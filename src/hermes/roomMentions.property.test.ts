import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { resolveMentions } from "./fakeGroups";
import { EVERYONE_HANDLES, completeMention, goesTo, mentionedHandles, pickerAt, pickerRows, type Recipients } from "./roomMentions";

type Seat = { handle: string; name: string };

const LOOKALIKES = [0x130, 0x131, 0x17f, 0x212a].map((c) => String.fromCodePoint(c));
const RUNS = { numRuns: 200 };

const handleArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,7}$/).filter((h) => !EVERYONE_HANDLES.has(h.toLowerCase()));
const rosterArb = fc.uniqueArray(handleArb, { minLength: 2, maxLength: 6, selector: (h) => h.toLowerCase() });
const seatsOf = (roster: readonly string[]): Seat[] => roster.map((handle) => ({ handle, name: handle }));
const cased = (h: string) => fc.array(fc.boolean(), { minLength: h.length, maxLength: h.length }).map((mask) => [...h].map((c, i) => (mask[i] ? c.toUpperCase() : c)).join(""));

const piece = (roster: readonly string[]) =>
  fc.oneof(
    { weight: 5, arbitrary: fc.constantFrom(...roster).chain(cased).map((h) => `@${h}`) },
    { weight: 3, arbitrary: fc.tuple(fc.constantFrom(...roster), fc.constantFrom(".", ":", "-", "_", ".:", "x", "\u00e9", ",", "!", "?", ...LOOKALIKES)).map(([h, tail]) => `@${h}${tail}`) },
    { weight: 1, arbitrary: fc.constantFrom("@all", "@EVERYONE", "@Everyone", "@ALL") },
    { weight: 2, arbitrary: handleArb.map((h) => `@${h}`) },
    { weight: 3, arbitrary: fc.constantFrom("x", "me", "a1", "_", "(", "[", "\u00e9", "\u{1f600}") },
    { weight: 3, arbitrary: fc.constantFrom("`", "``", "```", "```\n", "~~~\n", "\n", "\n\n", "    ", " ", "  ", "> ") },
    { weight: 1, arbitrary: fc.constantFrom("@", ...LOOKALIKES) },
    { weight: 1, arbitrary: fc.string({ unit: "grapheme", maxLength: 4 }) },
  );
const textArb = (roster: readonly string[]) =>
  fc
    .tuple(fc.array(piece(roster), { maxLength: 14 }), fc.constantFrom("", " ", "\n", ".", ", "))
    .map(([parts, sep]) => parts.join(sep));
const scenario = rosterArb.chain((roster) => textArb(roster).map((text) => ({ roster, text })));
const noAt = fc.string({ unit: "grapheme", maxLength: 12 }).filter((s) => !s.includes("@"));

const handlesOf = (to: Recipients<Seat>, roster: readonly string[]) => (to.kind === "seats" ? to.seats.map((s) => s.handle) : [...roster]);

