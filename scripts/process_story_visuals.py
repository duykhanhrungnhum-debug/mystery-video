#!/usr/bin/env python3
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image

API = os.environ.get("STORY_PROCESSOR_API", "").rstrip("/")
SOURCE_KEY = os.environ.get("STORY_SOURCE_KEY", "").strip()
IMAGE_API_URL = os.environ.get("STORY_IMAGE_API_URL", "").strip()
IMAGE_API_KEY = os.environ.get("STORY_IMAGE_API_KEY", "").strip()
IMAGE_MODEL = os.environ.get("STORY_IMAGE_MODEL", "").strip()
IMAGE_SIZE = os.environ.get("STORY_IMAGE_SIZE", "1536x1024").strip()
RIGHTS_CONFIRMED = os.environ.get("STORY_IMAGE_RIGHTS_CONFIRMED", "").lower() == "true"
AUDIENCE = "hidden-beyond-story-processor"

def http_json(url, method="GET", headers=None, payload=None, timeout=120):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))

def http_bytes(url, method="GET", headers=None, data=None, timeout=180):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read(), dict(res.headers)

def get_oidc():
    request_url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"]
    sep = "&" if "?" in request_url else "?"
    url = f"{request_url}{sep}audience={urllib.parse.quote(AUDIENCE)}"
    token = os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]
    data = http_json(url, headers={"Authorization": f"bearer {token}"}, timeout=30)
    return data["value"]

def api_post(route, payload):
    token = get_oidc()
    return http_json(
        f"{API}/{route}",
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        payload=payload,
        timeout=120,
    )

def provider_signature():
    if not IMAGE_API_URL or not IMAGE_API_KEY or not IMAGE_MODEL or not RIGHTS_CONFIRMED:
        return "provider-unconfigured-or-rights-unconfirmed-v1"
    host = urllib.parse.urlparse(IMAGE_API_URL).netloc or "custom"
    return f"openai-image:{host}:{IMAGE_MODEL}:v1"[:240]

def fail(episode_id, message, signature):
    try:
        result = api_post("visual-fail", {
            "episode_id": episode_id,
            "error": str(message)[:2000],
            "repair_signature": signature,
        })
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(f"Could not record visual failure: {exc}", file=sys.stderr)

def generate_image(prompt):
    payload = {
        "model": IMAGE_MODEL,
        "prompt": prompt,
        "size": IMAGE_SIZE,
        "response_format": "b64_json",
    }
    headers = {
        "Authorization": f"Bearer {IMAGE_API_KEY}",
        "Content-Type": "application/json",
    }
    result = http_json(IMAGE_API_URL, method="POST", headers=headers, payload=payload, timeout=300)
    items = result.get("data") or []
    if not items:
        raise RuntimeError("image_provider_returned_no_data")
    item = items[0]
    if item.get("b64_json"):
        return base64.b64decode(item["b64_json"])
    if item.get("url"):
        blob, _ = http_bytes(item["url"], timeout=180)
        return blob
    raise RuntimeError("image_provider_returned_no_image")

def normalize_image(blob, out_path):
    raw_path = out_path.with_suffix(".raw")
    raw_path.write_bytes(blob)
    try:
        with Image.open(raw_path) as im:
            im.load()
            if im.width < 512 or im.height < 512:
                raise RuntimeError(f"image_too_small_{im.width}x{im.height}")
            im = im.convert("RGB")
            target_w, target_h = 1280, 720
            scale = max(target_w / im.width, target_h / im.height)
            resized = im.resize((round(im.width * scale), round(im.height * scale)), Image.Resampling.LANCZOS)
            left = (resized.width - target_w) // 2
            top = (resized.height - target_h) // 2
            cropped = resized.crop((left, top, left + target_w, top + target_h))
            cropped.save(out_path, format="PNG", optimize=True)
    finally:
        raw_path.unlink(missing_ok=True)
    if out_path.stat().st_size < 20_000:
        raise RuntimeError("normalized_image_too_small")

def upload_signed(url, path, content_type):
    body = path.read_bytes()
    req = urllib.request.Request(
        url,
        data=body,
        method="PUT",
        headers={
            "Content-Type": content_type,
            "Cache-Control": "max-age=3600",
            "x-upsert": "true",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as res:
            res.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:1000]
        raise RuntimeError(f"signed_upload_http_{exc.code}:{detail}") from exc

def probe(path):
    cmd = [
        "ffprobe", "-v", "error", "-show_streams", "-show_format",
        "-of", "json", str(path)
    ]
    return json.loads(subprocess.check_output(cmd, text=True))

def media_duration(info):
    duration = info.get("format", {}).get("duration")
    if duration:
        return float(duration)
    durations = []
    for stream in info.get("streams", []):
        if stream.get("duration"):
            durations.append(float(stream["duration"]))
    return max(durations) if durations else 0.0

def render_video(images, narration, output):
    audio_info = probe(narration)
    audio_streams = [s for s in audio_info.get("streams", []) if s.get("codec_type") == "audio"]
    if not audio_streams:
        raise RuntimeError("narration_has_no_audio_stream")
    audio_duration = media_duration(audio_info)
    if audio_duration < 20:
        raise RuntimeError(f"narration_too_short_{audio_duration:.2f}s")
    per_scene = max(audio_duration / max(len(images), 1), 0.5)
    concat = output.parent / "visuals.concat.txt"
    with concat.open("w", encoding="utf-8") as f:
        for image in images:
            escaped = str(image.resolve()).replace("'", "'\\''")
            f.write(f"file '{escaped}'\n")
            f.write(f"duration {per_scene:.6f}\n")
        escaped = str(images[-1].resolve()).replace("'", "'\\''")
        f.write(f"file '{escaped}'\n")
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", str(concat),
        "-i", str(narration),
        "-shortest",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p", "-r", "30",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(output),
    ]
    subprocess.run(cmd, check=True)
    return audio_duration

