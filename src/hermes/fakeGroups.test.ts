import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FakeGroups, GROUPS_BUILDS, type FakeTurn, type TurnContext } from "./fakeGroups";

const member = (profile: string, name = profile[0].toUpperCase() + profile.slice(1)) => ({ member_id: profile, profile, handle: profile, display_name: name });
const TRIO = ["ada", "bram", "cleo"].map((p) => member(p));
const ok = <T = Record<string, any>>(g: FakeGroups, method: string, params: Record<string, unknown>): T => {
  const answer = g.handle(method, params);
  if ("error" in answer) throw new Error(`${method} refused: ${answer.error.code} ${answer.error.message}`);
  return answer.result as T;
};
const refused = (g: FakeGroups, method: string, params: Record<string, unknown>) => {
  const answer = g.handle(method, params);
  return "error" in answer ? answer.error : undefined;
};
const room = (script?: (t: TurnContext) => FakeTurn, members = TRIO) => {
  const g = new FakeGroups();
  let t = 1000;
  g.now = () => (t += 1);
  if (script) g.script = script;
  ok(g, "groups.create", { room_id: "r1", name: "Crew", members });
  return g;
};
const say = (g: FakeGroups, text: string, event_id = `ev-${text}`, thread_id = "main") => ok(g, "groups.send", { room_id: "r1", event_id, payload: { thread_id, text } });
const kinds = (g: FakeGroups, from = 0) => g.log("r1").slice(from).map((e) => (e.kind === "message.member" ? `${e.actor.id}:r${e.payload.round_index}` : e.kind));
const state = (g: FakeGroups) => ok(g, "groups.state", { room_id: "r1" });
const pingpong = (t: TurnContext): FakeTurn => ({ say: `${t.name} here. @${t.handles[t.index === 0 ? 1 : 0]} your turn.` });

describe("FakeGroups rosters", () => {
  it("takes 2 to 6 members and refuses 1, 7, a profile seated twice and a member with other fields", () => {
    const g = new FakeGroups();
    const six = ["a", "b", "c", "d", "e", "f"].map((p) => member(p));
    expect(refused(g, "groups.create", { room_id: "x", name: "X", members: [TRIO[0]] })).toEqual({ code: 4110, message: "members must contain between 2 and 6 entries" });
    expect(refused(g, "groups.create", { room_id: "x", name: "X", members: [...six, member("g")] })?.message).toBe("members must contain between 2 and 6 entries");
    expect(refused(g, "groups.create", { room_id: "x", name: "X", members: [TRIO[0], { ...TRIO[1], profile: "ada" }] })?.message).toBe("member profiles must be unique");
    expect(refused(g, "groups.create", { room_id: "x", name: "X", members: [TRIO[0], { ...TRIO[1], color: "red" }] })?.code).toBe(4110);
    expect(ok(g, "groups.create", { room_id: "six", name: "Six", members: six }).room.members).toHaveLength(6);
  });

  it("makes one room for a repeated room_id, and refuses the id for a different room", () => {
    const g = room();
    expect(ok(g, "groups.create", { room_id: "r1", name: "Crew", members: TRIO }).room.idempotent).toBe(true);
    expect(refused(g, "groups.create", { room_id: "r1", name: "Crew", members: TRIO.slice(0, 2) })?.message).toBe("room_id already exists with different state");
    expect(ok(g, "groups.list", { limit: 1 }).rooms.map((r: { room_id: string }) => r.room_id)).toEqual(["r1"]);
  });

  it("fails loudly on groups.capabilities, and records every call", () => {
    const g = room();
    expect(() => g.handle("groups.capabilities", {})).toThrow(/writes a file/);
    expect(g.calls.map((c) => c.method)).toEqual(["groups.create", "groups.capabilities"]);
  });
});

