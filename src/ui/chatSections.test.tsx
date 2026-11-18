// @vitest-environment jsdom
// The chat list's sections as the side panel shows them (ADR 0063): each one collapsible, remembered across a restart;
// Settings → General picking which show, never none; Archived as the one drawer at the list's foot, and clearing a chat
// from the Inbox by archiving it (ADR 0090, ADR 0202). The list on its own first, then the whole app against a fake
// Hermes.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import type { Chat } from "../hermes/model";
import { CheckTimesStore } from "../hermes/otherProfiles";
import { CLEARED_KEY, PINS_KEY, type Pins, type Snoozes } from "../hermes/snooze";
import { UI_PREFS_KEY, getUIPrefs, setUIPrefs } from "../hermes/uiPrefs";
import { connect, type Hermes } from "../hermes/transport";
import { projectScope } from "../hermes/projectLinks";
import { Main } from "../App";
import { ChatList } from "./Sidebar";
import { TAB_DRAG } from "./Tabs";
import { ChatSectionSettings } from "./ChatSectionSettings";

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

const NOW = Date.now();
const chat = (id: string, extra: Partial<Chat> = {}): Chat => ({ id, title: id, source: "app", settled: false, updatedAt: NOW - 60_000, items: [], ...extra });

function List({
  chats,
  onSettle = () => {},
  pins,
  snoozes,
  onPin,
  selectedId = null,
}: {
  chats: Chat[];
  onSettle?: (id: string, settled: boolean) => void;
  pins?: Pins;
  snoozes?: Snoozes;
  onPin?: (id: string, on: boolean) => void;
  selectedId?: string | null;
}) {
  return (
    <ChatList
      pins={pins}
      snoozes={snoozes}
      onPin={onPin}
      profile="default"
      status="connected"
      others={{ byName: {} }}
      checkTimes={new CheckTimesStore()}
      chats={chats}
      selectedId={selectedId}
      onOpen={() => {}}
      onSettle={onSettle}
      onDelete={() => {}}
      onRename={async () => {}}
      onRegenTitle={async () => {}}
      onListProfiles={async () => ["default"]}
      onCheckOthers={() => {}}
      onSwitchProfile={() => {}}
      onRetrySwitch={() => {}}
    />
  );
}

