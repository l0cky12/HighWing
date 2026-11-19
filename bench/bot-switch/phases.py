#!/usr/bin/env python3
"""Splits each traced bot switch (run.sh with TRACE_DIR, in a build with instrument.patch) into its steps.

    python3 bench/bot-switch/phases.py <TRACE_DIR>/*.json

Each column is ms from the click: when the new socket was open, when Hermes sent gateway.ready, when the chat list read
ended (switching cleared), when the Bot Chat lookup (session.list) was sent and answered, when session.resume was sent
and answered, and the probe's bot, chat and ready times. A step that didn't happen is blank.
"""
import json
import statistics
import sys

COLS = ["pipe", "ready", "listed", "lookup>", "lookup<", "resume>", "resume<", "bot", "chat", "done"]


def first(perf, t0, test):
    for t, k in perf:
        if t >= t0 and test(k):
            return round(t - t0)
    return None


def phases(trace):
    bs, perf = trace["bs"], trace["perf"]
    t0 = bs["t0"]
    return {
        "pipe": first(perf, t0, lambda k: k.startswith("pipe ")),
        "ready": first(perf, t0, lambda k: k == "gateway.ready"),
        "listed": first(perf, t0, lambda k: k == "switching null"),
        "lookup>": first(perf, t0, lambda k: k == "rpc> session.list"),
        "lookup<": first(perf, t0, lambda k: k == "rpc< session.list"),
        "resume>": first(perf, t0, lambda k: k == "rpc> session.resume"),
        "resume<": first(perf, t0, lambda k: k == "rpc< session.resume"),
        "bot": bs.get("bot"),
        "chat": bs.get("chat"),
        "done": bs.get("ready"),
    }


rows = []
print("trace\t" + "\t".join(COLS))
for path in sys.argv[1:]:
    with open(path) as f:
        p = phases(json.loads(json.load(f)))
    rows.append(p)
    print(path.rsplit("/", 1)[-1].removesuffix(".json") + "\t" + "\t".join("" if p[c] is None else str(p[c]) for c in COLS))
print("median\t" + "\t".join(str(round(statistics.median(v))) if (v := [r[c] for r in rows if r[c] is not None]) else "" for c in COLS))
