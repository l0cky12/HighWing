// @vitest-environment jsdom
// The chat header (issue #173): Search and the side panel stay on the bar, the chat's other actions are in a labelled
// More menu, and the split buttons sit at the end of the tab strip. Driven by keyboard only, against a fake Hermes.
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
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

/** A control's accessible name: its aria-label, else its title, else its text. */
const named = (el: Element | null) => el?.getAttribute("aria-label") ?? el?.getAttribute("title") ?? el?.textContent ?? "";

async function openChat() {
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "lena@hermes", url: "", username: "lena" }} onSignOut={async () => {}} />);
  await user.click(await screen.findByRole("button", { name: /Nightly backup/ }));
  await act(async () => void (await hermes.idle()));
  return { server, user };
}

describe("The chat header", () => {
  it("keeps Search and the side panel on the bar, with no split buttons anywhere, all reached with Tab", async () => {
    const { user } = await openChat();
    const actions = document.querySelector<HTMLElement>(".chat-head-actions")!;
    // Only these are buttons on the bar now; the rest went into More or onto the tab strip.
    expect([...actions.querySelectorAll("button")].map(named)).toEqual(["Open the side panel", "Find in chat", "More"]);
    for (const gone of ["Export…", "Copy chat link", "Archive", "Split into two panes"])
      expect(actions.querySelector(`[aria-label="${gone}"], [title="${gone}"]`)).toBeNull();
    // Splitting is Ctrl+\, a tab's menu or a drag (ADR 0116), so the tab strip has no split buttons either.
    expect(document.querySelector('.tab-strip [aria-label^="Split into two panes"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Find in chat" }).title).toBe("Find in chat (Ctrl+F)");

    // From the tab, Tab walks the strip's buttons, then the header's, in the order they are shown.
    screen.getByRole("tab", { name: "Nightly backup" }).focus();
    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      await user.tab();
      order.push(named(document.activeElement));
    }
    const at = (n: string) => order.indexOf(n);
    expect(at("New tab")).toBeGreaterThanOrEqual(0);
    expect(at("New tab")).toBeLessThan(at("Open the side panel"));
    expect(at("Open the side panel")).toBeLessThan(at("Find in chat"));
    expect(at("Find in chat")).toBeLessThan(at("More"));
  });

  it("opens More from the keyboard: labelled items, arrow keys between them, Escape back to the button", async () => {
    const { server, user } = await openChat();
    const more = screen.getByRole("button", { name: "More" });
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    more.focus();
    await user.keyboard("{Enter}");
    const menu = screen.getByRole("menu", { name: "More actions for Nightly backup" });
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect([...menu.querySelectorAll("[role=menuitem]")].map((m) => m.textContent)).toEqual(["Export…", "Share snapshot…", "Copy chat link", "PinP", "Archive", "Delete chat…"]);
    expect(document.activeElement!.textContent).toBe("Export…");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(document.activeElement!.textContent).toBe("Archive");
    await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(document.activeElement!.textContent).toBe("Delete chat…");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(more);
    expect(more.getAttribute("aria-expanded")).toBe("false");

    // Enter on an item runs it and closes the menu.
    await user.keyboard("{Enter}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    expect(screen.queryByRole("menu")).toBeNull();
    await screen.findByText("Archived", { selector: ".chat-title .badge" });
    expect(server.restRequests.some((r) => r.method === "PATCH" && r.body?.pinned === false)).toBe(true);
    // Archive settles the chat; nothing hides it in every Hermes client.
    expect(server.restRequests.some((r) => r.method === "PATCH" && r.body && "archived" in r.body)).toBe(false);
    await user.keyboard("{Enter}");
    const items = [...screen.getByRole("menu").querySelectorAll("[role=menuitem]")].map((m) => m.textContent);
    expect(items).toEqual(["Export…", "Share snapshot…", "Copy chat link", "Unarchive", "Delete chat…"]);
  });

  it("shows one Archived badge, and Unarchive clears both flags, for a chat archived here and in Hermes", async () => {
    const server = new FakeHermes();
    server.sessions = [row("plan", 1, { pinned: false, archived: true, title: "Old plan" })];
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    const user = userEvent.setup();
    render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "lena@hermes", url: "", username: "lena" }} onSignOut={async () => {}} />);
    await user.click(await screen.findByRole("button", { name: /^Archived/ }));
    await user.click(await screen.findByRole("button", { name: /Old plan/ }));
    await act(async () => void (await hermes.idle()));
    expect([...document.querySelectorAll(".chat-title .badge")].map((b) => b.textContent)).toEqual(["Archived"]);
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("menuitem", { name: /^(Archive|Restore)$/ })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Unarchive" }));
    await act(async () => void (await hermes.idle()));
    await vi.waitFor(() => expect(server.sessions[0]).toMatchObject({ pinned: true, archived: false }));
    expect(document.querySelector(".chat-title .badge")).toBeNull();
  });

  it("closes More on a second click of its button, without opening it again", async () => {
    const { user } = await openChat();
    const more = screen.getByRole("button", { name: "More" });
    await user.click(more);
    expect(screen.getByRole("menu")).toBeTruthy();
    await user.click(more);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps one More menu open across two panes: opening the other pane's closes the first", async () => {
    const { user } = await openChat();
    await user.keyboard("{Control>}\\{/Control}");
    const [left, right] = screen.getAllByRole("button", { name: "More" });
    await user.click(left);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    await user.click(right);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(left.getAttribute("aria-expanded")).toBe("false");
    expect(right.getAttribute("aria-expanded")).toBe("true");
  });
});
