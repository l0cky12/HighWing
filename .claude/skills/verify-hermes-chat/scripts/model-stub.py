"""An OpenAI-compatible model for a real Hermes dashboard. It answers every prompt with the same short reply and every
title request with "Stub title". Set STUB_DELAY_S=<seconds> to hold each reply that long, so a session stays working.

    python3 model-stub.py <host> <port> <requests.jsonl>
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT, LOG = sys.argv[1], int(sys.argv[2]), sys.argv[3]
DELAY_S = float(os.environ.get("STUB_DELAY_S") or 0)


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def is_title_request(body):
    system = text_of((body.get("messages") or [{}])[0].get("content"))
    return "title" in system.lower() and not body.get("tools")


class H(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._json(200, {"object": "list", "data": [{"id": "stub-model", "object": "model", "owned_by": "stub"}]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        title = is_title_request(body)
        out = "Stub title" if title else "Stub reply. I read the message and have nothing to add."
        with open(LOG, "a") as f:
            f.write(json.dumps({"t": time.time(), "title": title, "last": text_of((body.get("messages") or [{}])[-1].get("content"))[:400], "answer": out}) + "\n")
        if DELAY_S and not title:
            time.sleep(DELAY_S)
        usage = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
        msg = {"role": "assistant", "content": out}
        if not body.get("stream"):
            return self._json(200, {"id": "x", "object": "chat.completion", "model": "stub-model", "choices": [{"index": 0, "message": msg, "finish_reason": "stop"}], "usage": usage})
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        base = {"id": "x", "object": "chat.completion.chunk", "model": "stub-model"}
        for chunk in ({**base, "choices": [{"index": 0, "delta": msg, "finish_reason": None}]}, {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": usage}):
            self.wfile.write(b"data: " + json.dumps(chunk).encode() + b"\n\n")
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def log_message(self, *a):
        pass


ThreadingHTTPServer((HOST, PORT), H).serve_forever()
