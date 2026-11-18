// Group rooms (GLOSSARY "Group room", ADR 0205): a room of 2 to 6 bots that Hermes hosts and drives ("Group Chat",
// `groups.*` on `/api/ws`). Pure: no I/O, no timers, no React. A room is the connection's (Hermes keeps it install-wide
// in `shared-state.db`), so nothing here names the shown profile and nothing here is a `Chat`.
//
// Every `groups.*` shape is read and written in this file and no wire type is exported. Two things carry the design:
//   1. `RoomView` = the folded room log + the latest `groups.state` + this app's unsent messages, merged in `roomView`.
//   2. `Floor`: who the room waits on. Every surface (the pane's strip, the composer's hint, the list row, the Bots tab
//      badge, the Rail inbox entry) reads `Floor` through `FLOOR_SURFACE`. Nothing else decides "needs you".
import type { InboxKind } from "./inbox";
import { isObj } from "./values";

export const SEATS_MIN = 2;
export const SEATS_MAX = 6;

/** A bot seated in a room. `handle` is what `@` takes. Its face is joined in the UI from the bots by `profile`. */
export type Seat = { readonly id: string; readonly profile: string; readonly handle: string; readonly name: string };

declare const draftBrand: unique symbol;
/**
 * A roster Hermes will accept: 2 to 6 distinct profiles, unique handles, none of them `all` or `everyone`, a name.
 * Only `roomDraft` makes one. `id` is minted once, when the dialog opens: creating twice with one draft makes one room
 * (`groups.create` is a no-op on a repeated id).
 */
export type RoomDraft = { readonly id: string; readonly name: string; readonly seats: readonly Seat[]; readonly [draftBrand]: true };
export type DraftProblem = { problem: "name" | "tooFew" | "tooMany" | "handleClash" };

/** Hermes's limit on a room's name (`hosted_rooms.MAX_ROOM_NAME_CHARS`). */
export const ROOM_NAME_MAX = 120;
const RESERVED_HANDLES = new Set(["all", "everyone"]);

/** `bots`: the picked bots in pick order, which is the order they answer in (round 0 runs in roster order). */
export function roomDraft(id: string, name: string, bots: readonly { profile: string; name: string }[]): RoomDraft | DraftProblem {
  const named = name.trim();
  if (!named || named.length > ROOM_NAME_MAX) return { problem: "name" };
  if (bots.length < SEATS_MIN) return { problem: "tooFew" };
  if (bots.length > SEATS_MAX) return { problem: "tooMany" };
  // Hermes Desktop's convention for a bot on this server: member_id = handle = profile.
  const seats = bots.map((b): Seat => ({ id: b.profile, profile: b.profile, handle: b.profile, name: b.name }));
  const handles = new Set(seats.map((s) => s.handle.toLowerCase()));
  if (handles.size !== seats.length || [...handles].some((h) => RESERVED_HANDLES.has(h))) return { problem: "handleClash" };
  return { id, name: named, seats } as unknown as RoomDraft;
}

export const isDraft = (d: RoomDraft | DraftProblem): d is RoomDraft => !("problem" in d);

/** One thing the transcript draws, in log order. `seq` is Hermes's. `round` starts at 0. */
export type RoomEntry =
  | { kind: "owner"; seq: number; at: number; text: string }
  /** A whole reply: nothing streams into a room. `asks`: see `asksOwner`. */
  | { kind: "reply"; seq: number; at: number; seat: string; round: number; text: string; asks: boolean }
  /** The bot had nothing to add. */
  | { kind: "passed"; seq: number; at: number; seat: string; round: number }
  | { kind: "failed"; seq: number; at: number; seat: string; round: number; error: string }
  /** `steppedIn`: the owner's newer message cancelled the turn. `stopped`: Stop did. */
  | { kind: "cancelled"; seq: number; at: number; seat?: string; why: "steppedIn" | "stopped" | "other" }
  /** Hermes couldn't wake the bots at all. */
  | { kind: "unavailable"; seq: number; at: number; error: string }
  /** The discussion hit its cap. The live pause is `Floor.paused`; this row stays in the transcript afterwards. */
  | { kind: "pause"; seq: number; at: number; reason: PauseReason; rounds: number }
  | { kind: "continued"; seq: number; at: number }
  | { kind: "renamed"; seq: number; at: number; name: string };

