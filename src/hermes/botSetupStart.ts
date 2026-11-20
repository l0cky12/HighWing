import { botSetupMarkerId } from "./botSetupBrief";
import type { Item } from "./model";
import type { SetupLine } from "./returned";
import { ConnectionLostError, PromptUnconfirmedError } from "./sessionProtocol";
// Starting Bot setup's interview (ADR 0231, "Starting the interview"). The brief is seeded as a hidden row when the Bot
// Chat is made, and a separate hidden begin turn starts the bot's first reply, so finding the brief can't say whether
// the interview ever began. Nothing about a start is kept in the app: each step is decided from the Bot Chat's stored
// rows, read again after every request. Two Creates, a lost answer and a relaunch therefore find the same rows and
// take the same step, and each ends with one brief row and one begin row.

/** The begin turn: the short hidden message that starts the bot's first reply to the brief with this id. */
export const botSetupBegin = (id: string) => `[highwing:bot-setup begin id=${id}]`;

/**
 * A brief sent as a turn, as Keep history sends it. Its begin line comes last, so its stored row is the setup's begin
 * turn too. A seeded brief has no begin line and gets a begin turn of its own.
 */
export const briefTurn = (brief: string, id: string) => `${brief}\n\n${botSetupBegin(id)}`;

/** A stored row of a Bot Chat, as far as starting reads it. */
export type SetupRow = { rowId: number; role: string; text: string; hidden: boolean };

/**
 * A Bot Chat as read just now: its stored rows, oldest first, and whether its session is running. `error`: what Hermes
 * said when the last turn this app heard there failed.
 */
export type StartRead = { chatId: string; rows: readonly SetupRow[]; running: boolean; error?: string };

/**
 * Where a start stands. `noBrief`: the profile has a Bot Chat this app didn't seed. `briefed`: `hidden` is whether
 * Hermes stored the brief hidden. `beganAt`: the stored row of the setup's first begin turn, which is the brief's own
 * row when it was sent as a turn (`briefTurn`).
 */
export type StartState =
  | { at: "noChat" }
  | { at: "noBrief"; chatId: string }
  | { at: "briefed"; chatId: string; id: string; hidden: boolean }
  | { at: "running"; chatId: string; id: string; beganAt: number }
  | { at: "noReply"; chatId: string; id: string; beganAt: number; error?: string }
  | { at: "started"; chatId: string; id: string; beganAt: number };

/**
 * Why Bot setup won't start. `tooOld`: Hermes says it is older than `BOT_SETUP_SINCE`. `noBotMode`: it has no Bot Mode.
 * `notHidden`: it stored the seeded brief where the owner would see it. `hasBotChat`: the bot already has a Bot Chat
 * with no brief in it, and a second one can't take the title.
 */
export type BotSetupRefusal = "tooOld" | "noBotMode" | "notHidden" | "hasBotChat";

/** How a start ended. `waiting`: the bot's first reply is running. `noReply`: it never came; only the owner asks again. */
export type BotSetupStart =
  | { kind: "refused"; reason: BotSetupRefusal }
  | { kind: "waiting" | "started"; chatId: string; id: string }
  | { kind: "noReply"; chatId: string; id: string; error?: string };

/** `again`: the owner pressed Try again, so a begin turn that got no reply is sent once more. */
export type StartAsk = "start" | "again";

export type StartStep = { do: "create" } | { do: "begin"; chatId: string; id: string } | { do: "end"; with: BotSetupStart };

/** Reads where a start stands from the newest brief among the stored rows, or from there being no Bot Chat. */
export function startState(read: StartRead | null): StartState {
  if (!read) return { at: "noChat" };
  const { chatId, rows, running, error } = read;
  const briefAt = rows.map((r) => r.role === "user" && botSetupMarkerId(r.text) !== null).lastIndexOf(true);
  if (briefAt < 0) return { at: "noBrief", chatId };
  const id = botSetupMarkerId(rows[briefAt].text)!;
  const fromBrief = rows.slice(briefAt);
  const begin = botSetupBegin(id);
  const begun = (r: SetupRow, n: number) => r.role === "user" && (n === 0 ? r.text.trimEnd().endsWith(`\n${begin}`) : r.text.trim() === begin);
  const begins = fromBrief.flatMap((r, n) => (begun(r, n) ? [n] : []));
  if (!begins.length) return { at: "briefed", chatId, id, hidden: rows[briefAt].hidden };
  const beganAt = fromBrief[begins[0]].rowId;
  if (fromBrief.slice(begins.at(-1)! + 1).some((r) => r.role === "assistant" && r.text.trim())) return { at: "started", chatId, id, beganAt };
  return running ? { at: "running", chatId, id, beganAt } : { at: "noReply", chatId, id, beganAt, ...(error && { error }) };
}

