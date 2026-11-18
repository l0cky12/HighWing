import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppMethod } from "./canonicalVerbs";
import { FakeGroups, GROUPS_BUILDS, type FakeTurn, type GroupsBuild, type TurnContext } from "./fakeGroups";
import { isDraft, roomDraft, type RoomDraft } from "./groupRooms";
import { FOLLOW_MS, GroupRoomError, GroupRoomsStore, TAIL, nextReadIn, roomMarks } from "./groupRoomsStore";

const TRIO = [
  { profile: "ada", name: "Ada" },
  { profile: "bram", name: "Bram" },
  { profile: "cleo", name: "Cleo" },
];
const pingpong = (t: TurnContext): FakeTurn => ({ say: `${t.name} here. @${t.handles[t.index === 0 ? 1 : 0]} your turn.` });
const draft = (id = "r1", name = "Crew"): RoomDraft => {
  const d = roomDraft(id, name, TRIO);
  if (!isDraft(d)) throw new Error(d.problem);
  return d;
};
const flush = () => vi.advanceTimersByTimeAsync(0);

function setup(build: GroupsBuild = GROUPS_BUILDS.ae2a81cc, script?: (t: TurnContext) => FakeTurn) {
  const groups = new FakeGroups();
  groups.build = { ...build };
  if (script) groups.script = script;
  const net = { online: true, before: undefined as ((method: AppMethod) => void | Promise<void>) | undefined };
  let ids = 0;
  const store = new GroupRoomsStore({
    rpc: async (method, params) => {
      await net.before?.(method);
      if (!net.online) throw new Error("Not connected to Hermes.");
      const answer = groups.handle(method, params);
      if ("error" in answer) throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
      return answer.result;
    },
    ready: () => net.online,
    uuid: () => `id-${++ids}`,
  });
  groups.onChange = (room_ids) => store.changed({ room_ids, broadcast_id: "e1:1" });
  const stopListening = store.subscribe(() => {});
  const count = (method: string, since = 0) => groups.calls.slice(since).filter((c) => c.method === method).length;
  return { groups, store, net, count, stopListening };
}

