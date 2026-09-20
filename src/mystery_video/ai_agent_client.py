"""Client for the sibling AI- project's shared HTTP API."""
from __future__ import annotations

import json
import os
from urllib.request import Request, urlopen


class AIAgentClient:
    def __init__(self, base_url: str | None = None, token: str | None = None, timeout: float = 900):
        self.base_url = (base_url or os.environ.get("AI_AGENT_API_URL", "")).rstrip("/")
        self.token = token or os.environ.get("AI_AGENT_API_TOKEN", "")
        self.timeout = timeout
        if not self.base_url:
            raise ValueError("AI_AGENT_API_URL is required")
        if not self.token:
            raise ValueError("AI_AGENT_API_TOKEN is required")

    def translate(self, text: str, source_language: str = "auto", target_language: str = "Vietnamese") -> str:
        payload = json.dumps({
            "text": text,
            "source_language": source_language,
            "target_language": target_language,
        }, ensure_ascii=False).encode("utf-8")
        req = Request(self.base_url + "/v1/translate", data=payload, method="POST", headers={
            "authorization": f"Bearer {self.token}",
            "content-type": "application/json",
            "user-agent": "Hidden-Beyond-Bot/0.1",
        })
        with urlopen(req, timeout=self.timeout) as response:
            data = json.load(response)
        translated = str(data.get("text", "")).strip()
        if not translated:
            raise ValueError("AI- returned empty translation")
        return translated
