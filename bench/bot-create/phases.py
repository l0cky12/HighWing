#!/usr/bin/env python3
"""Splits each traced run (run.sh with TRACE_DIR, on a build with instrument.patch) into the steps between the Create
bot click and the bot being ready, in ms, and prints one row per run and the medians.

    python3 bench/bot-create/phases.py <TRACE_DIR>/*.json
"""
import json
import statistics
import sys

COLUMNS = ["post", "roster", "click", "reconnect", "chatlist", "session_list", "create", "title", "resume", "ready"]


def phases(path):
    trace = json.loads(json.loads(open(path).read()))
    bp, perf = trace["bp"], trace["perf"]
    if not bp.get("ready") or not perf:
        return None
    t0 = [t for t, k in perf if k == "createOnce"][-1]
    events = [(t - t0, k) for t, k in perf if t >= t0]

    def first(key, after=-1):
        return next((t for t, k in events if t > after and k == key), None)

    post = first("rest< POST api/profiles")
    roster = first("rpc< profiles.list", post)
    opened = first(f"openBot {bp['name']}")
    dialing = first("reconnect>", opened)
    connected = first("status connected", dialing)
    listed = first("switching null", connected)
    found = first("rpc< session.list", listed) or listed
    made = first("rpc< session.create", listed)
    titled = first("rpc< session.title", listed)
    resumed = first("rpc< session.resume", titled)
    return bp["name"], {
        "post": post, "roster": roster - post, "click": opened - roster, "reconnect": connected - dialing,
        "chatlist": listed - connected, "session_list": found - listed, "create": made - found, "title": titled - made,
        "resume": resumed - titled, "ready": bp["ready"],
    }


rows = [r for r in map(phases, sys.argv[1:]) if r]
print("\t".join(["run"] + COLUMNS))
for name, r in rows:
    print("\t".join([name] + [str(r[c]) for c in COLUMNS]))
print("\t".join(["median"] + [str(round(statistics.median(r[c] for _, r in rows))) for c in COLUMNS]))