export type PauseReason = "rounds" | "messages";

/** The discussion the newest owner message started, as the log tells it. */
export type Discussion = {
  /** Hermes's id for it: the owner event's. Never leaves this module and the store. */
  readonly id: string;
  /** The thread the owner's message was on. The store sends into it, which is stepping in. */
  readonly thread: string;
  /** `open`: no end event yet. `paused`: capped. `settled`: a round named nobody. `stopped`: the owner pressed Stop. */
  readonly status: "open" | "paused" | "settled" | "stopped";
  readonly pauseReason?: PauseReason;
  readonly round: number;
  readonly replies: number;
  readonly continues: number;
  readonly failed: boolean;
  /** The last reply that `asksOwner`, if any: who asked, and where. */
  readonly asked?: { seat: string; seq: number };
};

/**
 * Everything the log says in `(from, seq]`. Grows only by `foldRoom`. `from` above 0: the room was first read from its
 * tail, and older events wait behind "Earlier messages".
 */
export type RoomLog = { readonly from: number; readonly seq: number; readonly at: number; readonly entries: readonly RoomEntry[]; readonly discussion?: Discussion };

export const EMPTY_LOG: RoomLog = { from: 0, seq: 0, at: 0, entries: [] };
/** A log that starts after `seq`, for a room read from its tail. */
export const logAfter = (seq: number): RoomLog => ({ ...EMPTY_LOG, from: seq, seq });

declare const wire: unique symbol;
/** A `groups.log` event, parsed; opaque outside this file. */
export type LogEvent = { readonly seq: number; readonly [wire]: true };
type Event = { seq: number; id: string; kind: string; at: number; actorId: string; p: Record<string, unknown> };

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const ms = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) : 0);

function parseEvent(row: unknown): Event | undefined {
  if (!isObj(row)) return undefined;
  const seq = int(row.seq);
  if (seq === undefined || seq < 1 || typeof row.kind !== "string") return undefined;
  return { seq, id: str(row.event_id), kind: row.kind, at: ms(row.created_at), actorId: isObj(row.actor) ? str(row.actor.id) : "", p: isObj(row.payload) ? row.payload : {} };
}

/** Boundary: one `groups.log` answer. A row it can't read is dropped, not the read. */
export function parseLog(answer: unknown): { events: LogEvent[]; cursor: number; latestSeq: number; hasMore: boolean } {
  const a = isObj(answer) ? answer : {};
  const events = list(a.events).flatMap((row) => parseEvent(row) ?? []);
  const cursor = int(a.cursor) ?? events[events.length - 1]?.seq ?? 0;
  return { events: events as unknown as LogEvent[], cursor, latestSeq: int(a.latest_seq) ?? cursor, hasMore: a.has_more === true };
}

const MENTION = /@([A-Za-z0-9][A-Za-z0-9._:-]*)/g;
/** The `@handle`s a text names, lower-cased, as Hermes reads them, without the punctuation a sentence ends a name with. */
const mentions = (text: string): string[] => [...text.matchAll(MENTION)].map((m) => m[1].replace(/[._:-]+$/, "").toLowerCase());

/**
 * Whether a reply reads as a question to the owner: it names `@user`, `@owner` or `@you`, or its last paragraph ends
 * in `?` and names no seat. Hermes has no such signal (a bot can't summon the owner); this is a reading of the text.
 * It only words attention the floor already raised. It never raises attention.
 */
export function asksOwner(text: string, seats: readonly Seat[]): boolean {
  const named = mentions(text);
  if (named.some((h) => h === "user" || h === "owner" || h === "you")) return true;
  const last = text.trim().split(/\n\s*\n/).pop() ?? "";
  const handles = new Set(seats.map((s) => s.handle.toLowerCase()));
  return last.trimEnd().endsWith("?") && !mentions(last).some((h) => handles.has(h) || RESERVED_HANDLES.has(h));
}

