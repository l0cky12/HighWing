"""Cuts test vectors for a Group room's `@` routing out of Hermes's own source.

Hermes decides who answers a room message with `_MENTION_RE` and `resolve_mentions` in
gateway/hosted_room_discussion.py. This script lifts those two nodes out by `ast` (the package itself does not import
without Hermes's dependencies), runs them over a hand-picked and a seeded random corpus, and writes
src/hermes/roomMentionVectors.json. src/hermes/roomMentions.vectors.test.ts replays the file against the client's reader
(roomMentions.ts) and against the stand-in server (fakeGroups.ts), so a drift from Hermes fails the build.

    python3 -I scripts/room-mention-vectors.py <hermes-src> [--commit <sha>]    write the vectors
    python3 -I scripts/room-mention-vectors.py --check <hermes-src>             fail when the two nodes changed

Each case holds the roster's handles in roster order and what Hermes returns for them: `handles.defaultAll` is
default_all=True, which the owner's message uses, and `handles.namedOnly` is default_all=False, which a bot's reply
uses. `sourceHash` is the sha256 of the two nodes' source text, so `--check` against the Hermes build a server runs
says whether the vectors still describe it.
"""

import argparse
import ast
import hashlib
import json
import random
import re
import sys
from collections import namedtuple
from pathlib import Path
from typing import Iterable, Sequence

SOURCE = "gateway/hosted_room_discussion.py"
OUT = Path(__file__).resolve().parent.parent / "src" / "hermes" / "roomMentionVectors.json"
SEED = 20261118
RANDOM_CASES = 400

# Python's re.IGNORECASE widens [A-Za-z] on a str pattern to these four letters: dotted capital I, dotless i, long s
# and the Kelvin sign. str.casefold() then reads them as i + U+0307, itself, s and k.
LOOKALIKES = ["İ", "ı", "ſ", "K"]

Member = namedtuple("DiscussionMember", "member_id handle")

FAMILY = ["ada", "bram", "cleo"]
WIDE = ["ada", "bram", "kim", "sam", "ida", "adas"]
HANDLES = ["ada", "bram", "cleo", "kim", "sam", "ida", "adas", "Zoe.x", "research", "q1", "a", "Dev-2", "x:y", "n_1"]

HAND = [
    ("", FAMILY),
    ("hello there", FAMILY),
    ("@ada", FAMILY),
    ("@ada ", FAMILY),
    ("@ada and @bram, compare", FAMILY),
    ("@bram and @ada, compare", FAMILY),
    ("@all", FAMILY),
    ("@everyone", FAMILY),
    ("@EVERYONE", FAMILY),
    ("@All", FAMILY),
    ("@all @ada", FAMILY),
    ("@ada @all", FAMILY),
    ("@everyone, @ada", FAMILY),
    ("@ADA", FAMILY),
    ("@Ada @aDa @ada", FAMILY),
    ("@bram.", FAMILY),
    ("@bram:", FAMILY),
    ("@bram-", FAMILY),
    ("@bram,", FAMILY),
    ("@bram!", FAMILY),
    ("@bram?", FAMILY),
    ("Thanks @bram. Can you look?", FAMILY),
    ("@bram: can you look?", FAMILY),
    ("@bram.. @ada", FAMILY),
    ("x@ada", FAMILY),
    ("mail me at lena@bram.example.com", FAMILY),
    ("me@example.com", FAMILY),
    ("`@ada`", FAMILY),
    ("what is `@ada` here", FAMILY),
    ("```\n@ada\n```", FAMILY),
    ("```js\n@ada\n```\nthen @bram", FAMILY),
    ("unclosed `@ada here", FAMILY),
    ("    @ada indented", FAMILY),
    ("@quill hello", FAMILY),
    ("@quill @ada", FAMILY),
    ("@ada@bram", FAMILY),
    ("(@ada)", FAMILY),
    ("[@ada]", FAMILY),
    ("@ada's turn", FAMILY),
    ("@ada\n@bram", FAMILY),
    ("@", FAMILY),
    ("@@ada", FAMILY),
    ("@.ada", FAMILY),
    ("@_ada", FAMILY),
    ("@1", ["1", "ada"]),
    ("@a", ["a", "bram"]),
    ("@zoe.x", ["Zoe.x", "research", "ada"]),
    ("@Zoe.X:", ["Zoe.x", "research", "ada"]),
    ("@zoe.x:", ["Zoe.x", "research", "ada"]),
    ("@RESEARCH and @zoe.x", ["Zoe.x", "research", "ada"]),
    ("@ada@bram.@cleo", FAMILY),
    ("@adaé", FAMILY),
    ("@éada", FAMILY),
    ("@adaé @bram", FAMILY),
    ("@zoë", ["zo", "ada"]),
    ("@Å", FAMILY),
    ("@ada @bram", FAMILY),
    ("@ada​@bram", FAMILY),
    ("😀@ada", FAMILY),
    ("@ada😀", FAMILY),
]

