// @vitest-environment jsdom
// A computer-use run as the owner sees it (ComputerUseCard.tsx, ADR 0213): recorded Hermes turns (ADR 0211) replayed
// through the real transport into the chat pane, one card per run with a line per action, Watch live, and the note
// above the composer when Hermes was refused because a person holds the screen.
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cuFixture, type CuFixture } from "../hermes/cuFixtures";
import { FakeHermes } from "../hermes/fakeHermes";
import type { ApprovalChoice, Chat, Item } from "../hermes/model";
import type { ScreenState } from "../hermes/screenControl";
import { ScreenshotDesk, type ScreenshotApi } from "../hermes/screenshots";
import { connect, type Hermes } from "../hermes/transport";
import { ChatPane } from "./ChatPane";
import { ScreenDeskProvider, type ScreenDesk } from "./ComputerUseCard";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

const noScreenshots: ScreenshotApi = { capture: () => Promise.reject(new Error("no screenshots in this test")), discard: async () => {} };
const running: Hermes[] = [];
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
});

/** A recorded turn replayed into a chat, the owner answering each Approval as the recorder did, up to `upTo`. */
async function replayed(name: CuFixture, upTo?: (f: { frame: Record<string, unknown> }) => boolean): Promise<Chat> {
  const server = new FakeHermes();
  server.display = { status: { supported: true, installed: true, missing: [], running: true }, lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 }, minted: new Set() };
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  const id = await hermes.newChat();
  await hermes.send(id, "Use your computer_use tool on your Bot Desktop");
  const chat = () => hermes.getSnapshot().chats.find((c) => c.id === id)!;
  const frames = cuFixture(name);
  const cut = upTo ? frames.findIndex(upTo) : frames.length;
  const choices = frames.flatMap(({ dir, frame }) => (dir === "out" && frame.method === "approval.respond" ? [(frame.params as { choice: ApprovalChoice }).choice] : []));
  const answering = (async () => {
    for (const choice of upTo ? [] : choices) {
      let ask: Item | undefined;
      while (!(ask = chat().items.find((i) => i.kind === "approval" && !i.answer && !i.ended))) await new Promise((r) => setTimeout(r, 2));
      await hermes.answerApproval(id, ask.id, choice, true);
    }
  })();
  const replaying = server.replay(server.runtimeIdOf(id)!, frames.slice(0, cut));
  if (!upTo) await Promise.all([replaying, answering]);
  else await waitFor(() => expect(chat().items.some((i) => i.kind === "approval" && !i.answer) || server.openRequests.size === 0).toBe(true));
  return chat();
}

function pane(chat: Chat, desk: ScreenDesk = {}, onAnswer: (id: string, c: ApprovalChoice, confirmed?: boolean) => void = () => {}) {
  const el = (d: ScreenDesk) => (
    <ScreenDeskProvider value={d}>
      <ChatPane
        chat={chat}
        status="connected"
        draft=""
        draftKey="draft"
        screenshots={new ScreenshotDesk(noScreenshots)}
        onDraft={() => {}}
        onDraftStep={() => undefined}
        onRetry={() => {}}
        onEdit={() => {}}
        onDismiss={() => {}}
        onAttach={async () => ({ attachments: [], refused: [] })}
        onSend={() => {}}
        onStop={() => {}}
        onAnswer={onAnswer}
        onQuestion={() => {}}
      />
    </ScreenDeskProvider>
  );
  const r = render(el(desk));
  return { desk: (d: ScreenDesk) => act(() => r.rerender(el(d))) };
}

const cards = () => Array.from(document.querySelectorAll<HTMLElement>(".cu-run"));
const lines = (card: HTMLElement) => Array.from(card.querySelectorAll<HTMLElement>(".cu-step:not(.tool) > .tool-line")).map((l) => l.textContent);
const holding = (holder: ScreenState["holder"]): ScreenState => ({ profileKey: "/home/lena/.hermes", holder, epoch: 1 });

