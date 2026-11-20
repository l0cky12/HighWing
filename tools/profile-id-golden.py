"""Writes src/hermes/profileIdGolden.json: the profile ids Hermes's own `_suggest_profile_name` derives from names, for
profileId.test.ts.

Runs `hermes_cli.profiles._suggest_profile_name` at ae2a81cc over a fixed list of names. `fellBack` marks a name where
nothing usable was left, read from Hermes's own `_PROFILE_ID_RE` check rather than worked out again here. It also
records `_RESERVED_NAMES` and the id pattern, so the app's copies are checked against Hermes. It reads and writes no
profile. Run it from the repo root with the Python Hermes runs in, against a throwaway Hermes home:

    HERMES_HOME=$(mktemp -d) ~/.cache/hermes-v0232/venv/bin/python -I tools/profile-id-golden.py ~/.cache/hermes-v0232/src > src/hermes/profileIdGolden.json
"""
import json
import logging
import sys

sys.path.insert(0, sys.argv[1])
logging.disable(logging.CRITICAL)
from hermes_cli import profiles

NAMES = [
    # ASCII, spaces, punctuation
    "Travel Buddy", "travel-buddy", "Bot #2", "My Work", "snake_case_bot", "Dr. Who?", "C++ Helper", "a", "42",
    "  spaced   out  ", "Tab\tand\nnewline", "Mixed_-_Separators", "___leading underscores", "trailing dashes---",
    "--Ünïcödé Bot--", "  --Ünïcödé Bot--  ",
    # accents and letters that lowercase to ASCII or near it
    "Café Crème", "Zoë", "Ångström", "İstanbul", "Straße", "K Kelvin", "Ｆｕｌｌｗｉｄｔｈ",
    # emoji, CJK and nothing usable
    "🦅 Eagle", "Bot 🤖", "🤖", "日本語", "日本語 bot", "中文助手", "한국어", "Привет", "   ", "", "---", "_", "!!!",
    # very long
    "a" * 64, "a" * 65, "word " * 20, "x" * 63 + " tail", "Long " + "name " * 30 + "end",
    # reserved
    "hermes", "Hermes", "default", "Default", "test", "TMP", "root", "sudo ", "Root!",
]


class Spy:
    """Hermes's `_PROFILE_ID_RE`, remembering whether the last candidate failed it (so Hermes fell back)."""

    def __init__(self, real):
        self.real, self.failed = real, False

    def match(self, s):
        m = self.real.match(s)
        self.failed = m is None
        return m


spy = Spy(profiles._PROFILE_ID_RE)
profiles._PROFILE_ID_RE = spy
cases = []
for name in NAMES:
    profile_id = profiles._suggest_profile_name(name)
    cases.append({"name": name, "id": profile_id, **({"fellBack": True} if spy.failed else {})})

golden = {"pattern": spy.real.pattern, "reserved": sorted(profiles._RESERVED_NAMES), "cases": cases}
json.dump(golden, sys.stdout, indent=1, ensure_ascii=False)
print()
