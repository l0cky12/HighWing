// @vitest-environment jsdom
// The Bots view in the running app, against a fake Hermes as the deployed f0d94882 (ADR 0066): what each bot's row
// shows, that a row opens the bot's Bot Chat in its profile and keeps it out of the chat list, that the pen starts an
// ordinary chat there, that /new in a Bot Chat compacts it, that the chat list panel shows the chats or the bots as the
// owner picks with the switch at its top, that a Hermes without Bot Mode shows no Bots button and no switch, and each row's menu (ADR 0189): Edit bot,
// Clone, Pin, Hide, Delete and Open in Settings → Profiles, and the menu of a bot in the chat list panel (ADR 0194): Chat,
// Settings and Delete.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { BOT_CHAT_TITLE, BotModeUnsupportedError, rosterOf, type Bot } from "../hermes/bots";
import { getUIPrefs } from "../hermes/uiPrefs";
import { Bots, BOTS_REFRESH_MS } from "./Bots";
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
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `liam@hermes-${++launches}`, url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  await act(async () => void (await hermes.checkOtherProfiles()));
  return { server, hermes, user: userEvent.setup() };
}

const botsButton = () => document.querySelector<HTMLButtonElement>(".bots-btn");
const bots = () => screen.getByRole("dialog", { name: /Bots/ });
const botRows = () => Array.from(bots().querySelectorAll<HTMLButtonElement>(".bots-open"));
const listTitles = () => [...document.querySelectorAll(".sidebar .row-title")].map((e) => e.textContent);

async function pickProfile(user: ReturnType<typeof userEvent.setup>, profile: string) {
  await user.click(document.querySelector<HTMLElement>(".profile-btn")!);
  await user.click(await screen.findByRole("option", { name: new RegExp(`^${profile}`) }));
}

