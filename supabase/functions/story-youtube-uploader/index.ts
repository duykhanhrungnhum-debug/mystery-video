import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

function adminKey(): string {
  const modern = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modern) {
    const parsed = JSON.parse(modern);
    if (parsed.default) return parsed.default;
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("No Supabase admin key is available");
  return legacy;
}

function clip(value:string,max:number):string {
  return value.length<=max ? value : value.slice(0,max-1).trimEnd()+"…";
}

Deno.serve(async(req:Request)=>{
  if(!["GET","POST"].includes(req.method)){
    return Response.json({ok:false,error:"method_not_allowed"},{status:405});
  }
  try{
    const supabase=createClient(Deno.env.get("SUPABASE_URL")!,adminKey(),{
      auth:{persistSession:false,autoRefreshToken:false}
    });

    const botKey=req.headers.get("x-bot-key")||"";
    const auth=await supabase.rpc("verify_video_bot_key",{candidate:botKey});
    if(auth.error||auth.data!==true){
      return Response.json({ok:false,error:"unauthorized"},{status:401});
    }

    const connection=await supabase.from("youtube_connections")
      .select("channel_id,channel_title,refresh_token,scope")
      .order("updated_at",{ascending:false}).limit(1).maybeSingle();
    if(connection.error) throw new Error("youtube_connection_lookup_failed: "+connection.error.message);
    if(!connection.data) return Response.json({ok:false,stage:"youtube_connection",error:"No YouTube connection stored"},{status:409});

    const pending=await supabase.from("story_episodes")
      .select("id,series_id,episode_no,title_vi,source_url,final_video_storage_path,status,publish_ready,story_series!inner(title,source_id,source_key)")
      .eq("publish_ready",true)
      .is("youtube_video_id",null)
      .eq("status","video_ready")
      .not("final_video_storage_path","is",null)
      .order("id",{ascending:true})
      .limit(100);
    if(pending.error) throw new Error("story_queue_lookup_failed: "+pending.error.message);

    let candidate:any=null;
    for(const row of pending.data||[]){
      if(Number(row.episode_no)===1){
        candidate=row; break;
      }
      const prev=await supabase.from("story_episodes")
        .select("youtube_video_id,status")
        .eq("series_id",row.series_id)
        .eq("episode_no",Number(row.episode_no)-1)
        .maybeSingle();
      if(prev.error) throw new Error("previous_episode_lookup_failed: "+prev.error.message);
      if(prev.data?.youtube_video_id && prev.data?.status==="uploaded"){
        candidate=row; break;
      }
    }

    if(!candidate){
      return Response.json({ok:true,stage:"idle",message:"No publish-ready story episode is eligible in sequence"});
    }

    const clientId=Deno.env.get("YOUTUBE_CLIENT_ID")!;
    const clientSecret=Deno.env.get("YOUTUBE_CLIENT_SECRET")!;
    if(!clientId||!clientSecret) throw new Error("YouTube OAuth client secrets are missing");

    const tokenRes=await fetch("https://oauth2.googleapis.com/token",{
      method:"POST",
      headers:{"content-type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({
        client_id:clientId,
        client_secret:clientSecret,
        refresh_token:connection.data.refresh_token,
        grant_type:"refresh_token"
      })
    });
    const token=await tokenRes.json();
    if(!tokenRes.ok||!token.access_token){
      return Response.json({ok:false,stage:"refresh_token",google_status:tokenRes.status,google_error:token},{status:502});
    }

    const file=await supabase.storage.from("video-ingest").download(candidate.final_video_storage_path);
    if(file.error||!file.data) throw new Error("storage_download_failed: "+(file.error?.message||"missing file"));

    const series:any=candidate.story_series;
    const sourceLookup=await supabase.from("sources")
      .select("name,license_type,channel_url,terms_url")
      .eq("id",series.source_id).single();
    if(sourceLookup.error) throw new Error("source_lookup_failed: "+sourceLookup.error.message);

    const title=clip(candidate.title_vi||`${series.title} - Tập ${candidate.episode_no}`,100);
    const description=clip([
      `${series.title} — Tập ${candidate.episode_no}`,
      "",
      "Phiên bản kể chuyện tiếng Việt do Hidden Beyond biên tập, lồng tiếng và dựng hình từ nguyên tác thuộc phạm vi công cộng.",
      `Nguồn nguyên tác: ${sourceLookup.data.name}`,
      `Trang nguồn: ${candidate.source_url}`,
      `Tình trạng quyền: ${sourceLookup.data.license_type}`,
      sourceLookup.data.terms_url ? `Thông tin quyền: ${sourceLookup.data.terms_url}` : "",
      "",
      "Video được tạo lại từ văn bản nguồn; không phải bản reupload video của kênh khác.",
      "Các cảnh minh họa và phần kể tiếng Việt là thành phần của phiên bản Hidden Beyond."
    ].filter(Boolean).join("\n"),5000);

    const blob=file.data;
    const contentType=blob.type||"video/mp4";
    const initUrl=new URL("https://www.googleapis.com/upload/youtube/v3/videos");
    initUrl.searchParams.set("uploadType","resumable");
    initUrl.searchParams.set("part","snippet,status");
    initUrl.searchParams.set("notifySubscribers","false");

    const initRes=await fetch(initUrl,{
      method:"POST",
      headers:{
        authorization:`Bearer ${token.access_token}`,
        "content-type":"application/json; charset=UTF-8",
        "x-upload-content-type":contentType,
        "x-upload-content-length":String(blob.size)
      },
      body:JSON.stringify({
        snippet:{title,description,categoryId:"24"},
        status:{privacyStatus:"public",selfDeclaredMadeForKids:false}
      })
    });
    if(!initRes.ok){
      return Response.json({ok:false,stage:"youtube_resumable_init",youtube_status:initRes.status,youtube_error:await initRes.text()},{status:502});
    }

    const uploadUrl=initRes.headers.get("location");
    if(!uploadUrl) throw new Error("YouTube did not return a resumable upload URL");
    const uploadRes=await fetch(uploadUrl,{
      method:"PUT",
      headers:{"content-type":contentType,"content-length":String(blob.size)},
      body:blob
    });
    const uploaded=await uploadRes.json().catch(async()=>({raw:await uploadRes.text()}));
    if(!uploadRes.ok||!uploaded?.id){
      return Response.json({ok:false,stage:"youtube_upload",youtube_status:uploadRes.status,youtube_error:uploaded},{status:502});
    }

    const updated=await supabase.from("story_episodes").update({
      status:"uploaded",
      youtube_video_id:uploaded.id,
      uploaded_at:new Date().toISOString()
    }).eq("id",candidate.id).eq("publish_ready",true)
      .select("id,series_id,episode_no,title_vi,status,youtube_video_id,uploaded_at").single();
    if(updated.error) throw new Error("database_update_failed: "+updated.error.message);

    return Response.json({
      ok:true,
      stage:"uploaded",
      channel_id:connection.data.channel_id,
      channel_title:connection.data.channel_title,
      requested_privacy_status:"public",
      actual_privacy_status:uploaded?.status?.privacyStatus||null,
      youtube_video_id:uploaded.id,
      episode:updated.data
    });
  }catch(error){
    return Response.json({ok:false,error:error instanceof Error?error.message:String(error)},{status:500});
  }
});
