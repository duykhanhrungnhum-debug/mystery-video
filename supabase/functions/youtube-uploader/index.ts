import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";

const REPO="duykhanhrungnhum-debug/mystery-video";
const AUD="hidden-beyond-youtube-upload";
const JWKS=createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));

function adminKey(): string {
  const modern = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modern) { const parsed=JSON.parse(modern); if(parsed.default) return parsed.default; }
  const legacy=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!legacy) throw new Error("No Supabase admin key is available");
  return legacy;
}
function clip(value:string,max:number):string { return value.length<=max?value:value.slice(0,max-1).trimEnd()+"…"; }

async function authorize(req:Request,supabase:any){
  const auth=req.headers.get("authorization")||"";
  if(auth.startsWith("Bearer ")){
    const {payload}=await jwtVerify(auth.slice(7),JWKS,{issuer:"https://token.actions.githubusercontent.com",audience:AUD});
    if(payload.repository!==REPO) throw new Error("wrong_repository");
    if(payload.ref!=="refs/heads/main") throw new Error("wrong_ref");
    if(!["push","workflow_dispatch","schedule"].includes(String(payload.event_name||""))) throw new Error("wrong_event");
    const wr=String(payload.job_workflow_ref||"");
    if(wr && !wr.startsWith(REPO+"/.github/workflows/upload-youtube.yml@")) throw new Error("wrong_workflow");
    return;
  }
  const botKey=req.headers.get("x-bot-key")||"";
  const check=await supabase.rpc("verify_video_bot_key",{candidate:botKey});
  if(check.error||check.data!==true) throw new Error("unauthorized");
}


function hasPlaylistScope(scope:string):boolean{
  const s=new Set(String(scope||"").split(/\s+/).filter(Boolean));
  return s.has("https://www.googleapis.com/auth/youtube.force-ssl") || s.has("https://www.googleapis.com/auth/youtube");
}

async function refreshAccessToken(connection:any){
  const clientId=Deno.env.get("YOUTUBE_CLIENT_ID")!;
  const clientSecret=Deno.env.get("YOUTUBE_CLIENT_SECRET")!;
  if(!clientId||!clientSecret) throw new Error("YouTube OAuth client secrets are missing");
  const res=await fetch("https://oauth2.googleapis.com/token",{
    method:"POST",
    headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({
      client_id:clientId,
      client_secret:clientSecret,
      refresh_token:connection.refresh_token,
      grant_type:"refresh_token"
    })
  });
  const body=await res.json();
  if(!res.ok||!body.access_token) throw new Error("youtube_token_refresh_failed:"+JSON.stringify(body));
  return String(body.access_token);
}

async function resolveSeries(db:any, video:any){
  let seriesId=Number(video.series_id||0);
  let episodeNumber=video.episode_number===null||video.episode_number===undefined?null:Number(video.episode_number);
  if(!seriesId){
    const item=await db.from("source_items")
      .select("series_id,episode_number,series_title")
      .eq("source_id",video.source_id)
      .eq("source_item_id",video.source_video_id)
      .maybeSingle();
    if(item.error) throw new Error("Source item lookup failed: "+item.error.message);
    if(item.data?.series_id){
      seriesId=Number(item.data.series_id);
      episodeNumber=item.data.episode_number===null?null:Number(item.data.episode_number);
      const save=await db.from("videos")
        .update({series_id:seriesId,episode_number:episodeNumber})
        .eq("id",video.id);
      if(save.error) throw new Error("Video series link failed: "+save.error.message);
    }
  }
  if(!seriesId) return null;
  const sq=await db.from("source_series")
    .select("id,source_id,series_title,series_order,state,playlist_title,youtube_playlist_id,latest_episode_seen,last_ingested_episode")
    .eq("id",seriesId)
    .single();
  if(sq.error) throw new Error("Series lookup failed: "+sq.error.message);
  return {series:sq.data,episode_number:episodeNumber};
}

