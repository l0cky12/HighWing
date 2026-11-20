// @vitest-environment jsdom
// Ask first (ADR 0229) through the real transport against FakeHermes: what a message sent from here carries in a Bot
// Chat, in each setting, and nowhere else.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASK_FIRST_RULE, SEND_FREELY_RULE } from "./askFirst";
import { BOT_CHAT_TITLE } from "./bots";
import { FakeHermes, row } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import { setUIPrefs } from "./uiPrefs";

const running: Hermes[] = [];
beforeEach(() => localStorage.clear());
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
});

const ATTACHED = "\n\n--- Attached Context ---\n\n";

async function signedIn() {
  const server = new FakeHermes();
  server.sessions = [row("side", 1, { title: "Disk usage" }), row("bot", 2, { title: BOT_CHAT_TITLE, hidden: true })];
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  await hermes.sync();
  const botChat = async () => {
    const id = await hermes.openBotChat((await hermes.bots()).find((b) => b.profile === "default")!);
    await hermes.open(id);
    return id;
  };
  const submits = () => server.requests.filter((r) => r.method === "prompt.submit").map((r) => String(r.params.text));
  return { server, hermes, submits, botChat };
}

describe("a message in a Bot Chat", () => {
  it("carries the ask-first rule after the Attached Context marker, and the chat shows only the words typed", async () => {
    const { hermes, submits, botChat } = await signedIn();
    const bot = await botChat();
    expect(await hermes.send(bot, "Watch the release disk tonight")).toEqual({ delivery: "accepted" });
    expect(submits()).toEqual([`Watch the release disk tonight${ATTACHED}${ASK_FIRST_RULE}`]);
    expect(hermes.getSnapshot().chats.find((c) => c.id === bot)!.items.filter((i) => i.kind === "user").map((i) => i.text)).toEqual(["Watch the release disk tonight"]);
  });

  it("carries the send-freely rule when the owner turned Ask first off, so it overrides one left in the history", async () => {
    const { hermes, submits, botChat } = await signedIn();
    const bot = await botChat();
    await hermes.send(bot, "First");
    setUIPrefs({ askFirst: false });
    await hermes.send(bot, "Second");
    expect(submits()).toEqual([`First${ATTACHED}${ASK_FIRST_RULE}`, `Second${ATTACHED}${SEND_FREELY_RULE}`]);
  });

  it("carries the rule once when a failed send is retried", async () => {
    const { server, hermes, submits, botChat } = await signedIn();
    const bot = await botChat();
    server.rejectPrompt = { code: 4009, message: "session busy" };
    await hermes.send(bot, "Watch the release disk tonight");
    server.rejectPrompt = undefined;
    const failed = hermes.getSnapshot().chats.find((c) => c.id === bot)!.items.at(-1)!;
    expect(await hermes.retry(bot, failed.id)).toEqual({ delivery: "accepted" });
    expect(submits().at(-1)).toBe(`Watch the release disk tonight${ATTACHED}${ASK_FIRST_RULE}`);
    expect(submits().at(-1)!.split(ASK_FIRST_RULE)).toHaveLength(2);
  });
});

describe("a Bot Chat message sent from another client", () => {
  it("shows only the words typed in the chat open here", async () => {
    const { server, hermes, botChat } = await signedIn();
    const bot = await botChat();
    // Hermes runs the other client's turn here with no message from this app: the row it stored carries the rule.
    server.wake(bot, { text: `Tidy the desktop${ATTACHED}${ASK_FIRST_RULE}`, display_kind: "" }, "Tidied.");
    const users = () => hermes.getSnapshot().chats.find((c) => c.id === bot)!.items.filter((i) => i.kind === "user").map((i) => i.text);
    await expect.poll(users).toEqual(["Tidy the desktop"]);
  });
});

describe("a message in an ordinary chat", () => {
  it("carries no rule, in either setting", async () => {
    const { hermes, submits } = await signedIn();
    await hermes.open("side");
    await hermes.send("side", "Which disk is full?");
    setUIPrefs({ askFirst: false });
    await hermes.send("side", "And the other?");
    expect(submits()).toEqual(["Which disk is full?", "And the other?"]);
  });
});
