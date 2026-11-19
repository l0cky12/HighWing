// @vitest-environment jsdom
// An Ask (ADR 0225), as the owner sees it: a message typed in Hermes's Bot Chat that names @quill goes to Quill, and
// Hermes's chat shows an "Asked @quill" card with Quill's reply. The real app over the real transport and FakeHermes.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BOT_CHAT_TITLE } from "../hermes/bots";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { LocaleContext, type Locale } from "../i18n/locale";
import { pseudoLocale, untranslated } from "../i18n/pseudo";
import { Main } from "../App";

const dialog = vi.hoisted(() => ({ picked: null as string[] | null }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/api/core", async (actual) => {
  const core = await actual<typeof import("@tauri-apps/api/core")>();
  return { ...core, invoke: async (cmd: string, ...rest: never[]) => (cmd === "attach_picked_files" ? (dialog.picked ?? []) : core.invoke(cmd, ...rest)) };
});

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
  dialog.picked = null;
});

const SUMMARY = "The owner asked Hermes to plan the release, and Hermes proposed Friday.";
let launches = 0;

/** Hermes's Bot Chat is open, with Quill and Nib on the same server. */
async function launch({ setup = () => {}, locale }: { setup?: (server: FakeHermes) => void; locale?: Locale } = {}) {
  const server = new FakeHermes();
  server.health = { ...server.health, version: "0.23.2", displayVersion: "0.23.2" };
  const botChat = (id: string, n: number) => row(id, n, { title: BOT_CHAT_TITLE, hidden: true });
  server.sessions = [botChat("hermes-bot", 1)];
  server.otherProfiles = { quill: [botChat("quill-bot", 2)], nib: [botChat("nib-bot", 3)] };
  server.transcripts = {
    "hermes-bot": [
      { role: "user", text: "Plan the release.", row_id: 1 },
      { role: "assistant", text: "Ship it on Friday.", row_id: 2 },
    ],
    "quill-bot": [],
    "nib-bot": [],
  };
  server.oneshotAnswer = SUMMARY;
  setup(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  const app = <Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `lena@asking-${++launches}`, url: "", username: "lena" }} onSignOut={async () => {}} />;
  render(locale ? <LocaleContext value={locale}>{app}</LocaleContext> : app);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  const user = userEvent.setup();
  await user.click(document.querySelector<HTMLElement>('.sidebar [role=tab][data-mode="bots"]')!);
  await waitFor(() => expect(document.querySelectorAll(".sb-bots .bots-row")).toHaveLength(3));
  await user.click(document.querySelector<HTMLElement>('.sb-bots .bots-row[data-profile="default"] .bots-open')!);
  await waitFor(() => expect(server.runtimeIdOf("hermes-bot")).toBeTruthy());
  await waitFor(() => expect(document.querySelectorAll(".msg.assistant")).toHaveLength(1));
  return { server, hermes, user };
}

const composer = () => document.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;
const cards = () => Array.from(document.querySelectorAll<HTMLElement>(".msg.returned.asked"));
const heading = (card: HTMLElement) => card.querySelector(".returned-title")?.textContent;
const note = (card: HTMLElement) => card.querySelector(".asked-note")?.textContent;
const submits = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit");
const sessionOf = (server: FakeHermes, stored: string) => [...server.runtime].find(([, s]) => s === stored)![0];
const chip = () => screen.queryByRole("button", { name: /Referenced chat Bot Chat with Hermes/ });

/** Types the words, each `@handle` as its own word, and waits for the chip of this chat's reference to be ready. */
async function write(user: ReturnType<typeof userEvent.setup>, words: string) {
  await user.click(composer());
  await user.type(composer(), words);
  await waitFor(() => expect(chip()?.getAttribute("aria-label")).toContain("Show the summary"));
}

function reply(server: FakeHermes, stored: string, text: string) {
  const sid = sessionOf(server, stored);
  server.event(sid, "message.start");
  server.event(sid, "message.delta", { text });
  server.event(sid, "message.complete", { text, status: "complete" });
}

