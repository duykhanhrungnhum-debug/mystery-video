import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";

const REPO="duykhanhrungnhum-debug/mystery-video";
const AUD="hidden-beyond-bot2";
const JWKS=createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));
const FIXED=[
  {rotation:1,source_id:29,series_id:2},
  {rotation:2,source_id:30,series_id:3},
  {rotation:3,source_id:31,series_id:4},
  {rotation:4,source_id:32,series_id:5},
  {rotation:5,source_id:33,series_id:6},
];
const WORKER_STAGES=new Set([
  "source_downloading","source_ready","gpu_submitted","asr","translating",
  "translation_repair","tts","mixing","youtube_upload","youtube_uploaded"
]);

function adminKey():string{
  const modern=Deno.env.get("SUPABASE_SECRET_KEYS");
  if(modern){const p=JSON.parse(modern); if(p.default) return p.default;}
  const legacy=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!legacy) throw new Error("no_admin_key");
  return legacy;
}
function clip(value:any,max:number):string{
  const s=String(value??"").trim();
  return s.length<=max?s:s.slice(0,max-1).trimEnd()+"…";
}
function randomToken():string{
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  let raw=""; for(const b of bytes) raw+=String.fromCharCode(b);
  return btoa(raw).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}
async function sha256Hex(value:string):Promise<string>{
  const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(d)).map(x=>x.toString(16).padStart(2,"0")).join("");
}
function safeEqual(a:string,b:string):boolean{
  if(a.length!==b.length) return false;
  let x=0; for(let i=0;i<a.length;i++) x|=a.charCodeAt(i)^b.charCodeAt(i);
  return x===0;
}
async function authorizeGitHub(req:Request){
  const auth=req.headers.get("authorization")||"";
  if(!auth.startsWith("Bearer ")) throw new Error("missing_bearer");
  const {payload}=await jwtVerify(auth.slice(7),JWKS,{
    issuer:"https://token.actions.githubusercontent.com",audience:AUD
  });
  if(payload.repository!==REPO) throw new Error("wrong_repository");
  if(payload.ref!=="refs/heads/main") throw new Error("wrong_ref");
  if(!["push","workflow_dispatch","schedule"].includes(String(payload.event_name||"")))
    throw new Error("wrong_event");
  const wr=String(payload.job_workflow_ref||"");
  if(wr && !wr.startsWith(REPO+"/.github/workflows/hidden-beyond-bot2.yml@"))
    throw new Error("wrong_workflow");
}
async function loadState(db:any){
  const q=await db.from("hidden_beyond_bot2_state").select("*").eq("id",1).single();
  if(q.error) throw new Error("state_lookup_failed:"+q.error.message);
  return q.data;
}
async function authorizeWorker(req:Request,db:any,body:any){
  const token=req.headers.get("x-bot2-token")||"";
  if(!token) throw new Error("missing_worker_token");
  const state=await loadState(db);
  if(state.status!=="running") throw new Error("job_not_running");
  if(!state.job_token_hash||!state.job_expires_at) throw new Error("worker_token_not_issued");
  if(new Date(String(state.job_expires_at)).getTime()<Date.now()) throw new Error("worker_token_expired");
  const hash=await sha256Hex(token);
  if(!safeEqual(hash,String(state.job_token_hash))) throw new Error("invalid_worker_token");
  const sourceVideoId=String(body?.source_video_id||"").trim();
  if(!sourceVideoId||sourceVideoId!==String(state.current_source_video_id||""))
    throw new Error("worker_job_mismatch");
  return state;
}

