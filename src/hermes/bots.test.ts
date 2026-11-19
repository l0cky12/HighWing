// Contract tests for Bot Mode (ADR 0066), mirroring Hermes's own in apps/desktop/src/plugins/hermes-bots/:
// bot-row-opens-canonical-chat, canonical-chat-creation, canonical-chat-adopt-on-conflict, canonical-chat-registry
// (no stored pointer) and new-compact-guard. The transport's side (hidden from the list and search, the open) is in
// botsTransport.test.ts.
import { describe, expect, it } from "vitest";
import { legacyOver } from "./fakeSessions";
import { BOT_CHAT_TITLE, BotChats, BotModeUnsupportedError, botActivity, botName, botsWaiting, isBotChat, isBotChatTitle, namedByProfile, newInBotChatNote, rosterOf, agentMessaging, messagingStep, rosterRows, type Bot, type BotActivity, type BotRpc } from "./bots";

type Call = { method: string; params: Record<string, unknown> };

/** A fake connection: each method answers from `answers`, in order when it is a list. */
function rpcOf(answers: Record<string, unknown | unknown[] | ((p: Record<string, unknown>) => unknown)>) {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(answers).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]));
  const rpc: BotRpc = async (method, params) => {
    calls.push({ method, params });
    const a = queues.get(method);
    const next = Array.isArray(a) ? a.shift() : typeof a === "function" ? (a as (p: Record<string, unknown>) => unknown)(params) : a;
    if (next instanceof Error) throw next;
    if (next === undefined) throw Object.assign(new Error(`no answer for ${method}`), { code: -32601 });
    return next;
  };
  return { rpc, calls, methods: () => calls.map((c) => c.method) };
}

const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code });
const listed = (...rows: Record<string, unknown>[]) => ({ sessions: rows });