async function ensurePlaylist(db:any, accessToken:string, series:any){
  if(series.youtube_playlist_id) return String(series.youtube_playlist_id);
  const url="https://www.googleapis.com/youtube/v3/playlists?part=snippet,status";
  const res=await fetch(url,{
    method:"POST",
    headers:{authorization:"Bearer "+accessToken,"content-type":"application/json; charset=UTF-8"},
    body:JSON.stringify({
      snippet:{
        title:clip(String(series.playlist_title||series.series_title||"Hidden Beyond"),150),
        description:"Danh sách phát tự động theo từng bộ của Hidden Beyond."
      },
      status:{privacyStatus:"public"}
    })
  });
  const body=await res.json().catch(async()=>({raw:await res.text()}));
  if(!res.ok||!body?.id) throw new Error("playlist_create_failed:"+res.status+":"+JSON.stringify(body));
  const save=await db.from("source_series")
    .update({youtube_playlist_id:body.id,updated_at:new Date().toISOString()})
    .eq("id",series.id);
  if(save.error) throw new Error("playlist_id_save_failed:"+save.error.message);
  series.youtube_playlist_id=body.id;
  return String(body.id);
}

async function addVideoToPlaylist(accessToken:string, playlistId:string, videoId:string){
  const url="https://www.googleapis.com/youtube/v3/playlistItems?part=snippet";
  const res=await fetch(url,{
    method:"POST",
    headers:{authorization:"Bearer "+accessToken,"content-type":"application/json; charset=UTF-8"},
    body:JSON.stringify({
      snippet:{
        playlistId,
        resourceId:{kind:"youtube#video",videoId}
      }
    })
  });
  const body=await res.json().catch(async()=>({raw:await res.text()}));
  if(res.ok) return;
  const dump=JSON.stringify(body);
  if(dump.includes("videoAlreadyInPlaylist")) return;
  throw new Error("playlist_insert_failed:"+res.status+":"+dump);
}

async function advanceSeries(db:any, series:any, episodeNumber:number|null){
  if(episodeNumber!==null){
    const last=Math.max(Number(series.last_ingested_episode||0),episodeNumber);
    const u=await db.from("source_series")
      .update({last_ingested_episode:last,updated_at:new Date().toISOString()})
      .eq("id",series.id);
    if(u.error) throw new Error("series_progress_save_failed:"+u.error.message);
    series.last_ingested_episode=last;
  }

  const iq=await db.from("source_items")
    .select("source_item_id")
    .eq("series_id",series.id)
    .eq("active",true)
    .order("episode_number",{ascending:true,nullsFirst:false});
  if(iq.error) throw new Error("series_items_check_failed:"+iq.error.message);
  const ids=(iq.data||[]).map((x:any)=>String(x.source_item_id));
  if(!ids.length) return;

  const vq=await db.from("videos")
    .select("source_video_id,status,youtube_video_id")
    .eq("series_id",series.id)
    .in("source_video_id",ids);
  if(vq.error) throw new Error("series_video_check_failed:"+vq.error.message);
  const uploaded=new Set((vq.data||[]).filter((x:any)=>x.youtube_video_id&&x.status==="uploaded").map((x:any)=>String(x.source_video_id)));
  if(!ids.every((id:string)=>uploaded.has(id))) return;

  if(series.state==="backfill"){
    const now=new Date().toISOString();
    const done=await db.from("source_series")
      .update({state:"following",caught_up_at:now,updated_at:now})
      .eq("id",series.id);
    if(done.error) throw new Error("series_following_transition_failed:"+done.error.message);

    const next=await db.from("source_series")
      .select("id")
      .eq("source_id",series.source_id)
      .eq("active",true)
      .eq("state","queued")
      .order("series_order",{ascending:true})
      .limit(1)
      .maybeSingle();
    if(next.error) throw new Error("next_series_lookup_failed:"+next.error.message);
    if(next.data?.id){
      const promote=await db.from("source_series")
        .update({state:"backfill",updated_at:now})
        .eq("id",next.data.id);
      if(promote.error) throw new Error("next_series_promote_failed:"+promote.error.message);
    }
  }
}

