#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


def parse_trigger(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def build_request(event: str, trigger: dict[str, str]) -> dict:
    if event == "schedule":
        return {"selection_mode": "rotation", "run_origin": "schedule"}

    explicit = trigger.get("selection_mode", "").strip().lower()
    if explicit:
        mode = explicit
    elif trigger.get("source_rotation") and trigger.get("episode"):
        mode = "exact"
    else:
        mode = "rotation"

    if mode == "rotation":
        return {"selection_mode": "rotation", "run_origin": event or "manual"}

    if mode != "exact":
        raise SystemExit(f"unsupported selection_mode={mode!r}")

    try:
        rotation = int(trigger["source_rotation"])
        episode = int(trigger["episode"])
    except (KeyError, ValueError) as exc:
        raise SystemExit("exact selection requires integer source_rotation and episode") from exc
    if rotation < 1 or rotation > 5 or episode < 1:
        raise SystemExit("exact selection target is out of range")
    return {
        "selection_mode": "exact",
        "target_rotation": rotation,
        "target_episode": episode,
        "run_origin": event or "manual",
    }


def verify_selection(request: dict, job: dict) -> None:
    if request.get("selection_mode") != "exact":
        return
    stage = str(job.get("stage") or "")
    if stage not in {"selected", "resume_source_ready"}:
        return
    got_rotation = int(job.get("rotation") or 0)
    item = job.get("item") or {}
    got_episode = int(item.get("episode_number") or 0)
    want_rotation = int(request["target_rotation"])
    want_episode = int(request["target_episode"])
    if (got_rotation, got_episode) != (want_rotation, want_episode):
        raise SystemExit(
            "selection guard failed: "
            f"requested rotation={want_rotation} episode={want_episode}, "
            f"got rotation={got_rotation} episode={got_episode}"
        )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--event")
    ap.add_argument("--trigger")
    ap.add_argument("--output")
    ap.add_argument("--verify-request")
    ap.add_argument("--verify-job")
    args = ap.parse_args()

    if args.verify_request or args.verify_job:
        if not args.verify_request or not args.verify_job:
            raise SystemExit("--verify-request and --verify-job must be used together")
        request = json.loads(Path(args.verify_request).read_text(encoding="utf-8"))
        job = json.loads(Path(args.verify_job).read_text(encoding="utf-8"))
        verify_selection(request, job)
        print("BOT2_SELECTION_GUARD_OK", json.dumps(request, ensure_ascii=False))
        return

    if not args.output:
        raise SystemExit("--output is required")
    trigger = parse_trigger(Path(args.trigger or ".github/bot2.trigger"))
    request = build_request(str(args.event or ""), trigger)
    Path(args.output).write_text(
        json.dumps(request, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print("BOT2_SELECTION_REQUEST", json.dumps(request, ensure_ascii=False))


if __name__ == "__main__":
    main()
