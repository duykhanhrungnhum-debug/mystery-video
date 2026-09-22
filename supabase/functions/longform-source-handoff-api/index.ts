import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";

const REPO="duykhanhrungnhum-debug/AI-";
const AUD="hidden-beyond-source-handoff";
const JWKS=createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));

function adminKey():string{
  const modern=Deno.env.get("SUPABASE_SECRET_KEYS");
  if(modern){const p=JSON.parse(modern); if(p.default)return p.default;}
  const legacy=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!legacy)throw new Error("no_admin_key");
  return legacy;
}
function token():string{
  const b=crypto.getRandomValues(new Uint8Array(32));
  let s=""; for(const x of b)s+=String.fromCharCode(x);
  return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}
async function sha(v:string):Promise<string>{
  const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));
  return Array.from(new Uint8Array(d)).map(x=>x.toString(16).padStart(2,"0")).join("");
}
function equal(a:string,b:string):boolean{
  if(a.length!==b.length)return false; let x=0;
  for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);
  return x===0;
}
async function authGitHub(req:Request){
  const h=req.headers.get("authorization")||"";
  if(!h.startsWith("Bearer "))throw new Error("missing_bearer");
  const {payload}=await jwtVerify(h.slice(7),JWKS,{issuer:"https://token.actions.githubusercontent.com",audience:AUD});
  if(payload.repository!==REPO)throw new Error("wrong_repository");
  if(payload.ref!=="refs/heads/main")throw new Error("wrong_ref");
}
async function load(db:any,id:string,tok:string){
  const q=await db.from("longform_source_handoffs").select("*").eq("id",id).single();
  if(q.error)throw new Error("handoff_lookup_failed:"+q.error.message);
  if(!equal(await sha(tok),String(q.data.token_hash)))throw new Error("invalid_handoff_token");
  if(new Date(String(q.data.expires_at)).getTime()<Date.now())throw new Error("handoff_token_expired");
  return q.data;
}
Deno.serve(async(req:Request)=>{
  try{
    if(req.method!=="POST")return Response.json({ok:false,error:"method_not_allowed"},{status:405});
    const db=createClient(Deno.env.get("SUPABASE_URL")!,adminKey(),{auth:{persistSession:false,autoRefreshToken:false}});
    const path=new URL(req.url).pathname;
    const body=await req.json().catch(()=>({}));

    if(path.endsWith("/prepare")){
      await authGitHub(req);
      const sourceVideoId=String(body.source_video_id||"").trim();
      if(!sourceVideoId)throw new Error("source_video_id_required");
      const id=crypto.randomUUID();
      const t=token();
      const now=new Date();
      const exp=new Date(now.getTime()+2*3600*1000);
      const storagePath="source-handoff/"+id;
      const ins=await db.from("longform_source_handoffs").insert({
        id,source_video_id:sourceVideoId,token_hash:await sha(t),state:"created",
        message:"waiting_for_kaggle_source",storage_path:storagePath,
        heartbeat_at:now.toISOString(),expires_at:exp.toISOString()
      });
      if(ins.error)throw new Error("handoff_insert_failed:"+ins.error.message);
      return Response.json({ok:true,handoff_id:id,handoff_token:t});
    }

    if(path.endsWith("/heartbeat")){
      const id=String(body.handoff_id||""), t=req.headers.get("x-handoff-token")||"";
      await load(db,id,t);
      const now=new Date().toISOString();
      const u=await db.from("longform_source_handoffs").update({
        state:"running",message:String(body.message||"running").slice(0,500),heartbeat_at:now
      }).eq("id",id);
      if(u.error)throw new Error("handoff_heartbeat_failed:"+u.error.message);
      return Response.json({ok:true});
    }

    if(path.endsWith("/prepare-parts")){
      const id=String(body.handoff_id||""), t=req.headers.get("x-handoff-token")||"";
      const h=await load(db,id,t);
      const partCount=Number(body.part_count||0);
      const totalSize=Number(body.total_size||0);
      const chunkSize=Number(body.chunk_size||0);
      if(!Number.isInteger(partCount)||partCount<1||partCount>200)throw new Error("invalid_part_count");
      if(!Number.isFinite(totalSize)||totalSize<1)throw new Error("invalid_total_size");
      if(!Number.isFinite(chunkSize)||chunkSize<1||chunkSize>40*1024*1024)throw new Error("invalid_chunk_size");
      const uploads=[];
      for(let i=0;i<partCount;i++){
        const name="part-"+String(i).padStart(5,"0")+".bin";
        const objectPath=String(h.storage_path)+"/"+name;
        const up=await db.storage.from("video-ingest").createSignedUploadUrl(objectPath,{upsert:true});
        if(up.error||!up.data?.signedUrl)throw new Error("part_upload_signing_failed:"+i+":"+(up.error?.message||"missing_url"));
        uploads.push({index:i,name,upload_url:up.data.signedUrl});
      }
      const metadata={
        ...(h.metadata&&typeof h.metadata==="object"?h.metadata:{}),
        part_count:partCount,total_size:totalSize,chunk_size:chunkSize
      };
      const now=new Date().toISOString();
      const u=await db.from("longform_source_handoffs").update({
        state:"running",message:"uploading_source_parts",metadata,heartbeat_at:now
      }).eq("id",id);
      if(u.error)throw new Error("prepare_parts_update_failed:"+u.error.message);
      return Response.json({ok:true,parts:uploads});
    }

    if(path.endsWith("/complete")){
      const id=String(body.handoff_id||""), t=req.headers.get("x-handoff-token")||"";
      const h=await load(db,id,t);
      const expected=Number(h.metadata?.part_count||0);
      if(!expected)throw new Error("handoff_parts_not_prepared");
      const list=await db.storage.from("video-ingest").list(String(h.storage_path),{limit:250});
      if(list.error)throw new Error("handoff_storage_check_failed:"+list.error.message);
      const names=new Set((list.data||[]).map((x:any)=>String(x.name)));
      for(let i=0;i<expected;i++){
        const name="part-"+String(i).padStart(5,"0")+".bin";
        if(!names.has(name))throw new Error("handoff_part_missing:"+name);
      }
      const now=new Date().toISOString();
      const metadata={...(h.metadata||{}),...(body.metadata||{})};
      const u=await db.from("longform_source_handoffs").update({
        state:"completed",message:"source_ready",metadata,
        heartbeat_at:now,completed_at:now
      }).eq("id",id);
      if(u.error)throw new Error("handoff_complete_failed:"+u.error.message);
      return Response.json({ok:true,state:"completed"});
    }

    if(path.endsWith("/fail")){
      const id=String(body.handoff_id||""), t=req.headers.get("x-handoff-token")||"";
      await load(db,id,t);
      const now=new Date().toISOString();
      const u=await db.from("longform_source_handoffs").update({
        state:"failed",message:String(body.error||"source_worker_failed").slice(0,1000),
        heartbeat_at:now,failed_at:now
      }).eq("id",id);
      if(u.error)throw new Error("handoff_fail_failed:"+u.error.message);
      return Response.json({ok:true,state:"failed"});
    }

    if(path.endsWith("/status")){
      await authGitHub(req);
      const id=String(body.handoff_id||"");
      const q=await db.from("longform_source_handoffs")
        .select("id,source_video_id,state,message,metadata,heartbeat_at,created_at,completed_at,failed_at")
        .eq("id",id).single();
      if(q.error)throw new Error("handoff_status_failed:"+q.error.message);
      return Response.json({ok:true,handoff:q.data});
    }

    if(path.endsWith("/download")){
      await authGitHub(req);
      const id=String(body.handoff_id||"");
      const q=await db.from("longform_source_handoffs").select("state,storage_path,metadata").eq("id",id).single();
      if(q.error)throw new Error("handoff_download_lookup_failed:"+q.error.message);
      if(String(q.data.state)!=="completed")return Response.json({ok:false,error:"handoff_not_completed",state:q.data.state},{status:409});
      const count=Number(q.data.metadata?.part_count||0);
      if(!count)throw new Error("handoff_part_count_missing");
      const parts=[];
      for(let i=0;i<count;i++){
        const name="part-"+String(i).padStart(5,"0")+".bin";
        const objectPath=String(q.data.storage_path)+"/"+name;
        const dl=await db.storage.from("video-ingest").createSignedUrl(objectPath,3600);
        if(dl.error||!dl.data?.signedUrl)throw new Error("handoff_download_signing_failed:"+i+":"+(dl.error?.message||"missing_url"));
        parts.push({index:i,name,download_url:dl.data.signedUrl});
      }
      return Response.json({ok:true,parts,metadata:q.data.metadata||{}});
    }

    return Response.json({ok:false,error:"unknown_route"},{status:404});
  }catch(e){
    return Response.json({ok:false,error:e instanceof Error?e.message:String(e)},{status:500});
  }
});