describe("the bot row opens its Bot Chat", () => {
  it("opens the row the title lookup finds, at its lineage tip, and creates nothing", async () => {
    const { rpc, calls, methods } = rpcOf({ "session.list": listed({ id: "root-1", resolved_id: "tip-9", title: BOT_CHAT_TITLE }) });
    const opened = await new BotChats(rpc, () => legacyOver(rpc), "gui").open("scribe", "Scribe", true);
    expect(opened).toEqual({ registryId: "root-1", openId: "tip-9", created: false });
    expect(methods()).toEqual(["session.list"]);
    expect(calls[0].params).toEqual({ profile: "scribe", title: BOT_CHAT_TITLE, include_hidden: true, limit: 200 });
  });

  it("looks it up by title on every open and keeps no session id between opens", async () => {
    // The first lookup finds one row, the second a different one (say, restored from a backup): each open follows the
    // registry, never what an earlier open found.
    const { rpc, methods } = rpcOf({ "session.list": [listed({ id: "a", title: BOT_CHAT_TITLE }), listed({ id: "b", title: BOT_CHAT_TITLE })] });
    const chats = new BotChats(rpc, () => legacyOver(rpc), "gui");
    expect((await chats.open("ops", "Ops", true)).openId).toBe("a");
    expect((await chats.open("ops", "Ops", true)).openId).toBe("b");
    expect(methods()).toEqual(["session.list", "session.list"]);
  });

  it("never picks a row of another title, such as the newest chat, and creates nothing on such an answer", async () => {
    // A Hermes that ignored `title` lists its newest chats: that says nothing about whether a Bot Chat exists.
    const { rpc, methods } = rpcOf({ "session.list": listed({ id: "newest", title: "Release notes" }), "session.create": { session_id: "rt-1", stored_session_id: "s-1" } });
    await expect(new BotChats(rpc, () => legacyOver(rpc), "gui").open("ops", "Ops", false)).rejects.toThrow("Hermes answered the lookup of Ops's Bot Chat in a way this app doesn't read");
    expect(methods()).toEqual(["session.list"]);
  });

  it("creates nothing on a lookup answer it can't read", async () => {
    for (const answer of [{}, { sessions: "none" }, { sessions: [{ title: BOT_CHAT_TITLE }] }, { sessions: [null] }, null]) {
      const { rpc, methods } = rpcOf({ "session.list": () => answer, "session.create": { session_id: "rt-1", stored_session_id: "s-1" } });
      await expect(new BotChats(rpc, () => legacyOver(rpc), "gui").open("ops", "Ops", false), JSON.stringify(answer)).rejects.toThrow(/in a way this app doesn't read/);
      expect(methods()).toEqual(["session.list"]);
    }
  });
});

describe("creating a Bot Chat", () => {
  it("creates one only when the lookup finds none: hidden, following the profile's config, titled at once", async () => {
    const { rpc, calls } = rpcOf({
      "session.list": listed(),
      "session.create": { session_id: "rt-1", stored_session_id: "s-1" },
      "session.title": { title: BOT_CHAT_TITLE, pending: false },
    });
    expect(await new BotChats(rpc, () => legacyOver(rpc), "gui").open("scribe", "Scribe", false)).toEqual({ registryId: "s-1", openId: "s-1", created: true });
    expect(calls[1]).toEqual({ method: "session.create", params: { profile: "scribe", title: BOT_CHAT_TITLE, hidden: true, follow_profile_config: true, source: "gui" } });
    // Titled by its runtime id, which stores the row under the title.
    expect(calls[2]).toEqual({ method: "session.title", params: { session_id: "rt-1", title: BOT_CHAT_TITLE } });
    // No intro is sent: the owner speaks first.
    expect(calls.some((c) => c.method === "prompt.submit")).toBe(false);
  });

  it("creates once for a double click", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { rpc, methods } = rpcOf({
      "session.list": async () => {
        await held;
        return listed();
      },
      "session.create": { session_id: "rt-1", stored_session_id: "s-1" },
      "session.title": { title: BOT_CHAT_TITLE },
    });
    const chats = new BotChats(rpc, () => legacyOver(rpc), "gui");
    const first = chats.open("ops", "Ops", false);
    const second = chats.open("ops", "Ops", false);
    release();
    expect(await first).toEqual(await second);
    expect(methods().filter((m) => m === "session.create")).toHaveLength(1);
  });

  it("adopts the chat another client made meanwhile, when the title turns out to be taken", async () => {
    const { rpc, methods } = rpcOf({
      "session.list": [listed(), listed({ id: "theirs", resolved_id: "theirs", title: BOT_CHAT_TITLE })],
      "session.create": { session_id: "rt-1", stored_session_id: "mine" },
      "session.title": rpcError(4022, "Title 'Bot Chat' is already in use by session theirs"),
    });
    expect(await new BotChats(rpc, () => legacyOver(rpc), "gui").open("ops", "Ops", false)).toEqual({ registryId: "theirs", openId: "theirs", created: false });
    expect(methods()).toEqual(["session.list", "session.create", "session.title", "session.list"]);
  });

  it("says so when Hermes didn't name the new chat for another reason, and doesn't claim it", async () => {
    const { rpc } = rpcOf({
      "session.list": listed(),
      "session.create": { session_id: "rt-1", stored_session_id: "s-1" },
      "session.title": rpcError(5000, "database is locked"),
    });
    await expect(new BotChats(rpc, () => legacyOver(rpc), "gui").open("ops", "Ops", false)).rejects.toThrow("Hermes started Ops's Bot Chat but didn't name it: database is locked");
  });
});

describe("failing closed", () => {
  it("creates nothing when the lookup fails", async () => {
    const { rpc, methods } = rpcOf({ "session.list": new Error("timed out") });
    await expect(new BotChats(rpc, () => legacyOver(rpc), "gui").open("ops", "Ops", false)).rejects.toThrow("Couldn't look up Ops's Bot Chat, so no new one was started: timed out");
    expect(methods()).toEqual(["session.list"]);
  });

  it("creates nothing when the lookup comes back empty but the roster last named a Bot Chat", async () => {
    const { rpc, methods } = rpcOf({ "session.list": listed() });
    await expect(new BotChats(rpc, () => legacyOver(rpc), "gui").open("ops", "Ops", true)).rejects.toThrow("Hermes didn't confirm Ops's Bot Chat this time");
    expect(methods()).toEqual(["session.list"]);
  });

  it("calls a Hermes without the title lookup unsupported", async () => {
    const { rpc } = rpcOf({ "session.list": rpcError(-32601, "method not found") });
    await expect(new BotChats(rpc, () => legacyOver(rpc), "gui").open("ops", "Ops", false)).rejects.toBeInstanceOf(BotModeUnsupportedError);
  });

  it("lets a failed open be tried again", async () => {
    const { rpc } = rpcOf({ "session.list": [new Error("dropped"), listed({ id: "s-1", title: BOT_CHAT_TITLE })] });
    const chats = new BotChats(rpc, () => legacyOver(rpc), "gui");
    await expect(chats.open("ops", "Ops", true)).rejects.toThrow("dropped");
    expect((await chats.open("ops", "Ops", true)).openId).toBe("s-1");
  });
});

