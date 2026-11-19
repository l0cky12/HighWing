import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { atQuery } from "./chatReferences";
import { completeMention, matchBots, mentionsIn } from "./mentionPicker";

type Bot = { handle: string; name: string };

const LOOKALIKES = [0x130, 0x131, 0x17f, 0x212a].map((c) => String.fromCodePoint(c));
const RUNS = { numRuns: 300 };

// Hermes's PROFILE_ID_RE: a profile's name, which is its bot's handle.
const handleArb = fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const shortHandleArb = fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,5}$/);
const rosterArb = fc
  .uniqueArray(fc.oneof(shortHandleArb, handleArb), { minLength: 1, maxLength: 6 })
  .map((handles) => handles.map((handle): Bot => ({ handle, name: handle })));
const cased = (h: string) => fc.array(fc.boolean(), { minLength: h.length, maxLength: h.length }).map((mask) => [...h].map((c, i) => (mask[i] ? c.toUpperCase() : c)).join(""));
const startsWord = (text: string, at: number) => at === 0 || /\s/u.test(text.slice(0, at).at(-1)!);

const TAILS = [".", ",", "?", "!", ":", ";", ".com", "'s", ")", ".:", "?!", "x", "é", "́", "\u{1f600}", "\ud800", "-", "_", ...LOOKALIKES];
const piece = (roster: readonly Bot[]) =>
  fc.oneof(
    { weight: 5, arbitrary: fc.constantFrom(...roster.map((b) => b.handle)).chain(cased).map((h) => `@${h}`) },
    { weight: 3, arbitrary: fc.tuple(fc.constantFrom(...roster.map((b) => b.handle)), fc.constantFrom(...TAILS)).map(([h, tail]) => `@${h}${tail}`) },
    { weight: 2, arbitrary: handleArb.map((h) => `@${h}`) },
    { weight: 3, arbitrary: fc.constantFrom("x", "me", "a1", "_", "(", "[", "é", "\u{1f600}") },
    { weight: 3, arbitrary: fc.constantFrom("`", "\n", "\n\n", "\t", "    ", " ", "  ", " ", "﻿", "> ") },
    { weight: 1, arbitrary: fc.constantFrom("@", "@@", "x@", ...LOOKALIKES) },
    { weight: 1, arbitrary: fc.string({ unit: "binary", maxLength: 4 }) },
  );
const textArb = (roster: readonly Bot[]) =>
  fc.tuple(fc.array(piece(roster), { maxLength: 14 }), fc.constantFrom("", " ", "\n", ".", ", ")).map(([parts, sep]) => parts.join(sep));
const scenario = rosterArb.chain((roster) => textArb(roster).map((text) => ({ roster, text })));
const withCaret = scenario.chain((s) => fc.record({ roster: fc.constant(s.roster), text: fc.constant(s.text), caret: fc.nat(s.text.length) }));

describe("atQuery, over generated drafts", () => {
  it("opens only at an @ that starts the text or follows a space, and its query is the text between the @ and the caret, lowercased", () => {
    fc.assert(
      fc.property(withCaret, ({ text, caret }) => {
        const at = atQuery(text.slice(0, caret));
        fc.pre(at !== undefined);
        expect(text[at!.start]).toBe("@");
        expect(startsWord(text, at!.start)).toBe(true);
        expect(text.slice(at!.start + 1, caret).toLowerCase()).toBe(at!.query);
        expect(at!.query).not.toMatch(/[\s@]/u);
      }),
      RUNS,
    );
  });

  it("opens at every @ that starts the text or follows a space when the caret is just after it", () => {
    fc.assert(
      fc.property(scenario, ({ text }) => {
        for (let i = 0; i < text.length; i++) {
          if (text[i] === "@" && startsWord(text, i)) expect(atQuery(text.slice(0, i + 1))).toEqual({ query: "", start: i });
        }
      }),
      RUNS,
    );
  });
});

describe("completeMention, over generated drafts", () => {
  it("puts the bot picked at the @ with the caret just after `@handle `, and leaves the rest of the draft alone", () => {
    const picking = withCaret.chain((s) => fc.record({ s: fc.constant(s), pick: fc.nat(s.roster.length - 1) }));
    fc.assert(
      fc.property(picking, ({ s: { roster, text, caret }, pick }) => {
        const at = atQuery(text.slice(0, caret));
        fc.pre(at !== undefined);
        const { handle } = roster[pick];
        const done = completeMention(text, at!.start, caret, handle);
        const after = text.slice(caret);
        expect(done.caret).toBe(at!.start + `@${handle} `.length);
        expect(done.text.slice(at!.start, done.caret)).toBe(`@${handle} `);
        expect(done.text.slice(0, at!.start)).toBe(text.slice(0, at!.start));
        expect(done.text.slice(done.caret)).toBe(after.startsWith(" ") ? after.slice(1) : after);
      }),
      RUNS,
    );
  });
});

describe("the menu and the pills agree", () => {
  it("picking any bot the menu offers puts that bot's pill at that @", () => {
    fc.assert(
      fc.property(withCaret, ({ roster, text, caret }) => {
        const at = atQuery(text.slice(0, caret));
        fc.pre(at !== undefined);
        for (const bot of matchBots(at!.query, roster)) {
          const done = completeMention(text, at!.start, caret, bot.handle);
          expect(mentionsIn(done.text, roster).find((m) => m.start === at!.start)?.bot).toBe(bot);
        }
      }),
      RUNS,
    );
  });

  it("every pill sits where the menu opens at its @, with its bot offered for the word it covers", () => {
    fc.assert(
      fc.property(scenario, ({ roster, text }) => {
        for (const m of mentionsIn(text, roster)) {
          const at = atQuery(text.slice(0, m.end));
          expect(at?.start).toBe(m.start);
          expect(matchBots(at!.query, roster)).toContain(m.bot);
        }
      }),
      RUNS,
    );
  });

  it("a pill's handle is followed by a space, the end, or sentence marks before one of those, never by more of a token", () => {
    fc.assert(
      fc.property(scenario, ({ roster, text }) => {
        for (const m of mentionsIn(text, roster)) {
          expect(text.slice(m.end)).toMatch(/^[.,?!:;]*(?:\s|$)/u);
          expect(text.slice(m.start + 1, m.end).toLowerCase()).toBe(m.bot.handle);
        }
      }),
      RUNS,
    );
  });
});