const PAUSE: Record<string, PauseReason> = { max_rounds: "rounds", max_messages: "messages" };

/**
 * Pure and idempotent: events at or below `log.seq` are skipped, so replaying a page changes nothing, and events above
 * `upTo` are left for the next tick, so a view never runs ahead of the `groups.state` read it is shown with.
 */
export function foldRoom(log: RoomLog, events: readonly LogEvent[], seats: readonly Seat[], upTo: number): RoomLog {
  let { seq, at, discussion } = log;
  const entries = [...log.entries];
  /** The discussion an event belongs to, when it is the current one or names one the fold hasn't met (a tail read). */
  const own = (e: Event): Discussion | undefined => {
    const id = str(e.p.discussion_event_id);
    if (!id || discussion?.id === id) return discussion;
    // A late event of a discussion the owner's newer message replaced says nothing about the current one.
    if (discussion) return undefined;
    return { id, thread: str(e.p.thread_id), status: "open", round: 0, replies: 0, continues: 0, failed: false };
  };
  for (const e of events as unknown as readonly Event[]) {
    if (e.seq <= seq || e.seq > upTo) continue;
    seq = e.seq;
    at = e.at || at;
    const base = { seq: e.seq, at: e.at };
    const seat = str(e.p.member_id) || undefined;
    const round = int(e.p.round_index) ?? 0;
    switch (e.kind) {
      case "message.user":
        entries.push({ ...base, kind: "owner", text: str(e.p.text) });
        discussion = { id: e.id, thread: str(e.p.thread_id), status: "open", round: 0, replies: 0, continues: 0, failed: false };
        break;
      case "message.member": {
        const who = seat ?? e.actorId;
        const text = str(e.p.text);
        const asks = asksOwner(text, seats);
        entries.push({ ...base, kind: "reply", seat: who, round, text, asks });
        const d = own(e);
        if (d) discussion = { ...d, status: "open", round: Math.max(d.round, round), replies: d.replies + 1, asked: asks ? { seat: who, seq: e.seq } : d.asked };
        break;
      }
      case "turn.settled":
        if (e.p.passed === true && seat) entries.push({ ...base, kind: "passed", seat, round });
        break;
      case "turn.failed": {
        if (seat) entries.push({ ...base, kind: "failed", seat, round, error: str(e.p.error) });
        const d = own(e);
        if (d) discussion = { ...d, failed: true };
        break;
      }
      case "turn.cancelled": {
        // Hermes names only this reason; a turn Stop cancelled says "member turn cancelled", after `room.stop_requested`.
        const reason = str(e.p.reason);
        entries.push({ ...base, kind: "cancelled", seat, why: reason === "superseded_by_newer_user_event" ? "steppedIn" : "other" });
        break;
      }
      case "room.activity": {
        const d = own(e);
        if (!d) break;
        if (e.p.status === "bounded") {
          const reason = PAUSE[str(e.p.reason_code)] ?? "rounds";
          entries.push({ ...base, kind: "pause", reason, rounds: d.round + 1 });
          discussion = { ...d, status: "paused", pauseReason: reason };
        } else if (e.p.status === "settled") discussion = { ...d, status: "settled" };
        break;
      }
      case "room.continued": {
        entries.push({ ...base, kind: "continued" });
        const d = own(e);
        if (d) discussion = { ...d, status: "open", pauseReason: undefined, continues: int(e.p.grant) ?? d.continues + 1 };
        break;
      }
      case "room.stop_requested":
        entries.push({ ...base, kind: "cancelled", why: "stopped" });
        if (discussion) discussion = { ...discussion, status: "stopped" };
        break;
      case "room.renamed":
        entries.push({ ...base, kind: "renamed", name: str(e.p.name) });
        break;
      case "member.unavailable":
        entries.push({ ...base, kind: "unavailable", error: str(e.p.error) });
        break;
      default:
        // `turn.deferred`, `room.created`, and kinds a newer Hermes adds (`room.routed`, …): nothing the transcript draws.
        break;
    }
  }
  return seq === log.seq ? log : { from: log.from, seq, at, entries, discussion };
}

