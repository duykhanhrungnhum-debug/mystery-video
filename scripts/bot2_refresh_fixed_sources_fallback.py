from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


def norm(text: str) -> str:
    return re.sub(r"[\s《》【】\[\]（）()「」『』:：·・~～_—–\-]", "", (text or "").strip().lower())


def episode_number(title: str) -> int:
    text = title or ""
    m = re.search(r"第\s*(\d{1,4})\s*[季集部]", text, re.I)
    if not m:
        m = re.search(r"(?:season|ep(?:isode)?|s)\s*[-_:#]?\s*(\d{1,4})", text, re.I)
    return int(m.group(1)) if m else 0


def ytdlp_json(url: str, flat: bool = False) -> dict:
    cmd = [sys.executable, "-m", "yt_dlp", "--quiet", "--no-warnings", "--dump-single-json"]
    if flat:
        cmd += ["--flat-playlist", "--playlist-end", "500"]
    cmd += [url]
    out = subprocess.check_output(cmd, text=True, timeout=180)
    return json.loads(out)


def channel_candidates(source: dict) -> list[str]:
    urls = []
    channel = str(source.get("channel_url") or "").rstrip("/")
    if channel:
        urls += [channel + "/videos", channel]
    for seed in source.get("seed_video_urls") or []:
        try:
            meta = ytdlp_json(str(seed), flat=False)
        except Exception:
            continue
        for key in ("channel_url", "uploader_url"):
            value = str(meta.get(key) or "").rstrip("/")
            if value:
                urls += [value + "/videos", value]
    seen = set()
    return [u for u in urls if not (u in seen or seen.add(u))]


def discover(source: dict) -> list[dict]:
    key = norm(str(source.get("series_title") or ""))
    if not key:
        return []
    found_by_id = {}
    for url in channel_candidates(source):
        try:
            data = ytdlp_json(url, flat=True)
        except Exception:
            continue
        for entry in data.get("entries") or []:
            if not isinstance(entry, dict):
                continue
            vid = str(entry.get("id") or "").strip()
            title = str(entry.get("title") or "").strip()
            if not vid or key not in norm(title):
                continue
            found_by_id.setdefault(vid, {
                "source_item_id": vid,
                "title": title,
                "episode_number": episode_number(title),
                "source_channel_id": str(entry.get("channel_id") or ""),
                "source_published_at": None,
            })
    return list(found_by_id.values())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--source-ids", default="")
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    cfg = json.loads(Path(args.config).read_text(encoding="utf-8"))
    wanted = {int(x) for x in args.source_ids.split(",") if x.strip()}
    sources = []
    for source in cfg.get("sources") or []:
        sid = int(source["source_id"])
        if wanted and sid not in wanted:
            continue
        candidates = discover(source)
        sources.append({
            "source_id": sid,
            "series_id": int(source["series_id"]),
            "candidates": candidates,
        })
        print("BOT2_YTDLP_FIXED_FALLBACK", sid, "candidates="+str(len(candidates)), flush=True)
    Path(args.output).write_text(json.dumps({"sources": sources}, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")


if __name__ == "__main__":
    main()
