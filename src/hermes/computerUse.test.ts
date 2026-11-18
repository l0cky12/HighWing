// Hermes's computer_use as the transcript reads it (computerUse.ts, ADR 0213), against frames recorded from a real
// Hermes (src/hermes/fixtures/computer-use, ADR 0211).
import { describe, expect, it } from "vitest";
import { KEPT_CAPTURE_CHARS, foldRuns, keptResult, screenUse, stepOf, type CuRun } from "./computerUse";
import { cuEvents, cuFixture, type CuFixture } from "./cuFixtures";
import { FakeHermes, row } from "./fakeHermes";
import type { Item } from "./model";
import { toolResultText } from "./toolResult";
import { connect } from "./transport";

const results = (name: Parameters<typeof cuEvents>[0]) => cuEvents(name, "tool.complete").map((p) => p.result as Record<string, unknown>);

describe("What the chat keeps of a computer_use result", () => {
  it("keeps a capture's words and size, and none of its screenshot", () => {
    const capture = results("10-turn-approve")[0];
    const kept = keptResult(capture) as Record<string, unknown>;
    expect(kept.content).toEqual([{ type: "text", text: expect.stringMatching(/^capture mode=som 1280x800 app=Xfdesktop\n1 interactable element/) }]);
    expect(kept).not.toHaveProperty("text_summary");
    expect(kept.meta).toEqual({ mode: "som", width: 1280, height: 800, elements: 1 });
    expect(JSON.stringify(kept)).not.toMatch(/base64|image_url|png_bytes/);
  });

  it("keeps an input action's own answer, and what Hermes advised next", () => {
    const click = results("11-turn-foreground")[1];
    expect(keptResult(click)).toEqual(click);
    const typed = keptResult(results("11-turn-foreground")[4]) as { content: { text: string }[]; action_result: unknown };
    expect(JSON.parse(typed.content[0].text.split("\n\ncapture ")[0])).toMatchObject({ ok: true, action: "type_text" });
    expect(typed.action_result).toMatchObject({ ok: true, action: "type_text", verdict: { decision: "verify_fresh_state" } });
  });

  it("cuts a long element list, so a long run's Saved copy stays small", () => {
    const capture = results("10-turn-approve")[0] as { content: { type: string; text?: string }[] };
    const long = { ...capture, content: [{ type: "text", text: `capture mode=som 1280x800 app=Firefox\n${"  #1 button 'Reload' @ (10, 10)\n".repeat(400)}` }, capture.content[1]] };
    const text = (keptResult(long) as { content: { text: string }[] }).content[0].text;
    expect(text.length).toBeLessThanOrEqual(KEPT_CAPTURE_CHARS + 1);
    expect(text.startsWith("capture mode=som 1280x800 app=Firefox\n")).toBe(true);
  });

  it("leaves every other tool's result as it came", () => {
    expect(toolResultText({ content: [{ type: "image_url" }], text_summary: "kept" }, "vision_analyze")).toContain("text_summary");
    expect(toolResultText(results("12-turn-deny")[1], "computer_use")).toContain("BLOCKED: Action denied by user.");
    expect(toolResultText(results("10-turn-approve")[0], "computer_use")).not.toContain("text_summary");
  });
});

/**
 * A recorded turn replayed into a new chat through the real transport, the owner answering each Approval as the
 * recorder did. `upTo`: replay only the frames before the first one this finds.
 */
