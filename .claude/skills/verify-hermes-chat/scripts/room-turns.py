"""Which bots a real Hermes gave a turn for one owner message in a Group room, read from Hermes's own records.

    python3 -I room-turns.py <shared-state.db> <owner text> [--expect ada,bram] [--wait <seconds>]

Two independent records name the bots. `hosted_room_driver_tasks` is the queue Hermes's room driver ran turns from (its turn_id starts d<seq>.),
and `hosted_room_events` is the room's log (`message.member` replies, `turn.*` outcomes). Both are filtered to the
discussion that the owner's `message.user` event started. With --expect, it exits 1 unless the bots Hermes queued a
turn for, the bots with a turn outcome, and the bots that replied all equal the expected set, and the discussion has
settled. --wait polls until the discussion settles or the time runs out.
"""
import json
import sqlite3
import sys
import time

TURN_KINDS = ("turn.settled", "turn.failed", "turn.cancelled", "turn.deferred")


def read(db, text):
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            "SELECT room_id, seq, event_id, payload_json FROM hosted_room_events WHERE kind='message.user' ORDER BY created_at DESC"
        ).fetchall()
        owner = next((r for r in rows if json.loads(r[3]).get("text") == text), None)
        if owner is None:
            return None
        room, seq, discussion = owner[0], owner[1], owner[2]
        events = [(k, json.loads(p)) for k, p in conn.execute(
            "SELECT kind, payload_json FROM hosted_room_events WHERE room_id=? AND seq>? ORDER BY seq", (room, seq))]
        tasks = [(t, json.loads(p)) for t, p in conn.execute(
            "SELECT turn_id, payload_json FROM hosted_room_driver_tasks WHERE room_id=? ORDER BY source_event_seq, created_at, task_id", (room,))]
    finally:
        conn.close()
    mine = [(k, p) for k, p in events if p.get("discussion_event_id") == discussion]
    # Hermes names a task's turn d<discussion seq>.r<round>... (gateway/hosted_room_discussion.py, _make_task_plan).
    queued = [p for t, p in tasks if t.startswith(f"d{seq}.")]
    activity = [p.get("status") for k, p in mine if k == "room.activity"]
    return {
        "room": room,
        "owner_seq": seq,
        "discussion": discussion,
        "queued": sorted({t.get("target_member_id") for t in queued}),
        "turn_outcomes": sorted({p.get("member_id") for k, p in mine if k in TURN_KINDS}),
        "replied": sorted({p.get("member_id") for k, p in mine if k == "message.member"}),
        "round0_replied": sorted({p.get("member_id") for k, p in mine if k == "message.member" and p.get("round_index") == 0}),
        "settled": any(s in ("settled", "bounded") for s in activity),
        "cancelled": sorted({p.get("member_id") for k, p in mine if k == "turn.cancelled"}),
    }


def main(argv):
    db, text = argv[1], argv[2]
    expect = wait = None
    rest = argv[3:]
    while rest:
        flag, value, rest = rest[0], rest[1], rest[2:]
        if flag == "--expect":
            expect = sorted(value.split(","))
        elif flag == "--wait":
            wait = float(value)
        else:
            sys.exit(f"room-turns: unknown option {flag}")
    deadline = time.time() + (wait or 0)
    while True:
        found = read(db, text)
        if found and found["settled"] or time.time() >= deadline:
            break
        time.sleep(0.5)
    print(json.dumps(found, indent=1))
    if found is None:
        sys.exit(f"room-turns: no owner message with text {text!r}")
    if expect is None:
        return
    problems = [f"{k} {found[k]} != expected {expect}" for k in ("queued", "turn_outcomes", "replied") if found[k] != expect]
    if not found["settled"]:
        problems.append("the discussion has not settled")
    if found["cancelled"]:
        problems.append(f"turns were cancelled: {found['cancelled']}")
    if problems:
        sys.exit("room-turns: FAIL: " + "; ".join(problems))
    print(f"room-turns: ok: only {','.join(expect)} took a turn")


main(sys.argv)
