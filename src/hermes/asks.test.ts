import { describe, expect, it } from "vitest";
import { askStamp, askStampBlock, askTargets, askTurnIn, placeAsks, revive, toStoredAsk, type Ask, type AskId } from "./asks";
import { storedReferences, referenceBlock } from "./chatReferences";
import { typedText } from "./branch";
import { PICK_MARK } from "./mentionPicker";
import { withContext } from "./projectContext";
import type { Item } from "./model";

const ID = "k3j9x0q2ab" as AskId;
const bots = [
  { profile: "beta", handle: "beta", name: "Beta" },
  { profile: "gamma", handle: "gamma", name: "Gamma" },
  { profile: "default", handle: "hermes", name: "Hermes" },
];

describe("askTargets", () => {
  it("names each bot once, in the order first named, as the pills do", () => {
    expect(askTargets("@gamma and @beta, then @GAMMA again", bots, "named").map((b) => b.profile)).toEqual(["gamma", "beta"]);
    expect(askTargets("ask @hermes", bots, "named").map((b) => b.profile)).toEqual(["default"]);
  });

  it("names nobody in an address, a longer word, or a message without pills", () => {
    expect(askTargets("me@beta.org @betamax @nobody hello", bots, "named")).toEqual([]);
  });

  it("names only the bots picked from the menu under the picked rule, and nobody under the none rule", () => {
    const text = `@gamma and @${PICK_MARK}beta, then @${PICK_MARK}GAMMA again`;
    expect(askTargets(text, bots, "picked").map((b) => b.profile)).toEqual(["beta", "gamma"]);
    expect(askTargets(text, bots, "none")).toEqual([]);
  });
});

describe("the stamp", () => {
  const block = askStampBlock(ID, { name: "Alpha", handle: "alpha" });
  const sent = withContext("@beta what do you think?", [block, referenceBlock({ title: "Bot Chat with Alpha", summary: "We planned backups." })]);

  it("is read back from what follows the typed words, and hidden from them", () => {
    expect(askStamp(sent)).toBe(ID);
    expect(typedText(sent)).toBe("@beta what do you think?");
  });

  it("is never read into a reference's summary", () => {
    expect(storedReferences(sent)).toEqual([{ title: "Bot Chat with Alpha", summary: "We planned backups." }]);
  });

  it("counts only in the attached part: the same line typed by the owner is not one", () => {
    expect(askStamp(`[Asked from: Bot Chat with Alpha · ${ID}]`)).toBeUndefined();
  });
});

describe("askTurnIn", () => {
  const stamped = (id: number) => ({ id, role: "user", content: withContext("@beta hi", [askStampBlock(ID, { name: "Alpha", handle: "alpha" })]) });

  it("reads the turn after the stamped message, up to the next one the owner typed", () => {
    const rows = [
      { id: 1, role: "user", content: "earlier" },
      stamped(2),
      { id: 3, role: "assistant", content: "" },
      { id: 4, role: "tool", content: "{}" },
      { id: 5, role: "assistant", content: "Friday." },
      { id: 6, role: "user", content: "next", display_kind: "hidden" },
      { id: 7, role: "user", content: "next" },
      { id: 8, role: "assistant", content: "Not ours." },
    ];
    expect(askTurnIn(rows, ID)).toEqual({ row: 2, reply: "Friday.", ended: true });
  });

  it("says a turn still has no end, and finds nothing for another ask", () => {
    expect(askTurnIn([stamped(2), { id: 3, role: "assistant", content: "Fri" }], ID)).toEqual({ row: 2, reply: "Fri", ended: false });
    expect(askTurnIn([stamped(2)], "other00000" as AskId)).toBeUndefined();
  });
});

describe("placeAsks", () => {
  const items = [
    { kind: "user", id: "u1", text: "a", rowId: 10 },
    { kind: "assistant", id: "a1", text: "b", rowId: 11 },
    { kind: "user", id: "u2", text: "c", rowId: 20 },
    { kind: "assistant", id: "a2", text: "d" },
  ] as Item[];
  const ask = (id: string, at: number, afterRow?: number) => ({ id, at, afterRow, text: "", titles: [], targets: [] }) as unknown as Ask;

  it("puts a card before the first message stored after it was asked, else at the end, in the order asked", () => {
    const placed = placeAsks(items, [ask("b", 2, 11), ask("a", 1, 11), ask("c", 3, 20), ask("d", 4)]);
    expect(placed.get("u2")?.map((a) => a.id)).toEqual(["a", "b"]);
    expect(placed.get(null)?.map((a) => a.id)).toEqual(["c"]);
    expect(placed.get("u1")?.map((a) => a.id)).toEqual(["d"]);
  });

  it("keeps a card asked while a reply ran below that reply once it is stored", () => {
    const asked = ask("e", 5, 20);
    expect([...placeAsks(items, [asked]).keys()]).toEqual([null]);
    const stored = items.map((i) => (i.id === "a2" ? { ...i, rowId: 21 } : i));
    expect([...placeAsks(stored, [asked]).keys()]).toEqual([null]);
  });
});

describe("what a launch finds", () => {
  const base = { id: ID, text: "hi", at: 1, titles: [] };
  const t = { profile: "beta", handle: "beta", name: "Beta" };

  it("turns what was under way into what it can be now", () => {
    const a: Ask = {
      ...base,
      targets: [
        { ...t, state: "sending" },
        { ...t, profile: "b2", state: "sending", out: { session: "s" } },
        { ...t, profile: "b3", state: "answering", seat: { session: "s" }, reply: "half" },
        { ...t, profile: "b4", state: "waiting", why: "busy", seat: { session: "s" } },
        { ...t, profile: "b5", state: "answered", seat: { session: "s" }, reply: "done", ended: "complete" },
      ],
    };
    expect(revive(a).targets.map((x) => [x.state, "why" in x ? x.why : "cause" in x ? x.cause : undefined])).toEqual([
      ["failed", "closed"],
      ["unknown", undefined],
      ["waiting", "reading"],
      ["waiting", "reading"],
      ["answered", undefined],
    ]);
  });

  it("drops what isn't an ask", () => {
    expect(toStoredAsk({ ...base, targets: [{ ...t, state: "answered", seat: { session: "s" }, reply: "x", ended: "complete" }] })).toBeDefined();
    expect(toStoredAsk({ ...base, targets: [] })).toBeUndefined();
    expect(toStoredAsk({ ...base, targets: [{ ...t, state: "nonsense" }] })).toBeUndefined();
    expect(toStoredAsk("nope")).toBeUndefined();
  });
});
