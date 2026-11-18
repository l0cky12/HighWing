import { afterEach, describe, expect, it } from "vitest";
import { BOT_CHAT_TITLE, type Bot } from "./bots";
import { FakeHermes, row } from "./fakeHermes";
import { chatKind } from "./chatKind";
import { THREAD_WINDOW, threadTitle } from "./threads";
import { BranchUnconfirmed, connect, type Hermes } from "./transport";

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
});

async function signedIn(setup: (server: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.sessions = [row("side", 1, { title: "Disk usage" }), row("bot", 2, { title: BOT_CHAT_TITLE, hidden: true })];
  server.otherProfiles = { scribe: [row("scribe-bot", 2, { title: BOT_CHAT_TITLE, hidden: true })] };
  server.transcripts = {
    side: [{ role: "user", text: "How full is the release disk?" }],
    bot: [
      { role: "user", text: "Plan the VLANs" },
      { role: "assistant", text: "Three VLANs: lab, home, guests." },
    ],
  };
  server.profileMeta = { scribe: { ui_meta: { "hermes-bots": { title: "Scribe" } } } };
  server.seedThread("scribe", "Changelog", { messages: [{ role: "user", text: "Which release wording reads better?" }] });
  setup(server);
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  await hermes.sync();
  const bots = await hermes.bots();
  const bot = (profile: string): Bot => bots.find((b) => b.profile === profile)!;
  const shelf = (profile: string) => hermes.getSnapshot().threads[profile];
  const topics = (profile: string) => shelf(profile)?.threads.map((t) => t.topic);
  const listed = () => hermes.getSnapshot().chats.filter((c) => chatKind(c) === "ordinary").map((c) => c.id);
  return { server, hermes, bot, shelf, topics, listed };
}

const rpc = (server: FakeHermes, method: string) => server.requests.filter((r) => r.method === method);
const threadsOf = (server: FakeHermes, profile = "default") => server.store(profile)!.filter((s) => s.title?.startsWith("Bot Thread: "));

describe("reading a bot's threads", () => {
  it("reads each bot's shelf from one listing with hidden sessions, in Hermes's order", async () => {
    const { server, hermes, shelf, topics } = await signedIn((s) => {
      s.seedThread("default", "Backups", { hours: 30, messages: [{ role: "user", text: "Check last night's run" }] });
      s.seedThread("default", "VLAN plan", { hours: 2 });
    });
    expect(hermes.getSnapshot().threads).toEqual({});
    await hermes.readThreads(["default", "scribe"]);
    expect(topics("default")).toEqual(["VLAN plan", "Backups"]);
    expect(topics("scribe")).toEqual(["Changelog"]);
    expect(shelf("default")).toMatchObject({ capped: false, threads: [{ profile: "default", messageCount: 0 }, { preview: "Check last night's run", messageCount: 1 }] });
    expect(shelf("default").error).toBeUndefined();
    expect(rpc(server, "session.list").map((r) => r.params)).toEqual([
      { profile: "default", include_hidden: true, limit: THREAD_WINDOW },
      { profile: "scribe", include_hidden: true, limit: THREAD_WINDOW },
    ]);
  });

  it("reads only the shelves older than asked", async () => {
    const { server, hermes } = await signedIn();
    await hermes.readThreads(["default"]);
    await hermes.readThreads(["default", "scribe"], 60_000);
    expect(rpc(server, "session.list").map((r) => r.params.profile)).toEqual(["default", "scribe"]);
  });

  it("keeps the threads it had, with why, when a read fails, and reads that shelf again whatever its age", async () => {
    const { server, hermes, shelf, topics } = await signedIn();
    await hermes.readThreads(["scribe"]);
    const list = server.handlers["session.list"];
    server.handlers["session.list"] = (r) => server.fail(r.id, 5006, "database is locked");
    await hermes.readThreads(["scribe", "default"]);
    expect(topics("scribe")).toEqual(["Changelog"]);
    expect(shelf("scribe").error).toBe("database is locked");
    expect(shelf("default")).toEqual({ threads: [], at: 0, capped: false, error: "database is locked" });
    server.handlers["session.list"] = list;
    await hermes.readThreads(["scribe"], 60_000);
    expect(shelf("scribe").error).toBeUndefined();
  });

  it("looks up by title each thread a full window no longer lists, before dropping it", async () => {
    const { server, hermes, shelf, topics } = await signedIn((s) => {
      s.seedThread("default", "Backups", { hours: 30 });
      s.seedThread("default", "VLAN plan", { hours: 40 });
    });
    await hermes.readThreads(["default"]);
    expect(topics("default")).toEqual(["Backups", "VLAN plan"]);
    const list = server.handlers["session.list"];
    server.handlers["session.list"] = (r) => (r.params.title === undefined ? server.respond(r.id, { sessions: Array.from({ length: THREAD_WINDOW }, (_, i) => ({ id: `c${i}`, title: `Chat ${i}` })) }) : list(r));
    server.sessions.splice(server.sessions.findIndex((s) => s.title === "Bot Thread: VLAN plan"), 1);
    await hermes.readThreads(["default"]);
    expect(topics("default")).toEqual(["Backups"]);
    expect(shelf("default").capped).toBe(true);
    expect(rpc(server, "session.list").map((r) => r.params.title).filter(Boolean)).toEqual(["Bot Thread: Backups", "Bot Thread: VLAN plan"]);
  });

  it("lists again when a thread was started here while a listing was on its way", async () => {
    const { server, hermes, bot, topics } = await signedIn();
    const list = server.handlers["session.list"];
    const held: (() => void)[] = [];
    server.handlers["session.list"] = (r) => {
      if (r.params.title !== undefined || held.length) return list(r);
      const before = structuredClone(server.sessions);
      held.push(() => {
        const now = server.sessions;
        server.sessions = before;
        list(r);
        server.sessions = now;
      });
    };
    const read = hermes.readThreads(["default"]);
    await hermes.newThread(bot("default"), "VLAN plan");
    held[0]();
    await read;
    await hermes.idle();
    expect(topics("default")).toEqual(["VLAN plan"]);
  });
});

describe("New thread", () => {
  it("starts a hidden session titled for the topic, without a parent, and shows it under the bot", async () => {
    const { server, hermes, bot, topics } = await signedIn();
    const id = await hermes.newThread(bot("default"), "  VLAN   plan ");
    await hermes.idle();
    expect(rpc(server, "session.create").map((r) => r.params)).toEqual([{ profile: "default", title: "Bot Thread: VLAN plan", hidden: true, follow_profile_config: true, source: "gui" }]);
    expect(threadsOf(server)).toMatchObject([{ id, title: "Bot Thread: VLAN plan", hidden: true }]);
    expect(threadsOf(server)[0].parent_session_id).toBeUndefined();
    expect(topics("default")).toEqual(["VLAN plan"]);
    const chat = hermes.getSnapshot().chats.find((c) => c.id === id)!;
    expect(chat).toMatchObject({ title: "Bot Thread: VLAN plan" });
    expect(chatKind(chat)).toBe("thread");
  });

  it("opens the one empty thread a topic has, however often it is asked for", async () => {
    const { server, hermes, bot } = await signedIn();
    const [a, b] = await Promise.all([hermes.newThread(bot("default"), "VLAN plan"), hermes.newThread(bot("default"), "vlan plan")]);
    const c = await hermes.newThread(bot("default"), "VLAN plan");
    expect(new Set([a, b, c]).size).toBe(1);
    expect(rpc(server, "session.create")).toHaveLength(1);
    expect(threadsOf(server)).toHaveLength(1);
  });

  it("names a second thread on a topic that already has messages (2)", async () => {
    const { server, hermes, bot } = await signedIn((s) => s.seedThread("default", "VLAN plan", { messages: [{ role: "user", text: "Start with the lab" }] }));
    await hermes.newThread(bot("default"), "VLAN plan");
    expect(threadsOf(server).map((s) => s.title)).toEqual(["Bot Thread: VLAN plan", "Bot Thread: VLAN plan (2)"]);
  });

  it("looks again when another client takes the title first, and takes the next free one", async () => {
    const { server, hermes, bot } = await signedIn();
    const name = server.handlers["session.title"];
    server.handlers["session.title"] = (r) => {
      server.handlers["session.title"] = name;
      server.seedThread("default", "VLAN plan", { messages: [{ role: "user", text: "From the other computer" }] });
      name(r);
    };
    const id = await hermes.newThread(bot("default"), "VLAN plan");
    expect(threadsOf(server).map((s) => s.title)).toEqual(["Bot Thread: VLAN plan", "Bot Thread: VLAN plan (2)"]);
    expect(threadsOf(server)[1].id).toBe(id);
  });

  it("starts nothing when the lookup fails or proves nothing", async () => {
    const { server, hermes, bot } = await signedIn();
    server.titleLookupError = { code: 5006, message: "database is locked" };
    await expect(hermes.newThread(bot("default"), "VLAN plan")).rejects.toThrow("Couldn't look up the thread “VLAN plan”: database is locked");
    server.titleLookupError = undefined;
    server.handlers["session.list"] = (r) => server.respond(r.id, { sessions: [{ id: "side", title: "Disk usage" }] });
    await expect(hermes.newThread(bot("default"), "VLAN plan")).rejects.toThrow("in a way this app doesn't read");
    expect(rpc(server, "session.create")).toEqual([]);
  });

  it("refuses a bot in another profile than the one shown", async () => {
    const { hermes, bot } = await signedIn();
    await expect(hermes.newThread(bot("scribe"), "Notes")).rejects.toThrow("Switch to scribe first.");
  });
});

describe("opening a thread", () => {
  it("finds it by its title each time, and says when Hermes no longer has it", async () => {
    const { server, hermes, bot, topics } = await signedIn((s) => s.seedThread("default", "Backups"));
    await hermes.readThreads(["default"]);
    const title = threadTitle("Backups");
    expect(await hermes.openThread(bot("default"), title)).toBe(threadsOf(server)[0].id);
    expect(rpc(server, "session.list").at(-1)!.params).toMatchObject({ profile: "default", title, include_hidden: true });
    server.sessions = server.sessions.filter((s) => s.title !== title);
    await expect(hermes.openThread(bot("default"), title)).rejects.toThrow("Hermes no longer has Hermes's thread “Backups”.");
    await hermes.idle();
    expect(topics("default")).toEqual([]);
  });
});

describe("threads outside the chat list and search", () => {
  it("leaves a thread out of the list and search, hidden or not", async () => {
    const { server, hermes, listed } = await signedIn((s) => {
      const id = s.seedThread("default", "Release disk", { messages: [{ role: "user", text: "The release disk again" }] });
      s.sessions.find((x) => x.id === id)!.hidden = false;
    });
    expect(listed()).toEqual(["side"]);
    expect(hermes.getSnapshot().chats.map((c) => c.id)).toEqual(["side"]);
    expect((await hermes.search("release")).map((f) => f.chatId)).toEqual(["side"]);
    expect(server.sessions.some((s) => s.title === "Bot Thread: Release disk")).toBe(true);
  });

  it("hides a thread the visible list reported, once on a connection", async () => {
    const { server, hermes } = await signedIn((s) => {
      const id = s.seedThread("default", "VLAN plan");
      s.sessions.find((x) => x.id === id)!.hidden = false;
    });
    await hermes.idle();
    const [thread] = threadsOf(server);
    expect(thread.hidden).toBe(true);
    const hides = () => server.restRequests.filter((r) => r.method === "PATCH" && r.body?.hidden === true);
    expect(hides().map((r) => r.path)).toEqual([`/api/sessions/${thread.id}`]);
    thread.hidden = false;
    await hermes.sync();
    await hermes.idle();
    expect(hides()).toHaveLength(1);
  });

  it("doesn't touch a thread only the archived view lists, which lists hidden sessions", async () => {
    const { server, hermes } = await signedIn((s) => {
      const id = s.seedThread("default", "Old plan");
      s.sessions.find((x) => x.id === id)!.archived = true;
      s.sessions.push(row("old-side", 5, { title: "Old", archived: true }));
    });
    const { found } = await hermes.browse({ archived: "only" });
    await hermes.idle();
    expect(found.map((f) => f.chatId)).toEqual(["old-side"]);
    expect(server.restRequests.filter((r) => r.method === "PATCH")).toEqual([]);
  });

  it("takes an open chat renamed to a thread's title in another client out of the list, as a thread", async () => {
    const { server, hermes, listed } = await signedIn();
    await hermes.open("side");
    server.sessions.find((s) => s.id === "side")!.title = "Bot Thread: Disk usage";
    await hermes.sync();
    expect(listed()).toEqual([]);
    expect(chatKind(hermes.getSnapshot().chats.find((c) => c.id === "side")!)).toBe("thread");
  });

  it("refuses to rename an ordinary chat into a thread's title", async () => {
    const { server, hermes } = await signedIn();
    await expect(hermes.rename("side", "Bot Thread: Disk usage", "Disk usage")).rejects.toThrow("“Bot Thread:” is how a bot's threads are named. Pick another name.");
    expect(server.restRequests.filter((r) => r.method === "PATCH")).toEqual([]);
  });
});

describe("renaming and deleting a thread", () => {
  it("renames by topic, keeping the prefix, in a profile that isn't shown too", async () => {
    const { server, hermes, topics } = await signedIn();
    await hermes.readThreads(["scribe"]);
    expect(await hermes.renameThread({ profile: "scribe", title: threadTitle("Changelog") }, " Release  wording ")).toBe("Bot Thread: Release wording");
    expect(threadsOf(server, "scribe").map((s) => s.title)).toEqual(["Bot Thread: Release wording"]);
    expect(topics("scribe")).toEqual(["Release wording"]);
    await hermes.idle();
    expect(topics("scribe")).toEqual(["Release wording"]);
  });

  it("renames the open thread from its pane by topic, and doesn't let Hermes write it a title", async () => {
    const { server, hermes, bot } = await signedIn();
    const id = await hermes.newThread(bot("default"), "VLAN plan");
    expect(await hermes.rename(id, "Lab network", "Bot Thread: VLAN plan")).toBe("Bot Thread: Lab network");
    expect(hermes.getSnapshot().chats.find((c) => c.id === id)!.title).toBe("Bot Thread: Lab network");
    expect(threadsOf(server).map((s) => s.title)).toEqual(["Bot Thread: Lab network"]);
    await expect(hermes.regenerateTitle(id)).rejects.toThrow("A thread is named for its topic");
  });

  it("renames nothing when another client renamed the thread after it was looked up", async () => {
    const { server, hermes } = await signedIn();
    const list = server.handlers["session.list"];
    let renamedElsewhere = false;
    server.handlers["session.list"] = (r) => {
      list(r);
      if (renamedElsewhere || r.params.title !== "Bot Thread: Changelog") return;
      renamedElsewhere = true;
      server.otherProfiles.scribe.find((s) => s.title === "Bot Thread: Changelog")!.title = "Bot Thread: Changelog draft";
    };
    await expect(hermes.renameThread({ profile: "scribe", title: threadTitle("Changelog") }, "Release wording")).rejects.toThrow("was renamed in another Hermes client");
    expect(threadsOf(server, "scribe").map((s) => s.title)).toEqual(["Bot Thread: Changelog draft"]);
  });

  it("says when the bot already has a thread on the new topic", async () => {
    const { server, hermes } = await signedIn((s) => s.seedThread("scribe", "Release wording"));
    await expect(hermes.renameThread({ profile: "scribe", title: threadTitle("Changelog") }, "Release wording")).rejects.toThrow("This bot already has a thread on “Release wording”.");
    expect(threadsOf(server, "scribe").map((s) => s.title)).toEqual(["Bot Thread: Changelog", "Bot Thread: Release wording"]);
  });

  it("deletes a thread for good, and its shelf is empty at once", async () => {
    const { server, hermes, topics } = await signedIn();
    await hermes.readThreads(["scribe"]);
    expect(await hermes.deleteThread({ profile: "scribe", title: threadTitle("Changelog") })).toBe(true);
    expect(topics("scribe")).toEqual([]);
    expect(threadsOf(server, "scribe")).toEqual([]);
    await hermes.idle();
    expect(topics("scribe")).toEqual([]);
  });

  it("deletes the open thread, which leaves the chats here too", async () => {
    const { server, hermes, bot } = await signedIn();
    const id = await hermes.newThread(bot("default"), "VLAN plan");
    await hermes.open(id);
    expect(await hermes.deleteThread({ profile: "default", title: threadTitle("VLAN plan") })).toBe(true);
    expect(hermes.getSnapshot().chats.some((c) => c.id === id)).toBe(false);
    expect(threadsOf(server)).toEqual([]);
  });
});

describe("compaction", () => {
  it("leaves the threads under their bot when the Bot Chat moves to a new session", async () => {
    const { server, hermes, bot, topics, shelf } = await signedIn((s) => {
      s.compress = "rotate";
      s.seedThread("default", "VLAN plan", { messages: [{ role: "user", text: "Start with the lab" }] });
    });
    await hermes.readThreads(["default"]);
    const before = shelf("default").threads;
    const botChat = await hermes.openBotChat(bot("default"));
    await hermes.open(botChat);
    await hermes.compact(botChat);
    expect(server.sessions.find((s) => s.id === "bot")!.listedAs?.id).toBeTruthy();

    await hermes.bots();
    await hermes.readThreads(["default"]);
    await hermes.sync();
    expect(topics("default")).toEqual(["VLAN plan"]);
    expect(shelf("default").threads).toMatchObject([{ rootId: before[0].rootId, openId: before[0].openId }]);
    const id = await hermes.openThread(bot("default"), threadTitle("VLAN plan"));
    const chat = hermes.getSnapshot().chats.find((c) => c.id === id)!;
    expect(chat.bot).toBeUndefined();
    expect(chatKind(chat)).toBe("thread");
  });

  it("keeps a thread one row with one root when the thread itself moves to a new session, and opens the new one", async () => {
    const { server, hermes, bot, shelf } = await signedIn((s) => {
      s.compress = "rotate";
      s.seedThread("default", "VLAN plan", { messages: [{ role: "user", text: "Start with the lab" }] });
    });
    const title = threadTitle("VLAN plan");
    const first = await hermes.openThread(bot("default"), title);
    await hermes.open(first);
    await hermes.compact(first);
    const tip = server.sessions.find((s) => s.id === first)!.listedAs!.id!;

    await hermes.readThreads(["default"]);
    expect(shelf("default").threads).toMatchObject([{ title, rootId: first, openId: tip }]);
    expect(await hermes.openThread(bot("default"), title)).toBe(tip);
    expect(await hermes.deleteThread({ profile: "default", title })).toBe(true);
    expect(server.sessions.map((s) => s.id).sort()).toEqual(["bot", "side"]);
  });
});

describe("Thread from here", () => {
  async function inBotChat(setup?: (server: FakeHermes) => void) {
    const env = await signedIn((s) => {
      s.transcripts.bot = [];
      s.storeMessage("bot", { role: "user", text: "Plan the VLANs" });
      s.storeMessage("bot", { role: "assistant", text: "Three VLANs: lab, home, guests." });
      setup?.(s);
    });
    const botChat = await env.hermes.openBotChat(env.bot("default"));
    await env.hermes.open(botChat);
    const chat = () => env.hermes.getSnapshot().chats.find((c) => c.id === botChat)!;
    const reply = () => chat().items.find((i) => i.kind === "assistant")!.id;
    const forks = () => env.server.sessions.filter((s) => s.parent_session_id === botChat);
    return { ...env, botChat, chat, reply, forks };
  }

  it("has Hermes copy the Bot Chat up to the message into a hidden session named for the topic, under the bot", async () => {
    const { server, hermes, botChat, chat, reply, forks, topics } = await inBotChat();
    const preview = await hermes.previewBranch(botChat, reply());
    const { chatId, warnings } = await hermes.threadFromHere(preview, " VLAN  plan ");
    expect(warnings).toEqual([]);
    expect(rpc(server, "session.branch").map((r) => r.params)).toEqual([{ session_id: chat().runtimeId, count: 2, name: "Bot Thread: VLAN plan", idempotency_key: expect.stringMatching(/^branch-/) }]);
    expect(forks()).toMatchObject([{ id: chatId, title: "Bot Thread: VLAN plan", hidden: true, pinned: false }]);
    expect(server.transcripts[chatId].map((m) => m.text)).toEqual(["Plan the VLANs", "Three VLANs: lab, home, guests."]);

    const thread = hermes.getSnapshot().chats.find((c) => c.id === chatId)!;
    expect(chatKind(thread)).toBe("thread");
    expect(thread.items.map((i) => (i.kind === "user" || i.kind === "assistant" ? i.text : i.kind))).toEqual(["Plan the VLANs", "Three VLANs: lab, home, guests."]);
    expect(hermes.getSnapshot().branches).toEqual({ links: {}, attempts: [] });
    await hermes.idle();
    await hermes.sync();
    await hermes.idle();
    expect(topics("default")).toEqual(["VLAN plan"]);
    expect(forks()[0].pinned).toBe(false);
    expect(server.transcripts[botChat]).toHaveLength(2);
    const edits = server.restRequests.filter((r) => r.method === "PATCH").map((r) => r.body!);
    expect(edits.filter((b) => "hidden" in b || "pinned" in b || "title" in b)).toMatchObject([{ hidden: true }]);
  });

  it("takes the next free title when the topic's is taken, chosen before Hermes is asked", async () => {
    const { server, hermes, botChat, reply, forks } = await inBotChat((s) => s.seedThread("default", "VLAN plan"));
    const { chatId } = await hermes.threadFromHere(await hermes.previewBranch(botChat, reply()), "VLAN plan");
    expect(forks()).toMatchObject([{ id: chatId, title: "Bot Thread: VLAN plan (2)" }]);
    expect(rpc(server, "session.branch")).toHaveLength(1);
  });

  it("skips every title the bot's threads already hold, however many", async () => {
    const { hermes, botChat, reply, forks } = await inBotChat((s) => {
      s.seedThread("default", "VLAN plan");
      for (let n = 2; n <= 7; n++) s.seedThread("default", `VLAN plan (${n})`);
    });
    await hermes.readThreads(["default"]);
    const { chatId } = await hermes.threadFromHere(await hermes.previewBranch(botChat, reply()), "VLAN plan");
    expect(forks()).toMatchObject([{ id: chatId, title: "Bot Thread: VLAN plan (8)" }]);
  });

  it("adopts the thread Hermes made when its answer was lost, by its title, though no chat list shows it", async () => {
    const { server, hermes, botChat, reply, forks, topics } = await inBotChat();
    const preview = await hermes.previewBranch(botChat, reply());
    server.dropOnBranch = "stored";
    await expect(hermes.threadFromHere(preview, "VLAN plan")).rejects.toBeInstanceOf(BranchUnconfirmed);
    expect(hermes.getSnapshot().branches.attempts).toMatchObject([{ thread: "Bot Thread: VLAN plan" }]);
    expect(forks()).toMatchObject([{ title: "Bot Thread: VLAN plan" }]);
    expect(forks()[0].hidden).toBeUndefined();

    await hermes.reconnect();
    await hermes.idle();
    const id = forks()[0].id;
    expect(hermes.getSnapshot().branches).toEqual({ links: {}, attempts: [] });
    expect(hermes.getSnapshot().branchNews).toMatchObject({ chatId: id, text: "Hermes made the thread “VLAN plan” before the connection dropped. It's under its bot." });
    expect(chatKind(hermes.getSnapshot().chats.find((c) => c.id === id)!)).toBe("thread");
    expect(forks()).toMatchObject([{ hidden: true, pinned: false }]);
    expect(topics("default")).toEqual(["VLAN plan"]);
    expect(rpc(server, "session.branch")).toHaveLength(1);
  });

  it("asks again under the same title and key after a lost answer, and gets the one thread", async () => {
    const { server, hermes, botChat, reply, forks } = await inBotChat();
    server.dropOnBranch = "lost";
    await expect(hermes.threadFromHere(await hermes.previewBranch(botChat, reply()), "VLAN plan")).rejects.toBeInstanceOf(BranchUnconfirmed);
    await hermes.reconnect();
    await hermes.open(botChat);
    await hermes.idle();
    const { chatId } = await hermes.threadFromHere(await hermes.previewBranch(botChat, reply()), "VLAN plan");
    const asked = rpc(server, "session.branch").map((r) => r.params);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatchObject({ name: "Bot Thread: VLAN plan", idempotency_key: asked[0].idempotency_key });
    expect(forks().map((s) => s.id)).toEqual([chatId]);
  });

  it("deletes a thread that holds other rows than the preview showed", async () => {
    const { server, hermes, botChat, reply, forks, topics } = await inBotChat();
    const preview = await hermes.previewBranch(botChat, reply());
    server.beforeBranch = () => server.transcripts[botChat].unshift({ role: "user", text: "Slipped in by another client", row_id: 0 });
    await expect(hermes.threadFromHere(preview, "VLAN plan")).rejects.toThrow("so Highwing deleted that thread again");
    expect(forks()).toEqual([]);
    await hermes.idle();
    expect(topics("default")).toEqual([]);
  });

  it("says so when another session takes the title between the lookup and the branch, and makes nothing", async () => {
    const { server, hermes, botChat, reply, forks } = await inBotChat();
    const preview = await hermes.previewBranch(botChat, reply());
    server.beforeBranch = () => void server.seedThread("default", "VLAN plan", { messages: [{ role: "user", text: "From the other computer" }] });
    const branch = server.handlers["session.branch"];
    server.handlers["session.branch"] = (r) => {
      server.beforeBranch?.();
      server.beforeBranch = undefined;
      branch(r);
    };
    await expect(hermes.threadFromHere(preview, "VLAN plan")).rejects.toThrow("Another session took the name of the thread “VLAN plan” first. Nothing was made; try again.");
    expect(forks()).toEqual([]);
    expect(hermes.getSnapshot().branches.attempts).toEqual([]);
  });

  it("refuses a topic with nothing in it before asking Hermes for anything", async () => {
    const { server, hermes, botChat, reply } = await inBotChat();
    const preview = await hermes.previewBranch(botChat, reply());
    await expect(hermes.threadFromHere(preview, "  ")).rejects.toThrow("A thread needs a topic.");
    expect(rpc(server, "session.branch")).toEqual([]);
  });
});