async function replayed(name: CuFixture, upTo?: (f: { frame: Record<string, unknown> }) => boolean) {
  const server = new FakeHermes();
  server.display = { status: { supported: true, installed: true, missing: [], running: true }, lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 }, minted: new Set() };
  const hermes = await connect(server.openPipe);
  const id = await hermes.newChat();
  await hermes.send(id, "Use your computer_use tool on your Bot Desktop");
  const frames = cuFixture(name);
  const cut = upTo ? frames.findIndex(upTo) : -1;
  const chat = () => hermes.getSnapshot().chats.find((c) => c.id === id)!;
  const choices = frames.flatMap(({ dir, frame }) => (dir === "out" && frame.method === "approval.respond" ? [(frame.params as { choice: "once" | "session" | "always" | "deny" }).choice] : []));
  const answering = (async () => {
    for (const choice of choices) {
      let ask: Item | undefined;
      while (!(ask = chat().items.find((i) => i.kind === "approval" && !i.answer && !i.ended))) await new Promise((r) => setTimeout(r, 2));
      await hermes.answerApproval(id, ask.id, choice, true);
    }
  })();
  await server.replay(server.runtimeIdOf(id)!, cut < 0 ? frames : frames.slice(0, cut));
  if (cut < 0) await answering;
  return { server, hermes, id, chat, items: () => chat().items };
}

const runs = (items: readonly Item[]) => foldRuns(items).filter((b): b is CuRun => b.kind === "cu-run");
const steps = (run: CuRun) => run.lines.flatMap((l) => (l.kind === "step" ? [l.step] : []));
const lines = (run: CuRun) => steps(run).map((s) => [s.n, s.action.line, s.outcome.kind]);

describe("A computer-use run in the transcript", () => {
  it("reads a turn of captures and background clicks as one run, a line per call, with the Approvals under their steps", async () => {
    const { items } = await replayed("10-turn-approve");
    const [run, ...more] = runs(items());
    expect(more).toEqual([]);
    expect(run).toMatchObject({ steps: 10, state: "done" });
    expect(lines(run)).toEqual([
      [1, "capture", "done"],
      [2, "capture", "done"],
      [3, "click at (619, 777)", "failed"],
      [4, "capture", "done"],
      [5, "click at (22, 21)", "done"],
      [6, "capture", "done"],
      [7, "capture", "done"],
      [8, "capture", "done"],
      [9, "click at (618, 777)", "done"],
      [10, "capture", "done"],
    ]);
    const [first, , click, panel, clicked] = steps(run);
    expect(first.action).toEqual({ verb: "capture", line: "capture", app: "desktop", delivery: "background" });
    expect(first.outcome).toEqual({ kind: "done", capture: { app: "Xfdesktop", size: "1280x800", elements: 1 } });
    expect(click.outcome).toEqual({ kind: "failed", why: "No active window — call capture() first.", hint: expect.stringMatching(/^The input likely did not land/) });
    expect(panel.action.app).toBe("xfce4-panel");
    // A click with capture_after answers as the capture does, with the click's own answer as its text.
    expect(clicked.outcome).toMatchObject({ kind: "done", note: "Clicked at (22.0, 21.0) × 1 (delivery_mode=background)." });
    const asks = run.lines.flatMap((l) => (l.kind === "step" && l.asks.length ? [[l.step.n, l.asks.map((a) => a.answer)]] : []));
    expect(asks).toEqual([
      [3, ["once"]],
      [5, ["session"]],
    ]);
    expect(run.span.from).toBe(steps(run)[0].at);
    expect(run.span.to).toBeGreaterThanOrEqual(run.span.from!);
  });

  it("names each foreground action as Hermes's own Approval does", async () => {
    const { items } = await replayed("11-turn-foreground");
    const [run] = runs(items());
    expect(lines(run)).toEqual([
      [1, "capture", "done"],
      [2, "click at (618, 777)", "done"],
      [3, "capture", "done"],
      [4, "capture", "done"],
      [5, "type 'echo highwing-capture'", "done"],
      [6, "key 'return'", "done"],
      [7, "key 'ctrl+l'", "done"],
      [8, "capture", "done"],
    ]);
    const [, click, , , typed, enter] = steps(run);
    expect(click.action).toMatchObject({ verb: "click", delivery: "foreground", app: "desktop" });
    expect(click.outcome).toMatchObject({ kind: "done", verdict: "verify", hint: expect.stringMatching(/^Input was delivered but not confirmed/) });
    expect(typed.outcome).toMatchObject({ kind: "done", note: "Typed 21 character(s) (terminal emulator: pty/XTest key events).", verdict: "verify" });
    expect(enter.outcome).toMatchObject({ kind: "done", note: "Pressed key 'return' (delivery_mode=foreground)." });
  });

  it("says a step the owner denied was denied", async () => {
    const { items } = await replayed("12-turn-deny");
    const [run] = runs(items());
    expect(lines(run)).toEqual([
      [1, "capture", "done"],
      [2, "double_click at (640, 400)", "denied"],
    ]);
    expect(run.state).toBe("done");
  });

  it("says a step was refused while a person held the screen, with Hermes's words", async () => {
    const { items } = await replayed("13-turn-takeover");
    const [run] = runs(items());
    expect(lines(run)).toEqual([
      [1, "capture", "done"],
      [2, "scroll down x3", "refused"],
    ]);
    expect(steps(run)[1].outcome).toEqual({ kind: "refused", why: expect.stringMatching(/^A human has taken over this desktop/) });
    expect(run.state).toBe("refused");
  });

  it("says the run was stopped when the owner stopped the reply", async () => {
    const { items } = await replayed("14-turn-interrupt");
    const [run] = runs(items());
    expect(lines(run)).toEqual([
      [1, "capture", "done"],
      [2, "wait 2s", "done"],
    ]);
    expect(steps(run)[1].outcome).toMatchObject({ note: "waited 2.00s" });
    expect(run.state).toBe("stopped");
  });

  it("reads a reopened chat's stored calls as the same steps, never guessing how they came out", async () => {
    const resumed = cuFixture("15-resume-history").find((f) => (f.frame.result as { messages?: unknown } | undefined)?.messages)!;
    const server = new FakeHermes();
    server.sessions = [row("cu", 1)];
    server.transcripts = { cu: (resumed.frame.result as { messages: never[] }).messages };
    const hermes = await connect(server.openPipe);
    await hermes.sync();
    await hermes.open("cu");
    const stored = hermes.getSnapshot().chats.find((c) => c.id === "cu")!.items;
    const live = (await replayed("10-turn-approve")).items();
    const [run] = runs(stored);
    expect(foldRuns(stored).map((b) => b.kind)).toEqual(["user", "tool", "tool", "cu-run", "assistant"]);
    expect(steps(run).map((s) => s.action)).toEqual(steps(runs(live)[0]).map((s) => s.action));
    expect(new Set(steps(run).map((s) => s.outcome.kind))).toEqual(new Set(["unrecorded"]));
    expect(steps(run)[0].at).toBe(1795016821474.639);
  });

  it("is still running while a call runs, and asking while an Approval waits", async () => {
    const { items } = await replayed("10-turn-approve", (f) => f.frame.method === "approval");
    expect(runs(items())[0]).toMatchObject({ state: "acting", steps: 3 });
    expect(steps(runs(items())[0])[2].outcome).toEqual({ kind: "pending" });
  });
});