/**
 * What Carry on puts in the composer on a Hermes without Continue: the handles the last round's replies named, or, when
 * they named nobody, the bots that spoke in it. The owner's message then brings exactly those bots back in.
 */
export function carryOnDraft(log: RoomLog, seats: readonly Seat[]): string {
  const since = log.entries.map((e) => e.kind).lastIndexOf("owner");
  const replies = log.entries.slice(since + 1).filter((e) => e.kind === "reply");
  const round = Math.max(-1, ...replies.map((r) => r.round));
  const last = replies.filter((r) => r.round === round);
  const byHandle = new Map(seats.map((s) => [s.handle.toLowerCase(), s]));
  const named = last.flatMap((r) => mentions(r.text)).filter((h) => byHandle.has(h));
  const spoke = last.flatMap((r) => seats.find((s) => s.id === r.seat)?.handle.toLowerCase() ?? []);
  const handles = [...new Set(named.length ? named : spoke)];
  return handles.map((h) => `@${byHandle.get(h)!.handle} `).join("");
}

/** An Approval a room's bot waits on. A room offers only once or deny. `key` stands for Hermes's own tuple. */
export type RoomApproval = { readonly key: string; seat: string; command: string; description: string; timeoutS?: number };
export type RoomChoice = "once" | "deny";

/** One `groups.state` read. `seq` is the room's `latest_seq` at that read. */
export type RoomLive = {
  seq: number;
  name: string;
  seats: Seat[];
  disbanded: boolean;
  /** Hermes's room worker runs. False: nothing sent will be answered. */
  driver: boolean;
  /** Who works now. `tool`: what it is in, when Hermes says (`clarify`, `terminal`); older builds say only who. */
  activity: { seat: string; status: "queued" | "running" | "stopping"; round?: number; since?: number; tool?: string }[];
  approvals: RoomApproval[];
  /** Tasks Hermes holds until someone retries them (`pending_actions` of another kind). */
  held: { seat?: string }[];
  /** This Hermes has `groups.continue`, and says how many a discussion gets. Absent on `bf0203a` and `f0d9488`. */
  maxContinues?: number;
  /** Hermes says it pushes `groups.changed`. The store doesn't stretch its reads until one arrives. */
  saysPush: boolean;
};

function parseSeats(members: unknown): Seat[] {
  return list(members).flatMap((m): Seat[] => {
    if (!isObj(m) || typeof m.member_id !== "string") return [];
    const profile = str(m.profile) || m.member_id;
    return [{ id: m.member_id, profile, handle: str(m.handle) || profile, name: str(m.display_name) || profile }];
  });
}

const ACTIVE = new Set(["queued", "running", "stopping"]);

/** Boundary: one `groups.state` answer. Undefined when it isn't one. */
export function parseState(answer: unknown): RoomLive | undefined {
  if (!isObj(answer) || !isObj(answer.room) || typeof answer.room.room_id !== "string") return undefined;
  const room = answer.room;
  const driver = isObj(answer.driver_status) ? answer.driver_status : undefined;
  const actions = list(driver?.pending_actions).filter(isObj);
  return {
    seq: int(room.latest_seq) ?? 0,
    name: str(room.name),
    seats: parseSeats(room.members),
    disbanded: room.disbanded_at != null,
    driver: driver?.running === true,
    activity: list(driver?.member_activity).flatMap((row) => {
      if (!isObj(row) || typeof row.member_id !== "string" || !ACTIVE.has(str(row.status))) return [];
      return [{ seat: row.member_id, status: row.status as "queued" | "running" | "stopping", round: int(row.round_index), since: ms(row.started_at) || undefined, tool: str(row.tool) || undefined }];
    }),
    approvals: actions.flatMap((a): RoomApproval[] => {
      const generation = int(a.execution_generation);
      if (a.kind !== "approval" || typeof a.member_id !== "string" || typeof a.task_id !== "string" || typeof a.request_id !== "string" || !generation) return [];
      const ask = isObj(a.approval) ? a.approval : {};
      return [{ key: JSON.stringify([a.member_id, a.task_id, generation, a.request_id]), seat: a.member_id, command: str(ask.command), description: str(ask.description), timeoutS: int(ask.timeout_s) }];
    }),
    held: actions.filter((a) => a.kind !== "approval").map((a) => ({ seat: str(a.member_id) || undefined })),
    maxContinues: int(driver?.max_continues),
    saysPush: answer.change_events === true,
  };
}

