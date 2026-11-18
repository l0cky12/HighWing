// @vitest-environment jsdom
// Every recorded computer_use turn (src/hermes/fixtures/computer-use, ADR 0220) through the real transport and the Saved
// copy this computer keeps (chatCache.ts): no screenshot is ever kept, and a chat read back shows the same run.
import { afterEach, describe, expect, it } from "vitest";
import { localChatCache } from "./chatCache";
import { foldRuns, screenUse, type CuRun } from "./computerUse";
import { CU_TURNS, cuFixture, type CuFixture } from "./cuFixtures";
import { CU, HUMAN_HAS_CONTROL } from "./fakeComputerUse";
import { FakeHermes } from "./fakeHermes";
import type { ApprovalChoice, Item } from "./model";
import { connect, type Hermes } from "./transport";

const nas = { mode: "ssh" as const, sshTarget: "lena@nas", url: "", username: "lena" };
const open: Hermes[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
  localStorage.clear();
});

async function replayed(name: CuFixture, upTo?: (f: { frame: Record<string, unknown> }) => boolean) {
  const server = new FakeHermes();
  server.display = { status: { supported: true, installed: true, missing: [], running: true }, lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 }, minted: new Set() };
  const cache = localChatCache(nas);
  const hermes = await connect(server.openPipe, undefined, cache);
  open.push(hermes);
  const id = await hermes.newChat();
  await hermes.send(id, "Use your computer_use tool on your Bot Desktop");
  const chat = () => hermes.getSnapshot().chats.find((c) => c.id === id)!;
  const frames = cuFixture(name);
  const cut = upTo ? frames.findIndex(upTo) : frames.length;
  const choices = frames.flatMap(({ dir, frame }) => (dir === "out" && frame.method === "approval.respond" ? [(frame.params as { choice: ApprovalChoice }).choice] : []));
  const answering = (async () => {
    for (const choice of choices) {
      let ask: Item | undefined;
      while (!(ask = chat().items.find((i) => i.kind === "approval" && !i.answer && !i.ended))) await new Promise((r) => setTimeout(r, 2));
      await hermes.answerApproval(id, ask.id, choice, true);
    }
  })();
  await server.replay(server.runtimeIdOf(id)!, frames.slice(0, cut));
  await answering;
  await hermes.idle();
  return { server, hermes, id, cache, chat };
}

const savedText = () => Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? "").join("\n");
const runLines = (items: readonly Item[]) =>
  foldRuns(items).flatMap((b) => (b.kind === "cu-run" ? (b as CuRun).lines.flatMap((l) => (l.kind === "step" ? [[l.step.n, l.step.action.line, l.step.outcome.kind, l.step.at]] : [])) : []));

describe("A computer_use turn's Saved copy", () => {
  it.each(CU_TURNS)("keeps no screenshot of %s, and reads back as the same run", async (name) => {
    const { id, cache, chat } = await replayed(name);
    expect(cuFixture(name).some((f) => JSON.stringify(f.frame).includes(";base64,"))).toBe(true);
    expect(savedText()).not.toMatch(/;base64,[A-Za-z0-9+/]{1024}/);
    expect(savedText()).not.toMatch(/image_url|text_summary/);
    const saved = cache.loadTranscript("default", id)!.items;
    expect(runLines(saved).length).toBeGreaterThan(1);
    expect(runLines(saved)).toEqual(runLines(chat().items));
    expect(runLines(saved).every(([, , , at]) => typeof at === "number")).toBe(true);
  });
});

describe("Who holds the screen, for the run", () => {
  it("asks once on the chat's first computer_use call, and hears Hermes give it to a person and back", async () => {
    const { server, hermes, chat } = await replayed("13-turn-takeover", (f) => f.frame.method === "display.lease.release");
    expect(server.requests.filter((r) => r.method === "display.status")).toHaveLength(1);
    expect(hermes.getSnapshot().screen?.holder).toEqual({ kind: "someone", since: 1795017085.8091414, reason: "capture: human takes over" });
    expect(screenUse(chat())?.refused).toMatch(/^A human has taken over this desktop/);

    server.broadcast("display.lease", { profile_key: "/home/lena/.hermes", lease: { holder: "agent", viewer_id: null, since: 1795017094.591977, reason: "", epoch: 2, viewer_hash: null } });
    await hermes.idle();
    await new Promise((r) => setTimeout(r, 0));
    expect(hermes.getSnapshot().screen?.holder).toEqual({ kind: "agent" });
  });
});