async function withRoom(build?: GroupsBuild, script?: (t: TurnContext) => FakeTurn) {
  const t = setup(build, script);
  t.groups.seed({ id: "r1", name: "Crew", members: TRIO });
  t.store.wake();
  await flush();
  return t;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("when a room is read next", () => {
  it("is decided by whether it is on screen and whether its floor is busy", () => {
    const table = [true, false].flatMap((watched) => [true, false].map((busy) => [watched, busy, nextReadIn({ watched, busy }, false), nextReadIn({ watched, busy }, true)]));
    expect(table).toEqual([
      [true, true, 2_000, 10_000],
      [true, false, 10_000, 50_000],
      [false, true, 5_000, 25_000],
      [false, false, undefined, undefined],
    ]);
    expect(FOLLOW_MS.list).toBe(30_000);
  });
});

describe("the rooms store reading", () => {
  it("lists nothing until groups.list answers, then the rooms by name, and never asks for groups.capabilities", async () => {
    const { groups, store } = setup();
    groups.seed({ id: "r2", name: "Zeta", members: TRIO });
    groups.seed({ id: "r1", name: "Alpha", members: TRIO.slice(0, 2) });
    expect(store.list()).toBeUndefined();
    store.wake();
    expect(store.list()).toBeUndefined();
    await flush();
    expect(store.list()?.map((r) => [r.name, r.seats.length, r.floor?.kind])).toEqual([
      ["Alpha", 2, "yours"],
      ["Zeta", 3, "yours"],
    ]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(groups.calls.some((c) => c.method === "groups.capabilities")).toBe(false);
    expect([...new Set(groups.calls.map((c) => c.method))].sort()).toEqual(["groups.list", "groups.log", "groups.state"]);
  });

  it("reads the state, then the log only up to that state, so a bot is never writing beside its own reply", async () => {
    const { groups, store, net } = await withRoom();
    store.say("r1", "hi");
    await flush();
    groups.begin("r1");
    groups.handle("groups.rename", { room_id: "r1", event_id: "n1", name: "Crew two" });
    net.before = (method) => {
      if (method !== "groups.log") return;
      net.before = undefined;
      groups.step("r1");
    };
    const seen = groups.log("r1").length;
    const views: [seq: number, floor: string, replies: number][] = [];
    store.subscribe(() => {
      const v = store.room("r1")!;
      views.push([v.seq, v.floor.kind === "speaking" ? `speaking ${v.floor.seat.id}` : v.floor.kind, v.entries.filter((e) => e.kind === "reply").length]);
    });
    store.changed({ room_ids: ["r1"] });
    await flush();
    expect(views[0], "the reply posted after the state read waits for the next read").toEqual([seen, "speaking ada", 0]);
    expect(views.at(-1), "which the reply's own push brought forward").toEqual([seen + 2, "starting", 1]);
    expect(views.filter(([, floor, replies]) => floor === "speaking ada" && replies > 0)).toEqual([]);
  });

  it("reads a long room's last 50 events when first seen, its last 500 when opened, and the rest on Earlier messages", async () => {
    const { groups, store } = setup(GROUPS_BUILDS.ae2a81cc, pingpong);
    groups.seed({ id: "r1", name: "Crew", members: TRIO });
    for (let i = 0; i < 45; i++) {
      groups.handle("groups.send", { room_id: "r1", event_id: `seed-${i}`, payload: { thread_id: "main", text: "pingpong" } });
      groups.settle("r1");
    }
    const total = groups.log("r1").length;
    expect(total).toBeGreaterThan(TAIL.open + 100);
    store.wake();
    await flush();
    const first = store.room("r1")!;
    expect([first.entries[0].seq > total - TAIL.seen, first.seq, first.earlier]).toEqual([true, total, true]);
    const unwatch = store.watch("r1");
    await flush();
    const opened = store.room("r1")!;
    expect(opened.entries[0].seq).toBeGreaterThan(total - TAIL.open);
    expect(opened.entries[0].seq).toBeLessThanOrEqual(total - TAIL.open + 3);
    expect(opened.floor.kind).toBe("paused");
    await store.earlier("r1");
    const all = store.room("r1")!;
    expect([all.entries[0].seq, all.earlier, all.entries.filter((e) => e.kind === "owner").length]).toEqual([2, false, 45]);
    expect(new Set(all.entries.map((e) => e.seq)).size, "no event is drawn twice").toBe(all.entries.length);
    unwatch();
  });

  it("starts again from the tail when Hermes's log is shorter than what was read", async () => {
    const { groups, store } = await withRoom();
    store.say("r1", "hi");
    await flush();
    groups.settle("r1");
    store.changed({ room_ids: ["r1"] });
    await flush();
    expect(store.room("r1")!.seq).toBe(9);
    const fresh = new FakeGroups();
    fresh.seed({ id: "r1", name: "Crew", members: TRIO });
    fresh.handle("groups.send", { room_id: "r1", event_id: "other", payload: { thread_id: "main", text: "a new history" } });
    groups.handle = (method, params) => fresh.handle(method, params);
    store.changed({ room_ids: ["r1"] });
    await flush();
    expect(store.room("r1")).toMatchObject({ seq: 2, entries: [{ kind: "owner", text: "a new history" }] });
  });

  it("drops an answer that comes back after the connection was lost and made again", async () => {
    const { groups, store, net } = await withRoom();
    let release!: () => void;
    net.before = (method) => (method === "groups.state" ? new Promise<void>((r) => (release = r)) : undefined);
    store.changed({ room_ids: ["r1"] });
    await flush();
    net.before = undefined;
    groups.handle("groups.rename", { room_id: "r1", event_id: "n", name: "Renamed" });
    store.sleep();
    expect(store.room("r1")!.stale).toBe(true);
    store.wake();
    await flush();
    expect(store.room("r1")).toMatchObject({ name: "Renamed", stale: false });
    groups.handle = () => ({ result: { room: { room_id: "r1", name: "From the old connection", members: [], latest_seq: 1 } } });
    release();
    await flush();
    expect(store.room("r1")!.name).toBe("Renamed");
  });

  it("asks a Hermes without rooms once a connection, and nothing after", async () => {
    const { groups, store, count } = setup({ ...GROUPS_BUILDS.ae2a81cc, absent: true });
    store.wake();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect([store.list(), count("groups.list"), groups.calls.length]).toEqual([undefined, 1, 1]);
  });
});

describe("the rooms store following a room with no push", () => {
  it("reads a busy room on screen every 2 s and an idle one every 10 s", async () => {
    const { groups, store, count } = await withRoom(GROUPS_BUILDS.bf0203a);
    const unwatch = store.watch("r1");
    store.say("r1", "hi");
    await flush();
    groups.begin("r1");
    let at = groups.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(count("groups.state", at), "busy: Ada is writing").toBe(5);
    expect(store.room("r1")!.floor).toMatchObject({ kind: "speaking", seat: { name: "Ada" } });
    groups.settle("r1");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.room("r1")!.floor).toMatchObject({ kind: "yours", after: "settled" });
    at = groups.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(count("groups.state", at), "idle").toBe(3);
    unwatch();
  });

  it("reads a busy room off screen every 5 s, so its approval is seen, and an idle one only when the list shows it moved", async () => {
    const asks = (t: TurnContext): FakeTurn => (t.member === "ada" ? { approval: { command: "rm -rf /srv/tmp", description: "delete" }, then: "Done." } : { say: "ok" });
    const { groups, store, count } = await withRoom(GROUPS_BUILDS.bf0203a, asks);
    let at = groups.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect([count("groups.state", at), count("groups.list", at)], "idle and unwatched: only the list").toEqual([0, 2]);
    groups.handle("groups.send", { room_id: "r1", event_id: "elsewhere", payload: { thread_id: "main", text: "@ada run it" } });
    await vi.advanceTimersByTimeAsync(FOLLOW_MS.list);
    expect(store.room("r1")!.floor.kind, "another client woke it").toBe("starting");
    groups.step("r1");
    at = groups.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(count("groups.state", at)).toBe(2);
    expect(store.list()![0].attention).toMatchObject({ kind: "approval", needsOwner: true });
  });

  it("keeps the fast rate when Hermes only says it pushes, and slows down once a push arrives", async () => {
    const { groups, store, count } = await withRoom({ ...GROUPS_BUILDS.f0d9488, saysPush: true });
    const unwatch = store.watch("r1");
    store.say("r1", "hi");
    await flush();
    groups.begin("r1");
    let at = groups.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(count("groups.state", at), "change_events: true, and no frame yet").toBe(5);
    at = groups.calls.length;
    store.changed({ room_ids: ["r1"], broadcast_id: "e1:7" });
    await flush();
    expect(count("groups.state", at), "the push reads the room at once").toBe(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(count("groups.state", at), "then every 10 s").toBe(3);
    at = groups.calls.length;
    store.sleep();
    store.wake();
    await flush();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(count("groups.state", at), "a new connection must prove its pushes again").toBe(3);
    unwatch();
  });

  it("reads every room for a push that names none, and the list for a room it doesn't know", async () => {
    const { groups, store, count } = await withRoom();
    let at = groups.calls.length;
    store.changed({ broadcast_id: "e1:2" });
    await flush();
    expect([count("groups.state", at), count("groups.list", at)]).toEqual([1, 1]);
    groups.seed({ id: "r2", name: "Second", members: TRIO });
    at = groups.calls.length;
    await flush();
    expect(store.list()!.map((r) => r.name)).toEqual(["Crew", "Second"]);
    expect(count("groups.list", at)).toBe(1);
  });
});

describe("the rooms store's intents", () => {
  it("creates a room once for a draft, however often it is asked", async () => {
    const { groups, store } = setup();
    store.wake();
    await flush();
    const d = draft();
    await expect(store.create(d)).resolves.toBe("r1");
    await expect(store.create(d)).resolves.toBe("r1");
    expect(store.list()!.map((r) => [r.id, r.name])).toEqual([["r1", "Crew"]]);
    expect(groups.calls.find((c) => c.method === "groups.create")!.params).toEqual({
      room_id: "r1",
      name: "Crew",
      members: TRIO.map((b) => ({ member_id: b.profile, profile: b.profile, handle: b.profile, display_name: b.name })),
    });
    expect(store.room("r1")).toMatchObject({ name: "Crew", floor: { kind: "yours", after: "nothing" } });
  });

  it("says why when Hermes's room worker is down", async () => {
    const { groups, store } = setup();
    store.wake();
    groups.build.worker = false;
    const failed = await store.create(draft()).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(GroupRoomError);
    expect(failed).toMatchObject({ why: "workerDown", message: expect.stringContaining("room worker isn't running") });
  });

  it("shows the owner's message at once and keeps it until the log holds it", async () => {
    const { groups, store } = await withRoom();
    store.say("r1", "Hello team");
    expect(store.room("r1")).toMatchObject({ outgoing: [{ text: "Hello team", state: "sending" }], floor: { kind: "starting" } });
    await flush();
    const view = store.room("r1")!;
    expect(view.outgoing).toEqual([]);
    expect(view.entries.at(-1)).toMatchObject({ kind: "owner", text: "Hello team" });
    expect(groups.calls.find((c) => c.method === "groups.send")!.params).toEqual({ room_id: "r1", event_id: "id-1", payload: { thread_id: "main", text: "Hello team" } });
  });

  it("resends a failed message under its own event id, so Hermes posts it once", async () => {
    const { groups, store, net } = await withRoom();
    let lose = true;
    net.before = (method) => {
      if (method !== "groups.send" || !lose) return;
      lose = false;
      groups.handle("groups.send", { room_id: "r1", event_id: "id-1", payload: { thread_id: "main", text: "Hello team" } });
      throw new Error("Hermes didn't answer groups.send within 30 s.");
    };
    store.say("r1", "Hello team");
    await flush();
    expect(store.room("r1")!.outgoing).toMatchObject([{ eventId: "id-1", state: "failed", error: "Hermes didn't answer groups.send within 30 s." }]);
    store.retry("r1", "id-1");
    await flush();
    expect(groups.calls.filter((c) => c.method === "groups.send").map((c) => c.params.event_id)).toEqual(["id-1", "id-1"]);
    expect(groups.log("r1").filter((e) => e.kind === "message.user")).toHaveLength(1);
    expect(store.room("r1")).toMatchObject({ outgoing: [], entries: [{ kind: "owner", text: "Hello team" }] });
  });

  it("steps in on the running discussion's thread, and the cancelled turn gets its line", async () => {
    const { groups, store } = await withRoom(GROUPS_BUILDS.bf0203a, pingpong);
    groups.handle("groups.send", { room_id: "r1", event_id: "elsewhere", payload: { thread_id: "side-3", text: "pingpong" } });
    groups.step("r1");
    store.changed({ room_ids: ["r1"] });
    await flush();
    store.say("r1", "Owner here, stepping in");
    await flush();
    expect(groups.calls.filter((c) => c.method === "groups.send").at(-1)!.params.payload).toEqual({ thread_id: "side-3", text: "Owner here, stepping in" });
    expect(store.room("r1")!.entries.slice(-2)).toMatchObject([{ kind: "owner", text: "Owner here, stepping in" }, { kind: "cancelled", why: "steppedIn", seat: "bram" }]);
  });

  it("grants one Continue for two presses, and none when the bots aren't paused", async () => {
    const { groups, store, count } = await withRoom(GROUPS_BUILDS.ae2a81cc, pingpong);
    const unwatch = store.watch("r1");
    await expect(store.continue("r1")).rejects.toMatchObject({ why: "gone" });
    store.say("r1", "pingpong");
    await flush();
    groups.settle("r1");
    await vi.advanceTimersByTimeAsync(FOLLOW_MS.watchedBusy * FOLLOW_MS.pushSlowdown);
    expect(store.room("r1")!.floor).toMatchObject({ kind: "paused", rounds: 3, canContinue: true, continuesLeft: 5 });
    const [a, b] = [store.continue("r1"), store.continue("r1")];
    await Promise.all([a, b]);
    expect(count("groups.continue")).toBe(1);
    expect(store.room("r1")!.floor.kind).toBe("starting");
    unwatch();
  });

  it("offers no Continue on bf0203a: Carry on names the last round's bots and sends nothing", async () => {
    const { groups, store, count } = await withRoom(GROUPS_BUILDS.bf0203a, pingpong);
    store.say("r1", "pingpong");
    await flush();
    groups.settle("r1");
    await vi.advanceTimersByTimeAsync(FOLLOW_MS.unwatchedBusy);
    expect(store.room("r1")!.floor).toMatchObject({ kind: "paused", canContinue: false });
    const sends = count("groups.send");
    expect(store.carryOn("r1")).toBe("@bram @ada ");
    await expect(store.continue("r1")).rejects.toMatchObject({ why: "gone" });
    await flush();
    expect([count("groups.send"), count("groups.continue")]).toEqual([sends, 0]);
  });

  it("answers an approval by its key, and takes one Hermes no longer waits on as answered", async () => {
    const asks = (t: TurnContext): FakeTurn => (t.member === "cleo" ? { approval: { command: "rm -rf /srv/tmp", description: "delete in root path" }, then: "Cleo ran it." } : { say: `${t.name} here.` });
    const { groups, store } = await withRoom(GROUPS_BUILDS.bf0203a, asks);
    store.say("r1", "Cleo approve-me please");
    await flush();
    groups.settle("r1");
    await vi.advanceTimersByTimeAsync(FOLLOW_MS.unwatchedBusy);
    const floor = store.room("r1")!.floor;
    if (floor.kind !== "approval") throw new Error(`floor is ${floor.kind}`);
    expect(floor).toMatchObject({ seat: { name: "Cleo" }, approval: { command: "rm -rf /srv/tmp", description: "delete in root path" } });
    await store.answer("r1", floor.approval.key, "once");
    expect(groups.calls.find((c) => c.method === "groups.approve")!.params).toMatchObject({ room_id: "r1", member_id: "cleo", execution_generation: 1, choice: "once" });
    expect(store.room("r1")!.entries.at(-1)).toMatchObject({ kind: "reply", seat: "cleo", text: "Cleo ran it." });
    await expect(store.answer("r1", floor.approval.key, "deny"), "answered already: no error").resolves.toBeUndefined();
  });

  it("stops the room with a cancel id of its own each press", async () => {
    const { groups, store } = await withRoom();
    store.say("r1", "hi");
    await flush();
    groups.begin("r1");
    await store.stop("r1");
    await store.stop("r1");
    expect(groups.calls.filter((c) => c.method === "groups.stop").map((c) => c.params.cancel_id)).toEqual(["id-2", "id-3"]);
    expect(store.room("r1")!.floor).toEqual({ kind: "yours", after: "stopped", asked: undefined });
  });

  it("renames a room, and shows a disbanded one as gone while it is on screen", async () => {
    const { store } = await withRoom();
    const unwatch = store.watch("r1");
    await flush();
    await store.rename("r1", "Launch crew");
    expect([store.room("r1")!.name, store.list()![0].name]).toEqual(["Launch crew", "Launch crew"]);
    await store.disband("r1");
    expect(store.room("r1")!.floor).toEqual({ kind: "gone" });
    expect(store.list()).toEqual([]);
    unwatch();
  });

  it("refuses a write while not connected, in the owner's words", async () => {
    const { store, net } = await withRoom();
    net.online = false;
    await expect(store.stop("r1")).rejects.toMatchObject({ why: "offline", message: "Not connected to Hermes." });
    store.say("r1", "hi");
    await flush();
    expect(store.room("r1")!.outgoing).toMatchObject([{ state: "failed", error: "Not connected to Hermes." }]);
    store.discard("r1", store.room("r1")!.outgoing[0].eventId);
    expect(store.room("r1")!.outgoing).toEqual([]);
  });
});

describe("a store nobody listens to", () => {
  it("asks Hermes nothing, and starts reading when a screen subscribes", async () => {
    const { groups, store, stopListening } = setup();
    groups.seed({ id: "r1", name: "Crew", members: TRIO });
    stopListening();
    store.wake();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(groups.calls).toEqual([]);
    const stop = store.subscribe(() => {});
    await flush();
    expect(store.list()!.map((r) => r.name)).toEqual(["Crew"]);
    stop();
    const at = groups.calls.length;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(groups.calls.length, "and stops when the last one leaves").toBe(at);
  });
});

describe("what the owner has read", () => {
  it("tells of a finished discussion until the room is opened, and keeps that on this computer", async () => {
    const items: Record<string, string> = {};
    const storage = { getItem: (k: string) => items[k] ?? null, setItem: (k: string, v: string) => void (items[k] = v) };
    const { groups, store } = await withRoom(GROUPS_BUILDS.bf0203a);
    store.keepMarks(roomMarks(storage, "server"));
    groups.handle("groups.send", { room_id: "r1", event_id: "elsewhere", payload: { thread_id: "main", text: "hi" } });
    groups.settle("r1");
    await vi.advanceTimersByTimeAsync(FOLLOW_MS.list + FOLLOW_MS.unwatchedBusy);
    expect(store.list()![0].attention).toMatchObject({ kind: "completed", summary: "The bots are done." });
    const unwatch = store.watch("r1");
    await flush();
    expect(store.list()![0].attention).toBeUndefined();
    unwatch();
    expect(JSON.parse(items["hermes-chat.group-rooms-read.server"])).toEqual({ r1: 9 });

    const again = setup(GROUPS_BUILDS.bf0203a);
    again.groups.handle = (method, params) => groups.handle(method, params);
    again.store.keepMarks(roomMarks(storage, "server"));
    again.store.wake();
    await flush();
    expect(again.store.list()![0].attention, "read before the app was closed").toBeUndefined();
  });
});
