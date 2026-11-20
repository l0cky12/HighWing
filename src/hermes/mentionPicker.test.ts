import { describe, expect, it } from "vitest";
import { atQuery } from "./chatReferences";
import { PICK_MARK, completeMention, matchBots, mentionsFor, mentionsIn, withPicks, withoutPick } from "./mentionPicker";

type Bot = { handle: string; name: string };

const ADA: Bot = { handle: "ada", name: "Ada" };
const BRAM: Bot = { handle: "bram", name: "Bram" };
const ANGSTROM = "Zo\u00eb \u00c5ngstr\u00f6m";
const ZOE: Bot = { handle: "zoe", name: ANGSTROM };
const BUDDY: Bot = { handle: "research", name: "Research Buddy" };

describe("matchBots", () => {
  const roster = [ADA, BRAM, ZOE, BUDDY];
  const names = (query: string) => matchBots(query, roster).map((b) => b.name);

  it("lists every bot in roster order for an empty query", () => {
    expect(names("")).toEqual(["Ada", "Bram", ANGSTROM, "Research Buddy"]);
  });

  it("matches the start of the handle or of any word of the name, in any case", () => {
    expect(names("bud")).toEqual(["Research Buddy"]);
    expect(names("RES")).toEqual(["Research Buddy"]);
    expect(names("ang")).toEqual([]);
    expect(names("\u00e5")).toEqual([ANGSTROM]);
    expect(names("z")).toEqual([ANGSTROM]);
    expect(names("ddy")).toEqual([]);
  });

  it("keeps roster order, not match quality: a later word's match does not rank below an earlier bot's", () => {
    expect(matchBots("b", [{ handle: "x", name: "Ada Bram" }, BRAM]).map((b) => b.handle)).toEqual(["x", "bram"]);
  });

  it("puts the bot whose handle is the query first, so @hermes and Tab pick @hermes when the default bot is named Hermes", () => {
    const roster = [{ handle: "default", name: "Hermes" }, { handle: "hermes", name: "Hermes" }, ADA];
    expect(matchBots("hermes", roster).map((b) => b.handle)).toEqual(["hermes", "default"]);
    expect(matchBots("HERMES", roster).map((b) => b.handle)).toEqual(["hermes", "default"]);
    expect(matchBots("herm", roster).map((b) => b.handle)).toEqual(["default", "hermes"]);
  });

  it("never folds accents: a capital A-ring finds Zo\u00eb \u00c5ngstr\u00f6m and not Ada, a plain a finds Ada and not the A-ring", () => {
    expect(names("\u00c5")).toEqual([ANGSTROM]);
    expect(names("a")).toEqual(["Ada"]);
    expect(names("\u00e1")).toEqual([]);
  });

  it("never folds an accent the owner types: @\u00e9 does not find Eve", () => {
    expect(matchBots("\u00e9", [{ handle: "eve", name: "Eve" }])).toEqual([]);
    expect(matchBots("e", [{ handle: "eve", name: "Eve" }])).toHaveLength(1);
  });

  it("matches a Greek name in capitals, where lowercasing makes a final sigma", () => {
    const SISYPHUS = { handle: "sisyphus", name: "\u03a3\u03af\u03c3\u03c5\u03c6\u03bf\u03c2" };
    const rows = (q: string) => matchBots(q, [SISYPHUS]);
    expect(rows("\u03c3\u03af\u03c3")).toHaveLength(1);
    expect(rows("\u03a3\u038a\u03a3")).toHaveLength(1);
  });

  it("finds a name after an apostrophe, which is not part of a word", () => {
    expect(matchBots("ne", [{ handle: "x", name: "O'Neil" }])).toHaveLength(1);
  });

  it("matches a letter typed as a base and a combining mark the same as the composed letter", () => {
    expect(names("a\u030a")).toEqual([ANGSTROM]);
    expect(names("zoe\u0308")).toEqual([ANGSTROM]);
  });

  it("matches a name stored as a base and a combining mark", () => {
    const decomposed = "A\u030angstro\u0308m";
    expect(decomposed).not.toBe("\u00c5ngstr\u00f6m");
    expect(matchBots("\u00e5", [{ handle: "z", name: decomposed }])).toHaveLength(1);
  });
});

describe("what the @ menu reads, matched", () => {
  const found = (typed: string, bots: Bot[]) => matchBots(atQuery(typed)!.query, bots).map((b) => b.handle);

  it("keeps a combining mark in the query, so a name written with one is still found as it is typed", () => {
    expect(found("hi @a\u030a", [ADA, ZOE])).toEqual(["zoe"]);
    expect(found("@\u0935\u093f", [{ handle: "vikram", name: "\u0935\u093f\u0915\u094d\u0930\u092e" }])).toEqual(["vikram"]);
  });
});

describe("completeMention", () => {
  it("replaces the typed word with the handle and a space, and puts the caret after it", () => {
    expect(completeMention("hi @br", 3, 6, "bram")).toEqual({ text: `hi @${PICK_MARK}bram `, caret: 10 });
  });

  it("adds no second space before words that follow, and leaves the caret after the one there", () => {
    expect(completeMention("hi @br there", 3, 6, "bram")).toEqual({ text: `hi @${PICK_MARK}bram there`, caret: 10 });
  });

  it("adds a space before a new line rather than taking the line break for one", () => {
    expect(completeMention("@br\nnext", 0, 3, "bram")).toEqual({ text: `@${PICK_MARK}bram \nnext`, caret: 7 });
  });

  it("keeps what is after the caret, even the rest of a word", () => {
    expect(completeMention("@bXXX", 0, 2, "bram")).toEqual({ text: `@${PICK_MARK}bram XXX`, caret: 7 });
  });

  it("writes the pick mark right after the @, so the pill it makes is a picked one", () => {
    const done = completeMention("what does @br", 10, 13, "bram");
    expect(done.text).toBe("what does @\u200Dbram ");
    expect(mentionsIn(done.text, [BRAM]).map((m) => m.picked)).toEqual([true]);
  });

  it("adds no step for the caret: the @ and the mark are one grapheme, so @bram is as many stops as it has letters", () => {
    const graphemes = (s: string) => [...new Intl.Segmenter().segment(s)].length;
    expect(graphemes(`@${PICK_MARK}bram`)).toBe(graphemes("@bram"));
  });
});