async function youtubeAccess(db:any){
  const q=await db.from("youtube_connections")
    .select("channel_id,channel_title,refresh_token,scope")
    .order("updated_at",{ascending:false}).limit(1).maybeSingle();
  if(q.error) throw new Error("youtube_connection_lookup_failed:"+q.error.message);
  if(!q.data?.refresh_token) throw new Error("youtube_refresh_token_missing");
  const scope=String(q.data.scope||"");
  if(!scope.includes("youtube.upload")) throw new Error("youtube_upload_scope_missing");
  if(!scope.includes("youtube.force-ssl")&&!scope.includes("/auth/youtube "))
    throw new Error("youtube_playlist_scope_missing");
  const clientId=Deno.env.get("YOUTUBE_CLIENT_ID")||"";
  const clientSecret=Deno.env.get("YOUTUBE_CLIENT_SECRET")||"";
  if(!clientId||!clientSecret) throw new Error("youtube_client_secret_missing");
  const r=await fetch("https://oauth2.googleapis.com/token",{
    method:"POST",
    headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({
      client_id:clientId,client_secret:clientSecret,
      refresh_token:q.data.refresh_token,grant_type:"refresh_token"
    })
  });
  const b=await r.json();
  if(!r.ok||!b.access_token) throw new Error("youtube_token_refresh_failed:"+JSON.stringify(b));
  return {token:String(b.access_token),connection:q.data};
}
async function ensurePlaylist(db:any,token:string,series:any){
  if(series.youtube_playlist_id) return String(series.youtube_playlist_id);
  const title=clip(series.playlist_title||series.series_title||"Hidden Beyond",150);
  const r=await fetch("https://www.googleapis.com/youtube/v3/playlists?part=snippet,status",{
    method:"POST",
    headers:{authorization:"Bearer "+token,"content-type":"application/json"},
    body:JSON.stringify({
      snippet:{title,description:"Danh sách phát theo từng bộ trên Hidden Beyond."},
      status:{privacyStatus:"public"}
    })
  });
  const b=await r.json().catch(()=>({}));
  if(!r.ok||!b?.id) throw new Error("playlist_create_failed:"+r.status+":"+JSON.stringify(b));
  const u=await db.from("source_series").update({
    youtube_playlist_id:b.id,updated_at:new Date().toISOString()
  }).eq("id",series.id);
  if(u.error) throw new Error("playlist_save_failed:"+u.error.message);
  return String(b.id);
}
async function addPlaylist(token:string,playlistId:string,videoId:string){
  const r=await fetch("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet",{
    method:"POST",
    headers:{authorization:"Bearer "+token,"content-type":"application/json"},
    body:JSON.stringify({snippet:{playlistId,resourceId:{kind:"youtube#video",videoId}}})
  });
  const text=await r.text();
  if(r.ok||text.includes("videoAlreadyInPlaylist")) return;
  throw new Error("playlist_insert_failed:"+r.status+":"+text.slice(0,1000));
}