describe("FakeGroups turns", () => {
  it("needs a thread, and posts a resent event once", () => {
    const g = room();
    expect(refused(g, "groups.send", { room_id: "r1", event_id: "e", payload: { text: "hi" } })).toEqual({ code: 4111, message: "thread_id is required" });
    const first = say(g, "hi", "same");
    const again = say(g, "hi", "same");
    expect([first.event.seq, again.event.seq, again.event.idempotent]).toEqual([2, 2, true]);
    expect(kinds(g)).toEqual(["room.created", "message.user"]);
  });

  it("runs one bot at a time in roster order, and settles a round that names nobody", () => {
    const g = room();
    say(g, "Hello team");
    expect(state(g).driver_status.member_activity.map((a: { status: string }) => a.status)).toEqual(["queued", "queued", "queued"]);
    expect(g.begin("r1")).toBe(true);
    expect(state(g).driver_status.member_activity[0]).toMatchObject({ member_id: "ada", status: "running", thread_id: "main", round_index: 0 });
    g.settle("r1");
    expect(kinds(g, 2)).toEqual(["ada:r0", "turn.settled", "bram:r0", "turn.settled", "cleo:r0", "turn.settled", "room.activity"]);
    expect(g.log("r1").at(-1)?.payload).toMatchObject({ status: "settled", reason_code: "silent_round" });
    expect(g.step("r1")).toBe(false);
  });

  it("brings in only the bot the owner names", () => {
    const g = room();
    say(g, "@cleo just you this time");
    g.settle("r1");
    expect(kinds(g, 2)).toEqual(["cleo:r0", "turn.settled", "room.activity"]);
  });

  it("lets a bot's mention pull a teammate into the next round, and pauses at three rounds", () => {
    const g = room(pingpong);
    say(g, "pingpong please");
    g.settle("r1");
    expect(kinds(g, 2).filter((k) => k !== "turn.settled")).toEqual(["ada:r0", "bram:r0", "cleo:r0", "ada:r1", "bram:r1", "ada:r2", "bram:r2", "room.activity"]);
    expect(g.log("r1").at(-1)?.payload).toMatchObject({ status: "bounded", reason_code: "max_rounds" });
  });

  it("pauses at ten messages when the rounds are wide", () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((p) => member(p));
    const g = room(() => ({ say: "@all again" }), six);
    say(g, "go");
    g.settle("r1");
    expect(kinds(g).filter((k) => k.includes(":r"))).toHaveLength(12);
    expect(g.log("r1").at(-1)?.payload).toMatchObject({ status: "bounded", reason_code: "max_messages" });
  });

  it("grants three more rounds a Continue, five times, on a build that has it", () => {
    const g = room(pingpong);
    const sent = say(g, "pingpong");
    g.settle("r1");
    expect(state(g).driver_status.max_continues).toBe(5);
    for (let grant = 1; grant <= 5; grant++) {
      expect(ok(g, "groups.continue", { room_id: "r1", discussion_event_id: sent.event.event_id }).event.payload.grant).toBe(grant);
      g.settle("r1");
    }
    expect(g.log("r1").filter((e) => e.kind === "message.member").at(-1)?.payload.round_index).toBe(17);
    expect(refused(g, "groups.continue", { room_id: "r1", discussion_event_id: sent.event.event_id })).toEqual({ code: 4128, message: "discussion has no continues left" });
  });

  it("has no Continue and reports no max_continues as bf0203a and f0d9488", () => {
    for (const build of [GROUPS_BUILDS.bf0203a, GROUPS_BUILDS.f0d9488]) {
      const g = room(pingpong);
      g.build = { ...build };
      const sent = say(g, "pingpong");
      g.settle("r1");
      expect(refused(g, "groups.continue", { room_id: "r1", discussion_event_id: sent.event.event_id })).toEqual({ code: -32601, message: "unknown method: groups.continue" });
      expect("max_continues" in state(g).driver_status).toBe(false);
      expect("change_events" in state(g)).toBe(false);
    }
  });

  it("names only who and their status in bf0203a's activity", () => {
    const g = room();
    g.build = { ...GROUPS_BUILDS.bf0203a };
    say(g, "hi");
    g.begin("r1");
    expect(state(g).driver_status.member_activity[0]).toEqual({ member_id: "ada", status: "running" });
  });

  it("cancels the queued turns when the owner posts on the same thread, and answers the owner first", () => {
    const g = room(pingpong);
    say(g, "pingpong");
    for (let i = 0; i < 5; i++) g.step("r1");
    const at = g.log("r1").length;
    say(g, "Owner here, stepping in");
    g.step("r1");
    expect(kinds(g, at)).toEqual(["message.user", "turn.cancelled", "ada:r0", "turn.settled"]);
    expect(g.log("r1")[at + 1].payload).toMatchObject({ reason: "superseded_by_newer_user_event", round_index: 2, member_id: "ada" });
  });

  it("queues a message on another thread behind the running discussion", () => {
    const g = room();
    say(g, "@ada first");
    say(g, "@bram second", "ev-2", "side");
    g.settle("r1");
    expect(kinds(g).filter((k) => k.includes(":r") || k === "turn.cancelled")).toEqual(["ada:r0", "bram:r0"]);
  });

  it("stops queued and running work, once a cancel id", () => {
    const g = room();
    say(g, "hi");
    g.begin("r1");
    expect(ok(g, "groups.stop", { room_id: "r1", cancel_id: "c1" })).toEqual({ cancelled: 3 });
    expect(ok(g, "groups.stop", { room_id: "r1", cancel_id: "c1" })).toEqual({ cancelled: 0 });
    expect(kinds(g, 2)).toEqual(["room.stop_requested", "turn.cancelled"]);
    expect(state(g).driver_status.member_activity).toEqual([]);
  });
});

