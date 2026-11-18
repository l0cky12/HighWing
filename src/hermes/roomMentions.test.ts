import { describe, expect, it } from "vitest";
import { completeMention, goesTo, keyAction, mentionedHandles, pickerAt, pickerRows, type Mention, type Recipients } from "./roomMentions";

type Seat = { handle: string; name: string };
const ADA: Seat = { handle: "ada", name: "Ada" };
const BRAM: Seat = { handle: "bram", name: "Bram" };
const CLEO: Seat = { handle: "cleo", name: "Cleo" };
const ANGSTROM = "Zo\u00eb \u00c5ngstr\u00f6m";
const ZOE: Seat = { handle: "zoe", name: ANGSTROM };
const BUDDY: Seat = { handle: "research", name: "Research Buddy" };
const TRIO = [ADA, BRAM, CLEO];

const who = (to: Recipients<Seat>) => (to.kind === "seats" ? to.seats.map((s) => s.name) : `everyone (${to.because})`);
const kinds = (ms: readonly Mention<Seat>[]) => ms.map((m) => [m.kind, m.raw]);
const sentence = (text: string, roster: readonly Seat[] = TRIO) => {
  const g = goesTo(text, roster);
  return { to: who(g.to), mentions: kinds(g.mentions) };
};

describe("goesTo", () => {
  it("sends a message that names nobody to everyone, and says nobody was named", () => {
    expect(sentence("")).toEqual({ to: "everyone (nobodyNamed)", mentions: [] });
    expect(sentence("hello team")).toEqual({ to: "everyone (nobodyNamed)", mentions: [] });
  });

  it("sends a named bot's message to that bot alone, as the roster's own object", () => {
    const g = goesTo("@bram only you", TRIO);
    expect(g.to).toEqual({ kind: "seats", seats: [BRAM] });
    expect(g.to.kind === "seats" && g.to.seats[0]).toBe(BRAM);
    expect(g.mentions).toEqual([{ kind: "plain", at: 0, raw: "bram", target: { kind: "seat", seat: BRAM } }]);
  });

  it("lists the named bots in roster order, whatever order they were typed in", () => {
    expect(sentence("@cleo then @ada, compare").to).toEqual(["Ada", "Cleo"]);
    expect(sentence("@ada @ada @ADA").to).toEqual(["Ada"]);
  });

  it("reads @all and @everyone, in any case, as the whole roster, even beside a named bot", () => {
    expect(sentence("@all")).toEqual({ to: "everyone (allNamed)", mentions: [["plain", "all"]] });
    expect(sentence("@EVERYONE").to).toBe("everyone (allNamed)");
    expect(sentence("@all @ada").to).toBe("everyone (allNamed)");
    expect(sentence("@ada, @Everyone").to).toBe("everyone (allNamed)");
  });

  it("matches a handle in any case, and a handle that has capitals", () => {
    expect(sentence("@BRAM").to).toEqual(["Bram"]);
    expect(sentence("@zoe.x", [{ handle: "Zoe.x", name: "Zoe" }, ADA]).to).toEqual(["Zoe"]);
  });

  it("tells a trailing mark apart: Hermes reads the whole word, finds no such bot and sends to everyone", () => {
    const g = goesTo("Thanks @bram. Can you look?", TRIO);
    expect(who(g.to)).toBe("everyone (nobodyNamed)");
    expect(g.mentions).toEqual([{ kind: "trailing", at: 7, raw: "bram.", meant: { kind: "seat", seat: BRAM }, tail: "." }]);
  });

  it.each([
    ["@bram:", "bram:", ":"],
    ["@bram-", "bram-", "-"],
    ["@bram.:-", "bram.:-", ".:-"],
    ["@BRAM.", "BRAM.", "."],
  ])("reads %s as a trailing mark on Bram", (text, raw, tail) => {
    expect(goesTo(text, TRIO).mentions).toMatchObject([{ kind: "trailing", raw, tail, meant: { kind: "seat", seat: BRAM } }]);
  });

  it("does not call a comma or a question mark trailing: Hermes stops the name there", () => {
    expect(sentence("@bram, @ada?").to).toEqual(["Ada", "Bram"]);
  });

  it("reads a trailing mark on @all as meaning everyone", () => {
    expect(goesTo("@all.", TRIO).mentions).toMatchObject([{ kind: "trailing", meant: { kind: "everyone" }, tail: "." }]);
  });

  it("finds the mark only at the end of the word", () => {
    expect(kinds(goesTo("@bram.ok", TRIO).mentions)).toEqual([["unknown", "bram.ok"]]);
  });

  it("reports a handle nobody has, and not a name Hermes would never capture", () => {
    expect(sentence("@quill hello")).toEqual({ to: "everyone (nobodyNamed)", mentions: [["unknown", "quill"]] });
    expect(sentence("@\u00c5da")).toEqual({ to: "everyone (nobodyNamed)", mentions: [] });
  });

  it("sends x@ada to Ada anyway, and says it looks like an e-mail address", () => {
    const g = goesTo("mail x@ada please", TRIO);
    expect(who(g.to)).toEqual(["Ada"]);
    expect(g.mentions).toEqual([{ kind: "glued", at: 6, raw: "ada", before: "x", target: { kind: "seat", seat: ADA } }]);
  });

  it("stays quiet about an @ that is stuck to a word and names nobody here", () => {
    expect(sentence("me@example.com")).toEqual({ to: "everyone (nobodyNamed)", mentions: [] });
    expect(sentence("`@Injectable`")).toEqual({ to: "everyone (nobodyNamed)", mentions: [] });
  });

  it("calls an @ glued to a letter, digit or underscore glued, and one after a bracket or a space a mention", () => {
    expect(kinds(goesTo("a@ada 1@bram _@cleo (@ada [@bram \u00e9@cleo", TRIO).mentions)).toEqual([
      ["glued", "ada"],
      ["glued", "bram"],
      ["glued", "cleo"],
      ["plain", "ada"],
      ["plain", "bram"],
      ["glued", "cleo"],
    ]);
  });

  it("keeps only the stretch of text before a glued @ that is near it", () => {
    const g = goesTo(`${"y".repeat(80)}@ada`, TRIO);
    expect(g.mentions[0]).toMatchObject({ kind: "glued", before: `\u2026${"y".repeat(32)}` });
  });

  it("splits @ada@bram into a mention and a glued one", () => {
    expect(goesTo("@ada@bram", TRIO).mentions).toMatchObject([
      { kind: "plain", at: 0, raw: "ada" },
      { kind: "glued", at: 4, raw: "bram", before: "@ada" },
    ]);
  });

  it("sends a mention inside inline code, a fence or an indented block anyway, and says it is code", () => {
    for (const text of ["what is `@ada`?", "```\n@ada\n```", "```js\n@ada\n```\nthen nothing", "```\n@ada, never closed", "hi\n\n    @ada indented", "> `@ada` quoted", "~~~\n@ada\n~~~"]) {
      const g = goesTo(text, TRIO);
      expect(who(g.to), text).toEqual(["Ada"]);
      expect(kinds(g.mentions), text).toEqual([["inCode", "ada"]]);
    }
  });

  it("does not take an unclosed backtick for code", () => {
    expect(kinds(goesTo("unclosed `@ada here", TRIO).mentions)).toEqual([["plain", "ada"]]);
  });

  it("reads a mention after a closed fence as plain", () => {
    expect(kinds(goesTo("```\n@ada\n```\nthen @bram", TRIO).mentions)).toEqual([
      ["inCode", "ada"],
      ["plain", "bram"],
    ]);
  });

  it("calls a mention that is both glued and in code in code", () => {
    expect(kinds(goesTo("`x@ada`", TRIO).mentions)).toEqual([["inCode", "ada"]]);
  });

  it("does not warn about an unknown handle inside code", () => {
    expect(goesTo("`@quill`", TRIO).mentions).toEqual([]);
  });

  it("reads the text as it will be sent, trimmed, so leading spaces are not an indented block", () => {
    expect(goesTo("    @ada", TRIO).mentions).toMatchObject([{ kind: "plain", at: 4 }]);
    expect(goesTo("  \n  @quill", TRIO).mentions).toMatchObject([{ kind: "unknown", at: 5 }]);
  });

  it("does not read a very long text, or one that nests a line deep in block quotes, for code, and still routes it", () => {
    expect(kinds(goesTo(`${"> ".repeat(23)}\`@ada\``, TRIO).mentions)).toEqual([["inCode", "ada"]]);
    const deep = goesTo(`${"> ".repeat(24)}\`@ada\``, TRIO);
    expect(kinds(deep.mentions)).toEqual([["plain", "ada"]]);
    expect(who(deep.to)).toEqual(["Ada"]);
    const long = goesTo(`\`@ada\` ${"x".repeat(16 * 1024)}`, TRIO);
    expect(kinds(long.mentions)).toEqual([["plain", "ada"]]);
    expect(who(long.to)).toEqual(["Ada"]);
  });

  it("reads the four letters Python's ignore-case adds to [A-Za-z] as part of a handle", () => {
    const roster = [ADA, { handle: "adas", name: "Adas" }, { handle: "kim", name: "Kim" }];
    expect(sentence("@ada\u017f", roster).to).toEqual(["Adas"]);
    expect(sentence("@ada\u0131", roster).to).toBe("everyone (nobodyNamed)");
    expect(sentence("@ada\u0130", roster).to).toBe("everyone (nobodyNamed)");
    expect(sentence("@\u212aim", roster)).toEqual({ to: ["Kim"], mentions: [["plain", "\u212aim"]] });
    expect(sentence("@\u017fam", [{ handle: "sam", name: "Sam" }, ADA]).to).toEqual(["Sam"]);
  });

  it("stops a handle at any other non-ASCII letter, as Hermes does", () => {
    expect(sentence("@ada\u00e9").to).toEqual(["Ada"]);
    expect(kinds(goesTo("@ada\u00e9", TRIO).mentions)).toEqual([["plain", "ada"]]);
  });

  it("takes every mention's offset in the text it was given", () => {
    const text = "  hi @ada and x@bram";
    for (const m of goesTo(text, TRIO).mentions) expect(text.slice(m.at, m.at + 1 + m.raw.length)).toBe(`@${m.raw}`);
  });

  it("answers for any roster, including none", () => {
    expect(goesTo("@ada", []).to).toEqual({ kind: "everyone", because: "nobodyNamed" });
    expect(kinds(goesTo("@ada", []).mentions)).toEqual([["unknown", "ada"]]);
  });
});