for ch in LOOKALIKES:
    HAND += [
        (f"@{ch}da", WIDE),
        (f"@ad{ch}", WIDE),
        (f"@ada{ch}", WIDE),
        (f"@{ch}am", WIDE),
        (f"@s{ch}m", WIDE),
        (f"@k{ch}m", WIDE),
        (f"@{ch}", WIDE),
        (f"x {ch}@ada", WIDE),
    ]
HAND += [
    ("@adaſ", WIDE),
    ("@ADAſ", WIDE),
    ("@ſam", WIDE),
    ("@ſAM", WIDE),
    ("@Kim", WIDE),
    ("@KIM", WIDE),
    ("@Kim", WIDE),
    ("@İda", WIDE),
    ("@ıda", WIDE),
    ("@adaı", WIDE),
    ("@adaİ", WIDE),
    ("@ſam @Kim", WIDE),
    ("@aliſa", ["alisa", "ada"]),
    ("@ALſA", ["alisa", "ada"]),
]


def lift(source: str, where: str):
    tree = ast.parse(source)
    nodes = []
    for node in tree.body:
        is_re = isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "_MENTION_RE" for t in node.targets)
        if is_re or (isinstance(node, ast.FunctionDef) and node.name == "resolve_mentions"):
            nodes.append(node)
    if len(nodes) != 2:
        sys.exit(f"{where}: expected _MENTION_RE and resolve_mentions, found {len(nodes)} node(s). Hermes renamed or moved them.")
    text = "\n".join(ast.get_source_segment(source, n) or "" for n in nodes)
    ns = {"re": re, "Iterable": Iterable, "Sequence": Sequence, "DiscussionMember": Member}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), where, "exec"), ns)
    return hashlib.sha256(text.encode()).hexdigest(), ns["resolve_mentions"]


def corpus():
    rng = random.Random(SEED)
    parts = ["@", "@", "@", "@all", "@everyone", "`", "```", "\n", "\n\n", " ", " ", " ", ".", ":", "-", "_", ",", "é", "ß", "Å", "😀", "x", "7", *LOOKALIKES]
    cases = list(HAND)
    for _ in range(RANDOM_CASES):
        roster = rng.sample(HANDLES, rng.randint(2, 6))
        pieces = []
        for _ in range(rng.randint(1, 9)):
            pick = rng.random()
            if pick < 0.45:
                h = rng.choice(roster if rng.random() < 0.8 else HANDLES)
                pieces.append("@" + "".join(c.upper() if rng.random() < 0.3 else c for c in h) + rng.choice(["", "", "", ".", ":", "-", ",", "?", rng.choice(LOOKALIKES)]))
            else:
                pieces.append(rng.choice(parts))
        sep = rng.choice(["", " ", " ", "\n"])
        cases.append((sep.join(pieces), roster))
    return cases


def reads(resolve, text: str, roster: list[str], default_all: bool) -> list[str]:
    members = [Member(h, h) for h in roster]
    return [m.handle for m in resolve((text,), members, default_all=default_all)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("hermes", type=Path, help="a Hermes source checkout")
    ap.add_argument("--check", action="store_true", help="fail when the checkout's nodes hash differently from the vectors")
    ap.add_argument("--commit", help="the checkout's commit, recorded in the vectors (default: the folder's -<sha> suffix)")
    args = ap.parse_args()

    source = args.hermes / SOURCE
    if not source.is_file():
        sys.exit(f"{source} not found")
    digest, resolve = lift(source.read_text(encoding="utf-8"), str(source))

    if args.check:
        recorded = json.loads(OUT.read_text(encoding="utf-8"))
        if recorded["sourceHash"] != digest:
            print(f"changed: Hermes's routing no longer hashes as the vectors do (commit {recorded['hermes']}).", file=sys.stderr)
            print(f"  vectors {recorded['sourceHash']}\n  source  {digest}\nRerun without --check, then run the tests.", file=sys.stderr)
            return 1
        print(f"ok: the vectors describe {args.hermes} ({recorded['hermes']}, {len(recorded['cases'])} cases)")
        return 0

    commit = args.commit or (re.search(r"-([0-9a-f]{7,40})$", args.hermes.resolve().name) or [None, None])[1]
    if not commit:
        sys.exit("pass --commit <sha>: the checkout's folder name doesn't end in one")
    seen = set()
    cases = []
    for text, roster in corpus():
        if (text, tuple(roster)) in seen:
            continue
        seen.add((text, tuple(roster)))
        cases.append(
            {
                "text": text,
                "roster": roster,
                "handles": {"defaultAll": reads(resolve, text, roster, True), "namedOnly": reads(resolve, text, roster, False)},
            }
        )
    rows = ",\n".join("  " + json.dumps(c, ensure_ascii=True) for c in cases)
    head = f'{{\n "hermes": {json.dumps(commit)},\n "sourceHash": {json.dumps(digest)},\n "cases": [\n'
    OUT.write_text(f"{head}{rows}\n ]\n}}\n", encoding="utf-8")
    print(f"wrote {len(cases)} cases to {OUT} from {commit}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
