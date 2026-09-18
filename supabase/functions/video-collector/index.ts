import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const UA = "Hidden-Beyond-Collector/2.0";
const MAX_BYTES = 38 * 1024 * 1024;

type Candidate = {
  sourceId: number;
  sourceVideoId: string;
  sourceUrl: string;
  title: string;
  downloadUrl: string;
  rightsBasis: string;
  contentType?: string;
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

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function riskyText(value: unknown): boolean {
  const text = JSON.stringify(value).toLowerCase();
  return [
    "licensed music",
    "copyrighted music",
    "music courtesy",
    "music credit",
    "music credits",
    "all rights reserved",
    "not in the public domain",
    "third-party footage",
    "third party footage"
  ].some((m) => text.includes(m));
}

async function getJson(url: string, headers: Record<string,string> = {}): Promise<any> {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return await res.json();
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return await res.text();
}

async function alreadyStored(supabase: any, sourceId: number, sourceVideoId: string): Promise<boolean> {
  const row = await supabase
    .from("videos")
    .select("id,status")
    .eq("source_id", sourceId)
    .eq("source_video_id", sourceVideoId)
    .maybeSingle();
  if (row.error) throw new Error(`Existing-video lookup failed: ${row.error.message}`);
  return Boolean(row.data && ["downloaded", "uploaded"].includes(row.data.status));
}

async function probe(url: string): Promise<{ok:boolean, bytes:number, contentType:string}> {
  try {
    const head = await fetch(url, { method: "HEAD", headers: { "User-Agent": UA } });
    if (!head.ok) return { ok:false, bytes:0, contentType:"" };
    const bytes = Number(head.headers.get("content-length") || "0");
    const contentType = (head.headers.get("content-type") || "").split(";")[0].trim();
    if (bytes > MAX_BYTES) return { ok:false, bytes, contentType };
    return { ok:true, bytes, contentType };
  } catch {
    return { ok:false, bytes:0, contentType:"" };
  }
}

async function chooseUrl(urls: string[]): Promise<{url:string, contentType:string} | null> {
  const unique = [...new Set(urls)].filter(Boolean);
  const scored = unique.sort((a,b) => {
    const rank = (u:string) =>
      /~small|~mobile|_360|_480|_512|_720/i.test(u) ? 0 :
      /~medium|_1080/i.test(u) ? 1 : 2;
    return rank(a) - rank(b);
  });
  for (const url of scored) {
    const p = await probe(url);
    if (p.ok && (!p.bytes || p.bytes <= MAX_BYTES)) {
      return { url, contentType: p.contentType };
    }
  }
  return null;
}

function collectSvsMovies(value: unknown, out: any[] = []): any[] {
  if (Array.isArray(value)) {
    for (const item of value) collectSvsMovies(item, out);
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.media_type === "Movie" && typeof obj.url === "string") out.push(obj);
    for (const child of Object.values(obj)) collectSvsMovies(child, out);
  }
  return out;
}

async function collectNasaSvs(supabase: any): Promise<Candidate | null> {
  const queries = ["black hole", "aurora", "volcano", "asteroid"];
  for (const q of queries) {
    const search = await getJson(`https://svs.gsfc.nasa.gov/api/search/?search=${encodeURIComponent(q)}&limit=30`);
    for (const result of Array.isArray(search?.results) ? search.results : []) {
      const id = Number(result?.id);
      if (!Number.isFinite(id) || await alreadyStored(supabase, 1, String(id))) continue;
      const page = await getJson(`https://svs.gsfc.nasa.gov/api/${id}/`);
      if (riskyText(page)) continue;
      const urls = collectSvsMovies(page)
        .filter((m:any) => typeof m.url === "string" && /\.mp4(\?|$)/i.test(m.url))
        .filter((m:any) => !m.width || m.width <= 1920)
        .map((m:any) => m.url as string);
      const chosen = await chooseUrl(urls);
      if (!chosen) continue;
      return {
        sourceId: 1,
        sourceVideoId: String(id),
        sourceUrl: page.url || `https://svs.gsfc.nasa.gov/${id}/`,
        title: page.title || `NASA SVS ${id}`,
        downloadUrl: chosen.url,
        contentType: chosen.contentType || "video/mp4",
        rightsBasis: "NASA SVS content is public domain unless otherwise noted; this item passed automated exclusion checks for explicit licensed/copyrighted music or third-party restriction markers."
      };
    }
  }
  return null;
}

