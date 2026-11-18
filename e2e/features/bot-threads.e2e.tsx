import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { BOT_CHAT_TITLE } from "../../src/hermes/bots";
import { row, type FakeHermes } from "../../src/hermes/fakeHermes";
import { boot, sessionOfPrompt, shot } from "../harness";

const nowS = () => Date.now() / 1000;
const bot = (id: string, hours: number) => row(id, hours / 24, { title: BOT_CHAT_TITLE, hidden: true });
const active = (id: string, hours: number, title: string) => row(id, hours / 24, { pinned: true, title, last_read_at: nowS() });
const BOT_REPLY = "Nothing urgent. The nightly backup ran clean and the UPS test passed.";

const seed = (s: FakeHermes) => {
  s.compress = "rotate";
  s.sessions = [bot("hermes-bot", 0.5), active("backup", 0.4, "Nightly backup failing"), active("garage", 3, "VLAN notes for the garage")];
  s.otherProfiles = { writer: [bot("quill-bot", 14)], ops: [bot("ops-bot", 0.1)] };
  s.storeMessage("hermes-bot", { role: "user", text: "Anything I should look at this morning?" });
  s.storeMessage("hermes-bot", { role: "assistant", text: BOT_REPLY });
  s.transcripts["quill-bot"] = [{ role: "assistant", text: "Draft two of the release notes is in the doc." }];
  s.transcripts["ops-bot"] = [{ role: "assistant", text: "Rolling the Caddy config out to the second node now." }];
  s.transcripts.backup = [{ role: "user", text: "Why did last night's backup fail?" }];
  s.transcripts.garage = [{ role: "user", text: "Which VLAN should the garage door opener sit on?" }];
  s.profileMeta = {
    writer: { ui_meta: { "hermes-bots": { title: "Quill", color: "#f59e0b" } } },
    ops: { ui_meta: { "hermes-bots": { title: "Ops", color: "#3b82f6" } } },
  };
  s.seedThread("default", "Router VLAN plan", { hours: 26, messages: [{ role: "user", text: "IoT on VLAN 30, guests on VLAN 40." }] });
  s.seedThread("writer", "Changelog wording", { hours: 50, messages: [{ role: "user", text: "Shorter verbs, no marketing." }] });
  s.seedThread("writer", "Blog post: self-hosting", { hours: 5, messages: [{ role: "assistant", text: "The outline is in the doc." }] });
};

const inApp = <T extends Element>(css: string) => document.querySelector("iframe")!.contentDocument!.querySelector<T>(css);
const head = () => inApp(".chat-head .chat-title")?.textContent;
const threadsOf = (server: FakeHermes, profile: string) => server.store(profile)!.filter((s) => s.title?.startsWith("Bot Thread: "));

async function start() {
  const { app, server } = await boot({ seed });
  const panel = app.getByRole("complementary");
  const tab = (name: "Chats" | "Bots") => panel.getByRole("tab", { name: new RegExp(`^${name}`) });
  await expect.element(panel.getByRole("button", { name: /Nightly backup failing/ })).toBeVisible();
  const botRow = (name: string) => panel.getByRole("button", { name: new RegExp(`^${name}( \\(profile \\w+\\))?\\.`) });
  const toggle = (name: string) => panel.getByRole("button", { name: new RegExp(`^${name}: `) });
  const thread = (topic: string) => panel.getByRole("button", { name: new RegExp(`^${topic}`) });
  return { app, server, panel, tab, botRow, toggle, thread };
}

async function sendAndReply(app: Awaited<ReturnType<typeof boot>>["app"], server: FakeHermes, to: string, prompt: string, reply: string) {
  await app.getByPlaceholder(`Message ${to}`).fill(prompt);
  await userEvent.keyboard("{Enter}");
  const session = await sessionOfPrompt(server, prompt);
  server.event(session, "message.start");
  server.event(session, "message.complete", { text: reply, status: "complete" });
  await expect.element(app.getByText(reply)).toBeVisible();
}

