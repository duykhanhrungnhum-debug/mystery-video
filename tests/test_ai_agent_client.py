import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mystery_video.ai_agent_client import AIAgentClient


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        assert self.headers["authorization"] == "Bearer family"
        length = int(self.headers["content-length"])
        body = json.loads(self.rfile.read(length))
        assert body["text"] == "hello"
        data = json.dumps({"text": "Xin chào"}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *args):
        pass


def test_bot_calls_ai_agent_api():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = AIAgentClient(f"http://127.0.0.1:{server.server_port}", "family")
        assert client.translate("hello") == "Xin chào"
    finally:
        server.shutdown()
        thread.join()
