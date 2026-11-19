// @vitest-environment jsdom
// The owner's "@" in a Bot Chat, in the app (ADR 0233), and a bot picked from the "@" menu in an ordinary chat (ADR
// 0234): the chip for this chat, the send to the named bot, the composer's refusals, and the Asked card with the reply.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { askStamp } from "../hermes/asks";
import { BOT_CHAT_TITLE } from "../hermes/bots";
import { PICK_MARK } from "../hermes/mentionPicker";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { LocaleContext, type Locale } from "../i18n/locale";
import { pseudoLocale, untranslated } from "../i18n/pseudo";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
    return [{ left: 0, top: 0, width: 40, height: 20, right: 40, bottom: 20, x: 0, y: 0, toJSON: () => ({}) }] as unknown as DOMRectList;
  });
});
const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const SUMMARY = "The owner and Hermes planned the backup window.";
let launches = 0;

/** Signed in, Bots mode, Hermes's Bot Chat open. */
async function inHermesBotChat(setup: (server: FakeHermes) => void = () => {}, locale?: Locale) {
  const server = new FakeHermes();
  server.sessions = [row("hermes-bot", 1, { title: BOT_CHAT_TITLE, hidden: true })];
  server.otherProfiles = { quill: [row("quill-bot", 2, { title: BOT_CHAT_TITLE, hidden: true })] };
  server.transcripts = {
    "hermes-bot": [
      { role: "user", text: "When should backups run?", row_id: 1 },
      { role: "assistant", text: "At night.", row_id: 2 },
    ],
    "quill-bot": [],
  };
  server.oneshotAnswer = () => `Summary: ${SUMMARY}`;
  setup(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  const app = <Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `lena@asks-${++launches}`, url: "", username: "lena" }} onSignOut={async () => {}} />;
  render(locale ? <LocaleContext value={locale}>{app}</LocaleContext> : app);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.checkOtherProfiles()));
  const user = userEvent.setup();
  await user.click(document.querySelector<HTMLElement>('.sidebar [role=tab][data-mode="bots"]')!);
  await waitFor(() => expect(document.querySelectorAll(".sb-bots .bots-row")).toHaveLength(2));
  await user.click(document.querySelector<HTMLElement>('.sb-bots .bots-row[data-profile="default"] .bots-open')!);
  await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "hermes-bot")?.runtimeId).toBeTruthy());
  await act(async () => void (await hermes.idle()));
  return { server, hermes, user };
}

const box = () => document.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;
const submits = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit");
const card = () => document.querySelector<HTMLElement>(".msg.returned.ask");
const line = (profile: string) => card()?.querySelector<HTMLElement>(`.ask-target[data-profile="${profile}"]`);
const chip = (state: string) => screen.queryByRole("button", { name: new RegExp(`^Referenced chat Bot Chat with Hermes, ${state}`) });

/** Types a message naming quill, with the chip summarized, and sends it. */
async function ask(user: ReturnType<typeof userEvent.setup>, words = "@quill what do you think?") {
  await user.click(box());
  await user.keyboard(words);
  await waitFor(() => expect(chip("summary ready")).toBeTruthy());
  await user.keyboard("{Enter}");
}

