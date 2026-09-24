#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path

from mystery_video.kaggle_submit import KaggleClient


def safe_slug(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9-]+", "-", value).strip("-").lower()
    return value[:48] or "episode"


def build_worker(job: dict, kernel_ref: str) -> str:
    return r'''import json, subprocess, sys, time, urllib.request
from pathlib import Path

JOB = __JOB__
CALLBACK = JOB["callback_base"].rstrip("/")

def post(route, payload):
    data=json.dumps(payload,ensure_ascii=False).encode("utf-8")
    req=urllib.request.Request(
        CALLBACK+route,
        data=data,
        method="POST",
        headers={"content-type":"application/json","x-bot2-token":JOB["job_token"]},
    )
    with urllib.request.urlopen(req,timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))

def stage(name,message,**extra):
    payload={"source_video_id":JOB["source_video_id"],"stage":name,"message":message}
    payload.update(extra)
    print("BOT2_SOURCE_STAGE",json.dumps(payload,ensure_ascii=False),flush=True)
    post("/worker-stage",payload)

try:
    stage("source_downloading","Kaggle CPU is acquiring the fixed-source episode")
    subprocess.check_call([
        sys.executable,"-m","pip","install","--quiet","-U",
        "yt-dlp[default]>=2026.1","bgutil-ytdlp-pot-provider"
    ])
    subprocess.check_call([
        "bash","-lc",
        "export DENO_INSTALL=/kaggle/working/deno && curl -fsSL https://deno.land/install.sh | sh"
    ])
    deno="/kaggle/working/deno/bin/deno"
    subprocess.check_call([
        "git","clone","--depth","1","--branch","2.0.0",
        "https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git",
        "/kaggle/working/bgutil"
    ])
    subprocess.check_call(["npm","ci"],cwd="/kaggle/working/bgutil/server")
    subprocess.check_call(["npx","tsc"],cwd="/kaggle/working/bgutil/server")
    log=open("/kaggle/working/bgutil.log","w",encoding="utf-8")
    provider=subprocess.Popen(
        ["node","build/main.js"],
        cwd="/kaggle/working/bgutil/server",
        stdout=log,stderr=subprocess.STDOUT
    )
    time.sleep(3)

    source=Path("/kaggle/working/source.mp4")

    def valid_source():
        if not source.exists() or source.stat().st_size < 1_000_000:
            return False
        try:
            probe=subprocess.check_output([
                "ffprobe","-v","error","-show_entries",
                "stream=codec_type","-of","csv=p=0",str(source)
            ],text=True)
        except Exception:
            return False
        kinds={x.strip() for x in probe.splitlines() if x.strip()}
        return "video" in kinds and "audio" in kinds

    # YouTube access changes frequently. Keep source acquisition bounded and
    # method-local: try the preferred PO-token path, then two no-cookie clients.
    # Stop immediately after the first valid A/V file.
    strategies=[
        {
            "name":"mweb_bgutil",
            "extractor":"youtube:player_client=mweb",
            "format":"b[height<=480]/b",
        },
        {
            "name":"tv_skip_webpage",
            "extractor":"youtube:player_client=tv;player_skip=webpage,configs",
            "format":"b[height<=480]/b",
        },
        {
            "name":"android_vr_skip_webpage",
            "extractor":"youtube:player_client=android_vr;player_skip=webpage,configs",
            "format":"b[height<=480]/b",
        },
    ]
    errors=[]
    selected_strategy=""
    for strategy in strategies:
        for stale in Path("/kaggle/working").glob("source.mp4*"):
            try: stale.unlink()
            except Exception: pass
        cmd=[
            sys.executable,"-m","yt_dlp",
            "--no-playlist","--retries","2","--fragment-retries","2",
            "--remote-components","ejs:npm",
            "--js-runtimes","deno:"+deno,
            "--extractor-args",strategy["extractor"],
            "-f",strategy["format"],
            "--merge-output-format","mp4",
            "-o",str(source),
            JOB["source_url"],
        ]
        p=subprocess.run(cmd,text=True,capture_output=True)
        if p.returncode==0 and valid_source():
            selected_strategy=strategy["name"]
            print("BOT2_SOURCE_DOWNLOAD_STRATEGY",selected_strategy,flush=True)
            break
        errors.append({
            "strategy":strategy["name"],
            "returncode":p.returncode,
            "stderr":(p.stderr or "")[-900:],
        })
        print("BOT2_SOURCE_DOWNLOAD_RETRY",strategy["name"],p.returncode,flush=True)
    if not selected_strategy:
        raise RuntimeError("source_download_all_methods_failed:"+json.dumps(errors,ensure_ascii=False))

    # Caption-first production path: acquire Chinese subtitles on CPU while the
    # source downloader and anti-bot provider are already warm. Missing captions
    # are not a failure; the AI worker will fall back to ASR only when needed.
    caption_ok=False
    try:
        for caption_client in ("mweb","web_safari"):
            caption_cmd=[
                sys.executable,"-m","yt_dlp",
                "--no-playlist","--skip-download",
                "--retries","1",
                "--remote-components","ejs:npm",
                "--js-runtimes","deno:"+deno,
                "--extractor-args","youtube:player_client="+caption_client,
                "--write-subs","--write-auto-subs",
                "--sub-langs","zh-Hans,zh-CN,zh,zh-Hant,zh-TW",
                "--sub-format","json3",
                "-o","/kaggle/working/source-caption.%(ext)s",
                JOB["source_url"],
            ]
            subprocess.run(caption_cmd,check=False,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            if any(
                p.is_file() and p.stat().st_size>200
                for p in Path("/kaggle/working").glob("source-caption*.json3")
            ):
                break
        caption_files=[
            p for p in Path("/kaggle/working").glob("source-caption*.json3")
            if p.is_file() and p.stat().st_size>200
        ]
        caption_ok=bool(caption_files)
        print(
            "BOT2_SOURCE_CAPTION",
            "ready" if caption_ok else "missing",
            [p.name for p in caption_files],
            flush=True,
        )
    except Exception as caption_exc:
        print("BOT2_SOURCE_CAPTION fallback_asr",repr(caption_exc),flush=True)

    try:
        provider.terminate()
    except Exception:
        pass

    # Remove installer/runtime payload so the next Kaggle job mounts only useful output.
    subprocess.run(["rm","-rf","/kaggle/working/bgutil","/kaggle/working/deno"],check=False)
    stage(
        "source_ready",
        "Source verified on Kaggle CPU via "+selected_strategy,
        source_kernel_ref=JOB["source_kernel_ref"],
        source_bytes=source.stat().st_size,
    )
except Exception as exc:
    try:
        post("/worker-fail",{
            "source_video_id":JOB["source_video_id"],
            "stage":"source_downloading",
            "error":repr(exc),
        })
    finally:
        raise
'''.replace("__JOB__", repr({
        "callback_base": job["callback_base"],
        "job_token": job["job_token"],
        "source_video_id": job["item"]["source_item_id"],
        "source_url": job["item"]["source_url"],
        "source_kernel_ref": kernel_ref,
    }))


