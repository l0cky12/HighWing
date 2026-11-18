// The one owner of Group room state in the app, and the only caller of `groups.*` (groupRooms.ts, ADR 0205). Built once
// for each `Hermes` (transport.ts, beside `projects`) and kept across profile switches: a room is the connection's, so
// a switch only pauses the reads while the socket opens again.
//
// A screen gets three reads (`list`, `room`, `subscribe`), `watch`, and intents. Behind them: seq cursors and paging,
// the consistent read of state then log, when to read next, the unsent messages and their retry keys, the thread a
// message goes on, the approval's tuple, the read marks and the wording of refusals.
import type { AppMethod } from "./canonicalVerbs";
import {
  EMPTY_LOG,
  FLOOR_SURFACE,
  changedRooms,
  foldRoom,
  logAfter,
  parseList,
  parseLog,
  parseState,
  roomParams,
  roomView,
  sentSeq,
  type ListedRoom,
  type LogEvent,
  type Outgoing,
  type RoomChoice,
  type RoomDraft,
  type RoomLive,
  type RoomLog,
  type RoomSummary,
  type RoomView,
} from "./groupRooms";
import { errorText } from "./values";

export type GroupRoomsIO = {
  /** `Hermes.request`: rejects when not connected, and refuses a write while the capability is unsupported. */
  rpc(method: AppMethod, params: Record<string, unknown>): Promise<unknown>;
  /** The socket is connected, and this Hermes isn't known to lack rooms. */
  ready(): boolean;
  now?: () => number;
  uuid?: () => string;
  setTimer?: (fn: () => void, ms: number) => () => void;
};

export type RoomMarks = { load(): Record<string, number>; save(marks: Record<string, number>): void };

export const ROOM_MARKS_PREFIX = "hermes-chat.group-rooms-read.";

/** Read marks kept in `storage` for one connection (`scope`: inbox.ts `inboxScope`). A damaged record is as good as none. */
export function roomMarks(storage: Pick<Storage, "getItem" | "setItem">, scope: string): RoomMarks {
  const key = ROOM_MARKS_PREFIX + scope;
  return {
    load: () => {
      try {
        const read: unknown = JSON.parse(storage.getItem(key) ?? "{}");
        if (typeof read === "object" && read !== null) return Object.fromEntries(Object.entries(read).filter((e): e is [string, number] => typeof e[1] === "number"));
      } catch {
        // Nothing read.
      }
      return {};
    },
    save: (marks) => {
      try {
        storage.setItem(key, JSON.stringify(marks));
      } catch {
        // Kept in memory.
      }
    },
  };
}

/**
 * Why an intent didn't happen, in the owner's words. `gone`: the room, pause or approval is no longer there.
 * `workerDown`: Hermes's room worker isn't running. `unsupported`: this Hermes has no such method.
 */
export class GroupRoomError extends Error {
  constructor(
    readonly why: "offline" | "unsupported" | "workerDown" | "gone" | "refused",
    message: string,
    /** Hermes's JSON-RPC error code, when it answered with one. */
    readonly code?: number,
  ) {
    super(message);
  }
}

/** How long until a room is read again. Which rooms are busy is `FLOOR_SURFACE`'s to say. */
export const FOLLOW_MS = {
  /** A busy room on screen; Hermes's own desktop reads at this rate. */
  watchedBusy: 2_000,
  watchedIdle: 10_000,
  /** A busy room nobody is looking at: an Approval shows only in `groups.state`, so it is still read. */
  unwatchedBusy: 5_000,
  /** `groups.list`: finds a room another client woke (its `latest_seq` moved), and new or disbanded rooms. */
  list: 30_000,
  /** Every interval above is this many times longer once a `groups.changed` frame has arrived on this connection. */
  pushSlowdown: 5,
} as const;

/**
 * When a room is read next; undefined for an idle room off screen, which the list read covers. `pushProven`: a
 * `groups.changed` frame arrived on this connection. Hermes saying `change_events` is not enough: `f0d9488` behind a
 * messaging gateway says it and never delivers, and then the fast rate must stay.
 */
export function nextReadIn(room: { watched: boolean; busy: boolean }, pushProven: boolean): number | undefined {
  if (!room.watched && !room.busy) return undefined;
  const ms = room.watched ? (room.busy ? FOLLOW_MS.watchedBusy : FOLLOW_MS.watchedIdle) : FOLLOW_MS.unwatchedBusy;
  return ms * (pushProven ? FOLLOW_MS.pushSlowdown : 1);
}