async function collectNoaaFisheries(supabase: any): Promise<Candidate | null> {
  const category = "https://videos.fisheries.noaa.gov/category/videos/b-roll-packages---all";
  const html = await getText(category);
  const ids = [...html.matchAll(/videoId(?:%3D|=)(\d+)/g)].map((m) => m[1]);
  const og = html.match(/videoId=(\d+)/);
  if (og) ids.unshift(og[1]);
  const uniqueIds = [...new Set(ids)];

  const config = await getJson("https://players.brightcove.net/659677166001/4b3c8a9e-7bf7-43dd-b693-2614cc1ed6b7_default/config.json");
  const policy = config?.video_cloud?.policy_key;
  if (!policy) throw new Error("NOAA Fisheries Brightcove policy key unavailable");

  for (const id of uniqueIds) {
    if (await alreadyStored(supabase, 2, id)) continue;
    const video = await getJson(
      `https://edge.api.brightcove.com/playback/v1/accounts/659677166001/videos/${id}`,
      { Accept: `application/json;pk=${policy}` }
    );
    const sources = Array.isArray(video?.sources) ? video.sources : [];
    const mp4s = sources
      .filter((s:any) => typeof s.src === "string" && (s.container === "MP4" || s.type === "video/mp4" || /\.mp4(\?|$)/i.test(s.src)))
      .sort((a:any,b:any) => Number(a.size || 0) - Number(b.size || 0));
    const urls = mp4s
      .filter((s:any) => !s.size || Number(s.size) <= MAX_BYTES)
      .map((s:any) => s.src as string);
    const chosen = await chooseUrl(urls);
    if (!chosen) continue;
    return {
      sourceId: 2,
      sourceVideoId: id,
      sourceUrl: `${category}?videoId=${id}`,
      title: video.name || `NOAA Fisheries B-Roll ${id}`,
      downloadUrl: chosen.url,
      contentType: chosen.contentType || "video/mp4",
      rightsBasis: "NOAA Fisheries B-roll package: NOAA states B-roll packages are public domain and may be downloaded for use with NOAA Fisheries credit."
    };
  }
  return null;
}

