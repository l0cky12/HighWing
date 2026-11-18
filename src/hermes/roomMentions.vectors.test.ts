import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FakeGroups } from "./fakeGroups";

type Vector = { text: string; roster: string[]; handles: { defaultAll: string[]; namedOnly: string[] } };
const vectors = JSON.parse(readFileSync(new URL("./roomMentionVectors.json", import.meta.url), "utf8")) as { hermes: string; sourceHash: string; cases: Vector[] };

const shown = (text: string) => JSON.stringify(text).replace(/[^\x20-\x7e]/gu, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);

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

  describe.each(vectors.cases.filter((c) => c.text.trim()).map((c) => [shown(c.text) + " in " + c.roster.join(","), c] as const))("%s", (_, v) => {
    it("the stand-in server routes it as Hermes does", () => {
      expect(fakeFirstRound(v.text, v.roster)).toEqual(v.handles.defaultAll);
    });
  });
});
