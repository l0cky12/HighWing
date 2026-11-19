"""An OpenAI-compatible model for a real Hermes dashboard. It answers every prompt with the same short reply and every
title request with "Stub title". Set STUB_DELAY_S=<seconds> to hold each reply that long, so a session stays working.

A prompt "danger <tag>" makes the folder work/junk-<tag> beside the request log, then calls the terminal tool with
`rm -rf work/junk-<tag>` there. Hermes's approval gate flags that as a recursive delete. The stub answers Smart mode's
judge with ESCALATE, so in Smart and Manual mode Hermes asks the user, and under YOLO the folder is deleted. Once the
tool result is in, the stub replies with text as usual.

A prompt holding `direct:<tool> <json>` calls that tool with those arguments, and `calltool:<name> <json>` calls
`tool_call` for it, the way a model reaches an MCP tool Hermes defers behind `tool_search`. Once the result is in, the
reply is `TOOL RESULT: <the result>`. Each turn's log line also has the user rows, the system prompt and the tool names
the model was given, so a test can read what Hermes showed it.

    python3 model-stub.py <host> <port> <requests.jsonl>
"""
import json
import math
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT, LOG = sys.argv[1], int(sys.argv[2]), sys.argv[3]
WORK_PARENT = os.path.dirname(os.path.abspath(LOG))
DANGER = re.compile(r"\s*danger\s+([A-Za-z0-9_-]+)\b", re.IGNORECASE)
CALL = re.compile(r"(direct|calltool):(\S+) (\{.*\})")


def delay_from_env():
    raw = os.environ.get("STUB_DELAY_S") or "0"
    try:
        seconds = float(raw)
    except ValueError:
        seconds = math.nan
    if not math.isfinite(seconds) or seconds < 0:
        sys.exit(f"model-stub: STUB_DELAY_S must be a finite number of seconds, 0 or more, not {raw!r}")
    return seconds


DELAY_S = delay_from_env()


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def kind_of(body):
    """'title' or 'judge' for Hermes's side requests (they carry no tools), else 'turn'."""
    if body.get("tools"):
        return "turn"
    system = text_of((body.get("messages") or [{}])[0].get("content")).lower()
    if "security reviewer" in system and "escalate" in system:
        return "judge"
    return "title" if "title" in system else "turn"


def danger_tag(body):
    """The tag of a "danger <tag>" prompt the stub hasn't acted on yet in this turn, else None."""
    if not body.get("tools"):
        return None
    messages = body.get("messages") or []
    last_user = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=None)
    if last_user is None or any(m.get("role") == "tool" for m in messages[last_user + 1:]):
        return None
    match = DANGER.match(text_of(messages[last_user].get("content")))
    return match.group(1) if match else None


def tool_cue(body):
    """For a `direct:` or `calltool:` prompt: the tool call to make, or once its result is in, the reply. Else None."""
    if not body.get("tools"):
        return None
    messages = body.get("messages") or []
    last_user = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=None)
    match = CALL.search(text_of(messages[last_user].get("content"))) if last_user is not None else None
    if not match:
        return None
    results = [text_of(m.get("content")) for m in messages[last_user + 1:] if m.get("role") == "tool"]
    if results:
        return {"role": "assistant", "content": "TOOL RESULT: " + results[-1][:600]}
    kind, name, args = match.group(1), match.group(2), json.loads(match.group(3))
    if kind == "calltool":
        name, args = "tool_call", {"calls": [{"name": name, "arguments": args}]}
    call = {"id": f"call_{int(time.time() * 1000)}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}
    return {"role": "assistant", "content": None, "tool_calls": [call]}


def danger_call(tag):
    os.makedirs(os.path.join(WORK_PARENT, "work", f"junk-{tag}"), exist_ok=True)
    args = {"command": f"rm -rf work/junk-{tag}", "workdir": WORK_PARENT}
    return {"id": f"call_danger_{tag}", "type": "function", "function": {"name": "terminal", "arguments": json.dumps(args)}}


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
        kind = kind_of(body)
        tag = danger_tag(body)
        cue = tool_cue(body)
        if tag:
            msg = {"role": "assistant", "content": None, "tool_calls": [danger_call(tag)]}
            out, finish = msg["tool_calls"][0]["function"]["arguments"], "tool_calls"
        elif cue:
            msg = cue
            out, finish = (msg["content"], "stop") if msg.get("content") else (msg["tool_calls"][0]["function"]["arguments"], "tool_calls")
        else:
            out = {"title": "Stub title", "judge": "ESCALATE"}.get(kind, "Stub reply. I read the message and have nothing to add.")
            msg, finish = {"role": "assistant", "content": out}, "stop"
        with open(LOG, "a") as f:
            line = {"t": time.time(), "kind": kind, "last": text_of((body.get("messages") or [{}])[-1].get("content"))[:400], "answer": out}
            if kind == "turn":
                messages = body.get("messages") or []
                line["users"] = [text_of(m.get("content")) for m in messages if m.get("role") == "user"]
                line["system"] = "\n".join(text_of(m.get("content")) for m in messages if m.get("role") == "system")
                line["tools"] = [t.get("function", {}).get("name") for t in body.get("tools") or []]
            f.write(json.dumps(line) + "\n")
        if DELAY_S and kind == "turn":
            time.sleep(DELAY_S)
        usage = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
        if not body.get("stream"):
            return self._json(200, {"id": "x", "object": "chat.completion", "model": "stub-model", "choices": [{"index": 0, "message": msg, "finish_reason": finish}], "usage": usage})
        if msg.get("tool_calls"):
            msg = {**msg, "tool_calls": [{**c, "index": i} for i, c in enumerate(msg["tool_calls"])]}
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        base = {"id": "x", "object": "chat.completion.chunk", "model": "stub-model"}
        for chunk in ({**base, "choices": [{"index": 0, "delta": msg, "finish_reason": None}]}, {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}], "usage": usage}):
            self.wfile.write(b"data: " + json.dumps(chunk).encode() + b"\n\n")
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def log_message(self, *a):
        pass


ThreadingHTTPServer((HOST, PORT), H).serve_forever()
