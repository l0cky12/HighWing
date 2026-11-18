import { describe, expect, it } from "vitest";
import {
  EMPTY_LOG,
  FLOOR_SURFACE,
  asksOwner,
  attentionOf,
  carryOnDraft,
  changedRooms,
  floorOf,
  foldRoom,
  isDraft,
  logAfter,
  memberSessionRoom,
  parseList,
  parseLog,
  parseState,
  roomDraft,
  roomParams,
  roomView,
  type Floor,
  type RoomLive,
  type RoomLog,
  type Seat,
} from "./groupRooms";
import { ROOM_PROBE_LOG, ROOM_PROBE_SEATS } from "./groupRoomsProbe.fixture";

const seats: Seat[] = [...ROOM_PROBE_SEATS];
const members = seats.map((s) => ({ member_id: s.id, profile: s.profile, handle: s.handle, display_name: s.name }));
const page = (rows: readonly Record<string, unknown>[], latest = 100) => parseLog({ events: rows, cursor: rows.at(-1)?.seq ?? 0, latest_seq: latest, has_more: false });
const probe = page(ROOM_PROBE_LOG).events;

/** A `groups.state` answer as `ae2a81cc` writes one, quiet unless `driver` says otherwise. */
const state = (seq: number, driver: Record<string, unknown> = {}, room: Record<string, unknown> = {}) =>
  parseState({
    room: { room_id: "probe", name: "Probe", members, latest_seq: seq, ...room },
    driver_status: { running: true, pending_actions: [], member_activity: [], max_continues: 5, ...driver },
    change_events: true,
  })!;
const fold = (upTo: number, from: RoomLog = EMPTY_LOG) => foldRoom(from, probe, seats, upTo);
const floorAt = (seq: number, driver?: Record<string, unknown>) => floorOf(fold(seq), state(seq, driver), []);

describe("the fold of a real room's log", () => {
  it("names the floor after every event, with nothing live but the log", () => {
    const kinds = ROOM_PROBE_LOG.map((_, i) => floorAt(i + 1).kind);
    const runs: [kind: Floor["kind"], from: number, to: number][] = [];
    kinds.forEach((kind, i) => (runs.at(-1)?.[0] === kind ? (runs.at(-1)![2] = i + 1) : runs.push([kind, i + 1, i + 1])));
    expect(runs).toEqual([
      ["starting", 1, 7],
      ["yours", 8, 8],
      ["starting", 9, 15],
      ["yours", 16, 16],
      ["starting", 17, 31],
      ["paused", 32, 32],
      ["starting", 33, 45],
      ["paused", 46, 46],
      ["starting", 47, 53],
      ["yours", 54, 54],
      ["starting", 55, 61],
      ["yours", 62, 62],
      ["starting", 63, 69],
      ["yours", 70, 70],
      ["starting", 71, 73],
      ["yours", 74, 74],
      ["starting", 75, 100],
    ]);
  });

  it("pauses at three rounds with Continue while any are left, and counts the one used", () => {
    expect(floorAt(32), "the first pause").toEqual({ kind: "paused", reason: "rounds", rounds: 3, canContinue: true, continuesLeft: 5, asked: undefined });
    expect(floorAt(46), "the pause after Continue").toMatchObject({ kind: "paused", rounds: 6, canContinue: true, continuesLeft: 4 });
    expect(floorAt(46, { max_continues: 1 }), "none left").toMatchObject({ kind: "paused", canContinue: false, continuesLeft: 0 });
  });

  it("offers no Continue on a Hermes whose state reports no max_continues", () => {
    const older = floorOf(fold(32), state(32, { max_continues: undefined }), []);
    expect(older).toMatchObject({ kind: "paused", canContinue: false });
    expect((older as Extract<Floor, { kind: "paused" }>).continuesLeft).toBeUndefined();
  });

  it("draws whole replies, the cap, Continue and the turn the owner's message cancelled", () => {
    const log = fold(100);
    expect(log.entries.filter((e) => e.kind === "owner")).toHaveLength(9);
    expect(log.entries.filter((e) => e.kind === "reply")).toHaveLength(41);
    expect(log.entries.filter((e) => e.kind === "pause").map((e) => [e.seq, e.rounds])).toEqual([
      [32, 3],
      [46, 6],
    ]);
    expect(log.entries.find((e) => e.kind === "continued")?.seq).toBe(33);
    expect(log.entries.find((e) => e.kind === "cancelled")).toEqual({ kind: "cancelled", seq: 87, at: 1763400261000, seat: "ada", why: "steppedIn" });
    expect(log.entries.find((e) => e.seq === 72)).toMatchObject({ kind: "reply", seat: "cleo", round: 0 });
    expect(log.discussion).toMatchObject({ id: "0f80177e0c31146164a0", thread: "main", status: "open", round: 2, replies: 7 });
  });

  it("keeps the newer discussion when the turn it cancelled is logged after the owner's message", () => {
    expect(fold(87).discussion).toMatchObject({ id: "0f80177e0c31146164a0", status: "open", replies: 0 });
  });

  it("is the same however the pages are cut, and when a page is replayed", () => {
    const whole = fold(100);
    let paged = EMPTY_LOG;
    for (let upTo = 7; upTo <= 105; upTo += 7) paged = foldRoom(foldRoom(paged, probe, seats, upTo), probe, seats, upTo);
    expect(paged).toEqual(whole);
    expect(foldRoom(whole, probe, seats, 100), "nothing new").toBe(whole);
  });

  it("never folds past the state read it is shown with", () => {
    expect(fold(40).seq).toBe(40);
    expect(fold(40).entries.every((e) => e.seq <= 40)).toBe(true);
  });

  it("reads a room from its tail and says older events wait", () => {
    const tail = foldRoom(logAfter(74), probe, seats, 100);
    expect(tail.entries[0]).toMatchObject({ kind: "owner", seq: 75 });
    expect(roomView("probe", tail, state(100), [], 0, { stale: false, readAt: 1 }).earlier).toBe(true);
    const mid = foldRoom(logAfter(90), probe, seats, 100);
    expect(mid.discussion, "a tail that starts inside a discussion learns it from a reply").toMatchObject({ id: "0f80177e0c31146164a0", thread: "main", round: 2 });
  });
});

