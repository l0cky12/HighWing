import { describe, expect, it } from "vitest";
import { completeMention, matchBots, mentionsIn } from "./mentionPicker";

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

describe("completeMention", () => {
  it("replaces the typed word with the handle and a space, and puts the caret after it", () => {
    expect(completeMention("hi @br", 3, 6, "bram")).toEqual({ text: "hi @bram ", caret: 9 });
  });

  it("adds no second space before words that follow, and leaves the caret after the one there", () => {
    expect(completeMention("hi @br there", 3, 6, "bram")).toEqual({ text: "hi @bram there", caret: 9 });
  });

  it("keeps what is after the caret, even the rest of a word", () => {
    expect(completeMention("@bXXX", 0, 2, "bram")).toEqual({ text: "@bram XXX", caret: 6 });
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

  it("names nobody for an @ glued to a word, a longer word, another case or a handle not in the roster", () => {
    expect(named("me@bram.org @bramble @Bram @cleo")).toEqual([]);
  });

  it("reads the handle up to a mark that can't be in one, so @bram. and @bram? name Bram", () => {
    expect(named("@bram. @bram?")).toEqual([
      ["bram", "@bram"],
      ["bram", "@bram"],
    ]);
  });
});
