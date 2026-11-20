// @vitest-environment jsdom
// A bot made from a name and interviewed in its Bot Chat (ADR 0231), through the real transport against FakeHermes as
// Hermes 0.23.2, then the app quit and launched again after two answers: the answers show, and nothing is sent again.
import { afterEach, expect, it } from "vitest";
import { BOT_CHAT_TITLE } from "./bots";
import { botSetupBrief, botSetupMarkerId } from "./botSetupBrief";
import { localChatCache } from "./chatCache";
import { FakeHermes } from "./fakeHermes";
import { makeBot, newBotInventory } from "./newBot";
import { connect, type Hermes } from "./transport";

const nas = { mode: "ssh" as const, sshTarget: "lena@nas", url: "", username: "lena" };

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

async function launch(server: FakeHermes) {
  const hermes = await connect(server.openPipe, undefined, localChatCache(nas));
  running.push(hermes);
  await hermes.sync();
  return hermes;
}

/** Hermes's reply to the turn the last `prompt.submit` started, streamed and stored as Hermes does. */
function reply(server: FakeHermes, chatId: string, text: string) {
  const sid = String(server.last("prompt.submit")!.params.session_id);
  server.event(sid, "message.start");
  server.event(sid, "message.delta", { text });
  server.storeMessage(chatId, { role: "assistant", text });
  server.event(sid, "message.complete", { text, status: "complete" });
}

const sent = (server: FakeHermes) => server.requests.filter((r) => r.method === "session.create" || r.method === "prompt.submit").map((r) => [r.method, r.params.display_kind ?? null]);

it("after two answers, a relaunch shows both and sends no second brief or begin", async () => {
  const server = new FakeHermes();
  server.health = { ...server.health, version: "0.23.2", displayVersion: "0.23.2" };
  server.status = { ...server.status, version: "0.23.2" };
  const first = await launch(server);
  const { profile } = await makeBot(
    { list: () => first.manageProfiles.list(), create: (f) => first.manageProfiles.create(f), name: (p, title) => first.editBot(p, { title: { from: "", to: title } }) },
    "Travel Buddy",
    "default",
  );
  await first.switchProfile(profile);
  const bot = (await first.bots()).find((b) => b.profile === profile)!;
  expect(bot.name).toBe("Travel Buddy");
  const others = (await first.bots()).filter((b) => b.profile !== profile);
  const brief = async (id: string) =>
    botSetupBrief({ id, name: "Travel Buddy", inventory: await newBotInventory({ models: async () => undefined, skills: (p) => first.skills.rows(p), toolsets: (p) => first.toolsets.list(p) }, profile, others) });
  const started = await first.startBotSetup(bot, brief);
  if (started.kind !== "waiting") throw new Error(started.kind);
  reply(server, started.chatId, "Hi, I'm Travel Buddy. What should I call you?");
  await first.idle();
  await first.send(started.chatId, "Liam");
  reply(server, started.chatId, "What do you want me to help with?");
  await first.idle();
  await first.send(started.chatId, "Planning weekend trips");
  reply(server, started.chatId, "How should I talk to you?");
  await first.idle();
  const before = sent(server);
  expect(before).toEqual([
    ["session.create", null],
    ["prompt.submit", "hidden"],
    ["prompt.submit", null],
    ["prompt.submit", null],
  ]);
  await first.close();

  const again = await launch(server);
  await again.switchProfile(profile);
  const back = (await again.bots()).find((b) => b.profile === profile)!;
  const chatId = await again.openBotChat(back);
  expect(chatId).toBe(started.chatId);
  // Reading where the setup stands loads the chat, as opening it in a pane does.
  expect(await again.startBotSetup(back, () => Promise.reject(new Error("no second brief")))).toEqual({ kind: "started", chatId, id: started.id });
  await again.idle();
  const shown = again.getSnapshot().chats.find((c) => c.id === chatId)!;
  expect(shown.items.filter((i) => i.kind === "user").map((i) => i.kind === "user" && i.text)).toEqual(["Liam", "Planning weekend trips"]);
  expect(shown.items.filter((i) => i.kind === "assistant")).toHaveLength(3);
  expect(sent(server)).toEqual(before);
  expect(server.otherProfiles[profile].filter((s) => s.title === BOT_CHAT_TITLE)).toHaveLength(1);
  const rows = server.transcripts[chatId];
  expect(rows.filter((m) => botSetupMarkerId(m.text ?? "") !== null)).toHaveLength(1);
});
