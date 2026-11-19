// @vitest-environment jsdom
// The owner's "@" in a Bot Chat, in the app (ADR 0233): the chip for this chat, the send to the named bot, the
// composer's refusals, and the Asked card with the reply.
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
