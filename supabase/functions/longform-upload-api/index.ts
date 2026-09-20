import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";

const REPO="duykhanhrungnhum-debug/AI-";
const AUD="hidden-beyond-longform-upload";
const JWKS=createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));

function adminKey():string{
  const modern=Deno.env.get("SUPABASE_SECRET_KEYS");
  if(modern){const p=JSON.parse(modern); if(p.default) return p.default;}
  const legacy=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!legacy) throw new Error("no_admin_key");
  return legacy;
}

function clip(value:string,max:number):string{
  const v=String(value||"").trim();
  return v.length<=max?v:v.slice(0,max-1).trimEnd()+"…";
}

async function authorize(req:Request){
  const auth=req.headers.get("authorization")||"";
  if(!auth.startsWith("Bearer ")) throw new Error("missing_bearer");
  const {payload}=await jwtVerify(auth.slice(7),JWKS,{
    issuer:"https://token.actions.githubusercontent.com",
    audience:AUD,
  });
  if(payload.repository!==REPO) throw new Error("wrong_repository");
  if(payload.ref!=="refs/heads/main") throw new Error("wrong_ref");
  if(!["push","workflow_dispatch"].includes(String(payload.event_name||""))) throw new Error("wrong_event");
  const wr=String(payload.job_workflow_ref||"");
  if(wr && !wr.startsWith(REPO+"/.github/workflows/hidden-beyond-longform-first-upload.yml@")){
    throw new Error("wrong_workflow");
  }
}

async function accessToken(db:any){
  const q=await db.from("youtube_connections")
    .select("channel_id,channel_title,refresh_token,scope")
    .order("updated_at",{ascending:false})
    .limit(1)
    .maybeSingle();
  if(q.error) throw new Error("youtube_connection_lookup_failed:"+q.error.message);
  if(!q.data?.refresh_token) throw new Error("youtube_refresh_token_missing");
  const scope=String(q.data.scope||"");
  if(!scope.includes("youtube.upload")) throw new Error("youtube_upload_scope_missing");
  if(!scope.includes("youtube.force-ssl") && !scope.includes("/auth/youtube ")){
    throw new Error("youtube_playlist_scope_missing");
  }
  const clientId=Deno.env.get("YOUTUBE_CLIENT_ID")||"";
  const clientSecret=Deno.env.get("YOUTUBE_CLIENT_SECRET")||"";
  if(!clientId||!clientSecret) throw new Error("youtube_oauth_client_secret_missing");
  const res=await fetch("https://oauth2.googleapis.com/token",{
    method:"POST",
    headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({
      client_id:clientId,
      client_secret:clientSecret,
      refresh_token:q.data.refresh_token,
      grant_type:"refresh_token",
    })
  });
  const body=await res.json();
  if(!res.ok||!body.access_token) throw new Error("youtube_token_refresh_failed:"+JSON.stringify(body));
  return {token:String(body.access_token),connection:q.data};
}

async function ensurePlaylist(db:any,token:string,series:any){
  if(series.youtube_playlist_id) return String(series.youtube_playlist_id);
  const res=await fetch("https://www.googleapis.com/youtube/v3/playlists?part=snippet,status",{
    method:"POST",
    headers:{authorization:"Bearer "+token,"content-type":"application/json; charset=UTF-8"},
    body:JSON.stringify({
      snippet:{
        title:clip(series.playlist_title||series.series_title||"Hidden Beyond",150),
        description:"Danh sách phát theo từng bộ trên Hidden Beyond."
      },
      status:{privacyStatus:"public"}
    })
  });
  const body=await res.json().catch(async()=>({raw:await res.text()}));
  if(!res.ok||!body?.id) throw new Error("playlist_create_failed:"+res.status+":"+JSON.stringify(body));
  const save=await db.from("source_series")
    .update({youtube_playlist_id:body.id,updated_at:new Date().toISOString()})
    .eq("id",series.id);
  if(save.error) throw new Error("playlist_save_failed:"+save.error.message);
  return String(body.id);
}

