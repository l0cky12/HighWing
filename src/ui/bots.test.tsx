// @vitest-environment jsdom
// The bots in the running app, against a fake Hermes as the deployed f0d94882 (ADR 0066): what each bot's row shows,
// that a row opens the bot's Bot Chat in its profile and keeps it out of the chat list, that the pen starts an ordinary
// chat there, that /new in a Bot Chat compacts it, that the chat list panel shows the chats or the bots as the owner
// picks with the switch at its top (ADR 0195), that a Hermes without Bot Mode has no switch, New bot and Reload above
// the bots, and each bot's menu (ADR 0194, ADR 0203): Chat, Settings (Edit bot), Edit persona… (ADR 0206), Clone, Pin,
// Hide and Delete.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { RestError } from "../hermes/pipe";
import { BOT_CHAT_TITLE } from "../hermes/bots";
import { botSetupBrief, botSetupMarkerId } from "../hermes/botSetupBrief";
import { botSetupBegin } from "../hermes/botSetupStart";
import { getUIPrefs } from "../hermes/uiPrefs";
import { BOTS_REFRESH_MS } from "./Bots";
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
  // Nothing the view does may send a Bot Mode write that Hermes wouldn't check against another client's (ADR 0189).
  for (const server of servers.splice(0)) expect(server.uncheckedConfigures()).toEqual([]);
});

let launches = 0;
const nowS = () => Date.now() / 1000;

/** Signed in to `default`, with Scribe in `scribe`: its Bot Chat holds one exchange and is replying again. */
async function launch(setup: (server: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.sessions = [row("disk", 0.5, { pinned: true, title: "Disk usage", last_read_at: nowS() })];
  server.otherProfiles = {
    scribe: [
      row("scribe-bot", 0.01, { title: BOT_CHAT_TITLE, hidden: true, last_read_at: nowS() }),
      row("scribe-side", 1, { pinned: true, title: "Changelog wording", last_read_at: nowS() }),
    ],
  };
  server.transcripts = {
    disk: [{ role: "user", text: "How full is the disk?" }],
    "scribe-bot": [
      { role: "user", text: "Draft the release notes for 0.9" },
      { role: "assistant", text: "Release notes drafted: three fixes." },
    ],
    "scribe-side": [{ role: "user", text: "Which wording reads better?" }],
  };
  server.profileMeta = { scribe: { description: "Writes release notes", ui_meta: { "hermes-bots": { title: "Scribe", color: "#44aa77" } } } };
  server.liveSessions = [{ id: "rt-s", session_key: "scribe-bot", status: "working", last_active: nowS() - 5 }];
  setup(server);
  servers.push(server);
  const cache = memoryCache();
  const hermes = await connect(server.openPipe, undefined, cache);
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `lena@hermes-${++launches}`, url: "", username: "lena" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  await act(async () => void (await hermes.checkOtherProfiles()));
  return { server, hermes, cache, user: userEvent.setup() };
}

/** Bots mode's part of the chat list panel: New bot and Reload, then the bots' rows. */
const bots = () => document.querySelector<HTMLElement>(".sidebar .sb-bots")!;
const botRows = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".sidebar .sb-bots .bots-open"));
const modeTab = (name: "Chats" | "Bots") => within(document.querySelector<HTMLElement>(".sidebar")!).getByRole("tab", { name: new RegExp(`^${name}`) });
const listTitles = () => [...document.querySelectorAll(".sidebar .row-title")].map((e) => e.textContent);
const toast = () => document.querySelector<HTMLElement>(".toast")?.textContent;
const SETUP_ID = "c0ffee00-0000-4000-8000-000000000001";
const titleLookups = (server: FakeHermes) => server.requests.filter((r) => r.method === "session.list" && r.params.title !== undefined).map((r) => r.params.title);

async function pickProfile(user: ReturnType<typeof userEvent.setup>, profile: string) {
  await user.click(document.querySelector<HTMLElement>(".profile-btn")!);
  await user.click(await screen.findByRole("option", { name: new RegExp(`^${profile}`) }));
}

/** Picks Bots mode, and waits for `count` bots. */
async function showBots(user: ReturnType<typeof userEvent.setup>, count = 2) {
  await user.click(modeTab("Bots"));
  await waitFor(() => expect(botRows().length).toBe(count));
}

/**
 * Holds each `GET /api/profiles` the dialogs read as they open, until the test answers it: `answer(i)` sends Hermes's
 * answer to the i-th held read, `refuse(i)` fails it. The roster is read another way, so it isn't held.
 */
function holdProfileReads(server: FakeHermes) {
  const route = "GET /api/profiles";
  const real = server.rest[route];
  const held: { go: () => void; fail: () => void }[] = [];
  server.rest[route] = (req) =>
    new Promise((resolve, reject) => held.push({ go: () => resolve(real(req)), fail: () => reject(new Error("The connection was reset.")) }));
  return {
    held,
    answer: (i: number) => act(async () => held[i].go()),
    refuse: (i: number) => act(async () => held[i].fail()),
    release: () => void (server.rest[route] = real),
  };
}

/** Holds each new connection to a profile `hold` names until its `release`, as a slow dial does. Set before connecting. */
function holdDials(server: FakeHermes) {
  const open = server.openPipe;
  const held: { profile: string; go: () => void }[] = [];
  const holding = new Set<string>();
  server.openPipe = (onEvent, profile, signal) =>
    holding.has(profile)
      ? new Promise((resolve, reject) => held.push({ profile, go: () => void open(onEvent, profile, signal).then(resolve, reject) }))
      : open(onEvent, profile, signal);
  return {
    hold: (...profiles: string[]) => profiles.forEach((p) => holding.add(p)),
    waiting: (profile: string) => held.some((h) => h.profile === profile),
    release: (profile: string) =>
      act(async () => {
        holding.delete(profile);
        for (const h of held.filter((x) => x.profile === profile)) {
          held.splice(held.indexOf(h), 1);
          h.go();
        }
      }),
  };
}

describe("A bot's row", () => {
  it("lists every profile as a bot, with its Bot Chat's last message, what it is doing, and its description as its name's tip", async () => {
    const { user } = await launch();
    await showBots(user);
    const [hermesRow, scribeRow] = botRows();
    expect(within(hermesRow).getByText("Hermes")).toBeTruthy();
    expect(within(hermesRow).getByText("No Bot Chat yet. Open it to start one.")).toBeTruthy();
    expect(within(scribeRow).getByText("Scribe").getAttribute("title")).toBe("Writes release notes");
    expect(within(scribeRow).getByText("Release notes drafted: three fixes.")).toBeTruthy();
    expect(within(scribeRow).getByText("Replying")).toBeTruthy();
    expect(scribeRow.getAttribute("aria-label")).toMatch(/^Scribe\. Replying\. Writes release notes\. Last message: Release notes drafted/);
    expect(screen.getByRole("button", { name: "New chat with Scribe" })).toBeTruthy();
  });

  it("opens a bot's Bot Chat in its profile, and keeps it out of the chat list", async () => {
    const { server, hermes, user } = await launch();
    await showBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(hermes.profile).toBe("scribe"));
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    // Looked up by title, not created.
    expect(titleLookups(server)).toEqual([BOT_CHAT_TITLE]);
    expect(server.requests.filter((r) => r.method === "session.create")).toEqual([]);
    expect(hermes.getSnapshot().chats.find((c) => c.id === "scribe-bot")?.bot).toBe(true);
    expect(listTitles()).toEqual([]);
  });

  it("marks the open Bot Chat as one, and offers nothing that would rename, retire or link it by id", async () => {
    const { user } = await launch();
    await showBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    const head = document.querySelector<HTMLElement>(".chat-head")!;
    expect(within(head).getByText("Bot Chat")).toBeTruthy();
    expect(within(head).queryByText("Settled")).toBeNull();
    await user.click(within(head).getByRole("button", { name: "More" }));
    const menu = screen.getByRole("menu", { name: /More actions for Bot Chat/ });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Export…", "Share snapshot…"]);
  });

  it("starts a Bot Chat once for a bot without one, and sends nothing", async () => {
    const { server, hermes, user } = await launch();
    await showBots(user);
    await user.click(botRows()[0]);
    await waitFor(() => expect(server.sessions.some((s) => s.title === BOT_CHAT_TITLE && s.hidden)).toBe(true));
    expect(server.requests.filter((r) => r.method === "session.create")).toHaveLength(1);
    expect(server.requests.filter((r) => r.method === "prompt.submit")).toEqual([]);
    const id = server.sessions.find((s) => s.title === BOT_CHAT_TITLE)!.id;
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === id)?.bot).toBe(true));
  });

  it("starts an ordinary chat in the bot's profile from the pen", async () => {
    const { server, hermes, user } = await launch();
    await showBots(user);
    await user.click(screen.getByRole("button", { name: "New chat with Scribe" }));
    await waitFor(() => expect(hermes.profile).toBe("scribe"));
    await waitFor(() => expect(screen.getByText("What should Scribe work on?")).toBeTruthy());
    expect(titleLookups(server)).toEqual([]);
  });

  it("compacts a Bot Chat for /new instead of starting a new chat", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await showBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "scribe-bot")?.runtimeId).toBeTruthy());
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>(/Message/);
    await user.click(composer);
    await user.keyboard("/new{Enter}{Enter}");
    await waitFor(() => expect(screen.getByText(/A Bot Chat is one continuous conversation, so \/new compacts it/)).toBeTruthy());
    expect(server.requests.filter((r) => r.method === "session.compress")).toHaveLength(1);
    expect(screen.queryByText("What should Hermes work on?")).toBeNull();
  });
});