/** How many of a room's newest events are read when it is first seen, and when it is opened. */
export const TAIL = { seen: 50, open: 500 } as const;
const PAGE = 500;
const NO_SUCH_METHOD = -32601;
const NO_ROOM = 4114;
const NO_WORKER = new Set([4115, 4123]);
const NOT_PENDING = 5119;

const codeOf = (e: unknown): number | undefined => (typeof (e as { code?: unknown } | null)?.code === "number" ? (e as { code: number }).code : undefined);

type Tracked = {
  id: string;
  listed?: ListedRoom;
  log: RoomLog;
  /** Every event folded into `log`, kept to fold again from further back ("Earlier messages"). */
  events: LogEvent[];
  live?: RoomLive;
  outgoing: Outgoing[];
  watchers: number;
  readAt: number;
  stale: boolean;
  dueAt?: number;
  ticking?: Promise<void>;
  again: boolean;
  view?: RoomView;
};

export class GroupRoomsStore {
  private readonly rooms = new Map<string, Tracked>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private marks: Record<string, number> = {};
  private kept?: RoomMarks;
  private summaries?: readonly RoomSummary[];
  /** Goes up at every wake and sleep: an answer from before either is dropped. */
  private gen = 0;
  private awake = false;
  private pushProven = false;
  private listDueAt?: number;
  private listRead?: Promise<void>;
  private listAgain = false;
  /** `groups.list` has answered on some connection, so `list()` is what Hermes has, or had. */
  private listed = false;
  private cancelTimer?: () => void;
  private continuing = new Map<string, Promise<void>>();

  constructor(private readonly io: GroupRoomsIO) {
    this.now = io.now ?? (() => Date.now());
    this.uuid = io.uuid ?? (() => crypto.randomUUID());
    this.setTimer =
      io.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
  }

  /**
   * Where the read marks are kept: the seq the owner has read each room up to, on this computer, for the connection.
   * Hermes keeps none. Until the app says where, they last as long as the store.
   */
  keepMarks(kept: RoomMarks): void {
    this.kept = kept;
    this.marks = { ...kept.load(), ...this.marks };
    for (const room of this.rooms.values()) this.rebuild(room);
    this.emit();
  }

  /**
   * Rooms are read only while someone listens: the first listener starts the reads, and the last to leave stops them.
   * So a connection with no screen on it asks Hermes nothing about rooms.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.follow();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.unfollow();
    };
  };

  /** The rooms, by name. The same array until something changes. Undefined until `groups.list` first answers. */
  list = (): readonly RoomSummary[] | undefined => this.summaries;

  /** Undefined until the room's first read lands. The same object until something changes. */
  room = (id: string): RoomView | undefined => this.rooms.get(id)?.view;

  /** Whether `id` is one of the connection's rooms, as last listed. */
  has(id: string): boolean {
    return this.rooms.has(id);
  }