describe("An @ in a Bot Chat, in the app", { timeout: 30_000 }, () => {
  it("brings this chat along as a chip, sends the message to quill, and shows quill's reply on an Asked card", async () => {
    const { server, hermes, user } = await inHermesBotChat();
    await ask(user);
    await waitFor(() => expect(submits(server)).toHaveLength(1));
    const [submit] = submits(server);
    expect(submit.params.profile).toBe("quill");
    expect(String(submit.params.text)).toContain(`[Referenced chat: Bot Chat with Hermes]`);
    expect(String(submit.params.text)).toContain(SUMMARY);
    expect(askStamp(String(submit.params.text))).toBeDefined();
    expect(box().value).toBe("");
    expect(chip("summary ready")).toBeNull();
    // The chat whose composer it was takes no turn.
    expect(hermes.getSnapshot().chats.find((c) => c.id === "hermes-bot")?.items.filter((i) => i.kind === "user")).toHaveLength(1);

    await waitFor(() => expect(card()?.querySelector(".returned-title")?.textContent).toBe("Asked @quill"));
    expect(card()?.querySelector(".ask-words")?.textContent).toBe("@quill what do you think?");
    const rt = server.runtimeIdOf("quill-bot")!;
    act(() => {
      server.event(rt, "message.start");
      server.event(rt, "message.delta", { text: "Friday night works." });
      server.event(rt, "message.complete", { text: "Friday night works.", status: "complete" });
    });
    await waitFor(() => expect(line("quill")?.dataset.state).toBe("answered"));
    expect(line("quill")?.querySelector(".ask-name")?.textContent).toBe("Quill");
    expect(line("quill")?.querySelector(".returned-body")?.textContent).toContain("Friday night works.");
    // The card goes after the last message the chat had when it was asked.
    const night = within(document.querySelector<HTMLElement>(".transcript-inner")!).getByText("At night.").closest(".msg")!;
    expect(night.compareDocumentPosition(card()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("sends the words of a bot picked from the menu without the pick mark, in the message and on the card", async () => {
    const { server, user } = await inHermesBotChat();
    await user.click(box());
    await user.keyboard("@qu{Tab}what do you think?");
    expect(box().value).toBe(`@${PICK_MARK}quill what do you think?`);
    await waitFor(() => expect(chip("summary ready")).toBeTruthy());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(submits(server)).toHaveLength(1));
    expect(submits(server)[0].params.profile).toBe("quill");
    expect(String(submits(server)[0].params.text)).toContain("@quill what do you think?");
    expect(String(submits(server)[0].params.text)).not.toContain(PICK_MARK);
    await waitFor(() => expect(card()?.querySelector(".ask-words")?.textContent).toBe("@quill what do you think?"));
  });

  it("sends without this chat once the owner removes its chip, and doesn't bring it back while the message names a bot", async () => {
    const { server, user } = await inHermesBotChat();
    await user.click(box());
    await user.keyboard("@quill hi");
    await waitFor(() => expect(chip("summary ready")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Remove the reference to Bot Chat with Hermes" }));
    await user.click(box());
    await user.keyboard(" there");
    expect(chip("summary ready")).toBeNull();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(submits(server)).toHaveLength(1));
    const text = String(submits(server)[0].params.text);
    expect(text).not.toContain("[Referenced chat:");
    expect(askStamp(text)).toBeDefined();
  });

  it("goes while this chat's own reply runs, without queueing or steering it", async () => {
    const { server, hermes, user } = await inHermesBotChat();
    act(() => server.event(hermes.getSnapshot().chats.find((c) => c.id === "hermes-bot")!.runtimeId!, "message.start"));
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "hermes-bot")?.running).toBe(true));
    await ask(user);
    await waitFor(() => expect(submits(server)).toHaveLength(1));
    expect(submits(server)[0].params.profile).toBe("quill");
    expect(hermes.getSnapshot().queues["hermes-bot"]?.items ?? []).toEqual([]);
    expect(server.requests.some((r) => r.method === "command.dispatch")).toBe(false);
  });

  it("is refused offline with the words kept, and nothing goes", async () => {
    const { server, hermes, user } = await inHermesBotChat();
    await user.click(box());
    await user.keyboard("@quill what do you think?");
    await waitFor(() => expect(chip("summary ready")).toBeTruthy());
    act(() => server.drop());
    await waitFor(() => expect(hermes.getSnapshot().status).not.toBe("connected"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByText(/A message to another bot goes only while Hermes is connected/)).toBeTruthy());
    expect(box().value).toBe("@quill what do you think?");
    expect(chip("summary ready")).toBeTruthy();
    expect(submits(server)).toEqual([]);
    expect(card()).toBeNull();
  });

  it("shows a refusal on the card, and Edit puts the words back in the composer", async () => {
    const { server, user } = await inHermesBotChat((s) => void (s.rejectPrompt = { code: 4010, message: "quill's Bot Chat is closed" }));
    await ask(user);
    await waitFor(() => expect(line("quill")?.dataset.state).toBe("failed"));
    expect(line("quill")?.querySelector(".send-failed-why")?.textContent).toBe("Not sent to @quill. Quill's Bot Chat is closed.");
    server.rejectPrompt = undefined;
    await user.click(within(card()!).getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(box().value).toBe("@quill what do you think?"));
    expect(card()).toBeNull();
    expect(chip("summary ready")).toBeTruthy();
  });

  it("withdraws this chat's chip after a refusal once the message names no bot, so a plain message goes without it", async () => {
    const { server, hermes, user } = await inHermesBotChat();
    await user.click(box());
    await user.keyboard("@quill what do you think?");
    await waitFor(() => expect(chip("summary ready")).toBeTruthy());
    act(() => server.drop());
    await waitFor(() => expect(hermes.getSnapshot().status).not.toBe("connected"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByText(/A message to another bot goes only while Hermes is connected/)).toBeTruthy());
    await user.clear(box());
    await user.keyboard("never mind, what do you think?");
    await waitFor(() => expect(chip("summary ready")).toBeNull());
    await act(async () => void (await hermes.reconnect()));
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "hermes-bot")?.runtimeId).toBeTruthy());
    await act(async () => void (await hermes.idle()));
    await user.click(box());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(submits(server)).toHaveLength(1));
    expect(submits(server)[0].params.profile).toBe("default");
    expect(String(submits(server)[0].params.text)).not.toContain("[Referenced chat:");
  });

  it("Edit doesn't bring back this chat's chip when the failed message went without it", async () => {
    const { server, user } = await inHermesBotChat((s) => void (s.rejectPrompt = { code: 4010, message: "quill's Bot Chat is closed" }));
    await user.click(box());
    await user.keyboard("@quill hi");
    await waitFor(() => expect(chip("summary ready")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Remove the reference to Bot Chat with Hermes" }));
    await user.click(box());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(line("quill")?.dataset.state).toBe("failed"));
    server.rejectPrompt = undefined;
    await user.click(within(card()!).getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(box().value).toBe("@quill hi"));
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(screen.queryByRole("button", { name: /^Referenced chat Bot Chat with Hermes/ })).toBeNull();
    await user.click(box());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(submits(server)).toHaveLength(2));
    expect(String(submits(server)[1].params.text)).not.toContain("[Referenced chat:");
  });

  it("says everything in the catalogue's words", async () => {
    const { server, user } = await inHermesBotChat(() => {}, pseudoLocale());
    await user.click(box());
    await user.keyboard("@quill hi");
    await waitFor(() => expect(document.querySelector(".ref-chip, [aria-label^='Referenced chat']")).toBeTruthy());
    await waitFor(() => expect(screen.queryByRole("button", { name: /summary ready/ })).toBeTruthy());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(card()).toBeTruthy());
    const rt = server.runtimeIdOf("quill-bot")!;
    act(() => server.event(rt, "message.complete", { text: "", status: "complete" }));
    await waitFor(() => expect(line("quill")?.dataset.state).toBe("answered"));
    expect(untranslated(card()!.querySelector(".returned-head")!)).toEqual([]);
    expect(Array.from(card()!.querySelectorAll(".ask-note, .ask-actions")).flatMap(untranslated)).toEqual([]);
  });
});