Deno.serve(async(req:Request)=>{
  if(!["GET","POST"].includes(req.method)) return Response.json({ok:false,error:"method_not_allowed"},{status:405});
  try{
    const db=createClient(Deno.env.get("SUPABASE_URL")!,adminKey(),{auth:{persistSession:false,autoRefreshToken:false}});
    await authorize(req,db);

    const connection=await db.from("youtube_connections")
      .select("channel_id,channel_title,refresh_token,scope")
      .order("updated_at",{ascending:false}).limit(1).maybeSingle();
    if(connection.error) throw new Error("YouTube connection lookup failed: "+connection.error.message);
    if(!connection.data) return Response.json({ok:false,stage:"youtube_connection",error:"No YouTube connection stored"},{status:409});

    const pending=await db.from("videos")
      .select("id,source_id,source_video_id,title,translated_title,source_url,youtube_video_id,status,series_id,episode_number,youtube_playlist_id")
      .eq("status","uploaded_playlist_pending")
      .not("youtube_video_id","is",null)
      .order("id",{ascending:true}).limit(1).maybeSingle();
    if(pending.error) throw new Error("Pending playlist lookup failed: "+pending.error.message);

    const candidate=await db.from("videos")
      .select("id,source_id,source_video_id,title,translated_title,source_url,processed_storage_path,rights_verified,rights_basis,youtube_video_id,status,series_id,episode_number,youtube_playlist_id")
      .eq("rights_verified",true).is("youtube_video_id",null).eq("status","processed")
      .not("processed_storage_path","is",null).order("id",{ascending:true}).limit(1).maybeSingle();
    if(candidate.error) throw new Error("Video lookup failed: "+candidate.error.message);

    if(!pending.data&&!candidate.data){
      return Response.json({ok:true,stage:"idle",message:"No processed video is waiting for upload"});
    }

    const pendingSeries=pending.data?await resolveSeries(db,pending.data):null;
    const candidateSeries=candidate.data?await resolveSeries(db,candidate.data):null;
    if((pendingSeries||candidateSeries)&&!hasPlaylistScope(connection.data.scope||"")){
      return Response.json({
        ok:false,
        stage:"oauth_scope_required",
        required_scope:"https://www.googleapis.com/auth/youtube.force-ssl",
        reconnect_url:Deno.env.get("SUPABASE_URL")+"/functions/v1/youtube-oauth/start"
      });
    }

    const accessToken=await refreshAccessToken(connection.data);

    if(pending.data){
      const resolved=pendingSeries;
      if(!resolved) throw new Error("Pending playlist video has no series");
      const playlistId=await ensurePlaylist(db,accessToken,resolved.series);
      await addVideoToPlaylist(accessToken,playlistId,String(pending.data.youtube_video_id));
      const fixed=await db.from("videos")
        .update({status:"uploaded",youtube_playlist_id:playlistId})
        .eq("id",pending.data.id)
        .select("id,status,youtube_video_id,youtube_playlist_id")
        .single();
      if(fixed.error) throw new Error("Playlist repair save failed: "+fixed.error.message);
      await advanceSeries(db,resolved.series,resolved.episode_number);
      return Response.json({ok:true,stage:"playlist_repaired",video:fixed.data,playlist_id:playlistId});
    }

    const video=candidate.data;
    const resolved=candidateSeries;
    let playlistId:string|null=null;
    if(resolved) playlistId=await ensurePlaylist(db,accessToken,resolved.series);

    const file=await db.storage.from("video-ingest").download(video.processed_storage_path);
    if(file.error||!file.data) throw new Error("Storage download failed: "+(file.error?.message||"missing file"));
    const blob=file.data;

    const source=await db.from("sources").select("name,license_type,terms_url").eq("id",video.source_id).single();
    if(source.error) throw new Error("Source lookup failed: "+source.error.message);

    const ep=resolved?.episode_number;
    const baseTitle=video.translated_title||video.title||"Hidden Beyond";
    const title=clip(ep?("Tập "+ep+" | "+baseTitle):baseTitle,100);
    const description=clip([
      resolved?.series?.playlist_title?("Bộ: "+resolved.series.playlist_title):"",
      ep?("Tập: "+ep):"",
      "Bản lồng tiếng Việt do Hidden Beyond thực hiện.",
      "Nguồn / Source: "+source.data.name,
      "Video gốc / Original: "+video.source_url,
      "Giấy phép / License: "+(video.rights_basis||source.data.license_type||"Reusable source"),
      source.data.terms_url?("Điều khoản / Terms: "+source.data.terms_url):"",
      "",
      "Hình ảnh gốc được giữ nguyên; lời thoại được dịch và lồng tiếng Việt tự động."
    ].filter(Boolean).join("\n"),5000);

    const contentType=blob.type||"video/mp4";
    const initUrl=new URL("https://www.googleapis.com/upload/youtube/v3/videos");
    initUrl.searchParams.set("uploadType","resumable");
    initUrl.searchParams.set("part","snippet,status");
    initUrl.searchParams.set("notifySubscribers","false");
    const initRes=await fetch(initUrl,{
      method:"POST",
      headers:{
        authorization:"Bearer "+accessToken,
        "content-type":"application/json; charset=UTF-8",
        "x-upload-content-type":contentType,
        "x-upload-content-length":String(blob.size)
      },
      body:JSON.stringify({
        snippet:{title,description,categoryId:"1"},
        status:{privacyStatus:"public",selfDeclaredMadeForKids:false}
      })
    });
    if(!initRes.ok) return Response.json({ok:false,stage:"youtube_resumable_init",youtube_status:initRes.status,youtube_error:await initRes.text()},{status:502});
    const uploadUrl=initRes.headers.get("location");
    if(!uploadUrl) throw new Error("YouTube did not return a resumable upload URL");

    const uploadRes=await fetch(uploadUrl,{
      method:"PUT",
      headers:{"content-type":contentType,"content-length":String(blob.size)},
      body:blob
    });
    const uploaded=await uploadRes.json().catch(async()=>({raw:await uploadRes.text()}));
    if(!uploadRes.ok||!uploaded?.id) return Response.json({ok:false,stage:"youtube_upload",youtube_status:uploadRes.status,youtube_error:uploaded},{status:502});

    if(resolved&&playlistId){
      try{
        await addVideoToPlaylist(accessToken,playlistId,String(uploaded.id));
      }catch(e){
        const pendingSave=await db.from("videos")
          .update({
            status:"uploaded_playlist_pending",
            youtube_video_id:uploaded.id,
            uploaded_at:new Date().toISOString(),
            series_id:resolved.series.id,
            episode_number:resolved.episode_number,
            youtube_playlist_id:playlistId
          })
          .eq("id",video.id)
          .select("id,status,youtube_video_id,youtube_playlist_id")
          .single();
        if(pendingSave.error) throw new Error("Database save failed after playlist error: "+pendingSave.error.message);
        return Response.json({ok:false,stage:"uploaded_playlist_pending",error:e instanceof Error?e.message:String(e),video:pendingSave.data});
      }
    }

    const update=await db.from("videos")
      .update({
        status:"uploaded",
        youtube_video_id:uploaded.id,
        uploaded_at:new Date().toISOString(),
        series_id:resolved?.series?.id||video.series_id||null,
        episode_number:resolved?.episode_number??video.episode_number??null,
        youtube_playlist_id:playlistId
      })
      .eq("id",video.id)
      .select("id,title,translated_title,status,youtube_video_id,uploaded_at,series_id,episode_number,youtube_playlist_id")
      .single();
    if(update.error) throw new Error("Database update failed after YouTube upload: "+update.error.message);
    if(resolved) await advanceSeries(db,resolved.series,resolved.episode_number);

    return Response.json({
      ok:true,
      stage:"uploaded",
      channel_id:connection.data.channel_id,
      channel_title:connection.data.channel_title,
      requested_privacy_status:"public",
      actual_privacy_status:uploaded?.status?.privacyStatus||null,
      youtube_video_id:uploaded.id,
      playlist_id:playlistId,
      video:update.data
    });
  }catch(error){
    return Response.json({ok:false,error:error instanceof Error?error.message:String(error)},{status:500});
  }
});