describe("FakeHermes's computer_use turn, as the app sees it", () => {
  async function started() {
    const server = new FakeHermes();
    server.display = { status: { supported: true, installed: true, missing: [], running: true }, lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 }, minted: new Set() };
    const hermes = await connect(server.openPipe);
    open.push(hermes);
    const id = await hermes.newChat();
    await hermes.send(id, "Tidy the desktop");
    const chat = () => hermes.getSnapshot().chats.find((c) => c.id === id)!;
    const answer = async (choice: ApprovalChoice) => {
      let ask: Item | undefined;
      while (!(ask = chat().items.find((i) => i.kind === "approval" && !i.answer && !i.ended))) await new Promise((r) => setTimeout(r, 2));
      await hermes.answerApproval(id, ask.id, choice, true);
    };
    return { server, hermes, id, chat, answer, rid: server.runtimeIdOf(id)! };
  }

  it("asks once for an action allowed for the chat, and stores each call as Hermes does, with no result", async () => {
    const { server, id, chat, answer, rid } = await started();
    const turn = server.computerUseTurn(rid, { steps: [CU.capture(), CU.click([10, 20], "foreground"), CU.click([30, 40], "foreground"), CU.type("ls"), CU.wait(1)], reply: "Done." });
    await answer("session");
    await answer("deny");
    await turn;
    expect(runLines(chat().items).map(([n, line, outcome]) => [n, line, outcome])).toEqual([
      [1, "capture", "done"],
      [2, "click at (10, 20)", "done"],
      [3, "click at (30, 40)", "done"],
      [4, "type 'ls'", "denied"],
      [5, "wait 1s", "done"],
    ]);
    expect(chat().items.filter((i) => i.kind === "approval").map((i) => i.kind === "approval" && [i.command, i.answer])).toEqual([
      ["computer_use: click at (10, 20) [FOREGROUND — briefly raises the window / changes focus]", "session"],
      ["computer_use: type 'ls' [FOREGROUND — briefly raises the window / changes focus]", "deny"],
    ]);
    const stored = server.transcripts[id].filter((m) => m.role === "tool");
    expect(stored.map((m) => [m.name, m.context, (m.args!.calls as { name: string }[])[0].name, m.result])).toEqual(Array(5).fill(["tool_call", "Computer Use", "computer_use", undefined]));

    const reopened = await connect(server.openPipe);
    open.push(reopened);
    await reopened.sync();
    await reopened.open(id);
    const back = reopened.getSnapshot().chats.find((c) => c.id === id)!.items;
    expect(runLines(back).map(([n, line, outcome]) => [n, line, outcome])).toEqual(runLines(chat().items).map(([n, line]) => [n, line, "unrecorded"]));
  });

  async function waitingAsk(chat: () => { items: Item[] }) {
    let ask: Item | undefined;
    while (!(ask = chat().items.find((i) => i.kind === "approval" && !i.answer && !i.ended))) await new Promise((r) => setTimeout(r, 2));
    return ask as Extract<Item, { kind: "approval" }>;
  }

  it.each([
    ["once", "done"],
    ["session", "done"],
    ["always", "done"],
    ["deny", "denied"],
  ] as const)("sends %s to Hermes as approval.respond for the request it asked, and the step reads %s", async (choice, outcome) => {
    const { server, hermes, id, chat, rid } = await started();
    const turn = server.computerUseTurn(rid, { steps: [CU.click([10, 20], "background")], reply: "Done." });
    const ask = await waitingAsk(chat);
    expect(ask.cua).toEqual({ verb: "click", scope: "background", target: "click at (10, 20)", patternKey: "cua:click:background" });
    const requestId = (server.openRequests.get(ask.id)!.params as { request_id: string }).request_id;
    expect(ask.requestId).toBe(requestId);
    await hermes.answerApproval(id, ask.id, choice, true);
    await turn;
    expect(server.approvalAnswers).toEqual([{ id: ask.id, choice, via: "approval.respond" }]);
    expect(runLines(chat().items).map(([, , kind]) => kind)).toEqual([outcome]);
  });

  it("holds a session or always grant back until the owner has confirmed it", async () => {
    const { server, hermes, id, chat, rid } = await started();
    const turn = server.computerUseTurn(rid, { steps: [CU.click([10, 20], "foreground")], reply: "Done." });
    const ask = await waitingAsk(chat);
    await hermes.answerApproval(id, ask.id, "session");
    await hermes.answerApproval(id, ask.id, "always");
    expect(server.approvalAnswers).toEqual([]);
    expect(chat().items.find((i) => i.id === ask.id)).not.toHaveProperty("answer");
    await hermes.answerApproval(id, ask.id, "always", true);
    await turn;
    expect(server.approvalAnswers.map((a) => a.choice)).toEqual(["always"]);
  });

  it("doesn't ask again for a granted key, and still asks for the other delivery mode", async () => {
    const { server, hermes, id, chat, rid } = await started();
    const turn = server.computerUseTurn(rid, {
      steps: [CU.click([1, 2], "background"), CU.click([3, 4], "background"), CU.scroll("down", 3, "background"), CU.click([5, 6], "foreground")],
      reply: "Done.",
    });
    await hermes.answerApproval(id, (await waitingAsk(chat)).id, "session", true);
    await hermes.answerApproval(id, (await waitingAsk(chat)).id, "once", true);
    await hermes.answerApproval(id, (await waitingAsk(chat)).id, "once", true);
    await turn;
    expect(chat().items.flatMap((i) => (i.kind === "approval" ? [[i.cua?.patternKey, i.answer]] : []))).toEqual([
      ["cua:click:background", "session"],
      ["cua:scroll:background", "once"],
      ["cua:click:foreground", "once"],
    ]);
    expect(server.approvalAnswers).toHaveLength(3);
  });

  it("is refused before any Approval while a person holds the screen", async () => {
    const { server, chat, rid } = await started();
    server.display!.lease = { holder: "human", viewer_hash: "0123456789ab", since: 2, epoch: 1 };
    await server.computerUseTurn(rid, { steps: [CU.scroll("down", 3, "foreground")], reply: "Someone has the screen." });
    expect(chat().items.some((i) => i.kind === "approval")).toBe(false);
    expect(screenUse(chat())?.refused).toBe(HUMAN_HAS_CONTROL);
  });

  it("asks who holds the screen again after a reconnect, so a person who took it meanwhile shows on the refusal", async () => {
    const { server, hermes, id, chat, rid } = await started();
    await server.computerUseTurn(rid, { steps: [CU.capture()], reply: "Captured." });
    expect(hermes.getSnapshot().screen?.holder).toEqual({ kind: "agent" });
    server.drop();
    server.display!.lease = { holder: "human", viewer_hash: "0123456789ab", since: 2, epoch: 1 };
    await hermes.reconnect();
    await hermes.send(id, "Scroll down");
    await server.computerUseTurn(server.runtimeIdOf(id)!, { steps: [CU.scroll("down", 3, "foreground")], reply: "Someone has the screen." });
    await hermes.idle();
    expect(screenUse(chat())?.refused).toBe(HUMAN_HAS_CONTROL);
    expect(hermes.getSnapshot().screen?.holder).toEqual({ kind: "someone", since: 2 });
  });

  it("ends between two calls when the owner stops the reply", async () => {
    const { server, hermes, id, chat, rid } = await started();
    let release!: () => void;
    const turn = server.computerUseTurn(rid, { steps: [CU.capture(), CU.capture(), CU.capture()], reply: "never" }, (s) => (s > 0.6 ? new Promise((r) => (release = () => r())) : Promise.resolve()));
    await new Promise((r) => setTimeout(r, 10));
    await hermes.stop(id);
    release();
    await turn;
    const [run] = foldRuns(chat().items).filter((b): b is CuRun => b.kind === "cu-run");
    expect(run).toMatchObject({ steps: 1, state: "stopped" });
    expect(chat().running).toBe(false);
  });
});