/** Signed in, Bots mode, the ordinary chat "Nightly backup" open, with another chat beside it. */
async function inOrdinaryChat(setup: (server: FakeHermes) => void = () => {}, locale?: Locale, title = "Nightly backup") {
  const server = new FakeHermes();
  server.sessions = [
    row("backup", 1, { pinned: true, title }),
    row("nginx", 2, { pinned: true, title: "Rotate nginx logs" }),
    row("hermes-bot", 3, { title: BOT_CHAT_TITLE, hidden: true }),
  ];
  server.otherProfiles = { quill: [row("quill-bot", 4, { title: BOT_CHAT_TITLE, hidden: true })] };
  server.transcripts = {
    backup: [
      { role: "user", text: "Why did the backup fail?", row_id: 1 },
      { role: "assistant", text: "The restic repo was locked.", row_id: 2 },
    ],
    nginx: [{ role: "user", text: "Which logs rotate?", row_id: 1 }],
    "hermes-bot": [],
    "quill-bot": [],
  };
  server.oneshotAnswer = () => `Summary: ${SUMMARY}`;
  setup(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  const app = <Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `lena@chat-asks-${++launches}`, url: "", username: "lena" }} onSignOut={async () => {}} />;
  render(locale ? <LocaleContext value={locale}>{app}</LocaleContext> : app);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.checkOtherProfiles()));
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }));
  await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "backup")?.runtimeId).toBeTruthy());
  await act(async () => void (await hermes.idle()));
  return { server, hermes, user };
}

