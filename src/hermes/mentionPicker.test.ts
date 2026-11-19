import { describe, expect, it } from "vitest";
import { completeMention, keyAction, pickerAt, pickerRows } from "./mentionPicker";

type Seat = { handle: string; name: string };
const ADA: Seat = { handle: "ada", name: "Ada" };
const BRAM: Seat = { handle: "bram", name: "Bram" };
const ANGSTROM = "Zo\u00eb \u00c5ngstr\u00f6m";
const ZOE: Seat = { handle: "zoe", name: ANGSTROM };
const BUDDY: Seat = { handle: "research", name: "Research Buddy" };

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
  const names = (query: string) => pickerRows(query, roster).map((r) => r.seat.name);

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

  it("has no row for everyone: all and everyone match nothing", () => {
    expect(names("al")).toEqual([]);
    expect(names("eve")).toEqual([]);
  });

  it("keeps roster order, not match quality: a later word's match does not rank below an earlier seat's", () => {
    expect(pickerRows("b", [{ handle: "x", name: "Ada Bram" }, BRAM]).map((r) => r.seat.handle)).toEqual(["x", "bram"]);
  });

  it("never folds accents: a capital A-ring finds Zo\u00eb \u00c5ngstr\u00f6m and not Ada, a plain a finds Ada and not the A-ring", () => {
    expect(names("\u00c5")).toEqual([ANGSTROM]);
    expect(names("a")).toEqual(["Ada"]);
    expect(names("\u00e1")).toEqual([]);
  });

  it("matches a Greek name in capitals, where lowercasing makes a final sigma", () => {
    const SISYPHUS = { handle: "sisyphus", name: "\u03a3\u03af\u03c3\u03c5\u03c6\u03bf\u03c2" };
    const rows = (q: string) => pickerRows(q, [SISYPHUS]);
    expect(rows("\u03c3\u03af\u03c3")).toHaveLength(1);
    expect(rows("\u03a3\u038a\u03a3")).toHaveLength(1);
  });

  it("finds a name after an apostrophe, which is not part of a word", () => {
    expect(pickerRows("ne", [{ handle: "x", name: "O'Neil" }]).map((r) => r.kind)).toEqual(["seat"]);
  });

  it("matches a letter typed as a base and a combining mark the same as the composed letter", () => {
    expect(names("a\u030a")).toEqual([ANGSTROM]);
    expect(names("zoe\u0308")).toEqual([ANGSTROM]);
  });

  it("matches a name stored as a base and a combining mark", () => {
    const decomposed = "A\u030angstro\u0308m";
    expect(decomposed).not.toBe("\u00c5ngstr\u00f6m");
    expect(pickerRows("\u00e5", [{ handle: "z", name: decomposed }]).map((r) => r.kind)).toEqual(["seat"]);
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