describe("goesTo, over generated rosters and texts", () => {
  it("names the same bots as the stand-in's port of Hermes's rule", () => {
    fc.assert(
      fc.property(scenario, ({ roster, text }) => {
        const seats = seatsOf(roster);
        expect(handlesOf(goesTo(text, seats).to, roster)).toEqual(resolveMentions([text], seats, true).map((s) => s.handle));
      }),
      RUNS,
    );
  });

  it("makes `to` out of the routed mentions alone: non-empty, unique, in roster order", () => {
    fc.assert(
      fc.property(scenario, ({ roster, text }) => {
        const seats = seatsOf(roster);
        const { to, mentions } = goesTo(text, seats);
        const routed = mentions.flatMap((m) => ("target" in m ? [m.target] : []));
        const named = seats.filter((s) => routed.some((t) => t.kind === "seat" && t.seat === s));
        const expected: Recipients<Seat> = routed.some((t) => t.kind === "everyone")
          ? { kind: "everyone", because: "allNamed" }
          : named.length
            ? { kind: "seats", seats: named as [Seat, ...Seat[]] }
            : { kind: "everyone", because: "nobodyNamed" };
        expect(to).toEqual(expected);
      }),
      RUNS,
    );
  });

  it("reports mentions in order, apart, each exactly where the text has it", () => {
    fc.assert(
      fc.property(scenario, ({ roster, text }) => {
        const { mentions } = goesTo(text, seatsOf(roster));
        mentions.forEach((m, i) => {
          expect(text[m.at]).toBe("@");
          expect(text.slice(m.at + 1, m.at + 1 + m.raw.length)).toBe(m.raw);
          if (i) expect(m.at).toBeGreaterThanOrEqual(mentions[i - 1].at + 1 + mentions[i - 1].raw.length);
        });
      }),
      RUNS,
    );
  });

  it("is not moved by text without an @, or by trimming", () => {
    fc.assert(
      fc.property(scenario, noAt, noAt, ({ roster, text }, before, after) => {
        const seats = seatsOf(roster);
        const { to } = goesTo(text, seats);
        expect(goesTo(`${before} ${text} ${after}`, seats).to).toEqual(to);
        expect(goesTo(text.trim(), seats).to).toEqual(to);
      }),
      RUNS,
    );
  });

  it("is not moved by the case of ASCII letters", () => {
    const swap = (s: string) => s.replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
    fc.assert(
      fc.property(scenario, ({ roster, text }) => {
        const seats = seatsOf(roster);
        expect(goesTo(swap(text), seats).to).toEqual(goesTo(text, seats).to);
      }),
      RUNS,
    );
  });

  it("does not route on a token it says reaches nobody: blanking an unknown or trailing mention leaves `to` as it was", () => {
    fc.assert(
      fc.property(scenario, ({ roster, text }) => {
        const seats = seatsOf(roster);
        const { to, mentions } = goesTo(text, seats);
        for (const m of mentions) {
          if (m.kind !== "unknown" && m.kind !== "trailing") continue;
          const blanked = text.slice(0, m.at) + " ".repeat(1 + m.raw.length) + text.slice(m.at + 1 + m.raw.length);
          expect(goesTo(blanked, seats).to).toEqual(to);
        }
      }),
      RUNS,
    );
  });

  it("does route on a token it says goes there anyway, whether glued or in code", () => {
    fc.assert(
      fc.property(scenario, ({ roster, text }) => {
        const { to, mentions } = goesTo(text, seatsOf(roster));
        for (const m of mentions) {
          if (m.kind !== "inCode" && m.kind !== "glued") continue;
          if (m.target.kind === "everyone") expect(to.kind).toBe("everyone");
          else expect(to.kind === "everyone" || to.seats.includes(m.target.seat)).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it("calls a lone known mention in backticks code, and routes it the same", () => {
    const wrapped = rosterArb.chain((roster) =>
      fc.record({ roster: fc.constant(roster), h: fc.constantFrom(...roster).chain(cased), pre: fc.constantFrom("", " ", "see ", "ok\n"), post: fc.constantFrom("", " ", " ok", ", ok", "\nmore") }),
    );
    fc.assert(
      fc.property(wrapped, ({ roster, h, pre, post }) => {
        const seats = seatsOf(roster);
        const plain = goesTo(`${pre}@${h}${post}`, seats);
        const code = goesTo(`${pre}\`@${h}\`${post}`, seats);
        expect(plain.mentions.map((m) => [m.kind, m.at])).toEqual([["plain", pre.length]]);
        expect(code.mentions.map((m) => [m.kind, m.at])).toEqual([["inCode", pre.length + 1]]);
        expect(code.to).toEqual(plain.to);
        const odd = goesTo(`${pre}\` @${h}${post}`, seats);
        expect(odd.mentions.map((m) => m.kind)).toEqual(["plain"]);
      }),
      RUNS,
    );
  });

  it("finds exactly the tokens a character-by-character reading of the regex's grammar finds", () => {
    const head = new Set([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", ...LOOKALIKES]);
    const tail = new Set([...head, ".", "_", ":", "-"]);
    const oracle = (text: string) => {
      const found: { at: number; raw: string }[] = [];
      for (let i = 0; i < text.length; i++) {
        if (text[i] !== "@" || !head.has(text[i + 1])) continue;
        let end = i + 2;
        while (end < text.length && tail.has(text[end])) end++;
        found.push({ at: i, raw: text.slice(i + 1, end) });
        i = end - 1;
      }
      return found;
    };
    fc.assert(
      fc.property(scenario, ({ roster, text }) => {
        const tokens = oracle(text);
        expect(mentionedHandles(text)).toEqual(tokens.map((t) => t.raw.toLowerCase().replaceAll("\u017f", "s")));
        for (const m of goesTo(text, seatsOf(roster)).mentions) expect(tokens).toContainEqual({ at: m.at, raw: m.raw });
      }),
      RUNS,
    );
  });
});

describe("picking a bot, over generated drafts", () => {
  it("always routes to the bot picked, with the caret just after `@handle `", () => {
    const picking = scenario.chain(({ roster, text }) => fc.record({ roster: fc.constant(roster), text: fc.constant(text), caret: fc.nat(text.length), pick: fc.nat(roster.length) }));
    fc.assert(
      fc.property(picking, ({ roster, text, caret, pick }) => {
        const seats = seatsOf(roster);
        const typing = pickerAt(text, caret);
        fc.pre(typing !== undefined);
        const row = pick === seats.length ? ({ kind: "everyone" } as const) : ({ kind: "seat", seat: seats[pick] } as const);
        const done = completeMention(text, caret, typing!, row);
        const handle = row.kind === "everyone" ? "all" : row.seat.handle;
        expect(done.text.slice(typing!.from, done.caret)).toBe(`@${handle} `);
        const mention = goesTo(done.text, seats).mentions.find((m) => m.at === typing!.from);
        expect(mention && "target" in mention ? mention.target : undefined).toEqual(row.kind === "everyone" ? { kind: "everyone" } : { kind: "seat", seat: row.seat });
      }),
      RUNS,
    );
  });

  it("opens only at an @ that starts a word, and its query is the text between the @ and the caret", () => {
    const at = scenario.chain(({ text }) => fc.record({ text: fc.constant(text), caret: fc.nat(text.length) }));
    fc.assert(
      fc.property(at, ({ text, caret }) => {
        const typing = pickerAt(text, caret);
        fc.pre(typing !== undefined);
        expect(text[typing!.from]).toBe("@");
        expect(text.slice(typing!.from + 1, caret)).toBe(typing!.query);
        expect(typing!.query).not.toMatch(/[\s@]/);
        expect(text.slice(Math.max(0, typing!.from - 1), typing!.from)).not.toMatch(/^[A-Za-z0-9_]$/);
      }),
      RUNS,
    );
  });
});

describe("pickerRows, over generated names", () => {
  const WORDS = ["Ada", "Zo\u00eb", "\u00c5ngstr\u00f6m", "\u00c5sa", "Research", "Buddy", "\u00f1and\u00fa", "\u65e5\u672c\u8a9e", "\u03a9mega", "x2"];
  const nameArb = fc.array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 3 }).map((w) => w.join(" "));
  const rosterOf = fc.array(fc.tuple(handleArb, nameArb), { minLength: 1, maxLength: 5 }).map((rows) => rows.map(([handle, name]) => ({ handle, name })));
  const same = (a: readonly { kind: string }[], b: readonly { kind: string }[]) => a.length === b.length && a.every((row, i) => row === b[i] || JSON.stringify(row) === JSON.stringify(b[i]));

  it("finds a bot from any start of its handle or of any word of its name, in any case", () => {
    const prefixes = (s: string) => Array.from({ length: [...s].length }, (_, i) => [...s].slice(0, i + 1).join(""));
    fc.assert(
      fc.property(rosterOf, (roster) => {
        for (const seat of roster) {
          const queries = [...prefixes(seat.handle), ...seat.name.split(" ").flatMap(prefixes)];
          for (const q of queries) {
            for (const typed of [q, q.toUpperCase(), q.toLowerCase()]) {
              const rows = pickerRows(typed, roster, "Everyone");
              expect(rows.some((r) => r.kind === "seat" && r.seat === seat), `${typed} finds ${seat.name}`).toBe(true);
            }
          }
        }
      }),
      RUNS,
    );
  });

  it("only narrows as the query grows, and lists every bot then Everyone for an empty query", () => {
    const anyNames = fc.array(fc.record({ handle: handleArb, name: fc.string({ unit: "grapheme", minLength: 1, maxLength: 12 }) }), { minLength: 1, maxLength: 5 });
    const growth = fc.string({ unit: "grapheme", minLength: 1, maxLength: 2 });
    fc.assert(
      fc.property(anyNames, fc.string({ unit: "grapheme", maxLength: 4 }), growth, (roster, q, more) => {
        // A combining mark or a Hangul vowel joins the letter before it under NFC, which can widen a match; such growth isn't a longer query.
        fc.pre((q + more).normalize("NFC").startsWith(q.normalize("NFC")));
        const wide = pickerRows(q, roster, "Everyone");
        const narrow = pickerRows(q + more, roster, "Everyone");
        const wideSeats = wide.flatMap((r) => (r.kind === "seat" ? [r.seat] : []));
        for (const r of narrow) if (r.kind === "seat") expect(wideSeats).toContain(r.seat);
        if (narrow.some((r) => r.kind === "everyone")) expect(wide.some((r) => r.kind === "everyone")).toBe(true);
        const all = pickerRows("", roster, "Everyone");
        expect(all.map((r) => r.kind)).toEqual([...roster.map(() => "seat"), "everyone"]);
        expect(same(all.slice(0, -1), roster.map((seat) => ({ kind: "seat", seat })))).toBe(true);
      }),
      RUNS,
    );
  });

  it("keeps roster order", () => {
    fc.assert(
      fc.property(rosterOf, fc.constantFrom("", "a", "r", "\u00e5", "o"), (roster, q) => {
        const seats = pickerRows(q, roster, "Everyone").flatMap((r) => (r.kind === "seat" ? [r.seat] : []));
        const at = seats.map((s) => roster.indexOf(s));
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
        goesTo(text, seats);
        mentionedHandles(text);
        const typing = pickerAt(text, caret);
        if (typing) completeMention(text, caret, typing, { kind: "everyone" });
        pickerRows(text, seats, "Everyone");
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
    ["backtick-fenced mentions", "```\n@ada\n```\n".repeat(KB64 / 13)],
    ["inline code around every mention", "`@ada` ".repeat(KB64 / 7)],
    ["unclosed backticks before every mention", "`@ada ".repeat(KB64 / 6)],
    ["nested block quotes", `${"> ".repeat(KB64 / 2 - 5)}@ada`],
    ["nested list items", `${"- ".repeat(KB64 / 2 - 5)}@ada`],
    ["unclosed image openers", `${"![a](".repeat(KB64 / 6 - 1)}@ada`],
    ["a list nested just under the guard, repeated", `${"- ".repeat(23)}@ada\n`.repeat(KB64 / 54)],
    ["a long run before a glued @", `${"y".repeat(KB64 - 5)}@ada`],
    ["many words in an @all", "@all ".repeat(KB64 / 5)],
    ["look-alike letters", `@${LOOKALIKES.join("").repeat(KB64 / 8)}`],
  ])("reads %s at Hermes's 64 KB cap in well under the time a quadratic reader would take", (_, text) => {
    expect(text.length).toBeLessThanOrEqual(KB64);
    const started = performance.now();
    goesTo(text, SEATS);
    mentionedHandles(text);
    pickerAt(text, text.length);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
