import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const UA = "Hidden-Beyond-Story-Collector/1.1 (https://github.com/duykhanhrungnhum-debug/mystery-video)";

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


async function sleep(ms:number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRendered(title:string): Promise<{html:string,url:string} | null> {
  const u = new URL("https://zh.wikisource.org/w/index.php");
  u.searchParams.set("title", title);
  u.searchParams.set("action", "render");
  u.searchParams.set("uselang", "zh-hant");

  let lastStatus = 0;
  for (let attempt=0; attempt<4; attempt++) {
    const res = await fetch(u, {
      headers:{
        "User-Agent":UA,
        "Accept":"text/html,application/xhtml+xml"
      }
    });
    lastStatus = res.status;
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) {
      await sleep(1000 * Math.pow(2, attempt));
      continue;
    }
    if (!res.ok) throw new Error(`Wikisource HTTP ${res.status} for ${title}`);
    const html = await res.text();
    if (/noarticletext|There is currently no text in this page|此頁面目前沒有文字/i.test(html)) return null;
    return {
      html,
      url:`https://zh.wikisource.org/wiki/${encodeURIComponent(title)}`
    };
  }
  throw new Error(`Wikisource HTTP ${lastStatus} after retries for ${title}`);
}

async function fetchEpisode(title:string): Promise<{title:string,text:string,url:string} | null> {
  const page = await fetchRendered(title);
  if (!page) return null;
  const text = htmlToText(page.html);
  if (text.length < 200) return null;
  const h = page.html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return {
    title: h ? htmlToText(h[1]) : title,
    text,
    url: page.url
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
      let next = Number(series.next_episode_to_collect || 1);

      // Only probe for new source episodes after the backlog has been collected.
      // This keeps collection strictly sequential and avoids unnecessary source requests.
      if (next > latest) {
        for (let i=0;i<10;i++) {
          const candidate = latest + 1;
          const probe = await fetchEpisode(episodePage(series,candidate));
          if (!probe) break;
          latest = candidate;
        }
      }

      await supabase.from("story_series").update({
        latest_known_episode: latest,
        last_checked_at: new Date().toISOString()
      }).eq("id",series.id);
      let last = Number(series.last_collected_episode || 0);
      const collected:any[] = [];

      for (let i=0; i<maxPerSeries && next<=latest; i++) {
        if (next !== last + 1) throw new Error(`Order invariant failed for ${series.source_key}: next=${next}, last=${last}`);
        const pageTitle = episodePage(series,next);
        const episode = await fetchEpisode(pageTitle);
        if (!episode) {
          throw new Error(`Missing expected episode ${next} for ${series.source_key}: ${pageTitle}`);
        }
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
