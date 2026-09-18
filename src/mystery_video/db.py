from __future__ import annotations

import os

from dotenv import load_dotenv
from supabase import Client, create_client


def get_client() -> Client:
    load_dotenv()

    url = os.getenv("SUPABASE_URL", "").strip()
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()

    if not url or not service_role_key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required."
        )

    return create_client(url, service_role_key)


def list_active_sources() -> list[dict]:
    client = get_client()
    response = (
        client.table("sources")
        .select("*")
        .eq("active", True)
        .order("id")
        .execute()
    )
    return response.data or []


def save_candidates(source_id: int, candidates: list[dict]) -> int:
    if not candidates:
        return 0

    client = get_client()
    rows = [
        {
            "source_id": source_id,
            "source_video_id": item["source_video_id"],
            "source_url": item["source_url"],
            "title": item.get("title"),
            "status": "discovered",
            "rights_verified": False,
            "download_url": item.get("download_url"),
        }
        for item in candidates
    ]

    response = (
        client.table("videos")
        .upsert(rows, on_conflict="source_id,source_video_id", ignore_duplicates=True)
        .execute()
    )
    return len(response.data or [])
