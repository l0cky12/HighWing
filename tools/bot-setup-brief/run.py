"""Runs the Bot setup brief against the owner's model and scores every reply with validate.py.

    python3 tools/bot-setup-brief/run.py <out dir> [--model gpt-6.1-sol] [--effort high] [--jobs 4] [--controls-only]
                                         [--briefs again,again-kept]

The briefs come from src/hermes/botSetupBrief.ts through write-briefs.mjs, so this tests the text the app sends. First
it checks the validator: the good-*.txt replies in controls/ must pass, and every other reply there must fail, as must
each mutant, a good reply with one thing changed (a wrong type, a reversed rule, a kept field overwritten). A validator
that gets one of them wrong proves nothing, and the run stops there. Then, for the brief with MCP servers (new-mcp) and
without (new), it runs 8 single turns (first message, question 3, card, redraw after a change; two of each) and one
whole interview where each bot turn is the model's own reply to the conversation so far. Then Hermes's first-contact
note is appended to the brief, as Hermes does on a profile's first turn, for the first message and for Set up again
(again1, again-card). Last, Set up again on a bot whose persona is too long for the brief, whose description is longer
than a block's and whose colour isn't listed (keep: again1, again-keep), where the block must keep all three. The model
runs through `codex exec`, read-only and in an empty folder; stdin is closed, or codex waits on it. Replies, prompts and
logs land in <out dir>, and the last lines print the score per group. --briefs runs only the turns sent one of the named
briefs (new-mcp, new, again, again-kept), for a change to one brief's wording.
"""
import argparse
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True
from validate import check

ANSWERS = ["Liam", "Plan trips: trains and flights in Europe, hotels, day plans and packing lists.",
           "Never book or pay for anything. Always check with me before you email anyone.",
           "Google Maps, Gmail and Airbnb.", "Yes, the deep-research skill and the Brave search server from Research Assistant."]
ASKED = ["Hi, I'm Travel Buddy. What should I call you?", "What do you want me to help with?",
         "Is there anything I should never do, or always check with you first?", "Which apps or services should I work with?",
         "Want me to copy anything from one of your other bots: skills, tools or connected apps?"]


def card(mcp, copied, change):
    """The block the redraw turn starts from, and the owner's change to it."""
    block = {"v": 1, "persona": "You are Travel Buddy...", "description": "Plans European trips.", "model": None, "color": "teal", "callOwner": "Liam",
             "skills": [{"name": "find-nearby", "on": True}], "toolsets": [{"name": "web", "on": True}], "mcp": mcp,
             "copy": [{"from": "Research Assistant", "skills": ["deep-research"], "toolsets": [], "mcp": copied}]}
    return json.dumps(block, separators=(",", ":")), change


CARD = {"new-mcp": card([{"catalog": "airbnb"}, {"catalog": "google-maps"}], ["brave-search"], "Drop the Airbnb one and make the colour blue."),
        "new": card([], [], "Drop find-nearby and make the colour blue.")}
AGAIN_FIRST = ("I'm set up as a European trip planner for trains, flights, hotels, day plans and packing lists, in teal, with web search "
               "and the find-nearby and deep-research skills. I never book or pay, and I check with you before emailing anyone. "
               "What would you like to change?")
AGAIN_ANSWER = "Make it blue and turn on the weather skill."
KEPT_FIRST = ("I'm set up to plan European trips, stays, day plans and packing lists, in my own custom colour, with web search and the "
              "find-nearby and deep-research skills. What would you like to change?")
KEPT_ANSWER = "Turn on the weather skill."
CONTROLS = [("two-questions.txt", "q1", "new-mcp"), ("bad-card.txt", "card", "new-mcp"), ("help-intro.txt", "q1", "new"),
            ("again-interview.txt", "again1", "again"), ("mcp-without-catalog.txt", "card", "new")]
GOOD = {"good-card.txt": ("card", "new-mcp"), "good-again-keep.txt": ("again-keep", "again-kept")}


def persona(text):
    return lambda b: b.update(persona=text)


