import { isBotChat } from "./bots";
import type { Chat } from "./model";
import { isThreadTitle } from "./threads";

/**
 * `imported`: an Imported transcript (ADR 0031). `bot`: a bot's Bot Chat (ADR 0066). `jobRun`: the session Hermes ran
 * a Scheduled job in, which Hermes takes no reply in.
 */
export type ChatKind = "ordinary" | "imported" | "bot" | "thread" | "jobRun";

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
  threadFrom: boolean;
  organize: boolean;
  remove: boolean;
  rename: "title" | "topic" | "none";
  ofBot: boolean;
  link: boolean;
};

const LISTED = { listed: true, inbox: true, session: "live", branch: true, threadFrom: false, organize: true, remove: true, rename: "title", ofBot: false, link: true } as const;
const OF_BOT = { listed: false, inbox: true, session: "live", replay: true, organize: false, ofBot: true, link: false } as const;

export const CHAT_POLICY: Record<ChatKind, ChatPolicy> = {
  ordinary: { ...LISTED, replay: true },
  imported: { ...LISTED, readOnly: "imported", replay: false },
  bot: { ...OF_BOT, branch: true, threadFrom: true, remove: false, rename: "none" },
  thread: { ...OF_BOT, branch: false, threadFrom: false, remove: true, rename: "topic" },
  jobRun: { listed: false, inbox: false, session: "stored", readOnly: "jobRun", replay: false, branch: false, threadFrom: false, organize: false, remove: false, rename: "none", ofBot: false, link: true },
};

type Kinded = Pick<Chat, "source" | "bot" | "title">;

/** The title decides first: a thread is never a Bot Chat, even when Hermes reports the Bot Chat as its lineage root. */
export const chatKind = (c: Kinded): ChatKind =>
  isThreadTitle(c.title) ? "thread" : isBotChat(c) ? "bot" : c.source === "cron" ? "jobRun" : c.source === "import" ? "imported" : "ordinary";

export const policyOf = (c: Kinded): ChatPolicy => CHAT_POLICY[chatKind(c)];
