// Asks (ADR 0225): a message the owner sends from a Bot Chat to another bot by naming it with "@". It goes into that
// bot's own Bot Chat, in the bot's profile, as the owner's message, over the connection the asking chat is shown on.
// The asking chat shows it as a card with the bot's reply, and its own bot takes no turn. The desk owns every Ask of the
// shown profile and the sessions it resumed for them; the transport only hands it the wire.
import { EMPTY_LINE, step, type Line, type LineInput, type TurnEvent } from "./askLine";
import type { Bot } from "./bots";
import { referenceBlock } from "./chatReferences";
import type { Ask, AskState, Item, OutgoingItem, SentReference } from "./model";
import { neutralize } from "./projectContext";
import { PromptUnconfirmedError } from "./sessionProtocol";
import { errorText, isObj } from "./values";

/** What an Ask needs from the connection. Each is something the transport already does for a chat of the shown profile. */
export type AskPort = {
  /** Why nothing can be sent from this connection now, as for any message. */
  refusal(): string | undefined;
  connected(): boolean;
  items(chatId: string): readonly Item[] | undefined;
  /** The cards on screen, by the chat they were sent from. `nextFrame`: a streamed change, heard of once a frame. */
  shown(): Readonly<Record<string, readonly Ask[]>>;
  show(asks: Record<string, readonly Ask[]>, nextFrame?: boolean): void;
  /** The bot's Bot Chat, made first when it has none. */
  botChat(bot: AskableBot): Promise<string>;
  /** Resumes a chat of another profile on this connection. `newestRow`: the newest stored row it has. */
  resume(chatId: string, profile: string): Promise<{ runtimeId: string; newestRow?: number }>;
  /** What an event of a turn adds to the items the turn has shown so far, as a chat of the shown profile reads it. */
  said(items: readonly Item[], event: TurnEvent): Item[];
  /** Submits for Hermes to hold behind a running reply, never into it. `goingOut`: called as it goes, with the words sent. */
  submit(runtimeId: string, profile: string, message: { text: string; context: string[] }, goingOut: (prompt: string) => void): Promise<{ held: boolean; rowId?: number }>;
  /** The bot's outbox on this computer: `keep` adds a message, false when storage refused it; `change` maps or removes one. */
  keep(profile: string, chatId: string, row: OutgoingItem): boolean;
  change(profile: string, chatId: string, itemId: string, to: (row: OutgoingItem) => OutgoingItem | null): void;
};

/**
 * What every Ask tells the bot it goes to, before any Referenced chat: the chat it was sent from, which is how the card
 * is found again in the bot's Bot Chat after a restart, and that the owner is asking from another bot's chat.
 */
export const askedFromBlock = (chatId: string, bot: string) =>
  neutralize(`[Asked from: ${chatId}]\nThe owner sent you this message from their Bot Chat with ${bot.replace(/\s+/g, " ").trim()}, by naming you with "@". Answer the owner.`);

/** A bot as an Ask needs it: where its Bot Chat is, and whether the roster says it has one. */
export type AskableBot = Pick<Bot, "profile" | "name" | "handle" | "botChat">;

const UNSAVED = "This computer's storage is full, so the message couldn't be kept safe while it went, and wasn't sent. Free some space (Settings → General → Clear local cache), then retry.";

/** A bot's Bot Chat as this connection holds it for Asks. */
type Session = { profile: string; chatId: string; runtimeId: string; newestRow?: number; line: Line };

/** What an Ask was sent with, for Retry, and where its message is kept while Hermes hasn't confirmed it. */
type Trip = { from: string; fromBot: string; bot: AskableBot; text: string; references: SentReference[]; kept?: { chatId: string } };

export class AskDesk {
  private trips = new Map<string, Trip>();
  /** What the turn of each Ask being answered has shown so far. */
  private replies = new Map<string, Item[]>();
  private opening = new Map<string, Promise<Session>>();
  private sessions = new Map<string, Session>();
  /** Counts the connections this desk has stopped hearing, so what was opened on an earlier one is never used on the next. */
  private heardNoMore = 0;

  constructor(private readonly port: AskPort) {}

  /**
   * Sends the owner's message to each bot's Bot Chat, and shows a card for each in the chat `from`, whose bot is named
   * `fromBot`. Resolves at once with why nothing was sent, or nothing. While the app isn't connected the cards wait, and
   * go when it is.
   */
  ask(from: string, fromBot: string, bots: readonly AskableBot[], text: string, references: SentReference[] = []): string | undefined {
    const refused = this.port.refusal();
    if (refused) return refused;
    const items = this.port.items(from);
    if (!items) return "This chat isn't in the list.";
    const connected = this.port.connected();
    const cards = bots.map((bot): Ask => {
      const id = `ask-${crypto.randomUUID()}`;
      this.trips.set(id, { from, fromBot, bot, text, references });
      return {
        id,
        to: { profile: bot.profile, handle: bot.handle, name: bot.name },
        text,
        ...(references.length && { references: references.map((r) => r.title) }),
        ...(items.length && { after: items[items.length - 1].id }),
        afterIndex: items.length,
        reply: "",
        state: connected ? "sending" : "waiting",
      };
    });
    this.port.show({ ...this.port.shown(), [from]: [...(this.port.shown()[from] ?? []), ...cards] });
    if (connected) for (const c of cards) void this.go(c.id);
    return undefined;
  }

