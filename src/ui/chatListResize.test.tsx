// @vitest-environment jsdom
// Dragging the chat list's right edge makes it narrower or wider, never hidden; the width is kept (ADR 0199).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { UI_PREFS_KEY, getUIPrefs } from "../hermes/uiPrefs";
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
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("resizing");
});

const list = () => document.querySelector<HTMLElement>(".sidebar");
const edge = () => screen.getByRole("separator", { name: "Resize the chat list" });

/**
 * A window with `room` px beside the rail: the chat's area measures what the list leaves of it, and is measured again
 * on `relayout`, as a browser does after the list's width changes.
 */
const relayouts = new Set<() => void>();
const windowRoom = (room: number) =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: ResizeObserverCallback) {}
      measure = () => this.cb([{ contentRect: { width: room - (list() ? parseFloat(list()!.style.width) : 0) } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      observe() {
        relayouts.add(this.measure);
        this.measure();
      }
      disconnect() {
        relayouts.delete(this.measure);
      }
    },
  );
const relayout = () => act(() => relayouts.forEach((m) => m()));

async function signedIn() {
  const server = new FakeHermes();
  server.sessions = [row("a", 1, { pinned: true, title: "A chat with a long title that a narrow list cuts short" })];
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "lena@hermes", url: "", username: "lena" }} onSignOut={async () => {}} />);
  await screen.findByRole("button", { name: /A chat with a long title/ });
  await act(async () => void (await hermes.idle()));
  return { user };
}
describe("Resizing the chat list", () => {
  it("follows a drag of its edge wider and narrower, stops at its bounds without hiding, and keeps the width on release", async () => {
    await signedIn();
    expect(list()!.style.width).toBe("272px");
    fireEvent.pointerDown(edge(), { button: 0, clientX: 328, pointerId: 1 });
    expect(document.documentElement.classList.contains("resizing")).toBe(true);
    fireEvent.pointerMove(edge(), { clientX: 400, pointerId: 1 });
    expect(list()!.style.width).toBe("344px");
    fireEvent.pointerMove(edge(), { clientX: 1400, pointerId: 1 });
    expect(list()!.style.width).toBe("560px");
    fireEvent.pointerMove(edge(), { clientX: -300, pointerId: 1 });
    expect(list()!.style.width).toBe("200px");
    expect(edge().getAttribute("aria-valuenow")).toBe("200");
    expect(getUIPrefs().sidebarWidth).toBeNull();
    fireEvent.pointerMove(edge(), { clientX: 300, pointerId: 1 });
    fireEvent.pointerUp(edge(), { clientX: 300, pointerId: 1 });
    expect(list()!.style.width).toBe("244px");
    expect(getUIPrefs().sidebarWidth).toBe(244);
    expect(document.documentElement.classList.contains("resizing")).toBe(false);
  });

  it("keeps the width it was dragged to when the pointer is let go outside the window or the drag is cancelled", async () => {
    await signedIn();
    fireEvent.pointerDown(edge(), { button: 0, clientX: 328, pointerId: 1 });
    fireEvent.pointerMove(edge(), { clientX: 380, pointerId: 1 });
    fireEvent(edge(), new Event("lostpointercapture", { bubbles: true }));
    expect(getUIPrefs().sidebarWidth).toBe(324);
    expect(document.documentElement.classList.contains("resizing")).toBe(false);
    // Moves after the drag ended change nothing.
    fireEvent.pointerMove(edge(), { clientX: 500, pointerId: 1 });
    expect(list()!.style.width).toBe("324px");

    fireEvent.pointerDown(edge(), { button: 0, clientX: 380, pointerId: 2 });
    fireEvent.pointerMove(edge(), { clientX: 360, pointerId: 2 });
    fireEvent.pointerCancel(edge(), { clientX: 0, pointerId: 2 });
    expect(getUIPrefs().sidebarWidth).toBe(304);
    expect(list()!.style.width).toBe("304px");
  });

  it("resizes from the keyboard: arrows by a step, Home to the narrowest, End to the widest", async () => {
    const { user } = await signedIn();
    edge().focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(list()!.style.width).toBe("336px");
    expect(getUIPrefs().sidebarWidth).toBe(336);
    await user.keyboard("{ArrowLeft}");
    expect(edge().getAttribute("aria-valuenow")).toBe("304");
    await user.keyboard("{Home}");
    expect(edge().getAttribute("aria-valuenow")).toBe("200");
    await user.keyboard("{End}");
    expect(edge().getAttribute("aria-valuenow")).toBe("560");
  });

  it("is hidden and shown only by Ctrl+B, which keeps a width dragged to when it hid mid-drag", async () => {
    const { user } = await signedIn();
    fireEvent.pointerDown(edge(), { button: 0, clientX: 328, pointerId: 1 });
    fireEvent.pointerMove(edge(), { clientX: 420, pointerId: 1 });
    await user.keyboard("{Control>}b{/Control}");
    expect(list()).toBeNull();
    expect(getUIPrefs().sidebarWidth).toBe(364);
    expect(document.documentElement.classList.contains("resizing")).toBe(false);
    await user.keyboard("{Control>}b{/Control}");
    expect(list()!.style.width).toBe("364px");
  });

  it("opens at the width kept, narrowed while the window leaves the chat too little room, and drops a width no window could have", async () => {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 5, sidebarWidth: 540 }));
    await signedIn();
    expect(list()!.style.width).toBe("540px");
    cleanup();

    // 972 px beside the rail: 532 px is the most the list can take and leave the chat 440.
    windowRoom(972);
    await signedIn();
    relayout();
    relayout();
    expect(list()!.style.width).toBe("532px");
    expect(edge().getAttribute("aria-valuemax")).toBe("532");
    expect(getUIPrefs().sidebarWidth).toBe(540);
    cleanup();

    vi.unstubAllGlobals();
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 5, sidebarWidth: -40 }));
    await signedIn();
    expect(list()!.style.width).toBe("272px");
  });
});