it("starts a thread with New thread and one from a Bot Chat reply, and goes between them and the Bot Chat", async () => {
  const { app, server, panel, tab, botRow, toggle, thread } = await start();
  await tab("Bots").click();
  await expect.element(toggle("Hermes")).toHaveTextContent("1 thread");
  await expect.element(toggle("Quill")).toHaveTextContent("2 threads");
  await expect.element(toggle("Ops")).toHaveTextContent("No threads");
  await expect.element(toggle("Quill")).toHaveAttribute("aria-expanded", "false");
  await shot("every-bot-has-a-disclosure");

  await botRow("Hermes").click();
  await expect.poll(head).toBe("HHermesBot Chat");
  await expect.element(toggle("Hermes")).toHaveAttribute("aria-expanded", "true");
  await expect.element(thread("Router VLAN plan")).toBeVisible();
  await shot("bot-chat-with-its-threads");

  await panel.getByRole("group", { name: "Hermes's threads" }).getByRole("button", { name: "New thread" }).click();
  await panel.getByRole("textbox", { name: "Topic of the new thread with Hermes" }).fill("Backup restore drill");
  await shot("new-thread-topic");
  await userEvent.keyboard("{Enter}");
  await expect.poll(head).toBe("HHermes/Backup restore drillThread");
  await expect.element(thread("Backup restore drill")).toHaveAttribute("aria-current", "true");
  await sendAndReply(app, server, "Hermes", "Restore the photos share to /tmp/drill", "Restored the photos share to /tmp/drill.");
  const made = threadsOf(server, "default").find((s) => s.title === "Bot Thread: Backup restore drill")!;
  expect(made, "the new thread is a hidden session with no parent").toMatchObject({ hidden: true });
  expect(made.parent_session_id).toBeUndefined();
  await shot("new-thread-with-a-reply");

  await botRow("Hermes").click();
  await expect.poll(head).toBe("HHermesBot Chat");
  await app.getByText(BOT_REPLY).last().hover();
  await app.getByRole("button", { name: "Thread from here" }).last().click();
  const dialog = app.getByRole("dialog", { name: "Thread from here" });
  await expect.element(dialog.getByText(/History it starts with: 2 messages/)).toBeVisible();
  await dialog.getByRole("textbox", { name: "Topic" }).fill("UPS test follow-up");
  await shot("thread-from-here-preview");
  await dialog.getByRole("button", { name: "Start thread" }).click();
  await expect.poll(head).toBe("HHermes/UPS test follow-upThread");
  await expect.element(app.getByRole("paragraph").filter({ hasText: BOT_REPLY })).toBeVisible();
  await expect.element(app.getByText("Anything I should look at this morning?")).toBeVisible();
  await expect.element(thread("UPS test follow-up")).toHaveAttribute("aria-current", "true");
  const forked = threadsOf(server, "default").find((s) => s.title === "Bot Thread: UPS test follow-up")!;
  expect(forked, "the thread from a message is a hidden copy Hermes made of the Bot Chat").toMatchObject({ hidden: true, parent_session_id: "hermes-bot", pinned: false });
  expect(server.transcripts[forked.id].map((m) => m.text)).toEqual(["Anything I should look at this morning?", BOT_REPLY]);
  expect(server.transcripts["hermes-bot"]).toHaveLength(2);
  await expect.element(toggle("Hermes")).toHaveTextContent("3 threads");
  await shot("thread-from-here-opened");

  await thread("Backup restore drill").click();
  await expect.poll(head).toBe("HHermes/Backup restore drillThread");
  await expect.element(app.getByText("Restored the photos share to /tmp/drill.")).toBeVisible();
  await thread("Router VLAN plan").click();
  await expect.poll(head).toBe("HHermes/Router VLAN planThread");
  await expect.element(app.getByText("IoT on VLAN 30, guests on VLAN 40.")).toBeVisible();
  await shot("switched-to-an-older-thread");
  await botRow("Hermes").click();
  await expect.poll(head).toBe("HHermesBot Chat");
  await expect.element(botRow("Hermes")).toHaveAttribute("aria-current", "true");
  expect(server.sessions.filter((s) => s.title === BOT_CHAT_TITLE)).toHaveLength(1);
});