  /** Sends an Ask Hermes didn't take, or may not have, again as a new message. The first leaves the bot's outbox. */
  retry(id: string) {
    const card = this.card(id);
    const trip = this.trips.get(id);
    if (!card || !trip || (card.state !== "failed" && card.state !== "unknown")) return;
    this.unkeep(id, trip);
    if (!this.port.connected()) return this.set(id, { state: "waiting" });
    void this.go(id);
  }

  /** Takes away the card of an Ask that hasn't gone, and its message from the bot's outbox. One Hermes has stays. */
  dismiss(id: string) {
    const card = this.card(id);
    if (!card || (card.state !== "waiting" && card.state !== "failed" && card.state !== "unknown")) return;
    const trip = this.trips.get(id);
    if (trip) this.unkeep(id, trip);
    this.trips.delete(id);
    const shown = this.port.shown();
    const from = Object.keys(shown).find((chat) => shown[chat].some((a) => a.id === id));
    if (from) this.port.show({ ...shown, [from]: shown[from].filter((a) => a.id !== id) });
  }

  /** The connection is open: the Asks that waited for it go. */
  connected() {
    for (const card of Object.values(this.port.shown()).flat()) if (card.state === "waiting") void this.go(card.id);
  }

  /**
   * The connection stopped being heard. Hermes still has every message it confirmed, and their replies go on in the
   * bots' Bot Chats; the cards say they are no longer heard here. One on its way is settled by its own request failing.
   */
  disconnected() {
    this.drop();
    for (const card of Object.values(this.port.shown()).flat()) if (card.state === "held" || card.state === "replying") this.set(card.id, { state: "unheard" });
  }

  /** The shown profile changed: its cards are gone from the screen, and nothing sent for them is heard any more. */
  forget() {
    this.drop();
    this.trips.clear();
  }

  private drop() {
    this.heardNoMore++;
    this.opening.clear();
    this.sessions.clear();
    this.replies.clear();
  }

  /** Whether the runtime session is one resumed for an Ask, so its events and requests are no chat's. */
  owns(runtimeId: string): boolean {
    return this.sessions.has(runtimeId);
  }

  hear(runtimeId: string, event: TurnEvent) {
    const session = this.sessions.get(runtimeId);
    if (session) this.feed(session, { kind: "event", event });
  }

  /** The bot asked the owner something in the session. Only its own Bot Chat can answer, so the card says so. */
  asked(runtimeId: string) {
    const running = this.sessions.get(runtimeId)?.line.running;
    if (running?.owner === "ask" && this.card(running.ask)?.state === "replying") this.set(running.ask, { state: "replying", needsYou: true });
  }

  private async go(id: string) {
    const trip = this.trips.get(id);
    if (!trip) return;
    const { bot, text, references } = trip;
    this.set(id, { state: "sending" });
    let session: Session | undefined;
    try {
      session = await this.open(bot);
      if (this.trips.get(id) !== trip) return;
      const { profile, chatId } = session;
      const row: OutgoingItem = {
        kind: "user",
        id,
        text,
        ...(references.length && { references: references.map((r) => r.title) }),
        outgoing: { state: "sending", ...(references.length && { references }) },
      };
      if (!this.port.keep(profile, chatId, row)) throw new Error(UNSAVED);
      trip.kept = { chatId };
      this.feed(session, { kind: "submitted", ask: id });
      const context = [askedFromBlock(trip.from, trip.fromBot), ...references.map(referenceBlock)];
      const after = session.newestRow;
      const res = await this.port.submit(session.runtimeId, profile, { text, context }, (prompt) =>
        this.port.change(profile, chatId, id, (r) => ({ ...r, outgoing: { ...r.outgoing, sent: { prompt, ...(after !== undefined && { after }) } } })),
      );
      this.unkeep(id, trip);
      this.trips.delete(id);
      this.noteRows(session, [res.rowId]);
      this.feed(session, { kind: "answered", ask: id, held: res.held });
      // Hermes started its turn, though its start may not be heard yet.
      if (!res.held && this.card(id)?.state === "sending") this.set(id, { state: "replying" });
    } catch (e) {
      const unknown = e instanceof PromptUnconfirmedError;
      const reason = unknown ? `The connection dropped before Hermes confirmed it (${errorText(e)}).` : errorText(e);
      const state = unknown ? "unknown" : "failed";
      if (trip.kept) this.port.change(bot.profile, trip.kept.chatId, id, (r) => ({ ...r, outgoing: { ...r.outgoing, state, reason } }));
      if (session) this.feed(session, { kind: "refused", ask: id });
      this.set(id, { state, reason });
    }
  }

