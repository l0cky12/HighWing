import { isBotChat } from "./bots";
import type { AskRule } from "./mentionPicker";
import type { Chat } from "./model";

/**
 * `imported`: an Imported transcript (ADR 0031). `bot`: a bot's Bot Chat (ADR 0066). `jobRun`: the session Hermes ran
 * a Scheduled job in, which Hermes takes no reply in.
 */
export type ChatKind = "ordinary" | "imported" | "bot" | "jobRun";

export type ChatPolicy = {
  /** In the chat list, the unread counts, the list saved on this computer, and reopened at launch. */
  listed: boolean;
  /** Its replies, failures, unread dot and live session can make Inbox entries. */
  inbox: boolean;
  /**
   * `live`: opened as a session on this connection, marked read, kept as a Saved copy, and sent to. `stored`: its
   * stored rows are read each time it opens; nothing is sent, marked or kept.
   */
  session: "live" | "stored";
  /** Which note stands in for the composer; none means the composer. */
  readOnly?: "imported" | "jobRun";
  /** Edit and Regenerate. */
  replay: boolean;
  branch: boolean;
  organize: boolean;
  remove: boolean;
  rename: "title" | "none";
  ofBot: boolean;
  link: boolean;
  /** Which "@handle" words ask a bot (ADR 0232, 0234): see `AskRule`. */
  asks: AskRule;
};

const LISTED = { listed: true, inbox: true, session: "live", branch: true, organize: true, remove: true, rename: "title", ofBot: false, link: true } as const;
const OF_BOT = { listed: false, inbox: true, session: "live", replay: true, organize: false, ofBot: true, link: false } as const;

export const CHAT_POLICY: Record<ChatKind, ChatPolicy> = {
  ordinary: { ...LISTED, replay: true, asks: "picked" },
  imported: { ...LISTED, readOnly: "imported", replay: false, asks: "none" },
  bot: { ...OF_BOT, branch: true, remove: false, rename: "none", asks: "named" },
  jobRun: { listed: false, inbox: false, session: "stored", readOnly: "jobRun", replay: false, branch: false, organize: false, remove: false, rename: "none", ofBot: false, link: true, asks: "none" },
};

/**
 * What counts as an ask in a chat now. Compare sends one message to two chats, and an ask goes to the named bot
 * instead of either, so an ordinary chat in it asks nobody (ADR 0234).
 */
export const askRule = (policy: ChatPolicy, comparing: boolean): AskRule => (comparing && policy.asks === "picked" ? "none" : policy.asks);

type Kinded = Pick<Chat, "source" | "bot" | "title">;

export const chatKind = (c: Kinded): ChatKind => (isBotChat(c) ? "bot" : c.source === "cron" ? "jobRun" : c.source === "import" ? "imported" : "ordinary");

export const policyOf = (c: Kinded): ChatPolicy => CHAT_POLICY[chatKind(c)];
