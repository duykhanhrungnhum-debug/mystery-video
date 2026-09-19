import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const API = "https://zh.wikisource.org/w/api.php";
const UA = "Hidden-Beyond-Story-Collector/1.0";

function adminKey(): string {
  const modern = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modern) {
    const parsed = JSON.parse(modern);
    if (parsed.default) return parsed.default;
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("No Supabase admin key available");
  return legacy;
}

function episodePage(series:any, n:number): string {
  const s = String(n);
  if (series.episode_kind === "hui3") return `${series.page_prefix}${s.padStart(3,"0")}回`;
  if (series.episode_kind === "juan3") return `${series.page_prefix}${s.padStart(3,"0")}`;
  if (series.episode_kind === "juan2") return `${series.page_prefix}${s.padStart(2,"0")}卷`;
  throw new Error(`Unsupported episode kind: ${series.episode_kind}`);
}

function decodeHtml(s:string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n,16)));
}

function htmlToText(html:string): string {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<table[\s\S]*?<\/table>/gi, " ")
      .replace(/<sup[^>]*class=["'][^"']*reference[^"']*["'][^>]*>[\s\S]*?<\/sup>/gi, " ")
      .replace(/<span[^>]*class=["'][^"']*mw-editsection[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function api(params:Record<string,string>): Promise<any> {
  const u = new URL(API);
  for (const [k,v] of Object.entries({format:"json",formatversion:"2",origin:"*",...params})) {
    u.searchParams.set(k,v);
  }
  const res = await fetch(u, {headers:{"User-Agent":UA}});
  if (!res.ok) throw new Error(`Wikisource API HTTP ${res.status}`);
  return await res.json();
}

async function pageExists(title:string): Promise<boolean> {
  const j = await api({action:"query",titles:title});
  const page = j?.query?.pages?.[0];
  return Boolean(page && !page.missing && Number(page.pageid) > 0);
}

async function fetchEpisode(title:string): Promise<{title:string,text:string,url:string}> {
  const j = await api({action:"parse",page:title,prop:"text|displaytitle"});
  if (j?.error) throw new Error(`Parse failed for ${title}: ${j.error.info || j.error.code}`);
  const html = String(j?.parse?.text || "");
  const text = htmlToText(html);
  if (text.length < 200) throw new Error(`Parsed text too short for ${title}`);
  const display = htmlToText(String(j?.parse?.displaytitle || title)).split("\n")[0].trim() || title;
  return {
    title: display,
    text,
    url: `https://zh.wikisource.org/wiki/${encodeURIComponent(title)}`
  };
}

Deno.serve(async (req:Request) => {
  if (req.method !== "POST") return Response.json({ok:false,error:"method_not_allowed"},{status:405});
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, adminKey(), {
      auth:{persistSession:false,autoRefreshToken:false}
    });
    const botKey = req.headers.get("x-bot-key") || "";
    const auth = await supabase.rpc("verify_video_bot_key",{candidate:botKey});
    if (auth.error || auth.data !== true) return Response.json({ok:false,error:"unauthorized"},{status:401});

    let body:any = {};
    try { body = await req.json(); } catch {}
    const onlyKey = String(body?.source_key || "").trim();
    const maxPerSeries = Math.max(1, Math.min(10, Number(body?.max_per_series || 3)));

    let q = supabase
      .from("story_series")
      .select("id,source_id,title,source_key,page_prefix,episode_kind,latest_known_episode,next_episode_to_collect,last_collected_episode,active")
      .eq("active",true)
      .order("id");
    if (onlyKey) q = q.eq("source_key",onlyKey);
    const seriesRows = await q;
    if (seriesRows.error) throw new Error(seriesRows.error.message);
    if (!seriesRows.data?.length) return Response.json({ok:true,stage:"idle",message:"No active story series"});

    const results:any[] = [];
    for (const series of seriesRows.data) {
      let latest = Number(series.latest_known_episode || 0);

      // Monitor sequentially beyond the last known episode. This is how new source updates are detected.
      for (let i=0;i<10;i++) {
        const candidate = latest + 1;
        if (!(await pageExists(episodePage(series,candidate)))) break;
        latest = candidate;
      }

      if (latest !== Number(series.latest_known_episode || 0)) {
        await supabase.from("story_series").update({
          latest_known_episode: latest,
          last_checked_at: new Date().toISOString()
        }).eq("id",series.id);
      } else {
        await supabase.from("story_series").update({
          last_checked_at: new Date().toISOString()
        }).eq("id",series.id);
      }

      let next = Number(series.next_episode_to_collect || 1);
      let last = Number(series.last_collected_episode || 0);
      const collected:any[] = [];

      for (let i=0; i<maxPerSeries && next<=latest; i++) {
        if (next !== last + 1) throw new Error(`Order invariant failed for ${series.source_key}: next=${next}, last=${last}`);
        const pageTitle = episodePage(series,next);
        if (!(await pageExists(pageTitle))) {
          throw new Error(`Missing expected episode ${next} for ${series.source_key}: ${pageTitle}`);
        }

        const episode = await fetchEpisode(pageTitle);
        const inserted = await supabase.from("story_episodes").upsert({
          series_id:series.id,
          episode_no:next,
          source_page_title:pageTitle,
          source_url:episode.url,
          title:episode.title,
          source_text:episode.text,
          status:"collected",
          updated_at:new Date().toISOString()
        },{onConflict:"series_id,episode_no"})
          .select("id,episode_no,title,status")
          .single();
        if (inserted.error) throw new Error(`Episode save failed: ${inserted.error.message}`);

        last = next;
        next += 1;
        await supabase.from("story_series").update({
          latest_known_episode:latest,
          last_collected_episode:last,
          next_episode_to_collect:next,
          last_collected_at:new Date().toISOString(),
          last_checked_at:new Date().toISOString()
        }).eq("id",series.id);
        collected.push(inserted.data);
      }

      results.push({
        series_id:series.id,
        source_key:series.source_key,
        latest_known_episode:latest,
        last_collected_episode:last,
        next_episode_to_collect:next,
        caught_up: next > latest,
        collected
      });
    }

    return Response.json({ok:true,stage:"ordered_collection",results});
  } catch (error) {
    return Response.json({ok:false,error:error instanceof Error ? error.message : String(error)},{status:500});
  }
});