describe("mentionedHandles", () => {
  it("lists every handle Hermes would capture, folded the way Hermes folds it", () => {
    expect(mentionedHandles("@Ada x@BRAM `@cleo` @ada\u017f @quill. @\u212aim")).toEqual(["ada", "bram", "cleo", "adas", "quill.", "kim"]);
    expect(mentionedHandles("nothing here")).toEqual([]);
  });
});

describe("pickerAt", () => {
  it.each([
    ["@", 1, { from: 0, query: "" }],
    ["hi @c", 5, { from: 3, query: "c" }],
    ["hi @ada there", 7, { from: 3, query: "ada" }],
    ["hi @ada there", 5, { from: 3, query: "a" }],
    ["(@a", 3, { from: 1, query: "a" }],
    ["line\n@b", 7, { from: 5, query: "b" }],
    ["@\u00e5", 2, { from: 0, query: "\u00e5" }],
    ["@bram.", 6, { from: 0, query: "bram." }],
    ["@ada @", 6, { from: 5, query: "" }],
  ])("opens at the @ before the caret in %j", (text, caret, expected) => {
    expect(pickerAt(text, caret)).toEqual(expected);
  });

  it.each([
    ["no at here", 10],
    ["x@a", 3],
    ["1@a", 3],
    ["_@a", 3],
    ["\u00e9@a", 3],
    ["@ada done", 9],
    ["@a@b", 4],
    ["@a\nb", 4],
  ])("does not open in %j with the caret at %i", (text, caret) => {
    expect(pickerAt(text, caret)).toBeUndefined();
  });

  it("opens after an emoji, which is not a letter", () => {
    expect(pickerAt("\u{1f600}@a", 4)).toEqual({ from: 2, query: "a" });
  });
});

