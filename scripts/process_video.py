#!/usr/bin/env python3
import argparse, json, os, subprocess, sys, textwrap
from pathlib import Path
from faster_whisper import WhisperModel
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mystery_video.ai_agent_client import AIAgentClient

def ts(seconds):
    ms=max(0,int(round(seconds*1000))); h,rem=divmod(ms,3600000); m,rem=divmod(rem,60000); s,ms=divmod(rem,1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def run(cmd): return subprocess.run(cmd,check=True,text=True,capture_output=True)

def has_audio(path):
    return bool(run(["ffprobe","-v","error","-select_streams","a:0","-show_entries","stream=index","-of","csv=p=0",path]).stdout.strip())

def safe_title(original, translated):
    return translated.strip()[:200] if translated.strip() else original+" | Tiếng Việt"

def main():
    p=argparse.ArgumentParser()
    for x in ("input","output","srt","metadata","title"): p.add_argument("--"+x,required=True)
    a=p.parse_args(); meta={"status":"started"}
    try:
        if not has_audio(a.input):
            meta.update(status="no_audio",error="No audio stream found"); Path(a.metadata).write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding="utf-8"); return 3
        whisper=WhisperModel(os.environ.get("WHISPER_MODEL","small"),device="cpu",compute_type="int8")
        seg_iter,info=whisper.transcribe(a.input,vad_filter=True,beam_size=5,condition_on_previous_text=True)
        segments=list(seg_iter); texts=[s.text.strip() for s in segments if s.text.strip()]
        words=sum(len(t.split()) for t in texts)
        meta.update(detected_language=info.language,language_probability=float(info.language_probability or 0),transcript_words=words)
        if words<5:
            meta.update(status="no_speech",error="Audio exists but no usable spoken transcript was detected"); Path(a.metadata).write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding="utf-8"); return 3
        ai=AIAgentClient()
        # One batched request keeps the AI bridge efficient for a full episode.
        numbered="\n".join(f"[{i}] {t}" for i,t in enumerate(texts,1))
        translated=ai.translate("Translate each numbered dialogue line to natural Vietnamese for dubbing. Preserve every [number] and return one translated line per number.\n"+numbered,source_language=info.language)
        lines=[ln.strip() for ln in translated.splitlines() if ln.strip()]
        vi=[]
        for i in range(1,len(texts)+1):
            prefix=f"[{i}]"; match=next((ln[len(prefix):].strip() for ln in lines if ln.startswith(prefix)),None)
            if not match: raise ValueError(f"AI- translation missing segment {i}")
            vi.append(match)
        translated_title=ai.translate(a.title,source_language="auto")
        out=[]; j=0
        for seg in segments:
            if not seg.text.strip(): continue
            wrapped="\n".join(textwrap.wrap(vi[j],width=48)) or vi[j]; j+=1
            out += [str(j),f"{ts(seg.start)} --> {ts(seg.end)}",wrapped,""]
        Path(a.srt).write_text("\n".join(out),encoding="utf-8")
        # Keep original visuals and audio at this stage; AI- dubbing integration follows separately.
        first=subprocess.run(["ffmpeg","-y","-i",a.input,"-map","0:v:0","-map","0:a:0","-c:v","copy","-c:a","copy","-movflags","+faststart",a.output],text=True,capture_output=True)
        if first.returncode:
            second=subprocess.run(["ffmpeg","-y","-i",a.input,"-map","0:v:0","-map","0:a:0","-c:v","copy","-c:a","aac","-b:a","192k","-movflags","+faststart",a.output],text=True,capture_output=True)
            if second.returncode: raise RuntimeError("ffmpeg mux failed: "+second.stderr[-1500:])
        meta.update(status="ok",translated_title=safe_title(a.title,translated_title),subtitle_language="vi",translation_provider="AI-",original_visuals_preserved=True,original_audio_preserved=True,segments=len(vi))
        Path(a.metadata).write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding="utf-8"); return 0
    except Exception as e:
        meta.update(status="failed",error=str(e)); Path(a.metadata).write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding="utf-8"); return 1
if __name__=="__main__": sys.exit(main())
