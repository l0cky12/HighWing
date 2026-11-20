// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, Item } from "../hermes/model";
import { ChatPane } from "./ChatPane";
import { AttachmentDesk } from "../hermes/attachmentDesk";
import { setUIPrefs } from "../hermes/uiPrefs";
import { resetAll } from "./keybindings";
import type { AskHost } from "./AskCard";


vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

let VIEW = 600;
let width = 800;
let content = 5000;

const observers = new Set<{ run: () => void }>();
const runResizeObservers = () => act(() => observers.forEach((o) => o.run()));
const realObserver = globalThis.ResizeObserver;
// As in a browser, a scroller whose view moved gets one scroll event, at the next frame.
const moved = new Set<HTMLElement>();
const frame = () => {
  const els = [...moved];
  moved.clear();
  els.forEach((el) => fireEvent.scroll(el));
};

beforeAll(() => {
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
  const scrollTops = new WeakMap<Element, number>();
  const isScroller = (el: Element) => el.classList.contains("transcript");
  Object.defineProperties(HTMLElement.prototype, {
    clientHeight: { configurable: true, get(this: HTMLElement) { return isScroller(this) ? VIEW : 0; } },
    clientWidth: { configurable: true, get(this: HTMLElement) { return isScroller(this) ? width : 0; } },
    scrollHeight: { configurable: true, get(this: HTMLElement) { return isScroller(this) ? content : 0; } },
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) { return scrollTops.get(this) ?? 0; },
      set(this: HTMLElement, y: number) {
        const top = Math.max(0, Math.min(y, content - VIEW));
        if (top === (scrollTops.get(this) ?? 0)) return;
        scrollTops.set(this, top);
        moved.add(this);
      },
    },
  });
  globalThis.ResizeObserver = class {
    private entry: { run: () => void };
    constructor(cb: ResizeObserverCallback) {
      this.entry = { run: () => cb([], this as unknown as ResizeObserver) };
    }
    observe() { observers.add(this.entry); }
    unobserve() {}
    disconnect() { observers.delete(this.entry); }
  } as unknown as typeof ResizeObserver;
});
afterAll(() => {
  globalThis.ResizeObserver = realObserver;
});
beforeEach(() => {
  moved.clear();
  VIEW = 600;
  width = 800;
  content = 5000;
});
afterEach(() => {
  cleanup();
  resetAll();
});

function chat(turns: number, running = true): Chat {
  const items: Item[] = [];
  for (let t = 0; t < turns; t++)
    items.push({ kind: "user", id: `u-${t}`, text: `Question ${t}`, rowId: 2 * t }, { kind: "assistant", id: `a-${t}`, text: `Answer ${t}`, rowId: 2 * t + 1 });
  return { id: "c", runtimeId: "rt", title: "Logs", source: "app", settled: false, updatedAt: 0, items, running };
}

function pane(turns: number, { running = true } = {}) {
  const view = (turns: number, shown = chat(turns, running), ask?: AskHost) => (
    <ChatPane
      chat={shown}
      ask={ask}
      status="connected"
      draft=""
      draftKey="draft"
      desk={new AttachmentDesk({ discard: async () => {} })}
      onDraft={() => {}}
      onDraftStep={() => undefined}
      onRetry={() => {}}
      onEdit={() => {}}
      onDismiss={() => {}}
      onAttach={async () => ({ attachments: [], refused: [] })}
      onSend={() => {}}
      onStop={() => {}}
      onAnswer={() => {}}
      onQuestion={() => {}}
    />
  );
  const { rerender } = render(view(turns));
  runResizeObservers();
  const scroller = document.querySelector<HTMLElement>(".transcript")!;
  frame();
  return {
    scroller,
    /** Shows `next` as the chat, at the same height. */
    show: (next: Chat, ask?: AskHost) => rerender(view(turns, next, ask)),
    frame,
    fromBottom: () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
    grow: (px: number) => {
      content += px;
      rerender(view(++turns));
      runResizeObservers();
    },
  };
}

it("stays at the bottom, following the reply, when the browser moves the view as the pane widens", () => {
  const { scroller, fromBottom, grow } = pane(10);
  expect(fromBottom()).toBe(0);

  // WebKitGTK rewraps the wider pane and leaves the view 497 px above the bottom. Its scroll event comes before the
  // ResizeObserver runs for the new size, and no input from the owner caused it.
  width = 1200;
  content = 4200;
  scroller.scrollTop = content - VIEW - 497;
  fireEvent.scroll(scroller);
  runResizeObservers();
  expect(fromBottom()).toBe(0);

  grow(300);
  expect(fromBottom()).toBe(0);
});

it("stops following when the owner scrolls up, and follows again once they are back at the bottom", () => {
  const { scroller, fromBottom, grow } = pane(10);

  scroller.scrollTop = content - VIEW - 500;
  fireEvent.scroll(scroller);
  grow(300);
  expect(fromBottom()).toBe(800);

  scroller.scrollTop = content;
  fireEvent.scroll(scroller);
  grow(300);
  expect(fromBottom()).toBe(0);
});

