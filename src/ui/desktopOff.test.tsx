// @vitest-environment jsdom
// A Bot Chat whose bot has desktop control off says so, and Turn on does what Settings → Toolsets does (ADR 0227): the
// cautions wait for the owner, a change counts only once Hermes reads it back, and a failure keeps the note with Hermes's reason.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BOT_CHAT_TITLE } from "../hermes/bots";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { en } from "../i18n/en";
import { LocaleContext, type Locale } from "../i18n/locale";
import { pseudoLocale, untranslated } from "../i18n/pseudo";
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

const w = en.chat.computerUse.desktopOff;
const LABEL = "Computer Use (macOS/Windows/Linux)";
let launches = 0;

/** The default profile's Bot Chat open in Bots mode, with a plain chat beside it. */
async function openBotChat(setup: (server: FakeHermes) => void = () => {}, locale?: Locale) {
  const server = new FakeHermes();
  server.sessions = [row("side", 1, { pinned: true, title: "Disk usage" }), row("hermes-bot", 2, { title: BOT_CHAT_TITLE, hidden: true })];
  server.transcripts = { side: [{ role: "user", text: "How full is the disk?" }], "hermes-bot": [{ role: "user", text: "Tidy the desktop." }] };
  setup(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  const app = <Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `lena@desktop-off-${++launches}`, url: "", username: "lena" }} onSignOut={async () => {}} />;
  render(locale ? <LocaleContext value={locale}>{app}</LocaleContext> : app);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  const user = userEvent.setup();
  const show = async (mode: "chats" | "bots") => {
    await user.click(document.querySelector<HTMLElement>(`.sidebar [role=tab][data-mode="${mode}"]`)!);
    if (mode === "bots") await user.click(await waitFor(() => document.querySelector<HTMLElement>('.sb-bots .bots-row[data-profile="default"] .bots-open')!));
    else {
      await waitFor(() => expect([...document.querySelectorAll(".sidebar .row-title")].map((e) => e.textContent)).toContain("Disk usage"));
      await user.click(screen.getByText("Disk usage"));
    }
    await act(async () => void (await hermes.idle()));
  };
  await show("bots");
  return { server, hermes, user, show };
}

const note = () => document.querySelector<HTMLElement>(".cu-banner");
const words = () => note()?.textContent ?? "";
const button = (name: string) => screen.getByRole("button", { name });
const writes = (server: FakeHermes) => server.toolsetWrites.filter((x) => x.name === "computer_use");
const ready = (server: FakeHermes) => void (server.toolsetProviders.computer_use = [{ name: "cua-driver (background)", post_setup: "cua_driver", status: "ready", is_active: true }]);

describe("a Bot Chat whose bot has desktop control off", () => {
  it("says so above the composer, with Turn on and Not now", async () => {
    await openBotChat();
    await waitFor(() => expect(words()).toContain(w.text));
    expect(button(w.turnOn)).toBeTruthy();
    expect(button(w.notNow)).toBeTruthy();
  });

  it("says nothing when it is on", async () => {
    await openBotChat((s) => s.enabledToolsets("default").add("computer_use"));
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(note()).toBeNull();
  });

  it("says nothing in a chat that isn't a Bot Chat", async () => {
    const { show } = await openBotChat();
    await waitFor(() => expect(words()).toContain(w.text));
    await show("chats");
    expect(note()).toBeNull();
  });

  it("shows the install caution first, and sends nothing until Turn on anyway", async () => {
    const { server, user } = await openBotChat();
    await user.click(await screen.findByRole("button", { name: w.turnOn }));
    await waitFor(() => expect(words()).toContain(w.ask));
    expect(words()).toContain(en.toolsets.caution.install("cua_driver", LABEL));
    expect(writes(server)).toEqual([]);

    await user.click(button(w.anyway));
    await waitFor(() => expect(words()).toContain(w.on));
    expect(writes(server)).toEqual([{ profile: "default", name: "computer_use", enabled: true }]);
    expect(words()).toContain(w.installing("cua_driver"));
    expect(screen.queryByRole("button", { name: w.turnOn })).toBeNull();
  });

  it("keeps it off, and sends nothing, on Keep it off", async () => {
    const { server, user } = await openBotChat();
    await user.click(await screen.findByRole("button", { name: w.turnOn }));
    await user.click(await screen.findByRole("button", { name: w.keepOff }));
    expect(words()).toContain(w.text);
    expect(writes(server)).toEqual([]);
  });

  it("turns it on at once when nothing needs confirming", async () => {
    const { server, user } = await openBotChat(ready);
    await user.click(await screen.findByRole("button", { name: w.turnOn }));
    await waitFor(() => expect(words()).toContain(w.on));
    expect(words()).not.toContain(w.ask);
    expect(writes(server)).toHaveLength(1);
    expect(words()).not.toContain("installing");
  });

  it("hides on Not now, and shows again when the Bot Chat is opened again", async () => {
    const { user, show } = await openBotChat();
    await user.click(await screen.findByRole("button", { name: w.notNow }));
    expect(note()).toBeNull();
    await show("chats");
    await show("bots");
    await waitFor(() => expect(words()).toContain(w.text));
  });

  it("goes without writing when another client turned it on before the click", async () => {
    const { server, user } = await openBotChat();
    await user.click(await screen.findByRole("button", { name: w.turnOn }));
    await waitFor(() => expect(words()).toContain(w.ask));
    server.enabledToolsets("default").add("computer_use");
    await user.click(button(w.anyway));
    await waitFor(() => expect(note()).toBeNull());
    expect(writes(server)).toEqual([]);
  });

  it("keeps the note, with Hermes's reason, when Hermes refuses", async () => {
    const { server, user } = await openBotChat(ready);
    server.toolsetRefusal = { status: 403, detail: "toolsets are locked" };
    await user.click(await screen.findByRole("button", { name: w.turnOn }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("toolsets are locked"));
    expect(words()).toContain(w.text);
    expect(button(w.turnOn)).toBeTruthy();
    expect(words()).not.toContain(w.on);
  });

  it("keeps the note, saying Hermes still reads it as off, when something else decides it", async () => {
    const { server, user } = await openBotChat(ready);
    server.toolsetSuppressed.add("computer_use");
    await user.click(await screen.findByRole("button", { name: w.turnOn }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(w.mismatch));
    expect(button(w.turnOn)).toBeTruthy();
  });

  it("shows no note when the toolsets can't be read", async () => {
    await openBotChat((s) => (s.toolsetRoutes = "none"));
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(note()).toBeNull();
  });

  it("reads again when the window comes back, and goes once it is on", async () => {
    const { server } = await openBotChat();
    await waitFor(() => expect(words()).toContain(w.text));
    server.enabledToolsets("default").add("computer_use");
    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(note()).toBeNull());
  });

  it("says only catalogue words, in each state", async () => {
    const p = pseudoLocale();
    const { user } = await openBotChat(undefined, p);
    const d = p.chat.computerUse.desktopOff;
    await waitFor(() => expect(words()).toContain(d.text));
    expect(untranslated(note()!)).toEqual([]);
    await user.click(button(d.turnOn));
    await waitFor(() => expect(words()).toContain(d.ask));
    expect(untranslated(note()!)).toEqual([]);
    await user.click(button(d.anyway));
    await waitFor(() => expect(words()).toContain(d.on));
    expect(untranslated(note()!)).toEqual([]);
  });
});