describe("matchBots, over generated names", () => {
  const WORDS = ["Ada", "Zoë", "Ångström", "Åsa", "Research", "Buddy", "ñandú", "日本語", "Ωmega", "x2"];
  const nameArb = fc.array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 3 }).map((w) => w.join(" "));
  const rosterOf = fc.array(fc.tuple(shortHandleArb, nameArb), { minLength: 1, maxLength: 5 }).map((rows) => rows.map(([handle, name]): Bot => ({ handle, name })));

  it("finds a bot from any start of its handle or of any word of its name, in any case", () => {
    const prefixes = (s: string) => Array.from({ length: [...s].length }, (_, i) => [...s].slice(0, i + 1).join(""));
    fc.assert(
      fc.property(rosterOf, (roster) => {
        for (const bot of roster) {
          for (const q of [...prefixes(bot.handle), ...bot.name.split(" ").flatMap(prefixes)]) {
            for (const typed of [q, q.toUpperCase(), q.toLowerCase()]) expect(matchBots(typed, roster), `${typed} finds ${bot.name}`).toContain(bot);
          }
        }
      }),
      RUNS,
    );
  });

  it("only narrows as the query grows, and lists every bot in roster order for an empty query", () => {
    const anyNames = fc.array(fc.record({ handle: shortHandleArb, name: fc.string({ unit: "grapheme", minLength: 1, maxLength: 12 }) }), { minLength: 1, maxLength: 5 });
    const growth = fc.string({ unit: "grapheme", minLength: 1, maxLength: 2 });
    fc.assert(
      fc.property(anyNames, fc.string({ unit: "grapheme", maxLength: 4 }), growth, (roster, q, more) => {
        // A combining mark or a Hangul vowel joins the letter before it under NFC, which can widen a match; such growth isn't a longer query.
        fc.pre((q + more).normalize("NFC").startsWith(q.normalize("NFC")));
        const wide = matchBots(q, roster);
        for (const bot of matchBots(q + more, roster)) expect(wide).toContain(bot);
        expect(matchBots("", roster)).toEqual(roster);
      }),
      RUNS,
    );
  });

  it("lists first the bot whose whole handle is typed, in any case, so Tab picks it", () => {
    fc.assert(
      fc.property(rosterOf, (roster) => {
        for (const bot of roster) for (const typed of [bot.handle, bot.handle.toUpperCase()]) expect(matchBots(typed, roster)[0].handle).toBe(bot.handle);
      }),
      RUNS,
    );
  });

  it("lists the bots whose handle is the query first, then the rest, each in roster order", () => {
    fc.assert(
      fc.property(rosterOf, fc.constantFrom("", "a", "r", "å", "o", "x2", "ada"), (roster, q) => {
        const found = matchBots(q, roster);
        const exact = found.filter((b) => b.handle === q);
        expect(found.slice(0, exact.length)).toEqual(exact);
        for (const part of [exact, found.slice(exact.length)]) {
          const at = part.map((b) => roster.indexOf(b));
          expect(at).toEqual([...at].sort((a, b) => a - b));
        }
      }),
      RUNS,
    );
  });
});

describe("totality", () => {
  const BOTS: Bot[] = ["ada", "bram", "cleo"].map((handle) => ({ handle, name: handle }));

  it("answers any string, lone surrogates included, without throwing", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 300 }), fc.nat(320), (text, caret) => {
        const at = atQuery(text.slice(0, caret));
        if (at) completeMention(text, at.start, Math.min(caret, text.length), "ada");
        matchBots(text, BOTS);
        mentionsIn(text, BOTS);
      }),
      RUNS,
    );
  });

  const KB64 = 64 * 1024;
  it.each([
    ["an @a at every other character", "@a".repeat(KB64 / 2)],
    ["a pill at every fourth character", " @a.".repeat(KB64 / 4)],
    ["a glued @a at every other character", "a@".repeat(KB64 / 2)],
    ["only @", "@".repeat(KB64)],
    ["one long handle", `@${"a".repeat(KB64 - 1)}`],
    ["a long run of sentence marks, then a letter", `@a${".".repeat(KB64 - 3)}a`],
    ["sentence marks after many handles", ` @ada${"!".repeat(60)}x`.repeat(KB64 / 66)],
    ["a long run before a glued @", `${"y".repeat(KB64 - 5)}@ada`],
    ["a long run of lone surrogates before an @", `${"\ud800".repeat(KB64 - 5)}@ada`],
    ["a long run of combining marks", `@a${"́".repeat(KB64 - 2)}`],
    ["look-alike letters", `@${LOOKALIKES.join("").repeat(KB64 / 8)}`],
  ])("reads %s at 64 KB in well under the time a quadratic reader would take", (_, text) => {
    expect(text.length).toBeLessThanOrEqual(KB64);
    const started = performance.now();
    const at = atQuery(text);
    if (at) completeMention(text, at.start, text.length, "bram");
    matchBots(text, BOTS);
    mentionsIn(text, BOTS);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