async function peekNext(db:any,state:any){
  const start=Number(state.next_rotation||1);
  for(let offset=0;offset<5;offset++){
    const rotation=((start-1+offset)%5)+1;
    const fixed=FIXED.find(x=>x.rotation===rotation)!;
    const sq=await db.from("source_series")
      .select("id,source_id,series_title,playlist_title,last_ingested_episode,active,state")
      .eq("id",fixed.series_id).single();
    if(sq.error) throw new Error("series_lookup_failed:"+sq.error.message);
    if(!sq.data.active) continue;
    const last=Number(sq.data.last_ingested_episode||0);
    const iq=await db.from("source_items")
      .select("source_id,series_id,source_item_id,source_url,title,series_title,episode_number,rights_status,rights_basis,evidence_url")
      .eq("source_id",fixed.source_id).eq("series_id",fixed.series_id)
      .eq("active",true).eq("rights_status","approved")
      .gt("episode_number",last).order("episode_number",{ascending:true})
      .limit(1).maybeSingle();
    if(iq.error) throw new Error("source_item_lookup_failed:"+iq.error.message);
    if(iq.data) return {stage:"ready",rotation,series:sq.data,item:iq.data};
  }
  return {stage:"idle"};
}
async function selectNext(db:any,state:any){
  if(state.status==="running"&&state.current_source_video_id){
    const age=(Date.now()-new Date(String(state.updated_at)).getTime())/1000;
    if(age<7200){
      return {stage:"job_active",job:{
        source_id:state.current_source_id,series_id:state.current_series_id,
        source_video_id:state.current_source_video_id,stage:state.stage
      }};
    }
    await db.from("hidden_beyond_bot2_state").update({
      status:"failed",stage:"stalled",last_message:"Previous Bot2 job stale after 2h",
      completed_at:new Date().toISOString(),updated_at:new Date().toISOString()
    }).eq("id",1);
  }
  const next=await peekNext(db,state);
  if(next.stage!=="ready"){
    const now=new Date().toISOString();
    await db.from("hidden_beyond_bot2_state").update({
      status:"idle",stage:"idle",started_at:null,completed_at:null,youtube_video_id:null,
      current_source_id:null,current_series_id:null,current_source_video_id:null,
      job_token_hash:null,job_expires_at:null,source_kernel_ref:null,source_bytes:null,gpu_kernel_ref:null,
      last_message:"No pending approved episode in fixed five-source pool",updated_at:now
    }).eq("id",1);
    return {stage:"idle"};
  }
  const now=new Date().toISOString();
  const u=await db.from("hidden_beyond_bot2_state").update({
    next_rotation:next.rotation,status:"running",stage:"selected",
    started_at:now,completed_at:null,youtube_video_id:null,
    current_source_id:next.item.source_id,current_series_id:next.item.series_id,
    current_source_video_id:next.item.source_item_id,
    source_kernel_ref:null,source_bytes:null,gpu_kernel_ref:null,
    last_message:"Selected source "+next.rotation+" episode "+String(next.item.episode_number),
    updated_at:now
  }).eq("id",1).select("*").single();
  if(u.error) throw new Error("state_claim_failed:"+u.error.message);
  return {stage:"selected",rotation:next.rotation,series:next.series,item:next.item};
}
async function completeJob(db:any,state:any,youtubeVideoId:string){
  const videoId=String(state.current_source_video_id||"");
  const fixed=FIXED.find(x=>x.source_id===Number(state.current_source_id)&&x.series_id===Number(state.current_series_id));
  if(!fixed) throw new Error("fixed_source_mapping_missing");
  const ytId=String(youtubeVideoId||"").trim();
  if(!ytId) throw new Error("youtube_video_id_required");

  const item=await db.from("source_items")
    .select("source_url,title,rights_basis,episode_number")
    .eq("series_id",fixed.series_id).eq("source_item_id",videoId).single();
  if(item.error) throw new Error("source_item_lookup_failed:"+item.error.message);
  const episode=Number(item.data.episode_number||0);
  if(!episode) throw new Error("episode_number_missing");
  const seriesInfo=await db.from("source_series")
    .select("id,series_title,playlist_title,youtube_playlist_id,last_ingested_episode")
    .eq("id",fixed.series_id).single();
  if(seriesInfo.error) throw new Error("series_lookup_failed:"+seriesInfo.error.message);

  const yt=await youtubeAccess(db);
  const playlistId=await ensurePlaylist(db,yt.token,seriesInfo.data);
  await addPlaylist(yt.token,playlistId,ytId);

  const videoSave=await db.from("videos").upsert({
    source_id:fixed.source_id,source_video_id:videoId,source_url:item.data.source_url,
    title:item.data.title,translated_title:seriesInfo.data.playlist_title||seriesInfo.data.series_title,
    status:"uploaded",youtube_video_id:ytId,uploaded_at:new Date().toISOString(),
    rights_verified:true,rights_basis:item.data.rights_basis,original_audio_verified:true,
    processing_status:"complete",processing_error:null,processed_at:new Date().toISOString(),
    series_id:fixed.series_id,episode_number:episode,youtube_playlist_id:playlistId
  },{onConflict:"source_id,source_video_id"});
  if(videoSave.error) throw new Error("video_success_save_failed:"+videoSave.error.message);

  const last=Math.max(Number(seriesInfo.data.last_ingested_episode||0),episode);
  const su=await db.from("source_series").update({
    last_ingested_episode:last,updated_at:new Date().toISOString()
  }).eq("id",fixed.series_id);
  if(su.error) throw new Error("series_progress_update_failed:"+su.error.message);

  const nextRotation=(fixed.rotation%5)+1;
  const u=await db.from("hidden_beyond_bot2_state").update({
    next_rotation:nextRotation,status:"idle",stage:"completed",
    current_source_id:null,current_series_id:null,current_source_video_id:null,
    youtube_video_id:ytId,completed_at:new Date().toISOString(),
    job_token_hash:null,job_expires_at:null,source_kernel_ref:null,source_bytes:null,gpu_kernel_ref:null,
    last_message:"Completed rotation "+fixed.rotation+" episode "+episode,
    updated_at:new Date().toISOString()
  }).eq("id",1).select("*").single();
  if(u.error) throw new Error("state_success_failed:"+u.error.message);
  return {next_rotation:nextRotation,state:u.data,episode_number:episode};
}

