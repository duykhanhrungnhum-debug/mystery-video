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

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1).trimEnd() + "…";
}

Deno.serve(async (req: Request) => {
  if (!["GET", "POST"].includes(req.method)) {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }

  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, adminKey(), {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const botKey = req.headers.get("x-bot-key") || "";
    const authCheck = await supabase.rpc("verify_video_bot_key", { candidate: botKey });
    if (authCheck.error || authCheck.data !== true) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const connection = await supabase
      .from("youtube_connections")
      .select("channel_id,channel_title,refresh_token,scope")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (connection.error) throw new Error(`YouTube connection lookup failed: ${connection.error.message}`);
    if (!connection.data) {
      return Response.json({ ok: false, stage: "youtube_connection", error: "No YouTube connection stored" }, { status: 409 });
    }

    const candidate = await supabase
      .from("videos")
      .select("id,source_id,title,translated_title,source_url,storage_path,processed_storage_path,subtitle_storage_path,rights_verified,rights_basis,original_audio_verified,youtube_video_id,status")
      .eq("rights_verified", true)
      .is("youtube_video_id", null)
      .eq("status", "processed")
      .not("processed_storage_path", "is", null)
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (candidate.error) throw new Error(`Video lookup failed: ${candidate.error.message}`);
    if (!candidate.data) {
      return Response.json({ ok: true, stage: "idle", message: "No processed rights-verified video is waiting for upload" });
    }

    const clientId = Deno.env.get("YOUTUBE_CLIENT_ID")!;
    const clientSecret = Deno.env.get("YOUTUBE_CLIENT_SECRET")!;
    if (!clientId || !clientSecret) throw new Error("YouTube OAuth client secrets are missing");

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: connection.data.refresh_token,
        grant_type: "refresh_token"
      })
    });
    const token = await tokenRes.json();
    if (!tokenRes.ok || !token.access_token) {
      return Response.json({ ok: false, stage: "refresh_token", google_status: tokenRes.status, google_error: token }, { status: 502 });
    }

    const file = await supabase.storage
      .from("video-ingest")
      .download(candidate.data.processed_storage_path);

    if (file.error || !file.data) {
      throw new Error(`Storage download failed: ${file.error?.message || "missing file"}`);
    }

    const blob = file.data;

    const sourceLookup = await supabase
      .from("sources")
      .select("name,license_type,terms_url")
      .eq("id", candidate.data.source_id)
      .single();
    if (sourceLookup.error) throw new Error(`Source lookup failed: ${sourceLookup.error.message}`);

    const title = clip(candidate.data.translated_title || candidate.data.title || "Hidden Beyond", 100);
    const description = clip(
      [
        `Source: ${sourceLookup.data.name}`,
        `Original: ${candidate.data.source_url}`,
        "",
        `Rights basis: ${candidate.data.rights_basis || sourceLookup.data.license_type || "Verified reusable source"}`,
        sourceLookup.data.terms_url ? `Rights / terms: ${sourceLookup.data.terms_url}` : "",
        "",
        "Vietnamese subtitles were generated automatically from the spoken audio. Original source audio is retained in the processed video.",
        "Published automatically by Hidden Beyond from a source that passed the bot's rights checks."
      ].filter(Boolean).join("\n"),
      5000
    );

    const uploadContentType = blob.type || "video/mp4";

    const initUrl = new URL("https://www.googleapis.com/upload/youtube/v3/videos");
    initUrl.searchParams.set("uploadType", "resumable");
    initUrl.searchParams.set("part", "snippet,status");
    initUrl.searchParams.set("notifySubscribers", "false");

    const initRes = await fetch(initUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": uploadContentType,
        "x-upload-content-length": String(blob.size)
      },
      body: JSON.stringify({
        snippet: {
          title,
          description,
          categoryId: "28"
        },
        status: {
          privacyStatus: "public",
          selfDeclaredMadeForKids: false
        }
      })
    });

    if (!initRes.ok) {
      const detail = await initRes.text();
      return Response.json({
        ok: false,
        stage: "youtube_resumable_init",
        youtube_status: initRes.status,
        youtube_error: detail
      }, { status: 502 });
    }

    const uploadUrl = initRes.headers.get("location");
    if (!uploadUrl) throw new Error("YouTube did not return a resumable upload URL");

    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": uploadContentType,
        "content-length": String(blob.size)
      },
      body: blob
    });

    const uploaded = await uploadRes.json().catch(async () => ({ raw: await uploadRes.text() }));
    if (!uploadRes.ok || !uploaded?.id) {
      return Response.json({
        ok: false,
        stage: "youtube_upload",
        youtube_status: uploadRes.status,
        youtube_error: uploaded
      }, { status: 502 });
    }

    const update = await supabase
      .from("videos")
      .update({
        status: "uploaded",
        youtube_video_id: uploaded.id,
        uploaded_at: new Date().toISOString()
      })
      .eq("id", candidate.data.id)
      .select("id,title,status,youtube_video_id,uploaded_at")
      .single();

    if (update.error) throw new Error(`Database update failed after YouTube upload: ${update.error.message}`);

    return Response.json({
      ok: true,
      stage: "uploaded",
      channel_id: connection.data.channel_id,
      channel_title: connection.data.channel_title,
      requested_privacy_status: "public",
      actual_privacy_status: uploaded?.status?.privacyStatus || null,
      youtube_video_id: uploaded.id,
      video: update.data
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
});