describe("mentionsIn", () => {
  const roster = [ADA, BRAM];
  const named = (text: string) => mentionsIn(text, roster).map((m) => [m.bot.handle, text.slice(m.start, m.end)]);

  it("finds each handle of the roster that starts the text or follows a space", () => {
    expect(named("@bram and\n@ada, look")).toEqual([
      ["bram", "@bram"],
      ["ada", "@ada"],
    ]);
  });

  it("names nobody for an @ glued to a word, a longer word or a handle not in the roster", () => {
    expect(named("me@bram.org @bramble @cleo")).toEqual([]);
  });

  it("reads a handle in any case, as Hermes folds it and the menu matches it", () => {
    expect(named("@BRAM @Bram @aDa")).toEqual([
      ["bram", "@BRAM"],
      ["bram", "@Bram"],
      ["ada", "@aDa"],
    ]);
  });

  it("ends a handle at a space, the end, or sentence marks before either, so @bram, @bram. and @bram?! name Bram", () => {
    expect(named("@bram, what @bram.\n@bram?! ask @bram.")).toEqual([
      ["bram", "@bram"],
      ["bram", "@bram"],
      ["bram", "@bram"],
      ["bram", "@bram"],
    ]);
    expect(named("@ada; @ada: @ada!")).toEqual([
      ["ada", "@ada"],
      ["ada", "@ada"],
      ["ada", "@ada"],
    ]);
  });

  it("names nobody where the handle runs on into a longer token, as Hermes reads @bram.com as one handle", () => {
    expect(named("see @bram.com @ada's @ada) @bram.:x @ada\u{1f600} @bram/ @ada\"")).toEqual([]);
  });
});

describe("a picked mention and a typed one", () => {
  const roster = [ADA, BRAM];
  const marked = (handle: string) => `@${PICK_MARK}${handle}`;

  it("tells them apart by the mark after the @, and takes the mark into the mention's range", () => {
    const text = `${marked("bram")} and @ada`;
    const found = mentionsIn(text, roster);
    expect(found.map((m) => [m.bot.handle, m.picked])).toEqual([
      ["bram", true],
      ["ada", false],
    ]);
    expect([found[0].start, found[0].end]).toEqual([0, marked("bram").length]);
    expect(text.slice(found[0].start, found[0].end)).toBe(marked("bram"));
  });

  it("reads a marked handle by the same rules as a typed one", () => {
    expect(mentionsIn(`see ${marked("BRAM")}, ${marked("ada")}?! me${marked("ada")} ${marked("cleo")} ${marked("bramble")}`, roster).map((m) => [m.bot.handle, m.picked])).toEqual([
      ["bram", true],
      ["ada", true],
    ]);
  });

  it("counts a doubled mark, or a mark with no @, as no mention", () => {
    expect(mentionsIn(`@${PICK_MARK}${PICK_MARK}bram ${PICK_MARK}@bram x${PICK_MARK}`, roster)).toEqual([]);
  });

  it.each([
    ["named", ["bram", "ada"]],
    ["picked", ["bram"]],
    ["none", []],
  ] as const)("counts, under the rule %s, these of a typed and a picked mention: %j", (rule, handles) => {
    expect(mentionsFor(`${marked("bram")} @ada`, roster, rule).map((m) => m.bot.handle)).toEqual(handles);
  });

  it("strips the mark from every @ that has one and from nothing else", () => {
    expect(withoutPick(`${marked("bram")} hi ${marked("ada")}, a family \u{1F468}\u200D\u{1F469}\u200D\u{1F467} and a@${PICK_MARK}b`)).toBe(
      "@bram hi @ada, a family \u{1F468}\u200D\u{1F469}\u200D\u{1F467} and a@b",
    );
    expect(withoutPick("plain @bram")).toBe("plain @bram");
  });

  it("puts the mark on a typed mention and leaves a picked one alone", () => {
    expect(withPicks(`@bram hi ${marked("ada")} @ada me@bram.org`, [BRAM, ADA])).toBe(`${marked("bram")} hi ${marked("ada")} ${marked("ada")} me@bram.org`);
    expect(withPicks("@bram @ada", [BRAM])).toBe(`${marked("bram")} @ada`);
  });

  describe("an ordinary sentence with an @handle in it", () => {
    const bots = [
      { handle: "bram", name: "Bram" },
      { handle: "hermes", name: "Hermes" },
      { handle: "work", name: "Work" },
    ];
    const probes = ["What did @bram say about the budget?", "Rewrite this tweet: thanks @hermes for the help!", "@work is my job profile, explain it"];

    it.each(probes)("asks nobody in an ordinary chat, where only a picked bot asks: %s", (text) => {
      expect(mentionsFor(text, bots, "picked")).toEqual([]);
    });

    it.each(probes)("asks the bot in a Bot Chat, where a typed one does too: %s", (text) => {
      expect(mentionsFor(text, bots, "named")).toHaveLength(1);
    });

    it("asks the bot when the owner picked it in the same sentence", () => {
      expect(mentionsFor(`What did ${marked("bram")} say about the budget?`, bots, "picked").map((m) => m.bot.handle)).toEqual(["bram"]);
    });
  });
});
