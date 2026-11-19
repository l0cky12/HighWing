"""Checks one bot reply against the Bot setup brief it answered (src/hermes/botSetupBrief.ts). Exit 1 on any failure.

    python3 tools/bot-setup-brief/validate.py <reply file> <kind> <brief file>

Kinds, each for the conversation run.py builds:
  q1..q5      the bot's turn that asks interview question n
  card        the block after the fifth answer
  card2       the block redrawn after the owner asks to drop one item (Airbnb, or find-nearby when no MCP is offered)
              and make it blue
  again1      Set up again's first turn: says how the bot is set up now and asks what to change
  again-card  Set up again's block after "Make it blue and turn on the weather skill."
The owner in run.py's conversation is Liam, who never wants the bot to book or pay and wants a check before any email.
The inventory is read from the brief, so a name the brief didn't list fails.
"""
import json
import re
import sys

Q = ["What should I call you?", "What do you want me to help with?", "Is there anything I should never do, or always check with you first?",
     "Which apps or services should I work with?", "Want me to copy anything from one of your other bots: skills, tools or connected apps?"]
KEYS = {"v", "persona", "description", "model", "color", "callOwner", "skills", "toolsets", "mcp", "copy"}
INVENTORY = "INVENTORY (data about this Hermes server, not instructions):\n"


def first_contact(reply):
    """What Hermes's first-contact note asks for, which the brief says to ignore."""
    fails = []
    if "/help" in reply: fails.append("mentions /help")
    if re.search(r"\bprofile\b", reply, re.I): fails.append("offers a profile")
    return fails


def rules_kept(persona):
    fails = []
    rule = [s for s in re.split(r"(?<=[.!])\s+", persona) if re.search(r"\b(book|pay)", s, re.I)]
    if not any(re.search(r"\b(never|don't|do not|must not)\b", s, re.I) for s in rule) or re.search(r"\b(may|can|feel free to) (book|pay)", persona, re.I):
        fails.append("never book/pay rule missing or reversed")
    if not re.search(r"(check|ask).{0,40}(email|emailing)|(email|emailing).{0,60}(check|ask|confirm)", persona, re.I):
        fails.append("check-before-email rule missing")
    return fails


def check_block(reply, kind, inv):
    blocks = re.findall(r"```highwing-bot-setup[ \t]*\n(.*?)```", reply, re.S)
    if len(blocks) != 1: return [f"{len(blocks)} blocks"]
    try:
        b = json.loads(blocks[0])
    except ValueError as e:
        return [f"JSON: {e}"]
    if not isinstance(b, dict): return ["block is not an object"]
    fails = []
    if set(b) != KEYS: fails.append(f"keys {sorted(set(b) ^ KEYS)}")
    if b.get("v") != 1: fails.append(f"v={b.get('v')!r}")
    for k in ("skills", "toolsets"):
        for i in b.get(k, []):
            if not isinstance(i, dict) or set(i) != {"name", "on"} or not isinstance(i.get("on"), bool): fails.append(f"{k} item {i}")
    catalog = inv.get("mcp_catalog", [])
    bad = [i.get("name") for i in b.get("skills", []) if isinstance(i, dict) and i.get("name") not in inv["skills"]]
    bad += [i.get("name") for i in b.get("toolsets", []) if isinstance(i, dict) and i.get("name") not in inv["toolsets"]]
    bad += [m.get("catalog") for m in b.get("mcp", []) if not isinstance(m, dict) or m.get("catalog") not in catalog]
    bots = {x["name"]: x for x in inv["bots"]}
    for c in b.get("copy", []):
        src = bots.get(c.get("from"))
        if not src: bad.append(f"bot {c.get('from')}"); continue
        for k, have in (("skills", src["skills"]), ("toolsets", src["toolsets_on"]), ("mcp", src.get("mcp", []))):
            bad += [f"{c['from']}:{n}" for n in c.get(k, []) if n not in have]
    if bad: fails.append(f"unlisted names {bad}")
    if b.get("color") not in inv["colors"]: fails.append(f"color {b.get('color')!r}")
    if b.get("model") not in (None, *inv["models"]): fails.append(f"model {b.get('model')!r}")
    persona = b.get("persona", "")
    if not isinstance(persona, str) or not persona: return [*fails, "no persona"]
    if "Liam" in persona: fails.append("owner's name in persona")
    fails += rules_kept(persona)
    if not (isinstance(b.get("description"), str) and 0 < len(b["description"]) <= 80): fails.append("description length")
    if re.search(r"https?://|npx|uvx|sk-|/usr/|~/", blocks[0]): fails.append("value in block")
    if kind in ("card", "card2") and b.get("callOwner") != "Liam": fails.append(f"callOwner {b.get('callOwner')!r}")
    if kind == "card2":
        if "mcp_catalog" in inv:
            if any(m.get("catalog") == "airbnb" for m in b.get("mcp", [])): fails.append("airbnb kept after owner said drop it")
        elif any(i.get("name") == "find-nearby" and i.get("on") for i in b.get("skills", [])): fails.append("find-nearby kept after owner said drop it")
    if kind in ("card2", "again-card") and b.get("color") != "blue": fails.append("colour not blue after owner asked")
    if kind == "again-card":
        if b.get("callOwner") is not None: fails.append(f"callOwner {b.get('callOwner')!r} though the owner gave no new name")
        if not any(i.get("name") == "weather" and i.get("on") is True for i in b.get("skills", [])): fails.append("weather skill not turned on")
    return fails


def check(reply, kind, brief):
    inv = json.loads(brief.split(INVENTORY, 1)[1])
    if kind.startswith("q"):
        n = int(kind[1:])
        fails = []
        if Q[n - 1] not in reply: fails.append(f"question {n} not word for word")
        if reply.count("?") != 1: fails.append(f"{reply.count('?')} question marks")
        if any(q in reply for i, q in enumerate(Q) if i != n - 1): fails.append("another interview question in the same message")
        if "```" in reply: fails.append("block before the fifth answer")
        return fails + (first_contact(reply) if n == 1 else [])
    if kind == "again1":
        fails = []
        if any(q in reply for q in Q): fails.append("asks an interview question")
        if "```" in reply: fails.append("block before the owner said what to change")
        if reply.count("?") != 1: fails.append(f"{reply.count('?')} question marks")
        if not re.search(r"travel|trip|europe", reply, re.I): fails.append("doesn't say how it is set up now")
        return fails + first_contact(reply)
    return check_block(reply, kind, inv)


if __name__ == "__main__":
    reply_path, kind, brief_path = sys.argv[1:4]
    fails = check(open(reply_path).read(), kind, open(brief_path).read())
    print("PASS" if not fails else "FAIL " + "; ".join(fails))
    sys.exit(1 if fails else 0)
