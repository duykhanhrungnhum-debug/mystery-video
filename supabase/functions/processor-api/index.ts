// Deployed source lives in Supabase Edge Functions.
// This file is intentionally kept in GitHub for version history.
// GitHub Actions authenticates with OIDC; no long-lived processing secret is committed here.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";

const REPO = "duykhanhrungnhum-debug/mystery-video";
const AUDIENCE = "hidden-beyond-processor";
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

async function verifyGitHub(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) throw new Error("missing_bearer");
  const { payload } = await jwtVerify(auth.slice(7), JWKS, {
    issuer: "https://token.actions.githubusercontent.com",
    audience: AUDIENCE
  });
  if (payload.repository !== REPO) throw new Error("wrong_repository");
  if (payload.ref !== "refs/heads/main") throw new Error("wrong_ref");
  if (!["schedule", "workflow_dispatch", "push"].includes(String(payload.event_name || ""))) throw new Error("wrong_event");
  const workflowRef = String(payload.job_workflow_ref || "");
  if (workflowRef && !workflowRef.startsWith(REPO + "/.github/workflows/process-video.yml@")) throw new Error("wrong_workflow");
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== "POST") return Response.json({ok:false,error:"method_not_allowed"},{status:405});
    await verifyGitHub(req);
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, adminKey(), {auth:{persistSession:false,autoRefreshToken:false}});
    const path = new URL(req.url).pathname;
    let body:any = {};
    try { body = await req.json(); } catch { body = {}; }

    if (path.endsWith("/claim")) {
      const candidate = await supabase.from("videos")
        .select("id,title,storage_path,source_url,rights_basis,processing_attempts")
        .eq("status","downloaded").eq("rights_verified",true).eq("original_audio_verified",true)
        .is("youtube_video_id",null).lt("processing_attempts",3)
        .or("processing_status.is.null,processing_status.eq.failed")
        .order("id",{ascending:true}).limit(1).maybeSingle();
      if (candidate.error) throw new Error("queue_lookup_failed: " + candidate.error.message);
      if (!candidate.data) return Response.json({ok:true,stage:"idle"});

      const claimed = await supabase.from("videos").update({
        processing_status:"processing",processing_error:null,processing_claimed_at:new Date().toISOString(),
        processing_attempts:Number(candidate.data.processing_attempts || 0)+1
      }).eq("id",candidate.data.id).eq("status","downloaded")
        .select("id,title,storage_path,source_url,rights_basis,processing_attempts").single();
      if (claimed.error) throw new Error("claim_failed: " + claimed.error.message);

      const original = await supabase.storage.from("video-ingest").createSignedUrl(claimed.data.storage_path,3600);
      const processedPath = `processed/${claimed.data.id}/vi.mp4`;
      const subtitlePath = `processed/${claimed.data.id}/vi.srt`;
      const processedUpload = await supabase.storage.from("video-ingest").createSignedUploadUrl(processedPath,{upsert:true});
      const subtitleUpload = await supabase.storage.from("video-ingest").createSignedUploadUrl(subtitlePath,{upsert:true});
      if (original.error || processedUpload.error || subtitleUpload.error || !original.data || !processedUpload.data || !subtitleUpload.data) {
        throw new Error("storage_signing_failed");
      }
      return Response.json({ok:true,stage:"claimed",job:{
        video_id:claimed.data.id,title:claimed.data.title,source_url:claimed.data.source_url,rights_basis:claimed.data.rights_basis,
        original_download_url:original.data.signedUrl,processed:processedUpload.data,subtitle:subtitleUpload.data
      }});
    }

    if (path.endsWith("/complete")) {
      const id=Number(body?.video_id);
      if (!Number.isFinite(id)) return Response.json({ok:false,error:"invalid_video_id"},{status:400});
      const expectedProcessed=`processed/${id}/vi.mp4`;
      const expectedSubtitle=`processed/${id}/vi.srt`;
      if (body?.processed_path!==expectedProcessed || body?.subtitle_path!==expectedSubtitle) {
        return Response.json({ok:false,error:"invalid_storage_path"},{status:400});
      }
      const updated=await supabase.from("videos").update({
        status:"processed",processed_storage_path:expectedProcessed,subtitle_storage_path:expectedSubtitle,
        translated_title:String(body?.translated_title || "").slice(0,200) || null,translation_language:"vi",
        processing_status:"complete",processing_error:null,processed_at:new Date().toISOString()
      }).eq("id",id).eq("processing_status","processing")
        .select("id,title,translated_title,status,processed_storage_path,subtitle_storage_path,processed_at").single();
      if (updated.error) throw new Error("complete_failed: " + updated.error.message);
      return Response.json({ok:true,stage:"processed",video:updated.data});
    }

    if (path.endsWith("/fail")) {
      const id=Number(body?.video_id);
      if (!Number.isFinite(id)) return Response.json({ok:false,error:"invalid_video_id"},{status:400});
      const code=String(body?.code || "processing_failed");
      const patch:any={processing_status:code==="no_speech" ? "terminal" : "failed",processing_error:String(body?.error || code).slice(0,2000)};
      if (code==="no_speech") patch.status="skipped_no_speech";
      const updated=await supabase.from("videos").update(patch).eq("id",id)
        .select("id,status,processing_status,processing_attempts,processing_error").single();
      if (updated.error) throw new Error("fail_update_failed: " + updated.error.message);
      return Response.json({ok:true,stage:"failure_recorded",video:updated.data});
    }
    return Response.json({ok:false,error:"unknown_route"},{status:404});
  } catch (error) {
    return Response.json({ok:false,error:error instanceof Error ? error.message : String(error)},{status:401});
  }
});