describe("the roster", () => {
  const row = (over: Record<string, unknown>) => ({ name: "scribe", path: "/x", is_default: false, description: "", display_name: "", canonical_session: null, ui_meta_revisions: {}, has_avatar: false, ...over });

  it("reads each profile as a bot, with its Bot Chat as profiles.list reports it", () => {
    const bots = rosterOf({
      profiles: [
        row({ name: "default", is_default: true }),
        row({
          description: "Writes  release notes",
          has_avatar: true,
          ui_meta: { "hermes-bots": { title: "Scribe", color: "#44aa77", pinned: true, chat: "a-stale-pointer" } },
          last_session: { id: "side", last_active: 100 },
          canonical_session: { id: "root", resolved_id: "tip", root_title: BOT_CHAT_TITLE, title: BOT_CHAT_TITLE, preview: "Draft the\nnotes", last_active: 200, message_count: 9, live_message_count: 3 },
        }),
      ],
      bot_mode_protocol: true,
    });
    expect(bots).toEqual([
      { profile: "default", name: "Hermes", handle: "hermes", description: "", isDefault: true, hasAvatar: false, hidden: false, pinned: false, block: "none", botChat: null, lastActive: 0 },
      {
        profile: "scribe",
        name: "Scribe",
        handle: "scribe",
        description: "Writes release notes",
        isDefault: false,
        hasAvatar: true,
        color: "#44aa77",
        hidden: false,
        pinned: true,
        block: "held",
        botChat: { id: "root", resolvedId: "tip", preview: "Draft the notes", lastActive: 200_000, messageCount: 3 },
        lastActive: 200_000,
      },
    ]);
  });

  it("names a bot by its title, then its display name, then the profile", () => {
    expect(botName({ name: "ops", display_name: "Operator", ui_meta: { "hermes-bots": { title: "Ops Desk" } } })).toBe("Ops Desk");
    expect(botName({ name: "ops", display_name: "Operator" })).toBe("Operator");
    expect(botName({ name: "release_notes-bot" })).toBe("Release Notes Bot");
    expect(botName({ name: "default" })).toBe("Hermes");
  });

  it("gives the default profile the handle hermes and every other bot its profile's name, whatever it is called", () => {
    const bots = rosterOf({
      profiles: [
        row({ name: "default", is_default: true, ui_meta: { "hermes-bots": { title: "Chief" } } }),
        row({ name: "release_notes", display_name: "Scribe" }),
      ],
    });
    expect(bots.map((b) => [b.name, b.handle])).toEqual([
      ["Chief", "hermes"],
      ["Scribe", "release_notes"],
    ]);
  });

  it("leaves the default profile at @default while a profile named hermes holds that handle, as Hermes does", () => {
    const bots = rosterOf({ profiles: [row({ name: "default", is_default: true }), row({ name: "hermes" })] });
    expect(bots.map((b) => b.handle)).toEqual(["default", "hermes"]);
  });

  it("is unsupported when the rows don't report a Bot Chat at all", () => {
    expect(() => rosterOf({ profiles: [{ name: "default", is_default: true }] })).toThrow(BotModeUnsupportedError);
    expect(() => rosterOf({ nope: true })).toThrow(BotModeUnsupportedError);
  });
});

describe("telling a Bot Chat apart", () => {
  it("matches the title exactly", () => {
    expect(isBotChatTitle("Bot Chat")).toBe(true);
    expect(isBotChatTitle(" Bot Chat ")).toBe(true);
    expect(isBotChatTitle("Bot Chat #2")).toBe(false);
    expect(isBotChatTitle(undefined)).toBe(false);
  });

  it("counts a chat as a Bot Chat when it was opened as one, or has the title, however it got it", () => {
    expect(isBotChat({ bot: true, title: "anything" })).toBe(true);
    // Renamed to the title in another client: in Hermes it is now the profile's Bot Chat.
    expect(isBotChat({ title: "Bot Chat" })).toBe(true);
    expect(isBotChat({ title: "Disk usage" })).toBe(false);
  });
});


