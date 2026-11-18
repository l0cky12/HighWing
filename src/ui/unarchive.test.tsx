// @vitest-environment jsdom
// The Unarchive button on a chat archived here, in the Archived drawer and in the chat header's More menu, against a fake
// Hermes.
// Each test checks what reached Hermes and what the toast says, not which handler ran.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

/** Every `pinned` the app has written, in order. */
const pinnedWrites = (server: FakeHermes) =>
  server.restRequests.filter((r) => r.method === "PATCH" && r.body && "pinned" in r.body).map((r) => r.body!.pinned);
const toast = () => screen.getByRole("status");

/** Signed in with one Active chat and one archived here, the Archived drawer open. */
async function signedIn() {
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" }), row("old", 5, { title: "Old notes" })];
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "lena@hermes", url: "", username: "lena" }} onSignOut={async () => {}} />);
  await screen.findByRole("button", { name: /Nightly backup/ });
  await act(async () => void (await hermes.idle()));
  await user.click(screen.getByRole("button", { name: /^Archived/ }));
  return { server, hermes, user };
}

describe("Unarchive", () => {
  it("is the same icon-only button as Archive on an Archived chat in its drawer, named on hover, and unarchives with Undo", async () => {
    const { server, hermes, user } = await signedIn();
    const drawer = document.querySelector<HTMLElement>(".archived-drawer")!;
    const unarchive = within(drawer).getByRole("button", { name: "Unarchive" });
    // No words in the button: just the icon, with its name in the tooltip, like Archive.
    expect(unarchive.textContent).toBe("");
    expect(unarchive.title).toBe("Unarchive");
    expect(unarchive.querySelector("svg")).toBeTruthy();
    const archive = within(screen.getByRole("button", { name: /Nightly backup/ }).parentElement!).getByRole("button", { name: "Archive" });
    expect(unarchive.className).toBe(archive.className);
    expect(archive.textContent).toBe("");

    await user.click(unarchive);
    await act(async () => void (await hermes.idle()));
    expect(pinnedWrites(server)).toEqual([true]);
    expect(server.sessions.find((s) => s.id === "old")!.pinned).toBe(true);
    expect(toast().textContent).toContain("Unarchived: Old notes");

    await user.click(within(toast()).getByRole("button", { name: "Undo" }));
    await act(async () => void (await hermes.idle()));
    expect(pinnedWrites(server)).toEqual([true, false]);
    await waitFor(() => expect(document.querySelector('.row[data-section="archived"] .row-open')?.textContent).toContain("Old notes"));
  });

  it("is in the chat header's More menu, not beside the Archived badge", async () => {
    const { server, hermes, user } = await signedIn();
    await user.click(screen.getByRole("button", { name: /Old notes/ }));
    await act(async () => void (await hermes.idle()));
    const title = document.querySelector<HTMLElement>(".chat-title")!;
    expect(within(title).getByText("Archived")).toBeTruthy();
    expect(within(title).queryByRole("button", { name: "Unarchive" })).toBeNull();
    expect(within(document.querySelector<HTMLElement>(".chat-head-actions")!).queryByRole("button", { name: "Unarchive" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "More" }));

    await user.click(screen.getByRole("menuitem", { name: "Unarchive" }));
    await act(async () => void (await hermes.idle()));
    expect(pinnedWrites(server)).toEqual([true]);
    expect(toast().textContent).toContain("Unarchived: Old notes");
    await waitFor(() => expect(within(title).queryByText("Archived")).toBeNull());
  });
});
