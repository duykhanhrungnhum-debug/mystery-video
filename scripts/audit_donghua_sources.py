#!/usr/bin/env python3
"""Finite source discovery/audit for Hidden Beyond.

This is a SOURCE-MANAGER utility, not the Bot collector. It searches public
YouTube results, inspects metadata once, records licence signals, and stops.
Nothing from this script is publishable until separately promoted to
public.source_items with rights_status='approved'.
"""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

DEFAULT_QUERIES = (
    "修仙 动画",
    "仙侠 动画",
    "穿越 动画",
    "重生 系统 动画",
    "xianxia animation",
    "cultivation donghua",
)


def run_json(cmd: list[str], timeout: int = 90) -> dict:
    p = subprocess.run(cmd, text=True, capture_output=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError((p.stderr or p.stdout)[-1600:])
    return json.loads(p.stdout)


def search(query: str, per_query: int) -> list[dict]:
    data = run_json([
        "yt-dlp", "--flat-playlist", "--dump-single-json",
        "--playlist-end", str(per_query),
        f"ytsearch{per_query}:{query}",
    ])
    return data.get("entries") or []


def inspect(video_id: str) -> dict:
    url = f"https://www.youtube.com/watch?v={video_id}"
    return run_json([
        "yt-dlp", "--skip-download", "--no-playlist",
        "--dump-single-json", "--no-warnings", url,
    ], timeout=75)


def classify(meta: dict) -> tuple[str, str]:
    availability = str(meta.get("availability") or "").strip().lower()
    if availability in {"private", "premium_only", "subscriber_only", "needs_auth"}:
        return "unavailable", f"availability={availability}"

    license_text = str(meta.get("license") or "").strip()
    low = license_text.lower()
    if "creative commons" in low and ("attribution" in low or "reuse" in low):
        return "cc_candidate", f"explicit YouTube metadata license={license_text}"

    return "rejected_no_cc", (
        f"no explicit Creative Commons reuse license in YouTube metadata; "
        f"reported_license={license_text or 'none'}"
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-query", type=int, default=6)
    ap.add_argument("--max-details", type=int, default=24)
    ap.add_argument("--output", default="source-audit.json")
    args = ap.parse_args()

    discovered: list[tuple[str, str]] = []
    seen: set[str] = set()
    search_errors: list[dict] = []

    for query in DEFAULT_QUERIES:
        try:
            for item in search(query, args.per_query):
                video_id = str(item.get("id") or "").strip()
                if not video_id or video_id in seen:
                    continue
                seen.add(video_id)
                discovered.append((query, video_id))
                if len(discovered) >= args.max_details:
                    break
        except Exception as exc:
            search_errors.append({"query": query, "error": str(exc)[-800:]})
        if len(discovered) >= args.max_details:
            break

    audited: list[dict] = []
    for query, video_id in discovered:
        url = f"https://www.youtube.com/watch?v={video_id}"
        try:
            meta = inspect(video_id)
            status, reason = classify(meta)
            channel_id = str(meta.get("channel_id") or "").strip() or None
            channel_url = str(meta.get("channel_url") or "").strip() or (
                f"https://www.youtube.com/channel/{channel_id}" if channel_id else None
            )
            audited.append({
                "platform": "youtube",
                "source_video_id": video_id,
                "source_url": url,
                "title": meta.get("title"),
                "channel_id": channel_id,
                "channel_name": meta.get("channel") or meta.get("uploader"),
                "channel_url": channel_url,
                "search_query": query,
                "reported_license": meta.get("license"),
                "audit_status": status,
                "audit_reason": reason,
                "metadata": {
                    "duration": meta.get("duration"),
                    "upload_date": meta.get("upload_date"),
                    "availability": meta.get("availability"),
                    "live_status": meta.get("live_status"),
                    "extractor": meta.get("extractor"),
                },
            })
        except Exception as exc:
            audited.append({
                "platform": "youtube",
                "source_video_id": video_id,
                "source_url": url,
                "search_query": query,
                "audit_status": "error",
                "audit_reason": str(exc)[-1200:],
                "metadata": {},
            })

    counts: dict[str, int] = {}
    for item in audited:
        counts[item["audit_status"]] = counts.get(item["audit_status"], 0) + 1

    report = {
        "ok": True,
        "manager": "hidden-beyond-source-manager",
        "search_is_separate_from_bot": True,
        "queries": list(DEFAULT_QUERIES),
        "limits": {"per_query": args.per_query, "max_details": args.max_details},
        "discovered_unique": len(discovered),
        "audited": len(audited),
        "counts": counts,
        "search_errors": search_errors,
        "items": audited,
    }
    Path(args.output).write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        "SOURCE_MANAGER_OK "
        f"audited={len(audited)} cc_candidates={counts.get('cc_candidate', 0)} "
        f"rejected={counts.get('rejected_no_cc', 0)} errors={counts.get('error', 0)}"
    )


if __name__ == "__main__":
    main()
