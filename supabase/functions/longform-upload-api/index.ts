import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";

const REPO="duykhanhrungnhum-debug/AI-";
const AUD="hidden-beyond-longform-upload";
const JWKS=createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));
const CALLBACK_BASE="https://rlqqcuuphjmwksanbfml.supabase.co/functions/v1/longform-upload-api";

function adminKey():string{
  const modern=Deno.env.get("SUPABASE_SECRET_KEYS");
  if(modern){const p=JSON.parse(modern); if(p.default)return p.default;}
  const legacy=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!legacy)throw new Error("no_admin_key");
  return legacy;
}
function clip(v:any,n:number):string{
  const s=String(v??"").trim();
  return s.length<=n?s:s.slice(0,n-1).trimEnd()+"…";
}
function randomToken():string{
  const b=crypto.getRandomValues(new Uint8Array(32));
  let s=""; for(const x of b)s+=String.fromCharCode(x);
  return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}
async function sha256Hex(v:string):Promise<string>{
  const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));
  return Array.from(new Uint8Array(d)).map(x=>x.toString(16).padStart(2,"0")).join("");
}
function safeEqual(a:string,b:string):boolean{
  if(a.length!==b.length)return false;
  let x=0; for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);
  return x===0;
}
async function authorizeGitHub(req:Request){
  const h=req.headers.get("authorization")||"";
  if(!h.startsWith("Bearer "))throw new Error("missing_bearer");
  const {payload}=await jwtVerify(h.slice(7),JWKS,{issuer:"https://token.actions.githubusercontent.com",audience:AUD});
  if(payload.repository!==REPO)throw new Error("wrong_repository");
  if(payload.ref!=="refs/heads/main")throw new Error("wrong_ref");
  if(!["push","workflow_dispatch"].includes(String(payload.event_name||"")))throw new Error("wrong_event");
}
async function youtubeAccess(db:any){
  const q=await db.from("youtube_connections").select("channel_id,channel_title,refresh_token,scope")
    .order("updated_at",{ascending:false}).limit(1).maybeSingle();
  if(q.error)throw new Error("youtube_connection_lookup_failed:"+q.error.message);
  if(!q.data?.refresh_token)throw new Error("youtube_refresh_token_missing");
  const scope=String(q.data.scope||"");
  if(!scope.includes("youtube.upload"))throw new Error("youtube_upload_scope_missing");
  if(!scope.includes("youtube.force-ssl")&&!scope.includes("/auth/youtube "))throw new Error("youtube_playlist_scope_missing");
  const id=Deno.env.get("YOUTUBE_CLIENT_ID")||"";
  const secret=Deno.env.get("YOUTUBE_CLIENT_SECRET")||"";
  if(!id||!secret)throw new Error("youtube_client_secret_missing");
  const r=await fetch("https://oauth2.googleapis.com/token",{
    method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({client_id:id,client_secret:secret,refresh_token:q.data.refresh_token,grant_type:"refresh_token"})
  });
  const b=await r.json();
  if(!r.ok||!b.access_token)throw new Error("youtube_token_refresh_failed:"+JSON.stringify(b));
  return {token:String(b.access_token),connection:q.data};
}
async function getLongUploadsStatus(token:string){
  const url=new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part","status"); url.searchParams.set("mine","true");
  const r=await fetch(url,{headers:{authorization:"Bearer "+token}});
  const b=await r.json();
  if(!r.ok)throw new Error("youtube_long_upload_status_failed:"+r.status+":"+JSON.stringify(b));
  const item=Array.isArray(b.items)?b.items[0]:null;
  if(!item)throw new Error("youtube_channel_not_found");
  return String(item?.status?.longUploadsStatus||"");
}
async function loadSeriesItem(db:any,seriesId:number,sourceVideoId:string){
  const sq=await db.from("source_series")
    .select("id,source_id,series_title,playlist_title,youtube_playlist_id,state")
    .eq("id",seriesId).single();
  if(sq.error)throw new Error("series_lookup_failed:"+sq.error.message);
  const iq=await db.from("source_items")
    .select("source_id,source_item_id,source_url,title,series_title,episode_number,rights_status,rights_basis")
    .eq("series_id",seriesId).eq("source_item_id",sourceVideoId).eq("active",true).single();
  if(iq.error)throw new Error("source_item_lookup_failed:"+iq.error.message);
  if(iq.data.rights_status!=="approved")throw new Error("source_item_not_approved");
  if(Number(iq.data.source_id)!==Number(sq.data.source_id))throw new Error("series_source_mismatch");
  return {series:sq.data,item:iq.data};
}
async function ensurePlaylist(db:any,token:string,series:any){
  if(series.youtube_playlist_id)return String(series.youtube_playlist_id);
  const r=await fetch("https://www.googleapis.com/youtube/v3/playlists?part=snippet,status",{
    method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},
    body:JSON.stringify({snippet:{title:clip(series.playlist_title||series.series_title||"Hidden Beyond",150),
      description:"Danh sách phát theo từng bộ trên Hidden Beyond."},status:{privacyStatus:"public"}})
  });
  const b=await r.json().catch(()=>({}));
  if(!r.ok||!b?.id)throw new Error("playlist_create_failed:"+r.status+":"+JSON.stringify(b));
  const u=await db.from("source_series").update({youtube_playlist_id:b.id,updated_at:new Date().toISOString()}).eq("id",series.id);
  if(u.error)throw new Error("playlist_save_failed:"+u.error.message);
  return String(b.id);
}
async function addPlaylist(token:string,playlistId:string,videoId:string){
  const r=await fetch("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet",{
    method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},
    body:JSON.stringify({snippet:{playlistId,resourceId:{kind:"youtube#video",videoId}}})
  });
  const b=await r.json().catch(()=>({}));
  if(r.ok||JSON.stringify(b).includes("videoAlreadyInPlaylist"))return;
  throw new Error("playlist_insert_failed:"+r.status+":"+JSON.stringify(b));
}
async function markFollowing(db:any,series:any){
  const iq=await db.from("source_items").select("source_item_id,episode_number").eq("series_id",series.id).eq("active",true);
  if(iq.error)throw new Error("series_items_check_failed:"+iq.error.message);
  const ids=(iq.data||[]).map((x:any)=>String(x.source_item_id));
  if(!ids.length)return;
  const vq=await db.from("videos").select("source_video_id,status,youtube_video_id").eq("series_id",series.id).in("source_video_id",ids);
  if(vq.error)throw new Error("series_video_check_failed:"+vq.error.message);
  const done=new Set((vq.data||[]).filter((x:any)=>x.status==="uploaded"&&x.youtube_video_id).map((x:any)=>String(x.source_video_id)));
  if(!ids.every((x:string)=>done.has(x)))return;
  const last=Math.max(0,...(iq.data||[]).map((x:any)=>Number(x.episode_number||0)));
  const now=new Date().toISOString();
  const u=await db.from("source_series").update({state:"following",last_ingested_episode:last||null,caught_up_at:now,updated_at:now}).eq("id",series.id);
  if(u.error)throw new Error("series_following_update_failed:"+u.error.message);
}
async function loadJob(db:any,id:string,token:string){
  const q=await db.from("longform_jobs").select("*").eq("id",id).single();
  if(q.error)throw new Error("job_lookup_failed:"+q.error.message);
  const h=await sha256Hex(token);
  if(!safeEqual(h,String(q.data.token_hash)))throw new Error("invalid_job_token");
  if(new Date(String(q.data.expires_at)).getTime()<Date.now())throw new Error("job_token_expired");
  return q.data;
}
function defaultProfile(seriesId:number){
  return {
    series_id:seriesId,profile_version:1,profile_key:"auto",genre:"auto",
    register:"natural cinematic Vietnamese",
    pronoun_policy:"infer_from_relationship_and_context",
    glossary:{},style_rules:[],character_memory:{},detected_from:null
  };
}
async function start(req:Request,db:any,body:any){
  await authorizeGitHub(req);
  const seriesId=Number(body.series_id||0);
  const sourceVideoId=String(body.source_video_id||"").trim();
  const forceReprocess=body.force_reprocess===true;
  const versionLabel=clip(body.version_label||"",12);
  if(!seriesId||!sourceVideoId)throw new Error("series_id_and_source_video_id_required");
  const {series,item}=await loadSeriesItem(db,seriesId,sourceVideoId);

  const ev=await db.from("videos").select("id,status,youtube_video_id")
    .eq("source_id",series.source_id).eq("source_video_id",sourceVideoId).maybeSingle();
  if(ev.error)throw new Error("existing_video_lookup_failed:"+ev.error.message);
  if(ev.data?.youtube_video_id&&!forceReprocess)return Response.json({ok:true,stage:"already_uploaded",video:ev.data});

  const active=await db.from("longform_jobs").select("id,state,stage,heartbeat_at,expires_at")
    .eq("series_id",seriesId).eq("source_video_id",sourceVideoId)
    .in("state",["created","running"]).order("created_at",{ascending:false}).limit(1).maybeSingle();
  if(active.error)throw new Error("active_job_lookup_failed:"+active.error.message);
  if(active.data){
    const age=(Date.now()-new Date(String(active.data.heartbeat_at)).getTime())/1000;
    if(age<420&&new Date(String(active.data.expires_at)).getTime()>Date.now())
      return Response.json({ok:false,stage:"job_already_active",job:active.data},{status:409});
    await db.from("longform_jobs").update({
      state:"stalled",stage:"stalled",message:"Superseded after stale heartbeat",failed_at:new Date().toISOString()
    }).eq("id",active.data.id);
  }

  const yt=await youtubeAccess(db);
  const longStatus=await getLongUploadsStatus(yt.token);
  if(longStatus!=="allowed")return Response.json({ok:false,stage:"long_uploads_not_allowed",long_uploads_status:longStatus},{status:409});
  const playlistId=await ensurePlaylist(db,yt.token,series);
  const ep=Number(item.episode_number||1);
  const prefix=versionLabel?versionLabel+" - ":"";
  const title=clip(prefix+"Tập "+ep+" | "+String(series.playlist_title||series.series_title),100);
  const src=await db.from("sources").select("name").eq("id",series.source_id).single();
  if(src.error)throw new Error("source_lookup_failed:"+src.error.message);
  const description=clip([
    "Bộ: "+String(series.playlist_title||series.series_title),"Tập: "+ep,"",
    "Bản lồng tiếng Việt do Hidden Beyond thực hiện.",
    "Nguồn / Source: "+String(src.data.name||""),
    "Video gốc / Original: "+String(item.source_url||"")
  ].join("\n"),5000);

  const init=new URL("https://www.googleapis.com/upload/youtube/v3/videos");
  init.searchParams.set("uploadType","resumable");
  init.searchParams.set("part","snippet,status");
  init.searchParams.set("notifySubscribers","false");
  const ir=await fetch(init,{
    method:"POST",
    headers:{authorization:"Bearer "+yt.token,"content-type":"application/json","x-upload-content-type":"video/mp4"},
    body:JSON.stringify({snippet:{title,description,categoryId:"1"},status:{privacyStatus:"public",selfDeclaredMadeForKids:false}})
  });
  if(!ir.ok)throw new Error("youtube_resumable_init_failed:"+ir.status+":"+await ir.text());
  const uploadUrl=ir.headers.get("location");
  if(!uploadUrl)throw new Error("youtube_upload_url_missing");

  const id=crypto.randomUUID();
  const jobToken=randomToken();
  const now=new Date();
  const exp=new Date(now.getTime()+3*3600*1000);
  const root="longform/"+id;
  const subtitlePath=root+"/vi.srt";
  const metadataPath=root+"/metadata.json";
  const ins=await db.from("longform_jobs").insert({
    id,source_id:series.source_id,series_id:seriesId,source_video_id:sourceVideoId,
    token_hash:await sha256Hex(jobToken),state:"created",stage:"queued",
    message:"Ready for direct Kaggle worker",heartbeat_at:now.toISOString(),
    playlist_id:playlistId,expires_at:exp.toISOString(),
    subtitle_path:subtitlePath,metadata_path:metadataPath,youtube_upload_url:uploadUrl
  }).select("id,state,stage,heartbeat_at,expires_at,playlist_id").single();
  if(ins.error)throw new Error("job_insert_failed:"+ins.error.message);

  const vr=await db.from("videos").upsert({
    source_id:series.source_id,source_video_id:sourceVideoId,source_url:item.source_url,title:item.title,
    translated_title:series.playlist_title||series.series_title,status:"processing",
    rights_verified:true,rights_basis:item.rights_basis,original_audio_verified:true,
    series_id:seriesId,episode_number:ep,youtube_playlist_id:playlistId,
    processing_status:"longform_processing",processing_error:null
  },{onConflict:"source_id,source_video_id"});
  if(vr.error)throw new Error("video_job_save_failed:"+vr.error.message);

  return Response.json({
    ok:true,stage:"job_created",job_id:id,job_token:jobToken,callback_base:CALLBACK_BASE,
    playlist_id:playlistId,episode_number:ep,force_reprocess:forceReprocess,
    channel_id:yt.connection.channel_id,channel_title:yt.connection.channel_title
  });
}
async function workerConfig(req:Request,db:any,body:any){
  const id=String(body.job_id||"");
  const token=req.headers.get("x-job-token")||"";
  const job=await loadJob(db,id,token);
  if(["completed","failed","stalled"].includes(String(job.state)))
    return Response.json({ok:false,error:"job_terminal",state:job.state},{status:409});

  const item=await db.from("source_items")
    .select("source_url,title,series_title,episode_number")
    .eq("series_id",job.series_id).eq("source_item_id",job.source_video_id).single();
  if(item.error)throw new Error("worker_source_item_lookup_failed:"+item.error.message);
  const pq=await db.from("series_translation_profiles").select("*").eq("series_id",job.series_id).maybeSingle();
  if(pq.error)throw new Error("translation_profile_lookup_failed:"+pq.error.message);
  const subtitle=await db.storage.from("video-ingest").createSignedUploadUrl(String(job.subtitle_path),{upsert:true});
  const metadata=await db.storage.from("video-ingest").createSignedUploadUrl(String(job.metadata_path),{upsert:true});
  if(subtitle.error||metadata.error||!subtitle.data?.signedUrl||!metadata.data?.signedUrl)
    throw new Error("worker_artifact_signing_failed");

  return Response.json({
    ok:true,job_id:id,source_video_id:job.source_video_id,series_id:job.series_id,source_id:job.source_id,
    source_url:item.data.source_url,title:item.data.title,series_title:item.data.series_title,
    episode_number:item.data.episode_number,youtube_upload_url:job.youtube_upload_url,
    translation_profile:pq.data||defaultProfile(Number(job.series_id)),
    subtitle_upload_url:subtitle.data.signedUrl,metadata_upload_url:metadata.data.signedUrl
  });
}
async function heartbeat(req:Request,db:any,body:any){
  const id=String(body.job_id||""), token=req.headers.get("x-job-token")||"";
  const job=await loadJob(db,id,token);
  if(["completed","failed","stalled"].includes(String(job.state)))
    return Response.json({ok:false,error:"job_terminal",state:job.state},{status:409});
  const now=new Date().toISOString();
  const stage=clip(body.stage||"running",80);
  const message=clip(body.message||"worker alive",500);
  const u=await db.from("longform_jobs").update({
    state:"running",stage,message,heartbeat_at:now,supervisor_state:"running"
  }).eq("id",id).select("id,state,stage,message,heartbeat_at").single();
  if(u.error)throw new Error("heartbeat_update_failed:"+u.error.message);
  return Response.json({ok:true,job:u.data});
}
async function fail(req:Request,db:any,body:any){
  const id=String(body.job_id||""), token=req.headers.get("x-job-token")||"";
  const job=await loadJob(db,id,token);
  if(job.state==="completed")return Response.json({ok:true,ignored:true,state:"completed"});
  const msg=clip(body.error||body.message||"worker_failed",1000);
  const now=new Date().toISOString();
  const u=await db.from("longform_jobs").update({
    state:"failed",stage:"failed",message:msg,heartbeat_at:now,failed_at:now,supervisor_state:"blocked"
  }).eq("id",id).select("id,state,stage,message,failed_at").single();
  if(u.error)throw new Error("job_fail_update_failed:"+u.error.message);
  await db.from("videos").update({processing_status:"failed",processing_error:msg})
    .eq("source_id",job.source_id).eq("source_video_id",job.source_video_id);
  return Response.json({ok:true,job:u.data});
}
async function complete(req:Request,db:any,body:any){
  const id=String(body.job_id||""), token=req.headers.get("x-job-token")||"";
  const job=await loadJob(db,id,token);
  if(job.state==="completed")return Response.json({ok:true,stage:"uploaded",youtube_video_id:job.youtube_video_id});
  const yid=String(body.youtube_video_id||"").trim();
  if(!yid)throw new Error("youtube_video_id_required");
  const {series,item}=await loadSeriesItem(db,Number(job.series_id),String(job.source_video_id));

  const p=body.translation_profile;
  if(p&&typeof p==="object"){
    const row={
      series_id:job.series_id,
      profile_version:Math.max(1,Number(p.profile_version||1)),
      profile_key:clip(p.profile_key||"universal",80),
      genre:clip(p.genre||"general",80),
      register:clip(p.register||"natural cinematic Vietnamese",160),
      pronoun_policy:clip(p.pronoun_policy||"infer_from_relationship_and_context",200),
      glossary:(p.glossary&&typeof p.glossary==="object"&&!Array.isArray(p.glossary))?p.glossary:{},
      style_rules:Array.isArray(p.style_rules)?p.style_rules.slice(0,50):[],
      character_memory:(p.character_memory&&typeof p.character_memory==="object"&&!Array.isArray(p.character_memory))?p.character_memory:{},
      detected_from:clip(p.detected_from||"direct_longform_worker",120),
      updated_at:new Date().toISOString()
    };
    const pu=await db.from("series_translation_profiles").upsert(row,{onConflict:"series_id"});
    if(pu.error)throw new Error("translation_profile_save_failed:"+pu.error.message);
  }

  const yt=await youtubeAccess(db);
  const playlistId=String(job.playlist_id||await ensurePlaylist(db,yt.token,series));
  await addPlaylist(yt.token,playlistId,yid);
  const ep=Number(item.episode_number||1);
  const now=new Date().toISOString();
  const v=await db.from("videos").upsert({
    source_id:series.source_id,source_video_id:String(job.source_video_id),source_url:item.source_url,
    title:item.title,translated_title:clip(body.translated_title||series.playlist_title||series.series_title,200),
    status:"uploaded",rights_verified:true,rights_basis:item.rights_basis,original_audio_verified:true,
    series_id:series.id,episode_number:ep,youtube_playlist_id:playlistId,youtube_video_id:yid,uploaded_at:now,
    processing_status:"completed",processing_error:null
  },{onConflict:"source_id,source_video_id"})
    .select("id,status,youtube_video_id,uploaded_at,series_id,episode_number,youtube_playlist_id").single();
  if(v.error)throw new Error("video_complete_save_failed:"+v.error.message);
  await markFollowing(db,series);
  const j=await db.from("longform_jobs").update({
    state:"completed",stage:"uploaded",message:"Direct worker uploaded and completed",
    heartbeat_at:now,youtube_video_id:yid,completed_at:now,supervisor_state:"completed"
  }).eq("id",id).select("id,state,stage,message,youtube_video_id,playlist_id,completed_at").single();
  if(j.error)throw new Error("job_complete_update_failed:"+j.error.message);
  return Response.json({ok:true,stage:"uploaded",video:v.data,job:j.data});
}
async function status(req:Request,db:any,body:any){
  await authorizeGitHub(req);
  const id=String(body.job_id||"");
  if(!id)throw new Error("job_id_required");
  const q=await db.from("longform_jobs")
    .select("id,state,stage,message,heartbeat_at,youtube_video_id,playlist_id,created_at,completed_at,failed_at")
    .eq("id",id).single();
  if(q.error)throw new Error("job_status_lookup_failed:"+q.error.message);
  const age=Math.max(0,Math.round((Date.now()-new Date(String(q.data.heartbeat_at)).getTime())/1000));
  if(["created","running"].includes(String(q.data.state))&&age>420){
    const now=new Date().toISOString();
    const u=await db.from("longform_jobs").update({
      state:"stalled",stage:"stalled",message:"No worker heartbeat for >7 minutes",failed_at:now,supervisor_state:"blocked"
    }).eq("id",id).select("id,state,stage,message,heartbeat_at,youtube_video_id,failed_at").single();
    if(u.error)throw new Error("job_stall_update_failed:"+u.error.message);
    return Response.json({ok:true,job:{...u.data,heartbeat_age_seconds:age}});
  }
  return Response.json({ok:true,job:{...q.data,heartbeat_age_seconds:age}});
}
async function channelStatus(req:Request,db:any){
  await authorizeGitHub(req);
  const yt=await youtubeAccess(db);
  const url=new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part","status,snippet"); url.searchParams.set("mine","true");
  const r=await fetch(url,{headers:{authorization:"Bearer "+yt.token}});
  const b=await r.json();
  if(!r.ok)throw new Error("youtube_channel_status_failed:"+r.status+":"+JSON.stringify(b));
  const item=Array.isArray(b.items)?b.items[0]:null;
  if(!item)return Response.json({ok:true,exists:false});
  return Response.json({ok:true,exists:true,channel_id:item.id||null,channel_title:item?.snippet?.title||null,
    long_uploads_status:item?.status?.longUploadsStatus||null});
}
async function videoStatus(req:Request,db:any,body:any){
  await authorizeGitHub(req);
  const id=String(body.youtube_video_id||"").trim();
  if(!id)throw new Error("youtube_video_id_required");
  const yt=await youtubeAccess(db);
  const url=new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part","status,processingDetails,snippet"); url.searchParams.set("id",id);
  const r=await fetch(url,{headers:{authorization:"Bearer "+yt.token}});
  const b=await r.json();
  if(!r.ok)throw new Error("youtube_video_status_failed:"+r.status+":"+JSON.stringify(b));
  const item=Array.isArray(b.items)?b.items[0]:null;
  if(!item)return Response.json({ok:true,exists:false,youtube_video_id:id});
  return Response.json({ok:true,exists:true,youtube_video_id:id,
    privacy_status:item?.status?.privacyStatus||null,upload_status:item?.status?.uploadStatus||null,
    rejection_reason:item?.status?.rejectionReason||null,failure_reason:item?.status?.failureReason||null,
    processing_status:item?.processingDetails?.processingStatus||null,
    processing_failure_reason:item?.processingDetails?.processingFailureReason||null});
}

Deno.serve(async(req:Request)=>{
  try{
    if(req.method!=="POST")return Response.json({ok:false,error:"method_not_allowed"},{status:405});
    const db=createClient(Deno.env.get("SUPABASE_URL")!,adminKey(),{auth:{persistSession:false,autoRefreshToken:false}});
    const path=new URL(req.url).pathname;
    const body=await req.json().catch(()=>({}));
    if(path.endsWith("/start"))return await start(req,db,body);
    if(path.endsWith("/worker-config"))return await workerConfig(req,db,body);
    if(path.endsWith("/heartbeat"))return await heartbeat(req,db,body);
    if(path.endsWith("/fail"))return await fail(req,db,body);
    if(path.endsWith("/complete"))return await complete(req,db,body);
    if(path.endsWith("/status"))return await status(req,db,body);
    if(path.endsWith("/channel-status"))return await channelStatus(req,db);
    if(path.endsWith("/video-status"))return await videoStatus(req,db,body);
    return Response.json({ok:false,error:"unknown_route"},{status:404});
  }catch(e){
    return Response.json({ok:false,error:e instanceof Error?e.message:String(e)},{status:500});
  }
});