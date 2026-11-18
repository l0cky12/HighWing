// @vitest-environment jsdom
// Bot messaging (ADR 0205) in the real app against FakeHermes as Hermes 0.23.2 on a headless gateway: the switch above
// the bots turns Hermes's `message_agent` on, shown only as read back. All data is synthetic.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BOT_CHAT_TITLE } from "../hermes/bots";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
const running: Hermes[] = [];
const servers: FakeHermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
  // No write here may go without a check against another client's (ADR 0189).
  for (const server of servers.splice(0)) expect(server.uncheckedConfigures()).toEqual([]);
});

let launches = 0;

/** Signed in to a headless Hermes 0.23.2: the default profile and Quill, each with a Bot Chat, and no Bot Mode block. */
async function launch(setup: (server: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.health = { ...server.health, version: "0.23.2", displayVersion: "0.23.2" };
  server.sessions = [row("hermes-bot", 1, { title: BOT_CHAT_TITLE, hidden: true })];
  server.otherProfiles = { quill: [row("quill-bot", 2, { title: BOT_CHAT_TITLE, hidden: true })] };
  server.transcripts = { "hermes-bot": [{ role: "user", text: "Ask Quill what the backup window is." }], "quill-bot": [] };
  setup(server);
  servers.push(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `lena@messaging-${++launches}`, url: "", username: "lena" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  await act(async () => void (await hermes.checkOtherProfiles()));
  const user = userEvent.setup();
  await user.click(document.querySelector<HTMLElement>('.sidebar [role=tab][data-mode="bots"]')!);
  await waitFor(() => expect(document.querySelectorAll(".sb-bots .bots-row")).toHaveLength(2));
  return { server, hermes, user };
}

const toggle = () => document.querySelector<HTMLButtonElement>(".sb-bots [role=switch]")!;
const tip = () => toggle().closest<HTMLElement>("[title]")!.title;
const toast = () => document.querySelector<HTMLElement>(".toast")?.textContent;
const configures = (server: FakeHermes) => server.requests.filter((r) => r.method === "profiles.configure");
const pinned = (s: FakeHermes) => void (s.profileMeta.quill = { ui_meta: { "hermes-bots": { title: "Quill", pinned: true } } });

describe("Bot messaging's switch", () => {
  it("is off on a headless install, and shows on only once Hermes's roster says so", async () => {
    const { server, user } = await launch();
    expect(screen.getByRole("switch", { name: "Bots message each other" })).toBe(toggle());
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(tip()).toContain("adds Hermes's instructions for it to every Bot Chat's prompt");

    let whileSaving: [string | null, boolean] | undefined;
    server.beforeConfigure = () => (whileSaving = [toggle().getAttribute("aria-checked"), toggle().disabled]);
    await user.click(toggle());
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
    // Still off, and busy, while the write was on its way.
    expect(whileSaving).toEqual(["false", true]);
    expect(server.profileMeta.default?.ui_meta).toEqual({ "hermes-bots": {} });
    expect(server.messageAgentOffered("hermes-bot")).toBe(true);
    await waitFor(() => expect(toast()).toBe("Bots can now message each other from their Bot Chats."));

    await user.click(toggle());
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("false"));
    expect(server.profileMeta.default?.ui_meta).toBeUndefined();
    await waitFor(() => expect(toast()).toBe("Bots can no longer message each other."));
  });

  it("is on while a bot is pinned, names that bot, and turning it off sends nothing", async () => {
    const { server, user } = await launch(pinned);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    const why = "Stays on while Quill has bot settings saved in Hermes, such as a name, a color or a pin. Turning it off would remove them.";
    expect(tip()).toBe(why);
    await user.click(toggle());
    await waitFor(() => expect(toast()).toBe(why));
    expect(configures(server)).toEqual([]);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(server.profileMeta.quill?.ui_meta).toEqual({ "hermes-bots": { title: "Quill", pinned: true } });
  });

  it("is off, with why, on a Hermes older than 0.23", async () => {
    const { server, user } = await launch((s) => (s.health = { ...s.health, version: "0.22.9", displayVersion: "0.22.9" }));
    // The app reads Hermes's version a moment after connecting (`CHECK_DELAY_MS`).
    await waitFor(() => expect(toggle().disabled).toBe(true), { timeout: 5_000 });
    expect(tip()).toBe("This Hermes is older than 0.23, which is the first with a way for bots to message each other.");
    await user.click(toggle());
    expect(configures(server)).toEqual([]);
  });

  it("is off, with why, while the app isn't connected", async () => {
    const { server } = await launch();
    server.refuse = "Connection refused";
    await act(async () => server.drop());
    await waitFor(() => expect(toggle().disabled).toBe(true));
    expect(tip()).toBe("Not connected");
  });

  it("says why nothing changed on a Hermes without profiles.configure, and is off from then on", async () => {
    const { server, user } = await launch();
    server.handlers["profiles.configure"] = (r) => server.fail(r.id, -32601, "unknown method: profiles.configure");
    await user.click(toggle());
    const why = "This Hermes server can't do this: it has no route for profiles.configure. Updating Hermes adds it.";
    await waitFor(() => expect(toast()).toBe(`Bot messaging wasn't changed. ${why}`));
    await waitFor(() => expect(toggle().disabled).toBe(true));
    expect(tip()).toBe(why);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });
});
