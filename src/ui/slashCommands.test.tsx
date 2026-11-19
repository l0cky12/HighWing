// @vitest-environment jsdom
// Slash commands in the running app, against a fake Hermes: the menu by keyboard, what never sends by accident, text
// that stays an ordinary message, the Delete question, and answers that come after the profile changed.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { RestError } from "../hermes/pipe";
import { BOT_CHAT_TITLE } from "../hermes/bots";
import { LocaleContext, type Locale } from "../i18n/locale";
import { pseudoLocale } from "../i18n/pseudo";

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

let launches = 0;

/** The app signed in to a fake Hermes, with the chat "Nightly backup" open. */
async function launch(setup: (server: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  server.otherProfiles = { work: [row("deploy", 1, { pinned: true, title: "Deploy plan" })] };
  setup(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `lena@slash-${++launches}`, url: "", username: "lena" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /Nightly backup/ }));
  await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "backup")?.runtimeId).toBeTruthy());
  await act(async () => void (await hermes.idle()));
  return { server, hermes, user };
}

const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const options = () => within(screen.getByRole("listbox", { name: "Commands" })).getAllByRole("option");
const selected = () => options().find((o) => o.getAttribute("aria-selected") === "true")!;
const sent = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit").map((r) => r.params.text);

/** Starts a reply in the open chat, which the fake keeps running until told otherwise. */
async function startReply(user: ReturnType<typeof userEvent.setup>, hermes: Hermes) {
  await user.type(composer(), "Run the backup{Enter}");
  await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "backup")?.running).toBe(true));
}

