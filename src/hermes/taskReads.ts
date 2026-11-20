import { POLL_EVERY_MS, type TaskDetail } from "./kanban";
import { RestError } from "./pipe";
import { readIsFinal, type TaskRead } from "./taskCard";
import { errorText } from "./values";


export type TaskReadsDeps = {
  read: (id: string, board?: string) => Promise<TaskDetail>;
  now?: () => number;
};

const keyOf = (id: string, board?: string) => `${board ?? ""}\n${id}`;

/**
 * The latest read of each task a shown card names (ADR 0248), in memory only: nothing here is saved, and a profile
 * switch forgets it all. A task is read when its first card shows, again every `POLL_EVERY_MS` while a card shows it
 * and it isn't done, archived or gone, and at once when a `status.update` names it. Nothing is read while
 * disconnected; the reads kept say how old they are.
 */
export class TaskReads {
  private reads = new Map<string, TaskRead>();
  private watchers = new Map<string, { id: string; board?: string; listeners: Set<() => void> }>();
  /** The tasks being read, each with the epoch its read started in. */
  private reading = new Map<string, number>();
  private running = false;
  /** Bumped by `stop` and `reset`, so a read that started before doesn't land after. */
  private epoch = 0;
  private timer?: ReturnType<typeof setInterval>;
  private board?: string;
  private boardListeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private deps: TaskReadsDeps) {
    this.now = deps.now ?? Date.now;
  }

  get(id: string, board?: string): TaskRead | undefined {
    return this.reads.get(keyOf(id, board));
  }

  /** Hermes's current board, as the Kanban watch last read it: the one the Work page shows. */
  currentBoard(): string | undefined {
    return this.board;
  }

  /** `listener` hears each change of the current board until the returned function is called. */
  watchBoard = (listener: () => void): (() => void) => {
    this.boardListeners.add(listener);
    return () => void this.boardListeners.delete(listener);
  };

  setCurrentBoard(board: string | undefined) {
    if (board === this.board) return;
    this.board = board;
    for (const l of this.boardListeners) l();
  }

  /** A card shows the task: `listener` hears each new read until the returned function is called. */
  watch(id: string, board: string | undefined, listener: () => void): () => void {
    const key = keyOf(id, board);
    const w = this.watchers.get(key) ?? { id, ...(board && { board }), listeners: new Set<() => void>() };
    this.watchers.set(key, w);
    w.listeners.add(listener);
    if (this.running && !this.reads.has(key)) void this.read(key);
    return () => {
      w.listeners.delete(listener);
      if (!w.listeners.size) this.watchers.delete(key);
    };
  }

  /** Connected: every shown task not final is read now, and then every `POLL_EVERY_MS`, the Kanban watch's pace,. */
  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.readAll(), POLL_EVERY_MS);
    this.readAll();
  }

  /** Disconnected: no more reads; the reads kept stay, with their times. */
  stop() {
    this.running = false;
    this.epoch++;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Another profile is shown: nothing read so far applies. */
  reset() {
    const was = this.running;
    this.stop();
    this.reads.clear();
    this.reading.clear();
    for (const w of this.watchers.values()) for (const l of w.listeners) l();
    if (was) this.start();
  }

  /** A `status.update` of kind `process`: one naming a shown task (`Kanban t_…`) has it read now. */
  nudge(text: string) {
    const id = /\bKanban (t_[\w-]+)/.exec(text)?.[1];
    if (!id || !this.running) return;
    for (const [key, w] of this.watchers) if (w.id === id) void this.read(key);
  }

  private readAll() {
    for (const key of this.watchers.keys()) if (!readIsFinal(this.reads.get(key))) void this.read(key);
  }

  private async read(key: string) {
    const w = this.watchers.get(key);
    const epoch = this.epoch;
    if (!w || this.reading.get(key) === epoch) return;
    this.reading.set(key, epoch);
    let next: TaskRead;
    try {
      next = { kind: "read", at: this.now(), detail: await this.deps.read(w.id, w.board) };
    } catch (e) {
      next = gone(e, w.id) ? { kind: "gone", at: this.now() } : { kind: "failed", at: this.now(), why: errorText(e), ...lastOf(this.reads.get(key)) };
    } finally {
      if (this.reading.get(key) === epoch) this.reading.delete(key);
    }
    if (epoch !== this.epoch) return;
    this.reads.set(key, next);
    for (const l of this.watchers.get(key)?.listeners ?? []) l();
  }
}

/** Hermes's own answer for a task it doesn't have (`_require`, `plugins/kanban/dashboard/plugin_api.py` at 0.23.2). A missing board or plugin is a failed read, not a gone task. */
const gone = (e: unknown, id: string) => e instanceof RestError && e.status === 404 && e.detail === `task ${id} not found`;

const lastOf = (r: TaskRead | undefined) => {
  const last = r?.kind === "read" ? { at: r.at, detail: r.detail } : r?.kind === "failed" ? r.last : undefined;
  return last ? { last } : {};
};