describe("Which items make one run", () => {
  const cu = (id: string, args: Record<string, unknown>, more: Partial<Extract<Item, { kind: "tool" }>> = {}): Item => ({
    kind: "tool",
    id,
    name: "computer_use",
    args,
    status: "done",
    result: JSON.stringify({ ok: true, action: args.action, message: "ok" }),
    ...more,
  });
  const capture = (id: string) => cu(id, { action: "capture" });

  it("takes in the reasoning and other tools between two calls, and leaves out what comes after the last", () => {
    const items: Item[] = [
      { kind: "user", id: "u", text: "go" },
      capture("c1"),
      { kind: "thinking", id: "r1", text: "The panel is at the bottom." },
      { kind: "tool", id: "v1", name: "vision_analyze", status: "done" },
      cu("c2", { action: "click", coordinate: [5, 6] }),
      { kind: "thinking", id: "r2", text: "Done." },
      { kind: "tool", id: "t1", name: "terminal", status: "done" },
      { kind: "assistant", id: "a", text: "Clicked it." },
    ];
    const blocks = foldRuns(items);
    expect(blocks.map((b) => b.id)).toEqual(["u", "cu-c1", "r2", "t1", "a"]);
    const run = blocks[1] as CuRun;
    expect(run.items.map((i) => i.id)).toEqual(["c1", "r1", "v1", "c2"]);
    expect(run.lines.map((l) => (l.kind === "step" ? l.step.id : l.tool.id))).toEqual(["c1", "v1", "c2"]);
    expect(steps(run)[1]).toMatchObject({ n: 2, thought: "The panel is at the bottom." });
  });

  it("ends a run at assistant text or a message, and keeps counting the turn's steps across the split", () => {
    const items: Item[] = [
      { kind: "user", id: "u1", text: "go" },
      capture("c1"),
      { kind: "assistant", id: "a1", text: "Found the terminal." },
      capture("c2"),
      cu("c3", { action: "key", keys: "return" }),
      { kind: "user", id: "s", text: "and close it", steer: true },
      capture("c4"),
      { kind: "user", id: "u2", text: "again" },
      capture("c5"),
    ];
    const found = runs(items);
    expect(found.map((r) => r.id)).toEqual(["cu-c1", "cu-c2", "cu-c4", "cu-c5"]);
    expect(found.map((r) => steps(r).map((s) => s.n))).toEqual([[1], [2, 3], [4], [1]]);
  });

  it("leaves every other tool call as it was", () => {
    const items: Item[] = [
      { kind: "user", id: "u", text: "go" },
      { kind: "tool", id: "t1", name: "terminal", status: "done" },
    ];
    expect(foldRuns(items)).toEqual(items);
    expect(stepOf(items[1] as Extract<Item, { kind: "tool" }>, 1)).toBeUndefined();
  });

  it("words each action as Hermes's Approval names it", () => {
    const line = (args: Record<string, unknown>) => stepOf(cu("x", args) as Extract<Item, { kind: "tool" }>, 1)!.action.line;
    expect(line({ action: "capture", mode: "som" })).toBe("capture");
    expect(line({ action: "click", coordinate: [619, 777] })).toBe("click at (619, 777)");
    expect(line({ action: "double_click", coordinate: [640, 400] })).toBe("double_click at (640, 400)");
    expect(line({ action: "click", element: 4 })).toBe("click element #4");
    expect(line({ action: "type", text: "echo highwing-capture" })).toBe("type 'echo highwing-capture'");
    expect(line({ action: "key", keys: "return" })).toBe("key 'return'");
    expect(line({ action: "scroll", direction: "down", amount: 3 })).toBe("scroll down x3");
    expect(line({ action: "wait", seconds: 2 })).toBe("wait 2s");
    expect(line({ action: "list_apps" })).toBe("list_apps");
  });
});

describe("The last turn's use of the screen", () => {
  it("says whether it runs, how far it got, and Hermes's refusal when its last step got one", async () => {
    const { chat } = await replayed("13-turn-takeover");
    expect(screenUse(chat())).toMatchObject({ running: false, steps: 2, refused: expect.stringMatching(/^A human has taken over/) });
    const live = await replayed("10-turn-approve", (f) => f.frame.method === "approval");
    const use = screenUse(live.chat())!;
    expect(use).toMatchObject({ running: true, steps: 3, key: runs(live.items())[0].id });
    expect(use.since).toBe(steps(runs(live.items())[0])[0].at);
    expect(screenUse({ items: [{ kind: "user", id: "u", text: "hi" }], running: true })).toBeUndefined();
  });

  it("forgets a refusal once a later step went through", () => {
    const refused: Item = { kind: "tool", id: "c1", name: "computer_use", args: { action: "scroll" }, status: "done", result: JSON.stringify({ ok: false, code: "human_has_control", error: "A human has taken over" }) };
    const after: Item = { kind: "tool", id: "c2", name: "computer_use", args: { action: "capture" }, status: "done", result: JSON.stringify({ ok: true }) };
    expect(screenUse({ items: [refused, after] })?.refused).toBeUndefined();
  });
});