const backupChip = (state: string) => screen.queryByRole("button", { name: new RegExp(`^Referenced chat Nightly backup, ${state}`) });
const options = () => screen.queryAllByRole("option");
const groups = () => Array.from(document.querySelectorAll(".cmd-group.at-group")).map((g) => g.textContent);
const userItems = (hermes: Hermes, id: string) => hermes.getSnapshot().chats.find((c) => c.id === id)?.items.filter((i) => i.kind === "user");

describe("A bot picked from the @ menu in an ordinary chat, in the app", { timeout: 30_000 }, () => {
  it("lists the bots above the chats", async () => {
    const { user } = await inOrdinaryChat();
    await user.click(box());
    await user.keyboard("@");
    expect(groups()).toEqual(["Bots", "Chats"]);
    expect(options().map((o) => o.querySelector(".cmd-name, .cmd-desc")?.textContent)).toEqual(["@quill", "Rotate nginx logs"]);
    expect(screen.getByRole("button", { name: "Pick a bot or reference a chat" })).toBeTruthy();
  });

  it("asks quill from here: this chat comes along as a chip, takes no turn, and shows quill's reply on an Asked card", async () => {
    const { server, hermes, user } = await inOrdinaryChat();
    await user.click(box());
    await user.keyboard("@qu{Tab}what do you think?");
    expect(box().value).toBe(`@${PICK_MARK}quill what do you think?`);
    expect(document.querySelector("[data-mention=quill]")).toBeTruthy();
    await waitFor(() => expect(backupChip("summary ready")).toBeTruthy());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(submits(server)).toHaveLength(1));
    const [submit] = submits(server);
    const text = String(submit.params.text);
    expect(submit.params.profile).toBe("quill");
    expect(text).toContain("@quill what do you think?");
    expect(text).not.toContain(PICK_MARK);
    expect(text).toContain("[Referenced chat: Nightly backup]");
    expect(text).toContain(SUMMARY);
    expect(askStamp(text)).toBeDefined();
    expect(text).toContain(`[Asked from: chat "Nightly backup" with Hermes · ${askStamp(text)}]`);
    expect(text).not.toMatch(/Asked from: Bot Chat/);
    expect(box().value).toBe("");
    expect(backupChip("summary ready")).toBeNull();
    expect(userItems(hermes, "backup")).toHaveLength(1);

    await waitFor(() => expect(card()?.querySelector(".returned-title")?.textContent).toBe("Asked @quill"));
    expect(card()?.querySelector(".ask-words")?.textContent).toBe("@quill what do you think?");
    const rt = server.runtimeIdOf("quill-bot")!;
    act(() => {
      server.event(rt, "message.start");
      server.event(rt, "message.complete", { text: "Friday night works.", status: "complete" });
    });
    await waitFor(() => expect(line("quill")?.dataset.state).toBe("answered"));
    expect(line("quill")?.querySelector(".returned-body")?.textContent).toContain("Friday night works.");
    const locked = within(document.querySelector<HTMLElement>(".transcript-inner")!).getByText("The restic repo was locked.").closest(".msg")!;
    expect(locked.compareDocumentPosition(card()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the card in the chat it was asked from and in no other", async () => {
    const { server, user } = await inOrdinaryChat();
    await user.click(box());
    await user.keyboard("@qu{Tab}hi");
    await waitFor(() => expect(backupChip("summary ready")).toBeTruthy());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(card()).toBeTruthy());
    await user.click(screen.getByRole("button", { name: /Rotate nginx logs/ }));
    await waitFor(() => expect(document.querySelector(".chat-title span")?.textContent).toBe("Rotate nginx logs"));
    expect(card()).toBeNull();
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    await waitFor(() => expect(card()).toBeTruthy());
    expect(submits(server)).toHaveLength(1);
  });

  it("names the chat by a title that holds a separator, and the ask is still read back by its id", async () => {
    const title = "Plan · abcdefghij]";
    const { server, user } = await inOrdinaryChat(() => {}, undefined, title);
    await user.click(box());
    await user.keyboard("@qu{Tab}hi");
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Referenced chat Plan/ })).toBeTruthy());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(submits(server)).toHaveLength(1));
    const text = String(submits(server)[0].params.text);
    expect(askStamp(text)).toBeDefined();
    expect(text).toContain(`[Asked from: chat "${title}" with Hermes · ${askStamp(text)}]`);
  });

  it("leaves a typed @quill as plain words that go to this chat's own bot, with no chip and no Ask", async () => {
    const { server, hermes, user } = await inOrdinaryChat();
    await user.click(box());
    await user.keyboard("What did @quill say about the budget?");
    expect(document.querySelector("[data-mention]")).toBeNull();
    expect(backupChip(".*")).toBeNull();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(submits(server)).toHaveLength(1));
    expect(submits(server)[0].params.profile).toBe("default");
    expect(String(submits(server)[0].params.text)).toBe("What did @quill say about the budget?");
    expect(card()).toBeNull();
    expect(userItems(hermes, "backup")).toHaveLength(2);
  });

  it("brings no chip while the chat has no history to summarize", async () => {
    const { server, user } = await inOrdinaryChat((s) => (s.transcripts.nginx = []));
    await user.click(screen.getByRole("button", { name: /Rotate nginx logs/ }));
    await user.click(box());
    await user.keyboard("@qu{Tab}hi{Enter}");
    await waitFor(() => expect(submits(server)).toHaveLength(1));
    expect(submits(server)[0].params.profile).toBe("quill");
    expect(String(submits(server)[0].params.text)).not.toContain("[Referenced chat:");
  });

  it("refuses a message that runs a skill, as a Bot Chat does, and sends nothing", async () => {
    const { server, user } = await inOrdinaryChat((s) => s.skills.add("default", { dir: "/home/lena/.hermes/skills/debugging", source: "agent" }, "---\nname: debugging\ndescription: Find the cause\n---\n\nSteps.\n"));
    await user.click(box());
    await user.keyboard("@qu{Tab}fix it using $deb{Enter}");
    await waitFor(() => expect(box().value).toBe(`@${PICK_MARK}quill fix it using $debugging `));
    await waitFor(() => expect(backupChip("summary ready")).toBeTruthy());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByText(/A message that runs a skill can't go to another bot/)).toBeTruthy());
    expect(submits(server)).toEqual([]);
    expect(server.requests.some((r) => r.method === "command.dispatch")).toBe(false);
  });

  it("sends a draft with a picked bot as plain words, the mark gone, when there is no Bots mode", async () => {
    const { server, user } = await inOrdinaryChat((s) => (s.botMode = "none"));
    await user.click(box());
    await user.paste(`ask @${PICK_MARK}quill about it`);
    expect(document.querySelector("[data-mention]")).toBeNull();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(submits(server)).toHaveLength(1));
    expect(submits(server)[0].params.profile).toBe("default");
    expect(String(submits(server)[0].params.text)).toBe("ask @quill about it");
    expect(card()).toBeNull();
  });

  it("lists no bots in the menu without Bots mode, and offers only to reference a chat", async () => {
    const { user } = await inOrdinaryChat((s) => (s.botMode = "none"));
    await user.click(box());
    await user.keyboard("@");
    expect(groups()).toEqual([]);
    expect(screen.getByRole("button", { name: "Reference a chat" })).toBeTruthy();
    expect(options().map((o) => o.textContent)).toEqual(["Rotate nginx logs"]);
  });

  it("keeps the pick through Undo, so a pill that was taken out comes back and still asks", async () => {
    const { server, user } = await inOrdinaryChat();
    await user.click(box());
    await user.keyboard("@qu{Tab}hi");
    await user.keyboard("{Control>}z{/Control}");
    await user.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    await waitFor(() => expect(box().value).toBe(`@${PICK_MARK}quill hi`));
    await waitFor(() => expect(backupChip("summary ready")).toBeTruthy());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(submits(server)).toHaveLength(1));
    expect(submits(server)[0].params.profile).toBe("quill");
  });

  it("puts the words back as picked on Edit, so the message asks quill again", async () => {
    const { server, user } = await inOrdinaryChat((s) => void (s.rejectPrompt = { code: 4010, message: "quill's Bot Chat is closed" }));
    await user.click(box());
    await user.keyboard("@qu{Tab}what do you think?");
    await waitFor(() => expect(backupChip("summary ready")).toBeTruthy());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(line("quill")?.dataset.state).toBe("failed"));
    server.rejectPrompt = undefined;
    await user.click(within(card()!).getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(box().value).toBe(`@${PICK_MARK}quill what do you think?`));
    await waitFor(() => expect(backupChip("summary ready")).toBeTruthy());
    await user.click(box());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(submits(server)).toHaveLength(2));
    expect(submits(server)[1].params.profile).toBe("quill");
  });

  it("says everything in the catalogue's words", async () => {
    const { server, user } = await inOrdinaryChat(() => {}, pseudoLocale());
    await user.click(box());
    await user.keyboard("@");
    expect(Array.from(document.querySelectorAll(".cmd-group")).flatMap(untranslated)).toEqual([]);
    await user.keyboard("qu{Tab}hi");
    await waitFor(() => expect(screen.queryByRole("button", { name: /summary ready/ })).toBeTruthy());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(card()).toBeTruthy());
    const rt = server.runtimeIdOf("quill-bot")!;
    act(() => server.event(rt, "message.complete", { text: "", status: "complete" }));
    await waitFor(() => expect(line("quill")?.dataset.state).toBe("answered"));
    expect(untranslated(card()!.querySelector(".returned-head")!)).toEqual([]);
  });
});

