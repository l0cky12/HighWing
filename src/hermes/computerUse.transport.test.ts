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

describe("Stop during a computer-use turn", () => {
  async function started(display = true) {
    const server = new FakeHermes();
    if (display)
      server.display = { status: { supported: true, installed: true, missing: [], running: true }, lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 }, minted: new Set() };
    const hermes = await connect(server.openPipe);
    open.push(hermes);
    const id = await hermes.newChat();
    await hermes.send(id, "Tidy the desktop");
    const chat = (chatId = id) => hermes.getSnapshot().chats.find((c) => c.id === chatId)!;
    return { server, hermes, id, chat, rid: server.runtimeIdOf(id)! };
  }

  /** A turn of captures that pauses after its first, until `next` lets it go on. */
  function paused(server: FakeHermes, rid: string) {
    let next!: () => void;
    const turn = server.computerUseTurn(rid, { steps: [CU.capture(), CU.capture(), CU.capture()], reply: "never" }, (s) =>
      s > 0.6 ? new Promise<void>((r) => (next = r)) : Promise.resolve(),
    );
    return { turn, next: () => next() };
  }

  const screenAsks = (server: FakeHermes) =>
    server.requests.filter((r) => r.method === "display.observe" || r.method === "display.lease.acquire").map((r) => [r.method, r.params]);
  const interrupts = (server: FakeHermes) => server.requests.filter((r) => r.method === "session.interrupt").map((r) => r.params);
  const until = async (ok: () => boolean) => {
    while (!ok()) await new Promise((r) => setTimeout(r, 2));
  };

  it("interrupts the reply and takes the screen, so the next turn's first call is refused until Hand back", async () => {
    const { server, hermes, id, chat, rid } = await started();
    const { turn, next } = paused(server, rid);
    await until(() => chat().items.some((i) => i.kind === "tool"));
    await hermes.stop(id);
    expect(interrupts(server)).toEqual([{ session_id: rid }]);
    expect(screenAsks(server)).toEqual([
      ["display.observe", { profile: "default" }],
      ["display.lease.acquire", { profile: "default", viewer_id: "viewer-1", reason: "Stopped from Highwing" }],
    ]);
    next();
    await turn;
    expect(foldRuns(chat().items).find((b): b is CuRun => b.kind === "cu-run")).toMatchObject({ steps: 1, state: "stopped" });
    expect(server.display!.lease.holder).toBe("human");
    expect(hermes.getSnapshot().screen?.holder.kind).toBe("you");
    expect(chat().items.some((i) => i.kind === "error")).toBe(false);

    await hermes.send(id, "Carry on");
    await server.computerUseTurn(rid, { steps: [CU.click([10, 20])], reply: "You have the screen." });
    expect(chat().items.some((i) => i.kind === "approval")).toBe(false);
    expect(screenUse(chat())?.refused).toBe(HUMAN_HAS_CONTROL);

    await hermes.screen.handBack();
    expect(server.display!.lease.holder).toBe("agent");
    expect(hermes.getSnapshot().screen?.holder).toEqual({ kind: "agent" });
  });

  it("times a call the Stop cut short until the reply ended, so the run's time is its whole span", async () => {
    const { server, hermes, id, chat, rid } = await started();
    const turn = server.computerUseTurn(rid, { steps: [CU.capture(), CU.click([10, 20])], reply: "never" });
    await until(() => chat().items.some((i) => i.kind === "approval"));
    await new Promise((r) => setTimeout(r, 30));
    await hermes.stop(id);
    await turn;
    const run = foldRuns(chat().items).find((b): b is CuRun => b.kind === "cu-run")!;
    expect(run.lines.map((l) => l.kind === "step" && l.step.outcome.kind)).toEqual(["done", "stopped"]);
    expect(run.span.to! - run.span.from!).toBeGreaterThanOrEqual(30);
  });

  it("takes no screen when the reply used no computer_use", async () => {
    const { server, hermes, id, rid } = await started();
    server.event(rid, "message.start");
    server.event(rid, "tool.start", { tool_id: "t1", name: "terminal", preview: "du -sh /srv" });
    await hermes.stop(id);
    expect(interrupts(server)).toEqual([{ session_id: rid }]);
    expect(screenAsks(server)).toEqual([]);
    expect(server.display!.lease.holder).toBe("agent");
  });

  it("judges a turn Hermes started by its own calls, not the computer use of the turn before it", async () => {
    const { server, hermes, id, chat, rid } = await started();
    await server.computerUseTurn(rid, { steps: [CU.capture()], reply: "Tidied." });
    server.event(rid, "message.start");
    server.event(rid, "tool.start", { tool_id: "t1", name: "terminal", preview: "du -sh /srv" });
    await until(() => chat().items.some((i) => i.kind === "tool" && i.name === "terminal"));
    expect(screenUse(chat())).toBeUndefined();
    expect(await hermes.stopScreen()).toEqual({ stopped: [], hold: { kind: "held" } });
    expect(interrupts(server)).toEqual([]);
    await hermes.screen.handBack();
    const asked = screenAsks(server).length;
    await hermes.stop(id);
    expect(interrupts(server)).toEqual([{ session_id: rid }]);
    expect(screenAsks(server)).toHaveLength(asked);
    expect(server.display!.lease.holder).toBe("agent");
  });

  it("counts only its own steps in a turn Hermes started that uses the screen, for follow mode and Stop", async () => {
    const { server, chat, rid } = await started();
    await server.computerUseTurn(rid, { steps: [CU.capture()], reply: "Tidied." });
    const first = screenUse(chat())!.key;
    void server.computerUseTurn(rid, { steps: [CU.capture(), CU.capture()], reply: "never" }, () => new Promise(() => {}));
    await until(() => !!chat().running && chat().items.filter((i) => i.kind === "tool").length === 2);
    expect(screenUse(chat())).toMatchObject({ running: true, steps: 1 });
    expect(screenUse(chat())!.key).not.toBe(first);
  });

  it("sends the interrupt without waiting for the screen, and says why the screen couldn't be taken", async () => {
    const { server, hermes, id, chat, rid } = await started();
    const { turn, next } = paused(server, rid);
    await until(() => chat().items.some((i) => i.kind === "tool"));
    const observe = server.handlers["display.observe"];
    let answer!: () => void;
    server.handlers["display.observe"] = (r) => void (answer = () => observe(r));
    server.handlers["display.lease.acquire"] = (r) => server.fail(r.id, 5300, "the screen is busy");
    const stopping = hermes.stop(id);
    await until(() => interrupts(server).length > 0);
    answer();
    await stopping;
    next();
    await turn;
    expect(chat().items.filter((i) => i.kind === "error").map((i) => i.kind === "error" && i.text)).toEqual([
      "Stopped the reply, but couldn't take the Bot Desktop: the screen is busy",
    ]);
    expect(chat().running).toBe(false);
  });

  it("the panic Stop stops every reply using the screen, leaves the others, and takes the screen once", async () => {
    const { server, hermes, id, chat, rid } = await started();
    const other = await hermes.newChat();
    await hermes.send(other, "Count the logs");
    const otherRid = server.runtimeIdOf(other)!;
    server.event(otherRid, "message.start");
    const { turn, next } = paused(server, rid);
    await until(() => chat().items.some((i) => i.kind === "tool"));

    expect(await hermes.stopScreen()).toEqual({ stopped: [id], hold: { kind: "held" } });
    expect(interrupts(server)).toEqual([{ session_id: rid }]);
    expect(chat(other).running).toBe(true);
    expect(await hermes.stopScreen()).toEqual({ stopped: [], hold: { kind: "already" } });
    expect(screenAsks(server).map(([m]) => m)).toEqual(["display.observe", "display.lease.acquire"]);
    next();
    await turn;
    expect(server.display!.lease.holder).toBe("human");
  });

  it("takes no screen when Send now stops the reply to send a queued message", async () => {
    const { server, hermes, id, chat, rid } = await started();
    const { turn, next } = paused(server, rid);
    await until(() => chat().items.some((i) => i.kind === "tool"));
    expect(hermes.enqueue(id, "Open the browser instead")).toBeUndefined();
    await hermes.sendQueuedNow(id, hermes.getSnapshot().queues[id].items[0].id, "the agent is busy");
    await until(() => interrupts(server).length > 0);
    next();
    await turn;
    expect(interrupts(server)).toEqual([{ session_id: rid }]);
    expect(screenAsks(server)).toEqual([]);
    expect(server.display!.lease.holder).toBe("agent");
  });

  it("shares one hold between overlapping Stops, so a Hand back after the first isn't undone", async () => {
    const { server, hermes } = await started();
    const acquire = server.handlers["display.lease.acquire"];
    const waiting: (() => void)[] = [];
    server.handlers["display.lease.acquire"] = (r) => void waiting.push(() => acquire(r));
    const first = hermes.stopScreen();
    const second = hermes.stopScreen();
    await until(() => waiting.length > 0);
    await new Promise((r) => setTimeout(r, 20));
    waiting.shift()!();
    expect(await first).toEqual({ stopped: [], hold: { kind: "held" } });
    await hermes.screen.handBack();
    waiting.splice(0).forEach((answer) => answer());
    expect(await second).toEqual({ stopped: [], hold: { kind: "held" } });
    expect(server.display!.lease.holder).toBe("agent");
    expect(screenAsks(server).map(([m]) => m)).toEqual(["display.observe", "display.lease.acquire"]);
  });

  it("the panic Stop takes the screen with no reply running, and says when there is no screen to take", async () => {
    const { server, hermes } = await started();
    expect(await hermes.stopScreen()).toEqual({ stopped: [], hold: { kind: "held" } });
    expect(server.display!.lease.holder).toBe("human");

    const bare = await started(false);
    expect(await bare.hermes.stopScreen()).toEqual({ stopped: [], hold: { kind: "no-screen", why: "This Hermes has no Bot Desktop." } });
  });
});
