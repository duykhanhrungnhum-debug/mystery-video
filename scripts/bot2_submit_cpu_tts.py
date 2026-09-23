#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen

from mystery_video.kaggle_submit import KaggleClient

AI_WORKER_REVISION = "ee13877eedaeffaaa256210a2bb0c1e1be2ddc20"
CHECKPOINT_REVISION = "3bf7f1507b3936b56ded8398b078131d72c0ac46"
AI_WORKER_URL = f"https://raw.githubusercontent.com/duykhanhrungnhum-debug/AI-/{AI_WORKER_REVISION}/hidden_beyond/longform_audio_worker_v3.py"


def fetch_ai_worker() -> str:
    req = Request(AI_WORKER_URL, headers={"User-Agent": "Hidden-Beyond-Bot2/1.0"})
    with urlopen(req, timeout=60) as r:
        text = r.read().decode("utf-8")
    marker = "# __JOB_CONFIG_INJECT__"
    if marker not in text:
        raise RuntimeError("AI worker injection marker missing")
    return text


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--youtube-session", required=True)
    ap.add_argument("--source-ref", required=True)
    ap.add_argument("--output", default="bot2-cpu-submission.json")
    args = ap.parse_args()

    job = json.loads(Path(args.job).read_text(encoding="utf-8"))
    yt = json.loads(Path(args.youtube_session).read_text(encoding="utf-8"))
    source_ref = args.source_ref.strip()
    if not source_ref or "/" not in source_ref:
        raise RuntimeError("invalid source kernel ref")

    video_id = str(job["item"]["source_item_id"])
    cpu_slug = ("hidden-beyond-bot2-tts-" + video_id.lower().replace("_", "-"))[:48]
    cpu_ref = f"{os.environ.get('KAGGLE_USERNAME','duykhanhta')}/{cpu_slug}"

    runtime = {
        "mode": "bot2",
        "phase": "tts_only",
        "job_id": "bot2-" + video_id,
        "job_token": job["job_token"],
        "callback_base": job["callback_base"],
        "source_video_id": video_id,
        "worker_revision": AI_WORKER_REVISION,
        "checkpoint_revision": CHECKPOINT_REVISION,
        "gpu_kernel_ref": "",
        "mounted_source_glob": "/kaggle/input/**/source.mp4",
        "config": {
            "source_video_id": video_id,
            "series_id": int(job["series"]["id"]),
            "episode_number": int(job["item"]["episode_number"]),
            "title": str(job["item"].get("title") or ""),
            "series_title": str(job["series"].get("playlist_title") or job["series"].get("series_title") or ""),
            "translation_profile": {},
            "youtube_upload_url": yt["upload_url"],
        },
    }
    worker = fetch_ai_worker().replace("# __JOB_CONFIG_INJECT__", "JOB=" + repr(runtime), 1)

    client = KaggleClient(
        token=os.environ.get("KAGGLE_API_TOKEN", ""),
        username=os.environ.get("KAGGLE_USERNAME", "duykhanhta"),
        broker_url=os.environ.get("BOT2_KAGGLE_BROKER_URL", ""),
        broker_token=os.environ.get("BOT2_KAGGLE_BROKER_TOKEN", ""),
    )
    sub = client.submit_script(
        slug=cpu_slug,
        title="Hidden Beyond Bot2 CPU TTS " + video_id,
        source=worker,
        enable_gpu=False,
        kernel_data_sources=[source_ref],
    )
    result = {
        "ref": sub.ref,
        "version_number": sub.version_number,
        "source_ref": source_ref,
        "source_video_id": video_id,
        "ai_worker_revision": AI_WORKER_REVISION,
        "checkpoint_revision": CHECKPOINT_REVISION,
        "accelerator": "cpu",
    }
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("BOT2_CPU_TTS_SUBMITTED", json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