def main() -> None:
    ap=argparse.ArgumentParser()
    ap.add_argument("--job",required=True)
    ap.add_argument("--output",default="bot2-source-submission.json")
    args=ap.parse_args()

    job=json.loads(Path(args.job).read_text(encoding="utf-8"))
    video_id=str(job["item"]["source_item_id"])
    slug="hidden-beyond-bot2-source-"+safe_slug(video_id)
    kernel_ref=f"{os.environ.get('KAGGLE_USERNAME','duykhanhta')}/{slug}"
    worker=build_worker(job,kernel_ref)
    client=KaggleClient(
        token=os.environ.get("KAGGLE_API_TOKEN",""),
        username=os.environ.get("KAGGLE_USERNAME","duykhanhta"),
        broker_url=os.environ.get("BOT2_KAGGLE_BROKER_URL",""),
        broker_token=os.environ.get("BOT2_KAGGLE_BROKER_TOKEN",""),
    )
    sub=client.submit_script(
        slug=slug,
        title="Hidden Beyond Bot2 Source "+video_id,
        source=worker,
        enable_gpu=False,
    )
    result={"ref":sub.ref,"version_number":sub.version_number,"source_video_id":video_id}
    Path(args.output).write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print("BOT2_SOURCE_SUBMITTED",json.dumps(result,ensure_ascii=False))


if __name__=="__main__":
    main()