describe("a bot's activity", () => {
  const bot = { profile: "ops", botChat: { id: "root", resolvedId: "tip", preview: "", lastActive: 0, messageCount: 0 } };
  it("matches the profile as well as the id, since a copied profile keeps its stored ids", () => {
    const copy = { profile: "ops-copy", botChat: { id: "root", resolvedId: "root", preview: "", lastActive: 0, messageCount: 0 } };
    const live = [{ chatId: "root", status: "waiting" as const, profile: "ops-copy" }];
    expect(botActivity(bot, live, undefined, [bot, copy])).toBeUndefined();
    expect(botActivity(copy, live, undefined, [bot, copy])).toBe("needs-you");
    // A session whose profile isn't known yet counts only for the one bot whose Bot Chat has its id.
    const unknown = [{ chatId: "root", status: "working" as const }];
    expect(botActivity(bot, unknown, undefined, [bot, copy])).toBeUndefined();
    expect(botActivity(bot, [{ chatId: "tip", status: "working" as const }], undefined, [bot, copy])).toBe("replying");
  });

  it("follows its Bot Chat only, by registry row or lineage tip", () => {
    expect(botActivity(bot, [{ chatId: "tip", status: "working" }])).toBe("replying");
    expect(botActivity(bot, [{ chatId: "root", status: "waiting" }])).toBe("needs-you");
    // A side-chat working in the same profile isn't the bot's row.
    expect(botActivity(bot, [{ chatId: "side", status: "working" }])).toBeUndefined();
    expect(botActivity({ profile: "ops", botChat: null }, [{ chatId: "root", status: "working" }])).toBeUndefined();
  });

  it("prefers what this connection holds for the open Bot Chat, which is fresher than the last check", () => {
    expect(botActivity(bot, [{ chatId: "root", status: "working" }], { running: false })).toBeUndefined();
    expect(botActivity(bot, [], { running: true })).toBe("replying");
    expect(botActivity(bot, [], { running: true, waiting: true })).toBe("needs-you");
  });

  it("says why /new compacted instead", () => {
    expect(newInBotChatNote({ kind: "compacted" })).toMatch(/one continuous conversation, so \/new compacts it .* Hermes compacted it\.$/);
    expect(newInBotChatNote({ kind: "nothing" })).toMatch(/nothing to compact yet/);
    expect(newInBotChatNote({ kind: "busy", message: "Hermes is already compacting this chat." })).toMatch(/already compacting/);
  });
});

describe("what waits in the other bots", () => {
  const bot = (profile: string, more: Partial<Bot> = {}): Bot => ({
    profile,
    name: profile,
    handle: profile,
    description: "",
    isDefault: false,
    hasAvatar: false,
    block: "none",
    hidden: false,
    pinned: false,
    botChat: null,
    lastActive: 0,
    ...more,
  });
  const doing = (by: Record<string, BotActivity>) => (b: Bot) => by[b.profile];

  it("names the bots in other profiles that need the owner, in roster order, and counts those replying", () => {
    const roster = [bot("ops"), bot("scout"), bot("quill"), bot("hearth"), bot("default")];
    const now = doing({ ops: "replying", scout: "needs-you", hearth: "needs-you", quill: "replying" });
    const { waiting, replying } = botsWaiting(roster, now, "default");
    expect(waiting.map((b) => b.profile)).toEqual(["scout", "hearth"]);
    expect(replying).toBe(2);
  });

  it("leaves out the shown profile's own bot and the bots hidden in Hermes", () => {
    const roster = [bot("default"), bot("scout", { hidden: true }), bot("ops", { hidden: true })];
    const now = doing({ default: "needs-you", scout: "needs-you", ops: "replying" });
    expect(botsWaiting(roster, now, "default")).toEqual({ waiting: [], replying: 0 });
  });

  it("is nothing when every bot is idle", () => {
    expect(botsWaiting([bot("a"), bot("b")], () => undefined, "a")).toEqual({ waiting: [], replying: 0 });
  });
});