  /**
   * The room is on screen until the returned function is called: it is read now with its last `TAIL.open` events,
   * followed at the watched rate, and marked read up to what is shown. Counted, so two panes on one room are fine.
   */
  watch(id: string): () => void {
    const room = this.track(id);
    room.watchers += 1;
    this.markRead(room);
    void this.tick(room);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      room.watchers -= 1;
      this.reschedule(room);
    };
  }

  /** Resolves with the room's id once it is listed. Safe to call again with the same draft after a failure. */
  async create(draft: RoomDraft): Promise<string> {
    await this.write("groups.create", roomParams.create(draft));
    this.track(draft.id);
    await Promise.all([this.readList(), this.tick(this.track(draft.id))]);
    return draft.id;
  }

  /**
   * The owner speaks. It goes on the latest discussion's thread, so while bots talk this is stepping in: Hermes cancels
   * the queued turns and answers the owner first. It shows at once, and a send that fails stays, marked failed, for
   * `retry`.
   */
  say(roomId: string, text: string): void {
    const room = this.rooms.get(roomId);
    if (!room || !text.trim()) return;
    const message: Outgoing = { eventId: this.uuid(), text, at: this.now(), state: "sending" };
    room.outgoing = [...room.outgoing, message];
    this.publish(room);
    this.send(room, message.eventId);
  }

  /** Sends a failed message again under its own event id, so Hermes posts it once whatever became of the first try. */
  retry(roomId: string, eventId: string): void {
    const room = this.rooms.get(roomId);
    if (!room?.outgoing.some((o) => o.eventId === eventId && o.state === "failed")) return;
    this.setOutgoing(room, eventId, { state: "sending", error: undefined });
    this.send(room, eventId);
  }

  /** Takes a failed message back; nothing is sent. */
  discard(roomId: string, eventId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.outgoing = room.outgoing.filter((o) => o.eventId !== eventId || o.state !== "failed");
    this.publish(room);
  }

  /** Gives the paused discussion one more budget. A second press while one is on its way is the same grant. */
  continue(roomId: string): Promise<void> {
    const held = this.continuing.get(roomId);
    if (held) return held;
    const room = this.rooms.get(roomId);
    const floor = room?.view?.floor;
    if (!room?.log.discussion || floor?.kind !== "paused" || !floor.canContinue) return Promise.reject(new GroupRoomError("gone", "The bots are no longer paused."));
    const going = this.write("groups.continue", roomParams.continue(roomId, room.log.discussion))
      .then(() => this.tick(room))
      .finally(() => this.continuing.delete(roomId));
    this.continuing.set(roomId, going);
    return going;
  }

  /**
   * What Carry on puts in the composer on a Hermes without Continue: the handles the last round named. Nothing is
   * sent; the owner's next message is what carries the discussion on.
   */
  carryOn(roomId: string): string {
    return this.rooms.get(roomId)?.view?.carryOn ?? "";
  }

  /** Stops queued and running turns. Fine to call when nothing runs. */
  async stop(roomId: string): Promise<void> {
    await this.write("groups.stop", roomParams.stop(roomId, this.uuid()));
    await this.tickById(roomId);
  }

  /** Answers the Approval `key` names. One Hermes no longer waits on resolves too: the view has moved on. */
  async answer(roomId: string, key: string, choice: RoomChoice): Promise<void> {
    await this.write("groups.approve", roomParams.approve(roomId, key, choice)).catch((e: unknown) => {
      if (!(e instanceof GroupRoomError) || e.code !== NOT_PENDING) throw e;
    });
    await this.tickById(roomId);
  }

  async rename(roomId: string, name: string): Promise<void> {
    await this.write("groups.rename", roomParams.rename(roomId, this.uuid(), name));
    await Promise.all([this.readList(), this.tickById(roomId)]);
  }

  /** For good, in every Hermes client. The screen asks first. */
  async disband(roomId: string): Promise<void> {
    await this.write("groups.disband", roomParams.disband(roomId));
    await Promise.all([this.readList(), this.tickById(roomId)]);
  }

  /** Reads the `TAIL.open` events before the oldest one shown. */
  async earlier(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (room?.log.from) await this.extend(room, Math.max(0, room.log.from - TAIL.open));
  }

  /** The socket is connected (first, again, or after a profile switch): the list is read and following resumes. */
  wake(): void {
    this.gen += 1;
    this.awake = true;
    this.pushProven = false;
    for (const room of this.rooms.values()) room.ticking = undefined;
    this.listRead = undefined;
    this.continuing.clear();
    this.follow();
  }

  private follow() {
    void this.readList();
    for (const room of this.rooms.values()) if (room.watchers) void this.tick(room);
  }

  private unfollow() {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.listDueAt = undefined;
    for (const room of this.rooms.values()) room.dueAt = undefined;
  }

  private reading(): boolean {
    return this.awake && this.listeners.size > 0 && this.io.ready();
  }

  /** The socket dropped: reads stop, every view is as last seen, and pushes must prove themselves again. */
  sleep(): void {
    this.gen += 1;
    this.awake = false;
    this.pushProven = false;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.listDueAt = undefined;
    for (const room of this.rooms.values()) {
      room.stale = true;
      room.dueAt = undefined;
      this.rebuild(room);
    }
    this.emit();
  }

  /** A `groups.changed` frame's payload. It only brings a read forward: the rooms it names are read now. */
  changed(payload: Record<string, unknown>): void {
    if (!this.awake) return;
    this.pushProven = true;
    const ids = changedRooms(payload);
    const known = ids?.flatMap((id) => this.rooms.get(id) ?? []) ?? [...this.rooms.values()];
    for (const room of known) void this.tick(room);
    if (!ids || known.length < ids.length) void this.readList();
  }

  private track(id: string): Tracked {
    let room = this.rooms.get(id);
    if (!room) this.rooms.set(id, (room = { id, log: EMPTY_LOG, events: [], outgoing: [], watchers: 0, readAt: 0, stale: false, again: false }));
    return room;
  }

  private tickById(id: string): Promise<void> {
    const room = this.rooms.get(id);
    return room ? this.tick(room) : Promise.resolve();
  }

  /** A write, with Hermes's refusal put in the owner's words. */
  private async write(method: AppMethod, params: Record<string, unknown>): Promise<unknown> {
    if (!this.io.ready()) throw new GroupRoomError("offline", "Not connected to Hermes.");
    try {
      return await this.io.rpc(method, params);
    } catch (e) {
      const code = codeOf(e);
      if (code === NO_SUCH_METHOD) throw new GroupRoomError("unsupported", "This Hermes server can't do that with a Group room.", code);
      if (code !== undefined && NO_WORKER.has(code)) throw new GroupRoomError("workerDown", "Hermes's room worker isn't running, so the bots can't answer. Restart Hermes on the server.", code);
      if (code === NO_ROOM) throw new GroupRoomError("gone", "This Group room is no longer on the server.", code);
      throw new GroupRoomError(this.io.ready() ? "refused" : "offline", errorText(e), code);
    }
  }

  private send(room: Tracked, eventId: string) {
    const message = room.outgoing.find((o) => o.eventId === eventId);
    if (!message) return;
    this.write("groups.send", roomParams.send(room.id, eventId, room.log, message.text)).then(
      (answer) => {
        // Kept until the log holds it, so the message never blinks out between the answer and the next read.
        this.setOutgoing(room, eventId, { landedSeq: sentSeq(answer) ?? room.log.seq + 1 });
        void this.tick(room);
      },
      (e: unknown) => this.setOutgoing(room, eventId, { state: "failed", error: errorText(e) }),
    );
  }

  private setOutgoing(room: Tracked, eventId: string, patch: Partial<Outgoing>) {
    room.outgoing = room.outgoing.map((o) => (o.eventId === eventId ? { ...o, ...patch } : o));
    this.publish(room);
  }

  /** One list read at a time: a read asked for meanwhile runs once more after, so it sees what was just written. */
  private readList(): Promise<void> {
    if (!this.reading()) return Promise.resolve();
    if (this.listRead) {
      this.listAgain = true;
      return this.listRead;
    }
    const gen = this.gen;
    const read = (async () => {
      do {
        this.listAgain = false;
        await this.readListOnce(gen);
      } while (this.listAgain && gen === this.gen);
    })().finally(() => {
      if (gen !== this.gen) return;
      this.listRead = undefined;
      this.listDueAt = this.reading() ? this.now() + FOLLOW_MS.list * (this.pushProven ? FOLLOW_MS.pushSlowdown : 1) : undefined;
      this.schedule();
    });
    this.listRead = read;
    return read;
  }

  private async readListOnce(gen: number): Promise<void> {
    try {
      const listed = parseList(await this.io.rpc("groups.list", roomParams.list(PAGE)));
      if (gen !== this.gen) return;
      const ids = new Set(listed.map((r) => r.id));
      for (const [id, room] of this.rooms) {
        if (ids.has(id)) continue;
        // A room on screen stays, as gone, until its pane closes; any other is simply no longer listed.
        if (room.watchers && room.live) room.live = { ...room.live, disbanded: true };
        else if (!room.watchers) this.rooms.delete(id);
        room.listed = undefined;
        this.rebuild(room);
      }
      for (const row of listed) {
        const room = this.track(row.id);
        const moved = !room.live || row.latestSeq !== room.log.seq;
        room.listed = row;
        if (moved) void this.tick(room);
        else this.rebuild(room);
      }
      this.listed = true;
      this.emit();
    } catch (e) {
      // A Hermes without rooms answers "method not found": the list stays unread, and nothing is asked again.
      if (gen === this.gen && codeOf(e) === NO_SUCH_METHOD) this.awake = false;
    }
  }

  /**
   * One consistent read of one room: `groups.state`, then `groups.log` from the cursor, paged, folded only up to that
   * state's `latest_seq`, then one publish. So a view never shows a bot writing beside the reply it already posted.
   * One read a room at a time: a read asked for meanwhile runs once more after.
   */
  private tick(room: Tracked): Promise<void> {
    if (!this.reading()) return Promise.resolve();
    if (room.ticking) {
      room.again = true;
      return room.ticking;
    }
    const gen = this.gen;
    const run = (async () => {
      do {
        room.again = false;
        await this.read(room, gen);
      } while (room.again && gen === this.gen);
    })().finally(() => {
      if (gen !== this.gen) return;
      room.ticking = undefined;
      this.reschedule(room);
    });
    room.ticking = run;
    return run;
  }

  private async read(room: Tracked, gen: number): Promise<void> {
    try {
      const live = parseState(await this.io.rpc("groups.state", roomParams.state(room.id)));
      if (gen !== this.gen || !live) return;
      let { log, events } = room;
      // The log is shorter than what was read: Hermes's store was replaced. What was read is no longer its history.
      const reset = live.seq < log.seq;
      if (reset || !room.live) {
        log = logAfter(Math.max(0, live.seq - (room.watchers ? TAIL.open : TAIL.seen)));
        events = [];
      }
      let cursor = log.seq;
      while (cursor < live.seq) {
        const page = parseLog(await this.io.rpc("groups.log", roomParams.log(room.id, cursor, PAGE)));
        if (gen !== this.gen) return;
        // Events past the state read wait for the next one, which reads them again from this cursor.
        const fresh = page.events.filter((e) => e.seq > cursor && e.seq <= live.seq);
        if (!fresh.length) break;
        events = [...events, ...fresh];
        log = foldRoom(log, fresh, live.seats, live.seq);
        cursor = log.seq;
        if (!page.hasMore) break;
      }
      Object.assign(room, { live, log, events, readAt: this.now(), stale: false });
      this.markRead(room);
      this.publish(room);
      // Opened after it was first seen from its short tail: the rest of the open window is read once.
      const openFrom = Math.max(0, live.seq - TAIL.open);
      if (room.watchers && log.from > openFrom) await this.extend(room, openFrom);
    } catch (e) {
      if (gen !== this.gen) return;
      if (codeOf(e) === NO_ROOM && room.live) room.live = { ...room.live, disbanded: true };
      else room.stale = true;
      this.publish(room);
    }
  }

  /** Reads the events in `(since, log.from]` and folds the room again from `since`. */
  private async extend(room: Tracked, since: number): Promise<void> {
    const gen = this.gen;
    const until = room.log.from;
    if (!room.live || since >= until || !this.io.ready()) return;
    try {
      let older: LogEvent[] = [];
      let cursor = since;
      while (cursor < until) {
        const page = parseLog(await this.io.rpc("groups.log", roomParams.log(room.id, cursor, Math.min(PAGE, until - cursor))));
        if (gen !== this.gen || room.log.from !== until) return;
        if (!page.events.length) break;
        older = [...older, ...page.events];
        cursor = page.cursor;
      }
      room.events = [...older, ...room.events];
      room.log = foldRoom(logAfter(since), room.events, room.live.seats, room.log.seq);
      this.publish(room);
    } catch {
      // The older events stay behind "Earlier messages"; what is shown is still true.
    }
  }

  private markRead(room: Tracked) {
    if (!room.watchers || !room.live || (this.marks[room.id] ?? 0) >= room.log.seq) return;
    this.marks = { ...this.marks, [room.id]: room.log.seq };
    this.kept?.save(this.marks);
  }

  private rebuild(room: Tracked) {
    room.view = room.live ? roomView(room.id, room.log, room.live, room.outgoing, this.marks[room.id] ?? 0, { stale: room.stale, readAt: room.readAt }) : undefined;
    if (room.view) room.outgoing = [...room.view.outgoing];
  }

  private publish(room: Tracked) {
    this.rebuild(room);
    this.emit();
  }

  private emit() {
    if (this.listed) this.summaries = this.summarise();
    for (const listener of this.listeners) listener();
  }

  private summarise(): readonly RoomSummary[] {
    return [...this.rooms.values()]
      .filter((r) => r.listed)
      .map((r): RoomSummary => ({ id: r.id, name: r.view?.name || r.listed!.name, seats: r.view?.seats ?? r.listed!.seats, updatedAt: r.listed!.updatedAt, floor: r.view?.floor, attention: r.view?.attention, stale: r.stale }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  private reschedule(room: Tracked) {
    const floor = room.view?.floor;
    const wait = this.reading() && floor ? nextReadIn({ watched: room.watchers > 0, busy: FLOOR_SURFACE[floor.kind].busy }, this.pushProven) : undefined;
    room.dueAt = wait === undefined ? undefined : this.now() + wait;
    this.schedule();
  }

  /** Sets the one timer to the soonest read due: any room's, or the list's. */
  private schedule() {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (!this.reading()) return;
    const due = [this.listDueAt, ...[...this.rooms.values()].map((r) => (r.ticking ? undefined : r.dueAt))].filter((d): d is number => d !== undefined);
    if (!due.length) return;
    this.cancelTimer = this.setTimer(() => this.fire(), Math.max(0, Math.min(...due) - this.now()));
  }

  private fire() {
    this.cancelTimer = undefined;
    const now = this.now();
    if (this.listDueAt !== undefined && this.listDueAt <= now) {
      this.listDueAt = undefined;
      void this.readList();
    }
    for (const room of this.rooms.values())
      if (room.dueAt !== undefined && room.dueAt <= now) {
        room.dueAt = undefined;
        void this.tick(room);
      }
    this.schedule();
  }
}
