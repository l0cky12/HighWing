// @vitest-environment jsdom
// Watch live on a bot's Bot Desktop (issue #143). Hermes's computer use starts a stopped screen inside its own call, so
// the Screen asks Hermes again when it is shown and after each call, rather than offering Start on a screen that runs.
// A Start Hermes refuses shows Hermes's words with a Try again that never starts a running screen, and nothing asked
// for one bot's screen shows on another's.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BOT_CHAT_TITLE } from "../hermes/bots";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@novnc/novnc", () => ({ default: class {} }));

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

/** What Hermes says when `display.start` can't get the profile's terminal sandbox (tools/bot_desktop/runtime.py). */
const SANDBOX = "the terminal backend's sandbox could not be started, so there is nowhere to put the screen";
const WATCHING = "Watching: Hermes is in control.";
let launches = 0;

const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));
const screenTab = () => document.getElementById("panel-tab-screen")!;
const panelText = () => document.getElementById("panel-screen")?.textContent ?? "";
const startButton = () => screen.queryByRole("button", { name: /Start the screen/ });
const asked = (server: FakeHermes, method: string) => server.requests.filter((r) => r.method === method);

/** Signed in to `default`, its Bot Chat open in Bots mode, with Scribe in `scribe`. Hermes's screen is stopped. */
async function botChat(setup: (server: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.display = {
    status: { supported: true, installed: true, missing: [], running: false, geometry: "1440x900", placement: "terminal:docker" },
    lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 },
    minted: new Set(),
    profiles: { scribe: { geometry: "1024x768" } },
  };
  server.sessions = [row("hermes-bot", 1, { title: BOT_CHAT_TITLE, hidden: true })];
  server.otherProfiles = { scribe: [row("scribe-bot", 0.01, { title: BOT_CHAT_TITLE, hidden: true })] };
  server.transcripts = { "hermes-bot": [{ role: "user", text: "Tidy the desktop." }], "scribe-bot": [{ role: "user", text: "Draft the notes." }] };
  server.profileMeta = { scribe: { ui_meta: { "hermes-bots": { title: "Scribe", color: "#44aa77" } } } };
  setup(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `lena@watch-live-${++launches}`, url: "", username: "lena" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await settle(hermes);
  await act(async () => void (await hermes.checkOtherProfiles()));
  const user = userEvent.setup();
  const openBot = async (profile: string) => {
    await user.click(document.querySelector<HTMLElement>('.sidebar [role=tab][data-mode="bots"]')!);
    await user.click(await waitFor(() => document.querySelector<HTMLElement>(`.sb-bots .bots-row[data-profile="${profile}"] .bots-open`)!));
    await waitFor(() => expect(hermes.profile).toBe(profile));
    await settle(hermes);
  };
  await openBot("default");
  // Hermes's events reach the Bot Chat once it is resumed.
  await waitFor(() => expect(server.runtimeIdOf("hermes-bot")).toBeTruthy());
  await settle(hermes);
  const say = async (type: string, payload: Record<string, unknown> = {}) => {
    act(() => server.event(server.runtimeIdOf("hermes-bot")!, type, payload));
    await settle(hermes);
  };
  const calls = { begin: (id: string) => say("tool.start", { tool_id: id, name: "computer_use", context: "", args: { action: "capture", mode: "som" } }) };
  /** A call ends; with `starts`, Hermes brought the screen up inside it, as `ensure_started_for_tool` does. */
  const end = (id: string, starts = false) => {
    if (starts) server.display!.status.running = true;
    return say("tool.complete", { tool_id: id, name: "computer_use", duration_s: 0.5, result: { ok: true } });
  };
  const watchLive = async () => {
    await user.click(screen.getAllByRole("button", { name: /Watch live/ }).at(-1)!);
    await settle(hermes);
  };
  const openScreen = async () => {
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    await user.click(await screen.findByRole("button", { name: /^Screen/ }));
    await settle(hermes);
  };
  return { server, hermes, user, say, begin: calls.begin, end, watchLive, openScreen, openBot };
}

describe("Watch live on a bot's Bot Desktop", () => {
  it("shows the screen Hermes's computer use started after the Screen first read it stopped, and never starts it", async () => {
    const { server, say, begin, end, watchLive } = await botChat();
    await say("message.start");
    await begin("c1");
    await watchLive();
    await waitFor(() => expect(startButton()).toBeTruthy());

    await end("c1", true);
    await waitFor(() => expect(panelText()).toContain(WATCHING));
    expect(startButton()).toBeNull();
    expect(asked(server, "display.start")).toEqual([]);
  });

  it("asks again when Watch live shows a Screen that was made earlier and has been hidden since", async () => {
    const { server, user, say, begin, end, watchLive } = await botChat();
    await say("message.start");
    await begin("c1");
    await watchLive();
    await waitFor(() => expect(startButton()).toBeTruthy());
    await user.click(document.getElementById("panel-tab-files")!);

    await end("c1", true);
    expect(screenTab().getAttribute("aria-selected")).toBe("false");
    await watchLive();
    await waitFor(() => expect(panelText()).toContain(WATCHING));
    expect(asked(server, "display.start")).toEqual([]);
  });

  it("shows Hermes's own words when its sandbox can't start, and Try again starts only a screen that still isn't running", async () => {
    const { server, hermes, user, openScreen } = await botChat((s) => {
      s.handlers["display.start"] = (r) => s.fail(r.id, 5300, SANDBOX);
    });
    await openScreen();
    await user.click(await waitFor(() => startButton()!));
    await settle(hermes);

    const failure = await screen.findByRole("alert");
    expect(failure.textContent).toMatch(/^Hermes couldn't start .+'s screen/);
    expect(failure.textContent).toContain(SANDBOX);
    expect(asked(server, "display.start")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /Try again/ }));
    await settle(hermes);
    expect(asked(server, "display.start")).toHaveLength(2);
    expect((await screen.findByRole("alert")).textContent).toContain(SANDBOX);

    // The agent's computer use brought the screen up meanwhile: Try again watches it and sends no start.
    server.display!.status.running = true;
    const before = server.requests.length;
    await user.click(screen.getByRole("button", { name: /Try again/ }));
    await settle(hermes);
    await waitFor(() => expect(panelText()).toContain(WATCHING));
    expect(server.requests.slice(before).map((r) => r.method)).not.toContain("display.start");
    expect(panelText()).not.toContain(SANDBOX);
  });

  it("offers Start again when the screen stopped since it was shown", async () => {
    const { server, hermes, user, openScreen } = await botChat((s) => void (s.display!.status.running = true));
    await openScreen();
    await waitFor(() => expect(panelText()).toContain(WATCHING));
    await user.click(document.getElementById("panel-tab-files")!);

    server.display!.status.running = false;
    await user.click(screenTab());
    await settle(hermes);
    await waitFor(() => expect(startButton()).toBeTruthy());
    expect(panelText()).not.toContain(WATCHING);
  });

  it("offers Start when Hermes says the screen runs but it has stopped by the time the Screen attaches", async () => {
    const { server, hermes, openScreen } = await botChat((s) => {
      const real = s.handlers["display.status"];
      let once = true;
      s.handlers["display.status"] = (r) => {
        if (!once) return real(r);
        once = false;
        s.respond(r.id, { ...s.display!.status, running: true, lease: s.display!.lease, profile_key: "/home/lena/.hermes" });
      };
    });
    await openScreen();
    await settle(hermes);
    await waitFor(() => expect(startButton()).toBeTruthy());
    expect(asked(server, "display.observe").length).toBeGreaterThan(0);
    expect(asked(server, "display.start")).toEqual([]);
  });

  it("keeps a late answer about one bot's screen off the next bot's Screen", async () => {
    const { server, hermes, user, openScreen, openBot } = await botChat();
    await openScreen();
    await waitFor(() => expect(startButton()).toBeTruthy());
    await user.click(document.getElementById("panel-tab-files")!);

    const real = server.handlers["display.status"];
    const held: (() => void)[] = [];
    server.handlers["display.status"] = (r) => {
      if (r.params.profile !== "default") return real(r);
      held.push(() => server.respond(r.id, { ...server.display!.status, blocker: "Only the default bot's screen is blocked.", lease: server.display!.lease, profile_key: "/home/lena/.hermes" }));
    };
    await user.click(screenTab());
    await waitFor(() => expect(held).toHaveLength(1));

    await openBot("scribe");
    if (screenTab().getAttribute("aria-selected") !== "true") await user.click(screenTab());
    await waitFor(() => expect(panelText()).toContain("1024x768"));
    act(() => held.splice(0).forEach((answer) => answer()));
    await settle(hermes);
    expect(panelText()).toContain("1024x768");
    expect(panelText()).not.toContain("Only the default bot's screen");
    expect(startButton()).toBeTruthy();
  });

  it("keeps a late failed Start for one bot off the next bot's Screen", async () => {
    const { server, hermes, user, openScreen, openBot } = await botChat();
    const failures: (() => void)[] = [];
    server.handlers["display.start"] = (r) => void failures.push(() => server.fail(r.id, 5300, SANDBOX));
    await openScreen();
    await user.click(await waitFor(() => startButton()!));
    await waitFor(() => expect(failures).toHaveLength(1));

    await openBot("scribe");
    if (screenTab().getAttribute("aria-selected") !== "true") await user.click(screenTab());
    await waitFor(() => expect(panelText()).toContain("1024x768"));
    act(() => failures.splice(0).forEach((fail) => fail()));
    await settle(hermes);
    expect(panelText()).not.toContain(SANDBOX);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(startButton()).toBeTruthy();
  });
});
