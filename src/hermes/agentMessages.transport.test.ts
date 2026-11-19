// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { agentSend, deliveryLines } from "./agentMessages";
import { BOT_CHAT_TITLE } from "./bots";
import { localChatCache } from "./chatCache";
import { chatJson, chatMarkdown } from "./exportChat";
import { FakeHermes, row } from "./fakeHermes";
import { planImport } from "./importTranscripts";
import type { Item } from "./model";
import { returnedItem } from "./returned";
import { connect, type Hermes } from "./transport";

const nas = { mode: "ssh" as const, sshTarget: "lena@nas", url: "", username: "lena" };
const ASK = "What is the backup window?";
const REPLIES = { recipient: "The window is **02:00 to 03:00**.", sender: "Beta says the window is 02:00 to 03:00." };

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

function headless() {
  const server = new FakeHermes();
  server.sessions = [row("alpha-bot", 1, { title: BOT_CHAT_TITLE, hidden: true }), row("side", 2, { title: "Disk usage" })];
  server.otherProfiles = { beta: [row("beta-bot", 3, { title: BOT_CHAT_TITLE, hidden: true })] };
  server.transcripts = { "alpha-bot": [{ role: "user", text: "Ask beta what the backup window is." }], "beta-bot": [] };
  return server;
}

async function signedIn(server: FakeHermes, target = nas.sshTarget) {
  const hermes = await connect(server.openPipe, undefined, localChatCache({ ...nas, sshTarget: target }));
  running.push(hermes);
  await hermes.sync();
  return hermes;
}

async function botChat(hermes: Hermes, profile: string) {
  if (hermes.profile !== profile) await hermes.switchProfile(profile);
  const id = await hermes.openBotChat((await hermes.bots()).find((b) => b.profile === profile)!);
  await hermes.open(id);
  return () => hermes.getSnapshot().chats.find((c) => c.id === id)!.items;
}

