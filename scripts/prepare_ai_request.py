#!/usr/bin/env python3
import argparse,json,os,sys,uuid
from pathlib import Path
from faster_whisper import WhisperModel

def main():
 p=argparse.ArgumentParser()
 p.add_argument("--input",required=True);p.add_argument("--output",required=True);p.add_argument("--title",required=True);p.add_argument("--video-id",required=True)
 a=p.parse_args()
 m=WhisperModel(os.environ.get("WHISPER_MODEL","small"),device="cpu",compute_type="int8")
 it,info=m.transcribe(a.input,vad_filter=True,beam_size=5,condition_on_previous_text=True)
 seg=[{"index":i,"start":x.start,"end":x.end,"text":x.text.strip()} for i,x in enumerate(it,1) if x.text.strip()]
 if sum(len(x["text"].split()) for x in seg)<5: return 3
 req={"request_id":str(uuid.uuid4()),"video_id":a.video_id,"title":a.title,"detected_language":info.language,"segments":seg}
 Path(a.output).write_text(json.dumps(req,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
 print(json.dumps({"status":"ai_request_ready","segments":len(seg),"language":info.language}))
 return 0
if __name__=="__main__":sys.exit(main())