EMAIL = " Always check with the owner before emailing anyone."
# (name, good reply it changes, the change, whether the validator must pass it)
MUTANTS = [
    ("array fields as objects", "good-card.txt", lambda b: b.update(skills={}, toolsets={}, mcp={}, copy={}), False),
    ("mcp item with a command and a key", "good-card.txt",
     lambda b: b.update(mcp=[{"catalog": "airbnb", "command": "rm -rf .", "env": {"TOKEN": "my_private_token"}}]), False),
    ("copy item missing a list", "good-card.txt", lambda b: b["copy"][0].pop("toolsets"), False),
    ("v true", "good-card.txt", lambda b: b.update(v=True), False),
    ("callOwner a number", "good-card.txt", lambda b: b.update(callOwner=1), False),
    ("booking allowed", "good-card.txt", persona("You are Travel Buddy. You may book trains and hotels. Never pay for anything." + EMAIL), False),
    ("paying allowed", "good-card.txt", persona("You are Travel Buddy. Never book train tickets. Pay without permission." + EMAIL), False),
    ("booking allowed with an ask", "good-card.txt", persona("You are Travel Buddy. Never pay for anything. Never book without asking." + EMAIL), False),
    ("email check reversed", "good-card.txt", persona("You are Travel Buddy. Never book or pay for anything. Never ask before emailing anyone."), False),
    ("email check waived", "good-card.txt", persona("You are Travel Buddy. Never book or pay for anything. You don't need to check before emailing anyone."), False),
    ("all three reversed", "good-card.txt", persona("Never book train tickets. Pay without permission. Never ask before emailing anyone."), False),
    ("rules said another way", "good-card.txt",
     persona("You are Travel Buddy. Do not make bookings or payments of any kind. Never email anyone without checking with the owner first."), True),
    ("persona written though the brief left it out", "good-again-keep.txt", persona("You are Travel Buddy. Never book or pay for anything." + EMAIL), False),
    ("colour changed though the owner didn't ask", "good-again-keep.txt", lambda b: b.update(color="teal"), False),
    ("colour null on a new bot", "good-card.txt", lambda b: b.update(color=None), False),
    ("description rewritten though the owner didn't ask", "good-again-keep.txt", lambda b: b.update(description="Plans European trips."), False),
    ("description null on a new bot", "good-card.txt", lambda b: b.update(description=None), False),
    ("persona null on a new bot", "good-card.txt", lambda b: b.update(persona=None), False),
]


def mutant(reply, change):
    """The reply with its block replaced by the block after `change`."""
    head, rest = reply.split("```highwing-bot-setup", 1)
    body, tail = rest.split("```", 1)
    block = json.loads(body)
    change(block)
    return f"{head}```highwing-bot-setup\n{json.dumps(block)}\n```{tail}"


def control_results(briefs):
    """Each control as (label, failures, whether it must pass)."""
    rows = [(f"{f} ({kind}, {b})", check((HERE / "controls" / f).read_text(), kind, briefs[b]), False) for f, kind, b in CONTROLS]
    rows += [(f"{f} ({kind}, {b})", check((HERE / "controls" / f).read_text(), kind, briefs[b]), True) for f, (kind, b) in GOOD.items()]
    for name, base, change, ok in MUTANTS:
        kind, b = GOOD[base]
        rows.append((f"{base} with {name}", check(mutant((HERE / "controls" / base).read_text(), change), kind, briefs[b]), ok))
    return rows
HEAD = ("You are the chat bot in the conversation below, inside a chat app. Output only the bot's next message, exactly as it would appear in the chat, "
        "and nothing else. Don't run commands or read files.\n\nCONVERSATION\n[user message, hidden by the app]\n")


def convo(brief, turns, extra=""):
    """The prompt: the hidden brief, then (bot, owner) turns, then the bot's turn to answer."""
    s = HEAD + brief + "\n"
    for bot, owner in turns:
        s += f"[bot]\n{bot}\n[owner]\n{owner}\n"
    return s + extra + "[bot]\n"


def model_reply(prompt, out, name, args):
    (out / f"p-{name}.txt").write_text(prompt)
    reply = out / f"r-{name}.txt"
    with open(out / f"log-{name}.txt", "w") as log:
        subprocess.run(["codex", "exec", "-s", "read-only", "-m", args.model, "-c", f'model_reasoning_effort="{args.effort}"', "--ephemeral",
                        "--skip-git-repo-check", "-C", str(args.empty), "-o", str(reply), prompt],
                       stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, timeout=900, check=False)
    return reply.read_text().strip() if reply.exists() else ""