describe("Naming a bot in a Bot Chat", () => {
  it("references this chat with a chip the owner can remove, and takes it away when no bot is named", async () => {
    const { user } = await launch();
    await write(user, "@quill what do you think?");
    expect(chip()).toBeTruthy();

    await user.clear(composer());
    await waitFor(() => expect(chip()).toBeNull());

    await write(user, "@quill again");
    await user.click(screen.getByRole("button", { name: "Remove the reference to Bot Chat with Hermes" }));
    await user.type(composer(), " and more");
    expect(chip()).toBeNull();
  });

  it("sends the message to the named bot, and this chat's bot takes no turn", { timeout: 30_000 }, async () => {
    const { server, hermes, user } = await launch();
    await write(user, "@quill what do you think?");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(submits(server)).toHaveLength(1));
    expect(submits(server)[0].params).toMatchObject({ profile: "quill", session_id: sessionOf(server, "quill-bot"), queued: true });
    const sent = String(submits(server)[0].params.text);
    expect(sent.startsWith("@quill what do you think?\n\n--- Attached Context ---\n\n[Asked from: hermes-bot]")).toBe(true);
    expect(sent).toContain(`[Referenced chat: Bot Chat with Hermes]`);
    expect(sent.endsWith(SUMMARY)).toBe(true);
    expect(composer().value).toBe("");
    expect(chip()).toBeNull();

    const [card] = cards();
    expect(heading(card)).toBe("Asked @quill");
    expect(card.querySelector(".asked-text")?.textContent).toBe("@quill what do you think?");
    expect(card.querySelector(".ref-chip")?.textContent).toBe("Referenced: Bot Chat with Hermes");
    expect(document.querySelectorAll(".msg.user")).toHaveLength(1);
    expect(hermes.getSnapshot().chats.find((c) => c.id === "hermes-bot")!.running).toBeFalsy();
    expect(document.querySelector(".msg.assistant.thinking")).toBeNull();

    await act(async () => reply(server, "quill-bot", "Ship it, but **fix the changelog** first."));
    await waitFor(() => expect(card.querySelector(".returned-body strong")?.textContent).toBe("fix the changelog"));
    expect(card.querySelector(".asked-from")?.textContent).toBe("QQuill");
    expect(note(card)).toBeUndefined();
    expect(server.transcripts["hermes-bot"]).toHaveLength(2);
  });

  it("shows the reply under the card as it streams", async () => {
    const { server, user } = await launch();
    await write(user, "@quill go");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(submits(server)).toHaveLength(1));
    const sid = sessionOf(server, "quill-bot");
    await act(async () => server.event(sid, "message.start"));
    await waitFor(() => expect(note(cards()[0])).toBe("Quill is replying…"));
    await act(async () => server.event(sid, "message.delta", { text: "Ship " }));
    await waitFor(() => expect(cards()[0].querySelector(".returned-body")?.textContent).toContain("Ship"));
    expect(cards()[0].dataset.state).toBe("replying");
  });

  it("sends a message that names two bots to each, with a card for each", async () => {
    const { server, user } = await launch();
    await write(user, "@quill @nib hi");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(submits(server)).toHaveLength(2));
    expect(submits(server).map((r) => r.params.profile).sort()).toEqual(["nib", "quill"]);
    expect(cards().map(heading)).toEqual(["Asked @quill", "Asked @nib"]);
    await act(async () => {
      reply(server, "nib-bot", "Hi from Nib.");
      reply(server, "quill-bot", "Hi from Quill.");
    });
    await waitFor(() => expect(cards().map((c) => c.querySelector(".returned-body")?.textContent?.trim())).toEqual(["Hi from Quill.", "Hi from Nib."]));
  });

  it("goes without the reference once the owner removed its chip", async () => {
    const { server, user } = await launch();
    await write(user, "@quill no thread");
    await user.click(screen.getByRole("button", { name: "Remove the reference to Bot Chat with Hermes" }));
    await user.click(composer());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(submits(server)).toHaveLength(1));
    expect(String(submits(server)[0].params.text)).not.toContain("[Referenced chat:");
    expect(cards()[0].querySelector(".ref-chip")).toBeNull();
  });

  it.each([
    ["off", (_: FakeHermes) => {}, "false"],
    ["on", (s: FakeHermes) => void (s.profileMeta.quill = { ui_meta: { "hermes-bots": { title: "Quill", pinned: true } } }), "true"],
  ])("works with Bots message each other %s", async (_name, setup, checked) => {
    const { server, user } = await launch({ setup });
    expect(document.querySelector(".sb-bots [role=switch]")?.getAttribute("aria-checked")).toBe(checked);
    await write(user, "@quill ping");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(submits(server)).toHaveLength(1));
    await act(async () => reply(server, "quill-bot", "Pong."));
    await waitFor(() => expect(cards()[0].querySelector(".returned-body")?.textContent?.trim()).toBe("Pong."));
    expect(server.requests.some((r) => r.method === "profiles.configure")).toBe(false);
  });

  it("goes at once while this chat's own bot is replying, and the composer says Enter sends", async () => {
    const { server, hermes, user } = await launch();
    await user.click(composer());
    await user.type(composer(), "Draft the notes.{Enter}");
    await waitFor(() => expect(submits(server)).toHaveLength(1));
    await act(async () => server.event(sessionOf(server, "hermes-bot"), "message.start"));
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "hermes-bot")!.running).toBe(true));

    await write(user, "@quill meanwhile?");
    expect(document.querySelector(".composer-keys")?.textContent).toContain("to send");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(submits(server)).toHaveLength(2));
    expect(submits(server)[1].params.profile).toBe("quill");
    expect(hermes.getSnapshot().queues["hermes-bot"]).toBeUndefined();
  });
});