Deno.serve(async(req:Request)=>{
  try{
    if(req.method!=="POST") return Response.json({ok:false,error:"method_not_allowed"},{status:405});
    const db=createClient(Deno.env.get("SUPABASE_URL")!,adminKey(),{auth:{persistSession:false,autoRefreshToken:false}});
    const path=new URL(req.url).pathname;
    let body:any={}; try{body=await req.json();}catch{}

    if(path.endsWith("/worker-stage")){
      const state=await authorizeWorker(req,db,body);
      const stage=clip(body.stage||"",80);
      if(!WORKER_STAGES.has(stage)) return Response.json({ok:false,error:"invalid_worker_stage"},{status:400});
      const patch:any={
        status:"running",stage,last_message:clip(body.message||stage,1500),updated_at:new Date().toISOString()
      };
      if(body.source_kernel_ref) patch.source_kernel_ref=clip(body.source_kernel_ref,200);
      if(Number(body.source_bytes||0)>0) patch.source_bytes=Number(body.source_bytes);
      if(body.gpu_kernel_ref) patch.gpu_kernel_ref=clip(body.gpu_kernel_ref,200);
      if(body.youtube_video_id) patch.youtube_video_id=clip(body.youtube_video_id,100);
      const u=await db.from("hidden_beyond_bot2_state").update(patch).eq("id",1).select("*").single();
      if(u.error) throw new Error("worker_stage_update_failed:"+u.error.message);
      return Response.json({ok:true,stage:"updated",state:u.data});
    }
    if(path.endsWith("/worker-fail")){
      await authorizeWorker(req,db,body);
      const now=new Date().toISOString();
      const u=await db.from("hidden_beyond_bot2_state").update({
        status:"failed",stage:clip(body.stage||"failed",80),
        last_message:clip(body.error||body.message||"Bot2 worker failed",1500),
        completed_at:now,updated_at:now
      }).eq("id",1).select("*").single();
      if(u.error) throw new Error("worker_fail_update_failed:"+u.error.message);
      return Response.json({ok:true,stage:"failed",state:u.data});
    }
    if(path.endsWith("/worker-complete")){
      const state=await authorizeWorker(req,db,body);
      const result=await completeJob(db,state,String(body.youtube_video_id||""));
      return Response.json({ok:true,stage:"completed",...result});
    }

    await authorizeGitHub(req);

    if(path.endsWith("/config-fail")){
      const now=new Date().toISOString();
      const message=clip(body.error||body.message||"Bot2 configuration blocked",1500);
      const u=await db.from("hidden_beyond_bot2_state").update({
        status:"idle",stage:"config_blocked",
        current_source_id:null,current_series_id:null,current_source_video_id:null,
        source_kernel_ref:null,source_bytes:null,gpu_kernel_ref:null,
        job_token_hash:null,job_expires_at:null,
        started_at:null,completed_at:now,
        last_message:message,updated_at:now
      }).eq("id",1).select("*").single();
      if(u.error) throw new Error("config_fail_update_failed:"+u.error.message);
      return Response.json({ok:true,stage:"config_blocked",state:u.data});
    }

    if(path.endsWith("/status")) return Response.json({ok:true,state:await loadState(db)});
    if(path.endsWith("/peek")){
      const state=await loadState(db);
      return Response.json({ok:true,...await peekNext(db,state)});
    }
    if(path.endsWith("/next")){
      const state=await loadState(db);
      const result:any=await selectNext(db,state);
      if(result.stage!=="selected") return Response.json({ok:true,...result});
      const token=randomToken();
      const expires=new Date(Date.now()+4*3600*1000).toISOString();
      const u=await db.from("hidden_beyond_bot2_state").update({
        job_token_hash:await sha256Hex(token),job_expires_at:expires,updated_at:new Date().toISOString()
      }).eq("id",1);
      if(u.error) throw new Error("worker_token_save_failed:"+u.error.message);
      return Response.json({
        ok:true,...result,job_token:token,job_expires_at:expires,
        callback_base:Deno.env.get("SUPABASE_URL")+"/functions/v1/hidden-beyond-bot2"
      });
    }
    if(path.endsWith("/stage")){
      const state=await loadState(db);
      const videoId=String(body.source_video_id||"");
      if(!videoId||videoId!==String(state.current_source_video_id||""))
        return Response.json({ok:false,error:"job_mismatch"},{status:409});
      const stage=clip(body.stage||"",80);
      if(!stage) return Response.json({ok:false,error:"stage_required"},{status:400});
      const u=await db.from("hidden_beyond_bot2_state").update({
        status:"running",stage,last_message:clip(body.message||stage,1500),updated_at:new Date().toISOString()
      }).eq("id",1).select("*").single();
      if(u.error) throw new Error("state_stage_update_failed:"+u.error.message);
      return Response.json({ok:true,stage:"updated",state:u.data});
    }
    if(path.endsWith("/youtube-session")){
      const state=await loadState(db);
      const videoId=String(body.source_video_id||"").trim();
      if(state.status!=="running"||!videoId||videoId!==String(state.current_source_video_id||""))
        return Response.json({ok:false,error:"job_mismatch"},{status:409});
      const iq=await db.from("source_items")
        .select("source_id,series_id,source_item_id,source_url,title,series_title,episode_number,rights_status,rights_basis")
        .eq("source_item_id",videoId).eq("series_id",state.current_series_id).single();
      if(iq.error) throw new Error("source_item_lookup_failed:"+iq.error.message);
      if(iq.data.rights_status!=="approved") throw new Error("source_item_not_approved");
      const sq=await db.from("source_series")
        .select("id,source_id,series_title,playlist_title,youtube_playlist_id")
        .eq("id",state.current_series_id).single();
      if(sq.error) throw new Error("series_lookup_failed:"+sq.error.message);
      const src=await db.from("sources").select("name").eq("id",state.current_source_id).single();
      if(src.error) throw new Error("source_lookup_failed:"+src.error.message);

      const yt=await youtubeAccess(db);
      const playlistId=await ensurePlaylist(db,yt.token,sq.data);
      const ep=Number(iq.data.episode_number||1);
      const title=clip("Tập "+ep+" | "+String(sq.data.playlist_title||sq.data.series_title||iq.data.title||"Hidden Beyond"),100);
      const description=clip([
        "Bộ: "+String(sq.data.playlist_title||sq.data.series_title||""),"Tập: "+ep,"",
        "Bản lồng tiếng Việt do Hidden Beyond thực hiện.",
        "Nguồn / Source: "+String(src.data.name||""),
        "Video gốc / Original: "+String(iq.data.source_url||"")
      ].join("\n"),5000);
      const init=new URL("https://www.googleapis.com/upload/youtube/v3/videos");
      init.searchParams.set("uploadType","resumable");
      init.searchParams.set("part","snippet,status");
      init.searchParams.set("notifySubscribers","false");
      const ir=await fetch(init,{
        method:"POST",
        headers:{authorization:"Bearer "+yt.token,"content-type":"application/json; charset=UTF-8","x-upload-content-type":"video/mp4"},
        body:JSON.stringify({snippet:{title,description,categoryId:"1"},status:{privacyStatus:"public",selfDeclaredMadeForKids:false}})
      });
      if(!ir.ok) throw new Error("youtube_resumable_init_failed:"+ir.status+":"+await ir.text());
      const uploadUrl=ir.headers.get("location");
      if(!uploadUrl) throw new Error("youtube_upload_url_missing");
      await db.from("hidden_beyond_bot2_state").update({
        stage:"youtube_upload_ready",last_message:"YouTube resumable upload session ready",updated_at:new Date().toISOString()
      }).eq("id",1);
      return Response.json({
        ok:true,stage:"youtube_upload_ready",upload_url:uploadUrl,playlist_id:playlistId,
        title,episode_number:ep,channel_id:yt.connection.channel_id,channel_title:yt.connection.channel_title
      });
    }
    if(path.endsWith("/fail")){
      const state=await loadState(db);
      const videoId=String(body.source_video_id||"");
      if(!videoId||videoId!==String(state.current_source_video_id||""))
        return Response.json({ok:false,error:"job_mismatch"},{status:409});
      const now=new Date().toISOString();
      const u=await db.from("hidden_beyond_bot2_state").update({
        status:"failed",stage:clip(body.stage||"failed",80),
        last_message:clip(body.error||body.message||"Bot2 job failed",1500),
        completed_at:now,updated_at:now
      }).eq("id",1).select("*").single();
      if(u.error) throw new Error("state_fail_failed:"+u.error.message);
      return Response.json({ok:true,stage:"failed",state:u.data});
    }
    if(path.endsWith("/success")){
      const state=await loadState(db);
      const videoId=String(body.source_video_id||"");
      if(!videoId||videoId!==String(state.current_source_video_id||""))
        return Response.json({ok:false,error:"job_mismatch"},{status:409});
      const result=await completeJob(db,state,String(body.youtube_video_id||""));
      return Response.json({ok:true,stage:"completed",...result});
    }
    return Response.json({ok:false,error:"unknown_route"},{status:404});
  }catch(e){
    return Response.json({ok:false,error:e instanceof Error?e.message:String(e)},{status:401});
  }
});