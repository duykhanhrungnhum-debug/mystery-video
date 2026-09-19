import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";

const REPO = "duykhanhrungnhum-debug/mystery-video";
const AUDIENCE = "hidden-beyond-story-processor";
const JWKS = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));
const MAX_REPAIR_ATTEMPTS = 3;
const MAX_VERIFICATION_ATTEMPTS = 5;

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

function clip(value:unknown,max:number):string {
  return String(value||"").slice(0,max);
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
          .select("id,status,youtube_video_id,uploaded_at")
          .eq("series_id",row.series_id).eq("episode_no",Number(row.episode_no)-1)
          .maybeSingle();
        if(prev.error) throw new Error("previous_lookup_failed: "+prev.error.message);
        if(prev.data?.status==="uploaded" && prev.data?.youtube_video_id && prev.data?.uploaded_at){
          candidate=row; break;
        }
      }
      if(!candidate) return Response.json({ok:true,stage:"idle",reason:"previous_episode_not_uploaded"});

      const claimed=await supabase.from("story_episodes").update({
        processing_status:"processing",
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
        verification_status:"pending",
        verification_attempts:0,
        repair_attempts:0,
        last_verification_error:null,
        last_repair_signature:null,
        repair_history:[],
        verified_at:null,
        translation_model:String(body?.translation_model||"").slice(0,200)||null,
        rewrite_model:String(body?.rewrite_model||"").slice(0,200)||null,
        tts_voice:String(body?.tts_voice||"").slice(0,200)||null,
        generation_notes:String(body?.generation_notes||"").slice(0,2000)||null,
        processing_status:"complete",
        processing_error:null,
        processed_at:new Date().toISOString()
      }).eq("id",id).eq("processing_status","processing")
        .select("id,series_id,episode_no,title_vi,status,processing_status,visual_status,verification_status,narration_storage_path,preview_storage_path,processed_at")
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

    if(path.endsWith("/finalize-complete")){
      const id=Number(body?.episode_id);
      if(!Number.isFinite(id)) return Response.json({ok:false,error:"invalid_episode_id"},{status:400});
      const current=await supabase.from("story_episodes")
        .select("id,series_id,episode_no,status,processing_status,verification_status")
        .eq("id",id).single();
      if(current.error) throw new Error("episode_lookup_failed: "+current.error.message);
      if(current.data.processing_status!=="complete") return Response.json({ok:false,error:"processing_not_complete"},{status:409});
      const base=`stories/${current.data.series_id}/${String(current.data.episode_no).padStart(4,"0")}`;
      const expectedFinal=`${base}/final.mp4`;
      if(body?.final_video_path!==expectedFinal) return Response.json({ok:false,error:"invalid_final_video_path"},{status:400});

      const assets=await supabase.from("story_visual_assets")
        .select("id,status,image_storage_path,error")
        .eq("episode_id",id);
      if(assets.error) throw new Error("visual_assets_lookup_failed: "+assets.error.message);
      const rows=assets.data||[];
      if(!rows.length) return Response.json({ok:false,error:"no_visual_assets"},{status:409});
      const incomplete=rows.filter((x:any)=>x.status!=="complete"||!x.image_storage_path);
      if(incomplete.length) return Response.json({ok:false,error:"visual_assets_incomplete",incomplete:incomplete.length},{status:409});

      const updated=await supabase.from("story_episodes").update({
        status:"video_ready",
        visual_status:"complete",
        visual_mode:clip(body?.visual_mode||"ai_generated",100),
        final_video_storage_path:expectedFinal,
        verification_status:"pending",
        publish_ready:false,
        verified_at:null
      }).eq("id",id)
        .select("id,series_id,episode_no,status,visual_status,final_video_storage_path,verification_status,publish_ready")
        .single();
      if(updated.error) throw new Error("finalize_update_failed: "+updated.error.message);
      return Response.json({ok:true,stage:"video_ready",episode:updated.data});
    }

    if(path.endsWith("/verify-pass")){
      const id=Number(body?.episode_id);
      if(!Number.isFinite(id)) return Response.json({ok:false,error:"invalid_episode_id"},{status:400});
      const episode=await supabase.from("story_episodes")
        .select("id,status,processing_status,visual_status,final_video_storage_path,verification_attempts")
        .eq("id",id).single();
      if(episode.error) throw new Error("episode_lookup_failed: "+episode.error.message);

      const assets=await supabase.from("story_visual_assets")
        .select("id,status,image_storage_path,error")
        .eq("episode_id",id);
      if(assets.error) throw new Error("visual_assets_lookup_failed: "+assets.error.message);
      const rows=assets.data||[];
      const incomplete=rows.filter((x:any)=>x.status!=="complete"||!x.image_storage_path||x.error);

      const failures:string[]=[];
      if(episode.data.status!=="video_ready") failures.push("status_not_video_ready");
      if(episode.data.processing_status!=="complete") failures.push("processing_not_complete");
      if(episode.data.visual_status!=="complete") failures.push("visual_status_not_complete");
      if(!episode.data.final_video_storage_path) failures.push("missing_final_video");
      if(!rows.length) failures.push("no_visual_assets");
      if(incomplete.length) failures.push("visual_assets_incomplete");

      if(failures.length){
        return Response.json({ok:false,error:"verification_failed",failures},{status:409});
      }

      const now=new Date().toISOString();
      const updated=await supabase.from("story_episodes").update({
        verification_status:"passed",
        verification_attempts:Number(episode.data.verification_attempts||0)+1,
        last_verification_error:null,
        verified_at:now,
        publish_ready:true
      }).eq("id",id)
        .select("id,series_id,episode_no,status,verification_status,verification_attempts,verified_at,publish_ready")
        .single();
      if(updated.error) throw new Error("verify_pass_update_failed: "+updated.error.message);
      return Response.json({ok:true,stage:"verified",episode:updated.data});
    }

    if(path.endsWith("/verify-fail")){
      const id=Number(body?.episode_id);
      if(!Number.isFinite(id)) return Response.json({ok:false,error:"invalid_episode_id"},{status:400});
      const errorText=clip(body?.error||"verification_failed",2000) || "verification_failed";
      const signature=clip(body?.repair_signature||"",240).trim() || null;
      const current=await supabase.from("story_episodes")
        .select("id,verification_attempts,repair_attempts,last_repair_signature,repair_history")
        .eq("id",id).single();
      if(current.error) throw new Error("episode_lookup_failed: "+current.error.message);

      const verificationAttempts=Number(current.data.verification_attempts||0)+1;
      const repairAttempts=Number(current.data.repair_attempts||0)+(signature?1:0);
      const repeated=Boolean(signature && current.data.last_repair_signature===signature);
      const blocked=repeated || repairAttempts>=MAX_REPAIR_ATTEMPTS || verificationAttempts>=MAX_VERIFICATION_ATTEMPTS;
      const history=Array.isArray(current.data.repair_history)?current.data.repair_history.slice(-19):[];
      history.push({
        at:new Date().toISOString(),
        error:errorText,
        repair_signature:signature,
        repeated_signature:repeated,
        outcome:blocked?"blocked":"retry_allowed"
      });

      const updated=await supabase.from("story_episodes").update({
        verification_status:blocked?"blocked":"repairing",
        verification_attempts:verificationAttempts,
        repair_attempts:repairAttempts,
        last_verification_error:errorText,
        last_repair_signature:signature,
        repair_history:history,
        publish_ready:false,
        verified_at:null
      }).eq("id",id)
        .select("id,series_id,episode_no,verification_status,verification_attempts,repair_attempts,last_verification_error,last_repair_signature,publish_ready")
        .single();
      if(updated.error) throw new Error("verify_fail_update_failed: "+updated.error.message);
      return Response.json({
        ok:true,
        stage:blocked?"blocked":"repair_required",
        repeated_repair_signature:repeated,
        max_repair_attempts:MAX_REPAIR_ATTEMPTS,
        max_verification_attempts:MAX_VERIFICATION_ATTEMPTS,
        episode:updated.data
      });
    }

    if(path.endsWith("/fail")){
      const id=Number(body?.episode_id);
      if(!Number.isFinite(id)) return Response.json({ok:false,error:"invalid_episode_id"},{status:400});
      const errorText=String(body?.error||"story_processing_failed").slice(0,2000);
      const current=await supabase.from("story_episodes")
        .select("id,processing_status,processing_attempts,processing_error")
        .eq("id",id).single();
      if(current.error) throw new Error("episode_lookup_failed: "+current.error.message);
      const repeated=Boolean(current.data.processing_error && current.data.processing_error===errorText);
      const exhausted=Number(current.data.processing_attempts||0)>=3;
      const blocked=repeated||exhausted;
      const updated=await supabase.from("story_episodes").update({
        processing_status:blocked?"blocked":"failed",
        processing_error:errorText
      }).eq("id",id)
        .select("id,series_id,episode_no,status,processing_status,processing_attempts,processing_error")
        .single();
      if(updated.error) throw new Error("fail_update_failed: "+updated.error.message);
      return Response.json({
        ok:true,
        stage:blocked?"processing_blocked":"failure_recorded",
        repeated_error:repeated,
        max_processing_attempts:3,
        episode:updated.data
      });
    }

    return Response.json({ok:false,error:"unknown_route"},{status:404});
  }catch(error){
    return Response.json({ok:false,error:error instanceof Error?error.message:String(error)},{status:401});
  }
});
