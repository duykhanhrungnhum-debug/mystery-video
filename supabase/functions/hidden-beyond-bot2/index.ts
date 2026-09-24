import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";

const REPO="duykhanhrungnhum-debug/mystery-video";
const AUD="hidden-beyond-bot2";
const JWKS=createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));
const FIXED=[
  {rotation:1,source_id:29,series_id:2},
  {rotation:2,source_id:30,series_id:3},
  {rotation:3,source_id:31,series_id:4},
  {rotation:4,source_id:32,series_id:5},
  {rotation:5,source_id:33,series_id:6},
];
const WORKER_STAGES=new Set([
  "source_downloading","source_ready","gpu_submitted","asr","translating",
  "translation_repair","translation_complete","tts","mixing","youtube_upload","youtube_uploaded"
]);

function adminKey():string{
  const modern=Deno.env.get("SUPABASE_SECRET_KEYS");
  if(modern){const p=JSON.parse(modern); if(p.default) return p.default;}
  const legacy=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!legacy) throw new Error("no_admin_key");
  return legacy;
}
function clip(value:any,max:number):string{
  const s=String(value??"").trim();
  return s.length<=max?s:s.slice(0,max-1).trimEnd()+"…";
}
function randomToken():string{
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  let raw=""; for(const b of bytes) raw+=String.fromCharCode(b);
  return btoa(raw).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}
async function sha256Hex(value:string):Promise<string>{
  const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(d)).map(x=>x.toString(16).padStart(2,"0")).join("");
}
function safeEqual(a:string,b:string):boolean{
  if(a.length!==b.length) return false;
  let x=0; for(let i=0;i<a.length;i++) x|=a.charCodeAt(i)^b.charCodeAt(i);
  return x===0;
}
async function authorizeGitHub(req:Request){
  const auth=req.headers.get("authorization")||"";
  if(!auth.startsWith("Bearer ")) throw new Error("missing_bearer");
  const {payload}=await jwtVerify(auth.slice(7),JWKS,{
    issuer:"https://token.actions.githubusercontent.com",audience:AUD
  });
  if(payload.repository!==REPO) throw new Error("wrong_repository");
  if(payload.ref!=="refs/heads/main") throw new Error("wrong_ref");
  if(!["push","workflow_dispatch","schedule"].includes(String(payload.event_name||"")))
    throw new Error("wrong_event");
  const wr=String(payload.job_workflow_ref||"");
  const allowedWorkflows=[
    REPO+"/.github/workflows/hidden-beyond-bot2-vault.yml@",
    REPO+"/.github/workflows/hidden-beyond-bot2.yml@",
  ];
  if(wr && !allowedWorkflows.some((prefix)=>wr.startsWith(prefix)))
    throw new Error("wrong_workflow");
}
async function loadState(db:any){
  const q=await db.from("hidden_beyond_bot2_state").select("*").eq("id",1).single();
  if(q.error) throw new Error("state_lookup_failed:"+q.error.message);
  return q.data;
}
const CHECKPOINT_PHASE_RANK:Record<string,number>={
  asr_complete:10,
  translating:20,
  translation_complete:30,
};
function checkpointRank(phase:any):number{
  return CHECKPOINT_PHASE_RANK[String(phase||"")]||0;
}
async function checkpointSummary(db:any,sourceVideoId:string){
  const videoId=String(sourceVideoId||"").trim();
  if(!videoId) return {
    checkpoint_found:false,checkpoint_phase:null,checkpoint_cursor:0,
    checkpoint_segments:0,checkpoint_translated:0,checkpoint_cpu_ready:false,
  };
  const q=await db.from("hidden_beyond_bot2_checkpoints")
    .select("worker_revision,phase,cursor,payload,updated_at")
    .eq("source_video_id",videoId).maybeSingle();
  if(q.error) throw new Error("checkpoint_summary_failed:"+q.error.message);
  if(!q.data) return {
    checkpoint_found:false,checkpoint_phase:null,checkpoint_cursor:0,
    checkpoint_segments:0,checkpoint_translated:0,checkpoint_cpu_ready:false,
  };
  const payload=(q.data.payload&&typeof q.data.payload==="object")?q.data.payload:{};
  const segments=Array.isArray(payload.segments_data)?payload.segments_data.length:0;
  const translated=(payload.translated&&typeof payload.translated==="object")
    ?Object.keys(payload.translated).length:0;
  const phase=String(q.data.phase||"");
  return {
    checkpoint_found:true,
    checkpoint_revision:String(q.data.worker_revision||""),
    checkpoint_phase:phase,
    checkpoint_cursor:Number(q.data.cursor||0),
    checkpoint_segments:segments,
    checkpoint_translated:translated,
    checkpoint_cpu_ready:(
      phase==="translation_complete" &&
      segments>0 &&
      translated>=segments
    ),
    checkpoint_updated_at:q.data.updated_at,
  };
}
async function authorizeWorker(req:Request,db:any,body:any){
  const token=req.headers.get("x-bot2-token")||"";
  if(!token) throw new Error("missing_worker_token");
  const state=await loadState(db);
  if(state.status!=="running") throw new Error("job_not_running");
  if(!state.job_token_hash||!state.job_expires_at) throw new Error("worker_token_not_issued");
  if(new Date(String(state.job_expires_at)).getTime()<Date.now()) throw new Error("worker_token_expired");
  const hash=await sha256Hex(token);
  if(!safeEqual(hash,String(state.job_token_hash))) throw new Error("invalid_worker_token");
  const sourceVideoId=String(body?.source_video_id||"").trim();
  if(!sourceVideoId||sourceVideoId!==String(state.current_source_video_id||""))
    throw new Error("worker_job_mismatch");
  return state;
}

async function youtubeAccess(db:any){
  const q=await db.from("youtube_connections")
    .select("channel_id,channel_title,refresh_token,scope")
    .order("updated_at",{ascending:false}).limit(1).maybeSingle();
  if(q.error) throw new Error("youtube_connection_lookup_failed:"+q.error.message);
  if(!q.data?.refresh_token) throw new Error("youtube_refresh_token_missing");
  const scope=String(q.data.scope||"");
  if(!scope.includes("youtube.upload")) throw new Error("youtube_upload_scope_missing");
  if(!scope.includes("youtube.force-ssl")&&!scope.includes("/auth/youtube "))
    throw new Error("youtube_playlist_scope_missing");
  const clientId=Deno.env.get("YOUTUBE_CLIENT_ID")||"";
  const clientSecret=Deno.env.get("YOUTUBE_CLIENT_SECRET")||"";
  if(!clientId||!clientSecret) throw new Error("youtube_client_secret_missing");
  const r=await fetch("https://oauth2.googleapis.com/token",{
    method:"POST",
    headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({
      client_id:clientId,client_secret:clientSecret,
      refresh_token:q.data.refresh_token,grant_type:"refresh_token"
    })
  });
  const b=await r.json();
  if(!r.ok||!b.access_token) throw new Error("youtube_token_refresh_failed:"+JSON.stringify(b));
  return {token:String(b.access_token),connection:q.data};
}