/** The section headers the list shows, as their text: label then count. */
const heads = () => [...document.querySelectorAll<HTMLElement>(".section-toggle")].map((b) => b.textContent);
const head = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}\\d`) });
/** The titles of the chats the list shows in `section`, in order; rows of a collapsed section are out of sight. */
const titles = (section: string) =>
  [...document.querySelectorAll(`.row[data-section="${section}"]:not([hidden]) .row-open .row-title`)].map((t) => t.textContent);
const rowOf = (id: string) => document.querySelector<HTMLElement>(`.row-open[data-chat="${id}"]`)!;

const mix = [
  chat("new", { unread: true }),
  chat("read"),
  chat("busy", { running: true }),
  chat("quiet", { updatedAt: NOW - 3_600_000 }),
  chat("old", { settled: true }),
  chat("gone", { archived: true }),
];

describe("The side panel's sections", () => {
  it("shows the Inbox, Working and Archived with counts, and no Settled or Unsettled", () => {
    render(<List chats={mix} />);
    expect(heads()).toEqual(["Inbox3", "Working1", "Archived2"]);
    expect(titles("inbox")).toEqual(["new", "read", "quiet"]);
    expect(titles("working")).toEqual(["busy"]);
    expect(screen.queryByRole("button", { name: /^(Unsettled|Settled)/ })).toBeNull();
    // Archived starts collapsed.
    expect(head("Archived").getAttribute("aria-expanded")).toBe("false");
    expect(titles("archived")).toEqual([]);
  });

  it("collapses and expands each section from its header, remembered across a restart", async () => {
    const user = userEvent.setup();
    const first = render(<List chats={mix} />);
    await user.click(head("Inbox"));
    expect(head("Inbox").getAttribute("aria-expanded")).toBe("false");
    expect(titles("inbox")).toEqual([]);
    await user.click(head("Archived"));
    expect(titles("archived")).toEqual(["old", "gone"]);
    expect(JSON.parse(localStorage.getItem(UI_PREFS_KEY)!).chatSectionsCollapsed).toEqual(["inbox", "snoozed"]);

    // A restart: the prefs are read again from storage.
    first.unmount();
    const stored = localStorage.getItem(UI_PREFS_KEY)!;
    localStorage.clear();
    localStorage.setItem(UI_PREFS_KEY, stored);
    render(<List chats={mix} />);
    expect(head("Inbox").getAttribute("aria-expanded")).toBe("false");
    expect(head("Archived").getAttribute("aria-expanded")).toBe("true");
    expect(titles("archived")).toEqual(["old", "gone"]);
  });

  it("marks a collapsed section that has an unread chat", async () => {
    const user = userEvent.setup();
    render(<List chats={mix} />);
    expect(head("Inbox").querySelector(".dot")).toBeNull();
    await user.click(head("Inbox"));
    expect(head("Inbox").querySelector(".dot")?.getAttribute("title")).toBe("1 unread");
  });

  it("opens the section of a chat opened from elsewhere, such as a search", () => {
    const { rerender } = render(<List chats={mix} />);
    expect(head("Archived").getAttribute("aria-expanded")).toBe("false");
    rerender(<List chats={mix} selectedId="old" />);
    expect(head("Archived").getAttribute("aria-expanded")).toBe("true");
    expect(titles("archived")).toEqual(["old", "gone"]);
  });

  it("shows only the sections Settings picks, in the list's own order", () => {
    setUIPrefs({ chatSectionsShown: ["archived", "inbox"], chatSectionsCollapsed: [] });
    render(<List chats={mix} />);
    expect(heads()).toEqual(["Inbox3", "Archived2"]);
    expect(titles("archived")).toEqual(["old", "gone"]);
    expect(document.querySelector('.row[data-section="working"]')).toBeNull();
  });

  it("says when an open section is empty", () => {
    setUIPrefs({ chatSectionsCollapsed: [] });
    render(<List chats={[chat("busy", { running: true })]} />);
    const hints = [...document.querySelectorAll(".empty-hint")].map((h) => h.textContent);
    expect(hints).toEqual(["Nothing needs you right now.", "No archived chats."]);
  });
});

describe("The Archived drawer, in the list", () => {
  const scroll = () => document.querySelector<HTMLElement>(".sb-scroll")!;
  const foot = () => document.querySelector<HTMLElement>(".sb-foot");
  const drawer = () => document.querySelector<HTMLElement>(".archived-drawer");

  it("is the one drawer at the list's foot, holding chats archived here and in Hermes, and opens and closes from its header", async () => {
    const user = userEvent.setup();
    setUIPrefs({ chatSectionsShown: ["inbox", "archived"], chatSectionsCollapsed: [] });
    render(<List chats={mix} />);
    expect(heads()).toEqual(["Inbox3", "Archived2"]);
    expect(within(scroll()).queryByRole("button", { name: /^Archived/ })).toBeNull();
    expect(within(drawer()!).getByRole("button", { name: /^Archived/ })).toBe(head("Archived"));
    expect(scroll().nextElementSibling).toBe(foot());
    expect([...foot()!.children]).toEqual([drawer()]);
    // Open: the chat archived here and the one archived in Hermes are both in the drawer's own scroll.
    expect(drawer()!.classList.contains("open")).toBe(true);
    expect([...drawer()!.querySelectorAll(".archived-list .row-open")].map((r) => r.getAttribute("data-chat"))).toEqual(["old", "gone"]);
    // Closed: the header stays at the foot, and the archived chats are hidden.
    await user.click(head("Archived"));
    expect(drawer()!.classList.contains("open")).toBe(false);
    expect(drawer()!.querySelector(".archived-list")).toBeNull();
    expect(head("Archived").getAttribute("aria-expanded")).toBe("false");
  });

  // 37 Archived chats, newest first: s1 is the newest.
  const archivedMany = Array.from({ length: 37 }, (_, i) => chat(`s${i + 1}`, { settled: true, updatedAt: NOW - (i + 1) * 60_000 }));
  const drawn = () => [...drawer()!.querySelectorAll(".archived-list .row-open")].map((r) => r.getAttribute("data-chat"));
  const more = () => within(drawer()!).queryByRole("button", { name: /^Show \d+ more$/ });

  it("opens on the first ten Archived chats, then shows 25 more a press until all are drawn, and starts at ten again when reopened (ADR 0185)", async () => {
    const user = userEvent.setup();
    setUIPrefs({ chatSectionsShown: ["inbox", "archived"], chatSectionsCollapsed: [] });
    render(<List chats={archivedMany} />);
    expect(heads()).toEqual(["Inbox0", "Archived37"]);
    expect(drawn()).toEqual(archivedMany.slice(0, 10).map((c) => c.id));
    expect(more()?.textContent).toBe("Show 25 more");
    await user.click(more()!);
    expect(drawn()).toEqual(archivedMany.slice(0, 35).map((c) => c.id));
    // The last press offers only what is left.
    expect(more()?.textContent).toBe("Show 2 more");
    await user.click(more()!);
    expect(drawn()).toEqual(archivedMany.map((c) => c.id));
    expect(more()).toBeNull();
    // Closing the drawer and opening it again goes back to the first ten.
    await user.click(head("Archived"));
    await user.click(head("Archived"));
    expect(drawn()).toHaveLength(10);
    expect(more()?.textContent).toBe("Show 25 more");
  });

  it("draws no Show more button for ten Archived chats or fewer", () => {
    setUIPrefs({ chatSectionsShown: ["inbox", "archived"], chatSectionsCollapsed: [] });
    render(<List chats={archivedMany.slice(0, 10)} />);
    expect(drawn()).toHaveLength(10);
    expect(more()).toBeNull();
  });

  it("draws down to the Archived chat on screen when it is past the first ten, so its row shows", () => {
    setUIPrefs({ chatSectionsShown: ["inbox", "archived"], chatSectionsCollapsed: [] });
    render(<List chats={archivedMany} selectedId="s20" />);
    expect(drawn()).toEqual(archivedMany.slice(0, 20).map((c) => c.id));
    expect(drawer()!.querySelector('.row-open[aria-current="true"]')?.getAttribute("data-chat")).toBe("s20");
    expect(more()?.textContent).toBe("Show 17 more");
  });

  it("moves focus to the first new row on a keyboard press of Show more, and leaves it on a click", async () => {
    const user = userEvent.setup();
    setUIPrefs({ chatSectionsShown: ["inbox", "archived"], chatSectionsCollapsed: [] });
    render(<List chats={archivedMany} />);
    more()!.focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement?.getAttribute("data-chat")).toBe("s11");
    // A click draws the rest without moving focus to s36, the first row it drew.
    await user.click(more()!);
    expect(drawn()).toHaveLength(37);
    expect(document.activeElement?.closest(".row")).toBeNull();
  });

  it("moves focus to the first new row on a keyboard press while a row above is being renamed", async () => {
    const user = userEvent.setup();
    setUIPrefs({ chatSectionsShown: ["inbox", "archived"], chatSectionsCollapsed: [] });
    render(<List chats={archivedMany.slice(0, 11)} />);
    const s5 = drawer()!.querySelector<HTMLElement>('.row-open[data-chat="s5"]')!;
    await user.pointer({ keys: "[MouseRight]", target: s5 });
    await user.click(screen.getByRole("menuitem", { name: "Rename…" }));
    // An edited title keeps the rename box open when focus leaves it, so s5 has no row button meanwhile.
    await user.type(screen.getByRole("textbox", { name: "Chat title" }), " edited");
    more()!.focus();
    expect(screen.getByRole("textbox", { name: "Chat title" })).toBeTruthy();
    await user.keyboard("{Enter}");
    expect(more()).toBeNull();
    expect(document.activeElement?.getAttribute("data-chat")).toBe("s11");
  });

  it("has Working right above it, the scroll's last section, and Working stays last while Archived is hidden", () => {
    const chats = [...mix, chat("nap")];
    const all = ["pinned", "inbox", "snoozed", "working", "archived"] as const;
    for (const [shown, want] of [
      [all, ["Pinned1", "Inbox2", "Snoozed1", "Working1", "Archived2"]],
      [all.filter((k) => k !== "archived"), ["Pinned1", "Inbox2", "Snoozed1", "Working1"]],
    ] as const) {
      setUIPrefs({ chatSectionsShown: [...shown], chatSectionsCollapsed: [] });
      const { unmount } = render(<List chats={chats} pins={{ read: NOW }} snoozes={{ nap: NOW + 3_600_000 }} />);
      expect(heads()).toEqual(want);
      const last = scroll().lastElementChild!;
      expect(last.getAttribute("data-section")).toBe("working");
      expect(last.querySelector(".row-open")?.getAttribute("data-chat")).toBe("busy");
      expect(scroll().nextElementSibling).toBe(foot());
      expect(foot()?.firstElementChild ?? null).toBe(drawer());
      unmount();
    }
  });

  it("isn't drawn while Settings hides Archived", () => {
    setUIPrefs({ chatSectionsShown: ["inbox"] });
    render(<List chats={mix} />);
    expect(drawer()).toBeNull();
  });

  it("draws no rows closed, and the keys walk into it from the scroll", async () => {
    const user = userEvent.setup();
    render(<List chats={mix} />);
    expect(drawer()!.querySelector(".row")).toBeNull();
    await user.click(head("Archived"));
    rowOf("busy").focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rowOf("old"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rowOf("gone"));
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(rowOf("old"));
  });

  it("clears a chat from the Inbox by archiving it, from the row or its menu, and Unarchive puts one back; there is no Clear", async () => {
    const user = userEvent.setup();
    const calls: [string, boolean][] = [];
    setUIPrefs({ chatSectionsCollapsed: [] });
    render(<List chats={mix} onSettle={(id, on) => calls.push([id, on])} />);
    expect(screen.queryByRole("button", { name: "Clear from the Inbox" })).toBeNull();
    await user.click(within(rowOf("quiet").parentElement!).getByRole("button", { name: "Archive" }));
    fireEvent.contextMenu(rowOf("read"));
    expect(screen.queryByRole("menuitem", { name: "Clear from the Inbox" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    await user.click(within(rowOf("old").parentElement!).getByRole("button", { name: "Unarchive" }));
    fireEvent.contextMenu(rowOf("old"));
    expect(screen.queryByRole("menuitem", { name: "Back to the Inbox" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Unarchive" }));
    expect(calls).toEqual([
      ["quiet", true],
      ["read", true],
      ["old", false],
      ["old", false],
    ]);
  });

  it("archives a chat while its reply runs, and unarchives one Hermes archived only once its reply ends", async () => {
    const user = userEvent.setup();
    const calls: [string, boolean][] = [];
    setUIPrefs({ chatSectionsCollapsed: [] });
    const chats = [chat("busy", { running: true }), chat("gone", { archived: true }), chat("goneBusy", { archived: true, running: true })];
    const { rerender } = render(<List chats={chats} onSettle={(id, on) => calls.push([id, on])} />);
    await user.click(within(rowOf("busy").parentElement!).getByRole("button", { name: "Archive" }));
    await user.click(within(rowOf("gone").parentElement!).getByRole("button", { name: "Unarchive" }));
    expect(within(rowOf("goneBusy").parentElement!).queryByRole("button", { name: /^(Archive|Unarchive)$/ })).toBeNull();
    fireEvent.contextMenu(rowOf("goneBusy"));
    expect(screen.queryByRole("menuitem", { name: /^(Archive|Unarchive)$/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    rerender(<List chats={chats.map((c) => ({ ...c, running: false }))} onSettle={(id, on) => calls.push([id, on])} />);
    await user.click(within(rowOf("goneBusy").parentElement!).getByRole("button", { name: "Unarchive" }));
    expect(calls).toEqual([
      ["busy", true],
      ["gone", false],
      ["goneBusy", false],
    ]);
  });

  it("offers no way to hide a chat in every Hermes client, from a row or its menu", () => {
    setUIPrefs({ chatSectionsCollapsed: [] });
    render(<List chats={mix} />);
    for (const id of ["read", "old", "gone"]) {
      expect(within(rowOf(id).parentElement!).queryByRole("button", { name: /hide|restore/i })).toBeNull();
      fireEvent.contextMenu(rowOf(id));
      expect(screen.queryByRole("menuitem", { name: /hide|restore/i })).toBeNull();
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    }
    expect(screen.queryByTitle(/hide in every Hermes client/i)).toBeNull();
  });
});

describe("Dragging a row to archive or unarchive it, in the list", () => {
  const drawer = () => document.querySelector<HTMLElement>(".archived-drawer")!;
  const scroll = () => document.querySelector<HTMLElement>(".sb-scroll")!;
  const inboxTinted = () => scroll().getAttribute("data-drop") === "inbox";
  const tinted = () => drawer().classList.contains("drop") || inboxTinted();

  function dragRow(id: string, target: Element, { drop = true, tab = false }: { drop?: boolean; tab?: boolean } = {}) {
    const data = new Map<string, string>();
    // Browsers hide drag data until drop; dragover sees only the types.
    let readable = false;
    const dataTransfer = {
      types: [] as string[],
      setData: (k: string, v: string) => (data.set(k, v), dataTransfer.types.push(k)),
      getData: (k: string) => (readable ? (data.get(k) ?? "") : ""),
      effectAllowed: "",
      dropEffect: "",
    };
    const source = rowOf(id);
    fireEvent.dragStart(source, { dataTransfer });
    if (tab) dataTransfer.types.push(TAB_DRAG);
    fireEvent.dragOver(target, { dataTransfer });
    if (!drop) return;
    readable = true;
    fireEvent.drop(target, { dataTransfer });
    fireEvent.dragEnd(source, { dataTransfer });
  }

  const drag = [chat("fresh"), chat("shelved", { settled: true }), chat("gone", { archived: true })];

  it("archives an Inbox row dropped on the closed drawer, tinting it meanwhile, and leaves the drawer closed", () => {
    setUIPrefs({ chatSectionsCollapsed: ["archived"] });
    const onSettle = vi.fn();
    render(<List chats={drag} onSettle={onSettle} />);
    dragRow("fresh", head("Archived"), { drop: false });
    expect(drawer().classList.contains("drop")).toBe(true);
    dragRow("fresh", head("Archived"));
    expect(onSettle.mock.calls).toEqual([["fresh", true]]);
    expect(drawer().classList.contains("drop")).toBe(false);
    expect(head("Archived").getAttribute("aria-expanded")).toBe("false");
  });

  it("archives on the open drawer's rows too", () => {
    setUIPrefs({ chatSectionsCollapsed: [] });
    const onSettle = vi.fn();
    render(<List chats={drag} onSettle={onSettle} />);
    dragRow("fresh", rowOf("shelved"));
    expect(onSettle.mock.calls).toEqual([["fresh", true]]);
  });

  it("unarchives a row archived here dropped on an Inbox row or the Inbox's header, tinting the Inbox meanwhile", () => {
    setUIPrefs({ chatSectionsCollapsed: [] });
    const onSettle = vi.fn();
    render(<List chats={drag} onSettle={onSettle} />);
    dragRow("shelved", rowOf("fresh"), { drop: false });
    expect(inboxTinted()).toBe(true);
    expect(drawer().classList.contains("drop")).toBe(false);
    dragRow("shelved", rowOf("fresh"));
    dragRow("shelved", head("Inbox"));
    expect(onSettle.mock.calls).toEqual([
      ["shelved", false],
      ["shelved", false],
    ]);
    expect(inboxTinted()).toBe(false);
  });

  it("unarchives a pinned archived chat dropped on the Inbox, and archives a snoozed one dropped on the drawer", () => {
    setUIPrefs({ chatSectionsCollapsed: [] });
    const onSettle = vi.fn();
    render(
      <List
        chats={[chat("fresh"), chat("pinned", { settled: true }), chat("napping")]}
        pins={{ pinned: NOW }}
        snoozes={{ napping: NOW + 3_600_000 }}
        onSettle={onSettle}
      />,
    );
    dragRow("pinned", head("Inbox"));
    dragRow("napping", head("Archived"));
    expect(onSettle.mock.calls).toEqual([
      ["pinned", false],
      ["napping", true],
    ]);
  });

  it("does nothing, with no tint, for a drop that would change nothing", () => {
    setUIPrefs({ chatSectionsCollapsed: [] });
    const onSettle = vi.fn();
    render(<List chats={drag} onSettle={onSettle} />);
    for (const [id, target] of [
      ["shelved", head("Archived")],
      ["shelved", rowOf("shelved")],
      ["gone", head("Archived")],
      ["fresh", head("Inbox")],
      ["fresh", rowOf("fresh")],
    ] as const) {
      dragRow(id, target, { drop: false });
      expect(tinted()).toBe(false);
      dragRow(id, target);
    }
    expect(onSettle).not.toHaveBeenCalled();
  });

  it("leaves a chat Hermes archived where it is when dropped on the Inbox: Unarchive restores it", () => {
    setUIPrefs({ chatSectionsCollapsed: [] });
    const onSettle = vi.fn();
    render(<List chats={[...drag, chat("both", { settled: true, archived: true })]} onSettle={onSettle} />);
    for (const id of ["gone", "both"]) {
      dragRow(id, head("Inbox"), { drop: false });
      expect(tinted()).toBe(false);
      dragRow(id, head("Inbox"));
    }
    expect(onSettle).not.toHaveBeenCalled();
  });

  it("refuses a tab dragged onto the drawer or the Inbox", () => {
    setUIPrefs({ chatSectionsCollapsed: [] });
    const onSettle = vi.fn();
    render(<List chats={drag} onSettle={onSettle} />);
    dragRow("fresh", head("Archived"), { drop: false, tab: true });
    expect(tinted()).toBe(false);
    dragRow("fresh", head("Archived"), { tab: true });
    dragRow("shelved", head("Inbox"), { tab: true });
    expect(onSettle).not.toHaveBeenCalled();
  });

  it("takes the Inbox's header when it is empty and collapsed, and not the sections below it", () => {
    setUIPrefs({ chatSectionsCollapsed: ["inbox"] });
    const onSettle = vi.fn();
    render(<List chats={[chat("shelved", { settled: true }), chat("busy", { running: true })]} onSettle={onSettle} />);
    dragRow("shelved", head("Working"), { drop: false });
    expect(tinted()).toBe(false);
    dragRow("shelved", head("Inbox"));
    expect(onSettle.mock.calls).toEqual([["shelved", false]]);
  });
});

describe("Pinned chats, in the list", () => {
  it("lists pinned chats first, in the order pinned, each with a pin, and new messages don't reorder them", () => {
    const pins = { quiet: NOW - 2_000, read: NOW - 1_000 };
    const { rerender } = render(<List chats={mix} pins={pins} onPin={() => {}} />);
    expect(heads()).toEqual(["Pinned2", "Inbox1", "Working1", "Archived2"]);
    expect(titles("pinned")).toEqual(["quiet", "read"]);
    expect(rowOf("quiet").querySelector('[aria-label="Pinned"]')).not.toBeNull();
    expect(rowOf("new").querySelector('[aria-label="Pinned"]')).toBeNull();
    const later = mix.map((c) => (c.id === "read" || c.id === "new" ? { ...c, updatedAt: NOW } : c));
    rerender(<List chats={later} pins={pins} onPin={() => {}} />);
    expect(heads()[0]).toBe("Pinned2");
    expect(titles("pinned")).toEqual(["quiet", "read"]);
    expect(titles("inbox")).toEqual(["new"]);
  });

  it("moves a pinned chat to Archived when it is archived, keeping its pin for when it comes back", () => {
    const pins = { old: NOW - 2_000, read: NOW - 1_000 };
    const { rerender } = render(<List chats={mix} pins={pins} onPin={() => {}} />);
    expect(heads()).toEqual(["Pinned1", "Inbox2", "Working1", "Archived2"]);
    rerender(<List chats={mix.map((c) => (c.id === "old" ? { ...c, settled: false } : c))} pins={pins} onPin={() => {}} />);
    expect(titles("pinned")).toEqual(["old", "read"]);
  });

  it("draws no Pinned header while nothing is pinned", () => {
    render(<List chats={mix} pins={{}} />);
    expect(heads()[0]).toBe("Inbox3");
  });

  it("pins and unpins from the row's menu, by click or by its P key", async () => {
    const user = userEvent.setup();
    const calls: [string, boolean][] = [];
    render(<List chats={mix} pins={{ read: NOW }} onPin={(id, on) => calls.push([id, on])} />);
    fireEvent.contextMenu(rowOf("new"));
    await user.click(screen.getByRole("menuitem", { name: /^Pin/ }));
    fireEvent.contextMenu(rowOf("read"));
    expect(screen.getByRole("menuitem", { name: /^Unpin/ }).getAttribute("aria-keyshortcuts")).toBe("P");
    await user.keyboard("p");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(calls).toEqual([
      ["new", true],
      ["read", false],
    ]);
  });
});

describe("The row's menu from the keyboard", () => {
  it("opens on Shift+F10, which WebKitGTK sends no contextmenu event for", async () => {
    const user = userEvent.setup();
    render(<List chats={mix} onPin={() => {}} />);
    rowOf("read").focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("menu", { name: "Actions for read" })).toBeTruthy();
  });

  it("opens for the Menu key's event, which WebKitGTK sends to the focused row's corner, just outside it", () => {
    render(<List chats={mix} onPin={() => {}} />);
    const list = document.querySelector<HTMLElement>(".sb-scroll")!;
    rowOf("read").focus();
    const at = rowOf("read").getBoundingClientRect();
    fireEvent.contextMenu(list, { clientX: at.left + 40, clientY: at.bottom });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(list, { clientX: at.left, clientY: at.bottom });
    expect(screen.getByRole("menu", { name: "Actions for read" })).toBeTruthy();
  });
});

describe("Settings → General: chat list sections", () => {
  it("turns each section on or off in any mix, but never the last one", async () => {
    const user = userEvent.setup();
    render(<ChatSectionSettings />);
    const sw = (name: string) => screen.getByRole("switch", { name });
    expect(screen.queryByRole("switch", { name: "Unsettled" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Settled" })).toBeNull();
    const inOrder = ["Pinned", "Inbox", "Snoozed", "Working", "Archived"].map(sw);
    expect(screen.getAllByRole("switch")).toEqual(inOrder);
    expect(inOrder.map((s) => s.getAttribute("aria-checked"))).toEqual(["true", "true", "true", "true", "true"]);
    await user.click(sw("Archived"));
    expect(getUIPrefs().chatSectionsShown).toEqual(["pinned", "inbox", "snoozed", "working"]);
    await user.click(sw("Archived"));
    await user.click(sw("Working"));
    expect(getUIPrefs().chatSectionsShown).toEqual(["pinned", "inbox", "snoozed", "archived"]);
    for (const n of ["Pinned", "Inbox", "Snoozed"]) await user.click(sw(n));
    expect(getUIPrefs().chatSectionsShown).toEqual(["archived"]);
    // The last one on can't be turned off, and says why.
    expect(sw("Archived").getAttribute("aria-disabled")).toBe("true");
    expect(sw("Archived").getAttribute("aria-checked")).toBe("true");
    await user.click(sw("Archived"));
    expect(getUIPrefs().chatSectionsShown).toEqual(["archived"]);
    expect(screen.getByText(/At least one section stays on/)).toBeTruthy();
    await user.click(sw("Inbox"));
    expect(getUIPrefs().chatSectionsShown).toEqual(["inbox", "archived"]);
    expect(sw("Archived").getAttribute("aria-disabled")).toBeNull();
  });

  it("won't keep a stored list with no sections, or ones it doesn't know", () => {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 1, chatSectionsShown: [], chatSectionsCollapsed: ["nope", "inbox", "inbox"] }));
    expect(getUIPrefs().chatSectionsShown).toEqual(["pinned", "inbox", "snoozed", "working", "archived"]);
    expect(getUIPrefs().chatSectionsCollapsed).toEqual(["inbox"]);
    setUIPrefs({ chatSectionsShown: [] });
    expect(getUIPrefs().chatSectionsShown).toEqual(["pinned", "inbox", "snoozed", "working", "archived"]);
  });

  it("reads sections stored in an older order in the list's order, with Archived last", () => {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 3, chatSectionsShown: ["pinned", "inbox", "archived", "working", "snoozed"] }));
    expect(getUIPrefs().chatSectionsShown).toEqual(["pinned", "inbox", "snoozed", "working", "archived"]);
  });

  it("shows Archived to an owner who showed Settled and hid Archived, so the chats they settled stay in view", () => {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 5, chatSectionsShown: ["pinned", "inbox", "snoozed", "working", "settled"] }));
    expect(getUIPrefs().chatSectionsShown).toEqual(["pinned", "inbox", "snoozed", "working", "archived"]);
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 5, chatSectionsShown: ["pinned", "inbox", "snoozed", "working"] }));
    expect(getUIPrefs().chatSectionsShown).toEqual(["pinned", "inbox", "snoozed", "working"]);
  });

  it("drops Unsettled from preferences stored before ADR 0090, and a list of only Unsettled shows the defaults", () => {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 2, chatSectionsShown: ["inbox", "unsettled", "settled"], chatSectionsCollapsed: ["unsettled", "settled"] }));
    expect(getUIPrefs().chatSectionsShown).toEqual(["inbox", "archived"]);
    expect(getUIPrefs().chatSectionsCollapsed).toEqual(["archived"]);
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 2, chatSectionsShown: ["unsettled"] }));
    expect(getUIPrefs().chatSectionsShown).toEqual(["pinned", "inbox", "snoozed", "working", "archived"]);
  });
});

describe("Clearing from the Inbox, in the app", () => {
  const connection = { mode: "ssh" as const, sshTarget: "lena@hermes", url: "", username: "lena" };
  async function signedIn(server = new FakeHermes()) {
    if (!server.sessions.length) server.sessions = [row("a", 1, { pinned: true, title: "Deploy notes" }), row("b", 2, { pinned: true, title: "Groceries" })];
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    const user = userEvent.setup();
    render(<Main hermes={hermes} connection={connection} onSignOut={async () => {}} />);
    // Groceries stays in the Inbox in every test here; Deploy notes may be settled as the app starts.
    await screen.findByRole("button", { name: /Groceries/ });
    await act(async () => void (await hermes.idle()));
    return { server, hermes, user };
  }
  /** Every `pinned` the app has written, by chat, in order. */
  const pinnedWrites = (server: FakeHermes) =>
    server.restRequests.filter((r) => r.method === "PATCH" && r.body && "pinned" in r.body).map((r) => [r.path.split("/").pop(), r.body!.pinned]);

  it("archives the chat by settling it on Hermes, into the Archived drawer, and Undo brings it back to the Inbox", async () => {
    const { server, hermes, user } = await signedIn();
    const rowFor = (title: string) => screen.getByRole("button", { name: new RegExp(title) }).parentElement!;
    await user.click(within(rowFor("Deploy notes")).getByRole("button", { name: "Archive" }));
    await act(async () => void (await hermes.idle()));
    expect(screen.getByRole("status").textContent).toContain("Archived: Deploy notes");
    expect(titles("inbox")).toEqual(["Groceries"]);
    expect(head("Archived").textContent).toBe("Archived1");
    // Settled, not archived in Hermes: other Hermes clients still list it.
    expect(server.sessions.find((s) => s.id === "a")).toMatchObject({ pinned: false, archived: false });

    await user.click(within(screen.getByRole("status")).getByRole("button", { name: "Undo" }));
    await act(async () => void (await hermes.idle()));
    await waitFor(() => expect(titles("inbox")).toEqual(["Deploy notes", "Groceries"]));
    expect(server.sessions.find((s) => s.id === "a")!.pinned).toBe(true);
  });

  it("settles once the chats an older version kept cleared, then forgets every clear", async () => {
    const server = new FakeHermes();
    server.sessions = [
      row("a", 1, { pinned: true, title: "Deploy notes" }),
      row("b", 2, { pinned: true, title: "Groceries" }),
      row("c", 3, { pinned: true, title: "Taxes" }),
    ];
    const marks = Object.fromEntries(server.sessions.map((s) => [s.id, s.last_active! * 1000]));
    // "a" was cleared and nothing has happened since; "b" has had a message since its clear; "c" was never cleared.
    const scope = projectScope(connection, "default");
    localStorage.setItem(CLEARED_KEY, JSON.stringify({ v: 1, scopes: { [scope]: { a: marks.a, b: marks.b - 60_000 }, other: { x: 1 } } }));
    const { hermes } = await signedIn(server);
    await act(async () => void (await hermes.idle()));
    await waitFor(() => expect(pinnedWrites(server)).toEqual([["a", false]]));
    expect(server.sessions.map((s) => [s.id, s.pinned])).toEqual([
      ["a", false],
      ["b", true],
      ["c", true],
    ]);
    await waitFor(() => expect(titles("inbox")).toEqual(["Groceries", "Taxes"]));
    // This connection and profile's clears are gone; another's are left as they were.
    expect(JSON.parse(localStorage.getItem(CLEARED_KEY)!).scopes).toEqual({ other: { x: 1 } });
  });

  it("lists chats Hermes archived in the Archived drawer while it shows, and hiding or showing it writes nothing to Hermes", async () => {
    const server = new FakeHermes();
    server.sessions = [row("a", 1, { pinned: true, title: "Deploy notes" }), row("b", 2, { pinned: true, title: "Groceries" }), row("z", 3, { archived: true, title: "Old plan" })];
    const { hermes, user } = await signedIn(server);
    await waitFor(() => expect(head("Archived").textContent).toBe("Archived1"));
    expect(hermes.getSnapshot().archivedListed).toBe(true);
    expect([...document.querySelector(".sb-foot")!.children]).toEqual([head("Archived").closest(".archived-drawer")]);
    await user.click(head("Archived"));
    await user.click(rowOf("z"));
    expect(rowOf("z").closest(".row")!.classList.contains("sel")).toBe(true);
    await act(async () => void (await hermes.idle()));
    const writes = () => server.restRequests.filter((r) => r.method !== "GET").length;
    const before = writes();

    const all = getUIPrefs().chatSectionsShown;
    act(() => void setUIPrefs({ chatSectionsShown: all.filter((k) => k !== "archived") }));
    await waitFor(() => expect(hermes.getSnapshot().archivedListed).toBe(false));
    expect(screen.queryByRole("button", { name: /^Archived/ })).toBeNull();
    act(() => void setUIPrefs({ chatSectionsShown: all }));
    await waitFor(() => expect(hermes.getSnapshot().archivedListed).toBe(true));
    await waitFor(() => expect(titles("archived")).toEqual(["Old plan"]));
    expect(writes()).toBe(before);
    expect(server.sessions.find((r) => r.id === "z")?.archived).toBe(true);
  });

  it("unarchives a chat settled here and archived in Hermes by clearing both, back into the Inbox", async () => {
    const server = new FakeHermes();
    server.sessions = [row("b", 2, { pinned: true, title: "Groceries" }), row("z", 3, { pinned: false, archived: true, title: "Old plan" })];
    const { hermes, user } = await signedIn(server);
    await waitFor(() => expect(head("Archived").textContent).toBe("Archived1"));
    await user.click(head("Archived"));
    await user.click(within(rowOf("z").parentElement!).getByRole("button", { name: "Unarchive" }));
    await act(async () => void (await hermes.idle()));
    await waitFor(() => expect(server.sessions.find((s) => s.id === "z")).toMatchObject({ pinned: true, archived: false }));
    expect(screen.getByRole("status").textContent).toContain("Unarchived: Old plan");
    await waitFor(() => expect(titles("inbox")).toEqual(["Groceries", "Old plan"]));
    expect(head("Archived").textContent).toBe("Archived0");
  });
});

describe("Pinning, in the app", () => {
  const connection = { mode: "ssh" as const, sshTarget: "lena@hermes", url: "", username: "lena" };
  async function signedIn(server = new FakeHermes()) {
    if (!server.sessions.length)
      server.sessions = [
        row("a", 1, { pinned: true, title: "Deploy notes" }),
        row("b", 2, { pinned: true, title: "Groceries" }),
        row("c", 3, { pinned: true, title: "Taxes" }),
      ];
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    const user = userEvent.setup();
    const view = render(<Main hermes={hermes} connection={connection} onSignOut={async () => {}} />);
    await screen.findByRole("button", { name: /Deploy notes/ });
    await act(async () => void (await hermes.idle()));
    return { server, hermes, user, view };
  }
  const refresh = (hermes: Hermes) =>
    act(async () => {
      await hermes.sync();
      await hermes.idle();
    });
  const storedPins = () => Object.values(JSON.parse(localStorage.getItem(PINS_KEY) ?? '{"scopes":{}}').scopes).map((s) => Object.keys(s as object));

  it("pins from the row menu and the header's More menu, keeps them on this computer only, and keeps them across a restart", async () => {
    const { server, hermes, user, view } = await signedIn();
    const before = server.restRequests.length;
    fireEvent.contextMenu(rowOf("b"));
    await user.click(screen.getByRole("menuitem", { name: /^Pin/ }));
    expect(screen.getByRole("status").textContent).toContain("Pinned: Groceries");
    await user.click(rowOf("a"));
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: /^Pin/ }));
    expect(heads()[0]).toBe("Pinned2");
    expect(titles("pinned")).toEqual(["Groceries", "Deploy notes"]);
    expect(titles("inbox")).toEqual(["Taxes"]);
    expect(storedPins()).toEqual([["b", "a"]]);
    // Opening a chat marks it read on Hermes; nothing else is written there.
    expect(server.restRequests.slice(before).filter((r) => r.method !== "GET").map((r) => r.body)).toEqual([expect.objectContaining({ unread: false })]);

    // A new message in an unpinned chat leaves it below the pinned ones.
    server.sessions.find((s) => s.id === "c")!.last_active = Date.now() / 1000;
    await refresh(hermes);
    expect(heads()[0]).toBe("Pinned2");
    expect(titles("pinned")).toEqual(["Groceries", "Deploy notes"]);
    expect(titles("inbox")).toEqual(["Taxes"]);

    view.unmount();
    const again = await connect(server.openPipe);
    running.push(again);
    render(<Main hermes={again} connection={connection} onSignOut={async () => {}} />);
    await screen.findByRole("button", { name: /Deploy notes/ });
    expect(titles("pinned")).toEqual(["Groceries", "Deploy notes"]);
  }, 20_000);

  it("unpins back to the chat's place in the list, and Undo puts the pin back in its old place", async () => {
    const { user } = await signedIn();
    for (const id of ["b", "c"]) {
      fireEvent.contextMenu(rowOf(id));
      await user.click(screen.getByRole("menuitem", { name: /^Pin/ }));
    }
    expect(titles("pinned")).toEqual(["Groceries", "Taxes"]);
    fireEvent.contextMenu(rowOf("b"));
    await user.keyboard("p");
    expect(titles("pinned")).toEqual(["Taxes"]);
    expect(titles("inbox")).toEqual(["Deploy notes", "Groceries"]);
    await user.click(within(screen.getByRole("status")).getByRole("button", { name: "Undo" }));
    expect(titles("pinned")).toEqual(["Groceries", "Taxes"]);
  });

  it("keeps a pinned chat the list no longer reaches, and forgets the pin of one Hermes no longer has", async () => {
    const server = new FakeHermes();
    server.sessions = [row("a", 1, { pinned: true, title: "Deploy notes" }), row("old", 60, { title: "Last year's taxes" })];
    localStorage.setItem(PINS_KEY, JSON.stringify({ v: 1, scopes: { [projectScope(connection, "default")]: { old: NOW - 2, gone: NOW - 1 } } }));
    await signedIn(server);
    // Hermes has it settled, so it is Archived, which outranks a pin; the pin stays for when it is unarchived.
    await waitFor(() => expect(head("Archived").textContent).toBe("Archived1"));
    expect(titles("pinned")).toEqual([]);
    await waitFor(() => expect(storedPins()).toEqual([["old"]]));
  });

  it("forgets a deleted chat's pin", async () => {
    const { user } = await signedIn();
    fireEvent.contextMenu(rowOf("b"));
    await user.click(screen.getByRole("menuitem", { name: /^Pin/ }));
    fireEvent.contextMenu(rowOf("b"));
    await user.click(screen.getByRole("menuitem", { name: "Delete chat…" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /^Delete/ }));
    await waitFor(() => expect(storedPins()).toEqual([]));
  });
});
