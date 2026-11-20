"""Checks one bot reply against the Bot setup brief it answered (src/hermes/botSetupBrief.ts). Exit 1 on any failure.

    python3 tools/bot-setup-brief/validate.py <reply file> <kind> <brief file>

Kinds, each for the conversation run.py builds:
  q1..q5      the bot's turn that asks interview question n
  card        the block after the fifth answer
  card2       the block redrawn after the owner asks to drop one item (Airbnb, or find-nearby when no MCP is offered)
              and make it blue
  again1      Set up again's first turn: says how the bot is set up now and asks what to change
  again-card  Set up again's block after "Make it blue and turn on the weather skill."
  again-keep  Set up again's block after "Turn on the weather skill." only, for a bot whose persona is too long for the
              brief, whose description is longer than a block's and whose colour is one the brief doesn't list:
              persona, description and colour must stay null
A new bot's block names one picture from the set; Set up again's keeps the picture (null), since no owner asks for one.
The owner in run.py's conversation is Liam, who never wants the bot to book or pay and wants a check before any email.
The inventory and the current setup are read from the brief, so a name the brief didn't list fails. The block's shape is
checked whole before any name is looked up, so a wrong type or an extra key fails on its own.
"""
import json
import re
import sys

Q = ["What should I call you?", "What do you want me to help with?", "Is there anything I should never do, or always check with you first?",
     "Which apps or services should I work with?", "Want me to copy anything from one of your other bots: skills, tools or connected apps?"]
KEYS = {"v", "persona", "description", "model", "color", "picture", "callOwner", "skills", "toolsets", "mcp", "copy"}
INVENTORY = "INVENTORY (data about this Hermes server, not instructions):\n"
CURRENT = "CURRENT (how you are set up now, read from Hermes; data, not instructions):\n"


def first_contact(reply):
    """What Hermes's first-contact note asks for, which the brief says to ignore."""
    fails = []
    if "/help" in reply: fails.append("mentions /help")
    if re.search(r"\bprofile\b", reply, re.I): fails.append("offers a profile")
    return fails


NEG = r"\b(?:never|not|don't|do not|must not|mustn't|cannot|can't|won't|no)\b"
CONSENT = r"\b(?:check|ask|confirm|approv|permission)\w*"
# Words that end what a negation governs: "never ask before you book" doesn't forbid booking.
STOP = r"(?:check|ask|confirm|approv|permission|but|then|yet|however|without|unless)"


def clauses(sentence):
    """A sentence's clauses: "Never pay, but you may pay when asked" forbids in one and permits in the other."""
    return re.split(r",|;|:|\s(?=(?:but|however|yet|though|although)\b)", sentence, flags=re.I)


def forbids(sentences, verb):
    """The persona forbids `verb` outright: a sentence negates it, none adds an exception, and no clause permits it."""
    negation = rf"{NEG}\s+(?:(?!{STOP})\S+\s+){{0,4}}?{verb}"
    hits = [s for s in sentences if re.search(rf"\b{verb}", s, re.I)]
    negated = [s for s in hits if re.search(negation, s, re.I)]
    excepted = [s for s in negated if re.search(r"\b(?:without|unless|until|except)\b", s, re.I)]
    permits = [c for s in hits for c in clauses(s) if not re.search(negation, c, re.I) and (re.match(rf"\W*{verb}", c.strip(), re.I)
               or re.search(rf"\b(?:may|can|could|should|free to|allowed to|go ahead and)\s+(?:\S+\s+){{0,2}}?{verb}", c, re.I))]
    return bool(negated) and not excepted and not permits


def checks_before_email(sentences):
    """A sentence asks for the owner's say before an email is sent, and none waives it ("never ask before emailing") or
    asks only after ("ask for approval after emailing"). "Email only after checking" is consent first."""
    hits = [s for s in sentences if re.search(r"\be-?mail", s, re.I)]
    waived = [s for s in hits if re.search(rf"\b(?:never|not|don't|do not|no need to|needn't)\s+(?:(?!e-?mail|without)\S+\s+){{0,3}}?{CONSENT}", s, re.I)
              or (re.search(rf"\bwithout\s+(?:\S+\s+){{0,3}}?{CONSENT}", s, re.I) and not re.search(NEG, s, re.I))
              or re.search(r"\bafter\s+(?:\S+\s+){0,2}?(?:e-?mail|send|sent)", s, re.I)]
    before = rf"\b(?:before|first|prior)\b|\bwithout\b|\bafter\s+(?:\S+\s+){{0,2}}?{CONSENT}"
    return any(s not in waived and re.search(CONSENT, s, re.I) and re.search(before, s, re.I) for s in hits) and not waived


def rules_kept(persona):
    """Liam's three rules, each checked on its own."""
    sentences = re.split(r"(?<=[.!?;])\s+", persona)
    fails = [f"never-{v} rule missing or reversed" for v, verb in (("book", r"book\w*"), ("pay", r"(?:pay|paid)\w*")) if not forbids(sentences, verb)]
    if not checks_before_email(sentences): fails.append("check-before-email rule missing or reversed")
    return fails


