// @vitest-environment jsdom
// Set up again in the running app, against a fake Hermes (ADR 0231): where a bot's menu offers it, what its question
// asks and counts, that Keep history sends one hidden brief and Start fresh archives, clears and seeds, and what the app
// says when Start fresh can't go.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BOT_CHAT_TITLE } from "../hermes/bots";
import { botSetupMarkerId } from "../hermes/botSetupBrief";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { en } from "../i18n/en";
import { Main } from "../App";
import { freshNote, keptNote } from "./SetUpAgain";

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

const w = en.bots.again;
const BOT = "travel-buddy";
const OLD = "travel-chat";
let launches = 0;

/** Signed in to `default` on Hermes 0.23.2, Bots mode, with Travel Buddy in its own profile: a Bot Chat and three memory entries. */
async function launch(setup: (server: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.health = { ...server.health, version: "0.23.2", displayVersion: "0.23.2" };
  server.status = { ...server.status, version: "0.23.2" };
  server.learningRoutes = true;
  server.sessions = [row("home-bot", 0.5, { title: BOT_CHAT_TITLE, hidden: true })];
  server.otherProfiles = { [BOT]: [row(OLD, 0.5, { title: BOT_CHAT_TITLE, hidden: true }), row("trip", 1, { title: "Rome in May" })] };
  server.transcripts = {
    [OLD]: [
      { role: "user", text: "Rome to Florence?", row_id: 1 },
      { role: "assistant", text: "The 09:10 Frecciarossa is quickest.", row_id: 2 },
    ],
  };
  server.skills.profiles.add(BOT);
  server.souls[BOT] = "You are Travel Buddy.";
  server.profileMeta = { [BOT]: { description: "Plans trips.", ui_meta: { "hermes-bots": { title: "Travel Buddy", color: "#14b8a6" } } } };
  server.memory[BOT] = { memory: ["Rome trip is in May."], profile: ["The owner wants to be called Lena.", "Prefers trains."] };
  setup(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `lena@again-${++launches}`, url: "", username: "lena" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  await act(async () => void (await hermes.capabilities.refresh()));
  const user = userEvent.setup();
  const bots = document.querySelector<HTMLElement>('.sidebar [role=tab][data-mode="bots"]');
  if (bots) {
    await user.click(bots);
    await waitFor(() => expect(document.querySelectorAll(".sb-bots .bots-row").length).toBe(2));
  }
  return { server, hermes, user };
}

const menuOf = async (user: ReturnType<typeof userEvent.setup>, profile: string) => {
  await user.pointer({ keys: "[MouseRight]", target: document.querySelector<HTMLElement>(`.sb-bots .bots-row[data-profile="${profile}"] .bots-open`)! });
  return screen.getByRole("menu");
};
const entries = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((e) => e.textContent);
async function ask(user: ReturnType<typeof userEvent.setup>, profile = BOT) {
  await user.click(within(await menuOf(user, profile)).getByRole("menuitem", { name: en.bots.menu.again }));
  return screen.getByRole("dialog");
}
const replies = () => [...document.querySelectorAll(".msg.assistant p")].map((e) => e.textContent);
const toast = () => document.querySelector<HTMLElement>(".toast")?.textContent ?? "";
const sent = (server: FakeHermes, method: string) => server.requests.filter((r) => r.method === method);
const store = (server: FakeHermes) => server.otherProfiles[BOT];
const memoryOf = (server: FakeHermes) => [...server.memory[BOT].memory, ...server.memory[BOT].profile];
const wrote = (server: FakeHermes, from: number) => server.restRequests.slice(from).filter((r) => r.method !== "GET" && !/\/read$|last_read/.test(r.path) && r.body?.unread === undefined);

describe("Set up again in a bot's menu", { timeout: 30_000 }, () => {
  it("is offered on Hermes 0.23.2, after Edit persona", async () => {
    const { user } = await launch();
    expect(entries(await menuOf(user, BOT)).slice(0, 4)).toEqual(["Chat", "Settings", "Edit persona…", "Set up again…"]);
  });

  it("isn't offered below Hermes 0.23.2", async () => {
    const { user } = await launch((s) => {
      s.health = { ...s.health, version: "0.23.1", displayVersion: "0.23.1" };
      s.status = { ...s.status, version: "0.23.1" };
    });
    const menu = await menuOf(user, BOT);
    expect(entries(menu)).toContain("Edit persona…");
    expect(entries(menu)).not.toContain("Set up again…");
  });

  it("isn't offered on a Hermes without Bot Mode, which has no bots to set up", async () => {
    const { hermes } = await launch((s) => (s.botMode = "none"));
    expect(document.querySelector('.sidebar [role=tab][data-mode="bots"]')).toBeNull();
    expect(hermes.botSetupOff()).toBe("noBotMode");
  });
});

describe("Set up again's question", { timeout: 30_000 }, () => {
  it("asks Keep history or Start fresh, counts the memory entries Start fresh deletes, and turns its button red", async () => {
    const { server, user } = await launch();
    const restFrom = server.restRequests.length;
    const dialog = await ask(user);
    expect(within(dialog).getByRole("heading").textContent).toBe(w.title("Travel Buddy"));
    const keep = within(dialog).getByRole("radio", { name: new RegExp(`^${w.keep}`) }) as HTMLInputElement;
    const fresh = within(dialog).getByRole("radio", { name: new RegExp(`^${w.fresh}`) }) as HTMLInputElement;
    expect([keep.checked, fresh.checked]).toEqual([true, false]);
    expect(within(dialog).getByRole("button", { name: w.go }).className).toContain("primary");
    await waitFor(() => expect(within(dialog).getByText(new RegExp("Deletes Travel Buddy's 3 memory entries\\."))).toBeTruthy());

    await user.click(fresh);
    expect(within(dialog).getByText(w.freshWarn("Travel Buddy", 3))).toBeTruthy();
    expect(w.freshWarn("Travel Buddy", 3)).toContain("can't be brought back");
    expect(within(dialog).getByRole("button", { name: w.goFresh }).className).toContain("danger");

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(wrote(server, restFrom)).toEqual([]);
    expect(sent(server, "prompt.submit")).toEqual([]);
    expect(memoryOf(server)).toHaveLength(3);
  });

  it("never offers Start fresh for the main bot", async () => {
    const { user } = await launch();
    const dialog = await ask(user, "default");
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(within(dialog).getByText(w.noFreshDefault)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: w.go })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: w.goFresh })).toBeNull();
  });

  for (const [busy, status] of [["replying", "working"], ["waiting", "waiting"]] as const)
    it(`says why neither can go while the bot is ${busy} in its Bot Chat, and sends nothing`, async () => {
      const { server, user } = await launch((s) => (s.liveSessions = [{ id: "rt-t", session_key: OLD, status, last_active: Date.now() / 1000 }]));
      await waitFor(() => expect(document.querySelector(`.bots-row[data-profile="${BOT}"]`)?.className).toMatch(/is-(replying|needs-you)/));
      const restFrom = server.restRequests.length;
      const dialog = await ask(user);
      expect(within(dialog).getByRole("alert").textContent).toBe(w.busy[busy]("Travel Buddy"));
      await user.click(within(dialog).getByRole("radio", { name: new RegExp(`^${w.fresh}`) }));
      await user.click(within(dialog).getByRole("button", { name: w.goFresh }));
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(wrote(server, restFrom)).toEqual([]);
      expect(sent(server, "prompt.submit")).toEqual([]);
      expect(store(server).find((s) => s.id === OLD)).toMatchObject({ archived: false, title: BOT_CHAT_TITLE });
      expect(memoryOf(server)).toHaveLength(3);
    });

  it("turns Start fresh off, with the reason, when the memory it would delete can't be read", async () => {
    const { user } = await launch((s) => {
      s.learningRoutes = false;
      s.learningMethods = false;
    });
    const dialog = await ask(user);
    await waitFor(() => expect(within(dialog).getByText(/^Start fresh is off, because Highwing couldn't read the memory it would delete:/)).toBeTruthy());
    expect((within(dialog).getByRole("radio", { name: new RegExp(`^${w.fresh}`) }) as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog).getByRole("button", { name: w.go })).toBeTruthy();
  });
});

describe("Set up again, once asked", { timeout: 30_000 }, () => {
  it("Keep history goes to the bot and sends one hidden brief into its Bot Chat, and nothing to its profile", async () => {
    const { server, hermes, user } = await launch();
    const restFrom = server.restRequests.length;
    await user.click(within(await ask(user)).getByRole("button", { name: w.go }));
    await waitFor(() => expect(sent(server, "prompt.submit")).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(hermes.profile).toBe(BOT);
    const [brief] = sent(server, "prompt.submit");
    expect(brief.params).toMatchObject({ profile: BOT, display_kind: "hidden" });
    expect(botSetupMarkerId(String(brief.params.text))).toBeTruthy();
    expect(String(brief.params.text)).toContain('You are "Travel Buddy", one of the owner\'s bots.');
    expect(String(brief.params.text)).toContain('"persona":"You are Travel Buddy.","description":"Plans trips."');
    expect(sent(server, "session.create")).toEqual([]);
    expect(wrote(server, restFrom)).toEqual([]);
    expect(memoryOf(server)).toHaveLength(3);
    await waitFor(() => expect(screen.getByText(en.chat.botSetup.started)).toBeTruthy());
    expect(replies()).toEqual(["The 09:10 Frecciarossa is quickest."]);
    expect(document.querySelectorAll(".msg.user")).toHaveLength(1);
  });

  it("Start fresh archives the Bot Chat under a name, deletes the counted memory entries and opens a new Bot Chat with the brief seeded", async () => {
    const { server, hermes, user } = await launch();
    const dialog = await ask(user);
    await user.click(within(dialog).getByRole("radio", { name: new RegExp(`^${w.fresh}`) }));
    await waitFor(() => expect((within(dialog).getByRole("button", { name: w.goFresh }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(within(dialog).getByRole("button", { name: w.goFresh }));
    await waitFor(() => expect(sent(server, "prompt.submit")).toHaveLength(1), { timeout: 5000 });

    const old = store(server).find((s) => s.id === OLD)!;
    expect(old).toMatchObject({ archived: true, hidden: false });
    expect(old.title).toMatch(/^Earlier Bot Chat with Travel Buddy, /);
    expect(memoryOf(server)).toEqual([]);
    const [made] = store(server).filter((s) => s.title === BOT_CHAT_TITLE);
    expect(made.id).not.toBe(OLD);
    const [create] = sent(server, "session.create");
    expect(create.params).toMatchObject({ profile: BOT, title: BOT_CHAT_TITLE, messages: [{ role: "user", display_kind: "hidden" }] });
    expect(String((create.params.messages as { content: string }[])[0].content)).toContain("Bot setup again");
    expect(store(server).find((s) => s.id === "trip")).toMatchObject({ archived: false });

    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === made.id)?.bot).toBe(true));
    await waitFor(() => expect(screen.getByText(en.chat.botSetup.started)).toBeTruthy());
    expect(replies()).toEqual([]);
    expect(toast()).toBe("");
  });

  it("says this Hermes can't start a Bot Chat fresh when the title is still found: the chat is back and the memory untouched", async () => {
    const { server, user } = await launch((s) => (s.archiveKeepsBotChatTitle = true));
    const dialog = await ask(user);
    await user.click(within(dialog).getByRole("radio", { name: new RegExp(`^${w.fresh}`) }));
    await waitFor(() => expect((within(dialog).getByRole("button", { name: w.goFresh }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(within(dialog).getByRole("button", { name: w.goFresh }));
    await waitFor(() => expect(toast()).toBe(w.titleKept("Travel Buddy", true)), { timeout: 5000 });
    expect(w.titleKept("Travel Buddy", true)).toContain("This Hermes can't start a Bot Chat fresh");
    expect(store(server).find((s) => s.id === OLD)).toMatchObject({ archived: false, title: BOT_CHAT_TITLE });
    expect(memoryOf(server)).toHaveLength(3);
    expect(sent(server, "session.create")).toEqual([]);
    expect(sent(server, "prompt.submit")).toEqual([]);
    await waitFor(() => expect(replies()).toEqual(["The 09:10 Frecciarossa is quickest."]));
  });
});

describe("What the app says after Set up again", () => {
  const started = { kind: "waiting", chatId: "c", id: "s" } as const;

  it("says nothing when all of it went", () => {
    expect(keptNote(w, "Travel Buddy", started)).toBeUndefined();
    expect(freshNote(w, "Travel Buddy", { kind: "fresh", start: started, missed: {}, memoryLeft: 0 })).toBeUndefined();
  });

  it("gives the reason for a refusal", () => {
    expect(keptNote(w, "Travel Buddy", { kind: "refused", reason: "replying" })).toBe(w.busy.replying("Travel Buddy"));
    expect(freshNote(w, "Travel Buddy", { kind: "refused", reason: "waiting" })).toBe(w.busy.waiting("Travel Buddy"));
    expect(freshNote(w, "Hermes", { kind: "refused", reason: "default" })).toBe(w.isDefault);
    expect(freshNote(w, "Travel Buddy", { kind: "refused", reason: "tooOld" })).toBe(w.off);
  });

  it("says what Hermes holds when Start fresh stopped, and what a finished one left", () => {
    expect(freshNote(w, "Travel Buddy", { kind: "stopped", at: "archive", left: "asItWas", why: "Offline." })).toBe("Start fresh stopped before anything changed for Travel Buddy: Offline.");
    expect(freshNote(w, "Travel Buddy", { kind: "stopped", at: "lookup", left: "archived", why: "Offline." })).toContain("No memory was deleted.");
    expect(freshNote(w, "Travel Buddy", { kind: "stopped", at: "start", left: "noChat", why: "Offline." })).toContain("the new one didn't start");
    expect(freshNote(w, "Travel Buddy", { kind: "titleKept", restored: false })).toContain("still archived");
    expect(freshNote(w, "Travel Buddy", { kind: "fresh", start: started, missed: { retitle: "Title in use." }, memoryLeft: 2 })).toBe(
      "The old Bot Chat is in Archived without a name: Title in use. 2 memory entries weren't deleted. Settings → Memory shows what is left.",
    );
    expect(freshNote(w, "Travel Buddy", { kind: "fresh", start: started, missed: { memory: "Can't read it." }, memoryLeft: 0 })).toBe("The memory wasn't cleared: Can't read it.");
  });
});
