from __future__ import annotations

import os
from pathlib import Path

from flask import Flask, redirect, request
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build

app = Flask(__name__)

SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
CLIENT_ID = os.environ["YOUTUBE_CLIENT_ID"]
CLIENT_SECRET = os.environ["YOUTUBE_CLIENT_SECRET"]
REDIRECT_URI = os.getenv(
    "YOUTUBE_REDIRECT_URI", "http://localhost:8080/oauth2callback"
)
TOKEN_PATH = Path(os.getenv("YOUTUBE_TOKEN_PATH", ".tokens/youtube.json"))


def make_flow() -> Flow:
    client_config = {
        "web": {
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [REDIRECT_URI],
        }
    }
    flow = Flow.from_client_config(client_config, scopes=SCOPES)
    flow.redirect_uri = REDIRECT_URI
    return flow


@app.get("/")
def index():
    return '<a href="/auth">Connect YouTube</a>'


@app.get("/auth")
def auth():
    flow = make_flow()
    authorization_url, _ = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )
    return redirect(authorization_url)


@app.get("/oauth2callback")
def oauth2callback():
    error = request.args.get("error")
    if error:
        return f"OAuth failed: {error}", 400

    code = request.args.get("code")
    if not code:
        return "Missing authorization code", 400

    flow = make_flow()
    flow.fetch_token(code=code)

    TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_PATH.write_text(flow.credentials.to_json(), encoding="utf-8")

    youtube = build("youtube", "v3", credentials=flow.credentials)
    response = youtube.channels().list(part="snippet", mine=True).execute()
    items = response.get("items", [])
    if not items:
        return "OAuth succeeded, but no YouTube channel was returned.", 502

    channel = items[0]
    channel_id = channel["id"]
    title = channel["snippet"]["title"]
    return f"Connected YouTube channel: {title} ({channel_id})"


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8080)
