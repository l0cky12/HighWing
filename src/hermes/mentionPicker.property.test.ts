import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { completeMention, pickerAt, pickerRows } from "./mentionPicker";

type Seat = { handle: string; name: string };

const LOOKALIKES = [0x130, 0x131, 0x17f, 0x212a].map((c) => String.fromCodePoint(c));
const RUNS = { numRuns: 200 };

const handleArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,7}$/);
const rosterArb = fc.uniqueArray(handleArb, { minLength: 2, maxLength: 6, selector: (h) => h.toLowerCase() });
const glue = (before: string) => /^[\p{L}\p{N}_]$/u.test([...before].at(-1) ?? "");
const cased = (h: string) => fc.array(fc.boolean(), { minLength: h.length, maxLength: h.length }).map((mask) => [...h].map((c, i) => (mask[i] ? c.toUpperCase() : c)).join(""));

const piece = (roster: readonly string[]) =>
  fc.oneof(
    { weight: 5, arbitrary: fc.constantFrom(...roster).chain(cased).map((h) => `@${h}`) },
    { weight: 3, arbitrary: fc.tuple(fc.constantFrom(...roster), fc.constantFrom(".", ":", "-", "_", ".:", "x", "é", ",", "!", "?", ...LOOKALIKES)).map(([h, tail]) => `@${h}${tail}`) },
    { weight: 2, arbitrary: handleArb.map((h) => `@${h}`) },
    { weight: 3, arbitrary: fc.constantFrom("x", "me", "a1", "_", "(", "[", "é", "\u{1f600}") },
    { weight: 3, arbitrary: fc.constantFrom("`", "\n", "\n\n", "    ", " ", "  ", "> ") },
    { weight: 1, arbitrary: fc.constantFrom("@", ...LOOKALIKES) },
    { weight: 1, arbitrary: fc.string({ unit: "grapheme", maxLength: 4 }) },
  );
const textArb = (roster: readonly string[]) =>
  fc
    .tuple(fc.array(piece(roster), { maxLength: 14 }), fc.constantFrom("", " ", "\n", ".", ", "))
    .map(([parts, sep]) => parts.join(sep));
const scenario = rosterArb.chain((roster) => textArb(roster).map((text) => ({ roster, text })));

describe("pickerAt, over generated drafts", () => {
  it("opens only at an @ that starts a word, and its query is the text between the @ and the caret", () => {
    const at = scenario.chain(({ text }) => fc.record({ text: fc.constant(text), caret: fc.nat(text.length) }));
    fc.assert(
      fc.property(at, ({ text, caret }) => {
        const typing = pickerAt(text, caret);
        fc.pre(typing !== undefined);
        expect(text[typing!.from]).toBe("@");
        expect(text.slice(typing!.from + 1, caret)).toBe(typing!.query);
        expect(typing!.query).not.toMatch(/[\s@]/);
        expect(glue(text.slice(0, typing!.from))).toBe(false);
      }),
      RUNS,
    );
  });

  it("opens at every @ that starts a word when the caret is just after it", () => {
    fc.assert(
      fc.property(scenario, ({ text }) => {
        for (let i = 0; i < text.length; i++) {
          if (text[i] !== "@" || glue(text.slice(0, i))) continue;
          expect(pickerAt(text, i + 1)).toEqual({ from: i, query: "" });
        }
      }),
      RUNS,
    );
  });
});

describe("completeMention, over generated drafts", () => {
  it("puts the bot picked at the @ with the caret just after `@handle `, and leaves the rest of the draft alone", () => {
    const picking = scenario.chain(({ roster, text }) => fc.record({ roster: fc.constant(roster), text: fc.constant(text), caret: fc.nat(text.length), pick: fc.nat(roster.length - 1) }));
    fc.assert(
      fc.property(picking, ({ roster, text, caret, pick }) => {
        const typing = pickerAt(text, caret);
        fc.pre(typing !== undefined);
        const seat: Seat = { handle: roster[pick], name: roster[pick] };
        const done = completeMention(text, caret, typing!, { kind: "seat", seat });
        expect(done.text.slice(typing!.from, done.caret)).toBe(`@${seat.handle} `);
        expect(done.text.slice(0, typing!.from)).toBe(text.slice(0, typing!.from));
        expect(done.text.slice(done.caret)).toBe(text.slice(caret));
      }),
      RUNS,
    );
  });
});

