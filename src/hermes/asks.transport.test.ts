// @vitest-environment jsdom
// The owner's "@" in a Bot Chat (ADR 0232): the message goes to each named bot's Bot Chat, the asking bot takes no turn,
// and the asking chat keeps an Asked card with each reply, here and after a restart.
import { afterEach, describe, expect, it } from "vitest";
import { ASK_FIRST_RULE, SEND_FREELY_RULE } from "./askFirst";
import { askStamp } from "./asks";
import { BOT_CHAT_TITLE, type Bot } from "./bots";
import { localChatCache } from "./chatCache";
import { FakeHermes, row } from "./fakeHermes";
import type { SentReference } from "./model";
import { connect, type Hermes } from "./transport";
import { setUIPrefs } from "./uiPrefs";

const nas = { mode: "ssh" as const, sshTarget: "lena@nas", url: "", username: "lena" };
const WORDS = "@beta what do you think?";
const SELF: SentReference = { chatId: "alpha-bot", title: "Bot Chat with Hermes", summary: "The owner and Hermes planned the backup window." };

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

function headless() {
  const server = new FakeHermes();
  server.sessions = [row("alpha-bot", 1, { title: BOT_CHAT_TITLE, hidden: true })];
  server.otherProfiles = {
    beta: [row("beta-bot", 3, { title: BOT_CHAT_TITLE, hidden: true })],
    gamma: [row("gamma-bot", 4, { title: BOT_CHAT_TITLE, hidden: true })],
  };
  server.transcripts = { "alpha-bot": [{ role: "user", text: "When should backups run?", row_id: 1 }, { role: "assistant", text: "At night.", row_id: 2 }], "beta-bot": [], "gamma-bot": [] };
  return server;
}

async function signedIn(server: FakeHermes, target = nas.sshTarget) {
  const hermes = await connect(server.openPipe, undefined, localChatCache({ ...nas, sshTarget: target }));
  running.push(hermes);
  await hermes.sync();
  return hermes;
}

/** Signed in, alpha's Bot Chat open, and the other bots. */
async function inAlpha(server = headless()) {
  const hermes = await signedIn(server);
  const roster = await hermes.bots();
  const id = await hermes.openBotChat(roster.find((b) => b.profile === "default")!);
  await hermes.open(id);
  const items = () => hermes.getSnapshot().chats.find((c) => c.id === id)!.items;
  const bot = (profile: string) => roster.find((b) => b.profile === profile) as Bot;
  return { server, hermes, items, bot };
}