const until = async (hermes: Hermes, done: () => boolean) => {
  for (let n = 0; n < 50 && !done(); n++) {
    await hermes.idle();
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(done()).toBe(true);
};
const returned = (items: Item[]) => items.filter((i): i is Extract<Item, { kind: "returned" }> => i.kind === "returned");
const typed = (items: Item[]) => items.flatMap((i) => (i.kind === "user" ? [i.text] : []));

const ANSWER = { kind: "returned", title: "@beta answered.", body: REPLIES.recipient, process: false, agent: { kind: "answer", deliveryId: "delivery-1", status: "settled" } };
const FROM = { kind: "returned", body: ASK, process: false, agent: { kind: "from", teammate: { name: "hermes", handle: "hermes" } } };

describe("Hermes's gate on message_agent, as the stand-in models it", () => {
  it("offers the tool in no chat on a headless install, and a delivery can't happen", async () => {
    const server = headless();
    expect(server.messageAgentOffered("alpha-bot")).toBe(false);
    await expect(server.messageAgent("default", "beta", ASK, REPLIES)).rejects.toThrow(/not Bot-Mode-managed/);
    expect(server.transcripts["beta-bot"]).toEqual([]);
  });

  it("offers it in every Bot Chat, and only there, once any profile has a block, even an empty one", async () => {
    const server = headless();
    server.profileMeta.beta = { ui_meta: { "hermes-bots": {} } };
    expect(["alpha-bot", "beta-bot", "side"].map((id) => server.messageAgentOffered(id))).toEqual([true, true, false]);
    server.profileMeta.beta = { ui_meta: { "another-app": {} } };
    expect(server.messageAgentOffered("alpha-bot")).toBe(false);
  });

  it("stores a delivery in both Bot Chats with nobody attached", async () => {
    const server = headless();
    server.profileMeta.default = { ui_meta: { "hermes-bots": {} } };
    await server.messageAgent("default", "beta", ASK, REPLIES);
    expect(server.transcripts["beta-bot"].map((m) => [m.role, m.display_kind, m.text])).toEqual([
      ["user", "internal_notification", `Message from 🤖 hermes (@hermes): ${ASK}`],
      ["assistant", undefined, REPLIES.recipient],
    ]);
    expect(server.transcripts["alpha-bot"].map((m) => [m.role, m.display_kind ?? m.name])).toEqual([
      ["user", undefined],
      ["assistant", undefined],
      ["tool", "message_agent"],
      ["assistant", undefined],
      ["user", "process_complete"],
      ["assistant", undefined],
    ]);
  });
});

describe("One bot messages another", () => {
  it("shows the sender its call and the answer that came back, live and once reopened, and nothing as typed by the owner", async () => {
    const server = headless();
    const hermes = await signedIn(server);
    expect((await hermes.setAgentMessaging(true)).kind).toBe("saved");
    const items = await botChat(hermes, "default");
    await server.messageAgent("default", "beta", ASK, REPLIES);
    await until(hermes, () => returned(items()).length === 1 && items().at(-1)?.kind === "assistant");

    const shown = (list: Item[]) => {
      expect(list.find((i) => i.kind === "tool")).toMatchObject({ name: "message_agent", args: { target: "beta", message: ASK } });
      expect(returned(list)).toEqual([expect.objectContaining(ANSWER)]);
      expect(typed(list)).toEqual(["Ask beta what the backup window is."]);
      expect(list.at(-1)).toMatchObject({ kind: "assistant", text: REPLIES.sender });
    };
    shown(items());
    const ack = { kind: "queued", to: "@beta", recipients: [{ to: "@beta", deliveryId: "delivery-1", claimed: false, targetState: "idle" }], reply: "notification" };
    const sent = (list: Item[]) => list.find((i): i is Extract<Item, { kind: "tool" }> => i.kind === "tool")!;
    expect(agentSend(sent(items()))).toEqual({ to: "@beta", text: ASK, ack });
    const lines = (list: Item[]) => deliveryLines(agentSend(sent(list))!, list.slice(list.indexOf(sent(list)) + 1)).map((l) => l.kind);
    expect(lines(items())).toEqual(["queued", "ended"]);

    // History leaves the ack out; it is read back from the call's stored row, once a connection.
    const reopened = await signedIn(server, "lena@reload");
    const again = await botChat(reopened, "default");
    await until(reopened, () => sent(again()).result !== undefined);
    shown(again());
    expect(agentSend(sent(again()))).toEqual({ to: "@beta", text: ASK, ack });
    expect(lines(again())).toEqual(["queued", "ended"]);
    const reads = () => server.restRequests.filter((r) => r.path === "/api/sessions/alpha-bot/messages").length;
    expect(reads()).toBeGreaterThan(0);
    const before = reads();
    await reopened.open("side");
    await reopened.open("alpha-bot");
    await until(reopened, () => sent(again()).result !== undefined);
    expect(reads()).toBe(before);
    expect(server.requests.filter((r) => r.method === "prompt.submit")).toEqual([]);
  });

  it("shows the recipient the message as from that bot, from history", async () => {
    const server = headless();
    const hermes = await signedIn(server);
    await hermes.setAgentMessaging(true);
    await server.messageAgent("default", "beta", ASK, REPLIES);
    const items = (await botChat(hermes, "beta"))();
    expect(items).toEqual([expect.objectContaining(FROM), expect.objectContaining({ kind: "assistant", text: REPLIES.recipient })]);
  });

  it("shows the recipient the message before its reply when it arrives while its Bot Chat is open", async () => {
    const server = headless();
    const hermes = await signedIn(server);
    await hermes.setAgentMessaging(true);
    const items = await botChat(hermes, "beta");
    expect(items()).toEqual([]);
    await server.messageAgent("default", "beta", ASK, REPLIES);
    await until(hermes, () => returned(items()).length === 1);
    expect(items().map((i) => i.kind)).toEqual(["returned", "assistant"]);
    expect(items()[0]).toMatchObject(FROM);
    expect(typed(items())).toEqual([]);
  });

  it("keeps who it is from in the Saved copy and in a JSON export, which imports as the same row", async () => {
    const server = headless();
    const hermes = await signedIn(server);
    await hermes.setAgentMessaging(true);
    const items = await botChat(hermes, "beta");
    await server.messageAgent("default", "beta", ASK, REPLIES);
    await until(hermes, () => returned(items()).length === 1);

    expect(returned(localChatCache(nas).loadTranscript("beta", "beta-bot")?.items ?? [])).toEqual([expect.objectContaining(FROM)]);

    const chat = hermes.getSnapshot().chats.find((c) => c.id === "beta-bot")!;
    const exported = chatJson(chat, new Date("2026-11-17T10:00:00Z"));
    const [message] = (JSON.parse(exported) as { messages: Record<string, unknown>[] }[])[0].messages;
    expect(message).toMatchObject({ role: "user", display_kind: "internal_notification", content: `Message from 🤖 hermes (@hermes): ${ASK}` });
    expect(chatMarkdown(chat, new Date("2026-11-17T10:00:00Z"))).toContain(`**Returned:** Message from hermes (@hermes)\n\n${ASK}`);
    const [imported] = (await planImport("jsonl", "beta.json", exported)).chats[0].session.messages as Record<string, unknown>[];
    expect(returnedItem(String(imported.content), imported.display_kind, undefined)).toEqual({ body: ASK, process: false, agent: FROM.agent });
  });

  it("looks for an ack it didn't find again on the next connection, and never again for one it found", async () => {
    const server = headless();
    server.profileMeta.default = { ui_meta: { "hermes-bots": {} } };
    await server.messageAgent("default", "beta", ASK, REPLIES);
    const row = server.transcripts["alpha-bot"].find((m) => m.role === "tool")!;
    const stored = row.row_id;
    row.row_id = undefined;
    const hermes = await signedIn(server);
    const items = await botChat(hermes, "default");
    const call = () => items().find((i): i is Extract<Item, { kind: "tool" }> => i.kind === "tool")!;
    await until(hermes, () => returned(items()).length === 1);
    expect(call().result).toBeUndefined();
    const reads = () => server.restRequests.filter((r) => r.path === "/api/sessions/alpha-bot/messages").length;

    row.row_id = stored;
    const before = reads();
    server.drop();
    for (let n = 0; n < 300 && hermes.getSnapshot().status !== "connected"; n++) await new Promise((r) => setTimeout(r, 10));
    await hermes.open("alpha-bot");
    await until(hermes, () => call().result !== undefined);
    expect(reads()).toBeGreaterThan(before);
    expect(agentSend(call())?.ack).toMatchObject({ kind: "queued", recipients: [{ deliveryId: "delivery-1" }] });
  });

  it("keeps the sent call's id and ack in the Saved copy, so a card drawn offline still finds its answer", async () => {
    const server = headless();
    const hermes = await signedIn(server);
    await hermes.setAgentMessaging(true);
    const items = await botChat(hermes, "default");
    await server.messageAgent("default", "beta", ASK, REPLIES);
    await until(hermes, () => returned(items()).length === 1 && items().at(-1)?.kind === "assistant");

    const tool = (list: Item[]) => list.find((i): i is Extract<Item, { kind: "tool" }> => i.kind === "tool")!;
    const saved = localChatCache(nas).loadTranscript("default", "alpha-bot")?.items ?? [];
    const call = tool(saved);
    expect(call.callId).toBeTruthy();
    expect(call.callId).toBe(tool(items()).callId);
    expect(deliveryLines(agentSend(call)!, saved.slice(saved.indexOf(call) + 1)).map((l) => l.kind)).toEqual(["queued", "ended"]);
  });

  it("keeps a delivery's answer through a JSON export and import", async () => {
    const server = headless();
    const hermes = await signedIn(server);
    await hermes.setAgentMessaging(true);
    await server.messageAgent("default", "beta", ASK, REPLIES);
    await botChat(hermes, "default");
    const exported = chatJson(hermes.getSnapshot().chats.find((c) => c.id === "alpha-bot")!, new Date("2026-11-17T10:00:00Z"));
    const rows = (await planImport("jsonl", "alpha.json", exported)).chats[0].session.messages as Record<string, unknown>[];
    const answer = rows.find((m) => m.display_kind === "process_complete")!;
    expect(returnedItem(String(answer.content), answer.display_kind, undefined)).toEqual({ title: ANSWER.title, body: ANSWER.body, process: false, agent: ANSWER.agent });
  });
});