describe("the floor", () => {
  const running = (member_id: string, extra: Record<string, unknown> = {}) => ({ member_id, status: "running", thread_id: "main", round_index: 1, started_at: 1763400100, ...extra });
  const queued = (member_id: string) => ({ member_id, status: "queued", thread_id: "main", round_index: 1 });
  const approval = { kind: "approval", member_id: "cleo", task_id: "t9", execution_generation: 2, request_id: "rq-1", approval: { command: "rm -rf /srv/tmp", description: "delete in root path", choices: ["once", "deny"], timeout_s: 300 } };

  it("says who is writing, in which tool, and who is next", () => {
    expect(floorAt(24, { member_activity: [running("bram", { tool: "terminal" }), queued("cleo")] })).toEqual({
      kind: "speaking",
      seat: seats[1],
      round: 1,
      since: 1763400100000,
      tool: "terminal",
      stopping: false,
      next: [seats[2]],
    });
  });

  it("reads the older builds' activity, which names only who and their status", () => {
    const older = floorOf(fold(24), state(24, { member_activity: [{ member_id: "bram", status: "running" }], max_continues: undefined }), []);
    expect(older).toMatchObject({ kind: "speaking", seat: seats[1], tool: undefined, round: undefined });
  });

  it("puts an approval before the bot that is waiting on it", () => {
    const floor = floorAt(67, { member_activity: [running("cleo", { tool: "terminal" }), queued("ada")], pending_actions: [approval] });
    expect(floor).toMatchObject({ kind: "approval", seat: seats[2], next: [seats[0]], approval: { seat: "cleo", command: "rm -rf /srv/tmp", description: "delete in root path", timeoutS: 300 } });
    const key = (floor as Extract<Floor, { kind: "approval" }>).approval.key;
    expect(roomParams.approve("probe", key, "once")).toEqual({ room_id: "probe", member_id: "cleo", task_id: "t9", execution_generation: 2, choice: "once", request_id: "rq-1" });
  });

  it("calls a bot inside clarify stuck, never speaking", () => {
    expect(floorAt(57, { member_activity: [running("bram", { tool: "clarify" }), queued("cleo")] })).toEqual({ kind: "stuck", why: "clarify", seat: seats[1], next: [seats[2]] });
  });

  it("calls a task Hermes holds for a retry stuck once nothing else runs", () => {
    expect(floorAt(8, { pending_actions: [{ kind: "retry", task_id: "t1" }] })).toMatchObject({ kind: "stuck", why: "held" });
  });

  it("is starting while the owner's message is on its way, and yours once nothing is owed", () => {
    const sending = [{ eventId: "e", text: "hi", at: 1, state: "sending" as const }];
    expect(floorOf(fold(8), state(8), sending).kind).toBe("starting");
    expect(floorOf(fold(8), state(8), [{ ...sending[0], state: "failed" }])).toEqual({ kind: "yours", after: "settled", asked: undefined });
    expect(floorOf(EMPTY_LOG, state(0), [])).toEqual({ kind: "yours", after: "nothing", asked: undefined });
  });

  it("doesn't wait on a discussion while Hermes's room worker is down", () => {
    const live: RoomLive = { ...state(5), driver: false };
    expect(floorOf(fold(5), live, []).kind).toBe("yours");
    expect(roomView("probe", fold(5), live, [], 0, { stale: false, readAt: 1 }).workerDown).toBe(true);
  });

  it("is gone once the room is disbanded, whatever else the state says", () => {
    expect(floorOf(fold(67), state(67, { pending_actions: [approval] }, { disbanded_at: 1763400300 }), []).kind).toBe("gone");
  });

  it("stops being a discussion when the owner presses Stop", () => {
    const stopped = foldRoom(fold(20), page([{ seq: 21, event_id: "room-stop:1", kind: "room.stop_requested", created_at: 1763400070, actor: { kind: "gateway", id: "g" }, payload: { cancel_id: "c" } }], 21).events, seats, 21);
    expect(floorOf(stopped, state(21), [])).toEqual({ kind: "yours", after: "stopped", asked: undefined });
    expect(stopped.entries.at(-1)).toMatchObject({ kind: "cancelled", why: "stopped" });
  });
});