describe("pickerRows", () => {
  const roster = [ADA, BRAM, ZOE, BUDDY];
  const names = (query: string) => pickerRows(query, roster, "Everyone").map((r) => (r.kind === "seat" ? r.seat.name : "Everyone"));

  it("lists every bot in roster order, then Everyone, for an empty query", () => {
    expect(names("")).toEqual(["Ada", "Bram", ANGSTROM, "Research Buddy", "Everyone"]);
  });

  it("matches the start of the handle or of any word of the name, in any case", () => {
    expect(names("bud")).toEqual(["Research Buddy"]);
    expect(names("RES")).toEqual(["Research Buddy"]);
    expect(names("ang")).toEqual([]);
    expect(names("\u00e5")).toEqual([ANGSTROM]);
    expect(names("z")).toEqual([ANGSTROM]);
    expect(names("ddy")).toEqual([]);
  });

  it("finds Everyone by the handle all and by a word of its name", () => {
    expect(names("al")).toEqual(["Everyone"]);
    expect(names("eve")).toEqual(["Everyone"]);
  });

  it("keeps roster order, not match quality: a later word's match does not rank below an earlier seat's", () => {
    expect(pickerRows("b", [{ handle: "x", name: "Ada Bram" }, BRAM], "Everyone").map((r) => (r.kind === "seat" ? r.seat.handle : "all"))).toEqual(["x", "bram"]);
  });

  it("never folds accents: a capital A-ring finds Zo\u00eb \u00c5ngstr\u00f6m and not Ada, a plain a finds Ada and not the A-ring", () => {
    expect(names("\u00c5")).toEqual([ANGSTROM]);
    expect(names("a")).toEqual(["Ada", "Everyone"]);
    expect(names("\u00e1")).toEqual([]);
  });

  it("finds a name after an apostrophe, which is not part of a word", () => {
    expect(pickerRows("ne", [{ handle: "x", name: "O'Neil" }], "Everyone").map((r) => r.kind)).toEqual(["seat"]);
  });

  it("matches a letter typed as a base and a combining mark the same as the composed letter", () => {
    expect(names("a\u030a")).toEqual([ANGSTROM]);
    expect(names("zoe\u0308")).toEqual([ANGSTROM]);
  });

  it("matches a name stored as a base and a combining mark", () => {
    const decomposed = "A\u030angstro\u0308m";
    expect(decomposed).not.toBe("\u00c5ngstr\u00f6m");
    expect(pickerRows("\u00e5", [{ handle: "z", name: decomposed }], "Everyone").map((r) => r.kind)).toEqual(["seat"]);
  });
});