def single(job, briefs, out, args):
    group, name, brief, kind, prompt = job
    reply = model_reply(prompt, out, name, args)
    return [(group, name, kind, check(reply, kind, briefs[brief]) if reply else ["no reply"])]


def chain(group, brief, briefs, out, args):
    """One whole interview: each bot turn is the model's own reply to the conversation so far."""
    said, results = [], []
    for n in range(1, 7):
        kind = f"q{n}" if n <= 5 else "card"
        reply = model_reply(convo(briefs[brief], list(zip(said, ANSWERS))), out, f"{group}-chain-{n}", args)
        results.append((group, f"{group}-chain-{n}", kind, check(reply, kind, briefs[brief]) if reply else ["no reply"]))
        said.append(reply)
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--model", default="gpt-6.1-sol")
    ap.add_argument("--effort", default="high")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--controls-only", action="store_true")
    ap.add_argument("--briefs", type=lambda s: set(s.split(",")), default={"new-mcp", "new", "again", "again-kept"})
    args = ap.parse_args()
    out = Path(args.out).resolve()
    args.empty = out / "empty"
    args.empty.mkdir(parents=True, exist_ok=True)
    subprocess.run(["node", str(HERE / "write-briefs.mjs"), str(out / "briefs")], check=True)
    briefs = {b: (out / "briefs" / f"{b}.txt").read_text() for b in ("new-mcp", "new", "again", "again-kept")}
    note = (HERE / "first-contact-note.txt").read_text()

    wrong = []
    for label, fails, ok in control_results(briefs):
        print(f"control {label}: {'PASS' if not fails else 'FAIL ' + '; '.join(fails)}{'' if (not fails) == ok else '  <- WRONG'}")
        if (not fails) != ok: wrong.append(label)
    if wrong:
        sys.exit(f"validator got controls wrong: {wrong}; fix it before trusting a run")
    if args.controls_only:
        return

    jobs = []
    for b in ("new-mcp", "new"):
        asked = list(zip(ASKED, ANSWERS))
        card, change = CARD[b]
        for i in (1, 2):
            jobs.append((b, f"{b}-q1-{i}", b, "q1", convo(briefs[b], [])))
            jobs.append((b, f"{b}-q3-{i}", b, "q3", convo(briefs[b], asked[:2])))
            jobs.append((b, f"{b}-card-{i}", b, "card", convo(briefs[b], asked)))
            jobs.append((b, f"{b}-card2-{i}", b, "card2", convo(briefs[b], asked, f"[bot]\nHere's my setup.\n```highwing-bot-setup\n{card}\n```\n[owner]\n{change}\n")))
    for i in (1, 2):
        jobs.append(("note", f"note-q1-{i}", "new", "q1", convo(briefs["new"] + note, [])))
        jobs.append(("note", f"note-again1-{i}", "again", "again1", convo(briefs["again"] + note, [])))
        jobs.append(("note", f"note-again-card-{i}", "again", "again-card", convo(briefs["again"] + note, [(AGAIN_FIRST, AGAIN_ANSWER)])))
        jobs.append(("keep", f"keep-again1-{i}", "again-kept", "again1", convo(briefs["again-kept"], [])))
        jobs.append(("keep", f"keep-card-{i}", "again-kept", "again-keep", convo(briefs["again-kept"], [(KEPT_FIRST, KEPT_ANSWER)])))

    with ThreadPoolExecutor(args.jobs) as pool:
        futures = [pool.submit(chain, f"{b}", b, briefs, out, args) for b in ("new-mcp", "new") if b in args.briefs]
        futures += [pool.submit(single, j, briefs, out, args) for j in jobs if j[2] in args.briefs]
        results = [r for f in futures for r in f.result()]

    results.sort(key=lambda r: r[1])
    with open(out / "results.tsv", "w") as f:
        for group, name, kind, fails in results:
            line = f"{group}\t{name}\t{kind}\t{'PASS' if not fails else 'FAIL ' + '; '.join(fails)}"
            f.write(line + "\n")
            print(line)
    for group in ("new-mcp", "new", "note", "keep"):
        rs = [r for r in results if r[0] == group]
        if rs: print(f"{group}: {sum(not r[3] for r in rs)}/{len(rs)}")
    sys.exit(0 if all(not r[3] for r in results) else 1)


if __name__ == "__main__":
    os.environ.setdefault("NO_COLOR", "1")
    main()
