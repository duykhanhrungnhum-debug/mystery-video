from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable
from urllib.parse import urlparse

import feedparser


@dataclass(frozen=True)
class VideoCandidate:
    source_video_id: str
    source_url: str
    title: str
    published_at: str | None
    download_url: str | None = None


class CollectorError(ValueError):
    pass


def parse_feed(feed_url: str) -> list[VideoCandidate]:
    parsed_url = urlparse(feed_url)
    if parsed_url.scheme not in {"http", "https"}:
        raise CollectorError("feed_url must use http or https")

    feed = feedparser.parse(feed_url)
    candidates: list[VideoCandidate] = []

    for entry in feed.entries:
        source_video_id = str(
            entry.get("yt_videoid")
            or entry.get("id")
            or entry.get("guid")
            or entry.get("link")
            or ""
        ).strip()
        source_url = str(entry.get("link") or "").strip()
        title = str(entry.get("title") or "").strip()

        if not source_video_id or not source_url:
            continue

        candidates.append(
            VideoCandidate(
                source_video_id=source_video_id,
                source_url=source_url,
                title=title,
                published_at=entry.get("published") or entry.get("updated"),
            )
        )

    return candidates


def dedupe_candidates(candidates: Iterable[VideoCandidate]) -> list[VideoCandidate]:
    seen: set[str] = set()
    result: list[VideoCandidate] = []

    for candidate in candidates:
        if candidate.source_video_id in seen:
            continue
        seen.add(candidate.source_video_id)
        result.append(candidate)

    return result