it("stays where the owner scrolled to when the pane is resized after", () => {
  const { scroller, fromBottom } = pane(10);

  scroller.scrollTop = content - VIEW - 500;
  fireEvent.scroll(scroller);
  width = 1200;
  content = 4200;
  scroller.scrollTop = content - VIEW - 497;
  fireEvent.scroll(scroller);
  runResizeObservers();
  expect(fromBottom()).toBe(497);
});

it("stops following when the owner turns the wheel up while a reply streams, though each scroll lands within 40 px of the bottom", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);

  // WebKit's smooth scroll moves the view a few pixels a frame, and the reply grows between frames (#544).
  fireEvent.wheel(scroller, { deltaY: -87 });
  for (const step of [3, 1, 32, 20]) {
    scroller.scrollTop -= step;
    frame();
    grow(5);
  }
  expect(fromBottom()).toBe(76);

  grow(300);
  expect(fromBottom()).toBe(376);
});

it("keeps following when the reply gets shorter and the browser pulls the view up to the new bottom", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);

  content -= 200;
  scroller.scrollTop = content - VIEW;
  frame();
  grow(300);
  expect(fromBottom()).toBe(0);
});

it("stops following on the wheel itself, before the view has moved and while the last pin's scroll event is pending", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);

  grow(5);
  fireEvent.wheel(scroller, { deltaY: -87 });
  frame();
  grow(5);
  expect(fromBottom()).toBe(5);
});

it("keeps following after a wheel up over a transcript too short to scroll", () => {
  content = 500;
  const { scroller, fromBottom, grow } = pane(1);

  fireEvent.wheel(scroller, { deltaY: -87 });
  grow(4500);
  expect(fromBottom()).toBe(0);
});

it("stops following on a key that scrolls up after the owner clicked in the transcript", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);

  grow(5);
  fireEvent.pointerDown(scroller);
  fireEvent.keyDown(document.body, { key: "PageUp" });
  frame();
  grow(5);
  expect(fromBottom()).toBe(5);
});

it("keeps following on a key that scrolls up after the owner clicked somewhere else", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);

  fireEvent.pointerDown(scroller);
  fireEvent.pointerDown(document.body);
  fireEvent.keyDown(document.body, { key: "PageUp" });
  frame();
  grow(5);
  expect(fromBottom()).toBe(0);
});

it("stops following on a key that scrolls up from a button in the transcript", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);

  grow(5);
  fireEvent.keyDown(scroller.querySelector("button")!, { key: "ArrowUp" });
  frame();
  grow(5);
  expect(fromBottom()).toBe(5);
});

it("keeps following when the wheel turns up over a box in the transcript that scrolls up itself", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);
  const box = document.createElement("pre");
  scroller.querySelector(".msg.assistant")!.append(box);
  Object.defineProperty(box, "scrollTop", { configurable: true, value: 120 });

  fireEvent.wheel(box, { deltaY: -87 });
  frame();
  grow(5);
  expect(fromBottom()).toBe(0);
});

it("stops following when the first frame of a wheel scroll moves the view up less than a pixel", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);

  fireEvent.wheel(scroller, { deltaY: -87 });
  scroller.scrollTop -= 0.5;
  frame();
  grow(5);
  expect(fromBottom()).toBe(5.5);
});

it("follows again when the view grows taller and lands at the bottom, after the ResizeObserver has run", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);

  scroller.scrollTop = content - VIEW - 100;
  frame();
  VIEW += 200;
  scroller.scrollTop = content - VIEW;
  runResizeObservers();
  frame();
  grow(300);
  expect(fromBottom()).toBe(0);
});

it("keeps following when Shift turns the wheel sideways", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);

  grow(5);
  fireEvent.wheel(scroller, { deltaY: -87, shiftKey: true });
  frame();
  grow(5);
  expect(fromBottom()).toBe(0);
});

it("stops following on a key that scrolls up from a checkbox in the transcript", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);
  const box = document.createElement("input");
  box.type = "checkbox";
  scroller.querySelector(".msg.assistant")!.append(box);

  grow(5);
  fireEvent.keyDown(box, { key: "PageUp" });
  frame();
  grow(5);
  expect(fromBottom()).toBe(5);
});

it("stops following on Shift+Space from a link in the transcript, but not from a button, which Space presses", () => {
  const { scroller, frame, fromBottom, grow } = pane(10);
  const link = document.createElement("a");
  link.href = "https://example.com";
  scroller.querySelector(".msg.assistant")!.append(link);

  grow(5);
  fireEvent.keyDown(scroller.querySelector("button")!, { key: " ", shiftKey: true });
  frame();
  grow(5);
  expect(fromBottom()).toBe(0);

  fireEvent.keyDown(link, { key: " ", shiftKey: true });
  frame();
  grow(5);
  expect(fromBottom()).toBe(5);
});

