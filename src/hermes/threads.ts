import { BotModeUnsupportedError, type BotRpc } from "./bots";
import type { SessionProtocol } from "./sessionProtocol";
import { errorText, isObj } from "./values";

export const THREAD_PREFIX = "Bot Thread: ";
/** The longest topic. Hermes takes a title of 100 characters; this leaves room for the prefix and a ` (99)`. */
export const TOPIC_MAX = 80;
const TOPIC_FROM_MESSAGE = 48;

export type ThreadTitle = string & { readonly __thread: unique symbol };

/** Hermes's name for a copy it makes of a titled session ("Bot Thread: VLAN plan #2"). */
const NUMBERED_COPY = / #\d+$/;

export function threadTopic(title: unknown): string | undefined {
  if (typeof title !== "string" || !title.startsWith(THREAD_PREFIX)) return undefined;
  const topic = title.slice(THREAD_PREFIX.length).trim();
  return topic && !NUMBERED_COPY.test(topic) ? topic : undefined;
}

export const isThreadTitle = (title: unknown): title is ThreadTitle => threadTopic(title) !== undefined;

function tidyTopic(topic: string): string {
  let t = topic.replace(/\s+/g, " ").trim().slice(0, TOPIC_MAX).trim();
  while (NUMBERED_COPY.test(t)) t = t.replace(/ #(\d+)$/, " $1");
  return t;
}

export function threadTitle(topic: string): ThreadTitle {
  const tidy = tidyTopic(topic);
  if (!tidy) throw new Error("A thread needs a topic.");
  return `${THREAD_PREFIX}${tidy}` as ThreadTitle;
}

export function freeTitle(title: ThreadTitle, taken: readonly string[]): ThreadTitle {
  const held = new Set(taken.map((t) => t.toLowerCase()));
  if (!held.has(title.toLowerCase())) return title;
  for (let n = 2; ; n++) {
    const next = `${title} (${n})`;
    if (!held.has(next.toLowerCase())) return next as ThreadTitle;
  }
}

export function topicFrom(messageText: string): string {
  const line = messageText.split("\n").find((l) => /[\p{L}\p{N}]/u.test(l)) ?? "";
  return tidyTopic(line.replace(/^[#>*\-\s]+/, "").slice(0, TOPIC_FROM_MESSAGE));
}

export type BotThread = {
  profile: string;
  title: ThreadTitle;
  topic: string;
  rootId: string;
  openId: string;
  preview: string;
  lastActive: number;
  messageCount: number;
};

export type ThreadShelf = { threads: BotThread[]; at: number; capped: boolean; error?: string };

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function shelfOf(result: unknown, profile: string, limit: number, at: number): ThreadShelf {
  const rows = isObj(result) && Array.isArray(result.sessions) ? (result.sessions as unknown[]) : undefined;
  if (!rows) throw new Error("Hermes answered the list of threads in a way this app doesn't read.");
  const threads = new Map<string, BotThread>();
  for (const r of rows) {
    if (!isObj(r)) continue;
    const row = threadOf(r, profile);
    if (row && !threads.has(row.title)) threads.set(row.title, row);
  }
  return { threads: [...threads.values()], at, capped: rows.length >= limit };
}

export function threadOf(r: Record<string, unknown>, profile: string): BotThread | undefined {
  const id = text(r.id);
  const title = r.title;
  if (!id || !isThreadTitle(title)) return undefined;
  return {
    profile,
    title,
    topic: threadTopic(title)!,
    rootId: text(r._lineage_root_id) || id,
    openId: text(r.resolved_id) || id,
    preview: text(r.preview).replace(/\s+/g, " "),
    lastActive: num(r.last_active || r.started_at) * 1000,
    messageCount: num(typeof r.live_message_count === "number" ? r.live_message_count : r.message_count),
  };
}

export const THREAD_WINDOW = 500;
const LOOKUP_LIMIT = 200;
const START_ROUNDS = 5;

const NO_SUCH_METHOD = -32601;
const TITLE_IN_USE = 4022;
const codeOf = (e: unknown) => (isObj(e) && typeof e.code === "number" ? e.code : undefined);
export const titleInUse = (e: unknown) => codeOf(e) === TITLE_IN_USE || /already in use/i.test(errorText(e));

export type FoundThread = BotThread & { titleId: string };

export type StartedThread = { title: ThreadTitle; openId: string; created: boolean };

export class Threads {
  private flights = new Map<string, Promise<StartedThread>>();

  constructor(
    private readonly rpc: BotRpc,
    private readonly sessions: () => SessionProtocol,
    private readonly source: string,
  ) {}

  async list(profile: string): Promise<ThreadShelf> {
    return shelfOf(await this.rpc("session.list", { profile, include_hidden: true, limit: THREAD_WINDOW }), profile, THREAD_WINDOW, Date.now());
  }

  /** Hermes's title lookup has no window, sees hidden sessions, and names the session the thread is in now. */
  async find(profile: string, title: ThreadTitle): Promise<FoundThread | null> {
    let res: unknown;
    try {
      res = await this.rpc("session.list", { profile, title, include_hidden: true, limit: LOOKUP_LIMIT });
    } catch (e) {
      if (codeOf(e) === NO_SUCH_METHOD) throw new BotModeUnsupportedError("This Hermes can't look a chat up by its title, so it has no threads.");
      throw new Error(`Couldn't look up the thread “${threadTopic(title)}”: ${errorText(e)}`);
    }
    const rows = isObj(res) && Array.isArray(res.sessions) ? (res.sessions as unknown[]) : undefined;
    if (!rows || rows.some((r) => !isObj(r) || !text(r.id) || r.title !== title)) throw new Error(`Hermes answered the lookup of the thread “${threadTopic(title)}” in a way this app doesn't read.`);
    const row = rows[0];
    if (!isObj(row)) return null;
    return { ...threadOf(row, profile)!, titleId: text(row.id) };
  }

  start(profile: string, topic: string, taken: readonly string[]): Promise<StartedThread> {
    const base = threadTitle(topic);
    const key = `${profile}\n${base.toLowerCase()}`;
    const flight = this.flights.get(key);
    if (flight) return flight;
    const run = this.resolve(profile, base, [...taken]).finally(() => {
      if (this.flights.get(key) === run) this.flights.delete(key);
    });
    this.flights.set(key, run);
    return run;
  }

  private async resolve(profile: string, base: ThreadTitle, taken: string[]): Promise<StartedThread> {
    for (let round = 0; round < START_ROUNDS; round++) {
      const title = freeTitle(base, taken);
      const found = await this.find(profile, title);
      if (found) {
        if (found.messageCount === 0) return { title, openId: found.openId, created: false };
        taken.push(title);
        continue;
      }
      const made = await this.sessions().open({ kind: "bot", profile, source: this.source, title });
      const runtime = made.runtimeId;
      const stored = made.storedId;
      if (!runtime || !stored) throw new Error(`Hermes didn't say which session it started for the thread “${threadTopic(title)}”.`);
      try {
        // A new session has no row until its first message. Naming it now stores it, hidden, under the title.
        await this.sessions().edit(runtime, { op: "rename", title });
        return { title, openId: stored, created: true };
      } catch (e) {
        if (!titleInUse(e)) throw new Error(`Hermes started the thread “${threadTopic(title)}” but didn't name it: ${errorText(e)}`);
      }
    }
    throw new Error(`Hermes already has several threads on “${threadTopic(base)}”. Pick another topic.`);
  }
}