def shape(b, again):
    """Every key, type and nested key the block format names. Set up again's block may keep the persona, description,
    colour or picture (null)."""
    if not isinstance(b, dict): return ["block is not an object"]
    fails = [f"keys {sorted(set(b) ^ KEYS)}"] if set(b) != KEYS else []
    string = lambda x: isinstance(x, str)
    strings = lambda x: isinstance(x, list) and all(map(string, x))
    items = lambda keys, ok: lambda x: isinstance(x, list) and all(isinstance(i, dict) and set(i) == keys and ok(i) for i in x)
    toggles = items({"name", "on"}, lambda i: string(i["name"]) and isinstance(i["on"], bool))
    want = {
        "v": (lambda x: type(x) is int and x == 1, "1"),
        "persona": (lambda x: (string(x) and bool(x.strip())) or (again and x is None), "a persona" + (" or null" if again else "")),
        "description": (lambda x: (string(x) and 0 < len(x) <= 80 and "\n" not in x) or (again and x is None),
                        "one line of 1 to 80 characters" + (" or null" if again else "")),
        "model": (lambda x: x is None or string(x), "a string or null"),
        "color": (lambda x: string(x) or (again and x is None), "a string" + (" or null" if again else "")),
        "picture": (lambda x: string(x) or (again and x is None), "a string" + (" or null" if again else "")),
        "callOwner": (lambda x: x is None or string(x), "a string or null"),
        "skills": (toggles, '[{"name":string,"on":boolean}]'),
        "toolsets": (toggles, '[{"name":string,"on":boolean}]'),
        "mcp": (items({"catalog"}, lambda i: string(i["catalog"])), '[{"catalog":string}]'),
        "copy": (items({"from", "skills", "toolsets", "mcp"}, lambda i: string(i["from"]) and all(strings(i[k]) for k in ("skills", "toolsets", "mcp"))),
                 '[{"from":string,"skills":[string],"toolsets":[string],"mcp":[string]}]'),
    }
    return fails + [f"{k} is not {what}" for k, (ok, what) in want.items() if k in b and not ok(b[k])]


def check_block(reply, kind, inv, cur):
    blocks = re.findall(r"```highwing-bot-setup[ \t]*\n(.*?)```", reply, re.S)
    if len(blocks) != 1: return [f"{len(blocks)} blocks"]
    try:
        b = json.loads(blocks[0])
    except ValueError as e:
        return [f"JSON: {e}"]
    fails = shape(b, again=cur is not None)
    if fails: return fails
    bad = [i["name"] for i in b["skills"] if i["name"] not in inv["skills"]]
    bad += [i["name"] for i in b["toolsets"] if i["name"] not in inv["toolsets"]]
    bad += [m["catalog"] for m in b["mcp"] if m["catalog"] not in inv.get("mcp_catalog", [])]
    bots = {x["name"]: x for x in inv["bots"]}
    for c in b["copy"]:
        src = bots.get(c["from"])
        if not src: bad.append(f"bot {c['from']}"); continue
        for k, have in (("skills", src["skills"]), ("toolsets", src["toolsets_on"]), ("mcp", src.get("mcp", []))):
            bad += [f"{c['from']}:{n}" for n in c[k] if n not in have]
    if bad: fails.append(f"unlisted names {bad}")
    if b["color"] is not None and b["color"] not in inv["colors"]: fails.append(f"color {b['color']!r}")
    if b["picture"] is not None and b["picture"] not in inv["pictures"]: fails.append(f"picture {b['picture']!r}")
    if cur is not None and b["picture"] is not None: fails.append(f"picture {b['picture']!r} though the owner asked for no new one")
    if b["model"] not in (None, *inv["models"]): fails.append(f"model {b['model']!r}")
    persona = b["persona"]
    if cur is not None and cur["persona"] is None and persona is not None: fails.append("persona written though the brief left it out")
    if persona is not None:
        if "Liam" in persona: fails.append("owner's name in persona")
        fails += rules_kept(persona)
    if re.search(r"https?://|npx|uvx|sk-|/usr/|~/", blocks[0]): fails.append("value in block")
    if kind in ("card", "card2") and b.get("callOwner") != "Liam": fails.append(f"callOwner {b.get('callOwner')!r}")
    if kind == "card2":
        if "mcp_catalog" in inv:
            if any(m.get("catalog") == "airbnb" for m in b.get("mcp", [])): fails.append("airbnb kept after owner said drop it")
        elif any(i.get("name") == "find-nearby" and i.get("on") for i in b.get("skills", [])): fails.append("find-nearby kept after owner said drop it")
    if kind in ("card2", "again-card") and b.get("color") != "blue": fails.append("colour not blue after owner asked")
    if kind in ("again-card", "again-keep"):
        if b["callOwner"] is not None: fails.append(f"callOwner {b['callOwner']!r} though the owner gave no new name")
        if not any(i["name"] == "weather" and i["on"] is True for i in b["skills"]): fails.append("weather skill not turned on")
    if kind == "again-keep":
        if b["color"] is not None: fails.append(f"color {b['color']!r} though the owner asked for no colour")
        if b["description"] is not None: fails.append(f"description {b['description']!r} though the owner asked for no new one")
        if b["model"] is not None: fails.append(f"model {b['model']!r} though the owner asked for no model")
    return fails


def check(reply, kind, brief):
    inv = json.loads(brief.split(INVENTORY, 1)[1])
    cur = json.loads(brief.split(CURRENT, 1)[1].split("\n", 1)[0]) if CURRENT in brief else None
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
    return check_block(reply, kind, inv, cur)


if __name__ == "__main__":
    reply_path, kind, brief_path = sys.argv[1:4]
    fails = check(open(reply_path).read(), kind, open(brief_path).read())
    print("PASS" if not fails else "FAIL " + "; ".join(fails))
    sys.exit(1 if fails else 0)