describe("FakeGroups waits", () => {
  const asks = (t: TurnContext): FakeTurn => (t.member === "cleo" ? { approval: { command: "rm -rf /srv/tmp", description: "delete in root path" }, then: "Cleo ran it." } : { say: `${t.name} here.` });

  it("holds an approval in pending_actions until once or deny answers its exact tuple", () => {
    for (const choice of ["once", "deny"] as const) {
      const g = room(asks);
      say(g, "Cleo approve-me please");
      g.settle("r1");
      const [action] = state(g).driver_status.pending_actions;
      expect(action).toMatchObject({ kind: "approval", member_id: "cleo", execution_generation: 1, approval: { command: "rm -rf /srv/tmp", description: "delete in root path", choices: ["once", "deny"], timeout_s: 300 } });
      expect(g.step("r1"), "nothing moves while the approval waits").toBe(false);
      const tuple = { room_id: "r1", member_id: action.member_id, task_id: action.task_id, execution_generation: action.execution_generation, request_id: action.request_id };
      expect(refused(g, "groups.approve", { ...tuple, choice: "always" })?.code).toBe(5119);
      expect(refused(g, "groups.approve", { ...tuple, request_id: "other", choice: "once" })).toEqual({ code: 5119, message: "approval is no longer pending" });
      expect(ok(g, "groups.approve", { ...tuple, choice })).toMatchObject({ approved: true });
      expect(g.log("r1").filter((e) => e.kind === "message.member").at(-1)?.payload.text).toBe(choice === "once" ? "Cleo ran it." : "Cleo was told no: the command didn't run.");
      expect(refused(g, "groups.approve", { ...tuple, choice })?.code).toBe(5119);
      expect(state(g).driver_status.pending_actions).toEqual([]);
    }
  });

  it("stalls a bot in clarify with nothing pending, then moves on", () => {
    const g = room((t) => (t.member === "bram" ? { clarify: true, then: "Bram got no answer." } : { say: `${t.name} here.` }));
    say(g, "Bram clarify");
    g.step("r1");
    g.step("r1");
    expect(state(g).driver_status).toMatchObject({ pending_actions: [], member_activity: [{ member_id: "bram", status: "running", tool: "clarify" }, { member_id: "cleo", status: "queued" }] });
    g.step("r1");
    expect(g.log("r1").filter((e) => e.kind === "message.member").at(-1)?.payload).toMatchObject({ member_id: "bram", text: "Bram got no answer." });
  });

  it("lists each speaking seat's hidden session by its room", () => {
    const g = room();
    say(g, "hi");
    expect(g.liveRows()).toEqual([]);
    g.begin("r1");
    expect(g.liveRows()).toMatchObject([{ session_key: "group-r1-ada", status: "working", title: "Group: r1" }]);
  });

  it("refuses to run anything while the worker is down, and still reads", () => {
    const g = room();
    g.build.worker = false;
    expect(refused(g, "groups.send", { room_id: "r1", event_id: "e", payload: { thread_id: "main", text: "hi" } })).toEqual({ code: 4123, message: "Group Chat worker is unavailable. Restart the Hermes gateway and try again." });
    expect(refused(g, "groups.stop", { room_id: "r1" })?.code).toBe(4115);
    expect("driver_status" in state(g)).toBe(false);
    expect(ok(g, "groups.log", { room_id: "r1", since_seq: 0, limit: 50 }).latest_seq).toBe(1);
  });
});

