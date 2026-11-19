// The owner's "@" in a Bot Chat (ADR 0233), or in an ordinary chat with a bot picked from the menu (ADR 0234). A message
// that names other bots goes to each named bot's own Bot Chat as the owner's message, never the app relaying a bot's
// (ADR 0207), with the asking chat attached as a Referenced chat (ADR 0165). The asking bot takes no turn. Hermes keeps
// nothing in the asking chat, so this computer keeps the asks of each profile's chats: the words, the bots asked, where
// the card goes, and each reply once it has ended. The message carries an ask id in its attached context, which joins
// the record to the asked bot's stored rows when the app has to settle an ask it lost sight of. Nothing ever scans a
// Bot Chat for asks the record doesn't know.
//
// The asked Bot Chat is attached to this connection with `session.resume` under its own profile, which moves its
// events here (`_rebind_live_transport`, `tui_gateway/methods_session.py` at `ae2a81cc`), and is never shown: it isn't
// in the snapshot. Every ask goes with `queued: true`, so a bot that is replying gets it next and is never interrupted.
import { rowText, typedText, type StoredBranchRow } from "./branch";
import { referenceBlock } from "./chatReferences";
import { mentionsFor, type AskRule } from "./mentionPicker";
import type { Chat, Item, SentReference } from "./model";
import { neutralize } from "./projectContext";
import { PromptUnconfirmedError, echoesInflight } from "./sessionProtocol";
import { errorText, isObj } from "./values";

/** An ask's id: ten characters of [0-9a-z]. Made here, stamped on the message, and the only join to its stored row. */
export type AskId = string & { readonly __ask: unique symbol };
/** Where a message landed in the asked bot's lineage: the session it went into, and its stored row once known. */
export type AskSeat = { session: string; row?: number };
/** What the asked bot is doing while it answers, for the card's one line. */
export type AskDoing = "thinking" | "tool" | "needs-you";
type Who = { profile: string; handle: string; name: string };

/**
 * One bot an ask went to. `sending`: on its way; `out` once the frame left. `failed`: Hermes refused it (`reason`),
 * the app closed before it went, or Hermes turned out not to have it. `unknown`: the connection dropped before Hermes
 * answered. `waiting`: Hermes holds it behind the bot's running reply (`busy`), or this app lost sight of its turn and
 * reads it once connected (`reading`). `answering`: its turn runs here. `answered`: its turn ended; the reply is kept.
 */
export type AskTarget = Who &
  (
    | { state: "sending"; out?: AskSeat }
    | { state: "failed"; cause: "refused" | "closed" | "never"; reason?: string }
    | { state: "unknown"; seat: AskSeat; reason?: string }
    | { state: "waiting"; why: "busy" | "reading"; seat: AskSeat }
    | { state: "answering"; seat: AskSeat; reply: string; doing?: AskDoing }
    | { state: "answered"; seat: AskSeat; reply: string; ended: "complete" | "interrupted" | "error" }
  );

/** An ordinary chat an ask was sent from. Its `title` is as it was then, which a stamp sent again says. */
export type AskChat = { id: string; title: string };

/**
 * One message the owner sent from a chat. `chat`: the ordinary chat it came from; none for the profile's Bot Chat,
 * which has no other, and for an ask kept before an ordinary chat could ask. `afterRow`: that chat's newest stored
 * row then, which places the card. `titles`: the chats it referenced. `references`: kept while a bot may still have to
 * be sent it again. Invariant: `targets` is non-empty, one per profile.
 */
export type Ask = { id: AskId; text: string; at: number; chat?: AskChat; afterRow?: number; titles: string[]; references?: SentReference[]; targets: AskTarget[] };

/** The asks that belong on a chat's transcript: those sent from it, or, for a Bot Chat, from the profile's Bot Chat. */
export const askedIn = (asks: readonly Ask[], chatId: string, ofBot: boolean): Ask[] => asks.filter((a) => (a.chat ? a.chat.id === chatId : ofBot));