describe("A computer-use run in the chat", () => {
  it("reads as one card with a line per action, each with its outcome, and the Approvals under the steps they gated", async () => {
    pane(await replayed("10-turn-approve"), { screen: holding({ kind: "agent" }) });
    expect(cards()).toHaveLength(1);
    expect(document.querySelector(".tools")).toBeNull();
    const [card] = cards();
    expect(within(card).getByRole("button", { name: /Computer use · 10 steps/ }).textContent).toContain("done");
    expect(lines(card)).toEqual([
      "1capturedesktop1280x800 · Xfdesktop · 1 element0.7s",
      "2capturescreen1280x800 · screen · 0 elements0.4s",
      "3click at (619, 777)desktopNo active window — call capture() first.0.1s",
      "4capturexfce4-panel88x44 · Xfce4-panel · 1 element0.5s",
      "5click at (22, 21)xfce4-panelClicked at (22.0, 21.0) × 1 (delivery_mode=background). · not confirmed0.6s",
      "6capture88x44 · Xfce4-panel · 1 element0.5s",
      "7capturescreen1280x800 · screen · 0 elements0.1s",
      "8capturexfce4-panel88x44 · Xfce4-panel · 1 element0.5s",
      "9click at (618, 777)xfce4-panelClicked at (618.0, 777.0) × 1 (delivery_mode=background). · not confirmed0.5s",
      "10capturescreen1280x800 · screen · 0 elements1.4s",
    ]);
    const asks = Array.from(card.querySelectorAll<HTMLElement>(".cu-step")).filter((s) => s.querySelector(".approval"));
    expect(asks.map((s) => s.querySelector(".cu-n")!.textContent)).toEqual(["3", "5"]);
    expect(asks.map((s) => s.querySelector(".approval-head")!.textContent)).toEqual(["Approved once", "Allowed for this chat"]);
    expect(asks[0].querySelector(".approval")!.textContent).toContain("computer_use: click at (619, 777)");
    expect(within(card).getByText("Hermes drives the screen")).toBeTruthy();
  });

  it("opens a step to show what Hermes was told, and never a screenshot", async () => {
    pane(await replayed("11-turn-foreground"));
    const [card] = cards();
    fireEvent.click(within(card).getByRole("button", { name: /type 'echo highwing-capture'/ }));
    const step = within(card).getByRole("button", { name: /type 'echo highwing-capture'/ }).closest("li")!;
    expect(step.querySelector(".cu-tag")!.textContent).toBe("foreground");
    expect(step.textContent).toContain("Hermes's advice");
    expect(step.textContent).toContain('"text": "echo highwing-capture"');
    expect(step.textContent).not.toMatch(/base64|image_url/);
  });

  it("opens the Screen from Watch live", async () => {
    const onWatch = vi.fn();
    pane(await replayed("12-turn-deny"), { onWatch });
    const [card] = cards();
    expect(lines(card)[1]).toBe("2double_click at (640, 400)desktopforegrounddenied0.1s");
    fireEvent.click(within(card).getByRole("button", { name: "Watch live" }));
    expect(onWatch).toHaveBeenCalledOnce();
  });

  it("says a run is working, with the Approval it waits on answerable in place", async () => {
    const onAnswer = vi.fn();
    const chat = await replayed("10-turn-approve", (f) => f.frame.method === "approval.respond");
    pane(chat, {}, onAnswer);
    const [card] = cards();
    expect(within(card).getByRole("button", { name: /Computer use · 3 steps/ }).textContent).toContain("waiting for your approval");
    expect(card.querySelector(".cu-step.latest .cu-n")!.textContent).toBe("3");
    expect(card.querySelector(".approval-head")!.textContent).toBe("Hermes wants to click at (619, 777)");
    fireEvent.click(within(card).getByRole("button", { name: "Approve once" }));
    expect(onAnswer).toHaveBeenCalledWith(chat.items.find((i) => i.kind === "approval")!.id, "once", undefined);
  });

  it("reads a stopped run as stopped", async () => {
    pane(await replayed("14-turn-interrupt"));
    expect(within(cards()[0]).getByRole("button", { name: /Computer use · 2 steps/ }).textContent).toContain("stopped");
    expect(lines(cards()[0])[1]).toBe("2wait 2swaited 2.00s · not confirmed2s");
  });
});

describe("The note when a person holds the screen", () => {
  const refusedTurn = () => replayed("13-turn-takeover", (f) => f.frame.method === "display.lease.release");

  it("says who holds it, offers the owner Hand back, and goes once Hermes has it again", async () => {
    const onHandBack = vi.fn(async () => {});
    const chat = await refusedTurn();
    const { desk } = pane(chat, { screen: holding({ kind: "you", since: 1 }), onHandBack });
    expect(lines(cards()[0])[1]).toBe("2scroll down x3desktopforegroundrefused: a person holds the screen0.1s");
    const note = document.querySelector<HTMLElement>(".cu-banner")!;
    expect(note.textContent).toContain("Hermes's computer use was refused because you hold the Bot Desktop.");
    fireEvent.click(within(note).getByRole("button", { name: "Hand back" }));
    await waitFor(() => expect(onHandBack).toHaveBeenCalledOnce());

    desk({ screen: holding({ kind: "someone", since: 1 }), onWatch: () => {} });
    expect(document.querySelector(".cu-banner")!.textContent).toContain("someone else holds the Bot Desktop");
    expect(within(document.querySelector<HTMLElement>(".cu-banner")!).queryByRole("button", { name: "Hand back" })).toBeNull();
    expect(within(document.querySelector<HTMLElement>(".cu-banner")!).getByRole("button", { name: "Open the Screen" })).toBeTruthy();

    desk({ screen: holding({ kind: "agent" }) });
    expect(document.querySelector(".cu-banner")).toBeNull();
  });

  it("shows nothing when the last step went through", async () => {
    pane(await replayed("10-turn-approve"), { screen: holding({ kind: "someone", since: 1 }) });
    expect(document.querySelector(".cu-banner")).toBeNull();
  });
});
