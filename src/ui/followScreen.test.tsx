// @vitest-environment jsdom
// Follow mode (ADR 0213): with it on, the side panel's Screen opens once for each computer-use run that starts in the
// chat on screen; off, it opens only from a run's Watch live.
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { setUIPrefs } from "../hermes/uiPrefs";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const connection = { mode: "ssh" as const, sshTarget: "lena@hermes", url: "", username: "lena" };
const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));
const screenTab = () => document.getElementById("panel-tab-screen");

async function deskChat() {
  const server = new FakeHermes();
  server.display = { status: { supported: true, installed: true, missing: [], running: false }, lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 }, minted: new Set() };
  server.sessions = [row("desk", 1, { pinned: true, title: "Tidy the desktop" })];
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={connection} onSignOut={async () => {}} />);
  await user.click(await screen.findByRole("button", { name: /Tidy the desktop/ }));
  await settle(hermes);
  const rid = server.runtimeIdOf("desk")!;
  const say = async (type: string, payload: Record<string, unknown> = {}) => {
    act(() => server.event(rid, type, payload));
    await settle(hermes);
  };
  const call = (id: string) => say("tool.start", { tool_id: id, name: "computer_use", context: "", args: { action: "capture", mode: "som" } });
  return { user, say, call };
}

describe("Follow mode", () => {
  it("opens the Screen once for each run that starts in the chat on screen", async () => {
    setUIPrefs({ followScreen: true });
    const { user, say, call } = await deskChat();
    await say("message.start");
    expect(screenTab()).toBeNull();
    await call("c1");
    expect(screenTab()?.getAttribute("aria-selected")).toBe("true");

    await user.click(document.getElementById("panel-tab-files")!);
    await say("tool.complete", { tool_id: "c1", name: "computer_use", duration_s: 0.5, result: { ok: true } });
    await call("c2");
    expect(screenTab()?.getAttribute("aria-selected")).toBe("false");

    await say("message.delta", { text: "The desktop is empty, so I'll open the file manager." });
    await call("c3");
    expect(screenTab()?.getAttribute("aria-selected")).toBe("true");
  });

  it("leaves the panel alone while it is off", async () => {
    setUIPrefs({ followScreen: false });
    const { say, call } = await deskChat();
    await say("message.start");
    await call("c1");
    expect(screenTab()).toBeNull();
  });
});
