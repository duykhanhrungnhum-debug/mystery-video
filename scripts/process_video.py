#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

from faster_whisper import WhisperModel
from transformers import pipeline


def ts(seconds: float) -> str:
    ms = max(0, int(round(seconds * 1000)))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def run(cmd):
    return subprocess.run(cmd, check=True, text=True, capture_output=True)


def has_audio(path: str) -> bool:
    result = run([
        "ffprobe", "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=index", "-of", "csv=p=0", path
    ])
    return bool(result.stdout.strip())


def translate_batch(translator, texts):
    output = []
    batch_size = 8
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        rows = translator(batch, max_length=512)
        output.extend([r["translation_text"].strip() for r in rows])
    return output


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--srt", required=True)
    p.add_argument("--metadata", required=True)
    p.add_argument("--title", required=True)
    args = p.parse_args()

    metadata = {"status": "started"}

    try:
        if not has_audio(args.input):
            metadata.update(status="no_audio", error="No audio stream found")
            Path(args.metadata).write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
            return 3

        whisper_name = os.environ.get("WHISPER_MODEL", "small")
        whisper = WhisperModel(whisper_name, device="cpu", compute_type="int8")
        segments_iter, info = whisper.transcribe(
            args.input,
            vad_filter=True,
            beam_size=5,
            condition_on_previous_text=True,
        )
        segments = list(segments_iter)
        texts = [s.text.strip() for s in segments if s.text.strip()]
        word_count = sum(len(t.split()) for t in texts)

        metadata.update(
            detected_language=info.language,
            language_probability=float(info.language_probability or 0),
            transcript_words=word_count,
        )

        if word_count < 5:
            metadata.update(status="no_speech", error="Audio exists but no usable spoken transcript was detected")
            Path(args.metadata).write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
            return 3

        if info.language != "en":
            metadata.update(status="unsupported_language", error=f"Detected {info.language}; current automatic translator is English to Vietnamese")
            Path(args.metadata).write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
            return 4

        translator = pipeline(
            "translation",
            model=os.environ.get("TRANSLATION_MODEL", "Helsinki-NLP/opus-mt-en-vi"),
            device=-1,
        )

        vi_texts = translate_batch(translator, texts)
        translated_title = translate_batch(translator, [args.title])[0]

        srt_lines = []
        j = 0
        for seg in segments:
            original = seg.text.strip()
            if not original:
                continue
            vi = vi_texts[j]
            j += 1
            wrapped = "\n".join(textwrap.wrap(vi, width=48)) or vi
            srt_lines.extend([
                str(j),
                f"{ts(seg.start)} --> {ts(seg.end)}",
                wrapped,
                "",
            ])

        Path(args.srt).write_text("\n".join(srt_lines), encoding="utf-8")

        subtitle_filter = (
            f"subtitles={args.srt}:"
            "force_style='FontName=Noto Sans,FontSize=18,Outline=2,Shadow=1,MarginV=32'"
        )

        common = [
            "ffmpeg", "-y", "-i", args.input,
            "-map", "0:v:0", "-map", "0:a:0",
            "-vf", subtitle_filter,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
            "-movflags", "+faststart",
        ]

        audio_mode = "stream_copy"
        first = subprocess.run(common + ["-c:a", "copy", args.output], text=True, capture_output=True)
        if first.returncode != 0:
            audio_mode = "aac_reencode"
            second = subprocess.run(
                common + ["-c:a", "aac", "-b:a", "192k", args.output],
                text=True, capture_output=True
            )
            if second.returncode != 0:
                raise RuntimeError("ffmpeg render failed: " + second.stderr[-2000:])

        metadata.update(
            status="ok",
            translated_title=translated_title[:200],
            subtitle_language="vi",
            original_audio_preserved=True,
            audio_mode=audio_mode,
            segments=len(vi_texts),
        )
        Path(args.metadata).write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
        return 0

    except Exception as exc:
        metadata.update(status="failed", error=str(exc))
        Path(args.metadata).write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
        return 1


if __name__ == "__main__":
    sys.exit(main())
