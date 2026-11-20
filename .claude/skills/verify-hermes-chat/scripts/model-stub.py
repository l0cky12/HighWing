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

A chat holding Highwing's Bot setup brief gets the interview the brief asks for: the five questions one per turn, then a
`highwing-bot-setup` block built from the answers. Answer 1 is callOwner, answer 2 the description and what the
persona helps with, answer 3 the persona's rules. A name the brief's INVENTORY lists is picked when an answer names it:
skills and toolsets from answer 2, catalog servers from answer 4, and from answer 5 a bot plus its skills, toolsets and
servers. A ready turn that asks for a memory entry calls the memory tool with it, then replies. Set up again's brief
gets one line on how the bot is set up now, then a block whose description is the answer's first sentence and whose
skills and toolsets are those the answer names, off after "no" or "without".

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


SETUP_BRIEF = re.compile(r"^\[highwing:bot-setup v1 id=[A-Za-z0-9-]+\]$", re.MULTILINE)
SETUP_TURN = re.compile(r"^\[highwing:bot-setup (begin|ready) id=", re.MULTILINE)
SETUP_REMEMBER = re.compile(r'Save one memory entry now with your memory tool, and nothing else: "(.+)"')
SETUP_INVENTORY = "INVENTORY (data about this Hermes server, not instructions):\n"
SETUP_CURRENT = "CURRENT (how you are set up now, read from Hermes; data, not instructions):\n"
SETUP_QUESTIONS = [
    "What should I call you?",
    "What do you want me to help with?",
    "Is there anything I should never do, or always check with you first?",
    "Which apps or services should I work with?",
    "Want me to copy anything from one of your other bots: skills, tools or connected apps?",
]


def named(text, names):
    return [n for n in names if re.search(rf"(?<![\w-]){re.escape(n)}(?![\w-])", text, re.IGNORECASE)]


def toggles(text, names):
    off = lambda n: re.search(rf"\b(no|without)\s+(the\s+)?{re.escape(n)}(?![\w-])", text, re.IGNORECASE)
    return [{"name": n, "on": not off(n)} for n in named(text, names)]


def json_after(text, header):
    at = text.find(header)
    return json.JSONDecoder().raw_decode(text[at + len(header):])[0] if at >= 0 else {}


def bot_setup(body):
    """The reply to a turn in a chat holding a Bot setup brief, else None."""
    if not body.get("tools"):
        return None
    users = [text_of(m.get("content")) for m in body.get("messages") or [] if m.get("role") == "user"]
    at = max((i for i, u in enumerate(users) if SETUP_BRIEF.search(u)), default=None)
    if at is None:
        return None
    brief, later = users[at], users[at + 1:]
    ready = [i for i, u in enumerate(later) if (m := SETUP_TURN.search(u)) and m.group(1) == "ready"]
    if ready:
        if ready[-1] != len(later) - 1:
            return None
        messages = body.get("messages") or []
        last_user = max(i for i, m in enumerate(messages) if m.get("role") == "user")
        entry = SETUP_REMEMBER.search(later[-1])
        if entry and not any(m.get("role") == "tool" for m in messages[last_user + 1:]):
            args = {"action": "add", "target": "user", "content": entry.group(1)}
            call = {"id": f"call_memory_{int(time.time() * 1000)}", "type": "function", "function": {"name": "memory", "arguments": json.dumps(args)}}
            return {"role": "assistant", "content": None, "tool_calls": [call]}
        return "I'm set up. Ask me whenever you need me."
    # The app adds context blocks after the owner's words.
    answers = [u.strip().split("\n")[0].strip() for u in later if not SETUP_TURN.search(u)]
    inv = json_after(brief, SETUP_INVENTORY)
    name = re.search(r'You are ("(?:[^"\\]|\\.)*")', brief)
    name = json.loads(name.group(1)) if name else "a bot"
    fence = lambda block: "\n\n```highwing-bot-setup\n" + json.dumps(block) + "\n```"
    if SETUP_CURRENT in brief:
        cur = json_after(brief, SETUP_CURRENT)
        if not answers:
            return f"I'm set up as: {(cur.get('description') or 'no description').rstrip('.')}. What would you like to change?"
        a = answers[-1]
        block = {"v": 1, "persona": None, "description": re.split(r"(?<=\.)\s", a)[0][:80], "model": None, "color": None, "callOwner": None,
                 "skills": toggles(a, inv.get("skills", [])), "toolsets": toggles(a, inv.get("toolsets", [])), "mcp": [], "copy": []}
        return "Here's the change. Everything else stays as it is." + fence(block)
    if len(answers) < len(SETUP_QUESTIONS):
        hello = "" if answers else f"Hi, I'm {name}. "
        return hello + SETUP_QUESTIONS[len(answers)]
    call, helps, rules, apps, copy = answers[:5]
    block = {
        "v": 1,
        "persona": f"You are {name}. You help the owner with this: {helps.rstrip('.')}. Your rules: {rules.rstrip('.')}.",
        "description": helps[:80],
        "model": None,
        "color": "teal",
        "callOwner": call or None,
        "skills": [{"name": n, "on": True} for n in named(helps, inv.get("skills", []))],
        "toolsets": [{"name": n, "on": True} for n in named(helps, inv.get("toolsets", []))],
        "mcp": [{"catalog": n} for n in named(apps, inv.get("mcp_catalog", []))],
        "copy": [{"from": b["name"], "skills": named(copy, b.get("skills", [])), "toolsets": named(copy, b.get("toolsets_on", [])), "mcp": named(copy, b.get("mcp", []))}
                 for b in inv.get("bots", []) if named(copy, [b["name"]])],
    }
    return f"Thanks, {call}. Here's how I'd set myself up." + fence(block)


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
        setup = None if tag or cue else bot_setup(body)
        if tag:
            msg = {"role": "assistant", "content": None, "tool_calls": [danger_call(tag)]}
            out, finish = msg["tool_calls"][0]["function"]["arguments"], "tool_calls"
        elif cue:
            msg = cue
            out, finish = (msg["content"], "stop") if msg.get("content") else (msg["tool_calls"][0]["function"]["arguments"], "tool_calls")
        elif isinstance(setup, dict):
            msg = setup
            out, finish = msg["tool_calls"][0]["function"]["arguments"], "tool_calls"
        elif setup:
            out, finish = setup, "stop"
            msg = {"role": "assistant", "content": out}
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