function channelIdFromUrl(value:any):string{
  const m=String(value||"").match(/\/channel\/([^/?#]+)/);
  return m?String(m[1]):"";
}
function normalizeSeriesMatch(value:any):string{
  return String(value||"")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s《》【】\[\]（）()「」『』:：·・~～_—–\-]/g,"");
}
async function youtubeJson(token:string,url:URL){
  const r=await fetch(url,{headers:{authorization:"Bearer "+token}});
  const b=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error("youtube_read_failed:"+r.status+":"+JSON.stringify(b));
  return b;
}
async function youtubeVideosByIds(token:string,ids:string[]):Promise<any[]>{
  const unique=[...new Set(ids.filter(Boolean))];
  const out:any[]=[];
  for(let i=0;i<unique.length;i+=50){
    const url=new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part","snippet,status");
    url.searchParams.set("id",unique.slice(i,i+50).join(","));
    const b=await youtubeJson(token,url);
    out.push(...(Array.isArray(b?.items)?b.items:[]));
  }
  return out;
}

function normalizeLocatorValue(value:any):string{
  return String(value||"").trim();
}
function chineseOrdinal(raw:string):number{
  const s=String(raw||"").trim();
  if(/^\d+$/.test(s)) return Number(s);
  const m:Record<string,number>={一:1,二:2,两:2,兩:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
  if(s==="十") return 10;
  if(s.includes("十")){
    const [a,b]=s.split("十",2);
    const tens=a?Number(m[a]||0):1;
    const ones=b?Number(m[b]||0):0;
    return tens*10+ones;
  }
  return Number(m[s]||0);
}
function inferEpisodeNumber(title:any):number{
  const text=String(title||"").normalize("NFKC");
  const digit=text.match(/第\s*(\d{1,4})\s*[季集部]/i)
    || text.match(/(?:season|ep(?:isode)?|s)\s*[-_:#]?\s*(\d{1,4})/i);
  if(digit) return Number(digit[1]||0);
  const zh=text.match(/第\s*([一二三四五六七八九十两兩]+)\s*[季集部]/);
  return zh?chineseOrdinal(String(zh[1]||"")):0;
}
async function saveSourceHealth(db:any,sourceId:number,patch:any){
  const now=new Date().toISOString();
  const current=await db.from("hidden_beyond_source_health")
    .select("failure_count,last_success_at").eq("source_id",sourceId).maybeSingle();
  if(current.error) throw new Error("source_health_lookup_failed:"+current.error.message);
  const isHealthy=String(patch.status||"")==="healthy";
  const failureCount=isHealthy?0:Number(current.data?.failure_count||0)+1;
  const row={
    source_id:sourceId,
    status:String(patch.status||"unknown"),
    resolved_channel_id:patch.resolved_channel_id??null,
    uploads_playlist_id:patch.uploads_playlist_id??null,
    last_checked_at:now,
    last_success_at:isHealthy?now:(current.data?.last_success_at||null),
    failure_count:failureCount,
    reason:clip(patch.reason||"",500)||null,
    diagnostics:patch.diagnostics&&typeof patch.diagnostics==="object"?patch.diagnostics:{},
    updated_at:now,
  };
  const u=await db.from("hidden_beyond_source_health")
    .upsert(row,{onConflict:"source_id"});
  if(u.error) throw new Error("source_health_save_failed:"+u.error.message);
}
async function upsertVerifiedLocator(
  db:any,sourceId:number,locatorType:string,locatorValue:string,provenance:string
){
  const value=normalizeLocatorValue(locatorValue);
  if(!value) return;
  const now=new Date().toISOString();
  const u=await db.from("hidden_beyond_source_locators").upsert({
    source_id:sourceId,locator_type:locatorType,locator_value:value,
    verified:true,provenance,verified_at:now,last_success_at:now,
    failure_count:0,active:true,updated_at:now,
  },{onConflict:"source_id,locator_type,locator_value"});
  if(u.error) throw new Error("source_locator_save_failed:"+u.error.message);
}
async function channelInfo(token:string,channelId:string){
  const id=normalizeLocatorValue(channelId);
  if(!id) return null;
  const url=new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part","snippet,contentDetails");
  url.searchParams.set("id",id);
  const b=await youtubeJson(token,url);
  const item=Array.isArray(b?.items)?b.items[0]:null;
  if(!item) return null;
  return {
    channel_id:String(item?.id||id),
    channel_title:String(item?.snippet?.title||""),
    uploads_playlist_id:String(item?.contentDetails?.relatedPlaylists?.uploads||""),
  };
}
async function playlistChannelId(token:string,playlistId:string):Promise<string>{
  const id=normalizeLocatorValue(playlistId);
  if(!id) return "";
  const url=new URL("https://www.googleapis.com/youtube/v3/playlists");
  url.searchParams.set("part","snippet");
  url.searchParams.set("id",id);
  const b=await youtubeJson(token,url);
  return String(b?.items?.[0]?.snippet?.channelId||"");
}
async function resolveFixedSource(db:any,token:string,fixed:any,src:any){
  const lq=await db.from("hidden_beyond_source_locators")
    .select("locator_type,locator_value,provenance,verified,active")
    .eq("source_id",fixed.source_id).eq("active",true).eq("verified",true);
  if(lq.error) throw new Error("source_locator_lookup_failed:"+lq.error.message);
  const locators=lq.data||[];
  const channelCandidates:string[]=[];
  const addChannel=(v:any)=>{
    const id=normalizeLocatorValue(v);
    if(id&&!channelCandidates.includes(id)) channelCandidates.push(id);
  };
  for(const l of locators) if(l.locator_type==="channel_id") addChannel(l.locator_value);
  addChannel(channelIdFromUrl(src.channel_url));

  const playlistLocators=locators
    .filter((l:any)=>l.locator_type==="uploads_playlist_id")
    .map((l:any)=>normalizeLocatorValue(l.locator_value)).filter(Boolean);
  for(const playlistId of playlistLocators){
    try{
      addChannel(await playlistChannelId(token,playlistId));
    }catch{}
  }

  const seedIds=locators
    .filter((l:any)=>l.locator_type==="seed_video_id")
    .map((l:any)=>normalizeLocatorValue(l.locator_value)).filter(Boolean);
  if(seedIds.length){
    try{
      const seedMeta=await youtubeVideosByIds(token,seedIds);
      for(const v of seedMeta) addChannel(v?.snippet?.channelId);
    }catch{}
  }

  const attempts:any[]=[];
  for(const candidate of channelCandidates){
    try{
      const info=await channelInfo(token,candidate);
      attempts.push({channel_id:candidate,found:Boolean(info),uploads:Boolean(info?.uploads_playlist_id)});
      if(!info?.uploads_playlist_id) continue;
      const canonicalUrl="https://www.youtube.com/channel/"+info.channel_id;
      const su=await db.from("sources").update({channel_url:canonicalUrl}).eq("id",fixed.source_id);
      if(su.error) throw new Error("source_canonical_channel_save_failed:"+su.error.message);
      await upsertVerifiedLocator(db,fixed.source_id,"channel_id",info.channel_id,"resolved_verified_registry");
      await upsertVerifiedLocator(db,fixed.source_id,"uploads_playlist_id",info.uploads_playlist_id,"resolved_verified_registry");
      await saveSourceHealth(db,fixed.source_id,{
        status:"healthy",resolved_channel_id:info.channel_id,
        uploads_playlist_id:info.uploads_playlist_id,reason:"verified_locator_resolved",
        diagnostics:{attempts,seed_count:seedIds.length,channel_title:info.channel_title},
      });
      return {ok:true,...info};
    }catch(err){
      attempts.push({channel_id:candidate,error:clip(err instanceof Error?err.message:String(err),300)});
    }
  }
  await saveSourceHealth(db,fixed.source_id,{
    status:"unavailable",reason:"no_verified_locator_resolved",
    diagnostics:{attempts,seed_count:seedIds.length,locator_count:locators.length},
  });
  return {ok:false,reason:"no_verified_locator_resolved",attempts};
}
async function refreshFixedSources(db:any){
  const yt=await youtubeAccess(db);
  const inserted:any[]=[];
  const skipped:any[]=[];
  const observed:any[]=[];

  for(const fixed of FIXED){
    try{
      const srcQ=await db.from("sources")
        .select("id,name,channel_url,active,auto_eligible,approval_status")
        .eq("id",fixed.source_id).single();
      if(srcQ.error) throw new Error("fixed_source_lookup_failed:"+srcQ.error.message);
      const src=srcQ.data;
      if(!src.active||!src.auto_eligible||src.approval_status!=="approved"){
        await saveSourceHealth(db,fixed.source_id,{
          status:"unavailable",reason:"source_not_auto_approved",diagnostics:{}
        });
        skipped.push({source_id:fixed.source_id,reason:"source_not_auto_approved"});
        continue;
      }

      const resolved=await resolveFixedSource(db,yt.token,fixed,src);
      if(!resolved.ok){
        skipped.push({source_id:fixed.source_id,reason:"source_unavailable"});
        continue;
      }
      const uploads=String(resolved.uploads_playlist_id||"");

      const uploadIds:string[]=[];
      let pageToken="";
      const maxUploadPages=10;
      for(let page=0;page<maxUploadPages;page++){
        const plUrl=new URL("https://www.googleapis.com/youtube/v3/playlistItems");
        plUrl.searchParams.set("part","snippet,contentDetails");
        plUrl.searchParams.set("playlistId",uploads);
        plUrl.searchParams.set("maxResults","50");
        if(pageToken) plUrl.searchParams.set("pageToken",pageToken);
        const pl=await youtubeJson(yt.token,plUrl);
        const ids=(pl?.items||[])
          .map((x:any)=>String(x?.contentDetails?.videoId||x?.snippet?.resourceId?.videoId||""))
          .filter(Boolean);
        uploadIds.push(...ids);
        pageToken=String(pl?.nextPageToken||"");
        if(!pageToken) break;
      }
      const uploadMeta=await youtubeVideosByIds(yt.token,uploadIds);

      const seriesQ=await db.from("source_series")
        .select("id,source_id,series_title,latest_episode_seen,last_ingested_episode,active,state")
        .eq("source_id",fixed.source_id).eq("active",true)
        .order("series_order",{ascending:true});
      if(seriesQ.error) throw new Error("fixed_series_lookup_failed:"+seriesQ.error.message);

      for(const series of seriesQ.data||[]){
        const itemsQ=await db.from("source_items")
          .select("source_item_id,episode_number,source_published_at,checked_at")
          .eq("source_id",fixed.source_id).eq("series_id",series.id)
          .order("episode_number",{ascending:true});
        if(itemsQ.error) throw new Error("fixed_items_lookup_failed:"+itemsQ.error.message);
        const existing=itemsQ.data||[];
        const existingIds=existing.map((x:any)=>String(x.source_item_id||"")).filter(Boolean);
        const existingSet=new Set(existingIds);
        const existingEpisodes=new Set(
          existing.map((x:any)=>Number(x.episode_number||0)).filter((n:number)=>n>0)
        );
        const key=normalizeSeriesMatch(series.series_title);
        if(key.length<4){
          skipped.push({source_id:fixed.source_id,series_id:series.id,reason:"series_match_key_too_short"});
          continue;
        }

        const matching=uploadMeta.filter((v:any)=>{
          const id=String(v?.id||"");
          const titleKey=normalizeSeriesMatch(v?.snippet?.title||"");
          return (
            id && !existingSet.has(id) &&
            titleKey.includes(key) &&
            String(v?.status?.privacyStatus||"")==="public" &&
            String(v?.status?.license||"")==="creativeCommon"
          );
        }).sort((a:any,b:any)=>
          Date.parse(String(a?.snippet?.publishedAt||""))-
          Date.parse(String(b?.snippet?.publishedAt||""))
        );

        const durableTimes=existing
          .map((x:any)=>Date.parse(String(x.source_published_at||"")))
          .filter((x:number)=>Number.isFinite(x));
        const baseline=durableTimes.length?Math.max(...durableTimes):0;
        let cursor=Math.max(
          Number(series.latest_episode_seen||0),
          Number(series.last_ingested_episode||0),
          0,...Array.from(existingEpisodes)
        );
        const queuedEpisodes=new Set<number>();

        for(const v of matching){
          const id=String(v.id);
          const title=String(v?.snippet?.title||id);
          const published=Date.parse(String(v?.snippet?.publishedAt||""));
          const explicitEpisode=inferEpisodeNumber(title);
          let episode=0;
          let discoveryMethod="";
          if(explicitEpisode>0){
            if(existingEpisodes.has(explicitEpisode)||queuedEpisodes.has(explicitEpisode)) continue;
            episode=explicitEpisode;
            discoveryMethod="title_explicit_episode";
          }else if(baseline>0 && Number.isFinite(published) && published>baseline){
            cursor+=1;
            while(existingEpisodes.has(cursor)||queuedEpisodes.has(cursor)) cursor+=1;
            episode=cursor;
            discoveryMethod="chronological_after_durable_baseline";
          }else{
            observed.push({
              source_id:fixed.source_id,series_id:series.id,source_item_id:id,title,
              reason:"ambiguous_episode_without_durable_baseline"
            });
            continue;
          }
          if(episode<=Number(series.last_ingested_episode||0)) continue;
          queuedEpisodes.add(episode);
          cursor=Math.max(cursor,episode);
          const now=new Date().toISOString();
          const row={
            source_id:fixed.source_id,series_id:series.id,source_item_id:id,
            source_url:"https://www.youtube.com/watch?v="+id,title,
            series_title:String(series.series_title||""),episode_number:episode,
            license_type:"creativeCommon",rights_status:"approved",
            rights_basis:"YouTube Data API reports Creative Commons for this selected source item.",
            evidence_url:"https://www.youtube.com/watch?v="+id,
            attribution_text:String(src.name||""),active:true,checked_at:now,
            source_channel_id:String(v?.snippet?.channelId||resolved.channel_id||""),
            source_published_at:Number.isFinite(published)?new Date(published).toISOString():null,
            discovery_method:discoveryMethod,
          };
          const up=await db.from("source_items").upsert(row,{onConflict:"source_id,source_item_id"});
          if(up.error) throw new Error("fixed_item_upsert_failed:"+up.error.message);
          inserted.push({
            source_id:fixed.source_id,series_id:series.id,
            episode_number:episode,source_item_id:id,title,discovery_method:discoveryMethod
          });
        }

        const latest=Math.max(Number(series.latest_episode_seen||0),cursor);
        const su=await db.from("source_series").update({
          latest_episode_seen:latest,updated_at:new Date().toISOString()
        }).eq("id",series.id);
        if(su.error) throw new Error("latest_episode_seen_update_failed:"+su.error.message);

        observed.push({
          source_id:fixed.source_id,series_id:series.id,scanned_uploads:uploadMeta.length,
          eligible_matches:matching.length,queued:queuedEpisodes.size,
          resolved_channel_id:resolved.channel_id,uploads_playlist_id:uploads
        });
      }
    }catch(err){
      const message=clip(err instanceof Error?err.message:String(err),800);
      await saveSourceHealth(db,fixed.source_id,{
        status:"degraded",reason:"source_refresh_failed",diagnostics:{error:message}
      }).catch(()=>{});
      skipped.push({source_id:fixed.source_id,reason:"source_refresh_failed",error:message});
      continue;
    }
  }
  const healthQ=await db.from("hidden_beyond_source_health")
    .select("source_id,status,resolved_channel_id,uploads_playlist_id,last_checked_at,last_success_at,failure_count,reason")
    .in("source_id",FIXED.map(x=>x.source_id)).order("source_id",{ascending:true});
  if(healthQ.error) throw new Error("source_health_snapshot_failed:"+healthQ.error.message);
  return {inserted_count:inserted.length,inserted,skipped,observed,health:healthQ.data||[]};
}

async function ensurePlaylist(db:any,token:string,series:any){
  if(series.youtube_playlist_id){
    const existingId=String(series.youtube_playlist_id);
    const check=await fetch(
      "https://www.googleapis.com/youtube/v3/playlists?part=id&id="+encodeURIComponent(existingId),
      {headers:{authorization:"Bearer "+token}}
    );
    const body=await check.json().catch(()=>({}));
    if(check.ok && Array.isArray(body?.items) && body.items.length>0) return existingId;
    if(!check.ok && check.status!==404)
      throw new Error("playlist_verify_failed:"+check.status+":"+JSON.stringify(body));
    const clear=await db.from("source_series").update({
      youtube_playlist_id:null,updated_at:new Date().toISOString()
    }).eq("id",series.id);
    if(clear.error) throw new Error("playlist_clear_stale_failed:"+clear.error.message);
  }
  const title=clip(series.playlist_title||series.series_title||"Hidden Beyond",150);
  const r=await fetch("https://www.googleapis.com/youtube/v3/playlists?part=snippet,status",{
    method:"POST",
    headers:{authorization:"Bearer "+token,"content-type":"application/json"},
    body:JSON.stringify({
      snippet:{title,description:"Danh sách phát theo từng bộ trên Hidden Beyond."},
      status:{privacyStatus:"public"}
    })
  });
  const b=await r.json().catch(()=>({}));
  if(!r.ok||!b?.id) throw new Error("playlist_create_failed:"+r.status+":"+JSON.stringify(b));
  const u=await db.from("source_series").update({
    youtube_playlist_id:b.id,updated_at:new Date().toISOString()
  }).eq("id",series.id);
  if(u.error) throw new Error("playlist_save_failed:"+u.error.message);
  return String(b.id);
}
async function verifyPublicYoutubeVideo(token:string,videoId:string,expectedChannelId:string){
  const url=new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part","snippet,status");
  url.searchParams.set("id",videoId);
  const r=await fetch(url,{headers:{authorization:"Bearer "+token}});
  const b=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error("youtube_verify_failed:"+r.status+":"+JSON.stringify(b));
  const item=Array.isArray(b?.items)?b.items[0]:null;
  if(!item) throw new Error("youtube_verify_video_missing:"+videoId);
  const privacy=String(item?.status?.privacyStatus||"");
  const uploadStatus=String(item?.status?.uploadStatus||"");
  const channelId=String(item?.snippet?.channelId||"");
  if(privacy!=="public")
    throw new Error("youtube_verify_not_public:"+privacy);
  if(expectedChannelId && channelId!==expectedChannelId)
    throw new Error("youtube_verify_wrong_channel:"+channelId);
  if(["failed","rejected","deleted"].includes(uploadStatus))
    throw new Error("youtube_verify_bad_upload_status:"+uploadStatus);
  return {privacy_status:privacy,upload_status:uploadStatus,channel_id:channelId};
}

async function addPlaylist(token:string,playlistId:string,videoId:string){
  const r=await fetch("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet",{
    method:"POST",
    headers:{authorization:"Bearer "+token,"content-type":"application/json"},
    body:JSON.stringify({snippet:{playlistId,resourceId:{kind:"youtube#video",videoId}}})
  });
  const text=await r.text();
  if(r.ok||text.includes("videoAlreadyInPlaylist")) return;
  throw new Error("playlist_insert_failed:"+r.status+":"+text.slice(0,1000));
}

async function peekNext(db:any,state:any){
  const start=Number(state.next_rotation||1);
  for(let offset=0;offset<5;offset++){
    const rotation=((start-1+offset)%5)+1;
    const fixed=FIXED.find(x=>x.rotation===rotation)!;
    const sq=await db.from("source_series")
      .select("id,source_id,series_title,playlist_title,last_ingested_episode,active,state")
      .eq("id",fixed.series_id).single();
    if(sq.error) throw new Error("series_lookup_failed:"+sq.error.message);
    if(!sq.data.active) continue;
    const last=Number(sq.data.last_ingested_episode||0);
    const iq=await db.from("source_items")
      .select("source_id,series_id,source_item_id,source_url,title,series_title,episode_number,rights_status,rights_basis,evidence_url")
      .eq("source_id",fixed.source_id).eq("series_id",fixed.series_id)
      .eq("active",true).eq("rights_status","approved")
      .gt("episode_number",last).order("episode_number",{ascending:true})
      .limit(1).maybeSingle();
    if(iq.error) throw new Error("source_item_lookup_failed:"+iq.error.message);
    if(iq.data) return {stage:"ready",rotation,series:sq.data,item:iq.data};
  }
  return {stage:"idle"};
}
async function peekExact(db:any,rotation:number,episode:number){
  const fixed=FIXED.find(x=>x.rotation===rotation);
  if(!fixed) return {stage:"target_invalid",reason:"rotation_out_of_range",rotation,episode};
  if(!Number.isInteger(episode)||episode<1)
    return {stage:"target_invalid",reason:"episode_out_of_range",rotation,episode};

  const sq=await db.from("source_series")
    .select("id,source_id,series_title,playlist_title,last_ingested_episode,active,state")
    .eq("id",fixed.series_id).single();
  if(sq.error) throw new Error("series_lookup_failed:"+sq.error.message);
  if(!sq.data.active)
    return {stage:"target_missing",reason:"series_inactive",rotation,episode};

  const iq=await db.from("source_items")
    .select("source_id,series_id,source_item_id,source_url,title,series_title,episode_number,rights_status,rights_basis,evidence_url")
    .eq("source_id",fixed.source_id).eq("series_id",fixed.series_id)
    .eq("active",true).eq("rights_status","approved")
    .eq("episode_number",episode).maybeSingle();
  if(iq.error) throw new Error("source_item_lookup_failed:"+iq.error.message);
  if(!iq.data){
    const hq=await db.from("hidden_beyond_source_health")
      .select("status,reason,last_checked_at,failure_count")
      .eq("source_id",fixed.source_id).maybeSingle();
    if(hq.error) throw new Error("source_health_lookup_failed:"+hq.error.message);
    if(hq.data && ["unavailable","degraded"].includes(String(hq.data.status||""))){
      return {
        stage:"target_unavailable",reason:String(hq.data.reason||"source_unavailable"),
        rotation,episode,series_id:fixed.series_id,source_id:fixed.source_id,
        source_health:hq.data,last_ingested_episode:Number(sq.data.last_ingested_episode||0)
      };
    }
    return {
      stage:"target_missing",reason:"approved_source_item_not_found",
      rotation,episode,series_id:fixed.series_id,source_id:fixed.source_id,
      last_ingested_episode:Number(sq.data.last_ingested_episode||0)
    };
  }

  const existing=await db.from("videos")
    .select("youtube_video_id,status,processing_status")
    .eq("source_id",fixed.source_id)
    .eq("source_video_id",String(iq.data.source_item_id))
    .maybeSingle();
  if(existing.error) throw new Error("existing_video_lookup_failed:"+existing.error.message);
  if(existing.data?.youtube_video_id && existing.data?.processing_status==="complete"){
    return {
      stage:"already_completed",rotation,episode,
      source_id:fixed.source_id,series_id:fixed.series_id,
      source_video_id:String(iq.data.source_item_id),
      youtube_video_id:String(existing.data.youtube_video_id)
    };
  }
  return {stage:"ready",rotation,series:sq.data,item:iq.data};
}

async function selectNext(db:any,state:any,request:any={}){
  const selectionMode=String(request?.selection_mode||"rotation")==="exact"?"exact":"rotation";
  const targetRotation=Number(request?.target_rotation||0);
  const targetEpisode=Number(request?.target_episode||0);
  if(selectionMode==="exact" && (
    !Number.isInteger(targetRotation)||targetRotation<1||targetRotation>5||
    !Number.isInteger(targetEpisode)||targetEpisode<1
  )){
    return {
      stage:"target_invalid",reason:"exact_target_requires_rotation_and_episode",
      rotation:targetRotation,episode:targetEpisode
    };
  }
  if(
    state.status==="failed" &&
    state.stage==="youtube_uploaded" &&
    state.current_source_video_id
  ){
    return {
      stage:"recover_upload",
      source_id:state.current_source_id,
      series_id:state.current_series_id,
      source_video_id:state.current_source_video_id
    };
  }
  if(
    state.status==="failed" &&
    state.current_source_video_id &&
    state.source_kernel_ref &&
    Number(state.source_bytes||0)>1_000_000
  ){
    const fixed=FIXED.find(
      x=>x.source_id===Number(state.current_source_id)&&x.series_id===Number(state.current_series_id)
    );
    if(fixed){
      const sq=await db.from("source_series")
        .select("id,source_id,series_title,playlist_title,last_ingested_episode,active,state")
        .eq("id",fixed.series_id).single();
      if(sq.error) throw new Error("series_lookup_failed:"+sq.error.message);
      const iq=await db.from("source_items")
        .select("source_id,series_id,source_item_id,source_url,title,series_title,episode_number,rights_status,rights_basis,evidence_url")
        .eq("source_id",fixed.source_id).eq("series_id",fixed.series_id)
        .eq("source_item_id",String(state.current_source_video_id)).single();
      if(iq.error) throw new Error("source_item_lookup_failed:"+iq.error.message);
      if(
        selectionMode==="exact" &&
        (
          fixed.rotation!==targetRotation ||
          Number(iq.data.episode_number||0)!==targetEpisode
        )
      ){
        return {
          stage:"target_conflict",reason:"failed_job_does_not_match_exact_target",
          requested_rotation:targetRotation,requested_episode:targetEpisode,
          active_rotation:fixed.rotation,active_episode:Number(iq.data.episode_number||0),
          source_video_id:String(state.current_source_video_id)
        };
      }
      const now=new Date().toISOString();
      const u=await db.from("hidden_beyond_bot2_state").update({
        status:"running",stage:"source_ready",completed_at:null,youtube_video_id:null,
        gpu_kernel_ref:null,last_message:"Resuming from previously verified Kaggle source",
        updated_at:now
      }).eq("id",1).select("*").single();
      if(u.error) throw new Error("state_resume_failed:"+u.error.message);
      return {
        stage:"resume_source_ready",rotation:fixed.rotation,series:sq.data,item:iq.data,
        source_kernel_ref:String(state.source_kernel_ref),
        source_bytes:Number(state.source_bytes||0)
      };
    }
  }
  if(state.status==="running"&&state.current_source_video_id){
    const age=(Date.now()-new Date(String(state.updated_at)).getTime())/1000;
    if(age<7200){
      return {stage:"job_active",job:{
        source_id:state.current_source_id,series_id:state.current_series_id,
        source_video_id:state.current_source_video_id,stage:state.stage
      }};
    }
    await db.from("hidden_beyond_bot2_state").update({
      status:"failed",stage:"stalled",last_message:"Previous Bot2 job stale after 2h",
      completed_at:new Date().toISOString(),updated_at:new Date().toISOString()
    }).eq("id",1);
  }
  const next=selectionMode==="exact"
    ? await peekExact(db,targetRotation,targetEpisode)
    : await peekNext(db,state);
  if(["target_invalid","target_missing","target_unavailable","already_completed","target_conflict"].includes(String(next.stage))){
    return next;
  }
  if(next.stage!=="ready"){
    const now=new Date().toISOString();
    await db.from("hidden_beyond_bot2_state").update({
      status:"idle",stage:"idle",started_at:null,completed_at:null,youtube_video_id:null,
      current_source_id:null,current_series_id:null,current_source_video_id:null,
      job_token_hash:null,job_expires_at:null,source_kernel_ref:null,source_bytes:null,gpu_kernel_ref:null,
      last_message:"No pending approved episode in fixed five-source pool",updated_at:now
    }).eq("id",1);
    return {stage:"idle"};
  }
  const now=new Date().toISOString();
  const u=await db.from("hidden_beyond_bot2_state").update({
    next_rotation:next.rotation,status:"running",stage:"selected",
    started_at:now,completed_at:null,youtube_video_id:null,
    current_source_id:next.item.source_id,current_series_id:next.item.series_id,
    current_source_video_id:next.item.source_item_id,
    source_kernel_ref:null,source_bytes:null,gpu_kernel_ref:null,
    last_message:(selectionMode==="exact"?"Selected exact target ":"Selected rotation target ")+
      next.rotation+" episode "+String(next.item.episode_number),
    updated_at:now
  }).eq("id",1).select("*").single();
  if(u.error) throw new Error("state_claim_failed:"+u.error.message);
  return {stage:"selected",rotation:next.rotation,series:next.series,item:next.item};
}
async function recoverRecentUpload(db:any,state:any){
  const videoId=String(state.current_source_video_id||"");
  const fixed=FIXED.find(x=>x.source_id===Number(state.current_source_id)&&x.series_id===Number(state.current_series_id));
  if(!videoId||!fixed) throw new Error("recover_job_context_missing");

  const iq=await db.from("source_items")
    .select("source_item_id,title,episode_number")
    .eq("series_id",fixed.series_id).eq("source_item_id",videoId).single();
  if(iq.error) throw new Error("recover_source_item_lookup_failed:"+iq.error.message);

  const sq=await db.from("source_series")
    .select("id,series_title,playlist_title")
    .eq("id",fixed.series_id).single();
  if(sq.error) throw new Error("recover_series_lookup_failed:"+sq.error.message);

  const yt=await youtubeAccess(db);
  const channelId=String(yt.connection.channel_id||"").trim();
  if(!channelId) throw new Error("recover_channel_id_missing");

  const ch=await fetch("https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id="+encodeURIComponent(channelId),{
    headers:{authorization:"Bearer "+yt.token}
  });
  const chBody=await ch.json().catch(()=>({}));
  if(!ch.ok) throw new Error("recover_channels_lookup_failed:"+ch.status+":"+JSON.stringify(chBody));
  const uploads=String(chBody?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads||"");
  if(!uploads) throw new Error("recover_uploads_playlist_missing");

  const ep=Number(iq.data.episode_number||1);
  const expectedTitle=clip("Tập "+ep+" | "+String(sq.data.playlist_title||sq.data.series_title||iq.data.title||"Hidden Beyond"),100);
  const pr=await fetch(
    "https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=15&playlistId="+encodeURIComponent(uploads),
    {headers:{authorization:"Bearer "+yt.token}}
  );
  const pb=await pr.json().catch(()=>({}));
  if(!pr.ok) throw new Error("recover_uploads_lookup_failed:"+pr.status+":"+JSON.stringify(pb));
  const started=new Date(String(state.started_at||state.updated_at||new Date().toISOString())).getTime()-15*60*1000;
  const candidates=(pb.items||[]).filter((x:any)=>{
    const title=String(x?.snippet?.title||"");
    const published=new Date(String(x?.contentDetails?.videoPublishedAt||x?.snippet?.publishedAt||0)).getTime();
    return title===expectedTitle && Number.isFinite(published) && published>=started;
  });
  if(candidates.length<1) throw new Error("recover_recent_upload_not_found:title="+expectedTitle);
  const found=candidates[0];
  const recoveredId=String(found?.contentDetails?.videoId||found?.snippet?.resourceId?.videoId||"").trim();
  if(!recoveredId) throw new Error("recover_video_id_missing");
  return {youtube_video_id:recoveredId,title:expectedTitle};
}

async function completeJob(db:any,state:any,youtubeVideoId:string){
  const videoId=String(state.current_source_video_id||"");
  const fixed=FIXED.find(x=>x.source_id===Number(state.current_source_id)&&x.series_id===Number(state.current_series_id));
  if(!fixed) throw new Error("fixed_source_mapping_missing");
  const ytId=String(youtubeVideoId||"").trim();
  if(!ytId) throw new Error("youtube_video_id_required");

  const item=await db.from("source_items")
    .select("source_url,title,rights_basis,episode_number")
    .eq("series_id",fixed.series_id).eq("source_item_id",videoId).single();
  if(item.error) throw new Error("source_item_lookup_failed:"+item.error.message);
  const episode=Number(item.data.episode_number||0);
  if(!episode) throw new Error("episode_number_missing");
  const seriesInfo=await db.from("source_series")
    .select("id,series_title,playlist_title,youtube_playlist_id,last_ingested_episode")
    .eq("id",fixed.series_id).single();
  if(seriesInfo.error) throw new Error("series_lookup_failed:"+seriesInfo.error.message);

  const yt=await youtubeAccess(db);
  await verifyPublicYoutubeVideo(
    yt.token,ytId,String(yt.connection.channel_id||"")
  );
  const playlistId=await ensurePlaylist(db,yt.token,seriesInfo.data);
  await addPlaylist(yt.token,playlistId,ytId);

  const videoSave=await db.from("videos").upsert({
    source_id:fixed.source_id,source_video_id:videoId,source_url:item.data.source_url,
    title:item.data.title,translated_title:seriesInfo.data.playlist_title||seriesInfo.data.series_title,
    status:"uploaded",youtube_video_id:ytId,uploaded_at:new Date().toISOString(),
    rights_verified:true,rights_basis:item.data.rights_basis,original_audio_verified:true,
    processing_status:"complete",processing_error:null,processed_at:new Date().toISOString(),
    series_id:fixed.series_id,episode_number:episode,youtube_playlist_id:playlistId
  },{onConflict:"source_id,source_video_id"});
  if(videoSave.error) throw new Error("video_success_save_failed:"+videoSave.error.message);

  const last=Math.max(Number(seriesInfo.data.last_ingested_episode||0),episode);
  const su=await db.from("source_series").update({
    last_ingested_episode:last,updated_at:new Date().toISOString()
  }).eq("id",fixed.series_id);
  if(su.error) throw new Error("series_progress_update_failed:"+su.error.message);

  const nextRotation=(fixed.rotation%5)+1;
  const u=await db.from("hidden_beyond_bot2_state").update({
    next_rotation:nextRotation,status:"idle",stage:"completed",
    current_source_id:null,current_series_id:null,current_source_video_id:null,
    youtube_video_id:ytId,completed_at:new Date().toISOString(),
    job_token_hash:null,job_expires_at:null,source_kernel_ref:null,source_bytes:null,gpu_kernel_ref:null,
    last_message:"Completed rotation "+fixed.rotation+" episode "+episode,
    updated_at:new Date().toISOString()
  }).eq("id",1).select("*").single();
  if(u.error) throw new Error("state_success_failed:"+u.error.message);

  const cleanup=await db.from("hidden_beyond_bot2_checkpoints")
    .delete().eq("source_video_id",videoId);
  if(cleanup.error){
    await db.from("hidden_beyond_bot2_state").update({
      last_message:"Completed rotation "+fixed.rotation+" episode "+episode+
        "; checkpoint cleanup pending: "+clip(cleanup.error.message,500),
      updated_at:new Date().toISOString()
    }).eq("id",1);
    return {
      next_rotation:nextRotation,state:u.data,episode_number:episode,
      checkpoint_cleanup_pending:true
    };
  }
  return {
    next_rotation:nextRotation,state:u.data,episode_number:episode,
    checkpoint_cleanup_pending:false
  };
}

Deno.serve(async(req:Request)=>{
  try{
    if(req.method!=="POST") return Response.json({ok:false,error:"method_not_allowed"},{status:405});
    const db=createClient(Deno.env.get("SUPABASE_URL")!,adminKey(),{auth:{persistSession:false,autoRefreshToken:false}});
    const path=new URL(req.url).pathname;
    let body:any={}; try{body=await req.json();}catch{}

    if(path.endsWith("/translation-checkpoint-get")){
      const state=await authorizeWorker(req,db,body);
      const workerRevision=clip(body.worker_revision||"",80);
      if(!workerRevision) return Response.json({ok:false,error:"worker_revision_required"},{status:400});
      const q=await db.from("hidden_beyond_bot2_checkpoints")
        .select("source_video_id,worker_revision,phase,cursor,payload,updated_at")
        .eq("source_video_id",String(state.current_source_video_id)).maybeSingle();
      if(q.error) throw new Error("checkpoint_lookup_failed:"+q.error.message);
      if(!q.data) return Response.json({ok:true,found:false});
      if(String(q.data.worker_revision)!==workerRevision)
        return Response.json({ok:true,found:false,reason:"worker_revision_mismatch"});
      return Response.json({
        ok:true,found:true,phase:q.data.phase,cursor:Number(q.data.cursor||0),
        payload:q.data.payload||{},updated_at:q.data.updated_at
      });
    }
    if(path.endsWith("/translation-checkpoint-save")){
      const state=await authorizeWorker(req,db,body);
      const workerRevision=clip(body.worker_revision||"",80);
      const phase=clip(body.phase||"",80);
      const cursor=Math.max(0,Number(body.cursor||0));
      const payload=(body.payload&&typeof body.payload==="object")?body.payload:{};
      if(!workerRevision) return Response.json({ok:false,error:"worker_revision_required"},{status:400});
      if(!["asr_complete","translating","translation_complete"].includes(phase))
        return Response.json({ok:false,error:"invalid_checkpoint_phase"},{status:400});
      const existing=await db.from("hidden_beyond_bot2_checkpoints")
        .select("worker_revision,phase,cursor,payload")
        .eq("source_video_id",String(state.current_source_video_id)).maybeSingle();
      if(existing.error) throw new Error("checkpoint_guard_lookup_failed:"+existing.error.message);

      let finalPhase=phase;
      let finalCursor=cursor;
      let finalPayload={...payload};
      if(existing.data && String(existing.data.worker_revision)===workerRevision){
        const oldPayload=(existing.data.payload&&typeof existing.data.payload==="object")
          ?existing.data.payload:{};
        finalPayload={...oldPayload,...payload};

        // An ASR-only enrichment must never erase completed translations.
        if(
          oldPayload.translated &&
          typeof oldPayload.translated==="object" &&
          Object.keys(oldPayload.translated).length>0 &&
          (
            !payload.translated ||
            typeof payload.translated!=="object" ||
            Object.keys(payload.translated).length===0
          )
        ){
          finalPayload.translated=oldPayload.translated;
        }
        if(
          Array.isArray(oldPayload.review_ids) &&
          (!Array.isArray(payload.review_ids)||payload.review_ids.length===0)
        ) finalPayload.review_ids=oldPayload.review_ids;
        if(
          oldPayload.hard_reasons &&
          typeof oldPayload.hard_reasons==="object" &&
          (
            !payload.hard_reasons ||
            typeof payload.hard_reasons!=="object" ||
            Object.keys(payload.hard_reasons).length===0
          )
        ) finalPayload.hard_reasons=oldPayload.hard_reasons;

        const oldRank=checkpointRank(existing.data.phase);
        const newRank=checkpointRank(phase);
        if(oldRank>newRank){
          finalPhase=String(existing.data.phase);
          finalCursor=Number(existing.data.cursor||0);
        }else if(oldRank===newRank){
          finalCursor=Math.max(Number(existing.data.cursor||0),cursor);
        }
      }
      const payloadBytes=new TextEncoder().encode(JSON.stringify(finalPayload)).byteLength;
      if(payloadBytes>2_000_000)
        return Response.json({ok:false,error:"checkpoint_payload_too_large"},{status:413});
      const u=await db.from("hidden_beyond_bot2_checkpoints").upsert({
        source_video_id:String(state.current_source_video_id),
        worker_revision:workerRevision,phase:finalPhase,cursor:finalCursor,
        payload:finalPayload,updated_at:new Date().toISOString()
      },{onConflict:"source_video_id"}).select("source_video_id,phase,cursor,updated_at").single();
      if(u.error) throw new Error("checkpoint_save_failed:"+u.error.message);
      return Response.json({ok:true,saved:true,...u.data});
    }

    if(path.endsWith("/worker-stage")){
      const state=await authorizeWorker(req,db,body);
      const stage=clip(body.stage||"",80);
      if(!WORKER_STAGES.has(stage)) return Response.json({ok:false,error:"invalid_worker_stage"},{status:400});
      const patch:any={
        status:"running",stage,last_message:clip(body.message||stage,1500),updated_at:new Date().toISOString()
      };
      if(body.source_kernel_ref) patch.source_kernel_ref=clip(body.source_kernel_ref,200);
      if(Number(body.source_bytes||0)>0) patch.source_bytes=Number(body.source_bytes);
      if(body.gpu_kernel_ref) patch.gpu_kernel_ref=clip(body.gpu_kernel_ref,200);
      if(body.youtube_video_id) patch.youtube_video_id=clip(body.youtube_video_id,100);
      const u=await db.from("hidden_beyond_bot2_state").update(patch).eq("id",1).select("*").single();
      if(u.error) throw new Error("worker_stage_update_failed:"+u.error.message);
      return Response.json({ok:true,stage:"updated",state:u.data});
    }
    if(path.endsWith("/worker-fail")){
      await authorizeWorker(req,db,body);
      const now=new Date().toISOString();
      const u=await db.from("hidden_beyond_bot2_state").update({
        status:"failed",stage:clip(body.stage||"failed",80),
        last_message:clip(body.error||body.message||"Bot2 worker failed",1500),
        completed_at:now,updated_at:now
      }).eq("id",1).select("*").single();
      if(u.error) throw new Error("worker_fail_update_failed:"+u.error.message);
      return Response.json({ok:true,stage:"failed",state:u.data});
    }
    if(path.endsWith("/worker-complete")){
      const state=await authorizeWorker(req,db,body);
      const result=await completeJob(db,state,String(body.youtube_video_id||""));
      return Response.json({ok:true,stage:"completed",...result});
    }

    await authorizeGitHub(req);

    if(path.endsWith("/refresh-fixed-sources")){
      const result=await refreshFixedSources(db);
      return Response.json({ok:true,stage:"sources_refreshed",...result});
    }

    if(path.endsWith("/gpu-released")){
      const state=await loadState(db);
      const videoId=String(body.source_video_id||"").trim();
      if(!videoId||videoId!==String(state.current_source_video_id||""))
        return Response.json({ok:false,error:"job_mismatch"},{status:409});
      const u=await db.from("hidden_beyond_bot2_state").update({
        gpu_kernel_ref:null,
        updated_at:new Date().toISOString()
      }).eq("id",1).select("status,stage,current_source_video_id,gpu_kernel_ref,updated_at").single();
      if(u.error) throw new Error("gpu_release_state_failed:"+u.error.message);
      return Response.json({ok:true,stage:"gpu_released",state:u.data});
    }

    if(path.endsWith("/recover-upload")){
      const state=await loadState(db);
      if(state.status!=="failed"||state.stage!=="youtube_uploaded"||!state.current_source_video_id)
        return Response.json({ok:false,error:"recover_not_applicable"},{status:409});
      try{
        const recovered=await recoverRecentUpload(db,state);
        await db.from("hidden_beyond_bot2_state").update({
          status:"running",stage:"youtube_uploaded",
          youtube_video_id:recovered.youtube_video_id,
          last_message:"Recovered already-uploaded YouTube video id="+recovered.youtube_video_id,
          completed_at:null,updated_at:new Date().toISOString()
        }).eq("id",1);
        const result=await completeJob(db,{...state,status:"running"},recovered.youtube_video_id);
        return Response.json({ok:true,stage:"completed",recovered:true,...recovered,...result});
      }catch(err){
        const message=err instanceof Error?err.message:String(err);
        await db.from("hidden_beyond_bot2_state").update({
          status:"failed",stage:"youtube_uploaded",
          last_message:clip("Recovery completion failed: "+message,1500),
          completed_at:new Date().toISOString(),updated_at:new Date().toISOString()
        }).eq("id",1);
        return Response.json({ok:false,error:message},{status:500});
      }
    }

    if(path.endsWith("/config-fail")){
      const now=new Date().toISOString();
      const message=clip(body.error||body.message||"Bot2 configuration blocked",1500);
      const u=await db.from("hidden_beyond_bot2_state").update({
        status:"idle",stage:"config_blocked",
        current_source_id:null,current_series_id:null,current_source_video_id:null,
        source_kernel_ref:null,source_bytes:null,gpu_kernel_ref:null,
        job_token_hash:null,job_expires_at:null,
        started_at:null,completed_at:now,
        last_message:message,updated_at:now
      }).eq("id",1).select("*").single();
      if(u.error) throw new Error("config_fail_update_failed:"+u.error.message);
      return Response.json({ok:true,stage:"config_blocked",state:u.data});
    }

    if(path.endsWith("/status")) return Response.json({ok:true,state:await loadState(db)});
    if(path.endsWith("/peek")){
      const state=await loadState(db);
      return Response.json({ok:true,...await peekNext(db,state)});
    }
    if(path.endsWith("/next")){
      const state=await loadState(db);
      const result:any=await selectNext(db,state,body||{});
      if(!["selected","resume_source_ready"].includes(String(result.stage)))
        return Response.json({ok:true,selection_mode:String(body?.selection_mode||"rotation"),...result});
      const token=randomToken();
      const expires=new Date(Date.now()+4*3600*1000).toISOString();
      const u=await db.from("hidden_beyond_bot2_state").update({
        job_token_hash:await sha256Hex(token),job_expires_at:expires,updated_at:new Date().toISOString()
      }).eq("id",1);
      if(u.error) throw new Error("worker_token_save_failed:"+u.error.message);
      const checkpoint=await checkpointSummary(
        db,
        String(result?.item?.source_item_id||result?.source_video_id||"")
      );
      return Response.json({
        ok:true,selection_mode:String(body?.selection_mode||"rotation"),...result,...checkpoint,job_token:token,job_expires_at:expires,
        callback_base:Deno.env.get("SUPABASE_URL")+"/functions/v1/hidden-beyond-bot2"
      });
    }
    if(path.endsWith("/stage")){
      const state=await loadState(db);
      const videoId=String(body.source_video_id||"");
      if(!videoId||videoId!==String(state.current_source_video_id||""))
        return Response.json({ok:false,error:"job_mismatch"},{status:409});
      const stage=clip(body.stage||"",80);
      if(!stage) return Response.json({ok:false,error:"stage_required"},{status:400});
      const u=await db.from("hidden_beyond_bot2_state").update({
        status:"running",stage,last_message:clip(body.message||stage,1500),updated_at:new Date().toISOString()
      }).eq("id",1).select("*").single();
      if(u.error) throw new Error("state_stage_update_failed:"+u.error.message);
      return Response.json({ok:true,stage:"updated",state:u.data});
    }
    if(path.endsWith("/youtube-session")){
      const state=await loadState(db);
      const videoId=String(body.source_video_id||"").trim();
      if(state.status!=="running"||!videoId||videoId!==String(state.current_source_video_id||""))
        return Response.json({ok:false,error:"job_mismatch"},{status:409});
      const iq=await db.from("source_items")
        .select("source_id,series_id,source_item_id,source_url,title,series_title,episode_number,rights_status,rights_basis")
        .eq("source_item_id",videoId).eq("series_id",state.current_series_id).single();
      if(iq.error) throw new Error("source_item_lookup_failed:"+iq.error.message);
      if(iq.data.rights_status!=="approved") throw new Error("source_item_not_approved");
      const sq=await db.from("source_series")
        .select("id,source_id,series_title,playlist_title,youtube_playlist_id")
        .eq("id",state.current_series_id).single();
      if(sq.error) throw new Error("series_lookup_failed:"+sq.error.message);
      const src=await db.from("sources").select("name").eq("id",state.current_source_id).single();
      if(src.error) throw new Error("source_lookup_failed:"+src.error.message);

      const yt=await youtubeAccess(db);
      const playlistId=await ensurePlaylist(db,yt.token,sq.data);
      const ep=Number(iq.data.episode_number||1);
      const title=clip("Tập "+ep+" | "+String(sq.data.playlist_title||sq.data.series_title||iq.data.title||"Hidden Beyond"),100);
      const description=clip([
        "Bộ: "+String(sq.data.playlist_title||sq.data.series_title||""),"Tập: "+ep,"",
        "Bản lồng tiếng Việt do Hidden Beyond thực hiện.",
        "Nguồn / Source: "+String(src.data.name||""),
        "Video gốc / Original: "+String(iq.data.source_url||"")
      ].join("\n"),5000);
      const init=new URL("https://www.googleapis.com/upload/youtube/v3/videos");
      init.searchParams.set("uploadType","resumable");
      init.searchParams.set("part","snippet,status");
      init.searchParams.set("notifySubscribers","false");
      const ir=await fetch(init,{
        method:"POST",
        headers:{authorization:"Bearer "+yt.token,"content-type":"application/json; charset=UTF-8","x-upload-content-type":"video/mp4"},
        body:JSON.stringify({snippet:{title,description,categoryId:"1"},status:{privacyStatus:"public",selfDeclaredMadeForKids:false}})
      });
      if(!ir.ok) throw new Error("youtube_resumable_init_failed:"+ir.status+":"+await ir.text());
      const uploadUrl=ir.headers.get("location");
      if(!uploadUrl) throw new Error("youtube_upload_url_missing");
      await db.from("hidden_beyond_bot2_state").update({
        stage:"youtube_upload_ready",last_message:"YouTube resumable upload session ready",updated_at:new Date().toISOString()
      }).eq("id",1);
      return Response.json({
        ok:true,stage:"youtube_upload_ready",upload_url:uploadUrl,playlist_id:playlistId,
        title,episode_number:ep,channel_id:yt.connection.channel_id,channel_title:yt.connection.channel_title
      });
    }
    if(path.endsWith("/fail")){
      const state=await loadState(db);
      const videoId=String(body.source_video_id||"");
      if(!videoId||videoId!==String(state.current_source_video_id||""))
        return Response.json({ok:false,error:"job_mismatch"},{status:409});
      const now=new Date().toISOString();
      const u=await db.from("hidden_beyond_bot2_state").update({
        status:"failed",stage:clip(body.stage||"failed",80),
        last_message:clip(body.error||body.message||"Bot2 job failed",1500),
        completed_at:now,updated_at:now
      }).eq("id",1).select("*").single();
      if(u.error) throw new Error("state_fail_failed:"+u.error.message);
      return Response.json({ok:true,stage:"failed",state:u.data});
    }
    if(path.endsWith("/success")){
      const state=await loadState(db);
      const videoId=String(body.source_video_id||"");
      if(!videoId||videoId!==String(state.current_source_video_id||""))
        return Response.json({ok:false,error:"job_mismatch"},{status:409});
      const result=await completeJob(db,state,String(body.youtube_video_id||""));
      return Response.json({ok:true,stage:"completed",...result});
    }
    return Response.json({ok:false,error:"unknown_route"},{status:404});
  }catch(e){
    const message=e instanceof Error?e.message:String(e);
    const authError=/^(missing_bearer|wrong_repository|wrong_ref|wrong_event|wrong_workflow|missing_worker_token|worker_token_not_issued|worker_token_expired|invalid_worker_token|worker_job_mismatch|job_not_running)$/.test(message);
    return Response.json({ok:false,error:message},{status:authError?401:500});
  }
});