const STEPS: { [At in StartState["at"]]: (s: Extract<StartState, { at: At }>, ask: StartAsk) => StartStep } = {
  noChat: () => ({ do: "create" }),
  noBrief: () => ({ do: "end", with: { kind: "refused", reason: "hasBotChat" } }),
  briefed: (s) => (s.hidden ? { do: "begin", chatId: s.chatId, id: s.id } : { do: "end", with: { kind: "refused", reason: "notHidden" } }),
  running: (s) => ({ do: "end", with: { kind: "waiting", chatId: s.chatId, id: s.id } }),
  noReply: (s, ask) =>
    ask === "again" ? { do: "begin", chatId: s.chatId, id: s.id } : { do: "end", with: { kind: "noReply", chatId: s.chatId, id: s.id, ...(s.error && { error: s.error }) } },
  started: (s) => ({ do: "end", with: { kind: "started", chatId: s.chatId, id: s.id } }),
};

/** What the app does next from `state`: the ADR's table, one row per state. */
export const startStep = (state: StartState, ask: StartAsk): StartStep => (STEPS[state.at] as (s: StartState, ask: StartAsk) => StartStep)(state, ask);

/**
 * The chat's items with its one Setup started line for `line`, placed where the begin row `rowId` falls among the
 * stored rows the items show. A line already there for that setup stays where it is, and learns its row. `rowId`
 * undefined: the begin turn is going out now, so the line goes last. `id`: the item's id, when one is added.
 */
export function withSetupLine(items: Item[], line: SetupLine, id: string, rowId?: number): Item[] {
  const shown = (i: Item) => i.kind === "returned" && i.setup?.id === line.id;
  if (items.some(shown)) return items.map((i) => (shown(i) && i.kind === "returned" && i.rowId === undefined && rowId !== undefined ? { ...i, rowId } : i));
  const at = rowId === undefined ? -1 : items.findIndex((i) => "rowId" in i && i.rowId !== undefined && i.rowId > rowId);
  const item: Item = { kind: "returned", id, body: "", process: false, setup: line, ...(rowId !== undefined && { rowId }) };
  return at < 0 ? [...items, item] : [...items.slice(0, at), item, ...items.slice(at)];
}

/** What a start does to Hermes and the chat. Each request fails as the transport words it. */
export type StartIo = {
  /** The profile's Bot Chat, looked up by title and read now, or null when it has none. */
  read(): Promise<StartRead | null>;
  /** Makes the Bot Chat with the brief for the setup `id` seeded as a hidden row. */
  create(id: string): Promise<void>;
  /** Sends the hidden begin turn for the setup `id` into the Bot Chat. */
  begin(chatId: string, id: string): Promise<void>;
  /** Shows the setup's hidden rows as the chat's one Setup started line, at the begin row. */
  show(chatId: string, line: SetupLine, rowId: number): void;
  /** Hears whether Hermes stored a seeded brief hidden, each time one is read back before its begin turn. */
  readBack(hidden: boolean): void;
};

/** Whether a request went out and the connection dropped before Hermes answered, so Hermes may or may not have it. */
export const lostAnswer = (e: unknown) => e instanceof ConnectionLostError || e instanceof PromptUnconfirmedError;

/**
 * Takes a start as far as it goes: reads, takes the step the rows ask for, and reads again. A request whose answer was
 * lost is settled by that next read, never by sending it again: within one start the Bot Chat is created at most once
 * and the begin turn sent at most once. A later start reads the rows afresh, and sends the begin turn only when they
 * still hold none.
 */
export async function runStart(io: StartIo, ask: StartAsk, newId: () => string = () => crypto.randomUUID()): Promise<BotSetupStart> {
  const sent = new Set<"create" | "begin">();
  for (;;) {
    const state = startState(await io.read());
    if (state.at === "briefed") io.readBack(state.hidden);
    if ("beganAt" in state) io.show(state.chatId, { id: state.id }, state.beganAt);
    const step = startStep(state, sent.has("begin") ? "start" : ask);
    if (step.do === "end") return step.with;
    if (sent.has(step.do))
      throw new Error(step.do === "create" ? "Hermes took the new Bot Chat and doesn't list it, so no second one was started." : "Hermes took the message that starts Bot setup and doesn't show it. It wasn't sent twice.");
    sent.add(step.do);
    try {
      await (step.do === "create" ? io.create(newId()) : io.begin(step.chatId, step.id));
    } catch (e) {
      if (!lostAnswer(e)) throw e;
    }
  }
}

/** Runs starts, one at a time per profile: a second start for a profile while one runs joins it. */
export class BotSetupStarts {
  private flights = new Map<string, Promise<BotSetupStart>>();

  start(profile: string, run: () => Promise<BotSetupStart>): Promise<BotSetupStart> {
    const flight = this.flights.get(profile);
    if (flight) return flight;
    const started = run().finally(() => {
      if (this.flights.get(profile) === started) this.flights.delete(profile);
    });
    this.flights.set(profile, started);
    return started;
  }
}