describe("The button to the newest message", () => {
  const button = () => document.querySelector<HTMLButtonElement>(".to-newest button");
  const scrollUp = (scroller: HTMLElement, px: number) => {
    fireEvent.wheel(scroller, { deltaY: -px });
    scroller.scrollTop -= px;
    frame();
  };

  it("says a new reply is below once the owner scrolled up during a running reply and the reply grew", () => {
    const { scroller, grow } = pane(10);
    expect(button()).toBeNull();

    scrollUp(scroller, 300);
    expect(button()).toBeNull();
    grow(200);
    expect(screen.getByRole("button", { name: "New reply below" })).toBeTruthy();
  });

  it("says a new reply is below as soon as the owner is more than a screen up during a running reply", () => {
    const { scroller } = pane(10);
    scrollUp(scroller, 700);
    expect(button()?.textContent).toBe("New reply below");
  });

  it("lands on the newest message when clicked, follows the reply again, and hides", () => {
    const { scroller, frame, fromBottom, grow } = pane(10);
    scrollUp(scroller, 1500);
    grow(300);
    expect(fromBottom()).toBe(1800);

    fireEvent.click(screen.getByRole("button", { name: "New reply below" }));
    frame();
    expect(fromBottom()).toBe(0);
    expect(button()).toBeNull();
    grow(300);
    expect(fromBottom()).toBe(0);
    expect(button()).toBeNull();
  });

  it("hides once the owner scrolls back to the bottom", () => {
    const { scroller, frame, grow } = pane(10);
    scrollUp(scroller, 800);
    grow(100);
    expect(button()).not.toBeNull();

    scroller.scrollTop = content;
    frame();
    expect(button()).toBeNull();
  });

  it("says new messages are below when the chat moved on with no reply running", () => {
    const { scroller, grow } = pane(10, { running: false });
    scrollUp(scroller, 300);
    grow(200);
    expect(button()?.textContent).toBe("New messages below");
  });

  it("says something arrived when a side question is answered, though the chat's last item stays as it was", () => {
    const asked: Chat = { ...chat(10), sideQuestions: [{ id: "sq-1", question: "Which port?", state: "asking" }] };
    const { scroller, show } = pane(10);
    show(asked);
    frame();
    scrollUp(scroller, 300);
    expect(button()).toBeNull();
    show({ ...asked, sideQuestions: [{ id: "sq-1", question: "Which port?", state: "answered", answer: "8080" }] });
    expect(button()?.textContent).toBe("New reply below");
  });

  it("says something arrived when a tool call above the last item finishes", () => {
    const base = chat(10, false);
    const tool = (status: "running" | "done"): Item => ({ kind: "tool", id: "t-1", callId: "call-1", name: "terminal", status });
    const withTool = (status: "running" | "done"): Chat => ({ ...base, items: [...base.items.slice(0, -1), tool(status), base.items[base.items.length - 1]] });
    const { scroller, show } = pane(10, { running: false });
    show(withTool("running"));
    frame();
    scrollUp(scroller, 300);
    expect(button()).toBeNull();
    show(withTool("done"));
    expect(button()?.textContent).toBe("New messages below");
  });

  it("stays hidden when the asks are handed over again with nothing new in this chat, as when another chat's ask moves", () => {
    const host = (): AskHost => ({ asks: [], bots: [], rule: "picked", connected: true, send: () => undefined, retry: () => {}, dismiss: () => {}, open: () => {} });
    const base = chat(10, false);
    const { scroller, show } = pane(10, { running: false });
    show(base, host());
    frame();
    scrollUp(scroller, 300);
    show(base, host());
    expect(button()).toBeNull();
  });

  it("offers the newest message when the owner is more than a screen up in a finished chat, and not within one", () => {
    const { scroller } = pane(10, { running: false });
    scrollUp(scroller, 500);
    expect(button()).toBeNull();
    scrollUp(scroller, 200);
    expect(button()?.textContent).toBe("Go to the newest message");
  });

  it("goes to the newest message on Alt+End, and on the chord the owner rebinds it to", () => {
    const { scroller, frame, fromBottom } = pane(10);
    expect(document.querySelector(".to-newest")).toBeNull();
    scrollUp(scroller, 1000);
    expect(button()?.title).toBe("Go to the newest message and follow the chat (Alt+End)");
    expect(button()?.getAttribute("aria-keyshortcuts")).toBe("Alt+End");

    fireEvent.keyDown(window, { key: "End", code: "End", altKey: true });
    frame();
    expect(fromBottom()).toBe(0);
    expect(button()).toBeNull();

    act(() => void setUIPrefs({ keybindings: { jumpToNewest: ["Ctrl+J"] } }));
    scrollUp(scroller, 1000);
    expect(button()?.title).toBe("Go to the newest message and follow the chat (Ctrl+J)");
    fireEvent.keyDown(window, { key: "End", code: "End", altKey: true });
    frame();
    expect(fromBottom()).toBe(1000);
    fireEvent.keyDown(window, { key: "j", code: "KeyJ", ctrlKey: true });
    frame();
    expect(fromBottom()).toBe(0);
  });
});