/** A room as `groups.list` lists it. */
export type ListedRoom = { id: string; name: string; seats: Seat[]; latestSeq: number; updatedAt: number };

/** Boundary: one `groups.list` answer; disbanded rooms left out. */
export function parseList(answer: unknown): ListedRoom[] {
  return list(isObj(answer) ? answer.rooms : undefined).flatMap((r): ListedRoom[] =>
    isObj(r) && typeof r.room_id === "string" && r.disbanded_at == null ? [{ id: r.room_id, name: str(r.name), seats: parseSeats(r.members), latestSeq: int(r.latest_seq) ?? 0, updatedAt: ms(r.updated_at) }] : [],
  );
}

/** Whether a `groups.list` answer is one, for the capability's check. */
export const isRoomList = (answer: unknown): boolean => isObj(answer) && Array.isArray(answer.rooms);

/** The seq Hermes stored an owner message at, from `groups.send`'s answer. */
export const sentSeq = (answer: unknown): number | undefined => (isObj(answer) && isObj(answer.event) ? int(answer.event.seq) : undefined);

/** The rooms a `groups.changed` frame names; undefined when it names none, which means every room. */
export const changedRooms = (payload: Record<string, unknown>): string[] | undefined =>
  Array.isArray(payload.room_ids) ? payload.room_ids.filter((id): id is string => typeof id === "string") : undefined;

/** The title of the hidden session each seat answers in, which `session.active_list` lists. */
const MEMBER_SESSION = /^Group: (.+)$/;
export const memberSessionRoom = (title: unknown): string | undefined => (typeof title === "string" ? MEMBER_SESSION.exec(title)?.[1] : undefined);

/** What each `groups.*` write sends. `ROOMS_THREAD`: the thread of a room's first message. */
const ROOMS_THREAD = "main";
export const roomParams = {
  list: (limit: number) => ({ limit }),
  state: (roomId: string) => ({ room_id: roomId }),
  log: (roomId: string, sinceSeq: number, limit: number) => ({ room_id: roomId, since_seq: sinceSeq, limit }),
  create: (draft: RoomDraft) => ({
    room_id: draft.id,
    name: draft.name,
    members: draft.seats.map((s) => ({ member_id: s.id, profile: s.profile, handle: s.handle, display_name: s.name })),
  }),
  send: (roomId: string, eventId: string, log: RoomLog, text: string) => ({ room_id: roomId, event_id: eventId, payload: { thread_id: log.discussion?.thread || ROOMS_THREAD, text } }),
  continue: (roomId: string, discussion: Discussion) => ({ room_id: roomId, discussion_event_id: discussion.id }),
  stop: (roomId: string, cancelId: string) => ({ room_id: roomId, cancel_id: cancelId }),
  approve: (roomId: string, key: string, choice: RoomChoice) => {
    const [member_id, task_id, execution_generation, request_id] = JSON.parse(key) as [string, string, number, string];
    return { room_id: roomId, member_id, task_id, execution_generation, choice, request_id };
  },
  rename: (roomId: string, eventId: string, name: string) => ({ room_id: roomId, event_id: eventId, name }),
  disband: (roomId: string) => ({ room_id: roomId }),
} satisfies Record<string, (...args: never[]) => Record<string, unknown>>;

/**
 * Who the room waits on. Exactly one holds at a time; `floorOf` picks the first that applies, in this order.
 *   gone      the room was disbanded.
 *   approval  a bot can't go on until the owner answers.
 *   speaking  a bot is writing its reply; `next` are queued behind it.
 *   starting  the owner's message is on its way or accepted, or the bots are between turns.
 *   stuck     a bot is inside the `clarify` tool, whose question a dashboard room can't show or answer (Hermes gives
 *             up after about 90 s), or Hermes holds a task it won't run again by itself. A bot in `clarify` is never
 *             `speaking`.
 *   paused    the discussion hit its cap. `canContinue` false: this Hermes has no Continue, or none are left.
 *   yours     nothing runs. `asked`: the bot whose reply reads as a question to the owner.
 */