describe("The slash command menu", () => {
  it("opens on a leading /, filters as the owner types, and is driven by the keyboard alone", async () => {
    const { server, user } = await launch();
    await user.click(composer());
    await user.keyboard("/");
    expect(options().map((o) => o.querySelector(".cmd-name")!.textContent)).toEqual(["/help", "/new", "/rename", "/delete", "/steer", "/btw", "/context", "/goal"]);
    // Each says what it does, its argument, and whether the app or Hermes runs it.
    const steer = options()[4];
    expect(steer.textContent).toMatch(/<message>.*Hermes.*Tell the running reply something/);
    expect(options()[2].textContent).toMatch(/<title>.*App.*Rename this chat/);
    expect(composer().getAttribute("aria-activedescendant")).toBe(selected().id);

    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(selected().textContent).toMatch(/^\/rename/);
    await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(selected().textContent).toMatch(/^\/goal/);

    await user.keyboard("{Backspace}/ren");
    expect(options().map((o) => o.querySelector(".cmd-name")!.textContent)).toEqual(["/rename"]);
    // Enter fills the command in and sends nothing.
    await user.keyboard("{Enter}");
    expect(composer().value).toBe("/rename ");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(sent(server)).toEqual([]);

    await user.keyboard("Weekly backup{Enter}");
    await waitFor(() => expect(server.sessions.find((s) => s.id === "backup")?.title).toBe("Weekly backup"));
    await waitFor(() => expect(composer().value).toBe(""));
    expect(sent(server)).toEqual([]);
  });

  it("closes on Escape without sending or losing the text, and Tab fills in too", async () => {
    const { server, user } = await launch();
    await user.click(composer());
    await user.keyboard("/con");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(composer().value).toBe("/con");
    expect(sent(server)).toEqual([]);
    // Typing again opens it again.
    await user.keyboard("t");
    expect(options()).toHaveLength(1);
    await user.keyboard("{Tab}");
    expect(composer().value).toBe("/context");
    expect(document.activeElement).toBe(composer());
  });

  it("leaves the keys to an input method while it composes", async () => {
    const { server, user } = await launch();
    await user.click(composer());
    await user.keyboard("/ren");
    fireEvent.keyDown(composer(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(composer(), { key: "ArrowDown", isComposing: true });
    fireEvent.keyDown(composer(), { key: "Escape", isComposing: true });
    expect(composer().value).toBe("/ren");
    expect(options()).toHaveLength(1);
    expect(sent(server)).toEqual([]);
  });

  it("goes away for a new line, and a multiline argument reaches Hermes as typed", async () => {
    const { server, hermes, user } = await launch();
    await startReply(user, hermes);
    await user.click(composer());
    await user.keyboard("/steer");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.keyboard("skip the logs{Shift>}{Enter}{/Shift}  and report sizes{Enter}");
    await waitFor(() => expect(server.last("command.dispatch")?.params).toEqual({ name: "steer", arg: "skip the logs\n  and report sizes", session_id: server.runtimeIdOf("backup") }));
    expect(await screen.findByText(/Steer queued — arrives after the next tool call/)).toBeTruthy();
    expect(composer().value).toBe("");
    expect(sent(server)).toEqual(["Run the backup"]);
  });
});

describe("Text that starts with /", () => {
  it("is sent as an ordinary message unless it is one of the commands", async () => {
    const { server, hermes, user } = await launch();
    await user.click(composer());
    await user.keyboard("/deploy");
    expect(screen.getByRole("status").textContent).toMatch(/No command is called \/deploy\. Enter sends it as an ordinary message/);
    // The menu has nothing to pick, so Enter sends.
    await user.keyboard(" now{Enter}");
    await waitFor(() => expect(sent(server)).toEqual(["/deploy now"]));
    act(() => server.event(server.runtimeIdOf("backup")!, "message.complete", { text: "Done." }));
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "backup")?.running).toBeFalsy());

    await user.keyboard("/help me read this log{Enter}");
    await waitFor(() => expect(sent(server)).toEqual(["/deploy now", "/help me read this log"]));
  });

  it("a command that can't run now says why and keeps the text", async () => {
    const { server, user } = await launch();
    await user.click(composer());
    await user.keyboard("/steer stop here");
    await user.keyboard("{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe("/steer can't run: No reply is running to steer. Send it as a message instead.");
    expect(composer().value).toBe("/steer stop here");
    await user.clear(composer());
    await user.keyboard("/rename{Escape}{Enter}");
    expect(screen.getByRole("alert").textContent).toBe("/rename can't run: /rename needs <title>.");
    expect(server.requests.some((r) => r.method === "command.dispatch")).toBe(false);
    expect(sent(server)).toEqual([]);
  });

  it("a server command this Hermes doesn't list is marked so, and explains it", async () => {
    const { server, user } = await launch((s) => (s.commandCatalog = undefined));
    await user.click(composer());
    await user.keyboard("/cont");
    expect(options()[0].querySelector(".cmd-why")!.textContent).toMatch(/Couldn't check whether this Hermes has it: This Hermes doesn't list its commands\. Update Hermes/);
    await user.keyboard("{Enter}{Enter}");
    expect(screen.getByRole("alert").textContent).toMatch(/^\/context can't run: Couldn't check/);
    expect(composer().value).toBe("/context");
    expect(server.requests.some((r) => r.method === "slash.exec")).toBe(false);
  });

  it("a failed server command keeps the text and says what Hermes said", async () => {
    const { server, user } = await launch();
    server.handlers["slash.exec"] = (r) => server.fail(r.id, 5030, "slash worker start failed: boom");
    await user.click(composer());
    await user.keyboard("/context{Enter}{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe("/context didn't run: slash worker start failed: boom");
    expect(composer().value).toBe("/context");
  });
});

describe("Commands", () => {
  it("/context shows Hermes's answer under the composer", async () => {
    const { server, user } = await launch();
    await user.click(composer());
    await user.keyboard("/context{Enter}{Enter}");
    const note = await screen.findByText(/Context window: 12,400/);
    expect(note.closest(".cmd-note")!.querySelector(".cmd-note-title")!.textContent).toBe("/context");
    expect(server.last("slash.exec")?.params).toEqual({ command: "/context", session_id: server.runtimeIdOf("backup") });
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Context window/)).toBeNull();
    expect(document.activeElement).toBe(composer());
  });

  it("/steer after the reply ended is sent as the next message, as Hermes asks", async () => {
    const { server, hermes, user } = await launch((s) => (s.steerable = false));
    await startReply(user, hermes);
    await user.keyboard("/steer then tidy up{Enter}");
    await waitFor(() => expect(sent(server)).toEqual(["Run the backup", "then tidy up"]));
    expect(await screen.findByText(/No agent running; sent as next turn/)).toBeTruthy();
  });

  it("/delete asks first: Cancel keeps the chat and the text, Delete deletes it", async () => {
    const { server, user } = await launch();
    await user.click(composer());
    await user.keyboard("/delete{Enter}{Enter}");
    const ask = screen.getByRole("alertdialog", { name: "Delete this chat?" });
    expect(ask.textContent).toMatch(/Delete this chat in every Hermes client\? This can't be undone\./);
    expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Cancel" }));
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(composer().value).toBe("/delete");
    expect(document.activeElement).toBe(composer());
    expect(server.restRequests.some((r) => r.method === "DELETE")).toBe(false);

    // Escape cancels too.
    await user.keyboard("{Enter}");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(server.restRequests.some((r) => r.method === "DELETE")).toBe(false);

    await user.keyboard("{Enter}");
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(server.restRequests.some((r) => r.method === "DELETE" && r.path === "/api/sessions/backup")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Nightly backup/ })).toBeNull());
    expect(composer().value).toBe("");
  });

  it("/delete can't run while a reply is running", async () => {
    const { server, hermes, user } = await launch();
    await startReply(user, hermes);
    await user.keyboard("/delete{Enter}{Enter}");
    expect(screen.getByRole("alert").textContent).toBe("/delete can't run: A chat with a reply running can't be deleted.");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(server.restRequests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("/new opens the New chat pane, and /help lists every command until Escape", async () => {
    const { user } = await launch();
    await user.click(composer());
    await user.keyboard("/help{Enter}{Enter}");
    const help = screen.getByRole("region", { name: "Commands" });
    expect(within(help).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["In this app", "On Hermes, for this chat"]);
    expect(help.textContent).toMatch(/\/rename<title>Rename this chat in every Hermes client/);
    expect(help.textContent).toMatch(/\/steer<message>.*No reply is running to steer/);
    expect(composer().value).toBe("");
    expect(document.activeElement).toBe(composer());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Commands" })).toBeNull();

    await user.keyboard("/new{Enter}{Enter}");
    await waitFor(() => expect(screen.getByText("What should Hermes work on?")).toBeTruthy());
    expect(composer().value).toBe("");
  });
});

describe("A command's late answer", () => {
  it("after a profile switch shows nowhere, and the text typed stays in the chat it was typed in", async () => {
    const { server, hermes, user } = await launch();
    let answer!: () => void;
    server.handlers["slash.exec"] = (r) => (answer = () => server.respond(r.id, { output: "Context window: late" }));
    await user.click(composer());
    await user.keyboard("/context{Enter}{Enter}");
    expect(await screen.findByText(/Running \/context/)).toBeTruthy();

    await user.click(document.querySelector<HTMLElement>(".profile-btn")!);
    await user.click(await screen.findByRole("option", { name: /work/ }));
    await waitFor(() => expect(hermes.getSnapshot()).toMatchObject({ profile: "work", status: "connected" }));
    await waitFor(() => expect(hermes.getSnapshot().switching).toBeUndefined());
    act(() => answer());
    await act(async () => void (await hermes.idle()));
    expect(screen.queryByText(/Context window: late/)).toBeNull();
    expect(screen.queryByText(/Running \/context/)).toBeNull();

    // Back in the first profile, the chat still has the text.
    await user.click(document.querySelector<HTMLElement>(".profile-btn")!);
    await user.click(await screen.findByRole("option", { name: /default/ }));
    await waitFor(() => expect(hermes.getSnapshot()).toMatchObject({ profile: "default", status: "connected" }));
    await user.click(await screen.findByRole("button", { name: /Nightly backup/ }));
    await waitFor(() => expect(composer().value).toBe("/context"));
    expect(screen.queryByText(/Context window: late/)).toBeNull();
  });
});

describe("Review regressions", () => {
  it("never runs a /steer that a quick command of that name would replace", async () => {
    const { server, hermes, user } = await launch((s) => (s.quickCommands = { steer: "exec: ./deploy.sh" }));
    await startReply(user, hermes);
    await user.keyboard("/steer stop now{Enter}");
    expect(screen.getByRole("alert").textContent).toMatch(/^\/steer can't run: This Hermes has a quick or plugin command called \/steer/);
    expect(server.requests.some((r) => r.method === "command.dispatch")).toBe(false);
    expect(composer().value).toBe("/steer stop now");
  });

  it("a /steer Hermes asks to send keeps what the owner typed meanwhile", async () => {
    const { server, hermes, user } = await launch((s) => (s.steerable = false));
    await startReply(user, hermes);
    const dispatch = server.handlers["command.dispatch"];
    let answer!: () => void;
    server.handlers["command.dispatch"] = (r) => (answer = () => dispatch(r));
    await user.keyboard("/steer then tidy up{Enter}");
    await user.clear(composer());
    await user.keyboard("Something else entirely");
    act(() => answer());
    await waitFor(() => expect(sent(server)).toEqual(["Run the backup", "then tidy up"]));
    expect(composer().value).toBe("Something else entirely");
  });

  it("an answer that comes after the owner opened another chat leaves the first chat's text", async () => {
    const { server, user } = await launch((s) => s.sessions.push(row("nginx", 2, { pinned: true, title: "Rotate nginx logs" })));
    let answer!: () => void;
    server.handlers["slash.exec"] = (r) => (answer = () => server.respond(r.id, { output: "Context window: late" }));
    await user.click(composer());
    await user.keyboard("/context{Enter}{Enter}");
    await user.click(screen.getByRole("button", { name: /Rotate nginx logs/ }));
    act(() => answer());
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    await waitFor(() => expect(composer().value).toBe("/context"));
    expect(screen.queryByText(/Context window: late/)).toBeNull();
  });

  it("a delete Hermes refuses keeps the text in the chat", async () => {
    const { server, user } = await launch();
    server.rest["DELETE /api/sessions/backup"] = () => {
      throw new RestError(403, `{"detail":"Not allowed"}`);
    };
    await user.click(composer());
    await user.keyboard("/delete{Enter}{Enter}");
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: /Nightly backup/ }));
    await waitFor(() => expect(composer().value).toBe("/delete"));
  });

  it("two panes on one chat can't run the same command twice", async () => {
    const { server, user } = await launch();
    let answer!: () => void;
    server.handlers["slash.exec"] = (r) => (answer = () => server.respond(r.id, { output: "Context window: once" }));
    await user.keyboard("{Control>}\\{/Control}");
    const [left, right] = screen.getAllByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
    await user.click(left);
    await user.keyboard("/context{Enter}{Enter}");
    await waitFor(() => expect(right.value).toBe("/context"));
    await user.click(right);
    await user.keyboard("{Enter}{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe("/context didn't run: A command typed in this chat is still running.");
    act(() => answer());
    await screen.findByText(/Context window: once/);
    expect(server.requests.filter((r) => r.method === "slash.exec")).toHaveLength(1);
  });
});

