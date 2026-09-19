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
  const allowedWorkflows=[
    REPO+"/.github/workflows/process-story.yml@",
    REPO+"/.github/workflows/process-story-visuals.yml@"
  ];
  if(workflowRef && !allowedWorkflows.some((prefix)=>workflowRef.startsWith(prefix))) throw new Error("wrong_workflow");
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

    if(path.endsWith("/visual-claim")){
      const requestedKey=String(body?.source_key||"").trim();
      const repairSignature=clip(body?.repair_signature||"visual-provider-unspecified",240).trim()||"visual-provider-unspecified";
      let q=supabase.from("story_episodes")
        .select("id,series_id,episode_no,title_vi,script_vi,narration_storage_path,visual_plan,visual_status,visual_attempts,visual_error,visual_last_repair_signature,story_series!inner(title,source_key,source_id)")
        .eq("status","narrated")
        .eq("processing_status","complete")
        .is("youtube_video_id",null)
        .in("visual_status",["pending","failed","blocked"])
        .order("id",{ascending:true})
        .limit(100);
      if(requestedKey) q=q.eq("story_series.source_key",requestedKey);
      const candidates=await q;
      if(candidates.error) throw new Error("visual_queue_lookup_failed: "+candidates.error.message);

      let candidate:any=null;
      for(const row of candidates.data||[]){
        if(row.visual_status==="blocked" && row.visual_last_repair_signature===repairSignature) continue;
        if(Number(row.episode_no)>1){
          const prev=await supabase.from("story_episodes")
            .select("status,youtube_video_id,uploaded_at")
            .eq("series_id",row.series_id)
            .eq("episode_no",Number(row.episode_no)-1)
            .maybeSingle();
          if(prev.error) throw new Error("visual_previous_lookup_failed: "+prev.error.message);
          if(!(prev.data?.status==="uploaded" && prev.data?.youtube_video_id && prev.data?.uploaded_at)) continue;
        }
        const series:any=row.story_series;
        const source=await supabase.from("sources")
          .select("id,name,license_type,auto_eligible,active")
          .eq("id",series.source_id).single();
        if(source.error) throw new Error("visual_source_lookup_failed: "+source.error.message);
        if(source.data.active!==true || source.data.auto_eligible!==true) continue;
        candidate={...row,source:source.data}; break;
      }
      if(!candidate) return Response.json({ok:true,stage:"idle",reason:"no_visual_episode_eligible_in_sequence"});

      const sameRepair=candidate.visual_last_repair_signature===repairSignature;
      const attempts=sameRepair ? Number(candidate.visual_attempts||0)+1 : 1;
      const claimed=await supabase.from("story_episodes").update({
        visual_status:"processing",
        visual_attempts:attempts,
        visual_claimed_at:new Date().toISOString(),
        visual_last_repair_signature:repairSignature
      }).eq("id",candidate.id)
        .in("visual_status",["pending","failed","blocked"])
        .select("id,series_id,episode_no,title_vi,script_vi,narration_storage_path,visual_plan,visual_status,visual_attempts,visual_last_repair_signature")
        .single();
      if(claimed.error) throw new Error("visual_claim_failed: "+claimed.error.message);

      const assets=await supabase.from("story_visual_assets")
        .select("id,scene_no,prompt_vi,narration_excerpt_vi,status")
        .eq("episode_id",candidate.id)
        .order("scene_no",{ascending:true});
      if(assets.error) throw new Error("visual_assets_lookup_failed: "+assets.error.message);
      if(!(assets.data||[]).length) throw new Error("visual_assets_missing");

      const base=`stories/${claimed.data.series_id}/${String(claimed.data.episode_no).padStart(4,"0")}`;
      const signedAssets=await Promise.all((assets.data||[]).map(async(a:any)=>{
        const path=`${base}/visuals/scene-${String(a.scene_no).padStart(3,"0")}.png`;
        const signed=await supabase.storage.from("video-ingest").createSignedUploadUrl(path,{upsert:true});
        if(signed.error||!signed.data) throw new Error("visual_asset_signing_failed");
        return {id:a.id,scene_no:a.scene_no,prompt_vi:a.prompt_vi,narration_excerpt_vi:a.narration_excerpt_vi,path,signedUrl:signed.data.signedUrl};
      }));
      const finalPath=`${base}/final.mp4`;
      const finalSigned=await supabase.storage.from("video-ingest").createSignedUploadUrl(finalPath,{upsert:true});
      if(finalSigned.error||!finalSigned.data) throw new Error("final_video_signing_failed");
      const narrationSigned=await supabase.storage.from("video-ingest").createSignedUrl(claimed.data.narration_storage_path,7200);
      if(narrationSigned.error||!narrationSigned.data) throw new Error("narration_download_signing_failed");

      await supabase.from("story_visual_assets").update({
        status:"processing",
        provider:repairSignature,
        error:null,
        updated_at:new Date().toISOString()
      }).eq("episode_id",candidate.id);

      return Response.json({ok:true,stage:"visual_claimed",job:{
        episode_id:claimed.data.id,
        series_id:claimed.data.series_id,
        series_title:(candidate.story_series as any).title,
        episode_no:claimed.data.episode_no,
        title_vi:claimed.data.title_vi,
        script_vi:claimed.data.script_vi,
        source:{name:candidate.source.name,license_type:candidate.source.license_type,auto_eligible:candidate.source.auto_eligible},
        repair_signature:repairSignature,
        narration:{path:claimed.data.narration_storage_path,signedUrl:narrationSigned.data.signedUrl},
        assets:signedAssets,
        final_video:{path:finalPath,signedUrl:finalSigned.data.signedUrl}
      }});
    }

    if(path.endsWith("/visual-fail")){
      const id=Number(body?.episode_id);
      if(!Number.isFinite(id)) return Response.json({ok:false,error:"invalid_episode_id"},{status:400});
      const errorText=clip(body?.error||"visual_processing_failed",2000)||"visual_processing_failed";
      const repairSignature=clip(body?.repair_signature||"visual-provider-unspecified",240).trim()||"visual-provider-unspecified";
      const current=await supabase.from("story_episodes")
        .select("id,visual_status,visual_attempts,visual_error,visual_last_repair_signature,visual_failure_history")
        .eq("id",id).single();
      if(current.error) throw new Error("episode_lookup_failed: "+current.error.message);
      const sameError=Boolean(current.data.visual_error && current.data.visual_error===errorText);
      const sameRepair=current.data.visual_last_repair_signature===repairSignature;
      const repeated=sameError && sameRepair;
      const exhausted=Number(current.data.visual_attempts||0)>=3;
      const blocked=repeated||exhausted;
      const history=Array.isArray(current.data.visual_failure_history)?current.data.visual_failure_history.slice(-19):[];
      history.push({
        at:new Date().toISOString(),
        error:errorText,
        repair_signature:repairSignature,
        repeated_same_error_and_repair:repeated,
        outcome:blocked?"blocked":"retry_allowed"
      });
      const updated=await supabase.from("story_episodes").update({
        visual_status:blocked?"blocked":"failed",
        visual_error:errorText,
        visual_last_repair_signature:repairSignature,
        visual_failure_history:history,
        publish_ready:false,
        verification_status:blocked?"blocked":"pending",
        last_verification_error:errorText,
        verified_at:null
      }).eq("id",id)
        .select("id,series_id,episode_no,visual_status,visual_attempts,visual_error,visual_last_repair_signature,verification_status,publish_ready")
        .single();
      if(updated.error) throw new Error("visual_fail_update_failed: "+updated.error.message);
      await supabase.from("story_visual_assets").update({
        status:blocked?"blocked":"failed",
        error:errorText,
        provider:repairSignature,
        updated_at:new Date().toISOString()
      }).eq("episode_id",id).neq("status","complete");
      return Response.json({
        ok:true,
        stage:blocked?"visual_blocked":"visual_retry_allowed",
        repeated_same_error_and_repair:repeated,
        exhausted_attempts:exhausted,
        episode:updated.data
      });
    }

    if(path.endsWith("/visual-complete")){
      const id=Number(body?.episode_id);
      if(!Number.isFinite(id)) return Response.json({ok:false,error:"invalid_episode_id"},{status:400});
      const repairSignature=clip(body?.repair_signature||"visual-provider-unspecified",240).trim()||"visual-provider-unspecified";
      const current=await supabase.from("story_episodes")
        .select("id,series_id,episode_no,status,processing_status,title_vi,script_vi,narration_storage_path,visual_status,story_series!inner(source_id)")
        .eq("id",id).single();
      if(current.error) throw new Error("episode_lookup_failed: "+current.error.message);
      if(current.data.status!=="narrated"||current.data.processing_status!=="complete"||current.data.visual_status!=="processing"){
        return Response.json({ok:false,error:"visual_episode_not_in_processing_state"},{status:409});
      }

      const sourceId=(current.data.story_series as any).source_id;
      const source=await supabase.from("sources")
        .select("id,name,license_type,auto_eligible,active")
        .eq("id",sourceId).single();
      if(source.error) throw new Error("source_lookup_failed: "+source.error.message);
      if(source.data.active!==true||source.data.auto_eligible!==true){
        return Response.json({ok:false,error:"source_not_auto_eligible"},{status:409});
      }
      if(!String(current.data.title_vi||"").trim()||String(current.data.script_vi||"").trim().length<200){
        return Response.json({ok:false,error:"story_content_incomplete"},{status:409});
      }

      const expected=await supabase.from("story_visual_assets")
        .select("id,scene_no,prompt_vi")
        .eq("episode_id",id)
        .order("scene_no",{ascending:true});
      if(expected.error) throw new Error("visual_assets_lookup_failed: "+expected.error.message);
      const bodyAssets=Array.isArray(body?.assets)?body.assets:[];
      if(!expected.data?.length||bodyAssets.length!==expected.data.length){
        return Response.json({ok:false,error:"visual_asset_count_mismatch"},{status:409});
      }

      const base=`stories/${current.data.series_id}/${String(current.data.episode_no).padStart(4,"0")}`;
      const expectedFinal=`${base}/final.mp4`;
      if(body?.final_video_path!==expectedFinal) return Response.json({ok:false,error:"invalid_final_video_path"},{status:400});
      for(const item of expected.data){
        const found=bodyAssets.find((x:any)=>Number(x.scene_no)===Number(item.scene_no));
        const path=`${base}/visuals/scene-${String(item.scene_no).padStart(3,"0")}.png`;
        if(!found||found.path!==path) return Response.json({ok:false,error:"invalid_visual_asset_path",scene_no:item.scene_no},{status:400});
      }

      const checks=body?.verification||{};
      const requiredChecks=["images_valid","audio_valid","video_valid","duration_match","resolution_ok"];
      const failedChecks=requiredChecks.filter((k)=>checks?.[k]!==true);
      if(failedChecks.length){
        return Response.json({ok:false,error:"technical_verification_failed",failed_checks:failedChecks},{status:409});
      }

      const visualList=await supabase.storage.from("video-ingest").list(`${base}/visuals`,{limit:100});
      if(visualList.error) throw new Error("visual_storage_list_failed: "+visualList.error.message);
      const names=new Set((visualList.data||[]).map((x:any)=>x.name));
      for(const item of expected.data){
        const name=`scene-${String(item.scene_no).padStart(3,"0")}.png`;
        if(!names.has(name)) return Response.json({ok:false,error:"visual_asset_missing_in_storage",scene_no:item.scene_no},{status:409});
      }
      const baseList=await supabase.storage.from("video-ingest").list(base,{limit:100});
      if(baseList.error) throw new Error("final_storage_list_failed: "+baseList.error.message);
      const baseNames=new Set((baseList.data||[]).map((x:any)=>x.name));
      if(!baseNames.has("final.mp4")||!baseNames.has("narration_vi.wav")){
        return Response.json({ok:false,error:"final_or_narration_missing_in_storage"},{status:409});
      }

      for(const item of expected.data){
        const path=`${base}/visuals/scene-${String(item.scene_no).padStart(3,"0")}.png`;
        const assetUpdate=await supabase.from("story_visual_assets").update({
          status:"complete",
          provider:repairSignature,
          image_storage_path:path,
          error:null,
          updated_at:new Date().toISOString()
        }).eq("id",item.id);
        if(assetUpdate.error) throw new Error("visual_asset_complete_update_failed: "+assetUpdate.error.message);
      }

      const now=new Date().toISOString();
      const updated=await supabase.from("story_episodes").update({
        status:"video_ready",
        visual_status:"complete",
        visual_error:null,
        visual_last_repair_signature:repairSignature,
        visual_mode:"ai_generated_slideshow",
        final_video_storage_path:expectedFinal,
        verification_status:"passed",
        verification_attempts:1,
        last_verification_error:null,
        verified_at:now,
        publish_ready:true
      }).eq("id",id)
        .select("id,series_id,episode_no,status,visual_status,final_video_storage_path,verification_status,verified_at,publish_ready")
        .single();
      if(updated.error) throw new Error("visual_complete_update_failed: "+updated.error.message);
      return Response.json({ok:true,stage:"verified_publish_ready",episode:updated.data});
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
      const repairSignature=clip(body?.repair_signature||"unspecified",240).trim()||"unspecified";
      const current=await supabase.from("story_episodes")
        .select("id,processing_status,processing_attempts,processing_error,processing_last_repair_signature,processing_failure_history")
        .eq("id",id).single();
      if(current.error) throw new Error("episode_lookup_failed: "+current.error.message);

      const sameError=Boolean(current.data.processing_error && current.data.processing_error===errorText);
      const sameRepair=Boolean(current.data.processing_last_repair_signature && current.data.processing_last_repair_signature===repairSignature);
      const repeated=sameError && sameRepair;
      const exhausted=Number(current.data.processing_attempts||0)>=3;
      const blocked=repeated||exhausted;
      const history=Array.isArray(current.data.processing_failure_history)
        ? current.data.processing_failure_history.slice(-19)
        : [];
      history.push({
        at:new Date().toISOString(),
        error:errorText,
        repair_signature:repairSignature,
        repeated_same_error_and_repair:repeated,
        outcome:blocked?"blocked":"retry_allowed"
      });

      const updated=await supabase.from("story_episodes").update({
        processing_status:blocked?"blocked":"failed",
        processing_error:errorText,
        processing_last_repair_signature:repairSignature,
        processing_failure_history:history
      }).eq("id",id)
        .select("id,series_id,episode_no,status,processing_status,processing_attempts,processing_error,processing_last_repair_signature,processing_failure_history")
        .single();
      if(updated.error) throw new Error("fail_update_failed: "+updated.error.message);
      return Response.json({
        ok:true,
        stage:blocked?"processing_blocked":"failure_recorded",
        repeated_same_error_and_repair:repeated,
        exhausted_attempts:exhausted,
        max_processing_attempts:3,
        episode:updated.data
      });
    }

    return Response.json({ok:false,error:"unknown_route"},{status:404});
  }catch(error){
    return Response.json({ok:false,error:error instanceof Error?error.message:String(error)},{status:401});
  }
});