export type Floor =
  | { kind: "gone" }
  | { kind: "approval"; approval: RoomApproval; seat?: Seat; next: Seat[] }
  | { kind: "speaking"; seat: Seat; round?: number; since?: number; tool?: string; stopping: boolean; next: Seat[] }
  | { kind: "starting" }
  | { kind: "stuck"; why: "clarify" | "held"; seat?: Seat; next: Seat[] }
  | { kind: "paused"; reason: PauseReason; rounds: number; canContinue: boolean; continuesLeft?: number; asked?: Asked }
  | { kind: "yours"; after: "nothing" | "settled" | "stopped" | "failed"; asked?: Asked };

/** The bot whose reply reads as a question to the owner, and the reply's seq, to jump to. */
export type Asked = { seat: Seat; seq: number };

/** An owner message this app sent that the log doesn't hold yet. Client-owned; the log is Hermes's. */
export type Outgoing = { readonly eventId: string; text: string; at: number; state: "sending" | "failed"; error?: string; landedSeq?: number };

export function floorOf(log: RoomLog, live: RoomLive, outgoing: readonly Outgoing[]): Floor {
  if (live.disbanded) return { kind: "gone" };
  const seatOf = (id?: string) => live.seats.find((s) => s.id === id);
  const queued = live.activity.filter((a) => a.status === "queued").flatMap((a) => seatOf(a.seat) ?? []);
  const approval = live.approvals[0];
  if (approval) return { kind: "approval", approval, seat: seatOf(approval.seat), next: queued.filter((s) => s.id !== approval.seat) };
  const running = live.activity.find((a) => a.status !== "queued");
  const runner = running && seatOf(running.seat);
  if (running && runner && running.tool !== "clarify")
    return { kind: "speaking", seat: runner, round: running.round, since: running.since, tool: running.tool, stopping: running.status === "stopping", next: queued };
  const d = log.discussion;
  const waiting = outgoing.some((o) => o.state === "sending") || (!running && live.activity.length > 0) || (!running && live.driver && d?.status === "open");
  if (waiting) return { kind: "starting" };
  if (running) return { kind: "stuck", why: "clarify", seat: runner, next: queued };
  if (live.held.length) return { kind: "stuck", why: "held", seat: seatOf(live.held[0].seat), next: [] };
  const askedSeat = d?.asked && seatOf(d.asked.seat);
  const asked = d?.asked && askedSeat ? { seat: askedSeat, seq: d.asked.seq } : undefined;
  if (d?.status === "paused") {
    const left = live.maxContinues === undefined ? undefined : Math.max(0, live.maxContinues - d.continues);
    return { kind: "paused", reason: d.pauseReason ?? "rounds", rounds: d.round + 1, canContinue: !!left, continuesLeft: left, asked };
  }
  return { kind: "yours", after: !d ? "nothing" : d.status === "stopped" ? "stopped" : d.failed ? "failed" : "settled", asked };
}

/** What a floor means outside the pane. Adding a `Floor` kind won't compile until it has a row here. */
export type FloorSurface = {
  /** Read at the fast rate (`FOLLOW_MS`): Hermes is doing something, or waits on an answer only `groups.state` shows. */
  busy: boolean;
  /** The Rail inbox kind; none for a floor the inbox doesn't list. */
  inbox?: InboxKind;
  /**
   * When the room counts as needing the owner (the Bots tab badge, the Needs-you line, the row's mark). `always`:
   * even after they've seen it. `unread`: only while the log is newer than what they read. `never`: it doesn't.
   */
  tell: "always" | "unread" | "never";
};