/** Why an ask didn't go: not connected, the background connection, or this computer couldn't keep it. */
export type AskRefusal = "offline" | "background" | "unsaved";

/** The asks one profile keeps; the oldest ones whose every bot answered go first. */
export const ASKS_KEPT = 100;
const PAGE = 100;
const PAGES = 5;

/** The bots a message names, each once, in the order first named: exactly the bots its pills show. */
export function askTargets<B extends { profile: string; handle: string }>(text: string, bots: readonly B[], rule: AskRule): B[] {
  return [...new Map(mentionsFor(text, bots, rule).map((m) => [m.bot.profile, m.bot] as const)).values()];
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const STAMPS = /^\[Asked from: .+ · ([0-9a-z]{10})\]$/gm;

/**
 * The block every ask's message starts its attached context with, before its references, so no summary takes it in. It
 * says where the owner wrote the message: `chat` for an ordinary chat, none for the asker's Bot Chat. A chat's title
 * can hold any text, so it goes through `oneLine` as the name does, and the line it is on still ends " · <id>]".
 */
export const askStampBlock = (id: AskId, from: { name: string; handle: string }, chat?: { title: string }) => {
  const name = oneLine(from.name);
  const title = chat && oneLine(chat.title);
  const where = !chat ? `Bot Chat with ${name}` : title ? `chat "${title}" with ${name}` : `chat with ${name}`;
  return neutralize(`[Asked from: ${where} · ${id}]\nThe owner wrote this in their ${where} (@${from.handle}) and sent it to you. ${name} takes no turn; the owner reads your reply there.`);
};

/**
 * The asks a stored message carries, read only from what follows its typed words. Hermes merges text it holds behind a
 * running reply into one message (`_enqueue_prompt`), so one message can carry several.
 */
export const askStamps = (text: string): AskId[] => Array.from(text.slice(typedText(text).length).matchAll(STAMPS), (m) => m[1] as AskId);

/** The first ask a stored message carries. */
export const askStamp = (text: string): AskId | undefined => askStamps(text)[0];

export function newAskId(): AskId {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("") as AskId;
}

/** A user row that doesn't begin a turn: a hidden instruction, a model switch, or a steer of the running reply. */
const NOT_A_TURN = new Set(["hidden", "model_switch", "steer"]);

/**
 * The ask's turn in a run of a session's rows, oldest first: the user row stamped `id`, and the reply after it up to
 * the next message that begins a turn (`ended`). Undefined when the stamped row isn't among them.
 */
export function askTurnIn(rows: readonly StoredBranchRow[], id: AskId): { row: number; reply: string; ended: boolean } | undefined {
  const at = rows.findIndex((r) => r.role === "user" && askStamps(rowText(r.content)).includes(id));
  if (at < 0) return undefined;
  const texts: string[] = [];
  let ended = false;
  for (const r of rows.slice(at + 1)) {
    if (r.role === "user" && !NOT_A_TURN.has(String(r.display_kind ?? ""))) {
      ended = true;
      break;
    }
    const text = r.role === "assistant" ? rowText(r.content).trim() : "";
    if (text) texts.push(text);
  }
  return { row: rows[at].id, reply: texts.join("\n\n"), ended };
}

/**
 * Where each card goes among a chat's items: before the owner's first message stored after it was asked, keyed by that
 * item's id, or `null` for the end. A reply running when it was asked stays above it, as it showed then. Cards at one
 * place in the order asked. Row ids outlive a reload, a restart and a compression.
 */
export function placeAsks(items: readonly Item[], asks: readonly Ask[]): Map<string | null, Ask[]> {
  const placed = new Map<string | null, Ask[]>();
  for (const a of [...asks].sort((x, y) => x.at - y.at)) {
    const before = items.find((i) => {
      const row = (i as { rowId?: number }).rowId;
      return i.kind === "user" && row !== undefined && (a.afterRow === undefined || row > a.afterRow);
    });
    const key = before?.id ?? null;
    placed.set(key, [...(placed.get(key) ?? []), a]);
  }
  return placed;
}

/** An ask as a launch finds it: nothing runs after a restart, so what was under way is what it can be now. */
export function revive(a: Ask): Ask {
  const targets = a.targets.map((t): AskTarget => {
    const who = { profile: t.profile, handle: t.handle, name: t.name };
    if (t.state === "sending") return t.out ? { ...who, state: "unknown", seat: t.out } : { ...who, state: "failed", cause: "closed" };
    if (t.state === "answering" || t.state === "waiting") return { ...who, state: "waiting", why: "reading", seat: t.seat };
    return t;
  });
  return { ...a, targets };
}

const str = (v: unknown): v is string => typeof v === "string";
const seatOf = (v: unknown): AskSeat | undefined =>
  isObj(v) && str(v.session) ? { session: v.session, ...(typeof v.row === "number" && { row: v.row }) } : undefined;

function targetOf(v: unknown): AskTarget | undefined {
  if (!isObj(v) || !str(v.profile) || !str(v.handle) || !str(v.name)) return undefined;
  const who = { profile: v.profile, handle: v.handle, name: v.name };
  const seat = seatOf(v.seat);
  switch (v.state) {
    case "sending":
      return { ...who, state: "sending", ...(seatOf(v.out) && { out: seatOf(v.out) }) };
    case "failed":
      return v.cause === "refused" || v.cause === "closed" || v.cause === "never" ? { ...who, state: "failed", cause: v.cause, ...(str(v.reason) && { reason: v.reason }) } : undefined;
    case "unknown":
      return seat && { ...who, state: "unknown", seat, ...(str(v.reason) && { reason: v.reason }) };
    case "waiting":
      return seat && (v.why === "busy" || v.why === "reading") ? { ...who, state: "waiting", why: v.why, seat } : undefined;
    case "answering":
      return seat && str(v.reply) ? { ...who, state: "answering", seat, reply: v.reply } : undefined;
    case "answered":
      return seat && str(v.reply) && (v.ended === "complete" || v.ended === "interrupted" || v.ended === "error") ? { ...who, state: "answered", seat, reply: v.reply, ended: v.ended } : undefined;
  }
  return undefined;
}

/** An ask read from storage, or undefined if it isn't one: the only place stored JSON is trusted. */
export function toStoredAsk(v: unknown): Ask | undefined {
  if (!isObj(v) || !str(v.id) || !/^[0-9a-z]{10}$/.test(v.id) || !str(v.text) || typeof v.at !== "number" || !Array.isArray(v.targets)) return undefined;
  const targets = v.targets.map(targetOf);
  if (!targets.length || targets.some((t) => !t)) return undefined;
  const refs = Array.isArray(v.references) ? v.references.filter((r): r is SentReference => isObj(r) && str(r.title) && str(r.summary)) : [];
  return {
    id: v.id as AskId,
    text: v.text,
    at: v.at,
    ...(isObj(v.chat) && str(v.chat.id) && str(v.chat.title) && { chat: { id: v.chat.id, title: v.chat.title } }),
    ...(typeof v.afterRow === "number" && { afterRow: v.afterRow }),
    titles: Array.isArray(v.titles) ? v.titles.filter(str) : [],
    ...(refs.length && { references: refs }),
    targets: targets as AskTarget[],
  };
}

/** What the UI holds: the shown profile's asks. */
export type Asks = {
  subscribe(fn: () => void): () => void;
  /** Oldest first; the same array until something changes. */
  list(): readonly Ask[];
  /**
   * Sends `text` from the chat `chatId` to each bot. `title`: that chat's, for an ordinary chat; none for a Bot Chat. The
   * card is in `list()` before this returns; or why not.
   */
  send(chatId: string, to: readonly Who[], text: string, references: readonly SentReference[], title?: string): AskRefusal | undefined;
  /** A failed or unknown bot, sent again with the same id. An unknown one is looked for first, and sent only if missing. */
  retry(id: AskId, profile: string): void;
  /** Edit: the failed bots come off the card; the words, those bots' profiles and the references come back. */
  takeBack(id: AskId): { text: string; profiles: string[]; references: SentReference[] } | undefined;
  /** A bot comes off the card, in any state but `sending`; the card goes with its last bot. */
  dismiss(id: AskId, profile: string): void;
};

/** What the transport tells the store. Not on `Asks`, so the UI can't reach it. */
export type AskWire = {
  /** An event for a session no shown chat holds. True when it was an asked Bot Chat's. */
  hear(e: { type: string; sessionId?: string; payload: Record<string, unknown> }): boolean;
  /** A request (an Approval, a question) for an asked Bot Chat's turn: the card says it waits there. True when claimed. */
  asked(sessionId: string): boolean;
  /** Connected: the shown profile's unfinished asks are settled. */
  connected(): void;
  /** The connection went: every attached session with it. */
  detached(): void;
};

/** What the store needs from the transport: closures over its own pieces. */
export type AskPort = {
  /** The shown profile's bot, which asks and whose asks are listed. */
  shown(): Who;
  cantSend(): AskRefusal | undefined;
  /** The newest stored row of a chat of the shown profile. */
  newestRow(chatId: string): number | undefined;
  /** The bot's Bot Chat, made if it has none: the session to send to. */
  botChat(profile: string, name: string): Promise<string>;
  /** `inflightUser`: the message the running reply answers, as sent, stamp and all. `asking`: it waits on the owner. */
  attach(session: string, profile: string): Promise<{ runtimeId: string; running: boolean; inflight?: string; inflightUser?: string; asking: boolean }>;
  /** `prompt.submit` with `queued: true`; `going` as the frame leaves. Rejects `PromptUnconfirmedError` on a drop. */
  submit(runtimeId: string, profile: string, text: string, context: readonly string[], going: () => void): Promise<{ held: boolean; userRowId?: number }>;
  /** A page of a session's rows, newest pages first, oldest first within the page. */
  latestRows(session: string, profile: string, offset: number, limit: number): Promise<StoredBranchRow[]>;
  /** The transport's own event rule (`applyEvent`). */
  fold(scratch: Chat, type: string, payload: Record<string, unknown>): Chat;
  load(profile: string): unknown;
  /** False when storage refused it. */
  save(profile: string, asks: readonly Ask[]): boolean;
  track(work: Promise<unknown>): void;
};

type Key = { asker: string; id: AskId; profile: string };
type Heard = { type: string; payload: Record<string, unknown> };
/** An asked Bot Chat attached on this connection, and the asks listening on it. */
type Watch = {
  runtimeId: string;
  running: boolean;
  inflight?: string;
  inflightUser?: string;
  /** The running reply's text the resume read, until the turn's next frame: that frame may repeat its last delta. */
  resumed?: string;
  /** The running reply waits on the owner (an Approval in its Bot Chat), until a frame shows it going on. */
  asking: boolean;
  /** Submits and reads under way: what is heard meanwhile waits in `buffer`. */
  busy: number;
  buffer: Heard[];
  /** The turn running for asks: one, or several Hermes held and merged into one message. */
  current?: { keys: Key[]; scratch: Chat };
  held: Key[];
};

const blank = (text?: string): Chat => ({ id: "", title: "", source: "app", settled: false, updatedAt: 0, items: text ? [{ kind: "assistant", id: "a0", text }] : [] });
const replyOf = (c: Chat) =>
  c.items
    .flatMap((i) => (i.kind === "assistant" && i.text.trim() ? [i.text] : []))
    .join("\n\n");
const doingOf = (c: Chat): AskDoing | undefined => {
  const last = c.items.at(-1);
  return last?.kind === "thinking" ? "thinking" : last?.kind === "tool" ? "tool" : undefined;
};
const endedOf = (e: Heard) => (e.type === "error" || e.payload.status === "error" ? "error" : e.payload.status === "interrupted" ? "interrupted" : "complete");
const keyOf = (t: Key) => `${t.asker} ${t.id} ${t.profile}`;

export function createAsks(port: AskPort): { asks: Asks; wire: AskWire } {
  const ledgers = new Map<string, readonly Ask[]>();
  const watches = new Map<string, Watch>();
  const attached = new Map<string, Promise<Watch>>();
  const listeners = new Set<() => void>();
  let generation = 0;
  /** Attaches waiting for Hermes's answer, and what was heard meanwhile for sessions no watch holds: a running turn's
   * frames can come before the answer, as for any resume. */
  let attaching = 0;
  const early = new Map<string, Heard[]>();

  const ledger = (profile: string): readonly Ask[] => {
    let kept = ledgers.get(profile);
    if (!kept) {
      const raw = port.load(profile);
      kept = (Array.isArray(raw) ? raw : []).flatMap((v) => toStoredAsk(v) ?? []).map(revive);
      ledgers.set(profile, kept);
    }
    return kept;
  };
  const notify = () => listeners.forEach((fn) => fn());
  /** `keep`: also save it. A streaming reply only notifies; its turn's end is saved. */
  const write = (profile: string, change: (asks: readonly Ask[]) => readonly Ask[], keep = true): boolean => {
    const before = ledger(profile);
    let next = change(before).map((a) => {
      const resend = a.targets.some((t) => t.state === "sending" || t.state === "failed" || t.state === "unknown");
      if (resend || !a.references) return a;
      const { references: _, ...rest } = a;
      return rest;
    });
    while (next.length > ASKS_KEPT) {
      const old = next.findIndex((a) => a.targets.every((t) => t.state === "answered"));
      if (old < 0) break;
      next = next.filter((_, i) => i !== old);
    }
    if (next.length === before.length && next.every((a, i) => a === before[i])) return true;
    ledgers.set(profile, next);
    notify();
    return !keep || port.save(profile, next);
  };
  const find = (k: Key) => ledger(k.asker).find((a) => a.id === k.id);
  const targetAt = (k: Key) => find(k)?.targets.find((t) => t.profile === k.profile);
  const move = (k: Key, next: (t: AskTarget) => AskTarget | undefined, keep = true) =>
    write(k.asker, (asks) =>
      asks.map((a) => {
        if (a.id !== k.id) return a;
        const targets = a.targets.map((t) => (t.profile === k.profile ? (next(t) ?? t) : t));
        return targets.every((t, i) => t === a.targets[i]) ? a : { ...a, targets };
      }),
      keep,
    );
  const who = (t: Who): Who => ({ profile: t.profile, handle: t.handle, name: t.name });

  /** The asked Bot Chat attached on this connection, once per session. */
  const watchOf = (profile: string, session: string): Promise<Watch> => {
    const k = `${profile} ${session}`;
    let w = attached.get(k);
    if (!w) {
      const gen = generation;
      attaching++;
      w = port
        .attach(session, profile)
        .then((a) => {
          const heard = early.get(a.runtimeId) ?? [];
          early.delete(a.runtimeId);
          const watch: Watch = {
            runtimeId: a.runtimeId,
            running: a.running,
            ...(a.inflight && { inflight: a.inflight }),
            ...(a.inflightUser && { inflightUser: a.inflightUser }),
            ...(a.running && a.inflight && { resumed: a.inflight }),
            asking: a.asking,
            busy: 0,
            buffer: heard,
            held: [],
          };
          if (gen === generation) watches.set(a.runtimeId, watch);
          return watch;
        })
        .finally(() => {
          if (--attaching === 0) early.clear();
        });
      w.catch(() => attached.get(k) === w && attached.delete(k));
      attached.set(k, w);
    }
    return w;
  };

  /** Runs what was heard while a submit or a read was under way; a turn that started meanwhile is the ask's. */
  const drain = (w: Watch) => {
    if (w.busy) return;
    const heard = w.buffer.splice(0);
    for (const e of heard) feed(w, e);
  };

  const feed = (w: Watch, e: Heard) => {
    if (w.resumed !== undefined && (e.type.startsWith("message.") || e.type === "error")) {
      const text = w.resumed;
      w.resumed = undefined;
      if (e.type === "message.delta" && echoesInflight(text, e.payload)) return;
    }
    let now = w.current;
    if (!now) {
      // Hermes starts what it held once the running reply ends, as one message: it merges held words into one.
      if (e.type !== "message.start" || !w.held.length) return;
      now = w.current = { keys: w.held.splice(0), scratch: blank() };
      for (const k of now.keys) move(k, (t) => (t.state === "waiting" ? { ...who(t), state: "answering", seat: t.seat, reply: "" } : undefined));
    }
    const scratch = (now.scratch = port.fold(now.scratch, e.type, e.payload));
    if (e.type === "message.complete" || e.type === "error") {
      w.current = undefined;
      w.asking = false;
      const receipt = isObj(e.payload.persisted_turn) ? e.payload.persisted_turn : undefined;
      const row = typeof receipt?.user_row_id === "number" ? receipt.user_row_id : undefined;
      for (const k of now.keys)
        move(k, (t) => (t.state === "answering" ? { ...who(t), state: "answered", seat: { ...t.seat, ...(row !== undefined && { row }) }, reply: replyOf(scratch), ended: endedOf(e) } : undefined));
      return;
    }
    if (/^(message|tool|reasoning|thinking)\./.test(e.type)) w.asking = false;
    const reply = replyOf(scratch);
    const doing = w.asking ? "needs-you" : doingOf(scratch);
    for (const k of now.keys)
      move(k, (t) => (t.state === "answering" && (t.reply !== reply || t.doing !== doing) ? { ...who(t), state: "answering", seat: t.seat, reply, ...(doing && { doing }) } : undefined), false);
  };

  /** One bot's flight: its Bot Chat, attached, the message held behind any running reply, the outcome kept. */
  const fly = async (asker: Who, k: Key) => {
    const ask = find(k);
    const t = targetAt(k);
    if (!ask || !t) return;
    const gen = generation;
    let out: AskSeat | undefined;
    try {
      const session = await port.botChat(k.profile, t.name);
      const w = await watchOf(k.profile, session);
      const context = [askStampBlock(ask.id, asker, ask.chat), ...(ask.references ?? []).map(referenceBlock)];
      w.busy++;
      let res: { held: boolean; userRowId?: number };
      try {
        res = await port.submit(w.runtimeId, k.profile, ask.text, context, () => {
          out = { session };
          move(k, (x) => ({ ...who(x), state: "sending", out: { session } }));
        });
      } catch (e) {
        w.busy--;
        drain(w);
        throw e;
      }
      w.busy--;
      const seat = { session, ...(res.userRowId !== undefined && { row: res.userRowId }) };
      if (gen !== generation) {
        move(k, (x) => ({ ...who(x), state: "waiting", why: "reading", seat }));
        return;
      }
      if (res.held) {
        // What was heard meanwhile is the running reply's, and a turn that started since is this message's.
        w.held.push(k);
        move(k, (x) => ({ ...who(x), state: "waiting", why: "busy", seat }));
      } else {
        // What was heard before this message's turn started is a reply that ended as it came.
        const start = w.buffer.map((e) => e.type).lastIndexOf("message.start");
        for (const e of w.buffer.splice(0, start < 0 ? w.buffer.length : start)) feed(w, e);
        w.current = { keys: [k], scratch: blank() };
        move(k, (x) => ({ ...who(x), state: "answering", seat, reply: "" }));
      }
      drain(w);
    } catch (e) {
      if (e instanceof PromptUnconfirmedError && out) move(k, (x) => ({ ...who(x), state: "unknown", seat: out!, reason: errorText(e) }));
      else move(k, (x) => ({ ...who(x), state: "failed", cause: "refused", reason: errorText(e) }));
    }
  };

  /** A session's newest rows, back far enough to hold the ask's stamp, at most `PAGES` pages. */
  const walk = async (session: string, profile: string, id: AskId) => {
    let rows: StoredBranchRow[] = [];
    for (let page = 0; page < PAGES; page++) {
      const got = await port.latestRows(session, profile, page * PAGE, PAGE);
      rows = [...got, ...rows];
      if (got.length < PAGE || askTurnIn(rows, id)) break;
    }
    return rows;
  };

  /** Settles a bot the app lost sight of, from the asked Bot Chat's stored rows. Running it twice changes nothing. */
  const settle = async (k: Key) => {
    const t = targetAt(k);
    if (!t || !(t.state === "unknown" || (t.state === "waiting" && t.why === "reading"))) return;
    const seat = t.seat;
    const gen = generation;
    let w: Watch | undefined;
    try {
      w = await watchOf(k.profile, seat.session);
      w.busy++;
      const turn = askTurnIn(await walk(seat.session, k.profile, k.id), k.id);
      // Read on a connection since dropped: it stays as it was, for the next connection to read.
      if (gen !== generation) return;
      const ran = w.running;
      move(k, (x) => {
        if (x.state !== t.state) return undefined;
        if (!turn) {
          if (x.state === "waiting" && ran) {
            w!.held.push(k);
            return { ...who(x), state: "waiting", why: "busy", seat };
          }
          return { ...who(x), state: "failed", cause: "never" };
        }
        const at = { ...seat, row: turn.row };
        if (turn.ended || !ran) return { ...who(x), state: "answered", seat: at, reply: turn.reply, ended: "complete" };
        // Hermes stores a held message when it takes it, so a found stamp with a reply running ahead of it is still held.
        if (w!.inflightUser !== undefined && !askStamps(w!.inflightUser).includes(k.id)) {
          w!.held.push(k);
          return { ...who(x), state: "waiting", why: "busy", seat: at };
        }
        if (w!.current) w!.current.keys.push(k);
        else w!.current = { keys: [k], scratch: blank(w!.inflight ?? turn.reply) };
        if (w!.asking) return { ...who(x), state: "answering", seat: at, reply: w!.inflight ?? turn.reply, doing: "needs-you" };
        return { ...who(x), state: "answering", seat: at, reply: w!.inflight ?? turn.reply };
      });
    } catch {
      // It stays as it was, and is read again on the next connection.
    } finally {
      if (w) {
        w.busy--;
        drain(w);
      }
    }
  };

  /** Where the card goes: the asking chat's newest stored row, read from Hermes, as a turn it had this session has none here yet. */
  const place = async (profile: string, id: AskId, chatId: string) => {
    const gen = generation;
    const newest = (await port.latestRows(chatId, profile, 0, 1).catch(() => [])).at(-1)?.id;
    if (newest === undefined || gen !== generation) return;
    write(profile, (l) => l.map((a) => (a.id === id && (a.afterRow === undefined || newest > a.afterRow) ? { ...a, afterRow: newest } : a)));
  };

  const unfinished = (profile: string) =>
    ledger(profile).flatMap((a) => a.targets.flatMap((t) => (t.state === "unknown" || (t.state === "waiting" && t.why === "reading") ? [{ asker: profile, id: a.id, profile: t.profile }] : [])));

  const asks: Asks = {
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    list: () => ledger(port.shown().profile),
    send(chatId, to, text, references, title) {
      const why = port.cantSend();
      if (why) return why;
      const asker = port.shown();
      const afterRow = port.newestRow(chatId);
      const ask: Ask = {
        id: newAskId(),
        text,
        at: Date.now(),
        ...(title !== undefined && { chat: { id: chatId, title } }),
        ...(afterRow !== undefined && { afterRow }),
        titles: references.map((r) => r.title),
        ...(references.length && { references: [...references] }),
        targets: to.map((b) => ({ ...who(b), state: "sending" })),
      };
      const before = ledger(asker.profile);
      if (!write(asker.profile, (l) => [...l, ask])) {
        ledgers.set(asker.profile, before);
        notify();
        return "unsaved";
      }
      for (const t of ask.targets) port.track(fly(asker, { asker: asker.profile, id: ask.id, profile: t.profile }));
      port.track(place(asker.profile, ask.id, chatId));
      return undefined;
    },
    retry(id, profile) {
      const asker = port.shown();
      const k = { asker: asker.profile, id, profile };
      const t = targetAt(k);
      if (!t || (t.state !== "failed" && t.state !== "unknown") || port.cantSend()) return;
      port.track(
        (async () => {
          if (t.state === "unknown") await settle(k);
          if (targetAt(k)?.state !== "failed") return;
          move(k, (x) => ({ ...who(x), state: "sending" }));
          await fly(asker, k);
        })(),
      );
    },
    takeBack(id) {
      const profile = port.shown().profile;
      const ask = ledger(profile).find((a) => a.id === id);
      if (!ask?.targets.some((t) => t.state === "failed")) return undefined;
      const back = { text: ask.text, profiles: ask.targets.flatMap((t) => (t.state === "failed" ? [t.profile] : [])), references: ask.references ?? [] };
      write(profile, (l) => l.flatMap((a) => (a.id !== id ? [a] : a.targets.some((t) => t.state !== "failed") ? [{ ...a, targets: a.targets.filter((t) => t.state !== "failed") }] : [])));
      return back;
    },
    dismiss(id, profile) {
      const asker = port.shown().profile;
      const k = { asker, id, profile };
      if (!targetAt(k) || targetAt(k)?.state === "sending") return;
      for (const w of watches.values()) {
        w.held = w.held.filter((h) => keyOf(h) !== keyOf(k));
        if (w.current) w.current.keys = w.current.keys.filter((h) => keyOf(h) !== keyOf(k));
      }
      write(asker, (l) => l.flatMap((a) => (a.id !== id ? [a] : a.targets.length > 1 ? [{ ...a, targets: a.targets.filter((t) => t.profile !== profile) }] : [])));
    },
  };

  const wire: AskWire = {
    hear(e) {
      const w = e.sessionId ? watches.get(e.sessionId) : undefined;
      if (!w) {
        if (attaching && e.sessionId) early.set(e.sessionId, [...(early.get(e.sessionId) ?? []), { type: e.type, payload: e.payload }]);
        return false;
      }
      if (w.busy) w.buffer.push({ type: e.type, payload: e.payload });
      else feed(w, e);
      return true;
    },
    asked(sessionId) {
      const w = watches.get(sessionId);
      const now = w?.current;
      if (!w || !now?.keys.length) return false;
      w.asking = true;
      for (const k of now.keys) move(k, (t) => (t.state === "answering" ? { ...t, doing: "needs-you" } : undefined));
      return true;
    },
    connected() {
      for (const k of unfinished(port.shown().profile)) port.track(settle(k));
    },
    detached() {
      generation++;
      watches.clear();
      attached.clear();
      early.clear();
      for (const profile of ledgers.keys())
        write(profile, (l) =>
          l.map((a) => {
            const targets = a.targets.map((t): AskTarget => (t.state === "answering" || t.state === "waiting" ? { ...who(t), state: "waiting", why: "reading", seat: t.seat } : t));
            return targets.every((t, i) => t === a.targets[i]) ? a : { ...a, targets };
          }),
        );
    },
  };

  return { asks, wire };
}
