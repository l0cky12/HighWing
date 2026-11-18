// @vitest-environment jsdom
// Every recorded computer_use turn (src/hermes/fixtures/computer-use, ADR 0211) through the real transport and the Saved
// copy this computer keeps (chatCache.ts): no screenshot is ever kept, and a chat read back shows the same run.
import { afterEach, describe, expect, it } from "vitest";
import { localChatCache } from "./chatCache";
import { foldRuns, screenUse, type CuRun } from "./computerUse";
import { CU_TURNS, cuFixture, type CuFixture } from "./cuFixtures";
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