describe("FakeGroups reads and housekeeping", () => {
  it("pages the log forward and refuses a cursor ahead of it", () => {
    const g = room();
    say(g, "hi");
    g.settle("r1");
    const page = ok(g, "groups.log", { room_id: "r1", since_seq: 2, limit: 3 });
    expect([page.events.map((e: { seq: number }) => e.seq), page.cursor, page.latest_seq, page.has_more]).toEqual([[3, 4, 5], 5, 9, true]);
    expect(refused(g, "groups.log", { room_id: "r1", since_seq: 10 })).toEqual({ code: 4112, message: "since_seq is ahead of the hosted room log" });
  });

  it("renames once an event id, and tombstones a disbanded room for good", () => {
    const g = room();
    expect(ok(g, "groups.rename", { room_id: "r1", event_id: "n1", name: "Launch" }).room.name).toBe("Launch");
    ok(g, "groups.rename", { room_id: "r1", event_id: "n1", name: "Launch" });
    expect(kinds(g)).toEqual(["room.created", "room.renamed"]);
    expect(ok(g, "groups.disband", { room_id: "r1" }).tombstone.room_id).toBe("r1");
    expect(refused(g, "groups.state", { room_id: "r1" })).toEqual({ code: 4114, message: "hosted room not found" });
    expect(ok(g, "groups.list", {}).rooms).toEqual([]);
    expect(refused(g, "groups.create", { room_id: "r1", name: "Crew", members: TRIO })?.code).toBe(4110);
  });

  it("pushes the room that moved only on a build that pushes", () => {
    const g = room();
    const pushed = vi.fn();
    g.onChange = pushed;
    say(g, "hi");
    expect(pushed).toHaveBeenCalledWith(["r1"]);
    g.build = { ...GROUPS_BUILDS.f0d9488, saysPush: true };
    pushed.mockClear();
    g.settle("r1");
    expect(pushed).not.toHaveBeenCalled();
    expect(state(g).change_events, "it says it pushes and doesn't").toBe(true);
  });

  it("answers method not found to everything on a Hermes without rooms", () => {
    const g = new FakeGroups();
    g.build.absent = true;
    expect(refused(g, "groups.list", { limit: 1 })).toEqual({ code: -32601, message: "unknown method: groups.list" });
  });

  it("runs the turns by itself when told to", () => {
    vi.useFakeTimers();
    try {
      const g = room();
      g.auto = { delayMs: 100, clarifyMs: 500 };
      say(g, "hi");
      vi.advanceTimersByTime(100);
      expect(state(g).driver_status.member_activity[0]).toMatchObject({ member_id: "ada", status: "running" });
      vi.advanceTimersByTime(100);
      expect(kinds(g, 2)).toEqual(["ada:r0", "turn.settled"]);
      vi.advanceTimersByTime(1000);
      expect(g.log("r1").at(-1)?.kind).toBe("room.activity");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("FakeGroups independence", () => {
  it("reads an @ with its own port of Hermes's rule, so a test through it can fail when the client's reader is wrong", () => {
    const source = readFileSync(new URL("./fakeGroups.ts", import.meta.url), "utf8");
    const imported = [...source.matchAll(/(?:\bfrom|\bimport\()\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imported.filter((from) => /(^|\/)(roomMentions|groupRooms)$/.test(from))).toEqual([]);
  });
});
