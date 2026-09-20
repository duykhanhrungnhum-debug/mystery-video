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
    if int(payload.get("policy_version") or 0) < 2:
        raise RuntimeError("source registry policy is obsolete; refusing legacy candidate scan")
    if payload.get("policy") != "approved-items-only":
        raise RuntimeError("source registry is not in approved-items-only mode")
    if payload.get("rejected_candidates_exposed") is not False:
        raise RuntimeError("source registry exposed rejected/candidate sources")

    sources = {
        int(item["id"]): item
        for item in (payload.get("sources") or [])
        if item.get("active")
        and item.get("auto_eligible")
        and item.get("approval_status") == "approved"
    }
    approved_items = payload.get("approved_items") or []

    candidates = []
    seen: set[tuple[int, str]] = set()
    for item in approved_items:
        source_id = int(item["source_id"])
        source_item_id = str(item.get("source_item_id") or "").strip()
        if source_id not in sources:
            raise RuntimeError(f"approved item references non-approved source {source_id}")
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
            row["series_title"] or "",
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
        f"approved_sources={len(sources)} approved_items={len(candidates)} "
        "search_performed=false rejected_sources_exposed=false"
    )


if __name__ == "__main__":
    main()