describe("completeMention", () => {
  const row = { kind: "seat", seat: BRAM } as const;

  it("replaces the typed word with the handle and a space, and puts the caret after it", () => {
    const text = "hi @br there";
    expect(completeMention(text, 6, pickerAt(text, 6)!, row)).toEqual({ text: "hi @bram  there", caret: 9 });
  });

  it("keeps what is after the caret, even the rest of a word", () => {
    const text = "@bXXX";
    expect(completeMention(text, 2, pickerAt(text, 2)!, row)).toEqual({ text: "@bram XXX", caret: 6 });
  });

  it("writes @all for Everyone", () => {
    expect(completeMention("@e", 2, pickerAt("@e", 2)!, { kind: "everyone" })).toEqual({ text: "@all ", caret: 5 });
  });

  it("writes the handle as the roster has it, capitals and all", () => {
    expect(completeMention("@z", 2, pickerAt("@z", 2)!, { kind: "seat", seat: { handle: "Zoe.x" } })).toEqual({ text: "@Zoe.x ", caret: 7 });
  });
});

describe("keyAction", () => {
  const act = (key: string, o: { shift?: boolean; composing?: boolean; pickerOpen?: boolean } = {}) => keyAction({ key, shift: false, composing: false, pickerOpen: false, ...o });

  it("does nothing while an input method is composing, with the picker open or closed", () => {
    for (const key of ["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "a"])
      for (const pickerOpen of [true, false])
        for (const shift of [true, false]) expect(act(key, { composing: true, pickerOpen, shift }), `${key} open=${pickerOpen} shift=${shift}`).toBe("none");
  });

  it("moves, picks and closes with the picker open", () => {
    expect(act("ArrowDown", { pickerOpen: true })).toBe("next");
    expect(act("ArrowUp", { pickerOpen: true })).toBe("prev");
    expect(act("Enter", { pickerOpen: true })).toBe("pick");
    expect(act("Tab", { pickerOpen: true })).toBe("pick");
    expect(act("Escape", { pickerOpen: true })).toBe("close");
    expect(act("a", { pickerOpen: true })).toBe("none");
  });

  it("keeps picking on Shift+Enter with the picker open, as the composer did", () => {
    expect(act("Enter", { pickerOpen: true, shift: true })).toBe("pick");
  });

  it("sends on Enter, and only on Enter without Shift, with the picker closed", () => {
    expect(act("Enter")).toBe("send");
    expect(act("Enter", { shift: true })).toBe("none");
    for (const key of ["Tab", "Escape", "ArrowDown", "ArrowUp", "a"]) expect(act(key), key).toBe("none");
  });
});
