#!/usr/bin/env python3
"""Discover episodes from the five approved Hidden Beyond donghua sources.

This collector is deliberately idempotent: source_id + source_video_id is the
checkpoint. It never re-inserts an episode already known to the database.
Discovery and processing are separate; the processor owns downstream state.
"""
from __future__ import annotations
import re, subprocess, sys
from mystery_video.db import get_client

SOURCE_IDS=(19,20,21,22,23)

def entries(url: str):
    cmd=["yt-dlp","--flat-playlist","--dump-single-json","--playlist-end","200",url]
    import json
    p=subprocess.run(cmd,text=True,capture_output=True)
    if p.returncode: raise RuntimeError(p.stderr[-1200:])
    data=json.loads(p.stdout)
    return data.get("entries") or []

def episode_key(item):
    title=str(item.get("title") or "")
    nums=re.findall(r"(?:ep(?:isode)?|集|第)\s*0*(\d+)",title,re.I)
    return (int(nums[-1]) if nums else 10**9, str(item.get("upload_date") or ""), title)

def main():
    db=get_client()
    sources=(db.table("sources").select("id,name,url,active").in_("id",list(SOURCE_IDS)).execute().data or [])
    by_id={int(s["id"]):s for s in sources if s.get("active")}
    total=0
    for sid in SOURCE_IDS:
        s=by_id.get(sid)
        if not s:
            print(f"source={sid} skipped=inactive_or_missing"); continue
        found=sorted(entries(s["url"]),key=episode_key)
        rows=[]
        for x in found:
            vid=str(x.get("id") or "").strip()
            u=str(x.get("url") or "").strip()
            if vid and not u.startswith("http"): u=f"https://www.youtube.com/watch?v={vid}"
            if not vid or not u: continue
            rows.append({"source_id":sid,"source_video_id":vid,"source_url":u,
                         "title":x.get("title"),"status":"discovered",
                         "rights_verified":False,"original_audio_verified":False})
        if rows:
            db.table("videos").upsert(rows,on_conflict="source_id,source_video_id",ignore_duplicates=True).execute()
        total+=len(rows)
        print(f"source={sid} discovered={len(rows)} checkpoint=source_id+source_video_id")
    print(f"COLLECTOR_OK discovered={total} sources={len(SOURCE_IDS)}")
if __name__=="__main__": main()