describe("pickerRows, over generated names", () => {
  const WORDS = ["Ada", "Zoë", "Ångström", "Åsa", "Research", "Buddy", "ñandú", "日本語", "Ωmega", "x2"];
  const nameArb = fc.array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 3 }).map((w) => w.join(" "));
  const rosterOf = fc.array(fc.tuple(handleArb, nameArb), { minLength: 1, maxLength: 5 }).map((rows) => rows.map(([handle, name]) => ({ handle, name })));

  it("finds a bot from any start of its handle or of any word of its name, in any case", () => {
    const prefixes = (s: string) => Array.from({ length: [...s].length }, (_, i) => [...s].slice(0, i + 1).join(""));
    fc.assert(
      fc.property(rosterOf, (roster) => {
        for (const seat of roster) {
          const queries = [...prefixes(seat.handle), ...seat.name.split(" ").flatMap(prefixes)];
          for (const q of queries) {
            for (const typed of [q, q.toUpperCase(), q.toLowerCase()]) {
              const rows = pickerRows(typed, roster);
              expect(rows.some((r) => r.seat === seat), `${typed} finds ${seat.name}`).toBe(true);
            }
          }
        }
      }),
      RUNS,
    );
  });

  it("only narrows as the query grows, and lists every bot in roster order for an empty query", () => {
    const anyNames = fc.array(fc.record({ handle: handleArb, name: fc.string({ unit: "grapheme", minLength: 1, maxLength: 12 }) }), { minLength: 1, maxLength: 5 });
    const growth = fc.string({ unit: "grapheme", minLength: 1, maxLength: 2 });
    fc.assert(
      fc.property(anyNames, fc.string({ unit: "grapheme", maxLength: 4 }), growth, (roster, q, more) => {
        // A combining mark or a Hangul vowel joins the letter before it under NFC, which can widen a match; such growth isn't a longer query.
        fc.pre((q + more).normalize("NFC").startsWith(q.normalize("NFC")));
        const wide = pickerRows(q, roster).map((r) => r.seat);
        for (const r of pickerRows(q + more, roster)) expect(wide).toContain(r.seat);
        expect(pickerRows("", roster).map((r) => r.seat)).toEqual(roster);
      }),
      RUNS,
    );
  });

  it("keeps roster order", () => {
    fc.assert(
      fc.property(rosterOf, fc.constantFrom("", "a", "r", "å", "o"), (roster, q) => {
        const at = pickerRows(q, roster).map((r) => roster.indexOf(r.seat));
        expect(at).toEqual([...at].sort((a, b) => a - b));
      }),
      RUNS,
    );
  });
});

describe("totality", () => {
  it("answers any string, lone surrogates included, without throwing", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 300 }), fc.nat(320), (text, caret) => {
        const seats = [{ handle: "ada", name: "Ada" }];
        const typing = pickerAt(text, caret);
        if (typing) completeMention(text, caret, typing, { kind: "seat", seat: seats[0] });
        pickerRows(text, seats);
      }),
      RUNS,
    );
  });

  const SEATS = ["ada", "bram", "cleo"].map((handle) => ({ handle, name: handle }));
  const KB64 = 64 * 1024;
  it.each([
    ["an @a at every other character", "@a".repeat(KB64 / 2)],
    ["a glued @a at every other character", "a@".repeat(KB64 / 2)],
    ["only @", "@".repeat(KB64)],
    ["one long handle", `@${"a".repeat(KB64 - 1)}`],
    ["a long run of trailing marks, then a letter", `@a${".".repeat(KB64 - 3)}a`],
    ["a long run before a glued @", `${"y".repeat(KB64 - 5)}@ada`],
    ["a long run of lone surrogates before an @", `${"\ud800".repeat(KB64 - 5)}@ada`],
    ["look-alike letters", `@${LOOKALIKES.join("").repeat(KB64 / 8)}`],
  ])("reads %s at 64 KB in well under the time a quadratic reader would take", (_, text) => {
    expect(text.length).toBeLessThanOrEqual(KB64);
    const started = performance.now();
    pickerAt(text, text.length);
    pickerRows(text, SEATS);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