describe("What an Ask's card says when the message can't go at once", () => {
  it("says the bot is busy while Hermes holds the message, then shows the reply", async () => {
    const { server, user } = await launch({
      setup: (s) => {
        s.reattachTurns = true;
      },
    });
    server.runtime.set("rt-other", "quill-bot");
    server.event("rt-other", "message.start");
    await write(user, "@quill when you're free");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(note(cards()[0])).toBe("Quill is busy with another reply. Hermes gives it your message when that reply ends."));
    expect(cards()[0].dataset.state).toBe("held");

    await act(async () => {
      server.event("rt-other", "message.complete", { text: "Done reviewing.", status: "complete" });
      server.event("rt-other", "message.start");
      server.event("rt-other", "message.delta", { text: "Free now: ship it." });
      server.event("rt-other", "message.complete", { text: "Free now: ship it.", status: "complete" });
    });
    await waitFor(() => expect(cards()[0].querySelector(".returned-body")?.textContent?.trim()).toBe("Free now: ship it."));
    expect(cards()[0].textContent).not.toContain("Done reviewing.");
  });

  it("says it waits while the app is offline, then sends it when the connection is back", async () => {
    const { server, hermes, user } = await launch();
    await write(user, "@quill for later");
    server.refuse = "Connection refused";
    await act(async () => server.drop());
    await waitFor(() => expect(hermes.getSnapshot().status).not.toBe("connected"));

    await user.click(composer());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(note(cards()[0])).toBe("You're offline. This goes to Quill when the connection is back."));
    expect(submits(server)).toHaveLength(0);
    expect(composer().value).toBe("");

    server.refuse = undefined;
    await act(async () => void (await hermes.reconnect()));
    await waitFor(() => expect(submits(server)).toHaveLength(1));
    await act(async () => reply(server, "quill-bot", "Back."));
    await waitFor(() => expect(cards()[0].querySelector(".returned-body")?.textContent?.trim()).toBe("Back."));
  });

  it("says it wasn't sent and why, and Retry sends it again", async () => {
    const { server, user } = await launch();
    server.rejectPrompt = { code: 5001, message: "quill's model has no credentials" };
    await write(user, "@quill please");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(note(cards()[0])).toBe("Not sent to Quill. Quill's model has no credentials."));
    expect(within(cards()[0]).getByRole("alert")).toBeTruthy();

    server.rejectPrompt = undefined;
    await user.click(within(cards()[0]).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(submits(server)).toHaveLength(2));
    await act(async () => reply(server, "quill-bot", "Now it works."));
    await waitFor(() => expect(cards()[0].querySelector(".returned-body")?.textContent?.trim()).toBe("Now it works."));
    expect(cards()).toHaveLength(1);
  });

  it("takes a card that wasn't sent away on Dismiss", async () => {
    const { server, user } = await launch();
    server.rejectPrompt = { code: 5001, message: "No." };
    await write(user, "@quill never mind");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(cards()[0]?.dataset.state).toBe("failed"));
    await user.click(within(cards()[0]).getByRole("button", { name: "Dismiss" }));
    expect(cards()).toHaveLength(0);
  });

  it("keeps a message with a file, and says files go in the bot's own Bot Chat", async () => {
    const { server, user } = await launch();
    server.files = { "/home/lena/df.txt": "Filesystem  Use%\n/dev/sda1   92%\n" };
    dialog.picked = ["/home/lena/df.txt"];
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    await waitFor(() => expect(document.querySelector(".composer .chip-name")?.textContent).toBe("df.txt"));
    await write(user, "@quill look at this");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(Array.from(document.querySelectorAll(".attach-note")).map((n) => n.textContent)).toEqual(["Files can't go with a message that names a bot. Send them in that bot's own Bot Chat."]));
    expect(submits(server)).toHaveLength(0);
    expect(cards()).toHaveLength(0);
    expect(composer().value).toBe("@quill look at this");
  });

  it("offers the bot's own Bot Chat when the bot waits on the owner, and opens it", async () => {
    const { server, hermes, user } = await launch();
    await write(user, "@quill deploy it");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(submits(server)).toHaveLength(1));
    const sid = sessionOf(server, "quill-bot");
    await act(async () => {
      server.event(sid, "message.start");
      server.askApproval(sid);
    });
    await waitFor(() => expect(note(cards()[0])).toBe("Quill is waiting for your answer, which only its own Bot Chat can take."));
    expect(document.querySelector(".approval")).toBeNull();
    await user.click(within(cards()[0]).getByRole("button", { name: "Open Quill's Bot Chat" }));
    await waitFor(() => expect(hermes.profile).toBe("quill"));
  });

  it("says only catalogue words in the card", async () => {
    const p = pseudoLocale();
    const { server, user } = await launch({ locale: p });
    server.rejectPrompt = { code: 5001, message: "No." };
    await user.click(composer());
    await user.type(composer(), "@quill hola");
    await waitFor(() => expect(screen.getByRole("button", { name: /Show the summary/ }).querySelector(".chip-name")?.textContent).toBe(p.chat.ask.thread("Hermes")));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(cards()[0]?.dataset.state).toBe("failed"));
    const [card] = cards();
    expect(heading(card)).toBe(p.chat.ask.asked("quill"));
    expect(Array.from(card.querySelectorAll(".returned-head, .asked-note, .asked-actions, .ref-chip")).flatMap(untranslated)).toEqual([]);
    expect(card.querySelector(".returned-head")?.getAttribute("title")).toBe(p.chat.ask.hide);
  });
});
