// Set up again (ADR 0231): Bot setup run once more on a bot that exists. Keep history sends the brief into the Bot Chat
// as it is. Start fresh archives that chat, clears the bot's memory and seeds a new Bot Chat. Here is what needs no
// connection: what the brief says the bot has now, when a Bot Chat is too busy for either, and Start fresh's steps as a
// table, each with what a failure of it leaves in Hermes.
// Start fresh can't be undone past its archive: Hermes frees the title "Bot Chat" as it archives, and unarchiving
// doesn't give it back. So the steps before the archive stop the run with Hermes as it was, and the steps after it that
// only tidy up are noted and passed over, since stopping there would leave the bot with no Bot Chat for nothing.
import { BOT_SETUP_COLORS, type BotSetupCurrent } from "./botSetupBrief";
import { setPicture } from "./botPictures";
import { BOT_SETUP_COLOR_HEX, type HermesNow } from "./botSetupCard";
import type { BotSetupRefusal, BotSetupStart } from "./botSetupStart";
import type { MemoryEntry } from "./memory";
import { isWaiting, type Chat } from "./model";
import { errorText } from "./values";

/** How the bot is set up now, for Set up again's brief, from the same reads of Hermes the card's "before" comes from. */
export function currentSetup(now: HermesNow): BotSetupCurrent {
  const on = (rows: readonly { name: string; enabled: boolean }[]) => rows.filter((r) => r.enabled).map((r) => r.name);
  return {
    persona: now.persona,
    description: now.description,
    model: now.model,
    color: BOT_SETUP_COLORS.find((c) => BOT_SETUP_COLOR_HEX[c] === now.color) ?? now.color,
    picture: now.picture === null ? null : (setPicture(now.picture) ?? "own"),
    skillsOn: on(now.skills),
    toolsetsOn: on(now.toolsets),
    ...(now.mcp && { mcp: now.mcp.servers }),
  };
}

/** Why a Bot Chat can't take Set up again now: an Approval or another Question waits in it, or a reply runs. */
export type AgainBusy = "waiting" | "replying";

export const againBusy = (chat: Pick<Chat, "running" | "items"> | undefined): AgainBusy | undefined =>
  chat?.items.some(isWaiting) ? "waiting" : chat?.running ? "replying" : undefined;

/** `entries`: the memory entries the question counted and showed the owner, which Start fresh removes. */
export type AgainAsk = { how: "keep" } | { how: "fresh"; entries: readonly MemoryEntry[] };

export type AgainStart = BotSetupStart | { kind: "refused"; reason: AgainBusy };

export type FreshStepName = "check" | "leave" | "archive" | "lookup" | "retitle" | "memory" | "start";

/**
 * What Hermes holds when a step stops Start fresh. `asItWas`: nothing archived, nothing cleared. `archived`: the old
 * Bot Chat is archived and the bot has none; its memory is as it was. `noChat`: the same, after the memory step ran.
 */
export type FreshLeft = "asItWas" | "archived" | "noChat";

/**
 * How Start fresh ended. `refused`: nothing was sent; `default` is the main bot, which never starts fresh. `stopped`:
 * the step `at` failed with `why`. `titleKept`: Hermes still finds the old chat by its title after archiving it, so it
 * was unarchived (`restored`: whether that went in) and no memory was cleared. `fresh`: the new Bot Chat's start;
 * `missed`, why each tidying step that failed did, by its name; `memoryLeft`, the entries still there.
 */
export type FreshEnd =
  | { kind: "refused"; reason: BotSetupRefusal | AgainBusy | "default" }
  | { kind: "stopped"; at: FreshStepName; left: FreshLeft; why: string }
  | { kind: "titleKept"; restored: boolean }
  | { kind: "fresh"; start: BotSetupStart; missed: FreshMissed; memoryLeft: number };

export type FreshMissed = Partial<Record<FreshStepName, string>>;

