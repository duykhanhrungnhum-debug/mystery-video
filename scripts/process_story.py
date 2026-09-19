#!/usr/bin/env python3
import argparse
import gc
import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import torch
from PIL import Image, ImageDraw, ImageFont
from transformers import AutoModelForCausalLM, AutoModelForSeq2SeqLM, AutoTokenizer

TRANSLATION_MODEL = os.environ.get("STORY_TRANSLATION_MODEL", "Helsinki-NLP/opus-mt-zh-vi")
REWRITE_MODEL = os.environ.get("STORY_REWRITE_MODEL", "Qwen/Qwen2.5-0.5B-Instruct")
TTS_VOICE = os.environ.get("STORY_TTS_VOICE", "vi_VN-vais1000-medium")


def run(cmd, *, input_text=None):
    return subprocess.run(
        cmd,
        input=input_text,
        text=True if input_text is not None else False,
        check=True,
        capture_output=True,
    )


def clean_source(text: str) -> str:
    text = text.replace("\u3000", " ").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def split_chinese(text: str, max_chars: int = 360):
    parts = re.split(r"(?<=[。！？；!?])|\n+", text)
    chunks = []
    buf = ""
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if len(part) > max_chars:
            while len(part) > max_chars:
                take = part[:max_chars]
                chunks.append(take)
                part = part[max_chars:]
        if not part:
            continue
        if len(buf) + len(part) + 1 <= max_chars:
            buf = (buf + part).strip()
        else:
            if buf:
                chunks.append(buf)
            buf = part
    if buf:
        chunks.append(buf)
    return chunks


def translate_chunks(chunks):
    tokenizer = AutoTokenizer.from_pretrained(TRANSLATION_MODEL)
    model = AutoModelForSeq2SeqLM.from_pretrained(TRANSLATION_MODEL)
    model.eval()
    out = []
    batch_size = 4
    with torch.inference_mode():
        for i in range(0, len(chunks), batch_size):
            batch = chunks[i:i + batch_size]
            encoded = tokenizer(
                batch,
                return_tensors="pt",
                padding=True,
                truncation=True,
                max_length=512,
            )
            generated = model.generate(
                **encoded,
                max_new_tokens=512,
                num_beams=4,
                early_stopping=True,
            )
            decoded = tokenizer.batch_decode(generated, skip_special_tokens=True)
            out.extend(x.strip() for x in decoded)
    del model
    del tokenizer
    gc.collect()
    return out


def group_text(parts, max_chars=1700):
    groups, buf = [], ""
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if len(buf) + len(p) + 2 <= max_chars:
            buf = (buf + "\n" + p).strip()
        else:
            if buf:
                groups.append(buf)
            buf = p
    if buf:
        groups.append(buf)
    return groups