  /** The bot's Bot Chat resumed on this connection, once for every Ask to that bot. */
  private open(bot: AskableBot): Promise<Session> {
    const { profile } = bot;
    const known = this.opening.get(profile);
    if (known) return known;
    const connection = this.heardNoMore;
    const opening = (async (): Promise<Session> => {
      const chatId = await this.port.botChat(bot);
      const { runtimeId, newestRow } = await this.port.resume(chatId, profile);
      if (connection !== this.heardNoMore) throw new Error("The connection dropped before it went out.");
      const session: Session = { profile, chatId, runtimeId, newestRow, line: EMPTY_LINE };
      this.sessions.set(runtimeId, session);
      return session;
    })();
    this.opening.set(profile, opening);
    opening.catch(() => this.opening.get(profile) === opening && this.opening.delete(profile));
    return opening;
  }

  private feed(session: Session, input: LineInput) {
    if (this.sessions.get(session.runtimeId) !== session) return;
    const { line, out } = step(session.line, input);
    session.line = line;
    for (const o of out) {
      if (o.kind === "held") this.set(o.ask, { state: "held" });
      else if (o.kind === "started") this.set(o.ask, { state: "replying" });
      else if (o.kind === "heard") this.heard(o.ask, o.event);
      else this.ended(session, o.ask, o.event);
    }
  }

  /** The card's reply is the words the turn has shown: each stretch of them, apart from the tool calls between. */
  private heard(id: string, event: TurnEvent): Item[] {
    const items = this.port.said(this.replies.get(id) ?? [], event);
    this.replies.set(id, items);
    const reply = items.flatMap((i) => (i.kind === "assistant" && i.text.trim() ? [i.text.trim()] : [])).join("\n\n");
    if (reply !== this.card(id)?.reply) this.patch(id, (a) => ({ ...a, reply }), true);
    return items;
  }

  private ended(session: Session, id: string, event: TurnEvent) {
    const receipt = isObj(event.payload.persisted_turn) ? event.payload.persisted_turn : {};
    this.noteRows(session, [receipt.user_row_id, receipt.final_assistant_row_id, ...(Array.isArray(receipt.row_ids) ? receipt.row_ids : [])]);
    const items = this.heard(id, event);
    this.replies.delete(id);
    const failure = items.find((i): i is Extract<Item, { kind: "error" }> => i.kind === "error");
    const stopped = !!failure || items.some((i) => i.kind === "assistant" && i.interrupted);
    this.set(id, stopped ? { state: "stopped", ...(failure && { reason: failure.text }) } : { state: "answered" });
  }

  private noteRows(session: Session, ids: unknown[]) {
    const seen = ids.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
    if (seen.length) session.newestRow = Math.max(session.newestRow ?? -Infinity, ...seen);
  }

  private unkeep(id: string, trip: Trip) {
    if (!trip.kept) return;
    this.port.change(trip.bot.profile, trip.kept.chatId, id, () => null);
    trip.kept = undefined;
  }

  private card(id: string): Ask | undefined {
    return Object.values(this.port.shown()).flat().find((a) => a.id === id);
  }

  private set(id: string, state: AskState) {
    this.patch(id, ({ id: i, to, text, references, after, afterIndex, reply }) => ({ id: i, to, text, references, after, afterIndex, reply, ...state }));
  }

  private patch(id: string, fn: (a: Ask) => Ask, nextFrame = false) {
    const shown = this.port.shown();
    const from = Object.keys(shown).find((chat) => shown[chat].some((a) => a.id === id));
    if (from) this.port.show({ ...shown, [from]: shown[from].map((a) => (a.id === id ? fn(a) : a)) }, nextFrame);
  }
}

/**
 * Where each card shows among the asking chat's items: after the item it was sent after, or, when that item's id has
 * gone, as when the history is read again, after as many items as the chat had then. Keyed by the item's id; the cards
 * with no item before them are under `undefined`.
 */
export function placeAsks(asks: readonly Ask[], items: readonly Item[]): Map<string | undefined, Ask[]> {
  const ids = new Set(items.map((i) => i.id));
  const placed = new Map<string | undefined, Ask[]>();
  for (const a of asks) {
    const at = a.after !== undefined && ids.has(a.after) ? a.after : items[Math.min(a.afterIndex, items.length) - 1]?.id;
    placed.set(at, [...(placed.get(at) ?? []), a]);
  }
  return placed;
}
