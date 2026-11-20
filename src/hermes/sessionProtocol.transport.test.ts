// The transport's session core, run once per protocol (ADR 0174 step 4, ADR 0244): the same flows through the app's
// own transport against FakeHermes as a legacy dashboard and as a canonical gateway, asserting what the owner sees.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { withContext } from "./projectContext";
import { canonicalGate } from "./sessionProtocol";
import { connect } from "./transport";

const MODES = ["legacy", "canonical"] as const;

describe.each(MODES)("the transport's session core on a %s server", (mode) => {
  beforeEach(() => void (canonicalGate.open = mode === "canonical"));
  afterEach(() => {
    canonicalGate.open = false;
    vi.useRealTimers();
  });

  async function signedIn() {
    const server = new FakeHermes();
    if (mode === "canonical") server.asCanonical();
    const hermes = await connect(server.openPipe);
    expect(hermes["protocol"].kind).toBe(mode);
    const chat = (id: string) => hermes.getSnapshot().chats.find((c) => c.id === id)!;
    return { server, hermes, chat, runtime: (id: string) => server.runtimeIdOf(id)! };
  }

  /** A new chat whose reply to a message is under way. */
  async function replying() {
    const signed = await signedIn();
    const id = await signed.hermes.newChat();
    await signed.hermes.send(id, "Clean up the logs");
    const runtime = signed.runtime(id);
    signed.server.event(runtime, "message.start");
    const card = (kind: string) => signed.chat(id).items.find((i) => i.kind === kind);
    return { ...signed, id, runtime, card };
  }

  it("starts a chat and streams the reply to a message into it", async () => {
    const { server, hermes, chat, runtime } = await signedIn();
    const id = await hermes.newChat();
    expect(chat(id)).toMatchObject({ runtimeId: runtime(id), settled: false, items: [] });
    expect(await hermes.send(id, "What's the disk usage on the NAS?")).toEqual({ delivery: "accepted" });
    expect(chat(id)).toMatchObject({ running: true });
    server.event(runtime(id), "message.start");
    server.event(runtime(id), "message.delta", { text: "It's at " });
    server.event(runtime(id), "message.delta", { text: "**92%**." });
    server.event(runtime(id), "message.complete", { text: "It's at **92%**.", status: "complete" });
    expect(chat(id).running).toBe(false);
    expect(chat(id).items.map((i) => [i.kind, "text" in i ? i.text : undefined])).toEqual([
      ["user", "What's the disk usage on the NAS?"],
      ["assistant", "It's at **92%**."],
    ]);
  });

  it("sends project instructions with the chat's first message only, as the protocol carries them", async () => {
    const { server, hermes, runtime } = await signedIn();
    const id = await hermes.newChat(undefined, { instructions: "Answer in French." });
    await hermes.send(id, "hi");
    server.event(runtime(id), "message.start");
    server.event(runtime(id), "message.complete", { text: "Salut", status: "complete" });
    await hermes.send(id, "again");
    const texts = server.requests.filter((r) => r.method === "prompt.submit").map((r) => r.params.text);
    const created = server.last("session.create")!.params;
    if (mode === "legacy") {
      expect(created.messages).toEqual([{ role: "user", content: "Answer in French.", display_kind: "hidden" }]);
      expect(texts).toEqual(["hi", "again"]);
    } else {
      expect(created).not.toHaveProperty("messages");
      expect(texts).toEqual([withContext("hi", ["Answer in French."]), "again"]);
    }
  });

  it("lists a chat that has run a turn under this app's Source on a legacy server, and Hermes Desktop's on a canonical one", async () => {
    const { server, hermes, chat, runtime } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "hi");
    server.event(runtime(id), "message.start");
    server.event(runtime(id), "message.complete", { text: "Hello", status: "complete" });
    server.broadcast("sessions.changed");
    await hermes.idle();
    expect(chat(id).source).toBe(mode === "legacy" ? "app" : "desktop");
  });

  it("shows an Approval as a card, and the owner's answer reaches Hermes", async () => {
    const { server, hermes, id, runtime, chat, card } = await replying();
    const { id: asked } = server.askApproval(runtime, { command: "rm -rf /var/log/old", description: "recursive delete" });
    expect(card("approval")).toMatchObject({ id: asked, command: "rm -rf /var/log/old", description: "recursive delete", choices: ["once", "session", "always", "deny"] });
    expect(chat(id).running).toBe(true);
    await hermes.answerApproval(id, asked!, "once");
    expect(card("approval")).toMatchObject({ answer: "once" });
    expect(server.approvalAnswers.map((a) => a.choice)).toEqual(["once"]);
  });

  it("shows a Clarify question as a card, and the owner's answer reaches Hermes", async () => {
    const { server, hermes, id, runtime, card } = await replying();
    server.askClarify(runtime, [{ question: "Tea or coffee?", choices: ["Tea", "Coffee"] }]);
    const asked = card("clarify")!;
    expect(asked).toMatchObject({ questions: [{ question: "Tea or coffee?", choices: ["Tea", "Coffee"], multiSelect: false }] });
    const { qid } = (asked as Extract<typeof asked, { kind: "clarify" }>).questions[0];
    await hermes.answerQuestion(id, asked.id, { kind: "lock", qid, answer: "Tea" });
    expect(card("clarify")).toMatchObject({ answer: "answered", locked: { [qid]: "Tea" } });
    const sent = server.requests.find((r) => r.method === (mode === "legacy" ? "clarify.lock" : "clarify.respond"))!.params;
    expect(sent).toMatchObject({ answer: "Tea" });
  });

  it("stops a running reply, and closes the Approval it waited on", async () => {
    const { server, hermes, id, runtime, chat, card } = await replying();
    server.askApproval(runtime);
    await hermes.stop(id);
    const interrupt = server.last("session.interrupt")!.params;
    expect(interrupt).toMatchObject(mode === "legacy" ? { session_id: runtime } : { session_id: runtime, execution_generation: 1 });
    server.event(runtime, "message.complete", { text: "", status: "interrupted" });
    expect(chat(id).running).toBe(false);
    expect(card("approval")).toMatchObject({ ended: expect.any(String) });
  });

  it("brings back a running reply and its waiting Approval after a reconnect, and the answer reaches Hermes", async () => {
    vi.useFakeTimers();
    const { server, hermes, id, runtime, chat, card } = await replying();
    server.transcripts[id] = [{ role: "user", text: "Clean up the logs" }];
    const { id: asked } = server.askApproval(runtime);
    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();
    expect(chat(id).items.filter((i) => i.kind === "approval")).toEqual([expect.objectContaining({ id: asked, command: "rm -rf /var/log/old" })]);
    expect(chat(id)).toMatchObject({ running: true });
    await hermes.answerApproval(id, asked!, "once");
    expect(card("approval")).toMatchObject({ answer: "once" });
    expect(server.approvalAnswers.map((a) => a.choice)).toEqual(["once"]);
  });
});
