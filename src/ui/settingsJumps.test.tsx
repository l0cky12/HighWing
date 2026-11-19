// @vitest-environment jsdom
// A Settings page without sections of its own lists its headings under it in the tree, to jump to, and the one at the
// top of the view is current as the page scrolls (ADR 0160). jsdom has no layout, so each section here sits 400 px
// below the one before it, and the page's scroll offset moves them.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { ModelSettingsApi } from "../hermes/modelSettings";
import { appearanceStore } from "./appearance";
import { SettingsScreen } from "./Settings";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

const STEP = 400;
const VIEW = 800;
let scrollTop = 0;
const rect = (top: number) => ({ top, bottom: top + STEP, left: 0, right: 900, width: 900, height: STEP, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
const realRect = HTMLElement.prototype.getBoundingClientRect;
const scrolled: string[] = [];
beforeAll(() => {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains("settings-main")) return rect(0);
    if (this.matches("section.set-section")) {
      const all = [...document.querySelectorAll(".settings-main section.set-section")].filter((s) => s.querySelector(":scope > .set-head h2"));
      return rect(all.indexOf(this) * STEP - scrollTop);
    }
    return realRect.call(this);
  };
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.querySelector(":scope > .set-head h2")?.textContent ?? "");
  };
});
afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = realRect;
});
afterEach(() => {
  cleanup();
  scrollTop = 0;
  scrolled.length = 0;
  localStorage.clear();
});

function memoryStorage() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
}

function Shell() {
  const [appearance] = useState(() => appearanceStore(memoryStorage(), document.createElement("html")));
  return (
    <SettingsScreen
      status="connected"
      route={{ kind: "ssh", target: "lena@hermes" }}
      unsecure={false}
      username="lena"
      passwordSaved
      profile="default"
      olderPulled={false}
      cacheBytes={() => 0}
      appearance={appearance}
      listFonts={async () => ({ all: [], mono: [] })}
      modelSettings={new ModelSettingsApi(async () => Promise.reject(new Error("Not connected to Hermes.")), () => "default")}
      onClearCache={() => {}}
      onPullOlder={async () => []}
      onSignOut={async () => {}}
      onClose={() => {}}
    />
  );
}

async function appearance() {
  render(<Shell />);
  fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
  const main = document.querySelector<HTMLElement>(".settings-main")!;
  const links = () => within(screen.getByRole("group", { name: "Appearance: on this page" })).getAllByRole("button");
  Object.defineProperties(main, {
    scrollTop: { get: () => scrollTop, set: (v: number) => {
      scrollTop = v;
    }, configurable: true },
    clientHeight: { value: VIEW, configurable: true },
    scrollHeight: { get: () => links().length * STEP + VIEW / 2, configurable: true },
  });
  const scrollTo = (top: number) => act(() => void ((main.scrollTop = top), main.dispatchEvent(new Event("scroll"))));
  const current = () => links().filter((b) => b.getAttribute("aria-current") === "location").map((b) => b.textContent);
  return { links, scrollTo, current };
}

it("makes the heading at the top of the view current as the page scrolls, and the last one at the page's foot", async () => {
  const { links, scrollTo, current } = await appearance();
  const names = links().map((b) => b.textContent);
  expect(names.length).toBeGreaterThan(3);
  expect(current()).toEqual([names[0]]);

  scrollTo(STEP + 10);
  expect(current()).toEqual([names[1]]);
  scrollTo(2 * STEP - 50);
  expect(current()).toEqual([names[1]]);
  scrollTo(2 * STEP);
  expect(current()).toEqual([names[2]]);
  scrollTo(0);
  expect(current()).toEqual([names[0]]);

  scrollTo(names.length * STEP + VIEW / 2 - VIEW);
  expect(current()).toEqual([names.at(-1)]);
});

it("marks the heading under the scroll at once, and moves the highlight once that heading stays", async () => {
  vi.useFakeTimers();
  try {
    const { links, scrollTo, current } = await appearance();
    const names = links().map((b) => b.textContent);
    const highlighted = () => links().filter((b) => b.classList.contains("on")).map((b) => b.textContent);
    expect(current()).toEqual([names[0]]);
    expect(highlighted()).toEqual([names[0]]);

    scrollTo(STEP + 10);
    expect(current()).toEqual([names[1]]);
    expect(highlighted()).toEqual([names[0]]);

    await act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(highlighted()).toEqual([names[1]]);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps a clicked link current while its own scroll settles, then follows the scroll again", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { links, scrollTo, current } = await appearance();
    const names = links().map((b) => b.textContent!);
    fireEvent.click(links()[3]);
    expect(scrolled).toEqual([names[3]]);
    expect(current()).toEqual([names[3]]);

    scrollTo(STEP);
    expect(current()).toEqual([names[3]]);
    vi.setSystemTime(Date.now() + 100);
    scrollTo(STEP + 5);
    expect(current()).toEqual([names[3]]);

    vi.setSystemTime(Date.now() + 200);
    scrollTo(STEP + 10);
    expect(current()).toEqual([names[1]]);
  } finally {
    vi.useRealTimers();
  }
});
