from __future__ import annotations

import argparse

from .collector import dedupe_candidates, parse_feed
from .db import list_active_sources, save_candidates


def main() -> None:
    parser = argparse.ArgumentParser(description="Mystery Video MVP")
    parser.add_argument("--list-sources", action="store_true")
    parser.add_argument("--collect", type=str, metavar="FEED_URL")
    parser.add_argument("--source-id", type=int, metavar="SOURCE_ID")
    args = parser.parse_args()

    if args.list_sources:
        for source in list_active_sources():
            print(
                f'{source["id"]}: {source["name"]} | '
                f'auto_eligible={source["auto_eligible"]} | '
                f'feed_url={source.get("feed_url") or "-"}'
            )
        return

    if args.collect:
        if args.source_id is None:
            raise SystemExit("--source-id is required with --collect")

        candidates = dedupe_candidates(parse_feed(args.collect))
        inserted = save_candidates(
            args.source_id,
            [
                {
                    "source_video_id": item.source_video_id,
                    "source_url": item.source_url,
                    "title": item.title,
                    "download_url": item.download_url,
                }
                for item in candidates
            ],
        )
        print(f"discovered={len(candidates)} stored={inserted}")
        return

    parser.print_help()


if __name__ == "__main__":
    main()
