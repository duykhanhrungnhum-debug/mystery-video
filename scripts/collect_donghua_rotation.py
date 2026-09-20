#!/usr/bin/env python3
"""Emit only source items already approved by the external source registry.

This is intentionally NOT a source-searcher. It does not browse YouTube,
inspect candidate channels, infer licences, or approve rights. The source
management layer owns those responsibilities. Bot consumes APPROVED items only.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sources-json", required=True)
    args = ap.parse_args()

    payload = json.loads(Path(args.sources_json).read_text(encoding="utf-8"))
    if not payload.get("ok"):
        raise RuntimeError(f"source registry failed: {payload}")
    if int(payload.get("policy_version") or 0) < 3:
        raise RuntimeError("source registry policy is obsolete; refusing legacy candidate scan")
    if payload.get("policy") != "approved-series-items-only":
        raise RuntimeError("source registry is not in approved-series-items-only mode")
    if payload.get("rejected_candidates_exposed") is not False:
        raise RuntimeError("source registry exposed rejected/candidate sources")

    sources = {
        int(item["id"]): item
        for item in (payload.get("sources") or [])
        if item.get("active")
        and item.get("auto_eligible")
        and item.get("approval_status") == "approved"
    }
    active_series = payload.get("active_series") or []
    series_by_id = {int(s["id"]): s for s in active_series if s.get("active")}
    backfill_counts = Counter(
        int(s["source_id"]) for s in active_series
        if s.get("active") and s.get("state") == "backfill"
    )
    if any(count > 1 for count in backfill_counts.values()):
        raise RuntimeError("source registry exposed multiple backfill series for one source")

    approved_items = payload.get("approved_items") or []

    candidates = []
    seen: set[tuple[int, str]] = set()
    for item in approved_items:
        source_id = int(item["source_id"])
        series_id = int(item.get("series_id") or 0)
        source_item_id = str(item.get("source_item_id") or "").strip()
        if source_id not in sources:
            raise RuntimeError(f"approved item references non-approved source {source_id}")
        if series_id not in series_by_id:
            raise RuntimeError(f"approved item references inactive/untracked series {series_id}")
        series = series_by_id[series_id]
        if int(series["source_id"]) != source_id:
            raise RuntimeError(f"series/source mismatch for item {source_item_id}")
        if item.get("rights_status") != "approved":
            raise RuntimeError(f"non-approved item leaked into registry: {source_item_id}")
        if not source_item_id:
            raise RuntimeError("approved item missing source_item_id")
        key = (source_id, source_item_id)
        if key in seen:
            raise RuntimeError(f"duplicate approved item {key}")
        seen.add(key)

        source_url = str(item.get("source_url") or "").strip()
        evidence_url = str(item.get("evidence_url") or "").strip()
        rights_basis = str(item.get("rights_basis") or "").strip()
        license_type = str(item.get("license_type") or "").strip()
        if not source_url or not evidence_url or not rights_basis or not license_type:
            raise RuntimeError(f"approved item lacks rights evidence: {key}")

        candidates.append({
            "source_id": source_id,
            "series_id": series_id,
            "series_order": series.get("series_order"),
            "series_state": series.get("state"),
            "playlist_title": series.get("playlist_title"),
            "youtube_playlist_id": series.get("youtube_playlist_id"),
            "source_item_id": source_item_id,
            "source_video_id": source_item_id,
            "source_url": source_url,
            "media_url": item.get("media_url"),
            "title": item.get("title"),
            "series_title": item.get("series_title"),
            "episode_number": item.get("episode_number"),
            "status": "approved_source_item",
            "rights_verified": True,
            "rights_basis": rights_basis,
            "license_type": license_type,
            "rights_evidence_url": evidence_url,
            "attribution_text": item.get("attribution_text"),
            "original_audio_verified": False,
        })

    candidates.sort(
        key=lambda row: (
            row["source_id"],
            0 if row["series_state"] == "following" else 1,
            row["series_order"] if row["series_order"] is not None else 10**9,
            row["episode_number"] if row["episode_number"] is not None else 10**9,
            row["source_item_id"],
        )
    )
    counts = Counter(row["source_id"] for row in candidates)
    report = {
        "state": "ready" if candidates else "idle_no_approved_items",
        "policy_version": payload["policy_version"],
        "policy": payload["policy"],
        "approved_source_count": len(sources),
        "active_series_count": len(series_by_id),
        "approved_item_count": len(candidates),
        "counts_by_source": {str(k): v for k, v in sorted(counts.items())},
        "candidates": candidates,
    }
    Path("donghua-candidates.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        "COLLECTOR_OK "
        f"state={report['state']} "
        f"approved_sources={len(sources)} active_series={len(series_by_id)} approved_items={len(candidates)} "
        "search_performed=false rejected_sources_exposed=false"
    )


if __name__ == "__main__":
    main()
