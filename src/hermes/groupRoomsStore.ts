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
  rpc(method: AppMethod, params: Record<string, unknown>): Promise<unknown>;
  ready(): boolean;
  now?: () => number;
  uuid?: () => string;
  setTimer?: (fn: () => void, ms: number) => () => void;
};

export type RoomMarks = { load(): Record<string, number>; save(marks: Record<string, number>): void };

export const ROOM_MARKS_PREFIX = "hermes-chat.group-rooms-read.";

export function roomMarks(storage: Pick<Storage, "getItem" | "setItem">, scope: string): RoomMarks {
  const key = ROOM_MARKS_PREFIX + scope;
  return {
    load: () => {
      try {
        const read: unknown = JSON.parse(storage.getItem(key) ?? "{}");
        if (typeof read === "object" && read !== null) return Object.fromEntries(Object.entries(read).filter((e): e is [string, number] => typeof e[1] === "number"));
      } catch {}
      return {};
    },
    save: (marks) => {
      try {
        storage.setItem(key, JSON.stringify(marks));
      } catch {}
    },
  };
}

export class GroupRoomError extends Error {
  constructor(
    readonly why: "offline" | "unsupported" | "workerDown" | "gone" | "refused",
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export const FOLLOW_MS = {
  watchedBusy: 2_000,
  watchedIdle: 10_000,
  /** A busy room nobody is looking at: an Approval shows only in `groups.state`, so it is still read. */
  unwatchedBusy: 5_000,
  list: 30_000,
  pushSlowdown: 5,
} as const;

export function nextReadIn(room: { watched: boolean; busy: boolean }, pushProven: boolean): number | undefined {
  if (!room.watched && !room.busy) return undefined;
  const ms = room.watched ? (room.busy ? FOLLOW_MS.watchedBusy : FOLLOW_MS.watchedIdle) : FOLLOW_MS.unwatchedBusy;
  return ms * (pushProven ? FOLLOW_MS.pushSlowdown : 1);
}

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
  private gen = 0;
  private awake = false;
  private unsupported = false;
  private focused = true;
  private pushProven = false;
  private listDueAt?: number;
  private listRead?: Promise<void>;
  private listAgain = false;
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

  keepMarks(kept: RoomMarks): void {
    this.kept = kept;
    this.marks = { ...kept.load(), ...this.marks };
    for (const room of this.rooms.values()) this.rebuild(room);
    this.emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.follow();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.unfollow();
    };
  };

  list = (): readonly RoomSummary[] | undefined => this.summaries;

  room = (id: string): RoomView | undefined => this.rooms.get(id)?.view;

  has(id: string): boolean {
    return this.rooms.has(id);
  }

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

  async create(draft: RoomDraft): Promise<string> {
    await this.write("groups.create", roomParams.create(draft));
    this.track(draft.id);
    await Promise.all([this.readList(), this.tick(this.track(draft.id))]);
    return draft.id;
  }

  say(roomId: string, text: string): void {
    const room = this.rooms.get(roomId);
    if (!room || !text.trim()) return;
    const message: Outgoing = { eventId: this.uuid(), text, at: this.now(), state: "sending" };
    room.outgoing = [...room.outgoing, message];
    this.publish(room);
    this.send(room, message.eventId);
  }

  retry(roomId: string, eventId: string): void {
    const room = this.rooms.get(roomId);
    if (!room?.outgoing.some((o) => o.eventId === eventId && o.state === "failed")) return;
    this.setOutgoing(room, eventId, { state: "sending", error: undefined });
    this.send(room, eventId);
  }

  discard(roomId: string, eventId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.outgoing = room.outgoing.filter((o) => o.eventId !== eventId || o.state !== "failed");
    this.publish(room);
  }

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

  carryOn(roomId: string): string {
    return this.rooms.get(roomId)?.view?.carryOn ?? "";
  }

  async stop(roomId: string): Promise<void> {
    await this.write("groups.stop", roomParams.stop(roomId, this.uuid()));
    await this.tickById(roomId);
  }

  async answer(roomId: string, key: string, choice: RoomChoice): Promise<void> {
    const pending = () => this.rooms.get(roomId)?.live?.approvals.find((a) => a.key === key);
    const approval = pending();
    const failed = approval && (await this.write("groups.approve", roomParams.approve(roomId, approval.request, choice)).then(() => undefined, (e: unknown) => e));
    await this.tickById(roomId);
    // Hermes answers 5119 for every approve failure, so it means "already answered" only once the approval is gone.
    if (failed && !(failed instanceof GroupRoomError && failed.code === NOT_PENDING && !pending())) throw failed;
  }

  async rename(roomId: string, name: string): Promise<void> {
    await this.write("groups.rename", roomParams.rename(roomId, this.uuid(), name));
    await Promise.all([this.readList(), this.tickById(roomId)]);
  }

  async disband(roomId: string): Promise<void> {
    await this.write("groups.disband", roomParams.disband(roomId));
    await Promise.all([this.readList(), this.tickById(roomId)]);
  }

  async earlier(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (room?.log.from) await this.extend(room, Math.max(0, room.log.from - TAIL.open));
  }

  wake(): void {
    this.gen += 1;
    this.awake = true;
    this.unsupported = false;
    this.pushProven = false;
    for (const room of this.rooms.values()) room.ticking = undefined;
    this.listRead = undefined;
    this.continuing.clear();
    this.follow();
  }

  private follow() {
    void this.readList();
    for (const room of this.rooms.values()) if (room.watchers || (room.view && FLOOR_SURFACE[room.view.floor.kind].busy)) void this.tick(room);
  }

  private unfollow() {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.listDueAt = undefined;
    for (const room of this.rooms.values()) room.dueAt = undefined;
  }

  private reading(): boolean {
    return this.awake && !this.unsupported && this.listeners.size > 0 && this.io.ready();
  }

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

  changed(payload: Record<string, unknown>): void {
    if (!this.awake || this.unsupported) return;
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
      if (gen === this.gen && codeOf(e) === NO_SUCH_METHOD) this.unsupported = true;
    }
  }

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
      const reset = live.seq < log.seq;
      if (reset || !room.live) {
        log = logAfter(Math.max(0, live.seq - (room.watchers ? TAIL.open : TAIL.seen)));
        events = [];
      }
      let cursor = log.seq;
      while (cursor < live.seq) {
        const page = parseLog(await this.io.rpc("groups.log", roomParams.log(room.id, cursor, PAGE)));
        if (gen !== this.gen) return;
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
      const openFrom = Math.max(0, live.seq - TAIL.open);
      if (room.watchers && log.from > openFrom) await this.extend(room, openFrom);
    } catch (e) {
      if (gen !== this.gen) return;
      if (codeOf(e) === NO_ROOM && room.live) room.live = { ...room.live, disbanded: true };
      else room.stale = true;
      this.publish(room);
    }
  }

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
    } catch {}
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
    if (!focused) return;
    for (const room of this.rooms.values()) {
      if (!room.watchers) continue;
      this.markRead(room);
      this.rebuild(room);
    }
    this.emit();
  }

  private markRead(room: Tracked) {
    if (!this.focused || !room.watchers || !room.live || (this.marks[room.id] ?? 0) >= room.log.seq) return;
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