export const FLOOR_SURFACE: Record<Floor["kind"], FloorSurface> = {
  gone: { busy: false, tell: "never" },
  approval: { busy: true, inbox: "approval", tell: "always" },
  speaking: { busy: true, inbox: "running", tell: "never" },
  starting: { busy: true, inbox: "running", tell: "never" },
  stuck: { busy: true, inbox: "failed", tell: "always" },
  paused: { busy: false, inbox: "paused", tell: "always" },
  yours: { busy: false, inbox: "completed", tell: "unread" },
};

/**
 * What the Rail inbox lists for a room. `summary` never quotes a reply or a command (inbox.ts's rule). `mark` tells
 * one occasion from the next, for the entry's key. `needsOwner`: it counts on the badges.
 */
export type Attention = { kind: InboxKind; summary: string; at: number; mark: string; needsOwner: boolean };

export function attentionOf(floor: Floor, log: RoomLog, readSeq: number): Attention | undefined {
  const surface = FLOOR_SURFACE[floor.kind];
  const unread = log.seq > readSeq;
  if (!surface.inbox || (surface.tell === "unread" && !unread)) return undefined;
  const base = { kind: surface.inbox, at: log.at, needsOwner: surface.tell !== "never" };
  const asked = (a?: Asked) => (a ? `${a.seat.name} asked you something.` : undefined);
  switch (floor.kind) {
    case "approval":
      return { ...base, at: 0, mark: floor.approval.key, summary: `${floor.seat?.name ?? "A bot"} is waiting for your approval.` };
    case "speaking":
    case "starting":
      return { ...base, mark: "", summary: "The bots are talking." };
    case "stuck":
      return {
        ...base,
        mark: `${floor.why} ${floor.seat?.id ?? ""} ${log.seq}`,
        summary: floor.why === "clarify" ? `${floor.seat?.name ?? "A bot"} is asking through a tool a room can't show.` : "A bot's turn is stuck. Open the room to see it.",
      };
    case "paused":
      return { ...base, mark: `${log.discussion?.id ?? ""} ${log.discussion?.continues ?? 0}`, summary: asked(floor.asked) ?? `The bots paused after ${floor.rounds} ${floor.rounds === 1 ? "round" : "rounds"}.` };
    case "yours":
      return { ...base, mark: "", summary: asked(floor.asked) ?? (floor.after === "failed" ? "A bot's reply failed." : "The bots are done.") };
    case "gone":
      return undefined;
  }
}

/** A room as a screen reads it. Built only by `roomView`. */
export type RoomView = {
  id: string;
  name: string;
  seats: readonly Seat[];
  entries: readonly RoomEntry[];
  /** Older events wait on Hermes: "Earlier messages" reads them. */
  earlier: boolean;
  /** Sent from here and not in `entries` yet, oldest first. */
  outgoing: readonly Outgoing[];
  floor: Floor;
  attention?: Attention;
  /** What Carry on would put in the composer. */
  carryOn: string;
  seq: number;
  /** The last read failed or the connection is down: as last seen at `readAt`. */
  stale: boolean;
  readAt: number;
  /** Hermes's room worker isn't running, so nothing sent is answered. */
  workerDown: boolean;
};

/** The read boundary: Hermes's log and state, merged with this app's unsent messages and read mark. */
export function roomView(id: string, log: RoomLog, live: RoomLive, outgoing: readonly Outgoing[], readSeq: number, health: { stale: boolean; readAt: number }): RoomView {
  const unsent = outgoing.filter((o) => o.landedSeq === undefined || o.landedSeq > log.seq);
  const floor = floorOf(log, live, unsent);
  return {
    id,
    name: live.name,
    seats: live.seats,
    entries: log.entries,
    earlier: log.from > 0,
    outgoing: unsent,
    floor,
    attention: attentionOf(floor, log, readSeq),
    carryOn: carryOnDraft(log, live.seats),
    seq: log.seq,
    ...health,
    workerDown: !live.driver && !live.disbanded,
  };
}

/** A room in the list: `groups.list`'s row, plus what the store last learnt of it. */
export type RoomSummary = { id: string; name: string; seats: readonly Seat[]; updatedAt: number; floor?: Floor; attention?: Attention; stale: boolean };