const until = async (hermes: Hermes, done: () => boolean) => {
  for (let n = 0; n < 50 && !done(); n++) {
    await hermes.idle();
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(done()).toBe(true);
};
const submits = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit");
const target = (hermes: Hermes, profile = "beta") => hermes.asks.list().at(-1)?.targets.find((t) => t.profile === profile);

describe("An @ in a Bot Chat asks the named bot", () => {
  it.each([false, true])("goes to beta's Bot Chat with the stamp and the reference, held, and alpha takes no turn (messaging on: %s)", async (messaging) => {
    const { server, hermes, items, bot } = await inAlpha();
    if (messaging) expect((await hermes.setAgentMessaging(true)).kind).toBe("saved");
    const configured = server.requests.filter((r) => r.method === "profiles.configure").length;
    const before = items().length;

    expect(hermes.asks.send("alpha-bot", [bot("beta")], WORDS, [SELF])).toBeUndefined();
    await until(hermes, () => submits(server).length === 1 && target(hermes)?.state === "answering");

    const [submit] = submits(server);
    expect(submit.params).toMatchObject({ profile: "beta", queued: true, session_id: server.runtimeIdOf("beta-bot") });
    const text = String(submit.params.text);
    expect(text.startsWith(`${WORDS}\n\n--- Attached Context ---\n\n[Asked from: Bot Chat with `)).toBe(true);
    expect(text).toContain("[Referenced chat: Bot Chat with Hermes]");
    expect(askStamp(text)).toBe(hermes.asks.list()[0].id);
    // Nothing went to alpha's session, alpha isn't running, and the switch wasn't touched.
    expect(server.requests.some((r) => r.method === "prompt.submit" && r.params.profile !== "beta")).toBe(false);
    expect(items()).toHaveLength(before);
    expect(hermes.getSnapshot().chats.find((c) => c.id === "alpha-bot")?.running).toBeFalsy();
    expect(server.requests.filter((r) => r.method === "profiles.configure")).toHaveLength(configured);
    expect(hermes.asks.list()[0]).toMatchObject({ text: WORDS, titles: ["Bot Chat with Hermes"], afterRow: 2 });
  });

  it.each([true, false])("carries Ask first's rule last, as any message the owner sends in a Bot Chat does (ask first: %s)", async (askFirst) => {
    const { server, hermes, bot } = await inAlpha();
    setUIPrefs({ askFirst });
    hermes.asks.send("alpha-bot", [bot("beta")], WORDS, [SELF]);
    await until(hermes, () => submits(server).length === 1);
    const text = String(submits(server)[0].params.text);
    expect(text.endsWith(`\n\n${askFirst ? ASK_FIRST_RULE : SEND_FREELY_RULE}`)).toBe(true);
    expect(askStamp(text)).toBe(hermes.asks.list()[0].id);
  });

  it("places the card after a turn alpha had this session, by the newest row Hermes stored", async () => {
    const { server, hermes, items, bot } = await inAlpha();
    await hermes.send("alpha-bot", "And the restores?");
    const rt = server.runtimeIdOf("alpha-bot")!;
    server.event(rt, "message.complete", { text: "On Sunday.", status: "complete" });
    server.storeMessage("alpha-bot", { role: "assistant", text: "On Sunday." });
    const stored = server.transcripts["alpha-bot"].at(-1)!.row_id!;
    await until(hermes, () => !hermes.getSnapshot().chats.find((c) => c.id === "alpha-bot")?.running);
    expect(items().some((i) => "rowId" in i && i.rowId === stored)).toBe(false);

    hermes.asks.send("alpha-bot", [bot("beta")], WORDS, [SELF]);
    await until(hermes, () => hermes.asks.list()[0]?.afterRow === stored);
  });

  it("streams beta's reply into the card and keeps it once the turn ends", async () => {
    const { server, hermes, bot } = await inAlpha();
    hermes.asks.send("alpha-bot", [bot("beta")], WORDS, [SELF]);
    await until(hermes, () => target(hermes)?.state === "answering");
    const rt = server.runtimeIdOf("beta-bot")!;
    server.event(rt, "message.start");
    server.event(rt, "message.delta", { text: "Ship it " });
    await until(hermes, () => target(hermes)?.state === "answering" && (target(hermes) as { reply: string }).reply === "Ship it ");
    server.event(rt, "message.delta", { text: "tonight." });
    server.event(rt, "message.complete", { text: "Ship it tonight.", status: "complete" });
    await until(hermes, () => target(hermes)?.state === "answered");
    expect(target(hermes)).toMatchObject({ reply: "Ship it tonight.", ended: "complete" });
  });

  it("sends a message naming two bots to each, on one card", async () => {
    const { server, hermes, bot } = await inAlpha();
    hermes.asks.send("alpha-bot", [bot("beta"), bot("gamma")], "@beta @gamma which night?", []);
    await until(hermes, () => submits(server).length === 2);
    expect(submits(server).map((s) => s.params.profile).sort()).toEqual(["beta", "gamma"]);
    expect(hermes.asks.list()).toHaveLength(1);
    expect(hermes.asks.list()[0].targets.map((t) => t.profile)).toEqual(["beta", "gamma"]);
    const ids = submits(server).map((s) => askStamp(String(s.params.text)));
    expect(new Set(ids)).toEqual(new Set([hermes.asks.list()[0].id]));
  });

  it("comes back after a restart with the reply, without asking Hermes again", async () => {
    const { server, hermes, bot } = await inAlpha();
    hermes.asks.send("alpha-bot", [bot("beta")], WORDS, [SELF]);
    await until(hermes, () => target(hermes)?.state === "answering");
    const rt = server.runtimeIdOf("beta-bot")!;
    server.event(rt, "message.start");
    server.event(rt, "message.complete", { text: "Ship it tonight.", status: "complete" });
    await until(hermes, () => target(hermes)?.state === "answered");
    await hermes.close();

    const asked = server.requests.length;
    const again = await signedIn(server);
    expect(again.asks.list()).toEqual([expect.objectContaining({ text: WORDS, targets: [expect.objectContaining({ state: "answered", reply: "Ship it tonight." })] })]);
    await again.idle();
    expect(server.requests.slice(asked).some((r) => r.params?.profile === "beta")).toBe(false);
  });

  it("holds the message behind beta's running reply, never interrupting it, and shows only its own turn", async () => {
    const server = headless();
    server.reattachTurns = true;
    const busy = server.busyTurn("beta-bot", "Summarize the logs.");
    const { hermes, bot } = await inAlpha(server);
    hermes.asks.send("alpha-bot", [bot("beta")], WORDS, [SELF]);
    await until(hermes, () => target(hermes)?.state === "waiting");
    expect(target(hermes)).toMatchObject({ why: "busy" });
    expect(server.requests.some((r) => r.method === "session.interrupt")).toBe(false);

    server.event(busy, "message.delta", { text: "The logs say " });
    server.event(busy, "message.complete", { text: "The logs say nothing.", status: "complete" });
    // Hermes starts the held message's turn once the running one ends.
    await until(hermes, () => target(hermes)?.state === "answering");
    server.event(busy, "message.delta", { text: "Friday." });
    server.event(busy, "message.complete", { text: "Friday.", status: "complete" });
    await until(hermes, () => target(hermes)?.state === "answered");
    expect(target(hermes)).toMatchObject({ reply: "Friday." });
  });

  it("still holds it after a restart while beta's earlier reply runs, though Hermes stored it on accept", async () => {
    const server = headless();
    server.reattachTurns = true;
    const busy = server.busyTurn("beta-bot", "Summarize the logs.");
    const { hermes, bot } = await inAlpha(server);
    hermes.asks.send("alpha-bot", [bot("beta")], WORDS, [SELF]);
    await until(hermes, () => target(hermes)?.state === "waiting");
    await hermes.close();
    server.event(busy, "message.delta", { text: "The logs say " });

    const again = await signedIn(server);
    await until(again, () => JSON.stringify(target(again)).includes('"why":"busy"'));
    server.event(busy, "message.complete", { text: "The logs say nothing.", status: "complete" });
    await until(again, () => target(again)?.state === "answering");
    server.event(busy, "message.delta", { text: "Friday." });
    server.event(busy, "message.complete", { text: "Friday.", status: "complete" });
    await until(again, () => target(again)?.state === "answered");
    expect(target(again)).toMatchObject({ reply: "Friday." });
  });

  it("is refused offline, sending nothing and keeping nothing", async () => {
    const { server, hermes, bot } = await inAlpha();
    server.drop();
    await until(hermes, () => hermes.getSnapshot().status !== "connected");
    const sent = server.requests.length;
    expect(hermes.asks.send("alpha-bot", [bot("beta")], WORDS, [SELF])).toBe("offline");
    expect(hermes.asks.list()).toEqual([]);
    expect(server.requests.length).toBe(sent);
  });

  it("shows Hermes's refusal on the card; Retry sends the same ask again", async () => {
    const { server, hermes, bot } = await inAlpha();
    server.rejectPrompt = { code: 4010, message: "Bot Chat is closed" };
    hermes.asks.send("alpha-bot", [bot("beta")], WORDS, [SELF]);
    await until(hermes, () => target(hermes)?.state === "failed");
    expect(target(hermes)).toMatchObject({ cause: "refused", reason: expect.stringContaining("Bot Chat is closed") });
    server.rejectPrompt = undefined;
    const id = hermes.asks.list()[0].id;
    hermes.asks.retry(id, "beta");
    await until(hermes, () => target(hermes)?.state === "answering");
    expect(submits(server).map((s) => askStamp(String(s.params.text)))).toEqual([id, id]);
  });

  it("settles a send the connection dropped by its stamp: found, it isn't sent again", async () => {
    const { server, hermes, bot } = await inAlpha();
    server.dropOnPrompt = "stored";
    hermes.asks.send("alpha-bot", [bot("beta")], WORDS, [SELF]);
    await until(hermes, () => target(hermes)?.state === "unknown");
    await hermes.reconnect();
    await until(hermes, () => target(hermes)?.state !== "unknown");
    expect(target(hermes)?.state).not.toBe("failed");
    expect(submits(server)).toHaveLength(1);
  });

  it("settles a send the connection dropped by its stamp: not there, it is failed, and Retry sends it once", async () => {
    const { server, hermes, bot } = await inAlpha();
    server.dropOnPrompt = "lost";
    hermes.asks.send("alpha-bot", [bot("beta")], WORDS, [SELF]);
    await until(hermes, () => target(hermes)?.state === "unknown");
    await hermes.reconnect();
    await until(hermes, () => target(hermes)?.state === "failed");
    hermes.asks.retry(hermes.asks.list()[0].id, "beta");
    await until(hermes, () => target(hermes)?.state === "answering");
    expect(submits(server)).toHaveLength(2);
  });

  it("Edit takes the failed bots off the card and gives back the words and references; Dismiss drops the card", async () => {
    const { server, hermes, bot } = await inAlpha();
    server.rejectPrompt = { code: 4010, message: "no" };
    hermes.asks.send("alpha-bot", [bot("beta")], WORDS, [SELF]);
    await until(hermes, () => target(hermes)?.state === "failed");
    expect(hermes.asks.takeBack(hermes.asks.list()[0].id)).toEqual({ text: WORDS, references: [SELF] });
    expect(hermes.asks.list()).toEqual([]);

    hermes.asks.send("alpha-bot", [bot("beta")], WORDS, [SELF]);
    await until(hermes, () => target(hermes)?.state === "failed");
    hermes.asks.dismiss(hermes.asks.list()[0].id, "beta");
    expect(hermes.asks.list()).toEqual([]);
    await hermes.close();
    expect((await signedIn(server)).asks.list()).toEqual([]);
  });
});

const settleFor = async (hermes: Hermes, n = 30) => {
  for (let i = 0; i < n; i++) {
    await hermes.idle();
    await new Promise((r) => setTimeout(r, 10));
  }
};
const states = (hermes: Hermes) => hermes.asks.list().map((a) => a.targets.map((t) => ({ state: t.state, reply: (t as { reply?: string }).reply })));

describe("Asks to one bot that meet", () => {
  it("gives a reply that ends as the next ask reaches beta to the ask it answers, not to the next", async () => {
    const { server, hermes, bot } = await inAlpha();
    hermes.asks.send("alpha-bot", [bot("beta")], "@beta first?", [SELF]);
    await until(hermes, () => hermes.asks.list()[0]?.targets[0].state === "answering");
    const rt = server.runtimeIdOf("beta-bot")!;
    server.event(rt, "message.start");
    server.event(rt, "message.delta", { text: "First answer." });
    await settleFor(hermes, 3);
    // The first turn ends at Hermes just before the second message reaches it, so the second isn't held; its last frames
    // reach the app while the second submit is out.
    const submit = server.handlers["prompt.submit"];
    server.handlers["prompt.submit"] = (r) => {
      server.event(rt, "message.complete", { text: "First answer.", status: "complete" });
      submit(r);
    };
    hermes.asks.send("alpha-bot", [bot("beta")], "@beta second?", [SELF]);
    await settleFor(hermes);
    server.handlers["prompt.submit"] = submit;
    server.event(rt, "message.start");
    server.event(rt, "message.delta", { text: "Second answer." });
    server.event(rt, "message.complete", { text: "Second answer.", status: "complete" });
    await settleFor(hermes);
    expect(states(hermes)).toEqual([[{ state: "answered", reply: "First answer." }], [{ state: "answered", reply: "Second answer." }]]);
  });

  it("answers two asks Hermes held behind one reply with the one turn it merges them into, after a reconnect too", async () => {
    const server = headless();
    server.reattachTurns = true;
    const busy = server.busyTurn("beta-bot", "Summarize the logs.");
    const { hermes, bot } = await inAlpha(server);
    hermes.asks.send("alpha-bot", [bot("beta")], "@beta which night?", [SELF]);
    await until(hermes, () => hermes.asks.list()[0]?.targets[0].state === "waiting");
    hermes.asks.send("alpha-bot", [bot("beta")], "@beta which hour?", [SELF]);
    await until(hermes, () => hermes.asks.list()[1]?.targets[0].state === "waiting");
    server.drop();
    await until(hermes, () => hermes.getSnapshot().status !== "connected");
    await hermes.reconnect();
    await settleFor(hermes);
    expect(states(hermes).map((s) => s[0].state)).toEqual(["waiting", "waiting"]);

    server.event(busy, "message.complete", { text: "The logs say nothing.", status: "complete" });
    await until(hermes, () => states(hermes).every((s) => s[0].state === "answering"));
    server.event(busy, "message.delta", { text: "Friday at two." });
    server.event(busy, "message.complete", { text: "Friday at two.", status: "complete" });
    await settleFor(hermes);
    expect(states(hermes)).toEqual([[{ state: "answered", reply: "Friday at two." }], [{ state: "answered", reply: "Friday at two." }]]);
  });

  it("reads again on the next connection when a drop comes while a reconnect reads beta's rows", async () => {
    const server = headless();
    server.reattachTurns = true;
    const { hermes, bot } = await inAlpha(server);
    hermes.asks.send("alpha-bot", [bot("beta")], WORDS, [SELF]);
    await until(hermes, () => target(hermes)?.state === "answering");
    const rt = server.runtimeIdOf("beta-bot")!;
    server.event(rt, "message.start");
    server.event(rt, "message.delta", { text: "Fri" });
    server.drop();
    await until(hermes, () => hermes.getSnapshot().status !== "connected");

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gated = false;
    const rest = server as unknown as { restCall: (m: string, p: string, b?: string) => Promise<string> };
    const read = rest.restCall.bind(server);
    rest.restCall = async (m, p, b) => {
      if (!gated && p.includes("beta-bot") && p.includes("/messages")) {
        gated = true;
        await gate;
      }
      return read(m, p, b);
    };
    const back = hermes.reconnect();
    for (let n = 0; n < 200 && !gated; n++) await new Promise((r) => setTimeout(r, 5));
    expect(gated).toBe(true);
    server.drop();
    for (let n = 0; n < 200 && hermes.getSnapshot().status === "connected"; n++) await new Promise((r) => setTimeout(r, 5));
    release();
    await back.catch(() => {});
    await settleFor(hermes, 5);
    await hermes.reconnect();
    await settleFor(hermes);
    server.event(rt, "message.delta", { text: "day." });
    server.event(rt, "message.complete", { text: "Friday.", status: "complete" });
    await settleFor(hermes);
    expect(states(hermes)).toEqual([[{ state: "answered", reply: "Friday." }]]);
  });
});

describe("An ask picked back up after a restart while beta replies", () => {
  /** Asked, beta's reply under way with "Fri", and the app closed: the next launch reads it again. */
  async function closedMidReply() {
    const server = headless();
    server.reattachTurns = true;
    const { hermes, bot } = await inAlpha(server);
    hermes.asks.send("alpha-bot", [bot("beta")], WORDS, [SELF]);
    await until(hermes, () => target(hermes)?.state === "answering");
    const rt = server.runtimeIdOf("beta-bot")!;
    server.event(rt, "message.start");
    server.event(rt, "message.delta", { text: "Fri", segment: 0, offset: 0 });
    await settleFor(hermes, 3);
    return { server, hermes, rt };
  }

  it("keeps what beta sent before Hermes answered the resume", async () => {
    const { server, hermes, rt } = await closedMidReply();
    await hermes.close();
    server.beforeResumeAnswer = (sid) => {
      if (sid !== rt) return;
      server.event(rt, "message.delta", { text: "day.", segment: 0, offset: 3 });
      server.event(rt, "message.complete", { text: "Friday.", status: "complete" });
    };
    const again = await signedIn(server);
    await until(again, () => target(again)?.state === "answered");
    expect(target(again)).toMatchObject({ reply: "Friday." });
  });

  it("doesn't take in twice the delta the resume's text already had", async () => {
    const { server, hermes, rt } = await closedMidReply();
    await hermes.close();
    const again = await signedIn(server);
    await until(again, () => target(again)?.state === "answering");
    server.event(rt, "message.delta", { text: "Fri", segment: 0, offset: 0 });
    server.event(rt, "message.delta", { text: "day.", segment: 0, offset: 3 });
    server.event(rt, "message.complete", { text: "Friday.", status: "complete" });
    await until(again, () => target(again)?.state === "answered");
    expect(target(again)).toMatchObject({ reply: "Friday." });
  });

  it("still says beta waits on the owner when an Approval was open", async () => {
    const { server, hermes, rt } = await closedMidReply();
    server.ask(rt, "approval", { command: "rm -rf build", description: "delete the build folder" });
    await until(hermes, () => JSON.stringify(target(hermes)).includes('"doing":"needs-you"'));
    await hermes.close();
    const again = await signedIn(server);
    await until(again, () => target(again)?.state === "answering");
    expect(target(again)).toMatchObject({ doing: "needs-you" });
    // A frame that isn't the turn going on leaves it waiting; the turn going on means the owner answered.
    server.event(rt, "session.usage", { input_tokens: 10 });
    await settleFor(again, 3);
    expect(target(again)).toMatchObject({ doing: "needs-you" });
    server.event(rt, "message.delta", { text: "day.", segment: 0, offset: 3 });
    await until(again, () => target(again)?.state === "answering" && !JSON.stringify(target(again)).includes("needs-you"));
  });
});