describe("The @ menu in a Bot Chat", () => {
  const BOTS = { ada: "Writes the release notes", bram: "Reviews pull requests", cleo: "Watches the nightly jobs" };

  /** The app on a fake Hermes whose bots are Hermes (default), ada, bram and cleo, with ada's Bot Chat open. */
  async function inAdasBotChat(locale?: Locale) {
    const server = new FakeHermes();
    server.sessions = [row("hermes-bot", 1, { title: BOT_CHAT_TITLE, hidden: true }), row("backup", 1, { pinned: true, title: "Nightly backup" }), row("deploy", 1, { title: "Deploy pipeline" })];
    server.otherProfiles = { ada: [row("ada-bot", 2, { title: BOT_CHAT_TITLE, hidden: true }), row("notes", 2, { title: "Release notes" })] };
    for (const [profile, description] of Object.entries(BOTS)) {
      server.otherProfiles[profile] ??= [row(`${profile}-bot`, 1, { title: BOT_CHAT_TITLE, hidden: true })];
      server.profileMeta[profile] = { description, ui_meta: { "hermes-bots": { title: profile[0].toUpperCase() + profile.slice(1), color: "#3b82f6" } } };
    }
    const hermes = await connect(server.openPipe, undefined, memoryCache());
    running.push(hermes);
    const app = <Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `lena@slash-${++launches}`, url: "", username: "lena" }} onSignOut={async () => {}} />;
    render(locale ? <LocaleContext value={locale}>{app}</LocaleContext> : app);
    await waitFor(() => expect(hermes.hasListed()).toBe(true));
    await act(async () => void (await hermes.checkOtherProfiles()));
    const user = userEvent.setup();
    await user.click(document.querySelector<HTMLElement>('.sidebar [role=tab][data-mode="bots"]')!);
    await waitFor(() => expect(document.querySelectorAll(".sb-bots .bots-row")).toHaveLength(4));
    await user.click(document.querySelector<HTMLElement>('.sb-bots .bots-row[data-profile="ada"] .bots-open')!);
    await waitFor(() => expect(hermes.profile).toBe("ada"));
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "ada-bot")?.runtimeId).toBeTruthy());
    await act(async () => void (await hermes.idle()));
    return { server, hermes, user };
  }

  const box = () => document.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;
  const menu = () => screen.getByRole("listbox", { name: "Bots and chats" });
  const menuLines = () => Array.from(menu().querySelectorAll(".cmd-group, [role=option]")).map((e) => (e.matches(".cmd-group") ? `# ${e.textContent}` : e.textContent));
  const pill = () => document.querySelector<HTMLElement>(".inline-mark[data-mention]");

  // jsdom lays nothing out, so each word under a pill reports one box, as a browser would.
  beforeAll(() => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
      return [{ left: 0, top: 0, width: 40, height: 20, right: 40, bottom: 20, x: 0, y: 0, toJSON: () => ({}) }] as unknown as DOMRectList;
    });
  });

  it("lists the other bots, with Hermes as @hermes, above the chats, and leaves out the bot whose chat it is", { timeout: 30_000 }, async () => {
    const { user } = await inAdasBotChat();
    await user.click(box());
    await user.keyboard("@");
    expect(menuLines()).toEqual([
      "# Bots",
      "HHermes@hermes",
      `BBram@bram${BOTS.bram}`,
      `CCleo@cleo${BOTS.cleo}`,
      "# Chats",
      "Release notes",
    ]);
    expect(menu().textContent).not.toContain("@ada");
  });

  it("matches the start of a handle or of a word of the name, and opens the same menu from the @ button", { timeout: 30_000 }, async () => {
    const { user } = await inAdasBotChat();
    await user.click(box());
    await user.keyboard("@he");
    expect(menuLines()).toEqual(["# Bots", "HHermes@hermes"]);
    await user.keyboard("{Escape}");
    await user.clear(box());
    await user.click(screen.getByRole("button", { name: "Name a bot or reference a chat" }));
    expect(box().value).toBe("@");
    expect(menuLines()[0]).toBe("# Bots");
    expect(menuLines()).toContain("# Chats");
  });

  it("puts @handle in as a pill on Tab or Enter, sends nothing, and takes the pill out whole with Backspace", { timeout: 30_000 }, async () => {
    const { server, user } = await inAdasBotChat();
    await user.click(box());
    await user.keyboard("@br");
    expect(pill()).toBeNull();
    await user.keyboard("{Tab}");
    expect(box().value).toBe("@bram ");
    expect(screen.queryByRole("listbox")).toBeNull();
    await waitFor(() => expect(pill()?.textContent).toBe("@bram"));
    await user.keyboard("{Backspace}");
    expect(box().value).toBe("");
    expect(pill()).toBeNull();

    await user.keyboard("ask @cl{Enter}");
    expect(box().value).toBe("ask @cleo ");
    await waitFor(() => expect(pill()?.textContent).toBe("@cleo"));
    expect(server.requests.filter((r) => r.method === "prompt.submit")).toEqual([]);
  });

  it("puts the caret after the space when the pick leaves the words as they were, so Backspace takes the pill and the space", { timeout: 30_000 }, async () => {
    const { user } = await inAdasBotChat();
    await user.click(box());
    await user.keyboard("@bram {ArrowLeft}");
    expect(menuLines()).toEqual(["# Bots", `BBram@bram${BOTS.bram}`]);
    await user.keyboard("{Tab}");
    expect([box().value, box().selectionStart]).toEqual(["@bram ", 6]);
    await user.keyboard("{Backspace}");
    expect(box().value).toBe("");
  });

  it("shows the @ being typed as words while the menu is open on it, and as a pill once the word is done", { timeout: 30_000 }, async () => {
    const { user } = await inAdasBotChat();
    await user.click(box());
    await user.keyboard("@bram");
    expect(menuLines()).toEqual(["# Bots", `BBram@bram${BOTS.bram}`]);
    expect(pill()).toBeNull();
    await user.keyboard(" ");
    await waitFor(() => expect(pill()?.textContent).toBe("@bram"));
  });

  it("still references a chat picked from Chats as a chip, with no pill", { timeout: 30_000 }, async () => {
    const { user } = await inAdasBotChat();
    await user.click(box());
    await user.keyboard("see @rel{Enter}");
    expect(box().value).toBe("see ");
    expect(screen.getByRole("button", { name: /^Referenced chat Release notes/ })).toBeTruthy();
    expect(pill()).toBeNull();
  });

  it("lists only chats, with no Bots group, in an ordinary chat once the bots are known", { timeout: 30_000 }, async () => {
    const { hermes, user } = await inAdasBotChat();
    expect(hermes.getSnapshot().bots?.roster.map((b) => b.handle)).toEqual(["hermes", "ada", "bram", "cleo"]);
    await user.click(document.querySelector<HTMLElement>('.sidebar [role=tab][data-mode="chats"]')!);
    await waitFor(() => expect(hermes.profile).toBe("default"));
    await user.click(await screen.findByRole("button", { name: /Nightly backup/ }));
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "backup")?.runtimeId).toBeTruthy());
    await user.click(box());
    await user.keyboard("@");
    const list = screen.getByRole("listbox", { name: "Chats" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["Deploy pipeline"]);
    expect(list.querySelector(".cmd-group")).toBeNull();
    expect(screen.getByRole("button", { name: "Reference a chat" })).toBeTruthy();
  });

  it("names its groups, the menu and the button in the app's language", { timeout: 30_000 }, async () => {
    const p = pseudoLocale();
    const { user } = await inAdasBotChat(p);
    await user.click(screen.getByRole("button", { name: p.chat.at.button }));
    const list = screen.getByRole("listbox", { name: p.chat.at.menu });
    expect(Array.from(list.querySelectorAll(".cmd-group")).map((g) => g.textContent)).toEqual([p.chat.at.bots, p.chat.at.chats]);
    expect(document.querySelector(".cmd-keys")?.textContent).toBe(p.chat.at.keys);
  });
});