it("opens another bot's thread as a visit, and keeps threads out of Chats and Search", async () => {
  const { app, panel, tab, toggle, thread } = await start();
  await panel.getByRole("button", { name: /Nightly backup failing/ }).click();
  await expect.element(app.getByText("Why did last night's backup fail?")).toBeVisible();
  await tab("Bots").click();
  await toggle("Quill").click();
  await thread("Blog post: self-hosting").click();
  await expect.poll(head).toBe("QQuill/Blog post: self-hostingThread");
  await expect.element(app.getByText("The outline is in the doc.")).toBeVisible();
  await expect.element(app.getByPlaceholder("Message Quill")).toBeVisible();
  await expect.element(tab("Bots")).toHaveAttribute("aria-selected", "true");
  await shot("another-bots-thread");

  await tab("Chats").click();
  await expect.element(panel.getByRole("button", { name: "Hermes (default)" })).toBeVisible();
  await expect.element(app.getByText("Why did last night's backup fail?")).toBeVisible();
  await expect.element(panel.getByRole("button", { name: /VLAN notes for the garage/ })).toBeVisible();
  expect(panel.getByRole("button", { name: /Router VLAN plan|Bot Thread/ }).elements()).toEqual([]);
  await shot("chats-without-threads");

  await userEvent.keyboard("{Control>}k{/Control}");
  await app.getByPlaceholder("Search all chats, including Archived").fill("VLAN");
  await expect.poll(() => [...document.querySelector("iframe")!.contentDocument!.querySelectorAll(".hit-row")].length).toBe(1);
  await expect.element(app.getByText("Which VLAN should the garage door opener sit on?")).toBeVisible();
  expect(app.getByText(/IoT on VLAN 30/).elements()).toEqual([]);
  await shot("search-without-threads");
});

it("keeps a bot's threads under it, and opening, after its Bot Chat and a thread are compacted into new sessions", async () => {
  const { app, server, panel, tab, botRow, toggle, thread } = await start();
  await tab("Bots").click();
  await botRow("Hermes").click();
  await expect.poll(head).toBe("HHermesBot Chat");
  await expect.poll(() => server.runtimeIdOf("hermes-bot"), { message: "the Bot Chat resumed" }).toBeTruthy();
  await app.getByPlaceholder("Message Hermes").fill("/new");
  await userEvent.keyboard("{Enter}{Enter}");
  await expect.element(app.getByText(/A Bot Chat is one continuous conversation, so \/new compacts it/)).toBeVisible();
  const botTip = server.sessions.find((s) => s.id === "hermes-bot")!.listedAs?.id;
  expect(botTip, "Hermes moved the Bot Chat to a new session").toBeTruthy();
  expect(server.sessions.find((s) => s.id === "hermes-bot")).toMatchObject({ end_reason: "compression", title: BOT_CHAT_TITLE });

  await panel.getByRole("button", { name: "Reload bots" }).click();
  await expect.element(toggle("Hermes")).toHaveTextContent("1 thread");
  await expect.element(thread("Router VLAN plan")).toBeVisible();
  await shot("threads-after-the-bot-chat-compacted");
  await thread("Router VLAN plan").click();
  await expect.poll(head).toBe("HHermes/Router VLAN planThread");
  await expect.element(app.getByText("IoT on VLAN 30, guests on VLAN 40.")).toBeVisible();

  const first = threadsOf(server, "default")[0];
  await expect.poll(() => server.runtimeIdOf(first.id), { message: "the thread resumed" }).toBeTruthy();
  await app.getByPlaceholder("Message Hermes").fill("/new");
  await userEvent.keyboard("{Enter}{Enter}");
  await expect.element(app.getByText(/A thread is one continuous conversation, so \/new compacts it/)).toBeVisible();
  const threadTip = first.listedAs?.id;
  expect(threadTip, "Hermes moved the thread to a new session").toBeTruthy();
  await panel.getByRole("button", { name: "Reload bots" }).click();
  await expect.element(toggle("Hermes")).toHaveTextContent("1 thread");

  await botRow("Hermes").click();
  await expect.poll(head).toBe("HHermesBot Chat");
  await expect.poll(() => server.runtimeIdOf(botTip!), { message: "the Bot Chat opens in its new session" }).toBeTruthy();
  await thread("Router VLAN plan").click();
  await expect.poll(head).toBe("HHermes/Router VLAN planThread");
  await expect.poll(() => server.last("session.resume")?.params.session_id, { message: "the thread opens in its new session" }).toBe(threadTip);
  await expect.element(app.getByText("IoT on VLAN 30, guests on VLAN 40.")).toBeVisible();
  expect(threadsOf(server, "default").map((s) => s.title)).toEqual(["Bot Thread: Router VLAN plan"]);
  expect(server.sessions.filter((s) => s.title === BOT_CHAT_TITLE)).toHaveLength(1);
  await shot("threads-after-a-thread-compacted");
});
