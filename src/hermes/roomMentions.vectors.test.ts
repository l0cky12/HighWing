import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FakeGroups, resolveMentions } from "./fakeGroups";
import { goesTo, type Recipients } from "./roomMentions";

type Vector = { text: string; roster: string[]; handles: { defaultAll: string[]; namedOnly: string[] } };
const vectors = JSON.parse(readFileSync(new URL("./roomMentionVectors.json", import.meta.url), "utf8")) as { hermes: string; sourceHash: string; cases: Vector[] };

const shown = (text: string) => JSON.stringify(text).replace(/[^\x20-\x7e]/gu, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
const named = (roster: readonly string[]) => roster.map((handle) => ({ handle }));
const handlesOf = (to: Recipients<{ handle: string }>, roster: readonly string[]) => (to.kind === "seats" ? to.seats.map((s) => s.handle) : [...roster]);

const fakeFirstRound = (text: string, roster: readonly string[]): string[] => {
  const g = new FakeGroups();
  const members = roster.map((h) => ({ member_id: h, profile: h, handle: h }));
  g.handle("groups.create", { room_id: "r", name: "R", members });
  g.handle("groups.send", { room_id: "r", event_id: "e", payload: { thread_id: "main", text } });
  const state = g.handle("groups.state", { room_id: "r" }) as { result: { driver_status: { member_activity: { member_id: string }[] } } };
  return state.result.driver_status.member_activity.map((a) => a.member_id);
};

describe("Hermes's routing, cut from its source by scripts/room-mention-vectors.py", () => {
  it("has vectors from a Hermes build", () => {
    expect(vectors.hermes).toMatch(/^[0-9a-f]{7,40}$/);
    expect(vectors.cases.length).toBeGreaterThan(400);
  });

  it("covers the four letters Python's ignore-case adds, at the head and the tail of a handle", () => {
    for (const ch of ["\u0130", "\u0131", "\u017f", "\u212a"]) {
      expect(vectors.cases.some((c) => c.text.startsWith(`@${ch}`)), `head ${shown(ch)}`).toBe(true);
      expect(vectors.cases.some((c) => c.text.endsWith(`ada${ch}`)), `tail ${shown(ch)}`).toBe(true);
    }
  });

  describe.each(vectors.cases.map((c) => [`${shown(c.text)} in ${c.roster.join(",")}`, c] as const))("%s", (_, v) => {
    it("the client reads it as Hermes does", () => {
      expect(handlesOf(goesTo(v.text, named(v.roster)).to, v.roster)).toEqual(v.handles.defaultAll);
    });

    it("the stand-in's resolveMentions reads it as Hermes does, for an owner's message and for a bot's reply", () => {
      const members = named(v.roster);
      expect(resolveMentions([v.text], members, true).map((m) => m.handle)).toEqual(v.handles.defaultAll);
      expect(resolveMentions([v.text], members, false).map((m) => m.handle)).toEqual(v.handles.namedOnly);
    });

    it.skipIf(!v.text.trim())("the stand-in server sends it to the same bots", () => {
      expect(fakeFirstRound(v.text, v.roster)).toEqual(v.handles.defaultAll);
    });
  });
});