async function addToPlaylist(token:string,playlistId:string,videoId:string){
  const res=await fetch("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet",{
    method:"POST",
    headers:{authorization:"Bearer "+token,"content-type":"application/json; charset=UTF-8"},
    body:JSON.stringify({
      snippet:{
        playlistId,
        resourceId:{kind:"youtube#video",videoId}
      }
    })
  });
  const body=await res.json().catch(async()=>({raw:await res.text()}));
  if(res.ok) return;
  if(JSON.stringify(body).includes("videoAlreadyInPlaylist")) return;
  throw new Error("playlist_insert_failed:"+res.status+":"+JSON.stringify(body));
}

async function markFollowingIfCaughtUp(db:any,series:any){
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
  const uploaded=new Set((vq.data||[])
    .filter((x:any)=>x.status==="uploaded"&&x.youtube_video_id)
    .map((x:any)=>String(x.source_video_id)));
  if(!ids.every((id:string)=>uploaded.has(id))) return;
  const last=Math.max(0,...(iq.data||[]).map((_:any,i:number)=>i+1));
  const now=new Date().toISOString();
  const u=await db.from("source_series")
    .update({
      state:"following",
      last_ingested_episode:Math.max(Number(series.latest_episode_seen||0),last),
      caught_up_at:now,
      updated_at:now
    })
    .eq("id",series.id);
  if(u.error) throw new Error("series_following_update_failed:"+u.error.message);
}