def verify_video(output, audio_duration):
    if not output.exists() or output.stat().st_size < 1_000_000:
        raise RuntimeError("final_video_missing_or_too_small")
    info = probe(output)
    videos = [s for s in info.get("streams", []) if s.get("codec_type") == "video"]
    audios = [s for s in info.get("streams", []) if s.get("codec_type") == "audio"]
    if not videos:
        raise RuntimeError("final_video_missing_video_stream")
    if not audios:
        raise RuntimeError("final_video_missing_audio_stream")
    video = videos[0]
    resolution_ok = int(video.get("width") or 0) == 1280 and int(video.get("height") or 0) == 720
    video_duration = media_duration(info)
    duration_match = abs(video_duration - audio_duration) <= 3.0
    if not resolution_ok:
        raise RuntimeError(f"final_resolution_invalid_{video.get('width')}x{video.get('height')}")
    if not duration_match:
        raise RuntimeError(f"final_duration_mismatch_video_{video_duration:.2f}_audio_{audio_duration:.2f}")
    return {
        "images_valid": True,
        "audio_valid": True,
        "video_valid": True,
        "duration_match": True,
        "resolution_ok": True,
        "video_duration_seconds": round(video_duration, 3),
        "audio_duration_seconds": round(audio_duration, 3),
        "final_size_bytes": output.stat().st_size,
    }

def main():
    if not API or not SOURCE_KEY:
        raise RuntimeError("missing_story_runtime_configuration")

    signature = provider_signature()
    claim = api_post("visual-claim", {
        "source_key": SOURCE_KEY,
        "repair_signature": signature,
    })
    if claim.get("stage") == "idle":
        print(json.dumps(claim, ensure_ascii=False))
        return 0
    if claim.get("stage") != "visual_claimed":
        raise RuntimeError(f"unexpected_visual_claim:{claim}")

    job = claim["job"]
    episode_id = int(job["episode_id"])

    if signature.startswith("provider-unconfigured"):
        fail(episode_id, "visual_provider_unconfigured_or_rights_unconfirmed", signature)
        return 0

    work = Path(tempfile.mkdtemp(prefix=f"story-visual-{episode_id}-"))
    try:
        narration = work / "narration.wav"
        blob, _ = http_bytes(job["narration"]["signedUrl"], timeout=180)
        narration.write_bytes(blob)
        if narration.stat().st_size < 10_000:
            raise RuntimeError("downloaded_narration_too_small")

        image_paths = []
        completed_assets = []
        for asset in job["assets"]:
            scene_no = int(asset["scene_no"])
            prompt = str(asset.get("prompt_vi") or "").strip()
            if not prompt:
                raise RuntimeError(f"missing_visual_prompt_scene_{scene_no}")
            enhanced = (
                prompt
                + ". Cinematic historical Chinese illustration, coherent characters, "
                  "16:9 composition, detailed environment, no text, no logo, no watermark."
            )
            image_blob = generate_image(enhanced)
            image_path = work / f"scene-{scene_no:03d}.png"
            normalize_image(image_blob, image_path)
            upload_signed(asset["signedUrl"], image_path, "image/png")
            image_paths.append(image_path)
            completed_assets.append({"scene_no": scene_no, "path": asset["path"]})

        final_video = work / "final.mp4"
        audio_duration = render_video(image_paths, narration, final_video)
        verification = verify_video(final_video, audio_duration)
        upload_signed(job["final_video"]["signedUrl"], final_video, "video/mp4")

        result = api_post("visual-complete", {
            "episode_id": episode_id,
            "repair_signature": signature,
            "assets": completed_assets,
            "final_video_path": job["final_video"]["path"],
            "verification": verification,
        })
        print(json.dumps(result, ensure_ascii=False))
        if result.get("stage") != "verified_publish_ready":
            raise RuntimeError(f"visual_complete_not_verified:{result}")
        return 0
    except Exception as exc:
        fail(episode_id, str(exc), signature)
        raise

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"visual worker failed: {exc}", file=sys.stderr)
        raise