describe("a bot named only by its profile", () => {
  it("is its id made readable, in any case, with any separators", () => {
    expect(namedByProfile("Hermes Chat", "hermes-chat")).toBe(true);
    expect(namedByProfile("Scout", "scout")).toBe(true);
    expect(namedByProfile("Night Shift", "night_shift")).toBe(true);
  });

  it("isn't when the name says something the id doesn't", () => {
    expect(namedByProfile("Hermes", "default")).toBe(false);
    expect(namedByProfile("Quill", "writer")).toBe(false);
    expect(namedByProfile("Hermes Chat 2", "hermes-chat")).toBe(false);
  });
});

describe("Bot messaging, read from the roster (ADR 0207)", () => {
  const row = (name: string, block?: Record<string, unknown>, revision = 0) => ({
    name,
    is_default: name === "default",
    canonical_session: null,
    ui_meta_revisions: revision ? { "hermes-bots": revision } : {},
    ...(block && { ui_meta: { "hermes-bots": block } }),
  });
  const messaging = (rows: Record<string, unknown>[]) => agentMessaging(rosterOf({ profiles: rows }));

  it("is off while no profile has a Bot Mode block", () => {
    expect(messaging([row("default"), row("quill")])).toEqual({ on: false });
    expect(messaging([row("default"), { ...row("quill"), ui_meta: { "another-app": { pinned: true } } }])).toEqual({ on: false });
  });

  it("is on with an empty block, which nothing keeps on", () => {
    expect(messaging([row("default", {}, 1), row("quill")])).toEqual({ on: true, keptOnBy: [] });
  });

  it("is on, and kept on, by a bot whose block holds something", () => {
    const now = messaging([row("default"), row("quill", { pinned: true }, 1), row("scout", { groups: [] }, 1)]);
    expect(now.on && now.keptOnBy.map((b) => b.profile)).toEqual(["quill", "scout"]);
  });

  describe("the next step toward on or off", () => {
    it("turns it on with one empty block on the default profile, checked against its revision", () => {
      expect(messagingStep([row("quill"), row("default", undefined, 4)], true)).toEqual({
        kind: "write",
        requests: [{ name: "default", ui_meta: { "hermes-bots": {} }, ui_meta_expected_revisions: { "hermes-bots": 4 } }],
      });
    });

    it("has nothing to do when any block is there already", () => {
      expect(messagingStep([row("default"), row("quill", { hidden: true }, 1)], true)).toEqual({ kind: "done" });
      expect(messagingStep([row("default"), row("quill")], false)).toEqual({ kind: "done" });
    });

    it("turns it off by deleting each empty block at its revision", () => {
      expect(messagingStep([row("default", {}, 1), row("quill", {}, 3), row("scout")], false)).toEqual({
        kind: "write",
        requests: [
          { name: "default", ui_meta: { "hermes-bots": null }, ui_meta_expected_revisions: { "hermes-bots": 1 } },
          { name: "quill", ui_meta: { "hermes-bots": null }, ui_meta_expected_revisions: { "hermes-bots": 3 } },
        ],
      });
    });

    it("keeps it on, and writes nothing, while a block holds something", () => {
      expect(messagingStep([row("default", {}, 1), row("quill", { pinned: false }, 2)], false)).toEqual({ kind: "kept", by: ["quill"] });
    });

    it("writes nothing to a Hermes whose rows report no revisions", () => {
      const blind = ({ ui_meta_revisions: _, ...rest }: ReturnType<typeof row>) => rest;
      expect(messagingStep([blind(row("default"))], true)).toEqual({ kind: "noCheck" });
      expect(messagingStep([blind(row("default", {}))], false)).toEqual({ kind: "noCheck" });
    });

    it("has nothing left to do once its writes are applied", () => {
      for (const want of [true, false]) {
        const rows = [row("default", want ? undefined : {}, 1), row("quill", want ? undefined : {}, 1)];
        const step = messagingStep(rows, want);
        if (step.kind !== "write") throw new Error(`expected a write, got ${step.kind}`);
        const after = rows.map((r) => {
          const write = step.requests.find((q) => q.name === r.name);
          return write ? row(r.name, (write.ui_meta as Record<string, Record<string, unknown> | null>)["hermes-bots"] ?? undefined, 2) : r;
        });
        expect(messagingStep(rosterRows({ profiles: after })!, want)).toEqual({ kind: "done" });
      }
    });
  });
});