describe("An ordinary chat in Compare, in the app", { timeout: 30_000 }, () => {
  const pane = (i: number) => document.querySelectorAll<HTMLElement>(".pane")[i];
  const composerIn = (i: number) => within(pane(i)).getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
  const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));

  async function compare(user: ReturnType<typeof userEvent.setup>, hermes: Hermes) {
    await act(() => hermes.loadModels());
    await settle(hermes);
    await user.click(screen.getByRole("button", { name: /^Model:/ }));
    await user.click(screen.getByRole("button", { name: "Compare with another model" }));
    await user.click(within(screen.getByRole("dialog", { name: "Pick a model to compare with" })).getByRole("button", { name: /^gpt-5/ }));
    await settle(hermes);
    expect(document.querySelectorAll(".pane")).toHaveLength(2);
  }

  it("lists no bots in the menu", async () => {
    const { hermes, user } = await inOrdinaryChat();
    await compare(user, hermes);
    await user.click(composerIn(0));
    await user.keyboard("@");
    expect(groups()).toEqual([]);
    expect(options().map((o) => o.textContent)).toEqual(["Rotate nginx logs"]);
  });

  it("sends a picked bot's words to both chats as plain words, with the mark gone and no ask", async () => {
    const { server, hermes, user } = await inOrdinaryChat();
    await user.click(box());
    await user.keyboard("@qu{Tab}what do you think?");
    await waitFor(() => expect(backupChip("summary ready")).toBeTruthy());
    await compare(user, hermes);
    expect(composerIn(0).value).toBe(`@${PICK_MARK}quill what do you think?`);
    expect(document.querySelector("[data-mention]")).toBeNull();
    await user.click(composerIn(0));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(submits(server)).toHaveLength(2));
    expect(submits(server).map((r) => [r.params.profile, r.params.text])).toEqual([
      ["default", "@quill what do you think?"],
      ["default", "@quill what do you think?"],
    ]);
    expect(new Set(submits(server).map((r) => r.params.session_id)).size).toBe(2);
    expect(card()).toBeNull();
  });
});

