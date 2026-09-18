import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

type Media = {
  url?: string;
  filename?: string;
  media_type?: string;
  width?: number;
  height?: number;
};

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

function collectMovies(value: unknown, out: Media[] = []): Media[] {
  if (Array.isArray(value)) {
    for (const item of value) collectMovies(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.media_type === "Movie" && typeof obj.url === "string") {
      out.push(obj as Media);
    }
    for (const child of Object.values(obj)) collectMovies(child, out);
  }
  return out;
}

function hasRestrictedAudio(page: unknown): boolean {
  const text = JSON.stringify(page).toLowerCase();
  const markers = [
    "music credit",
    "music credits",
    "universal production music",
    "licensed music",
    "copyrighted music",
    "all rights reserved"
  ];
  return markers.some((marker) => text.includes(marker));
}

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
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

    const searchUrl = "https://svs.gsfc.nasa.gov/api/search/?search=Black%20Hole%20Accretion%20Disk&limit=20";
    const searchRes = await fetch(searchUrl, { headers: { "User-Agent": "Hidden-Beyond-Collector/1.0" } });
    if (!searchRes.ok) {
      throw new Error(`SVS search failed: HTTP ${searchRes.status}`);
    }
    const search = await searchRes.json();
    const results = Array.isArray(search?.results) ? search.results : [];

    let selected:
      | { page: any; movie: Media; bytes: number }
      | null = null;

    for (const result of results) {
      const id = Number(result?.id);
      if (!Number.isFinite(id)) continue;

      const pageRes = await fetch(`https://svs.gsfc.nasa.gov/api/${id}/`, {
        headers: { "User-Agent": "Hidden-Beyond-Collector/1.0" }
      });
      if (!pageRes.ok) continue;
      const page = await pageRes.json();

      if (hasRestrictedAudio(page)) continue;

      const movies = collectMovies(page)
        .filter((m) => typeof m.url === "string" && m.url!.toLowerCase().endsWith(".mp4"))
        .filter((m) => !m.width || m.width <= 1920);

      for (const movie of movies) {
        const head = await fetch(movie.url!, {
          method: "HEAD",
          headers: { "User-Agent": "Hidden-Beyond-Collector/1.0" }
        });
        if (!head.ok) continue;
        const bytes = Number(head.headers.get("content-length") || "0");
        if (bytes > 0 && bytes <= 20 * 1024 * 1024) {
          selected = { page, movie, bytes };
          break;
        }
      }
      if (selected) break;
    }

    if (!selected) {
      return Response.json({
        ok: false,
        stage: "discover",
        error: "No rights-safe MP4 <=20MB found for the search query"
      }, { status: 404 });
    }

    const videoRes = await fetch(selected.movie.url!, {
      headers: { "User-Agent": "Hidden-Beyond-Collector/1.0" }
    });
    if (!videoRes.ok) throw new Error(`Video download failed: HTTP ${videoRes.status}`);

    const body = await videoRes.arrayBuffer();
    if (body.byteLength > 25 * 1024 * 1024) {
      throw new Error("Downloaded file exceeded the 25MB ingest limit");
    }

    const filename = safeFilename(
      selected.movie.filename ||
      new URL(selected.movie.url!).pathname.split("/").pop() ||
      `svs-${selected.page.id}.mp4`
    );
    const storagePath = `nasa-svs/${selected.page.id}/${filename}`;

    const upload = await supabase.storage
      .from("video-ingest")
      .upload(storagePath, body, {
        contentType: "video/mp4",
        cacheControl: "3600",
        upsert: true
      });

    if (upload.error) throw new Error(`Storage upload failed: ${upload.error.message}`);

    const row = {
      source_id: 1,
      source_video_id: String(selected.page.id),
      source_url: selected.page.url || `https://svs.gsfc.nasa.gov/${selected.page.id}/`,
      title: selected.page.title || "NASA SVS video",
      status: "downloaded",
      storage_path: storagePath,
      rights_verified: true,
      rights_basis: "NASA SVS states its content is public domain unless otherwise noted; collector excluded pages with explicit licensed/music restriction markers.",
      download_url: selected.movie.url
    };

    const db = await supabase
      .from("videos")
      .upsert(row, { onConflict: "source_id,source_video_id" })
      .select("id,source_id,source_video_id,title,status,storage_path,rights_verified,download_url")
      .single();

    if (db.error) throw new Error(`Database upsert failed: ${db.error.message}`);

    return Response.json({
      ok: true,
      stage: "downloaded",
      nasa_page_id: selected.page.id,
      title: selected.page.title,
      source_url: row.source_url,
      download_url: selected.movie.url,
      bytes: body.byteLength,
      storage_path: storagePath,
      rights_verified: true,
      database: db.data
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
});
