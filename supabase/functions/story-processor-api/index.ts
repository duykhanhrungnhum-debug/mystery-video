import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";

const REPO = "duykhanhrungnhum-debug/mystery-video";
const AUDIENCE = "hidden-beyond-story-processor";
const JWKS = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));

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

async function verifyGitHub(req:Request) {
  const auth=req.headers.get("authorization")||"";
  if(!auth.startsWith("Bearer ")) throw new Error("missing_bearer");
  const {payload}=await jwtVerify(auth.slice(7),JWKS,{
    issuer:"https://token.actions.githubusercontent.com",
    audience:AUDIENCE
  });
  if(payload.repository!==REPO) throw new Error("wrong_repository");
  if(payload.ref!=="refs/heads/main") throw new Error("wrong_ref");
  if(!["schedule","workflow_dispatch","push"].includes(String(payload.event_name||""))) throw new Error("wrong_event");
  const workflowRef=String(payload.job_workflow_ref||"");
  if(workflowRef && !workflowRef.startsWith(REPO+"/.github/workflows/process-story.yml@")) throw new Error("wrong_workflow");
}

Deno.serve(async(req:Request)=>{
  try{
    if(req.method!=="POST") return Response.json({ok:false,error:"method_not_allowed"},{status:405});
    await verifyGitHub(req);
    const supabase=createClient(Deno.env.get("SUPABASE_URL")!,adminKey(),{auth:{persistSession:false,autoRefreshToken:false}});
    const path=new URL(req.url).pathname;
    let body:any={}; try{body=await req.json();}catch{}

    if(path.endsWith("/claim")){
      const requestedKey=String(body?.source_key||"").trim();
      let q=supabase.from("story_episodes")
        .select("id,series_id,episode_no,title,source_page_title,source_url,source_text,processing_attempts,story_series!inner(title,source_key)")
        .eq("status","collected").is("youtube_video_id",null).lt("processing_attempts",3)
        .or("processing_status.is.null,processing_status.eq.failed")
        .order("id",{ascending:true}).limit(100);
      if(requestedKey) q=q.eq("story_series.source_key",requestedKey);
      const candidates=await q;
      if(candidates.error) throw new Error("queue_lookup_failed: "+candidates.error.message);

      let candidate:any=null;
      for(const row of candidates.data||[]){
        if(Number(row.episode_no)===1){candidate=row;break;}
        const prev=await supabase.from("story_episodes")
          .select("id,status,processing_status")
          .eq("series_id",row.series_id).eq("episode_no",Number(row.episode_no)-1)
          .maybeSingle();
        if(prev.error) throw new Error("previous_lookup_failed: "+prev.error.message);
        if(prev.data && ["narrated","video_ready","uploaded"].includes(String(prev.data.status)) && prev.data.processing_status==="complete"){
          candidate=row; break;
        }
      }
      if(!candidate) return Response.json({ok:true,stage:"idle"});

      const claimed=await supabase.from("story_episodes").update({
        processing_status:"processing",
        processing_error:null,
        processing_claimed_at:new Date().toISOString(),
        processing_attempts:Number(candidate.processing_attempts||0)+1
      }).eq("id",candidate.id)
        .or("processing_status.is.null,processing_status.eq.failed")
        .select("id,series_id,episode_no,title,source_page_title,source_url,source_text,processing_attempts")
        .single();
      if(claimed.error) throw new Error("claim_failed: "+claimed.error.message);

      const series=await supabase.from("story_series").select("title,source_key").eq("id",claimed.data.series_id).single();
      if(series.error) throw new Error("series_lookup_failed: "+series.error.message);

      const base=`stories/${claimed.data.series_id}/${String(claimed.data.episode_no).padStart(4,"0")}`;
      const narrationPath=`${base}/narration_vi.wav`;
      const previewPath=`${base}/preview.mp4`;
      const narration=await supabase.storage.from("video-ingest").createSignedUploadUrl(narrationPath,{upsert:true});
      const preview=await supabase.storage.from("video-ingest").createSignedUploadUrl(previewPath,{upsert:true});
      if(narration.error||preview.error||!narration.data||!preview.data) throw new Error("storage_signing_failed");

      return Response.json({ok:true,stage:"claimed",job:{
        episode_id:claimed.data.id,
        series_id:claimed.data.series_id,
        series_title:series.data.title,
        source_key:series.data.source_key,
        episode_no:claimed.data.episode_no,
        source_title:claimed.data.title||claimed.data.source_page_title,
        source_url:claimed.data.source_url,
        source_text:claimed.data.source_text,
        narration:{path:narrationPath,signedUrl:narration.data.signedUrl},
        preview:{path:previewPath,signedUrl:preview.data.signedUrl}
      }});
    }

    if(path.endsWith("/complete")){
      const id=Number(body?.episode_id);
      if(!Number.isFinite(id)) return Response.json({ok:false,error:"invalid_episode_id"},{status:400});
      const current=await supabase.from("story_episodes").select("id,series_id,episode_no").eq("id",id).single();
      if(current.error) throw new Error("episode_lookup_failed: "+current.error.message);
      const base=`stories/${current.data.series_id}/${String(current.data.episode_no).padStart(4,"0")}`;
      const expectedNarration=`${base}/narration_vi.wav`;
      const expectedPreview=`${base}/preview.mp4`;
      if(body?.narration_path!==expectedNarration||body?.preview_path!==expectedPreview){
        return Response.json({ok:false,error:"invalid_storage_path"},{status:400});
      }
      const script=String(body?.script_vi||"").trim();
      if(script.length<200) return Response.json({ok:false,error:"script_too_short"},{status:400});
      const plan=Array.isArray(body?.visual_plan) ? body.visual_plan.slice(0,24) : [];
      const updated=await supabase.from("story_episodes").update({
        status:"narrated",
        title_vi:String(body?.title_vi||"").slice(0,240)||null,
        script_vi:script,
        narration_storage_path:expectedNarration,
        preview_storage_path:expectedPreview,
        visual_mode:"placeholder_motion_card",
        visual_plan:plan,
        visual_status:plan.length ? "pending" : "missing_plan",
        publish_ready:false,
        translation_model:String(body?.translation_model||"").slice(0,200)||null,
        rewrite_model:String(body?.rewrite_model||"").slice(0,200)||null,
        tts_voice:String(body?.tts_voice||"").slice(0,200)||null,
        generation_notes:String(body?.generation_notes||"").slice(0,2000)||null,
        processing_status:"complete",
        processing_error:null,
        processed_at:new Date().toISOString()
      }).eq("id",id).eq("processing_status","processing")
        .select("id,series_id,episode_no,title_vi,status,processing_status,visual_status,narration_storage_path,preview_storage_path,processed_at")
        .single();
      if(updated.error) throw new Error("complete_failed: "+updated.error.message);

      if(plan.length){
        const rows=plan.map((scene:any,index:number)=>({
          episode_id:id,
          scene_no:Number(scene?.scene||index+1),
          prompt_vi:String(scene?.prompt_vi||"").slice(0,4000),
          narration_excerpt_vi:String(scene?.narration_excerpt_vi||"").slice(0,2000)||null,
          provider:null,
          image_storage_path:null,
          status:"pending",
          error:null,
          updated_at:new Date().toISOString()
        })).filter((row:any)=>row.scene_no>0 && row.prompt_vi.length>0);
        if(rows.length){
          const assets=await supabase.from("story_visual_assets").upsert(rows,{onConflict:"episode_id,scene_no"});
          if(assets.error) throw new Error("visual_plan_queue_failed: "+assets.error.message);
        }
      }
      return Response.json({ok:true,stage:"narrated",episode:updated.data,visual_jobs:plan.length});
    }

    if(path.endsWith("/fail")){
      const id=Number(body?.episode_id);
      if(!Number.isFinite(id)) return Response.json({ok:false,error:"invalid_episode_id"},{status:400});
      const updated=await supabase.from("story_episodes").update({
        processing_status:"failed",
        processing_error:String(body?.error||"story_processing_failed").slice(0,2000)
      }).eq("id",id)
        .select("id,series_id,episode_no,status,processing_status,processing_attempts,processing_error")
        .single();
      if(updated.error) throw new Error("fail_update_failed: "+updated.error.message);
      return Response.json({ok:true,stage:"failure_recorded",episode:updated.data});
    }

    return Response.json({ok:false,error:"unknown_route"},{status:404});
  }catch(error){
    return Response.json({ok:false,error:error instanceof Error?error.message:String(error)},{status:401});
  }
});
