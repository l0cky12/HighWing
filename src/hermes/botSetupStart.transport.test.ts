// @vitest-environment jsdom
// Starting Bot setup through the real transport against FakeHermes as Hermes 0.23.2 (ADR 0231, "Starting the
// interview"): what goes to Hermes, what its stored rows hold after two Creates, a lost answer and a relaunch, and
// what the chat shows. The decisions themselves are in botSetupStart.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import { BOT_CHAT_TITLE } from "./bots";
import { botSetupBrief, botSetupMarkerId } from "./botSetupBrief";
import { botSetupBegin } from "./botSetupStart";
import { localChatCache } from "./chatCache";
import { chatJson, chatMarkdown } from "./exportChat";
import { FakeHermes, row } from "./fakeHermes";
import { connect, type Hermes } from "./transport";

const nas = { mode: "ssh" as const, sshTarget: "lena@nas", url: "", username: "lena" };

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const brief = (id: string) => botSetupBrief({ id, name: "Hermes", inventory: { models: ["claude-sonnet-4-5"], skills: ["notes"], toolsets: ["web"], bots: [] } });

function hermes0232(setup: (server: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.health = { ...server.health, version: "0.23.2", displayVersion: "0.23.2" };
  server.status = { ...server.status, version: "0.23.2" };
  server.sessions = [row("side", 1, { title: "Disk usage" })];
  server.transcripts = { side: [{ role: "user", text: "How full is the release disk?" }] };
  setup(server);
  return server;
}

/** The app launched on `server` and signed in, with the default profile's bot as the roster has it now. */
async function launch(server: FakeHermes) {
  const hermes = await connect(server.openPipe, undefined, localChatCache(nas));
  running.push(hermes);
  await hermes.sync();
  const me = async () => (await hermes.bots()).find((b) => b.profile === "default")!;
  return { hermes, me, start: async (ask?: "again") => hermes.startBotSetup(await me(), brief, ask) };
}

const rpc = (server: FakeHermes, method: string) => server.requests.filter((r) => r.method === method);
const kindOf = (text: string | undefined) => {
  const id = botSetupMarkerId(text ?? "");
  return id ? "brief" : /^\[highwing:bot-setup begin id=/.test(text ?? "") ? "begin" : (text ?? "");
};
/** Every stored row on the server that isn't the fixture chat's, as `[role, display kind, what]`. */
const stored = (server: FakeHermes) =>
  Object.entries(server.transcripts)
    .filter(([id]) => id !== "side")
    .flatMap(([, rows]) => rows.map((m) => [m.role, m.display_kind ?? null, kindOf(m.text)]));
const ONE_OF_EACH = [
  ["user", "hidden", "brief"],
  ["user", "hidden", "begin"],
];
const botChats = (server: FakeHermes) => server.sessions.filter((s) => s.title === BOT_CHAT_TITLE);
const chatOf = (hermes: Hermes, id: string) => hermes.getSnapshot().chats.find((c) => c.id === id)!;
const shown = (hermes: Hermes, id: string) => chatOf(hermes, id).items.map((i) => (i.kind === "returned" && i.setup ? "setup started" : i.kind));
/** The bot's reply to the turn the last `prompt.submit` started, streamed and stored as Hermes does. */
function reply(server: FakeHermes, chatId: string, text: string) {
  const sid = String(server.last("prompt.submit")!.params.session_id);
  server.event(sid, "message.start");
  server.event(sid, "message.delta", { text });
  server.storeMessage(chatId, { role: "assistant", text });
  server.event(sid, "message.complete", { text, status: "complete" });
}

describe("Create on Hermes 0.23.2", () => {
  it("makes the Bot Chat with the brief seeded hidden, then sends the hidden begin turn with the brief's id", async () => {
    const server = hermes0232();
    const { hermes, start } = await launch(server);
    const started = await start();
    expect(started).toEqual({ kind: "waiting", chatId: botChats(server)[0].id, id: expect.any(String) });
    if (started.kind !== "waiting") return;

    const [create] = rpc(server, "session.create");
    expect(create.params).toEqual({ profile: "default", title: BOT_CHAT_TITLE, hidden: true, follow_profile_config: true, source: "gui", messages: [{ role: "user", content: brief(started.id), display_kind: "hidden" }] });
    expect(rpc(server, "session.create")).toHaveLength(1);
    expect(rpc(server, "prompt.submit").map((r) => r.params)).toEqual([{ session_id: expect.any(String), profile: "default", text: botSetupBegin(started.id), display_kind: "hidden" }]);
    expect(botChats(server)).toMatchObject([{ hidden: true }]);
    expect(stored(server)).toEqual(ONE_OF_EACH);

    expect(chatOf(hermes, started.chatId)).toMatchObject({ bot: true, running: true, title: BOT_CHAT_TITLE });
    expect(shown(hermes, started.chatId)).toEqual(["setup started"]);
    reply(server, started.chatId, "I'm Hermes. What should I call you?");
    await hermes.idle();
    expect(shown(hermes, started.chatId)).toEqual(["setup started", "assistant"]);
    expect(await start()).toEqual({ kind: "started", chatId: started.chatId, id: started.id });
    expect(stored(server)).toEqual([...ONE_OF_EACH, ["assistant", null, "I'm Hermes. What should I call you?"]]);
  });

  it("keeps the line in the Saved copy as what it is, and leaves it out of an export", async () => {
    const server = hermes0232();
    const { hermes, start } = await launch(server);
    const started = await start();
    if (started.kind !== "waiting") throw new Error(started.kind);
    reply(server, started.chatId, "What should I call you?");
    await hermes.idle();
    const saved = localChatCache(nas).loadTranscript("default", started.chatId)?.items ?? [];
    expect(saved).toMatchObject([{ kind: "returned", body: "", setup: { id: started.id } }, { kind: "assistant" }]);
    const chat = chatOf(hermes, started.chatId);
    expect(JSON.parse(chatJson(chat, new Date(0)))[0].messages).toMatchObject([{ role: "assistant", content: "What should I call you?" }]);
    expect(chatMarkdown(chat, new Date(0))).not.toContain("Returned");
  });

  it("twice at once is one start: one Bot Chat, one brief, one begin", async () => {
    const server = hermes0232();
    const { start } = await launch(server);
    const [a, b] = await Promise.all([start(), start()]);
    expect(a).toEqual(b);
    expect(a.kind).toBe("waiting");
    expect(rpc(server, "session.create")).toHaveLength(1);
    expect(rpc(server, "prompt.submit")).toHaveLength(1);
    expect(stored(server)).toEqual(ONE_OF_EACH);
  });

  it("twice in a row finds the first: nothing is created or sent again", async () => {
    const server = hermes0232();
    const { start } = await launch(server);
    await start();
    expect(await start()).toMatchObject({ kind: "waiting" });
    expect(rpc(server, "session.create")).toHaveLength(1);
    expect(stored(server)).toEqual(ONE_OF_EACH);
  });

  it("writes nothing to the profile: only the session's own calls, and reads", async () => {
    const server = hermes0232();
    const { hermes, start } = await launch(server);
    await hermes.idle();
    const [rpcFrom, restFrom] = [server.requests.length, server.restRequests.length];
    const started = await start();
    if (started.kind !== "waiting") throw new Error(started.kind);
    reply(server, started.chatId, "What should I call you?");
    await hermes.idle();
    await start();

    const rest = server.restRequests.slice(restFrom);
    expect(rest.filter((r) => r.method !== "GET")).toEqual([]);
    expect(rest.filter((r) => /profiles|soul|config|memory|skills|toolsets|tools|mcp/i.test(r.path))).toEqual([]);
    const sent = [...new Set(server.requests.slice(rpcFrom).map((r) => r.method))].sort();
    expect(sent.filter((m) => !["profiles.list", "session.list", "session.create", "session.title", "session.resume", "prompt.submit", "subagent.list", "session.events.since"].includes(m))).toEqual([]);
    expect(sent).toEqual(expect.arrayContaining(["session.list", "session.create", "session.title", "prompt.submit"]));
    expect(server.uncheckedConfigures()).toEqual([]);
  });

  it("refuses a bot of another profile than the one shown", async () => {
    const server = hermes0232((s) => (s.otherProfiles = { scribe: [] }));
    const { hermes } = await launch(server);
    const scribe = (await hermes.bots()).find((b) => b.profile === "scribe")!;
    await expect(hermes.startBotSetup(scribe, brief)).rejects.toThrow("Switch to scribe first.");
    expect(rpc(server, "session.create")).toEqual([]);
  });
});

describe("a lost answer", () => {
  it.each(["stored", "lost"] as const)("to the create (%s) is settled by the title lookup and the rows: one brief, one begin", async (how) => {
    const server = hermes0232();
    const { hermes, start } = await launch(server);
    server.dropOnCreate = how;
    await expect(start()).rejects.toThrow("no new one was started");
    expect(stored(server)).toEqual(how === "stored" ? [ONE_OF_EACH[0]] : []);

    await hermes.reconnect();
    expect(await start()).toMatchObject({ kind: "waiting" });
    expect(rpc(server, "session.create")).toHaveLength(how === "stored" ? 1 : 2);
    expect(botChats(server)).toHaveLength(1);
    expect(stored(server)).toEqual(ONE_OF_EACH);
  });

  it.each(["stored", "lost"] as const)("to the begin turn (%s) is settled by reading the rows again: one brief, one begin", async (how) => {
    const server = hermes0232();
    const { hermes, start } = await launch(server);
    server.dropOnPrompt = how;
    await expect(start()).rejects.toThrow("no new one was started");
    expect(stored(server)).toEqual(how === "stored" ? ONE_OF_EACH : [ONE_OF_EACH[0]]);

    await hermes.reconnect();
    const again = await start();
    expect(again.kind).toBe(how === "stored" ? "noReply" : "waiting");
    expect(rpc(server, "session.create")).toHaveLength(1);
    expect(rpc(server, "prompt.submit")).toHaveLength(how === "stored" ? 1 : 2);
    expect(new Set(rpc(server, "prompt.submit").map((r) => r.params.text)).size).toBe(1);
    expect(stored(server)).toEqual(ONE_OF_EACH);
  });
});

describe("a relaunch", () => {
  /** A setup started by one launch of the app, which then quit. */
  async function startedBefore(server: FakeHermes) {
    const first = await launch(server);
    const started = await first.start();
    if (started.kind !== "waiting") throw new Error(started.kind);
    return { ...started, quit: () => first.hermes.close() };
  }

  it("waits while the first reply is still running, and sends nothing", async () => {
    const server = hermes0232((s) => (s.reattachTurns = true));
    const before = await startedBefore(server);
    await before.quit();
    const { hermes, start } = await launch(server);
    expect(await start()).toEqual({ kind: "waiting", chatId: before.chatId, id: before.id });
    expect(shown(hermes, before.chatId)).toEqual(["setup started"]);
    expect(stored(server)).toEqual(ONE_OF_EACH);
  });

  it("picks up a Bot Chat already shown at the click while its lookup ran, and settles it", async () => {
    const server = hermes0232();
    const before = await startedBefore(server);
    await before.quit();
    const { hermes, me, start } = await launch(server);
    expect(hermes.showBotChat(await me())).toBe(before.chatId);
    expect(chatOf(hermes, before.chatId).loading).toBe(true);
    expect(await start()).toEqual({ kind: "noReply", chatId: before.chatId, id: before.id });
    expect(chatOf(hermes, before.chatId).loading).toBeFalsy();
    expect(rpc(server, "session.resume").map((r) => r.params.session_id)).toContain(before.chatId);
  });

  it("says no reply came when none did, keeps the bot, and sends the begin turn again only when the owner asks", async () => {
    const server = hermes0232();
    const before = await startedBefore(server);
    await before.quit();
    const { hermes, start } = await launch(server);
    expect(await start()).toEqual({ kind: "noReply", chatId: before.chatId, id: before.id });
    expect(await start()).toMatchObject({ kind: "noReply" });
    expect(shown(hermes, before.chatId)).toEqual(["setup started"]);
    expect(stored(server)).toEqual(ONE_OF_EACH);
    expect(botChats(server)).toHaveLength(1);

    expect(await start("again")).toEqual({ kind: "waiting", chatId: before.chatId, id: before.id });
    expect(stored(server)).toEqual([...ONE_OF_EACH, ONE_OF_EACH[1]]);
    expect(shown(hermes, before.chatId)).toEqual(["setup started"]);
  });

  it("carries on a started interview: the hidden rows are no message of the owner's, and the line sits before the first reply", async () => {
    const server = hermes0232();
    const before = await startedBefore(server);
    reply(server, before.chatId, "What should I call you?");
    server.storeMessage(before.chatId, { role: "user", text: "Liam" });
    server.storeMessage(before.chatId, { role: "assistant", text: "What do you want me to help with?" });
    await before.quit();

    const { hermes, me, start } = await launch(server);
    const chatId = await hermes.openBotChat(await me());
    await hermes.open(chatId);
    const resumed = rpc(server, "session.resume").at(-1)!;
    expect(resumed.params).toMatchObject({ session_id: before.chatId });
    expect(chatOf(hermes, chatId).items.map((i) => [i.kind, "text" in i ? i.text : ""])).toEqual([
      ["assistant", "What should I call you?"],
      ["user", "Liam"],
      ["assistant", "What do you want me to help with?"],
    ]);

    expect(await start()).toEqual({ kind: "started", chatId, id: before.id });
    expect(shown(hermes, chatId)).toEqual(["setup started", "assistant", "user", "assistant"]);
    expect(chatOf(hermes, chatId).items.filter((i) => i.kind === "user").map((i) => (i.kind === "user" ? i.text : ""))).toEqual(["Liam"]);
    expect(rpc(server, "session.create")).toHaveLength(1);
    expect(rpc(server, "prompt.submit")).toHaveLength(1);
  });
});

describe("a begin turn that fails", () => {
  it("shows Hermes's error with the outcome, keeps the bot, and Try again sends the begin turn once more", async () => {
    const server = hermes0232();
    const { hermes, start } = await launch(server);
    const started = await start();
    if (started.kind !== "waiting") throw new Error(started.kind);
    const sid = String(server.last("prompt.submit")!.params.session_id);
    server.event(sid, "message.start");
    server.event(sid, "error", { message: "No API key for openrouter." });
    await hermes.idle();

    expect(await start()).toEqual({ kind: "noReply", chatId: started.chatId, id: started.id, error: "No API key for openrouter." });
    expect(shown(hermes, started.chatId)).toEqual(["setup started", "error"]);
    expect(rpc(server, "prompt.submit")).toHaveLength(1);
    expect(botChats(server)).toHaveLength(1);

    expect(await start("again")).toMatchObject({ kind: "waiting" });
    expect(rpc(server, "prompt.submit").map((r) => r.params.text)).toEqual([botSetupBegin(started.id), botSetupBegin(started.id)]);
    reply(server, started.chatId, "What should I call you?");
    await hermes.idle();
    expect(await start()).toMatchObject({ kind: "started" });
    expect(shown(hermes, started.chatId)).toEqual(["setup started", "error", "assistant"]);
  });

  it("leaves the chat as it was when Hermes turns the begin turn down", async () => {
    const server = hermes0232();
    const { hermes, start } = await launch(server);
    server.rejectPrompt = { code: 4009, message: "session busy" };
    await expect(start()).rejects.toThrow("session busy");
    const chatId = botChats(server)[0].id;
    expect(chatOf(hermes, chatId)).toMatchObject({ running: false, items: [] });
    expect(stored(server)).toEqual([ONE_OF_EACH[0]]);

    server.rejectPrompt = undefined;
    expect(await start()).toMatchObject({ kind: "waiting" });
    expect(stored(server)).toEqual(ONE_OF_EACH);
  });
});

describe("where Bot setup is off", () => {
  it("refuses below 0.23.2 with the reason, and sends nothing", async () => {
    const server = hermes0232((s) => {
      s.health = { ...s.health, version: "0.23.1", displayVersion: "0.23.1" };
      s.status = { ...s.status, version: "0.23.1" };
    });
    const { hermes, start } = await launch(server);
    await hermes.capabilities.refresh();
    const lookups = rpc(server, "session.list").length;
    expect(hermes.botSetupOff()).toBe("tooOld");
    expect(await start()).toEqual({ kind: "refused", reason: "tooOld" });
    expect(rpc(server, "session.list")).toHaveLength(lookups);
    expect(rpc(server, "session.create")).toEqual([]);
  });

  it("proceeds on 0.23.2 once the version is read", async () => {
    const server = hermes0232();
    const { hermes, start } = await launch(server);
    await hermes.capabilities.refresh();
    expect(hermes.capabilities.getSnapshot().facts.version).toBe("0.23.2");
    expect(hermes.botSetupOff()).toBeUndefined();
    expect(await start()).toMatchObject({ kind: "waiting" });
    expect(hermes.capabilities.get("botSetup")).toMatchObject({ state: "supported" });
  });

  it("refuses on a Hermes without Bot Mode", async () => {
    const server = hermes0232((s) => (s.botMode = "none"));
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    await hermes.sync();
    await hermes.idle();
    const me = { profile: "default", name: "Hermes", handle: "hermes", description: "", isDefault: true, hasAvatar: false, hidden: false, pinned: false, block: "none" as const, botChat: null, lastActive: 0 };
    expect(await hermes.startBotSetup(me, brief)).toEqual({ kind: "refused", reason: "noBotMode" });
    expect(rpc(server, "session.create")).toEqual([]);
  });

  it("turns off for a Hermes that stores the seeded brief unhidden: no begin turn, and diagnostics says why", async () => {
    const server = hermes0232();
    const create = server.handlers["session.create"];
    server.handlers["session.create"] = (r) =>
      create({ ...r, params: { ...r.params, messages: (r.params.messages as Record<string, unknown>[]).map(({ display_kind: _, ...m }) => m) } });
    const { hermes, start } = await launch(server);
    expect(await start()).toEqual({ kind: "refused", reason: "notHidden" });
    expect(stored(server)).toEqual([["user", null, "brief"]]);
    expect(rpc(server, "prompt.submit")).toEqual([]);
    expect(hermes.capabilities.get("botSetup")).toMatchObject({ state: "unsupported", why: expect.stringContaining("where the owner sees it") });

    const lookups = rpc(server, "session.list").length;
    expect(hermes.botSetupOff()).toBe("notHidden");
    expect(await start()).toEqual({ kind: "refused", reason: "notHidden" });
    expect(rpc(server, "session.list")).toHaveLength(lookups);
  });

  it("refuses a bot whose Bot Chat has no brief, and seeds nothing into it", async () => {
    const server = hermes0232((s) => {
      s.sessions.push(row("bot-chat", 0, { title: BOT_CHAT_TITLE, hidden: true }));
      s.transcripts["bot-chat"] = [{ role: "user", text: "Watch the release disk" }];
    });
    const { start } = await launch(server);
    expect(await start()).toEqual({ kind: "refused", reason: "hasBotChat" });
    expect(rpc(server, "session.create")).toEqual([]);
    expect(rpc(server, "prompt.submit")).toEqual([]);
  });

  it("drops its seeded session when another client's Bot Chat took the title first", async () => {
    const server = hermes0232();
    const lookup = server.handlers["session.list"];
    const emptyLookups = ["the start's own", "the creation's"];
    server.handlers["session.list"] = (r) => {
      if (!emptyLookups.length) return lookup(r);
      server.respond(r.id, { sessions: [] });
      emptyLookups.pop();
      if (!emptyLookups.length) server.sessions.push(row("theirs", 0, { title: BOT_CHAT_TITLE, hidden: true }));
    };
    const { hermes, start } = await launch(server);
    expect(await start()).toEqual({ kind: "refused", reason: "hasBotChat" });
    await hermes.idle();
    expect(rpc(server, "session.create")).toHaveLength(1);
    expect(server.sessions.map((s) => s.id).sort()).toEqual(["side", "theirs"]);
    expect(rpc(server, "prompt.submit")).toEqual([]);
  });
});