describe("New bot in Bots mode", () => {
  const dialog = () => screen.getByRole("dialog", { name: "New bot" });
  const at0232 = (s: FakeHermes) => {
    s.health = { ...s.health, version: "0.23.2", displayVersion: "0.23.2" };
    s.status = { ...s.status, version: "0.23.2" };
  };
  /** What was written to Hermes's profiles over REST. The Bot Mode name goes over the socket: `titleOf` reads it. */
  const writes = (server: FakeHermes) =>
    server.restRequests.filter((r) => r.method !== "GET" && r.path.startsWith("/api/profiles")).map((r) => [`${r.method} ${r.path}`, r.body]);
  const starts = (server: FakeHermes) => server.requests.filter((r) => r.method === "session.create" || r.method === "prompt.submit");
  const briefs = (server: FakeHermes) => server.requests.filter((r) => r.method === "session.create" && Array.isArray(r.params.messages));
  const titleOf = (server: FakeHermes, profile: string) => (server.profileMeta[profile]?.ui_meta?.["hermes-bots"] as { title?: string } | undefined)?.title;
  async function named(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(within(bots()).getByRole("button", { name: "New bot" }));
    await user.type(within(dialog()).getByLabelText("Name"), name);
  }

  it("asks only for a name: no path opens the profile form without a profile", async () => {
    const { user } = await launch();
    await showBots(user);
    await user.click(within(bots()).getByRole("button", { name: "New bot" }));
    expect(within(dialog()).getAllByRole("textbox").map((t) => t.getAttribute("id") && document.querySelector(`label[for="${t.id}"]`)?.textContent)).toEqual(["Name"]);
    for (const field of [/Description/, /Model/, /Persona/, /Skills/, /Tools/]) expect(within(dialog()).queryByText(field)).toBeNull();
  });

  it("on Hermes 0.23.2, Create makes the bot from the name, names it in Bot Mode, opens its Bot Chat as a visit and starts Bot setup there", async () => {
    const { server, hermes, user } = await launch(at0232);
    await act(async () => void (await hermes.capabilities.refresh()));
    await showBots(user);
    await named(user, "Travel Buddy");
    await user.click(within(dialog()).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(server.requests.some((r) => r.method === "prompt.submit")).toBe(true));
    expect(screen.queryByRole("dialog", { name: "New bot" })).toBeNull();
    expect(writes(server)).toEqual([["POST /api/profiles", { name: "travel-buddy" }]]);
    expect(titleOf(server, "travel-buddy")).toBe("Travel Buddy");
    expect(hermes.profile).toBe("travel-buddy");

    const [create] = briefs(server);
    expect(create.params).toMatchObject({ profile: "travel-buddy", title: BOT_CHAT_TITLE, messages: [{ role: "user", display_kind: "hidden" }] });
    const brief = String((create.params.messages as { content: string }[])[0].content);
    const id = botSetupMarkerId(brief)!;
    expect(brief).toContain('You are "Travel Buddy"');
    expect(brief).not.toMatch(/mcpCatalog|MCP catalog/);
    expect(server.requests.filter((r) => r.method === "prompt.submit").map((r) => r.params)).toEqual([{ session_id: expect.any(String), profile: "travel-buddy", text: botSetupBegin(id), display_kind: "hidden" }]);

    const chat = await waitFor(() => {
      const c = hermes.getSnapshot().chats.find((c) => c.bot && c.title === BOT_CHAT_TITLE);
      expect(c).toBeDefined();
      return c!;
    });
    const sid = String(server.last("prompt.submit")!.params.session_id);
    await act(async () => {
      server.event(sid, "message.start");
      server.event(sid, "message.delta", { text: "Hi, I'm Travel Buddy. What should I call you?" });
      server.storeMessage(chat.id, { role: "assistant", text: "Hi, I'm Travel Buddy. What should I call you?" });
      server.event(sid, "message.complete", { text: "Hi, I'm Travel Buddy. What should I call you?", status: "complete" });
    });
    await waitFor(() => expect(document.querySelector(".msg.assistant")?.textContent).toContain("Hi, I'm Travel Buddy. What should I call you?"));
    expect(document.querySelector(".msg.user")).toBeNull();
    await waitFor(() => expect(botRows().find((r) => r.querySelector(".bots-name")?.textContent === "Travel Buddy")?.getAttribute("aria-current")).toBe("true"));
  });

  it("right after Create, a begin turn Hermes fails shows Hermes's words on the Setup started line, and Try again sends the begin turn again", async () => {
    const { server, hermes, user } = await launch(at0232);
    await act(async () => void (await hermes.capabilities.refresh()));
    await showBots(user);
    await named(user, "Travel Buddy");
    await user.click(within(dialog()).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(server.requests.some((r) => r.method === "prompt.submit")).toBe(true));
    const begin = server.last("prompt.submit")!.params;
    await act(async () => {
      server.event(String(begin.session_id), "message.start");
      server.event(String(begin.session_id), "error", { message: "No API key for openrouter." });
    });
    const line = (await screen.findByText("Setup didn't start", undefined, { timeout: 5000 })).closest<HTMLElement>(".bot-setup-line")!;
    expect(line.textContent).toContain("Hermes said: No API key for openrouter.");
    await user.click(within(line).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(server.requests.filter((r) => r.method === "prompt.submit").map((r) => r.params.text)).toEqual([begin.text, begin.text]));
  });

  it("an ordinary open of a Bot Chat that holds a brief with no begin turn sends the begin turn once", async () => {
    const { server, hermes, user } = await launch((s) => {
      at0232(s);
      s.liveSessions = [];
      s.transcripts["scribe-bot"] = [{ role: "user", text: botSetupBrief({ id: SETUP_ID, name: "Scribe", inventory: { models: [], skills: [], toolsets: [], bots: [] } }), display_kind: "hidden", row_id: 1 }];
    });
    await showBots(user);
    await user.click(botRows().find((r) => r.querySelector(".bots-name")?.textContent === "Scribe")!);
    await waitFor(() => expect(server.requests.filter((r) => r.method === "prompt.submit").map((r) => r.params.text)).toEqual([botSetupBegin(SETUP_ID)]));
    await act(async () => void (await hermes.idle()));
    expect(server.requests.filter((r) => r.method === "prompt.submit")).toHaveLength(1);
    expect(briefs(server)).toEqual([]);
  });

  it("when Create's answer is lost and the list can't be read either, offers Check again, which reads and never makes a second bot", async () => {
    const { server, hermes, user } = await launch(at0232);
    const post = server.rest["POST /api/profiles"];
    const get = server.rest["GET /api/profiles"];
    let unreadable = 0;
    server.rest["POST /api/profiles"] = (req) => {
      post(req);
      unreadable = 1;
      throw new Error("The connection was reset.");
    };
    server.rest["GET /api/profiles"] = (req) => {
      if (unreadable-- > 0) throw new Error("The connection was reset.");
      return get(req);
    };
    await act(async () => void (await hermes.capabilities.refresh()));
    await showBots(user);
    await named(user, "Ada");
    await user.click(within(dialog()).getByRole("button", { name: "Create" }));
    const check = await within(dialog()).findByRole("button", { name: "Check again" });
    expect(within(dialog()).getByRole("alert").textContent).toMatch(/Check again reads Hermes's profiles to see whether it made ada, and doesn't make another\.$/);
    expect(within(dialog()).queryByRole("button", { name: "Create" })).toBeNull();
    await user.click(check);
    await waitFor(() => expect(hermes.profile).toBe("ada"));
    expect(writes(server)).toEqual([["POST /api/profiles", { name: "ada" }]]);
    expect(titleOf(server, "ada")).toBe("Ada");
    await waitFor(() => expect(server.requests.filter((r) => r.method === "prompt.submit")).toHaveLength(1));
  });

  it("when the bots can't be read after Create, keeps the made bot and opens it on Check again without making another", async () => {
    const { server, hermes, user } = await launch(at0232);
    await act(async () => void (await hermes.capabilities.refresh()));
    const configure = server.handlers["profiles.configure"];
    const bots = hermes.bots.bind(hermes);
    let unreadable = false;
    server.handlers["profiles.configure"] = (r) => {
      unreadable = true;
      configure(r);
    };
    vi.spyOn(hermes, "bots").mockImplementation(() => {
      if (!unreadable) return bots();
      unreadable = false;
      return Promise.reject(new Error("The connection was reset."));
    });
    await showBots(user);
    await named(user, "Ada");
    await user.click(within(dialog()).getByRole("button", { name: "Create" }));
    const check = await within(dialog()).findByRole("button", { name: "Check again" });
    expect(within(dialog()).getByRole("alert").textContent).toMatch(/^Made ada, but the bots couldn't be read to open it\./);
    expect(hermes.profile).toBe("default");
    await user.click(check);
    await waitFor(() => expect(hermes.profile).toBe("ada"));
    expect(screen.queryByRole("dialog", { name: "New bot" })).toBeNull();
    expect(writes(server)).toEqual([["POST /api/profiles", { name: "ada" }]]);
    await waitFor(() => expect(server.requests.filter((r) => r.method === "prompt.submit")).toHaveLength(1));
  });

  it("waits for Hermes's version before starting Bot setup, so a Create right after connecting to 0.23.1 asks nothing", async () => {
    let versionRead = () => {};
    const { server, hermes, user } = await launch((s) => {
      s.health = { ...s.health, version: "0.23.1", displayVersion: "0.23.1" };
      s.status = { ...s.status, version: "0.23.1" };
      const gate = new Promise<void>((r) => (versionRead = r));
      for (const route of ["GET /api/health", "GET /api/status"] as const) {
        const real = s.rest[route];
        s.rest[route] = async (req) => {
          await gate;
          return real(req);
        };
      }
    });
    await showBots(user);
    expect(hermes.capabilities.getSnapshot().facts.version).toBeUndefined();
    await named(user, "Ada");
    await user.click(within(dialog()).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(writes(server)).toEqual([["POST /api/profiles", { name: "ada" }]]));
    await act(async () => versionRead());
    await waitFor(() => expect(hermes.profile).toBe("ada"), { timeout: 5000 });
    await waitFor(() => expect(hermes.getSnapshot().chats.some((c) => c.bot && c.title === BOT_CHAT_TITLE)).toBe(true));
    await act(async () => void (await hermes.idle()));
    expect(briefs(server)).toEqual([]);
    expect(server.requests.filter((r) => r.method === "prompt.submit")).toEqual([]);
  });

  it("when the app goes offline before Hermes's version is read, keeps the made bot for Check again instead of waiting", async () => {
    const { server, hermes, user } = await launch((s) => {
      for (const route of ["GET /api/health", "GET /api/status"] as const) s.rest[route] = () => new Promise(() => {});
    });
    await showBots(user);
    await named(user, "Ada");
    await user.click(within(dialog()).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(writes(server)).toEqual([["POST /api/profiles", { name: "ada" }]]));
    server.refuse = "Wrong username or password.";
    act(() => server.drop());
    await waitFor(() => expect(hermes.getSnapshot().status).toBe("offline"), { timeout: 5000 });
    await within(dialog()).findByRole("button", { name: "Check again" });
    expect(within(dialog()).getByRole("alert").textContent).toMatch(/^Made ada, but/);
    expect(within(dialog()).getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", false);
    expect(hermes.profile).toBe("default");
    expect(briefs(server)).toEqual([]);
  });

  it("below Hermes 0.23.2, makes the bot from the name and the model in use, and opens its Bot Chat with no brief", async () => {
    const { server, hermes, user } = await launch((s) => {
      s.health = { ...s.health, version: "0.23.1", displayVersion: "0.23.1" };
      s.status = { ...s.status, version: "0.23.1" };
      s.profileModel.default = { model: "gpt-6.1", provider: "openai", reasoning_effort: "", fast: false };
    });
    await showBots(user);
    await act(async () => void (await hermes.capabilities.refresh()));
    await named(user, "Ada");
    expect(within(dialog()).getByText(/^This Hermes is older than 0\.23\.2/)).toBeTruthy();
    await user.click(within(dialog()).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(hermes.profile).toBe("ada"));
    await waitFor(() => expect(hermes.getSnapshot().chats.some((c) => c.bot && c.title === BOT_CHAT_TITLE)).toBe(true));
    expect(writes(server)).toEqual([["POST /api/profiles", { name: "ada", provider: "openai", model: "gpt-6.1" }]]);
    expect(titleOf(server, "ada")).toBe("Ada");
    await act(async () => void (await hermes.idle()));
    expect(briefs(server)).toEqual([]);
    expect(server.requests.filter((r) => r.method === "prompt.submit")).toEqual([]);
  });

  it("Start blank makes the bot and opens its Bot Chat empty, with no brief, on a Hermes that runs Bot setup", async () => {
    const { server, hermes, user } = await launch(at0232);
    await showBots(user);
    await named(user, "Ada");
    await user.click(within(dialog()).getByRole("button", { name: /^Skip/ }));
    await user.click(screen.getByRole("menuitem", { name: /Start blank/ }));
    await waitFor(() => expect(hermes.profile).toBe("ada"));
    await waitFor(() => expect(hermes.getSnapshot().chats.some((c) => c.bot && c.title === BOT_CHAT_TITLE)).toBe(true));
    await act(async () => void (await hermes.idle()));
    expect(writes(server)).toEqual([["POST /api/profiles", { name: "ada" }]]);
    expect(briefs(server)).toEqual([]);
    await user.click(botRows().find((r) => r.querySelector(".bots-name")?.textContent === "Scribe")!);
    await waitFor(() => expect(hermes.profile).toBe("scribe"));
    await user.click(botRows().find((r) => r.querySelector(".bots-name")?.textContent === "Ada")!);
    await waitFor(() => expect(hermes.profile).toBe("ada"));
    await act(async () => void (await hermes.idle()));
    expect(starts(server).filter((r) => r.method === "prompt.submit")).toEqual([]);
  });

  it("Copy a bot opens Clone profile with the name filled in, and makes nothing itself", async () => {
    const { server, user } = await launch();
    await showBots(user);
    await named(user, "Scribe Two");
    await user.click(within(dialog()).getByRole("button", { name: /^Skip/ }));
    await user.click(screen.getByRole("menuitem", { name: /Copy a bot/ }));
    const clone = await screen.findByRole("dialog", { name: /Clone/ });
    expect(within(clone).getByLabelText("New profile's name")).toHaveProperty("value", "scribe-two");
    expect(screen.queryByRole("dialog", { name: "New bot" })).toBeNull();
    expect(writes(server)).toEqual([]);
  });

  it("closes only the dialog on Escape, with focus back on New bot", async () => {
    const { user } = await launch();
    await showBots(user);
    await user.click(within(bots()).getByRole("button", { name: "New bot" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "New bot" })).toBeNull();
    expect(botRows()).toHaveLength(2);
    expect(document.activeElement).toBe(within(bots()).getByRole("button", { name: "New bot" }));
  });

  it("is off, with Reload, while the app isn't connected, and says why", async () => {
    const { server, user } = await launch();
    await showBots(user);
    server.refuse = "Connection refused";
    await act(async () => server.drop());
    const make = within(bots()).getByRole("button", { name: "New bot" });
    await waitFor(() => expect(make).toHaveProperty("disabled", true));
    expect(make.title).toBe("Not connected to Hermes.");
    expect(within(bots()).getByRole("button", { name: "Reload bots" })).toHaveProperty("disabled", true);
    expect(botRows()).toHaveLength(2);
  });
});

describe("Reload in Bots mode", () => {
  const names = () => botRows().map((r) => r.querySelector(".bots-name")?.textContent);
  const reload = () => within(bots()).getByRole("button", { name: "Reload bots" });

  it("reads the bots again now, busy while it reads", async () => {
    const { server, user } = await launch();
    await showBots(user);
    const list = server.handlers["profiles.list"];
    const held: (() => void)[] = [];
    server.handlers["profiles.list"] = (r) => void held.push(() => list(r));
    (server.profileMeta.scribe.ui_meta!["hermes-bots"] as { title: string }).title = "Quill";
    await user.click(reload());
    await waitFor(() => expect(held).toHaveLength(1));
    expect(reload().getAttribute("aria-disabled")).toBe("true");
    expect(names()).toEqual(["Hermes", "Scribe"]);
    server.handlers["profiles.list"] = list;
    await act(async () => held.splice(0).forEach((f) => f()));
    await waitFor(() => expect(names()).toEqual(["Hermes", "Quill"]));
    expect(reload().getAttribute("aria-disabled")).toBeNull();
  });

  it("says why a read failed, keeps the bots read last, and clears the note once a read succeeds", async () => {
    const { server, user } = await launch();
    await showBots(user);
    const list = server.handlers["profiles.list"];
    server.handlers["profiles.list"] = (r) => server.fail(r.id, -32000, "profiles are locked");
    await user.click(reload());
    expect((await within(bots()).findByRole("alert")).textContent).toBe("Couldn't read the bots: profiles are locked");
    expect(names()).toEqual(["Hermes", "Scribe"]);
    server.handlers["profiles.list"] = list;
    await user.click(reload());
    await waitFor(() => expect(within(bots()).queryByRole("alert")).toBeNull());
  });
});

describe("Edit bot, Edit persona, Clone, Pin and Hide from a bot's menu", { timeout: 30_000 }, () => {
  const rowOf = (profile: string) => bots().querySelector<HTMLElement>(`.bots-row[data-profile="${profile}"]`)!;
  const names = () => botRows().map((r) => r.querySelector(".bots-name")?.textContent);
  const block = (server: FakeHermes, profile = "scribe") => server.profileMeta[profile]?.ui_meta?.["hermes-bots"] as Record<string, unknown>;
  const writes = (server: FakeHermes) => server.restRequests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
  const sent = (server: FakeHermes, method: string) => server.requests.filter((r) => r.method === method);
  const menuOf = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await user.pointer({ keys: "[MouseRight]", target: botRows().find((r) => r.querySelector(".bots-name")?.textContent === name)! });
    return screen.getByRole("menu", { name: `More for ${name}` });
  };
  const pickFrom = async (user: ReturnType<typeof userEvent.setup>, name: string, entry: string) => user.click(within(await menuOf(user, name)).getByRole("menuitem", { name: entry }));
  /** Scribe's block as Hermes's desktop keeps it, with keys this app never edits. */
  const DESKTOP_KEYS = { sectionId: "s1", groups: ["drafts"], shape: "blob", futureKey: { n: 1 } };
  const withDesktopKeys = (s: FakeHermes) => {
    s.profileMeta.scribe = { description: "Writes release notes", ui_meta: { "hermes-bots": { title: "Scribe", color: "#44aa77", ...DESKTOP_KEYS } } };
    s.uiMetaRevisions.scribe = { "hermes-bots": 2 };
  };
  const editBot = async (user: ReturnType<typeof userEvent.setup>) => {
    await pickFrom(user, "Scribe", "Settings");
    return screen.findByRole("dialog", { name: "Edit bot: Scribe" });
  };

  it("pins and unpins a bot in Hermes, moving its row, and keeps what Hermes's desktop wrote beside it", async () => {
    const { server, user } = await launch(withDesktopKeys);
    await showBots(user);
    expect(names()).toEqual(["Hermes", "Scribe"]);
    await pickFrom(user, "Scribe", "Pin");
    await waitFor(() => expect(names()).toEqual(["Scribe", "Hermes"]));
    expect(block(server)).toEqual({ title: "Scribe", color: "#44aa77", ...DESKTOP_KEYS, pinned: true });
    await pickFrom(user, "Scribe", "Unpin");
    await waitFor(() => expect(names()).toEqual(["Hermes", "Scribe"]));
    expect(block(server)).toEqual({ title: "Scribe", color: "#44aa77", ...DESKTOP_KEYS, pinned: false });
  });

  it("hides a bot behind Hidden in Hermes, with focus on that fold, and shows it again", async () => {
    const { server, user } = await launch(withDesktopKeys);
    await showBots(user);
    botRows()[1].focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    await user.click(within(screen.getByRole("menu", { name: "More for Scribe" })).getByRole("menuitem", { name: "Hide" }));
    const fold = await within(bots()).findByRole("button", { name: "Hidden in Hermes (1)" });
    expect(names()).toEqual(["Hermes"]);
    expect(block(server)).toEqual({ title: "Scribe", color: "#44aa77", ...DESKTOP_KEYS, hidden: true });
    await waitFor(() => expect(document.activeElement).toBe(fold));
    await user.click(fold);
    await pickFrom(user, "Scribe", "Show");
    await waitFor(() => expect(within(bots()).queryByRole("button", { name: /Hidden in Hermes/ })).toBeNull());
    expect(names()).toEqual(["Hermes", "Scribe"]);
    expect(block(server).hidden).toBe(false);
  });

  it("turns off only Pin and Hide on a Hermes without profiles.configure, and says which method is missing", async () => {
    const { server, user } = await launch();
    server.handlers["profiles.configure"] = (r) => server.fail(r.id, -32601, "unknown method: profiles.configure");
    await showBots(user);
    await pickFrom(user, "Scribe", "Pin");
    const why = "This Hermes server can't do this: it has no route for profiles.configure. Updating Hermes adds it.";
    await waitFor(() => expect(toast()).toBe(`Scribe wasn't changed. ${why}`));
    const menu = await menuOf(user, "Scribe");
    const disabled = within(menu).getAllByRole("menuitem").filter((i) => i.getAttribute("aria-disabled") === "true");
    expect(disabled.map((i) => i.textContent)).toEqual(["Pin", "Hide"]);
    expect(within(menu).getAllByText(why)).toHaveLength(2);
    await user.click(within(menu).getByRole("menuitem", { name: "Pin" }));
    expect(sent(server, "profiles.configure")).toHaveLength(1);
    expect(names()).toEqual(["Hermes", "Scribe"]);
  });

  it("Edit bot changes the name, color and description, each read back into the row", async () => {
    const { server, user } = await launch(withDesktopKeys);
    await showBots(user);
    const dialog = await editBot(user);
    const name = within(dialog).getByLabelText("Name in Bot Mode");
    expect(document.activeElement).toBe(name);
    await user.clear(name);
    await user.type(name, "Writer");
    fireEvent.change(within(dialog).getByLabelText("Color"), { target: { value: "#ff8800" } });
    await user.clear(within(dialog).getByLabelText("Description"));
    await user.type(within(dialog).getByLabelText("Description"), "Drafts the changelog");
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull());
    expect(block(server)).toEqual({ title: "Writer", color: "#ff8800", ...DESKTOP_KEYS, custom: true });
    expect(server.profileMeta.scribe.description).toBe("Drafts the changelog");
    expect(writes(server)).toEqual(["PUT /api/profiles/scribe/description"]);
    await waitFor(() => expect(names()).toEqual(["Hermes", "Writer"]));
    expect(rowOf("scribe").querySelector(".bots-name")!.getAttribute("title")).toBe("Drafts the changelog");
    expect(rowOf("scribe").querySelector<HTMLElement>(".bots-face")!.style.background).toBe("rgb(255, 136, 0)");
    expect(toast()).toBe("Saved scribe.");
  });

  it("Edit bot shows Hermes's new name and stays open when the name changed elsewhere", async () => {
    const { server, user } = await launch(withDesktopKeys);
    await showBots(user);
    const dialog = await editBot(user);
    server.writeBotAsOtherClient("scribe", { title: "Quill" });
    const name = within(dialog).getByLabelText("Name in Bot Mode");
    await user.clear(name);
    await user.type(name, "Writer");
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    expect(await within(dialog).findByText("Changed elsewhere since you opened this. Hermes has “Quill” now. Save again to replace it.")).toBeTruthy();
    expect(block(server).title).toBe("Quill");
    expect(sent(server, "profiles.configure")).toEqual([]);
    expect(name).toHaveProperty("value", "Writer");
    expect(screen.getByRole("dialog", { name: "Edit bot: Scribe" })).toBeTruthy();
    // The row behind the dialog already shows what Hermes has.
    expect(names()).toEqual(["Hermes", "Quill"]);

    await user.click(within(dialog).getByRole("button", { name: "Use Hermes's" }));
    expect(name).toHaveProperty("value", "Quill");
    expect(within(dialog).queryByText(/Changed elsewhere/)).toBeNull();
    // Nothing is left to save, so the dialog closes without a question and nothing is written.
    expect(within(dialog).getByRole("button", { name: /Save changes/ })).toHaveProperty("disabled", true);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull();
    expect(sent(server, "profiles.configure")).toEqual([]);
    expect(block(server)).toEqual({ title: "Quill", color: "#44aa77", ...DESKTOP_KEYS });
  });

  it("Edit bot replaces a name changed elsewhere only on a second Save, once the owner has seen it", async () => {
    const { server, user } = await launch(withDesktopKeys);
    await showBots(user);
    const dialog = await editBot(user);
    server.writeBotAsOtherClient("scribe", { title: "Quill", sectionId: "s2" });
    await user.clear(within(dialog).getByLabelText("Name in Bot Mode"));
    await user.type(within(dialog).getByLabelText("Name in Bot Mode"), "Writer");
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    await within(dialog).findByText(/Hermes has “Quill” now/);
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull());
    expect(block(server)).toEqual({ title: "Writer", color: "#44aa77", ...DESKTOP_KEYS, sectionId: "s2" });
  });

  it("Edit bot sets and removes the bot's picture, shown in its row", async () => {
    const { server, user } = await launch(withDesktopKeys);
    await showBots(user);
    const dialog = await editBot(user);
    const bytes = Uint8Array.from("\x89PNG\r\n\x1a\nface", (c) => c.charCodeAt(0));
    const url = `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
    await user.upload(within(dialog).getByLabelText("Choose a picture…", { selector: "input" }), new File([bytes], "face.png", { type: "image/png" }));
    await waitFor(() => expect(dialog.querySelector(".profile-picture img")?.getAttribute("src")).toBe(url));
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull());
    expect(server.botAvatars.scribe).toBe(url);
    expect(block(server)).toEqual({ title: "Scribe", color: "#44aa77", ...DESKTOP_KEYS, custom: true, imageKind: "photo" });
    await waitFor(() => expect(rowOf("scribe").querySelector("img")?.getAttribute("src")).toBe(url));

    const again = await editBot(user);
    await user.click(within(again).getByRole("button", { name: "Remove picture" }));
    await user.click(within(again).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull());
    expect(server.botAvatars).toEqual({});
    expect(block(server).imageKind).toBe("shape");
    await waitFor(() => expect(rowOf("scribe").querySelector("img")).toBeNull());
  });

  it("Edit bot refuses a picture Hermes wouldn't store, before sending it", async () => {
    const { server, user } = await launch();
    await showBots(user);
    const dialog = await editBot(user);
    const input = within(dialog).getByLabelText("Choose a picture…", { selector: "input" });
    fireEvent.change(input, { target: { files: [new File(["GIF89a"], "face.gif", { type: "image/gif" })] } });
    expect(await within(dialog).findByText("Hermes takes PNG, JPEG or WebP pictures.")).toBeTruthy();
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(2_000_001)], "big.png", { type: "image/png" })] } });
    expect(await within(dialog).findByText("That picture is over 2 MB, the most Hermes stores.")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Save changes/ })).toHaveProperty("disabled", true);
    expect(sent(server, "profiles.set_asset")).toEqual([]);
  });

  it("Edit bot renames the profile last, as Settings → Profiles does, and its row follows with its look", async () => {
    // A profile with a reply running can't be renamed, so Scribe is idle here.
    const { server, hermes, user } = await launch((s) => {
      withDesktopKeys(s);
      s.liveSessions = [];
    });
    await showBots(user);
    const dialog = await editBot(user);
    await user.clear(within(dialog).getByLabelText("Name in Bot Mode"));
    await user.type(within(dialog).getByLabelText("Name in Bot Mode"), "Writer");
    await user.clear(within(dialog).getByLabelText("Profile name"));
    await user.type(within(dialog).getByLabelText("Profile name"), "quill");
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull());
    // The look is written under the old name, then the profile is renamed.
    expect(sent(server, "profiles.configure").map((r) => r.params.name)).toEqual(["scribe"]);
    expect(writes(server)).toEqual(["PATCH /api/profiles/scribe"]);
    expect(block(server, "quill")).toEqual({ title: "Writer", color: "#44aa77", ...DESKTOP_KEYS });
    await waitFor(() => expect(rowOf("quill")).toBeTruthy());
    expect(names()).toEqual(["Hermes", "Writer"]);
    expect(toast()).toBe("Renamed scribe to quill.");
    expect(hermes.profile).toBe("default");
  });

  it("Edit bot says so when Hermes no longer has the profile, and opens nothing", async () => {
    const { server, user } = await launch();
    await showBots(user);
    delete server.otherProfiles.scribe;
    await pickFrom(user, "Scribe", "Settings");
    await waitFor(() => expect(toast()).toBe("Hermes no longer has scribe. Another client may have renamed or deleted it."));
    expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull();
    await waitFor(() => expect(names()).toEqual(["Hermes"]));
  });

  it("Clone… opens the Clone dialog with this bot as the source", async () => {
    const { user } = await launch();
    await showBots(user);
    await pickFrom(user, "Scribe", "Clone…");
    const dialog = await screen.findByRole("dialog", { name: "Clone a profile" });
    await waitFor(() => expect(within(dialog).getByLabelText("From")).toHaveProperty("value", "scribe"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Clone a profile" })).toBeNull());
    expect(botRows()).toHaveLength(2);
  });

  const SOUL = "You are Scribe. You draft release notes.\n";
  const withSoul = (s: FakeHermes) => (s.souls.scribe = SOUL);
  const personaOf = (dialog: HTMLElement) => within(dialog).getByLabelText<HTMLTextAreaElement>("Persona");
  const loaded = async (dialog: HTMLElement) => {
    await waitFor(() => expect(personaOf(dialog).disabled).toBe(false));
    return personaOf(dialog);
  };

  it("Edit persona… opens Edit bot with the bot's SOUL.md in Persona, focused", async () => {
    const { user } = await launch(withSoul);
    await showBots(user);
    await pickFrom(user, "Scribe", "Edit persona…");
    const dialog = await screen.findByRole("dialog", { name: "Edit bot: Scribe" });
    const persona = await loaded(dialog);
    expect(persona.value).toBe(SOUL);
    await waitFor(() => expect(document.activeElement).toBe(persona));
  });

  it("Edit bot saves a changed persona as the bot's SOUL.md, and writes none when it's unchanged", async () => {
    const { server, user } = await launch(withSoul);
    await showBots(user);
    let dialog = await editBot(user);
    await loaded(dialog);
    await user.clear(within(dialog).getByLabelText("Description"));
    await user.type(within(dialog).getByLabelText("Description"), "Drafts the changelog");
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull());
    expect(writes(server)).toEqual(["PUT /api/profiles/scribe/description"]);

    dialog = await editBot(user);
    const persona = await loaded(dialog);
    await user.type(persona, "Keep it short.");
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull());
    expect(server.souls.scribe).toBe(`${SOUL}Keep it short.`);
    expect(writes(server)).toEqual(["PUT /api/profiles/scribe/description", "PUT /api/profiles/scribe/soul"]);
    expect(toast()).toBe("Saved scribe.");
  });

  it("Edit bot writes nothing over a persona changed elsewhere, and offers Hermes's", async () => {
    const { server, user } = await launch(withSoul);
    await showBots(user);
    const dialog = await editBot(user);
    const persona = await loaded(dialog);
    await user.type(persona, "Mine.");
    server.souls.scribe = "Theirs.\n";
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/^The persona changed elsewhere since you opened this\./);
    expect(server.souls.scribe).toBe("Theirs.\n");
    expect(writes(server)).toEqual([]);
    expect(persona.value).toBe(`${SOUL}Mine.`);
    await user.click(within(dialog).getByRole("button", { name: "Use Hermes's" }));
    expect(persona.value).toBe("Theirs.\n");
    expect(within(dialog).getByRole("button", { name: /Save changes/ })).toHaveProperty("disabled", true);
    await user.type(persona, "Again.");
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull());
    expect(server.souls.scribe).toBe("Theirs.\nAgain.");
  });

  it("Use Hermes's drops a rewrite still on its way, so its answer can't replace Hermes's persona", async () => {
    const { server, user } = await launch(withSoul);
    await showBots(user);
    const dialog = await editBot(user);
    const persona = await loaded(dialog);
    await user.type(persona, "Mine.");
    server.souls.scribe = "Theirs.\n";
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    await within(dialog).findByRole("button", { name: "Use Hermes's" });
    let go = () => {};
    server.oneshotGate = new Promise<void>((r) => (go = r));
    server.oneshotAnswer = "A rewrite of mine.";
    const write = within(dialog).getByRole("button", { name: /Write with AI/ });
    await waitFor(() => expect(write.getAttribute("aria-disabled")).toBeNull());
    await user.click(write);
    await within(dialog).findByRole("button", { name: "Stop" });
    await user.click(within(dialog).getByRole("button", { name: "Use Hermes's" }));
    await act(async () => go());
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(persona.value).toBe("Theirs.\n");
  });

  it("Edit bot's Undo is off while Save runs, so the screen can't show other text than the one saved", async () => {
    const { server, user } = await launch((s) => {
      withSoul(s);
      s.oneshotAnswer = "You are Scribe. Draft release notes in plain words.";
    });
    await showBots(user);
    const dialog = await editBot(user);
    await loaded(dialog);
    const write = within(dialog).getByRole("button", { name: /Write with AI/ });
    await waitFor(() => expect(write.getAttribute("aria-disabled")).toBeNull());
    await user.click(write);
    const undo = await within(dialog).findByRole("button", { name: "Undo" });
    let go = () => {};
    const gate = new Promise<void>((r) => (go = r));
    server.rest["PUT /api/profiles/scribe/soul"] = async (req) => {
      await gate;
      server.souls.scribe = String(req.body?.content);
      return { ok: true };
    };
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    expect(undo).toHaveProperty("disabled", true);
    await user.click(undo);
    go();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull());
    expect(server.souls.scribe).toBe("You are Scribe. Draft release notes in plain words.");
  });

  it("Edit bot's Write with AI rewrites the persona in place on the model that writes for the bot, with Undo", async () => {
    const { server, user } = await launch((s) => {
      withSoul(s);
      s.oneshotAnswer = "You are Scribe. Draft release notes in plain words.";
    });
    await showBots(user);
    const dialog = await editBot(user);
    const persona = await loaded(dialog);
    const write = within(dialog).getByRole("button", { name: /Write with AI/ });
    await waitFor(() => expect(write.getAttribute("aria-disabled")).toBeNull());
    expect(document.getElementById(write.getAttribute("aria-describedby")!)?.textContent).toMatch(/^scribe writes with openrouter · deepseek-v4-flash, its Text generation model, pinned on the server\./);
    await user.click(write);
    await waitFor(() => expect(persona.value).toBe("You are Scribe. Draft release notes in plain words."));
    expect(server.requests.filter((r) => r.method === "llm.oneshot").map((r) => [r.params.profile, r.params.input])).toEqual([["scribe", expect.stringContaining(`<persona>${SOUL}</persona>`)]]);
    await user.click(within(dialog).getByRole("button", { name: "Undo" }));
    expect(persona.value).toBe(SOUL);
    await user.click(within(dialog).getByRole("button", { name: /Write with AI/ }));
    await waitFor(() => expect(persona.value).toBe("You are Scribe. Draft release notes in plain words."));
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull());
    expect(server.souls.scribe).toBe("You are Scribe. Draft release notes in plain words.");
  });

  it("Edit bot's Stop leaves the persona as it was, and Save waits while the rewrite runs", async () => {
    const { server, user } = await launch(withSoul);
    await showBots(user);
    const dialog = await editBot(user);
    const persona = await loaded(dialog);
    let go = () => {};
    server.oneshotGate = new Promise<void>((r) => (go = r));
    await user.type(persona, "Short.");
    const write = within(dialog).getByRole("button", { name: /Write with AI/ });
    await waitFor(() => expect(write.getAttribute("aria-disabled")).toBeNull());
    await user.click(write);
    await waitFor(() => expect(persona.readOnly).toBe(true));
    const save = within(dialog).getByRole("button", { name: /Save changes/ });
    expect(save).toHaveProperty("disabled", true);
    expect(save.getAttribute("title")).toBe("Wait for the persona's rewrite, or stop it, first.");
    await user.click(within(dialog).getByRole("button", { name: "Stop" }));
    await act(async () => go());
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(persona.value).toBe(`${SOUL}Short.`);
    expect(persona.readOnly).toBe(false);
    expect(save).toHaveProperty("disabled", false);
  });

  it("Edit bot says why the persona couldn't be read, keeps it off, and reads it again on Try again", async () => {
    const { server, user } = await launch((s) => {
      withSoul(s);
      s.soulReadError = new RestError(500, `{"detail":"disk on fire"}`);
    });
    await showBots(user);
    const dialog = await editBot(user);
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/^Couldn't read the persona, so it can't be changed here: .*disk on fire/);
    expect(personaOf(dialog).disabled).toBe(true);
    server.soulReadError = undefined;
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect((await loaded(dialog)).value).toBe(SOUL);
  });
});

describe("Picking Bots mode", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgo=";
  const names = () => botRows().map((r) => r.querySelector(".bots-name")?.textContent);
  const picture = (i: number) => botRows()[i].querySelector("img")?.getAttribute("src");
  /** Holds every later `profiles.list` until `release`, so Bots mode can show only what the app already read. */
  function holdRosters(server: FakeHermes) {
    const list = server.handlers["profiles.list"];
    const held: (() => void)[] = [];
    server.handlers["profiles.list"] = (r) => void held.push(() => list(r));
    return () => {
      server.handlers["profiles.list"] = list;
      held.splice(0).forEach((f) => f());
    };
  }

  it("shows the bots and their pictures at once after connecting, before Hermes answers again", async () => {
    const { server, user } = await launch((s) => (s.botAvatars = { scribe: PNG }));
    holdRosters(server);
    await user.click(modeTab("Bots"));
    expect(names()).toEqual(["Hermes", "Scribe"]);
    expect(picture(1)).toBe(PNG);
    expect(screen.queryByText("Reading the bots…")).toBeNull();
  });

  it("shows them at once on picking it again, and doesn't ask for the pictures again on the same connection", async () => {
    const { server, hermes, user } = await launch((s) => (s.botAvatars = { scribe: PNG }));
    await showBots(user);
    await user.click(modeTab("Chats"));
    expect(botRows()).toEqual([]);
    const release = holdRosters(server);
    await user.click(modeTab("Bots"));
    expect(names()).toEqual(["Hermes", "Scribe"]);
    expect(picture(1)).toBe(PNG);
    await act(async () => release());
    await act(async () => void (await hermes.idle()));
    expect(server.requests.filter((r) => r.method === "profiles.get_asset")).toHaveLength(1);
  });

  it("shows the roster read last, then a change on the server once it is read again", async () => {
    const { server, user } = await launch();
    const scribe = server.profileMeta.scribe.ui_meta!["hermes-bots"] as { title: string };
    scribe.title = "Quill";
    const release = holdRosters(server);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await user.click(modeTab("Bots"));
      expect(names()).toEqual(["Hermes", "Scribe"]);
      await act(async () => release());
      await waitFor(() => expect(names()).toEqual(["Hermes", "Quill"]));
      scribe.title = "Inkwell";
      await act(async () => void vi.advanceTimersByTime(BOTS_REFRESH_MS));
      await waitFor(() => expect(names()).toEqual(["Hermes", "Inkwell"]));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Bots mode", () => {
  const panel = () => document.querySelector<HTMLElement>(".sidebar")!;
  const ago = (days: number) => nowS() - days * 86_400;

  async function launchMany() {
    const env = await launch((s) => {
      s.sessions = [
        row("a1", 0.1, { pinned: true, title: "Backup failing", last_read_at: ago(0.2) }),
        row("a2", 0.2, { pinned: true, title: "Disk usage", last_read_at: ago(0.1) }),
        ...[1, 2, 3, 4, 5, 6].map((i) => row(`s${i}`, i, { title: `Settled ${i}`, last_read_at: ago(0) })),
      ];
      s.transcripts = { ...s.transcripts, s6: [{ role: "user", text: "The oldest settled chat" }] };
    });
    await env.user.click(within(panel()).getByRole("tab", { name: /^Bots/ }));
    await waitFor(() => expect(panel().querySelector(".bots-row")).toBeTruthy());
    return env;
  }

  it("draws each bot as its name and last message, with the pen beside it, and no ⋯", async () => {
    await launchMany();
    const scribe = panel().querySelector<HTMLElement>('.bots-row[data-profile="scribe"]')!;
    expect(scribe.querySelector(".bots-name")?.textContent).toBe("Scribe");
    expect(scribe.querySelector(".bots-preview")?.textContent).toBe("Release notes drafted: three fixes.");
    expect(within(scribe).getByRole("button", { name: "New chat with Scribe" })).toBeTruthy();
    expect(scribe.querySelector(".bots-more")).toBeNull();
  });
});

describe("Chats mode", () => {
  const panel = () => document.querySelector<HTMLElement>(".sidebar")!;
  const line = () => panel().querySelector<HTMLElement>(".sb-needs-you");
  const botChatButtons = () => within(panel()).queryAllByRole("button", { name: /Bot Chat/ });
  const shownMode = () => within(panel()).getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")?.textContent;
  const waiting = (key: string, id = "rt-s") => ({ id, session_key: key, status: "waiting" as const, last_active: nowS() });

  it("lays out the switch, the profile switcher, New chat and Search, then the project switcher and the chats, with no Bot Chat row between", async () => {
    await launch();
    const order = [".sb-mode", ".sb-profile", ".sb-actions", ".sb-project", ".sb-scroll"].map((sel) => panel().querySelector(sel));
    expect(order.every(Boolean)).toBe(true);
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel().querySelector(".sb-actions")!.nextElementSibling).toBe(panel().querySelector(".sb-project"));
    expect(botChatButtons()).toEqual([]);
  });

  it("shows no needs-you line while no bot in another profile needs the owner", async () => {
    await launch();
    expect(line()).toBeNull();
    const slot = panel().querySelector<HTMLElement>(".sb-needs-you-slot")!;
    expect(slot.getAttribute("aria-live")).toBe("polite");
    expect(slot.getAttribute("role")).toBeNull();
  });

  it("names the one bot that needs the owner, with its last message, and opens its Bot Chat in its profile", async () => {
    const { hermes, user } = await launch((s) => (s.liveSessions = [waiting("scribe-bot")]));
    await waitFor(() => expect(line()).toBeTruthy());
    expect(line()!.textContent).toBe("SScribe needs youRelease notes drafted: three fixes.");
    expect(line()!.title).toBe("Open Scribe's Bot Chat");
    await user.click(line()!);
    await waitFor(() => expect(hermes.profile).toBe("scribe"));
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    expect(shownMode()).toBe("Chats");
  });

  it("asks first, as the bot's row does, when switching would leave something behind", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = [waiting("scribe-bot")]));
    await waitFor(() => expect(line()).toBeTruthy());
    await user.click(screen.getByText("Disk usage"));
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "disk")?.runtimeId).toBeTruthy());
    await act(async () => void server.askApproval(server.runtimeIdOf("disk")!));
    await user.click(line()!);
    const ask = await screen.findByRole("alertdialog", { name: "Switch to scribe?" });
    expect(ask.textContent).toMatch(/An approval is waiting in default/);
    await user.keyboard("{Escape}");
    expect(ask.isConnected).toBe(false);
    expect(hermes.profile).toBe("default");
    await user.click(line()!);
    await user.click(screen.getByRole("button", { name: "Switch to scribe" }));
    await waitFor(() => expect(hermes.profile).toBe("scribe"));
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
  });

  it("names several bots that need the owner, and picks Bots on a click", async () => {
    const { user } = await launch((s) => {
      s.otherProfiles.ops = [row("ops-bot", 0.01, { title: BOT_CHAT_TITLE, hidden: true })];
      s.profileMeta.ops = { ui_meta: { "hermes-bots": { title: "Ops" } } };
      s.liveSessions = [waiting("scribe-bot"), waiting("ops-bot", "rt-o")];
    });
    await waitFor(() => expect(line()?.textContent).toMatch(/^.2 bots need you/));
    expect(line()!.textContent).toMatch(/(Ops, Scribe|Scribe, Ops)$/);
    expect(line()!.title).toBe("Show the bots");
    await user.click(line()!);
    expect(shownMode()).toBe("Bots");
  });

  it("leaves out a bot hidden in Hermes", async () => {
    await launch((s) => {
      s.profileMeta.scribe = { ui_meta: { "hermes-bots": { title: "Scribe", hidden: true } } };
      s.liveSessions = [waiting("scribe-bot")];
    });
    expect(line()).toBeNull();
    expect(within(panel()).getByRole("tab", { name: /^Bots/ }).getAttribute("aria-label")).toBe("Bots");
  });

  it("leads the profile switcher with the bot's face and name, then its id, quieter", async () => {
    const { user } = await launch();
    const button = () => panel().querySelector<HTMLElement>(".sb-profile .profile-btn")!;
    expect(button().querySelector(".bots-face")?.textContent).toBe("H");
    expect(button().querySelector(".profile-name")?.textContent).toBe("Hermes");
    expect(button().querySelector(".profile-id")?.textContent).toBe("default");
    await pickProfile(user, "scribe");
    await waitFor(() => expect(button().querySelector(".profile-name")?.textContent).toBe("Scribe"));
    expect(button().querySelector(".profile-id")).toBeNull();
    expect((button().querySelector(".bots-face") as HTMLElement).style.background).toBe("rgb(68, 170, 119)");
  });

  it("names a profile without a bot name by its id made readable, once", async () => {
    const { user } = await launch((s) => (s.otherProfiles["hermes-chat"] = [row("hc-side", 1, { pinned: true, title: "Side chat" })]));
    await pickProfile(user, "hermes-chat");
    const button = panel().querySelector<HTMLElement>(".sb-profile .profile-btn")!;
    await waitFor(() => expect(button.querySelector(".profile-name")?.textContent).toBe("Hermes Chat"));
    expect(button.querySelector(".profile-id")).toBeNull();
  });

  it("keeps the Bot Chat out of the panel: no row for it, and none in the sections", async () => {
    await launch();
    await waitFor(() => expect(listTitles()).toEqual(["Disk usage"]));
    expect(botChatButtons()).toEqual([]);
  });

  it("shows the shown profile's bot waiting on the owner on its row in Bots mode, not on the needs-you line", async () => {
    const { user } = await launch((s) => (s.liveSessions = [waiting("scribe-bot")]));
    await pickProfile(user, "scribe");
    await user.click(within(panel()).getByRole("tab", { name: /^Bots/ }));
    await waitFor(() => expect(panel().querySelector('.bots-row[data-profile="scribe"]')?.textContent).toMatch(/Needs you/));
    await user.click(within(panel()).getByRole("tab", { name: /^Chats/ }));
    expect(within(panel()).getByRole("tab", { name: /^Bots/ }).getAttribute("aria-label")).toBe("Bots");
    expect(line()).toBeNull();
  });

  it("opens the shown profile's Bot Chat by Alt+B and stays in Chats, with no row for it in the panel", async () => {
    const { user } = await launch();
    await pickProfile(user, "scribe");
    await user.click(await screen.findByText("Changelog wording"));
    await user.keyboard("{Alt>}b{/Alt}");
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    expect(shownMode()).toBe("Chats");
    expect(botChatButtons()).toEqual([]);
    expect(panel().querySelector(".row.sel")).toBeNull();
  });
});

describe("The pane names the bot", () => {
  const head = () => document.querySelector<HTMLElement>(".chat-head .chat-title")!;
  const tabTitles = () => [...document.querySelectorAll(".tabs [role=tab]")].map((t) => t.textContent);

  async function openBotChatOf(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
    await showBots(user);
    await user.click(botRows().find((r) => name.test(r.textContent ?? ""))!);
  }

  it("heads a Bot Chat with its bot's face and name and a Bot Chat badge, and titles its tab with the name", async () => {
    const { user } = await launch();
    await openBotChatOf(user, /Scribe/);
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    expect(head().querySelector(".bots-face")?.textContent).toBe("S");
    expect(head().textContent).toBe("SScribeBot Chat");
    expect(tabTitles().some((t) => t?.startsWith("Scribe"))).toBe(true);
    expect(screen.getByPlaceholderText("Message Scribe")).toBeTruthy();
  });

  it("names a profile without a bot name by its id made readable", async () => {
    const { user } = await launch((s) => {
      s.otherProfiles["hermes-chat"] = [row("hc-bot", 0.01, { title: BOT_CHAT_TITLE, hidden: true })];
      s.transcripts = { ...s.transcripts, "hc-bot": [{ role: "user", text: "Ping" }] };
    });
    await showBots(user, 3);
    await user.click(botRows().find((r) => /Hermes Chat/.test(r.textContent ?? ""))!);
    await waitFor(() => expect(head().textContent).toBe("HHermes ChatBot Chat"));
    expect(screen.getByPlaceholderText("Message Hermes Chat")).toBeTruthy();
  });

  it("names the default profile by the display name saved for it", async () => {
    const { user } = await launch((s) => (s.profileMeta.default = { display_name: "Main" }));
    expect(screen.getByPlaceholderText("Message Main")).toBeTruthy();
    await openBotChatOf(user, /^M/);
    await waitFor(() => expect(head().textContent).toBe("MMainBot Chat"));
  });

  it("names the bot in every chat of its profile: the message box and an empty chat", async () => {
    const { user } = await launch();
    await pickProfile(user, "scribe");
    await waitFor(() => expect(screen.getByPlaceholderText("Message Scribe")).toBeTruthy());
    await user.keyboard("{Control>}n{/Control}");
    await waitFor(() => expect(screen.getByText("What should Scribe work on?")).toBeTruthy());
    await user.click(screen.getByText("Changelog wording"));
    await waitFor(() => expect(head().textContent).toMatch(/^Changelog wording/));
    expect(head().querySelector(".bots-face")).toBeNull();
  });

  it("says Hermes on a server without Bot Mode", async () => {
    const { hermes, user } = await launch((s) => (s.botMode = "none"));
    await act(async () => void (await hermes.capabilities.refresh()));
    await waitFor(() => expect(document.querySelector(".sidebar [role=tab]")).toBeNull());
    expect(screen.getByPlaceholderText("Message Hermes")).toBeTruthy();
    await user.keyboard("{Control>}n{/Control}");
    await waitFor(() => expect(screen.getByText("What should Hermes work on?")).toBeTruthy());
  });
});

describe("Alt+B", () => {
  const head = () => document.querySelector<HTMLElement>(".chat-head .chat-title")!;
  const altB = (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Alt>}b{/Alt}");

  it("opens the shown profile's Bot Chat from a chat, and goes back to that chat from it", async () => {
    const { server, user } = await launch((s) => (s.liveSessions = []));
    await user.click(screen.getByText("Disk usage"));
    await waitFor(() => expect(head().textContent).toMatch(/^Disk usage/));
    await altB(user);
    await waitFor(() => expect(head().textContent).toBe("HHermesBot Chat"));
    expect(server.sessions.filter((s) => s.title === BOT_CHAT_TITLE)).toHaveLength(1);
    await altB(user);
    await waitFor(() => expect(head().textContent).toMatch(/^Disk usage/));
    await altB(user);
    await waitFor(() => expect(head().textContent).toBe("HHermesBot Chat"));
    expect(server.sessions.filter((s) => s.title === BOT_CHAT_TITLE)).toHaveLength(1);
  });

  it("goes to New chat from a Bot Chat opened from elsewhere", async () => {
    const { user } = await launch((s) => (s.liveSessions = []));
    await showBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(head().textContent).toBe("SScribeBot Chat"));
    await altB(user);
    await waitFor(() => expect(screen.getByText("What should Scribe work on?")).toBeTruthy());
  });

  it("opens the Bot Chat of the profile picked in the switcher, and goes back to the chat left in it", async () => {
    const { user } = await launch((s) => (s.liveSessions = []));
    await pickProfile(user, "scribe");
    await user.click(await screen.findByText("Changelog wording"));
    await waitFor(() => expect(head().textContent).toMatch(/^Changelog wording/));
    await altB(user);
    await waitFor(() => expect(head().textContent).toBe("SScribeBot Chat"));
    await altB(user);
    await waitFor(() => expect(head().textContent).toMatch(/^Changelog wording/));
  });

  it("goes back to the chat left from the bot's own row in Bots mode too", async () => {
    const { user } = await launch((s) => (s.liveSessions = []));
    await user.click(screen.getByText("Disk usage"));
    await waitFor(() => expect(head().textContent).toMatch(/^Disk usage/));
    await user.click(within(document.querySelector<HTMLElement>(".sidebar")!).getByRole("tab", { name: /^Bots/ }));
    await user.click(await waitFor(() => document.querySelector<HTMLElement>('.sidebar .bots-row[data-profile="default"] .bots-open')!));
    await waitFor(() => expect(head().textContent).toBe("HHermesBot Chat"));
    await altB(user);
    await waitFor(() => expect(head().textContent).toMatch(/^Disk usage/));
  });

  it("forgets the chat before on a profile switch", async () => {
    const { user } = await launch((s) => (s.liveSessions = []));
    await user.click(screen.getByText("Disk usage"));
    await altB(user);
    await waitFor(() => expect(head().textContent).toBe("HHermesBot Chat"));
    await pickProfile(user, "scribe");
    await waitFor(() => expect(listTitles()).toEqual(["Changelog wording"]));
    await pickProfile(user, "default");
    await waitFor(() => expect(listTitles()).toEqual(["Disk usage"]));
    await showBots(user);
    await user.click(botRows()[0]);
    await waitFor(() => expect(head().textContent).toBe("HHermesBot Chat"));
    await altB(user);
    await waitFor(() => expect(screen.getByText("What should Hermes work on?")).toBeTruthy());
  });
});

describe("A Hermes without Bot Mode", () => {
  it("has no Bots tab once the check finds no profiles.list", async () => {
    const { hermes } = await launch((s) => (s.botMode = "none"));
    await act(async () => void (await hermes.capabilities.refresh()));
    await waitFor(() => expect(document.querySelector(".sidebar [role=tab]")).toBeNull());
  });

  it("has no Bots tab once the check finds a profiles.list that doesn't report Bot Chats", async () => {
    const { hermes } = await launch((s) => (s.botMode = "no-canonical"));
    await act(async () => void (await hermes.capabilities.refresh()));
    await waitFor(() => expect(document.querySelector(".sidebar [role=tab]")).toBeNull());
    expect(hermes.capabilities.get("botMode").why).toMatch(/doesn't report their Bot Chats/);
  });
});

describe("What the owner does while a Bot Chat opens", () => {
  /** Holds every `session.list` until `release`. */
  function holdLookups(server: FakeHermes) {
    const lookup = server.handlers["session.list"];
    const held: (() => void)[] = [];
    server.handlers["session.list"] = (r) => void held.push(() => lookup(r));
    return () => held.splice(0).forEach((f) => f());
  }

  it("keeps the chat the owner opened meanwhile, in the same profile", async () => {
    const { server, hermes, user } = await launch();
    const release = holdLookups(server);
    await showBots(user);
    await user.click(botRows()[0]);
    await waitFor(() => expect(server.requests.some((r) => r.method === "session.list")).toBe(true));
    await user.click(modeTab("Chats"));
    await user.click(screen.getByText("Disk usage"));
    await waitFor(() => expect(screen.getByText("How full is the disk?")).toBeTruthy());
    await act(async () => release());
    await waitFor(() => expect(server.sessions.some((s) => s.title === BOT_CHAT_TITLE)).toBe(true));
    // The Bot Chat was made, but the pane stays on the chat the owner picked.
    await act(async () => void (await hermes.idle()));
    expect(screen.getByText("How full is the disk?")).toBeTruthy();
    expect(document.querySelector(".chat-head")?.textContent).toMatch(/Disk usage/);
  });

  it("drops the open once the owner picks another profile before the bot's connection opens, even after coming back", async () => {
    let dials!: ReturnType<typeof holdDials>;
    const { server, hermes, user } = await launch((s) => (dials = holdDials(s)));
    dials.hold("scribe");
    await showBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(hermes.profile).toBe("scribe"));
    await user.click(modeTab("Chats"));
    await pickProfile(user, "default");
    await waitFor(() => expect(listTitles()).toEqual(["Disk usage"]));
    await dials.release("scribe");
    await pickProfile(user, "scribe");
    await waitFor(() => expect(listTitles()).toEqual(["Changelog wording"]));
    await act(async () => void (await hermes.idle()));
    // Coming back is an ordinary switch: no Bot Chat lookup, and the Bot Chat doesn't open.
    expect(titleLookups(server)).toEqual([]);
    expect(server.requests.filter((r) => r.method === "session.resume")).toEqual([]);
    expect(screen.queryByText("Draft the release notes for 0.9")).toBeNull();
  });
});

describe("A bot opened while its profile's connection opens (ADR 0232)", () => {
  const head = () => document.querySelector<HTMLElement>(".chat-head .chat-title")?.textContent;
  const rowOf = (name: string) => botRows().find((r) => r.querySelector(".bots-name")?.textContent === name)!;
  const current = () => botRows().map((r) => r.getAttribute("aria-current"));
  const resumed = (hermes: Hermes, id: string) => waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === id)?.runtimeId).toBeTruthy());
  const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));

  /** Coder, a second bot in a profile of its own, with a Bot Chat of one exchange. */
  function withCoder(s: FakeHermes) {
    s.otherProfiles.coder = [row("coder-bot", 0.02, { title: BOT_CHAT_TITLE, hidden: true, last_read_at: nowS() })];
    s.transcripts["coder-bot"] = [
      { role: "user", text: "Refactor the parser" },
      { role: "assistant", text: "Parser refactored." },
    ];
    s.profileMeta.coder = { ui_meta: { "hermes-bots": { title: "Coder", color: "#3366cc" } } };
  }

  /** Opens `name`'s Bot Chat until `text` shows, which leaves its Saved copy, then goes back to the default profile's bots. */
  async function visit(user: ReturnType<typeof userEvent.setup>, hermes: Hermes, name: string, text: string, count = 2) {
    await user.click(rowOf(name));
    await waitFor(() => expect(screen.getByText(text)).toBeTruthy());
    await settle(hermes);
    await user.click(modeTab("Chats"));
    await pickProfile(user, "default");
    await waitFor(() => expect(listTitles()).toEqual(["Disk usage"]));
    await settle(hermes);
    await showBots(user, count);
  }

  it("names the bot, marks its row and shows its Bot Chat's Saved copy at the click, then resumes that chat once connected", async () => {
    let dials!: ReturnType<typeof holdDials>;
    const { server, hermes, user } = await launch((s) => {
      s.liveSessions = [];
      dials = holdDials(s);
    });
    await showBots(user);
    await visit(user, hermes, "Scribe", "Draft the release notes for 0.9");
    dials.hold("scribe");
    const from = server.requests.length;
    await user.click(rowOf("Scribe"));
    expect(dials.waiting("scribe")).toBe(true);
    expect(head()).toBe("SScribeBot Chat");
    expect(current()).toEqual([null, "true"]);
    // The bot is drawn first, and its Saved copy follows a frame later.
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    expect(document.querySelector(".saved-note")?.textContent).toMatch(/Connecting to Hermes, so newer messages may be missing until it loads\./);
    expect(server.requests.slice(from).filter((r) => r.method === "session.list" || r.method === "session.resume")).toEqual([]);
    await dials.release("scribe");
    await resumed(hermes, "scribe-bot");
    await settle(hermes);
    expect(head()).toBe("SScribeBot Chat");
    expect(current()).toEqual([null, "true"]);
    expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy();
    // Confirmed by the title lookup as ever, and nothing created.
    expect(titleLookups(server)).toEqual([BOT_CHAT_TITLE, BOT_CHAT_TITLE]);
    expect(server.requests.filter((r) => r.method === "session.create")).toEqual([]);
  });

  it("looks the Bot Chat up and opens it without waiting for the profile's chat list", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    const list = server.rest["GET /api/sessions"];
    const held: (() => void)[] = [];
    let holding = true;
    server.rest["GET /api/sessions"] = (req) =>
      holding && req.query.get("profile") === "scribe" ? new Promise((resolve) => held.push(() => resolve(list(req)))) : list(req);
    await showBots(user);
    await user.click(rowOf("Scribe"));
    await resumed(hermes, "scribe-bot");
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    expect(titleLookups(server)).toEqual([BOT_CHAT_TITLE]);
    expect(held.length).toBeGreaterThan(0);
    expect(hermes.hasListed()).toBe(false);
    holding = false;
    await act(async () => held.splice(0).forEach((f) => f()));
    await settle(hermes);
    expect(head()).toBe("SScribeBot Chat");
  });

  it("keeps a draft typed in the Bot Chat while it connects, once the lookup confirms that chat", async () => {
    let dials!: ReturnType<typeof holdDials>;
    const { hermes, user } = await launch((s) => {
      s.liveSessions = [];
      dials = holdDials(s);
    });
    await showBots(user);
    await visit(user, hermes, "Scribe", "Draft the release notes for 0.9");
    dials.hold("scribe");
    await user.click(rowOf("Scribe"));
    await user.type(screen.getByPlaceholderText("Message Scribe"), "half a thought");
    await dials.release("scribe");
    await resumed(hermes, "scribe-bot");
    await settle(hermes);
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>("Message Scribe").value).toBe("half a thought");
  });

  it("never shows the first bot's chat under the second when the owner picks another bot before the first connects", async () => {
    let dials!: ReturnType<typeof holdDials>;
    const { server, hermes, user } = await launch((s) => {
      s.liveSessions = [];
      withCoder(s);
      dials = holdDials(s);
    });
    await showBots(user, 3);
    await visit(user, hermes, "Scribe", "Draft the release notes for 0.9", 3);
    await visit(user, hermes, "Coder", "Refactor the parser", 3);
    dials.hold("scribe", "coder");
    const from = server.requests.length;
    await user.click(rowOf("Scribe"));
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    await user.click(rowOf("Coder"));
    const coderShown = () => {
      expect(head()).toBe("CCoderBot Chat");
      expect(screen.getByText("Refactor the parser")).toBeTruthy();
      expect(screen.queryByText("Draft the release notes for 0.9")).toBeNull();
    };
    expect(head()).toBe("CCoderBot Chat");
    await waitFor(coderShown);
    // Scribe's connection opens while Coder shows; the switch to Coder then dials again.
    await dials.release("scribe");
    await waitFor(() => expect(dials.waiting("coder")).toBe(true));
    coderShown();
    await dials.release("coder");
    await resumed(hermes, "coder-bot");
    await settle(hermes);
    coderShown();
    const after = server.requests.slice(from);
    expect(after.filter((r) => r.method === "session.list" && r.params.title !== undefined).map((r) => r.params.profile)).toEqual(["coder"]);
    expect(after.filter((r) => r.method === "session.resume").map((r) => r.params.session_id)).toEqual(["coder-bot"]);
  });

  it("moves to the Bot Chat the lookup finds when the roster named an older one, and lets the older one go", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await showBots(user);
    // Another client replaced the Bot Chat after the roster was read.
    server.otherProfiles.scribe.find((s) => s.id === "scribe-bot")!.title = "Release notes, first try";
    server.otherProfiles.scribe.push(row("scribe-bot-2", 0, { title: BOT_CHAT_TITLE, hidden: true, last_read_at: nowS() }));
    server.transcripts["scribe-bot-2"] = [
      { role: "user", text: "Start the 1.0 notes" },
      { role: "assistant", text: "Started." },
    ];
    await user.click(rowOf("Scribe"));
    await waitFor(() => expect(screen.getByText("Start the 1.0 notes")).toBeTruthy());
    await settle(hermes);
    expect(head()).toBe("SScribeBot Chat");
    expect(current()).toEqual([null, "true"]);
    expect(screen.queryByText("Draft the release notes for 0.9")).toBeNull();
    expect(hermes.getSnapshot().chats.some((c) => c.id === "scribe-bot")).toBe(false);
    expect(server.requests.filter((r) => r.method === "session.create")).toEqual([]);
  });

  it("picks up a reply still running in the Bot Chat once its connection opens", async () => {
    let dials!: ReturnType<typeof holdDials>;
    const { server, hermes, user } = await launch((s) => {
      s.liveSessions = [];
      s.reattachTurns = true;
      dials = holdDials(s);
    });
    await showBots(user);
    await user.click(rowOf("Scribe"));
    await resumed(hermes, "scribe-bot");
    await user.type(screen.getByPlaceholderText("Message Scribe"), "Now the 1.0 notes{Enter}");
    await waitFor(() => expect(server.requests.some((r) => r.method === "prompt.submit")).toBe(true));
    const rt = server.runtimeIdOf("scribe-bot")!;
    await act(async () => {
      server.event(rt, "message.start");
      server.event(rt, "message.delta", { text: "Drafting " });
    });
    await waitFor(() => expect(screen.getByText(/^Drafting/)).toBeTruthy());
    // Hermes keeps the reply going while the owner is in another profile (ADR 0224).
    await user.click(modeTab("Chats"));
    await pickProfile(user, "default");
    await waitFor(() => expect(listTitles()).toEqual(["Disk usage"]));
    await settle(hermes);
    await showBots(user);
    dials.hold("scribe");
    await user.click(rowOf("Scribe"));
    expect(head()).toBe("SScribeBot Chat");
    await dials.release("scribe");
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "scribe-bot")?.running).toBe(true));
    await act(async () => {
      server.event(rt, "message.delta", { text: "the 1.0 notes." });
      server.event(rt, "message.complete", { text: "Drafting the 1.0 notes.", status: "complete" });
    });
    await waitFor(() => expect(screen.getByText("Drafting the 1.0 notes.")).toBeTruthy());
  });

  /** Holds every Bot Chat title lookup until `release`. */
  function holdTitleLookups(server: FakeHermes) {
    const lookup = server.handlers["session.list"];
    const held: (() => void)[] = [];
    server.handlers["session.list"] = (r) => (r.params.title === undefined ? lookup(r) : void held.push(() => lookup(r)));
    return {
      waiting: () => held.length > 0,
      release: () => act(async () => held.splice(0).forEach((f) => f())),
    };
  }

  it("shows the bot's Bot Chat at once once the profile changes, when the switch first hands back the Bot Desktop screen", async () => {
    let dials!: ReturnType<typeof holdDials>;
    const { server, hermes, user } = await launch((s) => {
      s.liveSessions = [];
      s.display = { status: { supported: true, installed: true, missing: [], running: true }, lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 }, minted: new Set() };
      dials = holdDials(s);
    });
    await showBots(user);
    await visit(user, hermes, "Scribe", "Draft the release notes for 0.9");
    await act(async () => void (await hermes.screen.takeOver()));
    const handBack = server.handlers["display.lease.release"];
    let handedBack: (() => void) | undefined;
    server.handlers["display.lease.release"] = (r) => void (handedBack = () => handBack(r));
    dials.hold("scribe");
    await user.click(rowOf("Scribe"));
    await waitFor(() => expect(handedBack).toBeDefined());
    expect(hermes.profile).toBe("default");
    await act(async () => handedBack!());
    await waitFor(() => expect(head()).toBe("SScribeBot Chat"));
    expect(dials.waiting("scribe")).toBe(true);
    expect(current()).toEqual([null, "true"]);
    // The bot is drawn first, and its Saved copy follows a frame later.
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    await dials.release("scribe");
    await resumed(hermes, "scribe-bot");
  });

  it("sends nothing to the Bot Chat shown early until its lookup confirms it, then sends there", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await showBots(user);
    await visit(user, hermes, "Scribe", "Draft the release notes for 0.9");
    const lookups = holdTitleLookups(server);
    const from = server.requests.length;
    await user.click(rowOf("Scribe"));
    await waitFor(() => expect(lookups.waiting()).toBe(true));
    await user.type(screen.getByPlaceholderText("Message Scribe"), "Now the 1.0 notes{Enter}");
    await settle(hermes);
    const sent = () => server.requests.slice(from).filter((r) => r.method === "session.resume" || r.method === "prompt.submit").map((r) => r.method);
    expect(sent()).toEqual([]);
    await lookups.release();
    await waitFor(() => expect(sent()).toEqual(["session.resume", "prompt.submit"]));
    expect(server.requests.slice(from).find((r) => r.method === "session.resume")!.params.session_id).toBe("scribe-bot");
  });

  it("sends nothing to a Bot Chat already open when its row is clicked again, until its lookup confirms it again", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await showBots(user);
    await user.click(rowOf("Scribe"));
    await resumed(hermes, "scribe-bot");
    await settle(hermes);
    const lookups = holdTitleLookups(server);
    const from = server.requests.length;
    await user.click(rowOf("Scribe"));
    await waitFor(() => expect(lookups.waiting()).toBe(true));
    await user.type(screen.getByPlaceholderText("Message Scribe"), "Now the 1.0 notes{Enter}");
    await settle(hermes);
    const submits = () => server.requests.slice(from).filter((r) => r.method === "prompt.submit");
    expect(submits()).toEqual([]);
    await lookups.release();
    await waitFor(() => expect(submits()).toHaveLength(1));
  });

  it("sends nothing to the Bot Chat shown early when its lookup finds another one", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await showBots(user);
    await visit(user, hermes, "Scribe", "Draft the release notes for 0.9");
    server.otherProfiles.scribe.find((s) => s.id === "scribe-bot")!.title = "Release notes, first try";
    server.otherProfiles.scribe.push(row("scribe-bot-2", 0, { title: BOT_CHAT_TITLE, hidden: true, last_read_at: nowS() }));
    server.transcripts["scribe-bot-2"] = [{ role: "assistant", text: "Started the 1.0 notes." }];
    const lookups = holdTitleLookups(server);
    const from = server.requests.length;
    await user.click(rowOf("Scribe"));
    await waitFor(() => expect(lookups.waiting()).toBe(true));
    await user.type(screen.getByPlaceholderText("Message Scribe"), "Now the 1.0 notes{Enter}");
    await lookups.release();
    await waitFor(() => expect([...document.querySelectorAll(".msg")].map((m) => m.textContent)).toEqual([expect.stringContaining("Started the 1.0 notes.")]));
    await settle(hermes);
    const after = server.requests.slice(from);
    expect(after.filter((r) => r.method === "session.resume").map((r) => r.params.session_id)).toEqual(["scribe-bot-2"]);
    expect(after.filter((r) => r.method === "prompt.submit")).toEqual([]);
  });
});

describe("A Bot Chat outside the list", () => {
  it("is counted on the Bots tab while an Approval waits in it, after switching away from its profile", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await showBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "scribe-bot")?.runtimeId).toBeTruthy());
    const runtimeId = hermes.getSnapshot().chats.find((c) => c.id === "scribe-bot")!.runtimeId!;
    // Hermes lists the session this app resumed as waiting; its row carries no title, and the app knows its profile.
    server.liveSessions = [{ id: runtimeId, session_key: "scribe-bot", status: "waiting", last_active: nowS() }];
    await act(async () => void (await hermes.switchProfile("default")));
    await act(async () => void (await hermes.sync()));
    await act(async () => void (await hermes.checkOtherProfiles()));
    expect(hermes.getSnapshot().live?.sessions).toEqual([expect.objectContaining({ chatId: "scribe-bot", status: "waiting", profile: "scribe" })]);
    expect(hermes.getSnapshot().live?.sessions[0].title).toBeUndefined();
    await user.click(modeTab("Chats"));
    await waitFor(() => expect(modeTab("Bots").getAttribute("aria-label")).toBe("Bots, 1 bot needs you"));
  });

  it("stays out of the list after switching away and back, and isn't the chat reopened at launch", async () => {
    const { hermes, user } = await launch();
    await pickProfile(user, "scribe");
    await waitFor(() => expect(hermes.profile).toBe("scribe"));
    await user.keyboard("{Alt>}b{/Alt}");
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    expect(getUIPrefs().lastOpenChat.scribe).toBeUndefined();
    await act(async () => void (await hermes.switchProfile("default")));
    await act(async () => void (await hermes.sync()));
    await act(async () => void (await hermes.switchProfile("scribe")));
    // The saved list shows at once, before Hermes answers: it never held the Bot Chat.
    expect(listTitles()).not.toContain(BOT_CHAT_TITLE);
    await act(async () => void (await hermes.sync()));
    expect(listTitles()).toEqual(["Changelog wording"]);
  });
});

describe("The chat list panel's two modes", () => {
  const panel = () => document.querySelector<HTMLElement>(".sidebar")!;
  const panelBots = () => Array.from(panel().querySelectorAll<HTMLButtonElement>(".bots-open"));
  const names = () => panelBots().map((r) => r.querySelector(".bots-name")?.textContent);
  const current = () => panelBots().map((r) => r.getAttribute("aria-current"));
  const tab = (name: RegExp) => within(panel()).getByRole("tab", { name });
  const shownMode = () => within(panel()).getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")?.textContent;

  async function pickBots(user: ReturnType<typeof userEvent.setup>) {
    await user.click(tab(/^Bots/));
    await waitFor(() => expect(names()).toEqual(["Hermes", "Scribe"]));
  }

  async function openScribe(user: ReturnType<typeof userEvent.setup>) {
    await showBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    await pickBots(user);
  }

  it("starts on the chats, with a switch at the top naming both modes", async () => {
    await launch();
    const tabs = within(panel()).getByRole("tablist", { name: "Chat list" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Chats", "Bots"]);
    expect(shownMode()).toBe("Chats");
    expect(listTitles()).toEqual(["Disk usage"]);
    expect(panelBots()).toEqual([]);
    expect(getUIPrefs().chatListMode).toBe("chats");
  });

  it("shows the bots in Bots mode, under New chat and Search, with the open Bot Chat's bot current", async () => {
    const { user } = await launch();
    await openScribe(user);
    expect(shownMode()).toBe("Bots");
    expect(current()).toEqual([null, "true"]);
    expect(within(panelBots()[1]).getByText("Release notes drafted: three fixes.")).toBeTruthy();
    expect(listTitles()).toEqual([]);
    expect(within(panel()).queryByRole("heading", { name: "Bots" })).toBeNull();
    expect(within(panel()).getByRole("button", { name: "New chat" })).toBeTruthy();
    expect(within(panel()).getByRole("button", { name: "Search chats" })).toBeTruthy();
    expect(getUIPrefs().chatListMode).toBe("bots");
  });

  it("marks no bot current while an ordinary chat is open", async () => {
    const { user } = await launch();
    await pickBots(user);
    expect(current()).toEqual([null, null]);
  });

  it("stays in Bots mode on New chat, back on the owner's own profile, with no bot current", async () => {
    const { hermes, user } = await launch();
    await openScribe(user);
    await user.click(within(panel()).getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(screen.getByText("What should Hermes work on?")).toBeTruthy());
    expect(hermes.profile).toBe("default");
    expect(shownMode()).toBe("Bots");
    expect(current()).toEqual([null, null]);
  });

  it("stays in Bots mode on Ctrl+N, back on the owner's own profile", async () => {
    const { hermes, user } = await launch();
    await openScribe(user);
    await user.keyboard("{Control>}n{/Control}");
    await waitFor(() => expect(screen.getByText("What should Hermes work on?")).toBeTruthy());
    expect(hermes.profile).toBe("default");
    expect(shownMode()).toBe("Bots");
    expect(names()).toEqual(["Hermes", "Scribe"]);
  });

  it("stays in Bots mode when an ordinary chat opens from search", async () => {
    const { user } = await launch();
    await openScribe(user);
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByPlaceholderText("Search all chats, including Archived"), "Changelog");
    await waitFor(() => expect(document.querySelector(".hit-row")).toBeTruthy());
    await user.click(document.querySelector<HTMLElement>(".hit-row")!);
    await waitFor(() => expect(screen.getByText("Which wording reads better?")).toBeTruthy());
    expect(shownMode()).toBe("Bots");
    expect(current()).toEqual([null, null]);
  });

  it("stays in Chats mode on a profile switch, and in Bots mode on the next one", async () => {
    const { hermes, user } = await launch();
    await pickProfile(user, "scribe");
    await waitFor(() => expect(listTitles()).toEqual(["Changelog wording"]));
    expect(shownMode()).toBe("Chats");
    await pickBots(user);
    await user.click(panelBots()[0].closest("li")!.querySelector<HTMLElement>(".bots-new")!);
    await waitFor(() => expect(hermes.profile).toBe("default"));
    await act(async () => void (await hermes.idle()));
    expect(shownMode()).toBe("Bots");
  });

  it("picks a mode by Left, Right, Home and End on the focused tab, with one tab stop", async () => {
    const { user } = await launch();
    tab(/^Chats/).focus();
    expect(within(panel()).getAllByRole("tab").map((t) => t.tabIndex)).toEqual([0, -1]);
    await user.keyboard("{ArrowRight}");
    expect(shownMode()).toBe("Bots");
    expect(document.activeElement).toBe(tab(/^Bots/));
    expect(within(panel()).getAllByRole("tab").map((t) => t.tabIndex)).toEqual([-1, 0]);
    await user.keyboard("{ArrowRight}");
    expect(shownMode()).toBe("Chats");
    await user.keyboard("{ArrowLeft}");
    expect(shownMode()).toBe("Bots");
    await user.keyboard("{Home}");
    expect(shownMode()).toBe("Chats");
    expect(document.activeElement).toBe(tab(/^Chats/));
    await user.keyboard("{End}");
    expect(shownMode()).toBe("Bots");
    expect(document.activeElement).toBe(tab(/^Bots/));
  });

  it("flips on Ctrl+Shift+B from anywhere, and shows the panel when it is hidden", async () => {
    const { user } = await launch();
    await user.click(screen.getByPlaceholderText(/Message/));
    await user.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
    expect(shownMode()).toBe("Bots");
    await user.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
    expect(shownMode()).toBe("Chats");
    await user.keyboard("{Control>}b{/Control}");
    expect(document.querySelector(".sidebar")).toBeNull();
    await user.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
    await waitFor(() => expect(document.querySelector(".sidebar")).toBeTruthy());
    expect(shownMode()).toBe("Bots");
    expect(tab(/^Bots/).getAttribute("aria-keyshortcuts")).toBe("Control+Shift+B");
  });

  it("names on the Chats tab, while the bots show, how many chats wait in the Inbox", async () => {
    const { user } = await launch((s) => (s.sessions = [row("disk", 0.5, { pinned: true, title: "Disk usage" }), row("logs", 1, { pinned: true, title: "Log rotation" })]));
    expect(tab(/^Chats/).getAttribute("aria-label")).toBe("Chats");
    await pickBots(user);
    expect(tab(/^Chats/).getAttribute("aria-label")).toBe("Chats, 2 in the Inbox");
    expect(tab(/^Chats/).getAttribute("title")).toBe("Chats: 2 in the Inbox (Ctrl+Shift+B)");
    expect(tab(/^Chats/).querySelector(".sb-mode-count")?.textContent).toBe("2");
  });

  it("names on the Bots tab a bot in another profile that is replying", async () => {
    await launch();
    expect(tab(/^Bots/).getAttribute("aria-label")).toBe("Bots, 1 bot is replying");
    expect(tab(/^Bots/).getAttribute("title")).toBe("Bots: 1 bot is replying (Ctrl+Shift+B)");
    expect(tab(/^Bots/).querySelector(".sb-mode-count.is-replying")).toBeTruthy();
  });

  it("names on the Bots tab how many bots in other profiles need the owner, before any that is replying", async () => {
    await launch((s) => {
      s.otherProfiles.ops = [row("ops-bot", 0.01, { title: BOT_CHAT_TITLE, hidden: true })];
      s.liveSessions = [
        { id: "rt-s", session_key: "scribe-bot", status: "waiting", last_active: nowS() },
        { id: "rt-o", session_key: "ops-bot", status: "working", last_active: nowS() },
      ];
    });
    await waitFor(() => expect(tab(/^Bots/).getAttribute("aria-label")).toBe("Bots, 1 bot needs you"));
    expect(tab(/^Bots/).getAttribute("title")).toBe("Bots: 1 bot needs you (Ctrl+Shift+B)");
    expect(tab(/^Bots/).querySelector(".sb-mode-count.is-needs-you")?.textContent).toBe("1");
  });

  it("puts nothing on the Bots tab while no bot in another profile needs the owner or replies", async () => {
    await launch((s) => (s.liveSessions = []));
    expect(tab(/^Bots/).getAttribute("aria-label")).toBe("Bots");
    expect(tab(/^Bots/).querySelector(".sb-mode-count")).toBeNull();
  });

  it("opens another bot's Bot Chat from the panel, in its profile, and stays in Bots mode with that bot current", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await openScribe(user);
    // Never the next profile's chats meanwhile.
    const chatsShown: string[][] = [];
    const watch = new MutationObserver(() => panelBots().length || chatsShown.push(listTitles() as string[]));
    watch.observe(document.body, { subtree: true, childList: true });
    await user.click(panelBots()[0]);
    await waitFor(() => expect(hermes.profile).toBe("default"));
    const made = await waitFor(() => server.sessions.find((s) => s.title === BOT_CHAT_TITLE && s.hidden)!.id);
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === made)?.bot).toBe(true));
    await act(async () => void (await hermes.idle()));
    watch.disconnect();
    expect(chatsShown).toEqual([]);
    expect(current()).toEqual(["true", null]);
    expect(within(document.querySelector<HTMLElement>(".chat-head")!).getByText("Bot Chat")).toBeTruthy();
  });

  it("asks before a bot in another profile opens while an Approval waits here", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await openScribe(user);
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "scribe-bot")?.runtimeId).toBeTruthy());
    await act(async () => void server.askApproval(server.runtimeIdOf("scribe-bot")!));
    await user.click(panelBots()[0]);
    const ask = await screen.findByRole("alertdialog", { name: "Switch to default?" });
    expect(ask.textContent).toMatch(/An approval is waiting in scribe/);
    await user.keyboard("{Escape}");
    expect(ask.isConnected).toBe(false);
    expect(hermes.profile).toBe("scribe");
    expect(current()).toEqual([null, "true"]);
    // Escape from a row, or choosing another row, also takes the question away.
    await user.click(panelBots()[0]);
    panelBots()[1].focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog", { name: "Switch to default?" })).toBeNull();
    await user.click(panelBots()[0]);
    await user.click(panelBots()[1]);
    expect(screen.queryByRole("alertdialog", { name: "Switch to default?" })).toBeNull();
    expect(hermes.profile).toBe("scribe");
    await user.click(panelBots()[0]);
    await user.click(screen.getByRole("button", { name: "Switch to default" }));
    await waitFor(() => expect(hermes.profile).toBe("default"));
    await waitFor(() => expect(current()).toEqual(["true", null]));
  });

  it("opens another bot at once while a reply is running here, and says in a toast that it keeps going", async () => {
    const { hermes, user } = await launch((s) => (s.liveSessions = []));
    await openScribe(user);
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "scribe-bot")?.runtimeId).toBeTruthy());
    await act(async () => void (await hermes.send("scribe-bot", "Keep going")));
    expect(hermes.getSnapshot().chats.find((c) => c.id === "scribe-bot")?.running).toBe(true);
    await user.click(panelBots()[0]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(hermes.profile).toBe("default"));
    expect(document.querySelector(".toast")?.textContent).toMatch(/A reply is still running in scribe/);
  });

  it("keeps a chat started while another bot's Bot Chat is on its way, and marks no bot current", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await openScribe(user);
    const lookup = server.handlers["session.list"];
    const held: (() => void)[] = [];
    server.handlers["session.list"] = (r) => (r.params.title ? void held.push(() => lookup(r)) : lookup(r));
    await user.click(panelBots()[0]);
    await waitFor(() => expect(hermes.profile).toBe("default"));
    await waitFor(() => expect(held).toHaveLength(1));
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>(/Message/);
    await user.click(composer);
    await user.paste("Check the disk");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(server.requests.some((r) => r.method === "prompt.submit")).toBe(true));
    server.handlers["session.list"] = lookup;
    held.splice(0).forEach((f) => f());
    await act(async () => void (await hermes.idle()));
    expect(document.querySelector(".chat-head")?.textContent).not.toMatch(/Bot Chat/);
    expect(shownMode()).toBe("Bots");
    expect(current()).toEqual([null, null]);
  });

  it("keeps a chat sent while it is still starting, when the Bot Chat on its way is found first", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await openScribe(user);
    const lookup = server.handlers["session.list"];
    const create = server.handlers["session.create"];
    const lookups: (() => void)[] = [];
    const creates: (() => void)[] = [];
    server.handlers["session.list"] = (r) => (r.params.title ? void lookups.push(() => lookup(r)) : lookup(r));
    server.handlers["session.create"] = (r) => (r.params.title ? create(r) : void creates.push(() => create(r)));
    await user.click(panelBots()[0]);
    await waitFor(() => expect(hermes.profile).toBe("default"));
    await waitFor(() => expect(lookups).toHaveLength(1));
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>(/Message/);
    await user.click(composer);
    await user.paste("Check the disk");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(creates).toHaveLength(1));
    server.handlers["session.list"] = lookup;
    lookups.splice(0).forEach((f) => f());
    await act(async () => void (await hermes.idle()));
    // The owner's message is on its way to a chat of its own, so the Bot Chat found meanwhile doesn't take the pane.
    expect(document.querySelector(".chat-head")?.textContent).not.toMatch(/Bot Chat/);
    server.handlers["session.create"] = create;
    creates.splice(0).forEach((f) => f());
    await waitFor(() => expect(server.requests.some((r) => r.method === "prompt.submit")).toBe(true));
    await act(async () => void (await hermes.idle()));
    expect(document.querySelector(".chat-head")?.textContent).not.toMatch(/Bot Chat/);
    expect(document.querySelector(".chat-head")?.textContent).toMatch(/Check the disk/);
    expect(current()).toEqual([null, null]);
  });

  it("is in the mode picked last after a relaunch, which reopens no Bot Chat", async () => {
    const { hermes, user } = await launch();
    await openScribe(user);
    cleanup();
    render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `lena@hermes-${launches}`, url: "", username: "lena" }} onSignOut={async () => {}} />);
    await waitFor(() => expect(names()).toEqual(["Hermes", "Scribe"]));
    expect(shownMode()).toBe("Bots");
    expect(current()).toEqual([null, null]);
    expect(screen.queryByText("Draft the release notes for 0.9")).toBeNull();
  });

  it("reads the roster again every BOTS_REFRESH_MS while the bots show, and not while the chats do", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { server, user } = await launch();
      const reads = () => server.requests.filter((r) => r.method === "profiles.list").length;
      const before = reads();
      await act(async () => void (await vi.advanceTimersByTimeAsync(BOTS_REFRESH_MS)));
      expect(reads()).toBe(before);
      await pickBots(user);
      const shown = reads();
      await act(async () => void (await vi.advanceTimersByTimeAsync(BOTS_REFRESH_MS)));
      await waitFor(() => expect(reads()).toBeGreaterThan(shown));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("A bot visit", () => {
  const title = () => document.querySelector<HTMLElement>(".chat-head .chat-title")?.textContent ?? "";
  const switcher = () => document.querySelector<HTMLElement>(".sidebar .sb-profile .profile-btn .profile-name")?.textContent;
  const rowOf = (name: string) => botRows().find((r) => r.querySelector(".bots-name")?.textContent === name)!;
  const withOps = (s: FakeHermes) => {
    s.otherProfiles.ops = [row("ops-bot", 0.01, { title: BOT_CHAT_TITLE, hidden: true })];
    s.transcripts = { ...s.transcripts, "ops-bot": [{ role: "assistant", text: "Deploy is green." }] };
    s.profileMeta.ops = { ui_meta: { "hermes-bots": { title: "Ops" } } };
    s.liveSessions = [];
  };

  async function openBySearch(user: ReturnType<typeof userEvent.setup>, chatTitle: string) {
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByPlaceholderText("Search all chats, including Archived"), chatTitle);
    await waitFor(() => expect(document.querySelector(".hit-row")).toBeTruthy());
    await user.click(document.querySelector<HTMLElement>(".hit-row")!);
    await waitFor(() => expect(title()).toMatch(new RegExp(`^${chatTitle}`)));
  }

  /** On `default` with Disk usage open, Scribe opened from Bots mode. */
  async function visitScribe(setup?: (s: FakeHermes) => void, count = 2) {
    const env = await launch(setup);
    await env.user.click(screen.getByText("Disk usage"));
    await waitFor(() => expect(title()).toMatch(/^Disk usage/));
    await showBots(env.user, count);
    await env.user.click(rowOf("Scribe"));
    await waitFor(() => expect(title()).toBe("SScribeBot Chat"));
    expect(env.hermes.profile).toBe("scribe");
    return env;
  }

  it("goes back to the owner's profile and the chat they were in when Chats is picked", async () => {
    const { hermes, user } = await visitScribe();
    await user.click(modeTab("Chats"));
    await waitFor(() => expect(hermes.profile).toBe("default"));
    await waitFor(() => expect(title()).toMatch(/^Disk usage/));
    expect(switcher()).toBe("Hermes");
    expect(listTitles()).toEqual(["Disk usage"]);
  });

  it("goes back on Ctrl+Shift+B too", async () => {
    const { hermes, user } = await visitScribe();
    await user.click(screen.getByPlaceholderText(/Message/));
    await user.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
    await waitFor(() => expect(hermes.profile).toBe("default"));
    await waitFor(() => expect(title()).toMatch(/^Disk usage/));
    expect(modeTab("Chats").getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the owner's profile through a second bot", async () => {
    const { hermes, user } = await visitScribe(withOps, 3);
    await user.click(rowOf("Ops"));
    await waitFor(() => expect(title()).toBe("OOpsBot Chat"));
    expect(hermes.profile).toBe("ops");
    await user.click(modeTab("Chats"));
    await waitFor(() => expect(hermes.profile).toBe("default"));
    await waitFor(() => expect(title()).toMatch(/^Disk usage/));
  });

  it("ends on the owner's own bot, which stays open on Chats", async () => {
    const { hermes, user } = await visitScribe((s) => (s.liveSessions = []));
    await user.click(rowOf("Hermes"));
    await waitFor(() => expect(title()).toBe("HHermesBot Chat"));
    expect(hermes.profile).toBe("default");
    await user.click(modeTab("Chats"));
    await act(async () => void (await hermes.idle()));
    expect(title()).toBe("HHermesBot Chat");
    expect(switcher()).toBe("Hermes");
  });

  it("makes the bot's profile the owner's once an ordinary chat of it is open", async () => {
    const { hermes, user } = await visitScribe();
    await openBySearch(user, "Changelog wording");
    await user.click(modeTab("Chats"));
    await act(async () => void (await hermes.idle()));
    expect(hermes.profile).toBe("scribe");
    expect(switcher()).toBe("Scribe");
    expect(title()).toMatch(/^Changelog wording/);
  });

  it("makes another bot's profile the owner's from its pen", async () => {
    const { hermes, user } = await visitScribe(withOps, 3);
    await user.click(within(bots()).getByRole("button", { name: "New chat with Ops" }));
    await waitFor(() => expect(hermes.profile).toBe("ops"));
    await user.click(modeTab("Chats"));
    await act(async () => void (await hermes.idle()));
    expect(hermes.profile).toBe("ops");
    expect(switcher()).toBe("Ops");
  });

  /** What the next launch opens on: `connect` with the same saved data, to a server that has every profile. */
  async function nextLaunch(cache: ReturnType<typeof memoryCache>) {
    const server = new FakeHermes();
    server.otherProfiles = { scribe: [] };
    const again = await connect(server.openPipe, undefined, cache);
    running.push(again);
    return again.profile;
  }

  it("leaves the next launch on the owner's profile, until the bot's profile is theirs", async () => {
    const { hermes, cache, user } = await visitScribe();
    await act(async () => void (await hermes.idle()));
    expect(await nextLaunch(cache)).toBe("default");
    await openBySearch(user, "Changelog wording");
    expect(await nextLaunch(cache)).toBe("scribe");
  });
});

describe("A Hermes without Bot Mode", () => {
  it("has no switch: the panel is the chats, with the profile switcher at its top", async () => {
    const { hermes } = await launch((s) => (s.botMode = "none"));
    await act(async () => void (await hermes.capabilities.refresh()));
    await waitFor(() => expect(document.querySelector(".sidebar [role=tab]")).toBeNull());
    expect(document.querySelector(".sidebar [role=tablist]")).toBeNull();
    expect(document.querySelector(".sidebar .sb-head .profile-btn")).toBeTruthy();
    expect(listTitles()).toEqual(["Disk usage"]);
  });
});

describe("A bot's menu in the chat list panel", { timeout: 30_000 }, () => {
  const panel = () => document.querySelector<HTMLElement>(".sidebar")!;
  const panelBots = () => Array.from(panel().querySelectorAll<HTMLButtonElement>(".bots-open"));
  const names = () => panelBots().map((r) => r.querySelector(".bots-name")?.textContent);
  const current = () => panelBots().map((r) => r.getAttribute("aria-current"));
  const panelRow = (name: string) => panelBots().find((r) => r.querySelector(".bots-name")?.textContent === name)!;
  /** What was written to the server's profiles: opening a Bot Chat writes its own read mark, which isn't the menu's. */
  const writes = (server: FakeHermes) => server.restRequests.filter((r) => r.method !== "GET" && r.path.startsWith("/api/profiles")).map((r) => `${r.method} ${r.path}`);
  const entries = (menu: HTMLElement) => within(menu).getAllByRole("menuitem");
  /** Scratch: a disposable bot with no Bot Chat, in a profile of its own. */
  const withScratch = (s: FakeHermes) => {
    s.otherProfiles.scratch = [];
    s.profileMeta.scratch = { description: "Disposable test bot", ui_meta: { "hermes-bots": { title: "Scratch" } } };
  };

  async function openScribe(user: ReturnType<typeof userEvent.setup>, count = 3) {
    await showBots(user, count);
    await user.click(botRows().find((r) => r.textContent?.includes("Scribe"))!);
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    await waitFor(() => expect(panelBots().length).toBe(count));
  }

  async function rightClick(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.pointer({ keys: "[MouseRight]", target: panelRow(name) });
    return screen.getByRole("menu", { name: `More for ${name}` });
  }

  it("opens on a right-click on any row, selected or not, with Chat, Settings, Edit persona…, Clone, Pin, Hide and Delete, and switches nothing", async () => {
    const { server, hermes, user } = await launch(withScratch);
    await openScribe(user);
    expect(names()).toEqual(["Hermes", "Scribe", "Scratch"]);
    const before = server.requests.length;
    for (const name of ["Hermes", "Scribe", "Scratch"]) {
      const menu = await rightClick(user, name);
      expect(entries(menu).map((i) => i.textContent)).toEqual(["Chat", "Settings", "Edit persona…", "Clone…", "Pin", "Hide", "Delete"]);
      expect(entries(menu)[6].classList.contains("danger")).toBe(true);
      // Nothing is opened or switched until an entry is picked.
      expect(hermes.profile).toBe("scribe");
      expect(current()).toEqual([null, "true", null]);
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).toBeNull();
    }
    expect(server.requests.slice(before).filter((r) => r.method === "session.resume" || r.method === "session.create")).toEqual([]);
    // As the chat rows in the panel, the bots open their menu only by a right-click or a key, with no ⋯ button.
    expect(panel().querySelector(".bots-more")).toBeNull();
  });

  it("opens from Shift+F10 and the Menu key on a row, moves with the arrows, and puts focus back on Escape", async () => {
    const { user } = await launch(withScratch);
    await openScribe(user);
    panelRow("Scratch").focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("menu", { name: "More for Scratch" })).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Chat");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("Settings");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("Edit persona…");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("Clone…");
    await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(document.activeElement?.textContent).toBe("Delete");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(panelRow("Scratch"));
    await user.keyboard("{ContextMenu}");
    expect(screen.getByRole("menu", { name: "More for Scratch" })).toBeTruthy();
    // A click outside closes it, and does nothing else.
    await user.click(panel().querySelector<HTMLElement>(".sb-scroll")!);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Chat opens that bot's Bot Chat in its profile, as its row does", async () => {
    const { hermes, user } = await launch((s) => {
      withScratch(s);
      s.liveSessions = [];
    });
    await openScribe(user);
    await user.click(within(await rightClick(user, "Hermes")).getByRole("menuitem", { name: "Chat" }));
    await waitFor(() => expect(hermes.profile).toBe("default"));
    await waitFor(() => expect(current()).toEqual(["true", null, null]));
    expect(within(document.querySelector<HTMLElement>(".chat-head")!).getByText("Bot Chat")).toBeTruthy();
  });

  it("Settings opens Edit bot on that bot, saves through Hermes, and its row reads the change back", async () => {
    const { server, hermes, user } = await launch(withScratch);
    await openScribe(user);
    await user.click(within(await rightClick(user, "Scratch")).getByRole("menuitem", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit bot: Scratch" });
    expect(within(dialog).getByLabelText<HTMLInputElement>("Name in Bot Mode").value).toBe("Scratch");
    await user.clear(within(dialog).getByLabelText("Description"));
    await user.type(within(dialog).getByLabelText("Description"), "Edited from the panel");
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull());
    expect(writes(server)).toEqual(["PUT /api/profiles/scratch/description"]);
    expect(server.profileMeta.scratch.description).toBe("Edited from the panel");
    expect(server.profileMeta.scribe.description).toBe("Writes release notes");
    await waitFor(() => expect(panelRow("Scratch").querySelector(".bots-name")?.getAttribute("title")).toBe("Edited from the panel"));
    // Still the same bot, and the same one open.
    expect(names()).toEqual(["Hermes", "Scribe", "Scratch"]);
    expect(hermes.profile).toBe("scribe");
    expect(current()).toEqual([null, "true", null]);
    expect(screen.queryByRole("tab", { name: "Profiles" })).toBeNull();
  });

  it("Delete asks first, naming the bot; Cancel deletes nothing, and the bot built into Hermes can't be deleted", async () => {
    const { server, hermes, user } = await launch(withScratch);
    await openScribe(user);
    const hermesMenu = await rightClick(user, "Hermes");
    const del = within(hermesMenu).getByRole("menuitem", { name: "Delete" });
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(within(hermesMenu).getByText("Hermes's built-in profile can't be deleted.")).toBeTruthy();
    await user.click(del);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.keyboard("{Escape}");

    await user.click(within(await rightClick(user, "Scratch")).getByRole("menuitem", { name: "Delete" }));
    let question = await screen.findByRole("alertdialog", { name: /Delete profile “scratch”\?/ });
    await user.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(writes(server)).toEqual([]);
    expect(names()).toEqual(["Hermes", "Scribe", "Scratch"]);

    await user.click(within(await rightClick(user, "Scratch")).getByRole("menuitem", { name: "Delete" }));
    question = await screen.findByRole("alertdialog", { name: /Delete profile “scratch”\?/ });
    const confirm = within(question).getByRole("button", { name: /Delete profile/ });
    expect(confirm).toHaveProperty("disabled", true);
    await user.type(within(question).getByLabelText("Type scratch to confirm"), "scratch");
    await user.click(confirm);
    await waitFor(() => expect(names()).toEqual(["Hermes", "Scribe"]));
    expect(writes(server)).toEqual(["DELETE /api/profiles/scratch"]);
    expect(server.otherProfiles.scratch).toBeUndefined();
    expect(server.otherProfiles.scribe).toBeTruthy();
    expect(screen.getByText("Deleted scratch.")).toBeTruthy();
    expect(hermes.profile).toBe("scribe");
    expect(current()).toEqual([null, "true"]);
  });

  it("keeps the bot's row while a delete runs and after it fails, and says why", async () => {
    const { server, user } = await launch(withScratch);
    let fail!: (e: Error) => void;
    server.profileGatewayStop = new Promise((_, reject) => (fail = reject));
    server.profileGatewayStop.catch(() => {});
    await openScribe(user);
    await user.click(within(await rightClick(user, "Scratch")).getByRole("menuitem", { name: "Delete" }));
    const question = await screen.findByRole("alertdialog", { name: /Delete profile “scratch”\?/ });
    await user.type(within(question).getByLabelText("Type scratch to confirm"), "scratch");
    await user.click(within(question).getByRole("button", { name: /Delete profile/ }));
    await waitFor(() => expect(within(question).getByRole("button", { name: /Deleting/ })).toHaveProperty("disabled", true));
    expect(within(question).getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
    expect(names()).toEqual(["Hermes", "Scribe", "Scratch"]);
    await act(async () => fail(new Error("The connection was reset.")));
    expect((await within(question).findByRole("alert")).textContent).toMatch(/^The profile wasn't deleted: /);
    expect(server.otherProfiles.scratch).toBeTruthy();
    await user.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(names()).toEqual(["Hermes", "Scribe", "Scratch"]);
  });

  it("turns Delete off once this Hermes turns out to have no route for it, and says which", async () => {
    const { server, user } = await launch((s) => {
      withScratch(s);
      s.profileRoutesMissing.add("remove");
    });
    await openScribe(user);
    await user.click(within(await rightClick(user, "Scratch")).getByRole("menuitem", { name: "Delete" }));
    const question = await screen.findByRole("alertdialog", { name: /Delete profile “scratch”\?/ });
    await user.type(within(question).getByLabelText("Type scratch to confirm"), "scratch");
    await user.click(within(question).getByRole("button", { name: /Delete profile/ }));
    await within(question).findByRole("alert");
    await user.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(names()).toEqual(["Hermes", "Scribe", "Scratch"]);
    const del = within(await rightClick(user, "Scratch")).getByRole("menuitem", { name: "Delete" });
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(del.getAttribute("title")).toMatch(/DELETE \/api\/profiles/);
    expect(server.otherProfiles.scratch).toBeTruthy();
  });

  it("Settings opens only the bot picked last, and saves to it, when Hermes answers the first pick later or fails it", async () => {
    const { server, user } = await launch(withScratch);
    await openScribe(user);
    const reads = holdProfileReads(server);
    await user.click(within(await rightClick(user, "Scribe")).getByRole("menuitem", { name: "Settings" }));
    await user.click(within(await rightClick(user, "Scratch")).getByRole("menuitem", { name: "Settings" }));
    await user.click(within(await rightClick(user, "Hermes")).getByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(reads.held).toHaveLength(2));
    // Hermes's Delete is off, so the last pick is Scratch's Settings.
    reads.release();
    await reads.answer(1);
    const dialog = await screen.findByRole("dialog", { name: "Edit bot: Scratch" });
    const description = within(dialog).getByLabelText<HTMLTextAreaElement>("Description");
    await user.clear(description);
    await user.type(description, "Drafted before Scribe's answer");
    await reads.answer(0);
    expect(screen.getAllByRole("dialog", { name: /Edit bot/ })).toEqual([dialog]);
    expect(within(dialog).getByLabelText<HTMLInputElement>("Profile name").value).toBe("scratch");
    expect(within(dialog).getByLabelText<HTMLInputElement>("Name in Bot Mode").value).toBe("Scratch");
    expect(description.value).toBe("Drafted before Scribe's answer");
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull());
    expect(writes(server)).toEqual(["PUT /api/profiles/scratch/description"]);
    expect(server.profileMeta.scratch.description).toBe("Drafted before Scribe's answer");
    expect(server.profileMeta.scribe.description).toBe("Writes release notes");

    // A pick Hermes fails after a later one opened says nothing and closes nothing.
    const again = holdProfileReads(server);
    await user.click(within(await rightClick(user, "Scribe")).getByRole("menuitem", { name: "Settings" }));
    await user.click(within(await rightClick(user, "Scratch")).getByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(again.held).toHaveLength(2));
    again.release();
    await again.answer(1);
    const question = await screen.findByRole("alertdialog", { name: /Delete profile “scratch”\?/ });
    await again.refuse(0);
    expect(screen.queryByText(/^Couldn't open Scribe/)).toBeNull();
    expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull();
    expect(question.isConnected).toBe(true);
    await user.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(server.otherProfiles.scratch).toBeTruthy();
  });

  it("puts focus on a renamed bot's row once listed, from the keyboard", async () => {
    const { server, user } = await launch(withScratch);
    await openScribe(user);
    panelRow("Scratch").focus();
    await user.keyboard("{Shift>}{F10}{/Shift}{ArrowDown}{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Edit bot: Scratch" });
    await user.clear(within(dialog).getByLabelText("Profile name"));
    await user.type(within(dialog).getByLabelText("Profile name"), "spare");
    within(dialog).getByRole("button", { name: /Save changes/ }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull());
    expect(writes(server)).toEqual(["PATCH /api/profiles/scratch"]);
    await waitFor(() => expect(document.activeElement).toBe(panel().querySelector('.bots-row[data-profile="spare"] .bots-open')));
    expect(names()).toEqual(["Hermes", "Scribe", "Scratch"]);
    expect(screen.getByText("Renamed scratch to spare.")).toBeTruthy();
  });

  it("puts focus on the open bot's row after deleting another bot from the keyboard", async () => {
    const { server, user } = await launch(withScratch);
    await openScribe(user);
    panelRow("Scratch").focus();
    await user.keyboard("{Shift>}{F10}{/Shift}{ArrowUp}{Enter}");
    const question = await screen.findByRole("alertdialog", { name: /Delete profile “scratch”\?/ });
    expect(document.activeElement).toBe(within(question).getByLabelText("Type scratch to confirm"));
    await user.keyboard("scratch{Enter}");
    await waitFor(() => expect(names()).toEqual(["Hermes", "Scribe"]));
    expect(writes(server)).toEqual(["DELETE /api/profiles/scratch"]);
    await waitFor(() => expect(document.activeElement).toBe(panelRow("Scribe")));
  });

  it("Delete on the open bot switches to default first, then deletes it", async () => {
    const { server, hermes, user } = await launch(withScratch);
    await openScribe(user);
    await user.click(within(await rightClick(user, "Scribe")).getByRole("menuitem", { name: "Delete" }));
    const question = await screen.findByRole("alertdialog", { name: /Delete profile “scribe”\?/ });
    expect(within(question).getByText("You're using this profile. Highwing will switch to default first.")).toBeTruthy();
    await user.type(within(question).getByLabelText("Type scribe to confirm"), "scribe");
    await user.click(within(question).getByRole("button", { name: /Delete profile/ }));
    await waitFor(() => expect(server.otherProfiles.scribe).toBeUndefined());
    expect(hermes.profile).toBe("default");
    expect(server.otherProfiles.scratch).toBeTruthy();
    await waitFor(() => expect(names()).toEqual(["Hermes", "Scratch"]));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByPlaceholderText(/Message/)));
  });
});

describe("Bots mode without threads (#89)", () => {
  it("lists only the bots, reads no hidden sessions, offers no Thread from here, and leaves hidden and visible sessions as Hermes keeps them", async () => {
    const { server, user } = await launch((s) => {
      s.sessions.push(row("shown", 0.2, { pinned: true, title: "Backups" }), row("hidden", 0.2, { pinned: true, title: "VLAN plan", hidden: true }));
      s.liveSessions = [];
    });
    await waitFor(() => expect(listTitles()).toContain("Backups"));
    expect(listTitles()).not.toContain("VLAN plan");

    await showBots(user);
    expect([...bots().querySelectorAll("li")].every((li) => li.matches(".bots-row, .bots-hidden"))).toBe(true);
    await user.click(botRows()[1]);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Branch from here" }).length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: "Thread from here" })).toBeNull();
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(server.requests.filter((r) => r.method === "session.list" && r.params.title === undefined && r.params.include_hidden === true)).toEqual([]);
    expect(server.sessions.find((s) => s.id === "shown")!.hidden).toBeUndefined();
  });
});