async function collectNoaaSos(supabase: any): Promise<Candidate | null> {
  const pages = [
    "https://sos.noaa.gov/catalog/datasets/120-years-earthquakes-tsunamis/",
    "https://sos.noaa.gov/catalog/datasets/temperature-anomaly-yearly-noaa-1850-present/",
    "https://sos.noaa.gov/catalog/datasets/sos-locations/",
    "https://sos.noaa.gov/catalog/datasets/etopo1-topography-and-bathymetry/",
    "https://sos.noaa.gov/catalog/datasets/cooking-up-a-storm/"
  ];
  for (const pageUrl of pages) {
    const slug = new URL(pageUrl).pathname.split("/").filter(Boolean).pop() || pageUrl;
    if (await alreadyStored(supabase, 3, slug)) continue;
    let html: string;
    try { html = await getText(pageUrl); } catch { continue; }
    const lower = html.toLowerCase();
    if (!lower.includes("noaa") || lower.includes("not in the public domain") || riskyText(html)) continue;

    const hrefs = [...html.matchAll(/href=["']([^"']+\.(?:mp4|mov|webm)(?:\?[^"']*)?)["']/gi)]
      .map((m) => {
        try { return new URL(m[1].replace(/&amp;/g, "&"), pageUrl).toString(); } catch { return ""; }
      })
      .filter(Boolean);
    if (slug === "120-years-earthquakes-tsunamis") {
      hrefs.unshift("https://sos.noaa.gov/videos-original/tsunami_history.mov");
    }
    const chosen = await chooseUrl(hrefs);
    if (!chosen) continue;
    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return {
      sourceId: 3,
      sourceVideoId: slug,
      sourceUrl: pageUrl,
      title: titleMatch ? stripHtml(titleMatch[1]).replace(/\s*\|.*$/, "") : slug.replace(/-/g, " "),
      downloadUrl: chosen.url,
      contentType: chosen.contentType || (/\.mov(\?|$)/i.test(chosen.url) ? "video/quicktime" : "video/mp4"),
      rightsBasis: "NOAA Science On a Sphere item identified as NOAA-created and without an explicit third-party/public-domain exclusion marker; NOAA-created digital media is generally reusable subject to item-level restrictions."
    };
  }
  return null;
}

async function collectUsgs(supabase: any): Promise<Candidate | null> {
  const cameras = await getJson("https://api.waterdata.usgs.gov/nims/v0/cameras?returnFields=camId,camName,tlDir,newestImageDT");
  const preferred = (Array.isArray(cameras) ? cameras : [])
    .filter((c:any) => typeof c.camId === "string" && typeof c.tlDir === "string")
    .sort((a:any,b:any) => {
      const ar = /^HI_Kilauea_/i.test(a.camId) ? 0 : 1;
      const br = /^HI_Kilauea_/i.test(b.camId) ? 0 : 1;
      return ar - br;
    });

  for (const cam of preferred) {
    const id = String(cam.camId);
    if (await alreadyStored(supabase, 4, id)) continue;
    const url = `${cam.tlDir}${id}_720.mp4`;
    const chosen = await chooseUrl([url]);
    if (!chosen) continue;
    return {
      sourceId: 4,
      sourceVideoId: id,
      sourceUrl: `https://api.waterdata.usgs.gov/nims/v0/cameras?camId=${encodeURIComponent(id)}`,
      title: `USGS Timelapse — ${cam.camName || id}`,
      downloadUrl: chosen.url,
      contentType: chosen.contentType || "video/mp4",
      rightsBasis: "Official U.S. Geological Survey NIMS camera timelapse. USGS-authored/produced information is generally U.S. public domain unless otherwise noted."
    };
  }
  return null;
}

async function collectNasaImages(supabase: any): Promise<Candidate | null> {
  const queries = ["black hole", "asteroid", "aurora", "volcano"];
  for (const q of queries) {
    const search = await getJson(`https://images-api.nasa.gov/search?q=${encodeURIComponent(q)}&media_type=video&page_size=25`);
    for (const item of Array.isArray(search?.collection?.items) ? search.collection.items : []) {
      const data = Array.isArray(item?.data) ? item.data[0] : null;
      const id = String(data?.nasa_id || "").trim();
      if (!id || await alreadyStored(supabase, 6, id) || riskyText(data)) continue;
      if (typeof item?.href !== "string" || !item.href.startsWith("https://images-assets.nasa.gov/")) continue;
      let assets: any;
      try { assets = await getJson(item.href); } catch { continue; }
      const urls = (Array.isArray(assets) ? assets : [])
        .filter((u:any) => typeof u === "string" && /^https?:\/\/images-assets\.nasa\.gov\//i.test(u) && /\.mp4(\?|$)/i.test(u))
        .map((u:string) => u.replace(/^http:\/\//i, "https://"));
      const chosen = await chooseUrl(urls);
      if (!chosen) continue;
      return {
        sourceId: 6,
        sourceVideoId: id,
        sourceUrl: `https://images.nasa.gov/details/${encodeURIComponent(id)}`,
        title: data?.title || id,
        downloadUrl: chosen.url,
        contentType: chosen.contentType || "video/mp4",
        rightsBasis: "Official NASA Image and Video Library asset; NASA media is generally reusable under NASA media usage guidelines, and this record passed automated third-party/licensed-content exclusion checks."
      };
    }
  }
  return null;
}

async function pickSource(supabase: any): Promise<number> {
  const active = await supabase
    .from("sources")
    .select("id")
    .eq("active", true)
    .eq("auto_eligible", true)
    .in("id", [1,2,3,4,6])
    .order("id");
  if (active.error) throw new Error(`Source lookup failed: ${active.error.message}`);
  const ids = (active.data || []).map((x:any) => Number(x.id));
  if (!ids.length) throw new Error("No automatic sources are active");

  const recent = await supabase
    .from("videos")
    .select("source_id,discovered_at")
    .in("source_id", ids)
    .order("discovered_at", { ascending: false });
  if (recent.error) throw new Error(`Recent-source lookup failed: ${recent.error.message}`);

  const latest = new Map<number,string>();
  for (const row of recent.data || []) {
    const sid = Number(row.source_id);
    if (!latest.has(sid)) latest.set(sid, row.discovered_at);
  }
  ids.sort((a,b) => {
    const av = latest.get(a) || "";
    const bv = latest.get(b) || "";
    if (!av && bv) return -1;
    if (av && !bv) return 1;
    return av.localeCompare(bv);
  });
  return ids[0];
}

async function discover(sourceId:number, supabase:any): Promise<Candidate | null> {
  if (sourceId === 1) return collectNasaSvs(supabase);
  if (sourceId === 2) return collectNoaaFisheries(supabase);
  if (sourceId === 3) return collectNoaaSos(supabase);
  if (sourceId === 4) return collectUsgs(supabase);
  if (sourceId === 6) return collectNasaImages(supabase);
  throw new Error(`Unsupported automatic source: ${sourceId}`);
}

async function storeAndUpload(candidate: Candidate, req:Request, botKey:string, supabase:any) {
  const videoRes = await fetch(candidate.downloadUrl, { headers: { "User-Agent": UA } });
  if (!videoRes.ok) throw new Error(`Video download failed: HTTP ${videoRes.status}`);
  const length = Number(videoRes.headers.get("content-length") || "0");
  if (length > MAX_BYTES) throw new Error(`Video exceeds ingest limit: ${length} bytes`);
  const body = await videoRes.arrayBuffer();
  if (body.byteLength > MAX_BYTES) throw new Error(`Downloaded file exceeds ingest limit: ${body.byteLength} bytes`);

  let ext = ".mp4";
  const path = new URL(candidate.downloadUrl).pathname.toLowerCase();
  if (path.endsWith(".mov")) ext = ".mov";
  else if (path.endsWith(".webm")) ext = ".webm";
  const original = new URL(candidate.downloadUrl).pathname.split("/").pop() || `video${ext}`;
  const filename = safeFilename(original.includes(".") ? original : original + ext);
  const storagePath = `source-${candidate.sourceId}/${safeFilename(candidate.sourceVideoId)}/${filename}`;
  const contentType = candidate.contentType || videoRes.headers.get("content-type")?.split(";")[0] || (ext === ".mov" ? "video/quicktime" : "video/mp4");

  const storage = await supabase.storage
    .from("video-ingest")
    .upload(storagePath, body, { contentType, cacheControl:"3600", upsert:true });
  if (storage.error) throw new Error(`Storage upload failed: ${storage.error.message}`);

  const db = await supabase
    .from("videos")
    .upsert({
      source_id: candidate.sourceId,
      source_video_id: candidate.sourceVideoId,
      source_url: candidate.sourceUrl,
      title: candidate.title,
      status: "downloaded",
      storage_path: storagePath,
      rights_verified: true,
      rights_basis: candidate.rightsBasis,
      download_url: candidate.downloadUrl
    }, { onConflict:"source_id,source_video_id" })
    .select("id,source_id,source_video_id,title,status,storage_path,rights_verified,download_url")
    .single();
  if (db.error) throw new Error(`Database upsert failed: ${db.error.message}`);

  let uploadTrigger:any = null;
  try {
    const uploaderUrl = new URL("/functions/v1/youtube-uploader", req.url).toString();
    const uploaderRes = await fetch(uploaderUrl, {
      method:"POST",
      headers:{ "content-type":"application/json", "x-bot-key":botKey },
      body:JSON.stringify({ video_id: db.data.id })
    });
    uploadTrigger = { status:uploaderRes.status, result:await uploaderRes.json().catch(() => null) };
  } catch (error) {
    uploadTrigger = { status:"trigger_failed", error:String(error) };
  }

  return {
    source_id:candidate.sourceId,
    title:candidate.title,
    source_url:candidate.sourceUrl,
    bytes:body.byteLength,
    storage_path:storagePath,
    rights_verified:true,
    database:db.data,
    upload_trigger:uploadTrigger
  };
}

Deno.serve(async (req: Request) => {
  if (!["GET","POST"].includes(req.method)) {
    return Response.json({ok:false,error:"method_not_allowed"},{status:405});
  }
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, adminKey(), {
      auth:{persistSession:false,autoRefreshToken:false}
    });
    const botKey = req.headers.get("x-bot-key") || "";
    const authCheck = await supabase.rpc("verify_video_bot_key", { candidate:botKey });
    if (authCheck.error || authCheck.data !== true) {
      return Response.json({ok:false,error:"unauthorized"},{status:401});
    }

    let body:any = {};
    if (req.method === "POST") {
      try { body = await req.json(); } catch { body = {}; }
    }
    const requested = Number(body?.source_id || 0);
    const sourceId = requested || await pickSource(supabase);
    const candidate = await discover(sourceId, supabase);
    if (!candidate) {
      return Response.json({ok:false,stage:"discover",source_id:sourceId,error:"No new rights-safe downloadable video found"},{status:404});
    }
    const result = await storeAndUpload(candidate, req, botKey, supabase);
    return Response.json({ok:true,stage:"downloaded_and_upload_triggered",...result});
  } catch (error) {
    return Response.json({ok:false,error:error instanceof Error ? error.message : String(error)},{status:500});
  }
});