/** What Start fresh does to Hermes. Each call rejects as the transport words it. */
export type FreshIo = {
  /** The bot's Bot Chat, looked up by title and opened here so what runs in it is known; null when it has none. */
  find(): Promise<{ chatId: string; busy?: AgainBusy } | null>;
  /** The old Bot Chat an earlier Start fresh of this bot archived and didn't name, while Hermes has it so; else null. */
  unnamed(): Promise<string | null>;
  leave(chatId: string): Promise<void>;
  /** Rejects unless Hermes has the chat archived when read back. */
  archive(chatId: string): Promise<void>;
  titleTaken(): Promise<boolean>;
  /** Resolves to whether Hermes has the chat unarchived when read back. */
  unarchive(chatId: string): Promise<boolean>;
  retitle(chatId: string): Promise<void>;
  /** Removes the memory entries the owner was shown. Resolves to how many are still there. */
  clearMemory(): Promise<number>;
  /** Makes the new Bot Chat with the brief seeded and starts the bot's first reply. */
  start(): Promise<BotSetupStart>;
};

/** `unnamed`: when the bot has no Bot Chat, the old one an earlier run archived and stopped before naming. */
type FreshRun = { old: string | null; unnamed: string | null; missed: FreshMissed; memoryLeft: number };

/**
 * One step before the new Bot Chat is made. `on: "old"`: it acts on the old Bot Chat, so a bot that has none, as after
 * a Start fresh that stopped, passes it over. `fail`: when it rejects, stop with Hermes left so, or note it and carry on.
 */
type FreshStep = { name: Exclude<FreshStepName, "start">; fail: FreshLeft | "carryOn" } & (
  | { on: "bot"; run(io: FreshIo, run: FreshRun): Promise<FreshEnd | void> }
  | { on: "old"; run(io: FreshIo, old: string): Promise<FreshEnd | void> }
);

export const FRESH_STEPS: readonly FreshStep[] = [
  {
    name: "check",
    on: "bot",
    fail: "asItWas",
    run: async (io, run) => {
      const found = await io.find();
      if (found?.busy) return { kind: "refused", reason: found.busy };
      run.old = found?.chatId ?? null;
      // A failed read passes the unnamed chat over, as one Hermes no longer has: stopping here would tell the owner
      // nothing changed while the bot has no Bot Chat.
      run.unnamed = found ? null : await io.unnamed().catch(() => null);
    },
  },
  { name: "leave", on: "old", fail: "asItWas", run: (io, old) => io.leave(old) },
  {
    name: "archive",
    on: "old",
    fail: "archived",
    // An archive whose read-back failed may have gone in, and freed the title with it, so only the lookup still
    // finding the old chat says Hermes is as it was.
    run: async (io, old) => {
      try {
        await io.archive(old);
      } catch (e) {
        if (await io.titleTaken().catch(() => false)) return { kind: "stopped", at: "archive", left: "asItWas", why: errorText(e) };
        throw e;
      }
    },
  },
  {
    name: "lookup",
    on: "old",
    fail: "archived",
    run: async (io, old) => {
      if (await io.titleTaken()) return { kind: "titleKept", restored: await io.unarchive(old).catch(() => false) };
    },
  },
  {
    name: "retitle",
    on: "bot",
    fail: "carryOn",
    run: async (io, run) => {
      const chatId = run.old ?? run.unnamed;
      if (chatId) await io.retitle(chatId);
    },
  },
  {
    name: "memory",
    on: "bot",
    fail: "carryOn",
    run: async (io, run) => {
      run.memoryLeft = await io.clearMemory();
    },
  },
];

/** Start fresh: `FRESH_STEPS` in order to the first that ends it, then the new Bot Chat, whose failure leaves the bot with none. */
export async function runFresh(io: FreshIo): Promise<FreshEnd> {
  const run: FreshRun = { old: null, unnamed: null, missed: {}, memoryLeft: 0 };
  const stopped = (at: FreshStepName, left: FreshLeft, e: unknown): FreshEnd => ({ kind: "stopped", at, left, why: errorText(e) });
  for (const step of FRESH_STEPS) {
    try {
      const end = step.on === "bot" ? await step.run(io, run) : run.old === null ? undefined : await step.run(io, run.old);
      if (end) return end;
    } catch (e) {
      if (step.fail !== "carryOn") return stopped(step.name, step.fail, e);
      run.missed[step.name] = errorText(e);
    }
  }
  try {
    return { kind: "fresh", start: await io.start(), missed: run.missed, memoryLeft: run.memoryLeft };
  } catch (e) {
    return stopped("start", "noChat", e);
  }
}