def rewrite_narration(parts):
    tokenizer = AutoTokenizer.from_pretrained(REWRITE_MODEL)
    model = AutoModelForCausalLM.from_pretrained(
        REWRITE_MODEL,
        torch_dtype=torch.float32,
        low_cpu_mem_usage=True,
    )
    model.eval()
    groups = group_text(parts)
    rewritten = []
    fallbacks = 0

    for group in groups:
        messages = [
            {
                "role": "system",
                "content": (
                    "Bạn là biên kịch kể chuyện tiếng Việt. "
                    "Nhiệm vụ là chỉnh đoạn dịch thành lời kể tự nhiên, dễ nghe khi đọc thành audio. "
                    "Giữ đúng diễn biến, nhân vật và quan hệ trong nguyên tác; không thêm tình tiết mới; "
                    "không bình luận về bản quyền hay quá trình dịch. Chỉ trả về lời kể."
                ),
            },
            {
                "role": "user",
                "content": (
                    "Hãy viết lại đoạn dưới đây thành lời kể tiếng Việt liền mạch, "
                    "giữ đầy đủ ý chính và tên riêng:\n\n" + group
                ),
            },
        ]
        prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=3072)
        with torch.inference_mode():
            output = model.generate(
                **inputs,
                max_new_tokens=900,
                do_sample=False,
                repetition_penalty=1.06,
                eos_token_id=tokenizer.eos_token_id,
                pad_token_id=tokenizer.eos_token_id,
            )
        text = tokenizer.decode(output[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True).strip()
        if len(text) < max(120, int(len(group) * 0.35)):
            text = group
            fallbacks += 1
        rewritten.append(text)

    del model
    del tokenizer
    gc.collect()
    return rewritten, fallbacks


def make_visual_plan(script: str, count: int = 8):
    sentences = [x.strip() for x in re.split(r"(?<=[.!?…])\s+|\n+", script) if len(x.strip()) > 20]
    if not sentences:
        sentences = [script[:500]]
    count = min(count, len(sentences))
    indexes = [round(i * (len(sentences) - 1) / max(1, count - 1)) for i in range(count)]
    plan = []
    seen = set()
    scene_no = 1
    for idx in indexes:
        if idx in seen:
            continue
        seen.add(idx)
        excerpt = sentences[idx][:320]
        plan.append({
            "scene": scene_no,
            "narration_excerpt_vi": excerpt,
            "prompt_vi": (
                "Minh họa hoạt hình 2D điện ảnh dựa đúng bối cảnh truyện cổ Trung Hoa; "
                "không chữ, không logo, không người thật; ánh sáng kịch tính, bố cục 16:9. "
                "Cảnh cần minh họa: " + excerpt
            ),
        })
        scene_no += 1
    return plan


def font(size):
    candidates = [
        "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
        "/usr/share/fonts/opentype/noto/NotoSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    for p in candidates:
        if Path(p).exists():
            return ImageFont.truetype(p, size=size)
    return ImageFont.load_default()


def make_cover(path: str, title: str, episode_no: int):
    w, h = 1280, 720
    img = Image.new("RGB", (w, h), (12, 16, 28))
    px = img.load()
    for y in range(h):
        for x in range(w):
            r = int(12 + 24 * (x / w) + 14 * (y / h))
            g = int(16 + 16 * (x / w))
            b = int(28 + 28 * (1 - y / h))
            px[x, y] = (r, g, b)

    d = ImageDraw.Draw(img)
    d.rectangle((64, 58, w - 64, h - 58), outline=(212, 178, 92), width=3)
    d.text((90, 90), "HIDDEN BEYOND", font=font(30), fill=(225, 205, 150))

    wrapped = textwrap.wrap(title, width=28) or [title]
    y = 215
    for line in wrapped[:3]:
        box = d.textbbox((0, 0), line, font=font(62))
        tw = box[2] - box[0]
        d.text(((w - tw) / 2, y), line, font=font(62), fill=(245, 244, 238))
        y += 82

    ep = f"TẬP {episode_no}"
    box = d.textbbox((0, 0), ep, font=font(38))
    tw = box[2] - box[0]
    d.text(((w - tw) / 2, 520), ep, font=font(38), fill=(212, 178, 92))
    d.text(
        (90, 635),
        "Bản dựng thử nghiệm • Hình ảnh AI sẽ được thay ở bước tiếp theo",
        font=font(22),
        fill=(196, 199, 207),
    )
    img.save(path)


def synthesize_piper(script: str, model_path: str, config_path: str, output_path: str):
    piper = shutil.which("piper")
    if piper:
        cmd = [piper, "--model", model_path, "--config", config_path, "--output_file", output_path]
    else:
        cmd = [sys.executable, "-m", "piper", "--model", model_path, "--config", config_path, "--output_file", output_path]
    result = subprocess.run(cmd, input=script + "\n", text=True, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError("Piper TTS failed: " + result.stderr[-3000:])
    if not Path(output_path).exists() or Path(output_path).stat().st_size < 10000:
        raise RuntimeError("Piper TTS did not create a usable WAV file")


def render_preview(cover: str, audio: str, output: str):
    cmd = [
        "ffmpeg", "-y",
        "-loop", "1", "-framerate", "2", "-i", cover,
        "-i", audio,
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage",
        "-crf", "25", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k",
        "-shortest", "-movflags", "+faststart",
        output,
    ]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError("ffmpeg preview render failed: " + result.stderr.decode("utf-8", "ignore")[-3000:])


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--source-text", required=True)
    p.add_argument("--series-title", required=True)
    p.add_argument("--episode-no", required=True, type=int)
    p.add_argument("--voice-model", required=True)
    p.add_argument("--voice-config", required=True)
    p.add_argument("--script-out", required=True)
    p.add_argument("--audio-out", required=True)
    p.add_argument("--preview-out", required=True)
    p.add_argument("--metadata-out", required=True)
    args = p.parse_args()

    meta = {"status": "started"}
    try:
        source = clean_source(Path(args.source_text).read_text(encoding="utf-8"))
        if len(source) < 200:
            raise RuntimeError("Source text is too short")

        chunks = split_chinese(source)
        translations = translate_chunks(chunks)
        rewritten, fallbacks = rewrite_narration(translations)

        title_vi = f"{args.series_title} - Tập {args.episode_no}"
        intro = (
            f"{title_vi}. "
            "Sau đây là phiên bản kể chuyện tiếng Việt được biên tập từ nguyên tác thuộc phạm vi công cộng."
        )
        outro = "Hết tập này. Câu chuyện sẽ tiếp tục ở tập kế tiếp."
        script = intro + "\n\n" + "\n\n".join(rewritten) + "\n\n" + outro

        if len(script) < 300:
            raise RuntimeError("Generated Vietnamese script is too short")

        Path(args.script_out).write_text(script, encoding="utf-8")
        visual_plan = make_visual_plan(script)

        synthesize_piper(script, args.voice_model, args.voice_config, args.audio_out)
        cover = str(Path(args.preview_out).with_suffix(".png"))
        make_cover(cover, args.series_title, args.episode_no)
        render_preview(cover, args.audio_out, args.preview_out)

        meta.update({
            "status": "ok",
            "title_vi": title_vi,
            "script_chars": len(script),
            "source_chars": len(source),
            "translation_chunks": len(chunks),
            "rewrite_groups": len(rewritten),
            "rewrite_fallbacks": fallbacks,
            "translation_model": TRANSLATION_MODEL,
            "rewrite_model": REWRITE_MODEL,
            "tts_voice": TTS_VOICE,
            "visual_mode": "placeholder_motion_card",
            "visual_plan": visual_plan,
            "generation_notes": (
                "Vietnamese script generated locally from public-domain source. "
                "Translation uses Apache-2.0 OPUS-MT zh-vi; narration rewrite uses Apache-2.0 Qwen2.5-0.5B-Instruct. "
                "TTS uses Piper vi_VN-vais1000-medium; its model card lists the VAIS-1000 dataset as CC BY 4.0. "
                "Preview image is procedural and is NOT the final AI-animation stage."
            ),
        })
        Path(args.metadata_out).write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        return 0
    except Exception as exc:
        meta.update({"status": "failed", "error": str(exc)})
        Path(args.metadata_out).write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        return 1


if __name__ == "__main__":
    sys.exit(main())