describe("what a floor means outside the pane", () => {
  it("has a row for every kind, and reads fast exactly where Hermes works or waits on an answer", () => {
    expect(Object.entries(FLOOR_SURFACE).map(([kind, s]) => [kind, s.busy, s.inbox ?? "-", s.tell])).toEqual([
      ["gone", false, "-", "never"],
      ["approval", true, "approval", "always"],
      ["speaking", true, "running", "never"],
      ["starting", true, "running", "never"],
      ["stuck", true, "failed", "always"],
      ["paused", false, "paused", "always"],
      ["yours", false, "completed", "unread"],
    ]);
  });

  it("tells the owner of a finished discussion only while it is unread", () => {
    const log = fold(8);
    const floor = floorOf(log, state(8), []);
    expect(attentionOf(floor, log, 0)).toMatchObject({ kind: "completed", summary: "The bots are done.", needsOwner: true, at: 1763400024000 });
    expect(attentionOf(floor, log, 8)).toBeUndefined();
  });

  it("keeps telling of a pause, an approval and a stuck bot after they were read", () => {
    const paused = fold(32);
    expect(attentionOf(floorOf(paused, state(32), []), paused, 32)).toMatchObject({ kind: "paused", summary: "The bots paused after 3 rounds.", needsOwner: true });
    const waiting = floorAt(67, { pending_actions: [{ kind: "approval", member_id: "cleo", task_id: "t", execution_generation: 1, request_id: "r", approval: { command: "x" } }] });
    expect(attentionOf(waiting, fold(67), 67)).toMatchObject({ kind: "approval", summary: "Cleo is waiting for your approval.", needsOwner: true });
    const stuck = floorAt(57, { member_activity: [{ member_id: "bram", status: "running", tool: "clarify" }] });
    expect(attentionOf(stuck, fold(57), 57)).toMatchObject({ kind: "failed", summary: "Bram is asking through a tool a room can't show.", needsOwner: true });
  });

  it("lists a talking room as running without counting it, and a disbanded one not at all", () => {
    expect(attentionOf(floorAt(20), fold(20), 0)).toMatchObject({ kind: "running", needsOwner: false });
    expect(attentionOf({ kind: "gone" }, fold(20), 0)).toBeUndefined();
  });

  it("only rewords a finished discussion when a reply reads as a question to the owner", () => {
    const asking = page([
      { seq: 1, event_id: "d1", kind: "message.user", created_at: 10, actor: { kind: "user", id: "u" }, payload: { text: "Plan it", thread_id: "main" } },
      { seq: 2, event_id: "m2", kind: "message.member", created_at: 11, actor: { kind: "member", id: "ada" }, payload: { discussion_event_id: "d1", member_id: "ada", round_index: 0, thread_id: "main", text: "Two options.\n\nWhich budget should I plan for?" } },
      { seq: 3, event_id: "a3", kind: "room.activity", created_at: 12, actor: { kind: "gateway", id: "g" }, payload: { discussion_event_id: "d1", status: "settled", reason_code: "silent_round", thread_id: "main" } },
    ], 3).events;
    const open = foldRoom(EMPTY_LOG, asking, seats, 2);
    expect(floorOf(open, state(2), []).kind, "a question in the text raises nothing while the bots talk").toBe("starting");
    const done = foldRoom(open, asking, seats, 3);
    const floor = floorOf(done, state(3), []);
    expect(floor).toEqual({ kind: "yours", after: "settled", asked: { seat: seats[0], seq: 2 } });
    expect(attentionOf(floor, done, 0)).toMatchObject({ kind: "completed", summary: "Ada asked you something." });
    expect(attentionOf(floor, done, 3), "read: the wording alone tells nobody").toBeUndefined();
  });
});

