import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

function adminKey():string{
  const modern=Deno.env.get("SUPABASE_SECRET_KEYS");
  if(modern){const p=JSON.parse(modern); if(p.default)return p.default;}
  const legacy=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!legacy)throw new Error("no_admin_key");
  return legacy;
}
async function sha256Hex(v:string):Promise<string>{
  const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));
  return Array.from(new Uint8Array(d)).map(x=>x.toString(16).padStart(2,"0")).join("");
}
function safeEqual(a:string,b:string):boolean{
  if(a.length!==b.length)return false;
  let x=0; for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);
  return x===0;
}
function clip(v:any,n:number):string{
  const s=String(v??"").trim(); return s.length<=n?s:s.slice(0,n);
}
async function loadJob(db:any,req:Request,body:any){
  const id=String(body.job_id||"");
  const token=req.headers.get("x-job-token")||"";
  if(!id||!token)throw new Error("job_auth_required");
  const q=await db.from("longform_jobs").select("id,series_id,source_video_id,token_hash,expires_at,state").eq("id",id).single();
  if(q.error)throw new Error("job_lookup_failed:"+q.error.message);
  const hash=await sha256Hex(token);
  if(!safeEqual(hash,String(q.data.token_hash)))throw new Error("invalid_job_token");
  if(new Date(String(q.data.expires_at)).getTime()<Date.now())throw new Error("job_token_expired");
  return q.data;
}
function defaultProfile(seriesId:number){
  return {
    series_id:seriesId,profile_version:1,profile_key:"universal",genre:"auto",
    register:"natural cinematic Vietnamese",
    pronoun_policy:"infer_from_relationship_and_context",
    glossary:{},style_rules:[],character_memory:{},detected_from:null
  };
}
Deno.serve(async(req:Request)=>{
  try{
    if(req.method!=="POST")return Response.json({ok:false,error:"method_not_allowed"},{status:405});
    const db=createClient(Deno.env.get("SUPABASE_URL")!,adminKey(),{auth:{persistSession:false,autoRefreshToken:false}});
    const path=new URL(req.url).pathname;
    const body=await req.json().catch(()=>({}));
    const job=await loadJob(db,req,body);

    if(path.endsWith("/profile")){
      const q=await db.from("series_translation_profiles").select("*").eq("series_id",job.series_id).maybeSingle();
      if(q.error)throw new Error("profile_lookup_failed:"+q.error.message);
      return Response.json({ok:true,profile:q.data||defaultProfile(Number(job.series_id))});
    }

    if(path.endsWith("/profile/update")){
      const p=(body.profile&&typeof body.profile==="object")?body.profile:{};
      const row={
        series_id:job.series_id,
        profile_version:Math.max(1,Number(p.profile_version||1)),
        profile_key:clip(p.profile_key||"universal",80),
        genre:clip(p.genre||"general",80),
        register:clip(p.register||"natural cinematic Vietnamese",160),
        pronoun_policy:clip(p.pronoun_policy||"infer_from_relationship_and_context",200),
        glossary:(p.glossary&&typeof p.glossary==="object"&&!Array.isArray(p.glossary))?p.glossary:{},
        style_rules:Array.isArray(p.style_rules)?p.style_rules.slice(0,50):[],
        character_memory:(p.character_memory&&typeof p.character_memory==="object"&&!Array.isArray(p.character_memory))?p.character_memory:{},
        detected_from:clip(p.detected_from||"longform_source",120),
        updated_at:new Date().toISOString()
      };
      const u=await db.from("series_translation_profiles").upsert(row,{onConflict:"series_id"}).select("*").single();
      if(u.error)throw new Error("profile_store_failed:"+u.error.message);
      return Response.json({ok:true,profile:u.data});
    }

    if(path.endsWith("/memory/load")){
      const hashes=Array.isArray(body.source_hashes)?body.source_hashes.map((x:any)=>String(x||"").trim()).filter(Boolean):[];
      if(hashes.length>200)throw new Error("memory_batch_too_large");
      if(!hashes.length)return Response.json({ok:true,entries:[]});
      const modelKey=clip(body.model_key||"hy-mt2-7b-longform-v1",120);
      const profileVersion=Math.max(1,Number(body.profile_version||1));
      const q=await db.from("series_translation_memory")
        .select("source_hash,source_text,translation,qa_state,use_count,first_source_video_id,last_source_video_id,updated_at")
        .eq("series_id",job.series_id).eq("profile_version",profileVersion).eq("model_key",modelKey)
        .in("source_hash",hashes);
      if(q.error)throw new Error("memory_lookup_failed:"+q.error.message);
      return Response.json({ok:true,entries:q.data||[]});
    }

    if(path.endsWith("/memory/store")){
      const entries=Array.isArray(body.entries)?body.entries:[];
      if(entries.length>200)throw new Error("memory_batch_too_large");
      if(!entries.length)return Response.json({ok:true,stored:0});
      const modelKey=clip(body.model_key||"hy-mt2-7b-longform-v1",120);
      const profileVersion=Math.max(1,Number(body.profile_version||1));
      const now=new Date().toISOString();
      const rows=entries.map((x:any)=>{
        const sourceHash=String(x.source_hash||"").trim();
        const sourceText=String(x.source_text||"").trim();
        const translation=String(x.translation||"").trim();
        if(!sourceHash||!sourceText||!translation)throw new Error("invalid_memory_entry");
        return {
          series_id:job.series_id,source_hash:sourceHash,source_text:sourceText,translation,
          profile_version:profileVersion,model_key:modelKey,
          qa_state:["passed","reviewed","repaired"].includes(String(x.qa_state||""))?String(x.qa_state):"passed",
          first_source_video_id:String(x.first_source_video_id||job.source_video_id),
          last_source_video_id:String(job.source_video_id),
          updated_at:now
        };
      });
      const u=await db.from("series_translation_memory").upsert(rows,{
        onConflict:"series_id,source_hash,profile_version,model_key"
      });
      if(u.error)throw new Error("memory_store_failed:"+u.error.message);
      return Response.json({ok:true,stored:rows.length});
    }

    if(path.endsWith("/benchmark-complete")){
      const now=new Date().toISOString();
      const u=await db.from("longform_jobs").update({
        state:"completed",stage:"benchmark_complete",
        message:"Long-form benchmark completed without YouTube upload",
        heartbeat_at:now,completed_at:now,supervisor_state:"completed",recovery_updated_at:now
      }).eq("id",job.id).select("id,state,stage,message,completed_at").single();
      if(u.error)throw new Error("benchmark_complete_failed:"+u.error.message);
      return Response.json({ok:true,job:u.data});
    }

    if(path.endsWith("/load")){
      const keys=Array.isArray(body.segment_keys)?body.segment_keys.map((x:any)=>String(x||"").trim()).filter(Boolean):[];
      if(keys.length>200)throw new Error("cache_batch_too_large");
      if(!keys.length)return Response.json({ok:true,entries:[]});
      const modelKey=clip(body.model_key||"hy-mt2-7b-longform-v1",120);
      const profileVersion=Math.max(1,Number(body.profile_version||1));
      const q=await db.from("longform_segment_cache")
        .select("segment_key,segment_index,start_ms,end_ms,source_text,source_context_hash,translation,qa_state,translation_hash,profile_version,model_key,updated_at")
        .eq("series_id",job.series_id).eq("source_video_id",job.source_video_id)
        .eq("profile_version",profileVersion).eq("model_key",modelKey).in("segment_key",keys);
      if(q.error)throw new Error("cache_lookup_failed:"+q.error.message);
      return Response.json({ok:true,entries:q.data||[]});
    }

    if(path.endsWith("/store")){
      const entries=Array.isArray(body.entries)?body.entries:[];
      if(entries.length>200)throw new Error("cache_batch_too_large");
      if(!entries.length)return Response.json({ok:true,stored:0});
      const modelKey=clip(body.model_key||"hy-mt2-7b-longform-v1",120);
      const profileVersion=Math.max(1,Number(body.profile_version||1));
      const now=new Date().toISOString();
      const rows=entries.map((x:any)=>{
        const startMs=Math.max(0,Number(x.start_ms||0));
        const endMs=Math.max(startMs,Number(x.end_ms||startMs));
        const row={
          series_id:job.series_id,source_video_id:job.source_video_id,
          segment_key:String(x.segment_key||"").trim(),segment_index:Number(x.segment_index||0),
          start_ms:startMs,end_ms:endMs,source_text:String(x.source_text||"").trim(),
          source_context_hash:String(x.source_context_hash||"").trim(),
          profile_version:profileVersion,model_key:modelKey,translation:String(x.translation||"").trim(),
          qa_state:["passed","reviewed","repaired"].includes(String(x.qa_state||""))?String(x.qa_state):"passed",
          translation_hash:String(x.translation_hash||"").trim()||null,updated_at:now
        };
        if(!row.segment_key||!row.segment_index||!row.source_text||!row.source_context_hash||!row.translation)
          throw new Error("invalid_cache_entry");
        return row;
      });
      const u=await db.from("longform_segment_cache").upsert(rows,{onConflict:"series_id,source_video_id,segment_key,profile_version,model_key"});
      if(u.error)throw new Error("cache_store_failed:"+u.error.message);
      return Response.json({ok:true,stored:rows.length});
    }

    return Response.json({ok:false,error:"unknown_route"},{status:404});
  }catch(e){
    return Response.json({ok:false,error:e instanceof Error?e.message:String(e)},{status:500});
  }
});