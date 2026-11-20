// @vitest-environment jsdom
// Set up again through the real transport against FakeHermes as Hermes 0.23.2 (ADR 0231, "Set up again"): what Keep
// history and Start fresh send, what Hermes holds after each way Start fresh can end, and what the chat shows. The
// steps themselves are in botSetupAgain.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import { BOT_CHAT_TITLE } from "./bots";
import { botSetupBrief, botSetupMarkerId } from "./botSetupBrief";
import { localChatCache } from "./chatCache";
import { FakeHermes, row } from "./fakeHermes";
import type { MemoryEntry } from "./memory";
import { connect, type Hermes } from "./transport";

const nas = { mode: "ssh" as const, sshTarget: "lena@nas", url: "", username: "lena" };
const BOT = "travel-buddy";
const OLD = "travel-chat";
const EARLIER = "Earlier Bot Chat with Travel Buddy, 19 Nov 2026, 14:05";

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

function hermes0232(setup: (server: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.health = { ...server.health, version: "0.23.2", displayVersion: "0.23.2" };
  server.status = { ...server.status, version: "0.23.2" };
  server.learningRoutes = true;
  server.otherProfiles = { [BOT]: [row(OLD, 0.5, { title: BOT_CHAT_TITLE, hidden: true }), row("trip", 1, { title: "Rome in May" })] };
  server.transcripts = {
    [OLD]: [
      { role: "user", text: "Rome to Florence?", row_id: 1 },
      { role: "assistant", text: "The 09:10 Frecciarossa is quickest.", row_id: 2 },
    ],
  };
  server.skills.profiles.add(BOT);
  server.souls[BOT] = "You are Travel Buddy.";
  server.profileMeta = { [BOT]: { description: "Plans trips.", ui_meta: { "hermes-bots": { title: "Travel Buddy", color: "#14b8a6" } } } };
  server.memory[BOT] = { memory: ["Rome trip is in May."], profile: ["The owner wants to be called Lena.", "Prefers trains."] };
  setup(server);
  return server;
}

async function launch(server: FakeHermes, profile = BOT) {
  const hermes = await connect(server.openPipe, profile, localChatCache(nas));
  running.push(hermes);
  await hermes.sync();
  const me = async () => (await hermes.bots()).find((b) => b.profile === profile)!;
  const brief = async () => {
    const current = await hermes.botSetupCurrent(await me());
    return (id: string) => botSetupBrief({ id, name: "Travel Buddy", inventory: { models: [], skills: [], toolsets: [], bots: [] }, current });
  };
  const entries = async () => Object.values((await hermes.memory.load(profile)).resources).flatMap((r) => r.entries);
  const fresh = async (given?: readonly MemoryEntry[]) => hermes.startBotFresh(await me(), await brief(), given ?? (await entries()), EARLIER);
  return { hermes, me, brief, entries, fresh, keep: async () => hermes.setUpBotAgain(await me(), await brief()) };
}

const rpc = (server: FakeHermes, method: string) => server.requests.filter((r) => r.method === method);
const store = (server: FakeHermes, profile = BOT) => (profile === "default" ? server.sessions : server.otherProfiles[profile]);
const botChats = (server: FakeHermes, profile = BOT) => store(server, profile).filter((s) => s.title === BOT_CHAT_TITLE);
const memoryOf = (server: FakeHermes) => [...server.memory[BOT].memory, ...server.memory[BOT].profile];
const writes = (server: FakeHermes, from = 0) => server.restRequests.slice(from).filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
const chatOf = (hermes: Hermes, id: string) => hermes.getSnapshot().chats.find((c) => c.id === id);
const kindOf = (text: string | undefined) => (botSetupMarkerId(text ?? "") ? "brief" : /^\[highwing:bot-setup begin id=/.test(text ?? "") ? "begin" : (text ?? ""));
const storedIn = (server: FakeHermes, id: string) => (server.transcripts[id] ?? []).map((m) => [m.role, m.display_kind ?? null, kindOf(m.text)]);

describe("Keep history", () => {
  it("sends exactly one hidden brief turn into the Bot Chat, with a new setup id, and nothing to the profile", async () => {
    const server = hermes0232();
    const { hermes, keep } = await launch(server);
    await hermes.idle();
    const restFrom = server.restRequests.length;
    const started = await keep();
    expect(started).toEqual({ kind: "waiting", chatId: OLD, id: expect.any(String) });
    if (started.kind !== "waiting") return;

    expect(rpc(server, "session.create")).toEqual([]);
    const sent = rpc(server, "prompt.submit");
    expect(sent.map((r) => ({ ...r.params, text: botSetupMarkerId(String(r.params.text)) }))).toEqual([{ session_id: expect.any(String), profile: BOT, text: started.id, display_kind: "hidden" }]);
    expect(String(sent[0].params.text)).toContain('"persona":"You are Travel Buddy.","description":"Plans trips."');
    expect(String(sent[0].params.text)).toContain('"color":"teal"');
    expect(storedIn(server, OLD)).toEqual([
      ["user", null, "Rome to Florence?"],
      ["assistant", null, "The 09:10 Frecciarossa is quickest."],
      ["user", "hidden", "brief"],
    ]);
    expect(writes(server, restFrom)).toEqual([]);
    expect(memoryOf(server)).toHaveLength(3);
    expect(botChats(server)).toMatchObject([{ id: OLD, archived: false }]);

    const chat = chatOf(hermes, OLD)!;
    expect(chat.running).toBe(true);
    expect(chat.items.map((i) => (i.kind === "returned" && i.setup ? "setup started" : i.kind))).toEqual(["user", "assistant", "setup started"]);
  });

  it("is picked up from the stored rows as started once the bot replied, with no begin turn", async () => {
    const server = hermes0232();
    const { hermes, keep } = await launch(server);
    const started = await keep();
    if (started.kind !== "waiting") throw new Error(started.kind);
    const sid = String(server.last("prompt.submit")!.params.session_id);
    server.event(sid, "message.start");
    server.storeMessage(OLD, { role: "assistant", text: "Here's how I'm set up now. What should change?" });
    server.event(sid, "message.complete", { text: "Here's how I'm set up now. What should change?", status: "complete" });
    await hermes.idle();
    expect(await hermes.resumeBotSetup()).toEqual({ kind: "started", chatId: OLD, id: started.id });
    expect(rpc(server, "prompt.submit")).toHaveLength(1);
    expect(storedIn(server, OLD).map(([, , what]) => what)).not.toContain("begin");
  });

  for (const busy of ["replying", "waiting"] as const)
    it(`is refused while the Bot Chat is ${busy}, and sends nothing`, async () => {
      const server = hermes0232();
      const { hermes, keep, me } = await launch(server);
      await hermes.openBotChat(await me());
      await hermes.send(OLD, "And back?");
      const sid = String(server.last("prompt.submit")!.params.session_id);
      server.event(sid, "message.start");
      if (busy === "waiting") server.askApproval(sid);
      await hermes.idle();
      expect(await keep()).toEqual({ kind: "refused", reason: busy });
      expect(rpc(server, "prompt.submit")).toHaveLength(1);
    });

  it("seeds a new Bot Chat for a bot that has none, as a new bot's start does", async () => {
    const server = hermes0232((s) => (s.otherProfiles[BOT] = []));
    const { keep } = await launch(server);
    const started = await keep();
    expect(started).toMatchObject({ kind: "waiting" });
    expect(rpc(server, "session.create")).toHaveLength(1);
    expect(storedIn(server, botChats(server)[0].id)).toEqual([
      ["user", "hidden", "brief"],
      ["user", "hidden", "begin"],
    ]);
  });

  it("is refused on a Hermes without Bot Mode, with nothing sent", async () => {
    const server = hermes0232((s) => (s.botMode = "none"));
    const hermes = await connect(server.openPipe, BOT, localChatCache(nas));
    running.push(hermes);
    await hermes.sync();
    await hermes.bots().catch(() => []);
    const bot = { profile: BOT, name: "Travel Buddy", handle: BOT, description: "", isDefault: false, hasAvatar: false, hidden: false, pinned: false, block: "none", botChat: null, lastActive: 0 } as const;
    expect(await hermes.setUpBotAgain(bot, () => "")).toEqual({ kind: "refused", reason: "noBotMode" });
    expect(await hermes.startBotFresh(bot, () => "", [], EARLIER)).toEqual({ kind: "refused", reason: "noBotMode" });
    expect(rpc(server, "prompt.submit")).toEqual([]);
    expect(rpc(server, "session.close")).toEqual([]);
  });

  it("is refused below Hermes 0.23.2, with nothing sent", async () => {
    const server = hermes0232((s) => {
      s.health = { ...s.health, version: "0.23.1", displayVersion: "0.23.1" };
      s.status = { ...s.status, version: "0.23.1" };
    });
    const { hermes, keep, fresh } = await launch(server);
    await hermes.capabilities.refresh();
    const restFrom = server.restRequests.length;
    expect(await keep()).toEqual({ kind: "refused", reason: "tooOld" });
    expect(await fresh()).toEqual({ kind: "refused", reason: "tooOld" });
    expect(rpc(server, "prompt.submit")).toEqual([]);
    expect(rpc(server, "session.close")).toEqual([]);
    expect(writes(server, restFrom)).toEqual([]);
  });
});

describe("Start fresh", () => {
  it("leaves the session, archives the Bot Chat, names it, clears the memory entry by entry and seeds a new Bot Chat", async () => {
    const server = hermes0232();
    const { hermes, fresh } = await launch(server);
    await hermes.idle();
    const [rpcFrom, restFrom] = [server.requests.length, server.restRequests.length];
    const seen: Record<string, unknown> = {};
    const old = () => store(server).find((s) => s.id === OLD)!;
    server.beforeTitleLookup = () => (seen.atLookup = { left: rpc(server, "session.close").length > 0, archived: old().archived });
    server.beforeLearningRest = () => (seen.atMemory ??= { named: old().title, made: rpc(server, "session.create").length });
    const end = await fresh();
    expect(end).toEqual({ kind: "fresh", start: { kind: "waiting", chatId: expect.any(String), id: expect.any(String) }, missed: {}, memoryLeft: 0 });
    if (end.kind !== "fresh" || end.start.kind !== "waiting") return;
    const made = end.start.chatId;
    expect(made).not.toBe(OLD);

    expect(server.requests.slice(rpcFrom).map((r) => r.method).filter((m) => ["session.close", "session.create", "prompt.submit"].includes(m))).toEqual(["session.close", "session.create", "prompt.submit"]);
    const wrote = server.restRequests.slice(restFrom).filter((r) => r.method !== "GET");
    expect(wrote.map((r) => `${r.method} ${r.path}`)).toEqual([`PATCH /api/sessions/${OLD}`, `PATCH /api/sessions/${OLD}`, ...Array<string>(3).fill("DELETE /api/learning/node")]);
    expect(wrote.slice(0, 2).map((r) => r.body)).toMatchObject([{ archived: true }, { title: EARLIER }]);
    expect(seen).toEqual({ atLookup: { left: true, archived: true }, atMemory: { named: EARLIER, made: 0 } });
    expect(store(server).find((s) => s.id === OLD)).toMatchObject({ archived: true, hidden: false, title: EARLIER });
    expect(botChats(server)).toMatchObject([{ id: made, hidden: true, archived: false }]);
    expect(memoryOf(server)).toEqual([]);
    expect(storedIn(server, made)).toEqual([
      ["user", "hidden", "brief"],
      ["user", "hidden", "begin"],
    ]);
    expect(store(server).find((s) => s.id === "trip")).toMatchObject({ archived: false, title: "Rome in May" });

    expect(chatOf(hermes, OLD)).toMatchObject({ archived: true, title: EARLIER });
    expect(chatOf(hermes, OLD)!.bot).toBeFalsy();
    expect(chatOf(hermes, made)).toMatchObject({ bot: true, running: true, title: BOT_CHAT_TITLE });
    expect((await hermes.bots()).find((b) => b.profile === BOT)!.botChat?.id).toBe(made);
  });

  for (const busy of ["replying", "waiting"] as const)
    it(`is refused while the Bot Chat is ${busy}: nothing archived, nothing cleared`, async () => {
      const server = hermes0232();
      const { hermes, fresh, me } = await launch(server);
      await hermes.openBotChat(await me());
      await hermes.send(OLD, "And back?");
      const sid = String(server.last("prompt.submit")!.params.session_id);
      server.event(sid, "message.start");
      if (busy === "waiting") server.askApproval(sid);
      await hermes.idle();
      const restFrom = server.restRequests.length;
      expect(await fresh()).toEqual({ kind: "refused", reason: busy });
      expect(writes(server, restFrom)).toEqual([]);
      expect(rpc(server, "session.close")).toEqual([]);
      expect(botChats(server)).toMatchObject([{ id: OLD, archived: false }]);
      expect(memoryOf(server)).toHaveLength(3);
    });

  it("unarchives the old chat, clears no memory and makes no chat when the title lookup still finds it", async () => {
    const server = hermes0232((s) => (s.archiveKeepsBotChatTitle = true));
    const { hermes, fresh } = await launch(server);
    await hermes.idle();
    const restFrom = server.restRequests.length;
    expect(await fresh()).toEqual({ kind: "titleKept", restored: true });
    expect(writes(server, restFrom)).toEqual([`PATCH /api/sessions/${OLD}`, `PATCH /api/sessions/${OLD}`]);
    expect(botChats(server)).toMatchObject([{ id: OLD, archived: false, hidden: true }]);
    expect(memoryOf(server)).toHaveLength(3);
    expect(rpc(server, "session.create")).toEqual([]);
    expect(chatOf(hermes, OLD)).toMatchObject({ bot: true, archived: false, title: BOT_CHAT_TITLE });
    await hermes.send(OLD, "Still here?");
    expect(rpc(server, "prompt.submit")).toHaveLength(1);
    expect(chatOf(hermes, OLD)!.items.map((i) => i.kind)).toEqual(["user", "assistant", "user"]);
  });

  it("is never run on default", async () => {
    const server = hermes0232((s) => {
      s.sessions = [row("home-bot", 0.5, { title: BOT_CHAT_TITLE, hidden: true })];
      s.memory.default = { memory: ["Keep me."], profile: [] };
    });
    const { hermes, me, brief } = await launch(server, "default");
    await hermes.idle();
    const restFrom = server.restRequests.length;
    expect(await hermes.startBotFresh(await me(), await brief(), [], EARLIER)).toEqual({ kind: "refused", reason: "default" });
    expect(writes(server, restFrom)).toEqual([]);
    expect(botChats(server, "default")).toMatchObject([{ id: "home-bot", archived: false }]);
    expect(server.memory.default.memory).toEqual(["Keep me."]);
  });

  it("removes only the entries the owner was shown, and says how many are still there", async () => {
    const server = hermes0232();
    const { entries, fresh } = await launch(server);
    const shown = await entries();
    server.memory[BOT].memory.push("Noted after the question.");
    server.learningRestRefusal = { status: 400, detail: "The memory file is locked." };
    const end = await fresh(shown);
    expect(end).toMatchObject({ kind: "fresh", memoryLeft: 1 });
    expect(memoryOf(server)).toEqual(["Rome trip is in May.", "Noted after the question."]);
  });

  it("carries on when Hermes refuses the old chat's new title, and says so", async () => {
    const server = hermes0232((s) => s.otherProfiles[BOT].push(row("named", 2, { title: EARLIER })));
    const { hermes, fresh } = await launch(server);
    const end = await fresh();
    expect(end).toMatchObject({ kind: "fresh", missed: { retitle: expect.stringContaining("already in use") }, memoryLeft: 0 });
    expect(store(server).find((s) => s.id === OLD)).toMatchObject({ archived: true, title: null });
    expect(chatOf(hermes, OLD)!.bot).toBeFalsy();
    expect(botChats(server)).toHaveLength(1);
  });

  it("run again after it stopped with the old chat archived: clears the memory and seeds the new Bot Chat", async () => {
    const server = hermes0232();
    const { hermes, fresh } = await launch(server);
    await hermes.idle();
    let lookups = 0;
    const failAfterFirstLookup = () => void (server.titleLookupError = ++lookups === 1 ? undefined : { code: 5000, message: "state.db is busy" });
    server.beforeTitleLookup = failAfterFirstLookup;
    const stopped = await fresh();
    expect(stopped).toMatchObject({ kind: "stopped", at: "lookup", left: "archived" });
    expect(memoryOf(server)).toHaveLength(3);
    expect(botChats(server)).toEqual([]);

    server.beforeTitleLookup = undefined;
    server.titleLookupError = undefined;
    const end = await fresh();
    expect(end).toMatchObject({ kind: "fresh", memoryLeft: 0 });
    expect(memoryOf(server)).toEqual([]);
    expect(botChats(server)).toHaveLength(1);
    expect(rpc(server, "session.create")).toHaveLength(1);
    expect(rpc(server, "prompt.submit").map((r) => kindOf(String(r.params.text)))).toEqual(["begin"]);
  });
});