describe("a reply that reads as a question to the owner", () => {
  it("names the owner, or ends on a question that names no bot", () => {
    expect(asksOwner("@user which one?", seats)).toBe(true);
    expect(asksOwner("Here is the plan.\n\nShall I go on?", seats)).toBe(true);
    expect(asksOwner("@bram can you check this?", seats)).toBe(false);
    expect(asksOwner("Is it done? Yes, it is done.", seats)).toBe(false);
    expect(asksOwner("@all thoughts?", seats)).toBe(false);
  });
});

describe("Carry on", () => {
  it("names the bots the last round named", () => {
    expect(carryOnDraft(fold(32), seats)).toBe("@bram @ada ");
  });

  it("names the bots that spoke when the last round named nobody", () => {
    expect(carryOnDraft(fold(8), seats)).toBe("@ada @bram @cleo ");
    expect(carryOnDraft(EMPTY_LOG, seats)).toBe("");
  });
});

describe("a roster", () => {
  const bots = (n: number) => Array.from({ length: n }, (_, i) => ({ profile: `bot${i + 1}`, name: `Bot ${i + 1}` }));

  it("takes two to six bots, in pick order, each under its profile's handle", () => {
    const draft = roomDraft("r1", "  Launch crew ", [{ profile: "cleo", name: "Cleo" }, { profile: "ada", name: "Ada" }]);
    expect(draft).toMatchObject({ id: "r1", name: "Launch crew", seats: [{ id: "cleo", profile: "cleo", handle: "cleo", name: "Cleo" }, { id: "ada", profile: "ada", handle: "ada", name: "Ada" }] });
    expect(isDraft(draft) && roomParams.create(draft)).toEqual({
      room_id: "r1",
      name: "Launch crew",
      members: [
        { member_id: "cleo", profile: "cleo", handle: "cleo", display_name: "Cleo" },
        { member_id: "ada", profile: "ada", handle: "ada", display_name: "Ada" },
      ],
    });
    expect(isDraft(roomDraft("r", "Six", bots(6)))).toBe(true);
  });

  it("refuses one bot, seven, no name, a bot seated twice and a reserved handle", () => {
    expect(roomDraft("r", "One", bots(1))).toEqual({ problem: "tooFew" });
    expect(roomDraft("r", "Seven", bots(7))).toEqual({ problem: "tooMany" });
    expect(roomDraft("r", "  ", bots(2))).toEqual({ problem: "name" });
    expect(roomDraft("r", "Twice", [...bots(2), bots(2)[0]])).toEqual({ problem: "handleClash" });
    expect(roomDraft("r", "All", [{ profile: "all", name: "All" }, ...bots(1)])).toEqual({ problem: "handleClash" });
  });
});

describe("the wire", () => {
  it("sends every owner message on the latest discussion's thread, and a first one on main", () => {
    expect(roomParams.send("probe", "ev-1", EMPTY_LOG, "hi")).toEqual({ room_id: "probe", event_id: "ev-1", payload: { thread_id: "main", text: "hi" } });
    const other = foldRoom(EMPTY_LOG, page([{ seq: 1, event_id: "d1", kind: "message.user", created_at: 1, actor: { kind: "user", id: "u" }, payload: { text: "x", thread_id: "side-7" } }], 1).events, seats, 1);
    expect(roomParams.send("probe", "ev-2", other, "again").payload.thread_id).toBe("side-7");
    expect(roomParams.continue("probe", fold(32).discussion!)).toEqual({ room_id: "probe", discussion_event_id: "5a49d228f9dc9d814e1c" });
  });

  it("drops rows it can't read instead of failing the read", () => {
    expect(parseLog({ events: [{ seq: "1" }, null, ROOM_PROBE_LOG[0]], latest_seq: 1 }).events).toHaveLength(1);
    expect(parseLog("nonsense")).toEqual({ events: [], cursor: 0, latestSeq: 0, hasMore: false });
    expect(parseState({ rooms: [] })).toBeUndefined();
    expect(parseList({ rooms: [{ room_id: "a", name: "A", members, latest_seq: 4, updated_at: 2 }, { room_id: "b", disbanded_at: 3 }, 7] })).toEqual([{ id: "a", name: "A", seats, latestSeq: 4, updatedAt: 2000 }]);
  });

  it("reads a push's rooms and a seat's hidden session title", () => {
    expect(changedRooms({ room_ids: ["a", 3, "b"], broadcast_id: "e:1" })).toEqual(["a", "b"]);
    expect(changedRooms({ broadcast_id: "e:2" })).toBeUndefined();
    expect(memberSessionRoom("Group: room-1")).toBe("room-1");
    expect(memberSessionRoom("Group chat notes")).toBeUndefined();
  });
});