async function openBots(user: ReturnType<typeof userEvent.setup>) {
  await user.click(botsButton()!);
  await waitFor(() => expect(botRows().length).toBe(2));
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

describe("The Bots view", () => {
  it("lists every profile as a bot, with its description, its Bot Chat's last message and what it is doing", async () => {
    const { user } = await launch();
    await openBots(user);
    const [hermesRow, scribeRow] = botRows();
    expect(within(hermesRow).getByText("Hermes")).toBeTruthy();
    expect(within(hermesRow).getByText("No Bot Chat yet. Open it to start one.")).toBeTruthy();
    expect(within(scribeRow).getByText("Scribe")).toBeTruthy();
    expect(within(scribeRow).getByText("Writes release notes")).toBeTruthy();
    expect(within(scribeRow).getByText("Release notes drafted: three fixes.")).toBeTruthy();
    expect(within(scribeRow).getByText("Replying")).toBeTruthy();
    expect(scribeRow.getAttribute("aria-label")).toMatch(/^Scribe\. Replying\. Writes release notes\. Last message: Release notes drafted/);
    expect(screen.getByRole("button", { name: "New chat with Scribe" })).toBeTruthy();
  });

  it("shows only the bots whose name holds what is typed in the search box, in any case, and not their description", async () => {
    const { user } = await launch();
    await openBots(user);
    const search = within(bots()).getByRole("textbox", { name: "Search bots" });
    await user.type(search, "SCRI");
    expect(botRows().map((r) => r.querySelector(".bots-name")?.textContent)).toEqual(["Scribe"]);
    await user.clear(search);
    await user.type(search, "release");
    expect(botRows()).toEqual([]);
    expect(within(bots()).getByText("No bots match “release”.")).toBeTruthy();
    await user.clear(search);
    expect(botRows().length).toBe(2);
  });

  it("opens a bot's Bot Chat in its profile, and keeps it out of the chat list", async () => {
    const { server, hermes, user } = await launch();
    await openBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(hermes.profile).toBe("scribe"));
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    expect(screen.queryByRole("dialog", { name: /Bots/ })).toBeNull();
    // Looked up by title, not created.
    expect(server.requests.filter((r) => r.method === "session.list").map((r) => r.params.title)).toEqual([BOT_CHAT_TITLE]);
    expect(server.requests.filter((r) => r.method === "session.create")).toEqual([]);
    expect(hermes.getSnapshot().chats.find((c) => c.id === "scribe-bot")?.bot).toBe(true);
    // The panel shows the bots meanwhile; back on the chat list, it lists the side-chat only.
    await user.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(listTitles()).toEqual(["Changelog wording"]));
  });

  it("marks the open Bot Chat as one, and offers nothing that would rename, retire or link it by id", async () => {
    const { user } = await launch();
    await openBots(user);
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
    await openBots(user);
    await user.click(botRows()[0]);
    await waitFor(() => expect(server.sessions.some((s) => s.title === BOT_CHAT_TITLE && s.hidden)).toBe(true));
    expect(server.requests.filter((r) => r.method === "session.create")).toHaveLength(1);
    expect(server.requests.filter((r) => r.method === "prompt.submit")).toEqual([]);
    const id = server.sessions.find((s) => s.title === BOT_CHAT_TITLE)!.id;
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === id)?.bot).toBe(true));
  });

  it("starts an ordinary chat in the bot's profile from the pen", async () => {
    const { server, hermes, user } = await launch();
    await openBots(user);
    await user.click(screen.getByRole("button", { name: "New chat with Scribe" }));
    await waitFor(() => expect(hermes.profile).toBe("scribe"));
    await waitFor(() => expect(screen.getByText("What should Scribe work on?")).toBeTruthy());
    expect(server.requests.filter((r) => r.method === "session.list")).toEqual([]);
  });

  it("compacts a Bot Chat for /new instead of starting a new chat", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await openBots(user);
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

describe("New bot in the Bots view", () => {
  const form = () => screen.getByRole("dialog", { name: "New bot" });

  it("makes a profile through New profile's form and shows the new bot's row, focused, without starting its Bot Chat", async () => {
    const { server, user } = await launch();
    await openBots(user);
    await user.click(screen.getByRole("button", { name: "New bot" }));
    await user.type(within(form()).getByLabelText("Name"), "ada");
    await user.type(within(form()).getByLabelText("Description (optional)"), "Reads papers");
    await user.click(within(form()).getByRole("button", { name: /Create bot/ }));
    await waitFor(() => expect(botRows()).toHaveLength(3));
    expect(screen.queryByRole("dialog", { name: "New bot" })).toBeNull();
    expect(server.restRequests.filter((r) => r.method !== "GET").map((r) => [`${r.method} ${r.path}`, r.body])).toEqual([["POST /api/profiles", { name: "ada", description: "Reads papers" }]]);
    const ada = botRows().find((r) => r.querySelector(".bots-name")?.textContent === "Ada")!;
    expect(within(ada).getByText("Reads papers")).toBeTruthy();
    expect(within(ada).getByText("No Bot Chat yet. Open it to start one.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(ada));
    expect(within(bots()).getByRole("status").textContent).toBe("Created ada. Open its row to start its Bot Chat.");
    expect(server.requests.filter((r) => r.method === "session.create" || r.method === "prompt.submit")).toEqual([]);
  });

  it("clears a search that would hide the new bot, so its row is shown and focused", async () => {
    const { user } = await launch();
    await openBots(user);
    await user.type(screen.getByLabelText("Search bots"), "scribe");
    await user.click(screen.getByRole("button", { name: "New bot" }));
    await user.type(within(form()).getByLabelText("Name"), "ada");
    await user.click(within(form()).getByRole("button", { name: /Create bot/ }));
    await waitFor(() => expect(botRows()).toHaveLength(3));
    expect(screen.getByLabelText("Search bots")).toHaveProperty("value", "");
    const ada = botRows().find((r) => r.querySelector(".bots-name")?.textContent === "Ada")!;
    await waitFor(() => expect(document.activeElement).toBe(ada));
  });

  it("refuses a name another bot's profile has, before asking Hermes", async () => {
    const { server, user } = await launch();
    await openBots(user);
    await user.click(screen.getByRole("button", { name: "New bot" }));
    await user.type(within(form()).getByLabelText("Name"), "scribe");
    expect(within(form()).getByText("There's already a profile named scribe. Pick another name.")).toBeTruthy();
    expect(within(form()).getByRole("button", { name: /Create bot/ })).toHaveProperty("disabled", true);
    expect(server.restRequests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  /** The Bots view with its first roster read still pending: `arrive` gives it `roster` and answers the read. */
  async function pending() {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe, undefined, memoryCache());
    running.push(hermes);
    let answer = () => {};
    const view = (last?: { roster: Bot[]; at: number }) => (
      <Bots
        server="hermes"
        profile="default"
        connected
        last={last}
        pictures={{}}
        load={() => new Promise<void>((done) => (answer = done))}
        activity={() => undefined}
        onOpen={() => {}}
        onNewChat={() => {}}
        onRefresh={() => {}}
        onClose={onClose}
        profiles={{
          api: hermes.manageProfiles,
          inUse: "default",
          connected: true,
          unread: () => undefined,
          catalog: async () => [],
          busy: () => undefined,
          lostMessages: () => 0,
          jobCount: async () => undefined,
          switchTo: async () => false,
          local: { pending: () => undefined, note: () => {}, clear: () => {}, renamed: async () => {}, deleted: async () => {} },
          copyText: async () => {},
        }}
      />
    );
    const { rerender } = render(view());
    expect(screen.getByText("Reading the bots…")).toBeTruthy();
    const arrive = (roster: Bot[]) =>
      act(async () => {
        rerender(view({ roster, at: Date.now() }));
        answer();
      });
    return { user, onClose, server, arrive };
  }

  it("keeps focus in the form when the roster arrives after it opened", async () => {
    const { user, onClose, arrive } = await pending();
    await user.click(screen.getByRole("button", { name: "New bot" }));
    const name = within(form()).getByLabelText("Name");
    await user.type(name, "ada");
    await arrive(rosterOf({ profiles: [{ name: "default", canonical_session: null }] }));
    expect(botRows()).toHaveLength(1);
    expect(document.activeElement).toBe(name);
    await user.keyboard("{Escape}");
    expect(within(form()).getByText("The changes you made here aren't saved.")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("waits for the roster before creating, so a taken name never reaches Hermes", async () => {
    const { user, server, arrive } = await pending();
    await user.click(screen.getByRole("button", { name: "New bot" }));
    await user.type(within(form()).getByLabelText("Name"), "scribe");
    const create = within(form()).getByRole("button", { name: /Create bot/ });
    expect(create).toHaveProperty("disabled", true);
    expect(within(form()).getByRole("status").textContent).toBe("Wait for the list of profiles, so the name can be checked against it.");
    await user.click(create);
    await user.keyboard("{Enter}");
    expect(server.restRequests.filter((r) => r.method !== "GET")).toEqual([]);
    await arrive(rosterOf({ profiles: [{ name: "default", canonical_session: null }, { name: "scribe", canonical_session: null }] }));
    expect(within(form()).getByText("There's already a profile named scribe. Pick another name.")).toBeTruthy();
    expect(create).toHaveProperty("disabled", true);
    expect(server.restRequests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("closes only the form on Escape, with focus back on New bot", async () => {
    const { user } = await launch();
    await openBots(user);
    await user.click(screen.getByRole("button", { name: "New bot" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "New bot" })).toBeNull();
    expect(bots()).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New bot" }));
  });
});

describe("A bot's menu in the Bots view", { timeout: 30_000 }, () => {
  const rowOf = (profile: string) => bots().querySelector<HTMLElement>(`.bots-row[data-profile="${profile}"]`)!;
  const names = () => botRows().map((r) => r.querySelector(".bots-name")?.textContent);
  const block = (server: FakeHermes, profile = "scribe") => server.profileMeta[profile]?.ui_meta?.["hermes-bots"] as Record<string, unknown>;
  const writes = (server: FakeHermes) => server.restRequests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
  const sent = (server: FakeHermes, method: string) => server.requests.filter((r) => r.method === method);
  const menuOf = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await user.click(within(bots()).getByRole("button", { name: `More for ${name}` }));
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
    await pickFrom(user, "Scribe", "Edit bot…");
    return screen.findByRole("dialog", { name: "Edit bot: Scribe" });
  };

  it("opens from the ⋯ button, a right-click, Shift+F10 and the Menu key, and Escape closes the menu alone", async () => {
    const { user } = await launch();
    await openBots(user);
    const menu = await menuOf(user, "Scribe");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Edit bot…", "Clone…", "Pin", "Hide", "Open in Settings → Profiles", "Delete bot…"]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(bots()).toBeTruthy();
    for (const open of [
      () => user.pointer({ keys: "[MouseRight]", target: botRows()[1] }),
      async () => (botRows()[1].focus(), await user.keyboard("{Shift>}{F10}{/Shift}")),
      async () => (within(rowOf("scribe")).getByRole("button", { name: "New chat with Scribe" }).focus(), await user.keyboard("{ContextMenu}")),
    ]) {
      await open();
      expect(screen.getByRole("menu", { name: "More for Scribe" })).toBeTruthy();
      // The menu works from the keyboard: Down moves on from its first entry.
      expect(document.activeElement?.textContent).toBe("Edit bot…");
      await user.keyboard("{ArrowDown}");
      expect(document.activeElement?.textContent).toBe("Clone…");
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).toBeNull();
      expect(bots()).toBeTruthy();
    }
  });

  it("pins and unpins a bot in Hermes, moving its row, and keeps what Hermes's desktop wrote beside it", async () => {
    const { server, user } = await launch(withDesktopKeys);
    await openBots(user);
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
    await openBots(user);
    await pickFrom(user, "Scribe", "Hide");
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
    await openBots(user);
    await pickFrom(user, "Scribe", "Pin");
    const why = "This Hermes server can't do this: it has no route for profiles.configure. Updating Hermes adds it.";
    expect((await within(bots()).findByRole("status")).textContent).toBe(`Scribe wasn't changed. ${why}`);
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
    await openBots(user);
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
    expect(within(rowOf("scribe")).getByText("Drafts the changelog")).toBeTruthy();
    expect(rowOf("scribe").querySelector<HTMLElement>(".bots-face")!.style.background).toBe("rgb(255, 136, 0)");
    expect(within(bots()).getByRole("status").textContent).toBe("Saved scribe.");
  });

  it("Edit bot shows Hermes's new name and stays open when the name changed elsewhere", async () => {
    const { server, user } = await launch(withDesktopKeys);
    await openBots(user);
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
    await openBots(user);
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
    await openBots(user);
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
    await openBots(user);
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
    await openBots(user);
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
    expect(within(bots()).getByRole("status").textContent).toBe("Renamed scribe to quill.");
    await waitFor(() => expect(document.activeElement).toBe(within(rowOf("quill")).getByRole("button", { name: /^Writer/ })));
    expect(hermes.profile).toBe("default");
  });

  it("Edit bot says so when Hermes no longer has the profile, and opens nothing", async () => {
    const { server, user } = await launch();
    await openBots(user);
    delete server.otherProfiles.scribe;
    await pickFrom(user, "Scribe", "Edit bot…");
    expect((await within(bots()).findByRole("status")).textContent).toBe("Hermes no longer has scribe. Another client may have renamed or deleted it.");
    expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull();
    await waitFor(() => expect(names()).toEqual(["Hermes"]));
  });

  it("Clone… opens the Clone dialog with this bot as the source", async () => {
    const { user } = await launch();
    await openBots(user);
    await pickFrom(user, "Scribe", "Clone…");
    const dialog = await screen.findByRole("dialog", { name: "Clone a profile" });
    await waitFor(() => expect(within(dialog).getByLabelText("From")).toHaveProperty("value", "scribe"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Clone a profile" })).toBeNull());
    expect(bots()).toBeTruthy();
  });

  it("Delete bot… deletes through Settings → Profiles' question, and default can't be deleted", async () => {
    const { server, user } = await launch();
    await openBots(user);
    const hermesMenu = await menuOf(user, "Hermes");
    const del = within(hermesMenu).getByRole("menuitem", { name: "Delete bot…" });
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(within(hermesMenu).getByText("Hermes's built-in profile can't be deleted.")).toBeTruthy();
    await user.click(del);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.keyboard("{Escape}");

    await pickFrom(user, "Scribe", "Delete bot…");
    const question = await screen.findByRole("alertdialog", { name: /Delete profile “scribe”\?/ });
    const confirm = within(question).getByRole("button", { name: /Delete profile/ });
    expect(confirm).toHaveProperty("disabled", true);
    await user.type(within(question).getByLabelText("Type scribe to confirm"), "scribe");
    await user.click(confirm);
    await waitFor(() => expect(names()).toEqual(["Hermes"]));
    expect(writes(server)).toEqual(["DELETE /api/profiles/scribe"]);
    expect(server.otherProfiles.scribe).toBeUndefined();
    expect(within(bots()).getByRole("status").textContent).toBe("Deleted scribe.");
    expect(bots().contains(document.activeElement)).toBe(true);
  });

  it("Delete bot… switches to default first when the bot's profile is the one in use", async () => {
    const { server, hermes, user } = await launch();
    await pickProfile(user, "scribe");
    await waitFor(() => expect(hermes.profile).toBe("scribe"));
    await openBots(user);
    await pickFrom(user, "Scribe", "Delete bot…");
    const question = await screen.findByRole("alertdialog", { name: /Delete profile “scribe”\?/ });
    expect(within(question).getByText("You're using this profile. Highwing will switch to default first.")).toBeTruthy();
    await user.type(within(question).getByLabelText("Type scribe to confirm"), "scribe");
    await user.click(within(question).getByRole("button", { name: /Delete profile/ }));
    await waitFor(() => expect(server.otherProfiles.scribe).toBeUndefined());
    expect(hermes.profile).toBe("default");
    await waitFor(() => expect(names()).toEqual(["Hermes"]));
  });

  it("opens only the bot picked last when Hermes answers the first pick later", async () => {
    const { server, user } = await launch();
    await openBots(user);
    const reads = holdProfileReads(server);
    await pickFrom(user, "Scribe", "Edit bot…");
    await pickFrom(user, "Hermes", "Edit bot…");
    await waitFor(() => expect(reads.held).toHaveLength(2));
    reads.release();
    await reads.answer(1);
    const dialog = await screen.findByRole("dialog", { name: "Edit bot: Hermes" });
    await reads.answer(0);
    expect(screen.getAllByRole("dialog", { name: /Edit bot/ })).toEqual([dialog]);
    expect(dialog.isConnected).toBe(true);
    expect(screen.queryByRole("dialog", { name: "Edit bot: Scribe" })).toBeNull();
  });

  it("Open in Settings → Profiles opens Settings on that bot's profile", async () => {
    const { user } = await launch();
    await openBots(user);
    await pickFrom(user, "Scribe", "Open in Settings → Profiles");
    expect(screen.queryByRole("dialog", { name: /Bots/ })).toBeNull();
    const list = await screen.findByRole("listbox", { name: "Profiles" });
    await waitFor(() => expect(within(list).getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true")?.getAttribute("data-profile")).toBe("scribe"));
    expect(screen.getByRole("tab", { name: "Profiles" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("Opening the Bots view", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgo=";
  const names = () => botRows().map((r) => r.querySelector(".bots-name")?.textContent);
  const picture = (i: number) => botRows()[i].querySelector("img")?.getAttribute("src");
  /** Holds every later `profiles.list` until `release`, so the view can show only what the app already read. */
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
    await user.click(botsButton()!);
    expect(names()).toEqual(["Hermes", "Scribe"]);
    expect(picture(1)).toBe(PNG);
    expect(screen.queryByText("Reading the bots…")).toBeNull();
    expect(document.activeElement).toBe(botRows()[0]);
  });

  it("shows them at once on reopening, and doesn't ask for the pictures again on the same connection", async () => {
    const { server, hermes, user } = await launch((s) => (s.botAvatars = { scribe: PNG }));
    await openBots(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /Bots/ })).toBeNull();
    const release = holdRosters(server);
    await user.click(botsButton()!);
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
      await user.click(botsButton()!);
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
  const under = () => panel().querySelector<HTMLElement>(".bots-chats");
  const underTitles = () => [...(under()?.querySelectorAll(".row-title") ?? [])].map((e) => e.textContent);
  const shownMode = () => within(panel()).getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")?.textContent;
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
    await waitFor(() => expect(under()).toBeTruthy());
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

  it("puts the shown profile's chats under its bot: Active first, then the newest Settled up to three", async () => {
    await launchMany();
    expect(under()!.closest(".bots-under")!.previousElementSibling?.getAttribute("data-profile")).toBe("default");
    expect(under()!.getAttribute("aria-label")).toBe("Hermes's chats");
    expect(underTitles()).toEqual(["Backup failing", "Disk usage", "Settled 1"]);
    const marked = [...under()!.querySelectorAll(".row")].map((r) => !!r.querySelector('.bots-chat-mark[aria-label="In the Inbox"]'));
    expect(marked).toEqual([true, true, false]);
    expect(within(under()!).getByRole("button", { name: "All 8 chats" })).toBeTruthy();
  });

  it("adds the chat in the pane, marked selected, and opens a chat from under the bot", async () => {
    const { user } = await launchMany();
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByPlaceholderText("Search all chats, including Settled"), "Settled 6");
    await waitFor(() => expect(document.querySelector(".hit-row")).toBeTruthy());
    await user.click(document.querySelector<HTMLElement>(".hit-row")!);
    await waitFor(() => expect(underTitles()).toEqual(["Backup failing", "Disk usage", "Settled 1", "Settled 6"]));
    const open = within(under()!).getByRole("button", { name: /Settled 6/ });
    expect(open.getAttribute("aria-current")).toBe("true");
    await user.click(within(under()!).getByRole("button", { name: /Disk usage/ }));
    await waitFor(() => expect(within(under()!).getByRole("button", { name: /Disk usage/ }).getAttribute("aria-current")).toBe("true"));
    expect(shownMode()).toBe("Bots");
  });

  it("picks Chats from All N chats", async () => {
    const { user } = await launchMany();
    await user.click(within(under()!).getByRole("button", { name: "All 8 chats" }));
    expect(shownMode()).toBe("Chats");
    expect(listTitles()).toEqual(["Backup failing", "Disk usage"]);
  });

  it("walks the bots and the chats under the shown one as one list with Up and Down", async () => {
    const { user } = await launchMany();
    const hermesRow = panel().querySelector<HTMLElement>('.bots-row[data-profile="default"] .bots-open')!;
    hermesRow.focus();
    const walk: string[] = [];
    for (let i = 0; i < 5; i++) {
      await user.keyboard("{ArrowDown}");
      const at = document.activeElement;
      walk.push(at?.closest(".bots-row")?.getAttribute("data-profile") ?? at?.querySelector(".row-title")?.textContent ?? at?.textContent ?? "");
    }
    expect(walk).toEqual(["Backup failing", "Disk usage", "Settled 1", "All 8 chats", "scribe"]);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement?.textContent).toBe("All 8 chats");
  });

  it("follows the shown profile: its bot's row holds its chats", async () => {
    const { hermes, user } = await launchMany();
    await user.click(panel().querySelector<HTMLElement>('.bots-row[data-profile="scribe"] .bots-open')!);
    await waitFor(() => expect(hermes.profile).toBe("scribe"));
    await waitFor(() => expect(under()?.getAttribute("aria-label")).toBe("Scribe's chats"));
    expect(under()!.closest(".bots-under")!.previousElementSibling?.getAttribute("data-profile")).toBe("scribe");
    await waitFor(() => expect(underTitles()).toEqual(["Changelog wording"]));
    expect(within(under()!).getByRole("button", { name: "All 1 chat" })).toBeTruthy();
  });
});

describe("Chats mode", () => {
  const panel = () => document.querySelector<HTMLElement>(".sidebar")!;
  const line = () => panel().querySelector<HTMLElement>(".sb-needs-you");
  const botChatRow = () => panel().querySelector<HTMLButtonElement>(".sb-botchat-row .row-open");
  const shownMode = () => within(panel()).getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")?.textContent;
  const waiting = (key: string, id = "rt-s") => ({ id, session_key: key, status: "waiting" as const, last_active: nowS() });

  it("lays out the switch, the profile switcher, New chat and Search, the Bot Chat row, then the project switcher and the chats", async () => {
    await launch();
    const order = [".sb-mode", ".sb-profile", ".sb-actions", ".sb-botchat", ".sb-project", ".sb-scroll"].map((sel) => panel().querySelector(sel));
    expect(order.every(Boolean)).toBe(true);
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it("shows the Bot Chat row with how long ago its bot was active, out of the sections", async () => {
    await launch();
    expect(botChatRow()!.textContent).toMatch(/^HBot Chat\d+[mhd]$/);
    expect(botChatRow()!.getAttribute("aria-label")).toBe("Hermes's Bot Chat");
    expect(listTitles()).toEqual(["Disk usage"]);
  });

  it("shows Replying on the Bot Chat row while its bot replies, and its last message in its tip", async () => {
    const { user } = await launch();
    await pickProfile(user, "scribe");
    await waitFor(() => expect(botChatRow()?.textContent).toBe("SBot ChatReplying"));
    expect(botChatRow()!.title).toBe("Scribe's Bot Chat (Alt+B)\nRelease notes drafted: three fixes.");
    expect(botChatRow()!.getAttribute("aria-keyshortcuts")).toBe("Alt+B");
  });

  it("shows Needs you on the Bot Chat row while its bot waits on the owner", async () => {
    const { user } = await launch((s) => (s.liveSessions = [waiting("scribe-bot")]));
    await pickProfile(user, "scribe");
    await waitFor(() => expect(botChatRow()?.textContent).toBe("SBot ChatNeeds you"));
    expect(line()).toBeNull();
  });

  it("opens the shown profile's Bot Chat from its row, marked selected while it is in the active pane", async () => {
    const { user } = await launch();
    await pickProfile(user, "scribe");
    await waitFor(() => expect(botChatRow()).toBeTruthy());
    expect(botChatRow()!.getAttribute("aria-current")).toBeNull();
    await user.click(botChatRow()!);
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    await waitFor(() => expect(botChatRow()!.getAttribute("aria-current")).toBe("true"));
    expect(botChatRow()!.closest(".row")!.classList.contains("sel")).toBe(true);
    expect(shownMode()).toBe("Chats");
    await user.click(screen.getByText("Changelog wording"));
    await waitFor(() => expect(botChatRow()!.getAttribute("aria-current")).toBeNull());
  });
});

describe("The pane names the bot", () => {
  const head = () => document.querySelector<HTMLElement>(".chat-head .chat-title")!;
  const tabTitles = () => [...document.querySelectorAll(".tabs [role=tab]")].map((t) => t.textContent);

  async function openBotChatOf(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
    await openBots(user);
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
    await user.click(botsButton()!);
    await waitFor(() => expect(botRows().length).toBe(3));
    await user.click(botRows().find((r) => /Hermes Chat/.test(r.textContent ?? ""))!);
    await waitFor(() => expect(screen.getByText("Ping")).toBeTruthy());
    expect(head().textContent).toBe("HHermes ChatBot Chat");
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
    await waitFor(() => expect(botsButton()).toBeNull());
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
    await openBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(head().textContent).toBe("SScribeBot Chat"));
    await altB(user);
    await waitFor(() => expect(screen.getByText("What should Scribe work on?")).toBeTruthy());
  });

  it("goes back to the chat left from the Bot Chat row's click too", async () => {
    const { user } = await launch((s) => (s.liveSessions = []));
    await pickProfile(user, "scribe");
    await user.click(await screen.findByText("Changelog wording"));
    await waitFor(() => expect(head().textContent).toMatch(/^Changelog wording/));
    await user.click(document.querySelector<HTMLElement>(".sb-botchat-row .row-open")!);
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
    await openBots(user);
    await user.click(botRows()[0]);
    await waitFor(() => expect(head().textContent).toBe("HHermesBot Chat"));
    await altB(user);
    await waitFor(() => expect(screen.getByText("What should Hermes work on?")).toBeTruthy());
  });
});

describe("A Hermes without Bot Mode", () => {
  it("shows no Bots button once the check finds no profiles.list", async () => {
    const { hermes } = await launch((s) => (s.botMode = "none"));
    await act(async () => void (await hermes.capabilities.refresh()));
    await waitFor(() => expect(botsButton()).toBeNull());
  });

  it("shows no Bots button once the check finds a profiles.list that doesn't report Bot Chats, without opening the view", async () => {
    const { hermes } = await launch((s) => (s.botMode = "no-canonical"));
    await act(async () => void (await hermes.capabilities.refresh()));
    await waitFor(() => expect(botsButton()).toBeNull());
    expect(hermes.capabilities.get("botMode").why).toMatch(/doesn't report their Bot Chats/);
  });

  it("says why in the view when it finds out there, with focus on Close so Escape closes it", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onUnsupported = vi.fn();
    render(
      <Bots
        server="hermes"
        profile="default"
        connected
        pictures={{}}
        load={async () => {
          throw new BotModeUnsupportedError("This Hermes lists its profiles but doesn't report their Bot Chats, so it has no Bot Mode.");
        }}
        activity={() => undefined}
        onOpen={() => {}}
        onNewChat={() => {}}
        onRefresh={() => {}}
        onClose={onClose}
        onUnsupported={onUnsupported}
      />,
    );
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/so it has no Bot Mode\. Highwing shows no Bots button for it\.$/));
    expect(onUnsupported).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement?.classList.contains("bots-close")).toBe(true));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
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
    await openBots(user);
    await user.click(botRows()[0]);
    await waitFor(() => expect(server.requests.some((r) => r.method === "session.list")).toBe(true));
    await user.click(screen.getByText("Disk usage"));
    await waitFor(() => expect(screen.getByText("How full is the disk?")).toBeTruthy());
    await act(async () => release());
    await waitFor(() => expect(server.sessions.some((s) => s.title === BOT_CHAT_TITLE)).toBe(true));
    // The Bot Chat was made, but the pane stays on the chat the owner picked.
    await act(async () => void (await hermes.idle()));
    expect(screen.getByText("How full is the disk?")).toBeTruthy();
    expect(document.querySelector(".chat-head")?.textContent).toMatch(/Disk usage/);
  });

  it("drops the open once the owner picks another profile before the bot's list loads, even after coming back", async () => {
    const { server, hermes, user } = await launch();
    // The scribe profile's list is held, so the open waits for it.
    const list = server.rest["GET /api/sessions"];
    const held: (() => void)[] = [];
    let holding = true;
    server.rest["GET /api/sessions"] = (req) =>
      holding && req.query.get("profile") === "scribe" ? new Promise((resolve) => held.push(() => resolve(list(req)))) : list(req);
    await openBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(hermes.profile).toBe("scribe"));
    await pickProfile(user, "default");
    await waitFor(() => expect(listTitles()).toEqual(["Disk usage"]));
    holding = false;
    held.splice(0).forEach((f) => f());
    await pickProfile(user, "scribe");
    await waitFor(() => expect(listTitles()).toEqual(["Changelog wording"]));
    await act(async () => void (await hermes.idle()));
    // Coming back is an ordinary switch: no Bot Chat lookup, and the Bot Chat doesn't open.
    expect(server.requests.filter((r) => r.method === "session.list")).toEqual([]);
    expect(screen.queryByText("Draft the release notes for 0.9")).toBeNull();
  });
});

describe("A Bot Chat outside the list", () => {
  it("keeps the rail's dot for an Approval in a Bot Chat resumed here, after switching away from its profile", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await openBots(user);
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
    await waitFor(() => expect(botsButton()?.getAttribute("aria-label")).toBe("Bots, one needs you"));
  });

  it("stays out of the list after switching away and back, and isn't the chat reopened at launch", async () => {
    const { hermes, user } = await launch();
    await openBots(user);
    await user.click(botRows()[1]);
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
    await openBots(user);
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

  it("stays on the chats when a Bot Chat opens from the Bots view", async () => {
    const { user } = await launch();
    await openBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    expect(shownMode()).toBe("Chats");
    await waitFor(() => expect(listTitles()).toEqual(["Changelog wording"]));
    expect(panelBots()).toEqual([]);
  });

  it("shows the bots in Bots mode, under New chat and Search, with the open Bot Chat's bot current", async () => {
    const { user } = await launch();
    await openScribe(user);
    expect(shownMode()).toBe("Bots");
    expect(current()).toEqual([null, "true"]);
    expect(within(panelBots()[1]).getByText("Release notes drafted: three fixes.")).toBeTruthy();
    expect(listTitles()).toEqual(["Changelog wording"]);
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

  it("stays in Bots mode on New chat, with no bot current", async () => {
    const { user } = await launch();
    await openScribe(user);
    await user.click(within(panel()).getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(screen.getByText("What should Scribe work on?")).toBeTruthy());
    expect(shownMode()).toBe("Bots");
    expect(current()).toEqual([null, null]);
  });

  it("stays in Bots mode on Ctrl+N", async () => {
    const { user } = await launch();
    await openScribe(user);
    await user.keyboard("{Control>}n{/Control}");
    await waitFor(() => expect(screen.getByText("What should Scribe work on?")).toBeTruthy());
    expect(shownMode()).toBe("Bots");
    expect(names()).toEqual(["Hermes", "Scribe"]);
  });

  it("stays in Bots mode when an ordinary chat opens from search", async () => {
    const { user } = await launch();
    await openScribe(user);
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByPlaceholderText("Search all chats, including Settled"), "Changelog");
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

  it("asks before a bot in another profile opens while an Approval waits here, as the Bots view does", async () => {
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
    render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `liam@hermes-${launches}`, url: "", username: "liam" }} onSignOut={async () => {}} />);
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

describe("A Hermes without Bot Mode", () => {
  it("has no switch: the panel is the chats, with the profile switcher at its top", async () => {
    const { hermes } = await launch((s) => (s.botMode = "none"));
    await act(async () => void (await hermes.capabilities.refresh()));
    await waitFor(() => expect(botsButton()).toBeNull());
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
    await user.click(botsButton()!);
    await waitFor(() => expect(botRows().length).toBe(count));
    await user.click(botRows().find((r) => r.textContent?.includes("Scribe"))!);
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    await user.click(within(panel()).getByRole("tab", { name: /^Bots/ }));
    await waitFor(() => expect(panelBots().length).toBe(count));
  }

  async function rightClick(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.pointer({ keys: "[MouseRight]", target: panelRow(name) });
    return screen.getByRole("menu", { name: `More for ${name}` });
  }

  it("opens on a right-click on any row, selected or not, with Chat, Settings and Delete, and switches nothing", async () => {
    const { server, hermes, user } = await launch(withScratch);
    await openScribe(user);
    expect(names()).toEqual(["Hermes", "Scribe", "Scratch"]);
    const before = server.requests.length;
    for (const name of ["Hermes", "Scribe", "Scratch"]) {
      const menu = await rightClick(user, name);
      expect(entries(menu).map((i) => i.textContent)).toEqual(["Chat", "Settings", "Delete"]);
      expect(entries(menu)[2].classList.contains("danger")).toBe(true);
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
    await waitFor(() => expect(within(panelRow("Scratch")).getByText("Edited from the panel")).toBeTruthy());
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
    await user.keyboard("{Shift>}{F10}{/Shift}{ArrowDown}{ArrowDown}{Enter}");
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