Deno.serve(async(req:Request)=>{
  try{
    if(req.method!=="POST") return Response.json({ok:false,error:"method_not_allowed"},{status:405});
    await authorize(req);
    const db=createClient(Deno.env.get("SUPABASE_URL")!,adminKey(),{
      auth:{persistSession:false,autoRefreshToken:false}
    });
    const url=new URL(req.url);
    const body=await req.json().catch(()=>({}));
    const seriesId=Number(body.series_id||0);
    const sourceVideoId=String(body.source_video_id||"").trim();
    if(!seriesId||!sourceVideoId) return Response.json({ok:false,error:"series_id_and_source_video_id_required"},{status:400});

    const sq=await db.from("source_series")
      .select("id,source_id,series_title,playlist_title,youtube_playlist_id,state,latest_episode_seen")
      .eq("id",seriesId).single();
    if(sq.error) throw new Error("series_lookup_failed:"+sq.error.message);
    const series=sq.data;

    const iq=await db.from("source_items")
      .select("source_id,source_item_id,source_url,title,episode_number,rights_status,rights_basis")
      .eq("series_id",seriesId)
      .eq("source_item_id",sourceVideoId)
      .eq("active",true)
      .single();
    if(iq.error) throw new Error("source_item_lookup_failed:"+iq.error.message);
    if(iq.data.rights_status!=="approved") throw new Error("source_item_not_approved");
    if(Number(iq.data.source_id)!==Number(series.source_id)) throw new Error("series_source_mismatch");

    if(url.pathname.endsWith("/prepare")){
      const existing=await db.from("videos")
        .select("id,status,youtube_video_id")
        .eq("source_id",series.source_id)
        .eq("source_video_id",sourceVideoId)
        .maybeSingle();
      if(existing.error) throw new Error("existing_video_lookup_failed:"+existing.error.message);
      if(existing.data?.youtube_video_id){
        return Response.json({ok:true,stage:"already_uploaded",video:existing.data});
      }
      if(existing.data?.status==="uploading_external"){
        return Response.json({ok:false,stage:"upload_in_progress",video:existing.data},{status:409});
      }
    }

    const yt=await accessToken(db);
    const playlistId=await ensurePlaylist(db,yt.token,series);

    if(url.pathname.endsWith("/prepare")){
      const translatedTitle=clip(String(body.translated_title||iq.data.title||series.series_title),92);
      const episode=Number(iq.data.episode_number||body.episode_number||1);
      const fullTitle=clip("Tập "+episode+" | "+translatedTitle,100);
      const source=await db.from("sources").select("name").eq("id",series.source_id).single();
      if(source.error) throw new Error("source_lookup_failed:"+source.error.message);
      const description=clip([
        "Bộ: "+String(series.playlist_title||series.series_title),
        "Tập: "+episode,
        "",
        "Bản lồng tiếng Việt do Hidden Beyond thực hiện.",
        "Nguồn / Source: "+String(source.data.name||""),
        "Video gốc / Original: "+String(iq.data.source_url||""),
      ].join("\n"),5000);

      const size=Number(body.size_bytes||0);
      if(!Number.isFinite(size)||size<100000) return Response.json({ok:false,error:"invalid_size_bytes"},{status:400});
      const contentType="video/mp4";
      const init=new URL("https://www.googleapis.com/upload/youtube/v3/videos");
      init.searchParams.set("uploadType","resumable");
      init.searchParams.set("part","snippet,status");
      init.searchParams.set("notifySubscribers","false");
      const initRes=await fetch(init,{
        method:"POST",
        headers:{
          authorization:"Bearer "+yt.token,
          "content-type":"application/json; charset=UTF-8",
          "x-upload-content-type":contentType,
          "x-upload-content-length":String(size)
        },
        body:JSON.stringify({
          snippet:{title:fullTitle,description,categoryId:"1"},
          status:{privacyStatus:"public",selfDeclaredMadeForKids:false}
        })
      });
      if(!initRes.ok) throw new Error("youtube_resumable_init_failed:"+initRes.status+":"+await initRes.text());
      const uploadUrl=initRes.headers.get("location");
      if(!uploadUrl) throw new Error("youtube_upload_url_missing");

      const row=await db.from("videos").upsert({
        source_id:series.source_id,
        source_video_id:sourceVideoId,
        source_url:iq.data.source_url,
        title:iq.data.title,
        translated_title:translatedTitle,
        status:"uploading_external",
        rights_verified:true,
        rights_basis:iq.data.rights_basis,
        original_audio_verified:true,
        series_id:seriesId,
        episode_number:episode,
        youtube_playlist_id:playlistId,
        processing_status:"longform_ready"
      },{onConflict:"source_id,source_video_id"})
      .select("id,source_id,source_video_id,status,series_id,episode_number")
      .single();
      if(row.error) throw new Error("video_prepare_save_failed:"+row.error.message);

      return Response.json({
        ok:true,stage:"ready",upload_url:uploadUrl,playlist_id:playlistId,
        video:row.data,channel_id:yt.connection.channel_id,channel_title:yt.connection.channel_title
      });
    }

    if(url.pathname.endsWith("/complete")){
      const youtubeVideoId=String(body.youtube_video_id||"").trim();
      if(!youtubeVideoId) return Response.json({ok:false,error:"youtube_video_id_required"},{status:400});
      await addToPlaylist(yt.token,playlistId,youtubeVideoId);
      const episode=Number(iq.data.episode_number||body.episode_number||1);
      const u=await db.from("videos")
        .update({
          status:"uploaded",
          youtube_video_id:youtubeVideoId,
          uploaded_at:new Date().toISOString(),
          series_id:seriesId,
          episode_number:episode,
          youtube_playlist_id:playlistId,
          processing_status:"completed",
          processing_error:null
        })
        .eq("source_id",series.source_id)
        .eq("source_video_id",sourceVideoId)
        .select("id,status,youtube_video_id,uploaded_at,series_id,episode_number,youtube_playlist_id")
        .single();
      if(u.error) throw new Error("video_complete_save_failed:"+u.error.message);
      await markFollowingIfCaughtUp(db,series);
      return Response.json({ok:true,stage:"uploaded",video:u.data,playlist_id:playlistId});
    }

    return Response.json({ok:false,error:"unknown_route"},{status:404});
  }catch(e){
    return Response.json({ok:false,error:e instanceof Error?e.message:String(e)},{status:500});
  }
});