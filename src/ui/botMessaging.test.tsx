// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BOT_CHAT_TITLE } from "../hermes/bots";
import { CHECK_DELAY_MS } from "../hermes/capabilities";
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
});
const running: Hermes[] = [];
const servers: FakeHermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
  for (const server of servers.splice(0)) expect(server.uncheckedConfigures()).toEqual([]);
});

const ASK = "What is the **backup window**?";
const REPLIES = { recipient: "The window is 02:00 to 03:00.", sender: "Quill says 02:00 to 03:00." };
let launches = 0;

async function launch(setup: (server: FakeHermes) => void = () => {}, locale?: Locale) {
  const server = new FakeHermes();
  server.health = { ...server.health, version: "0.23.2", displayVersion: "0.23.2" };
  server.sessions = [row("hermes-bot", 1, { title: BOT_CHAT_TITLE, hidden: true })];
  server.otherProfiles = { quill: [row("quill-bot", 2, { title: BOT_CHAT_TITLE, hidden: true })] };
  server.transcripts = { "hermes-bot": [{ role: "user", text: "Ask Quill what the backup window is." }], "quill-bot": [] };
  setup(server);
  servers.push(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  const app = <Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `lena@messaging-${++launches}`, url: "", username: "lena" }} onSignOut={async () => {}} />;
  render(locale ? <LocaleContext value={locale}>{app}</LocaleContext> : app);
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
const botRow = (profile: string) => document.querySelector<HTMLElement>(`.sb-bots .bots-row[data-profile="${profile}"] .bots-open`)!;
const cards = () => Array.from(document.querySelectorAll<HTMLElement>(".msg.returned"));
const said = (card: HTMLElement) => Array.from(card.querySelectorAll(".returned-head, .returned-why, .returned-body, .delivery")).flatMap(untranslated);
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

  it("is off, with why, on a Hermes older than 0.21.6", async () => {
    const { server, user } = await launch((s) => (s.health = { ...s.health, version: "0.21.5", displayVersion: "0.21.5" }));
    await waitFor(() => expect(toggle().disabled).toBe(true), { timeout: CHECK_DELAY_MS * 2 });
    expect(tip()).toBe("This Hermes is older than 0.21.6, the oldest known to let bots message each other.");
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

async function delivered(locale?: Locale) {
  const launched = await launch(undefined, locale);
  const { server, hermes, user } = launched;
  await user.click(toggle());
  await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
  await user.click(botRow("default"));
  await waitFor(() => expect(server.runtimeIdOf("hermes-bot")).toBeTruthy());
  await act(async () => void (await server.messageAgent("default", "quill", ASK, REPLIES)));
  await act(async () => void (await hermes.idle()));
  await waitFor(() => expect(cards()).toHaveLength(2));
  return launched;
}

describe("A message between two bots, in their Bot Chats", () => {
  it("shows the sender what it sent and the answer, and the recipient who it is from, none of it as the owner's", { timeout: 30_000 }, async () => {
    const { hermes, user } = await delivered();
    const [sent, answer] = cards();
    expect(sent.querySelector(".returned-title")?.textContent).toBe("Messaged @quill");
    expect(sent.querySelector(".returned-body strong")?.textContent).toBe("backup window");
    expect(sent.closest(".tools")).toBeNull();
    expect(document.querySelector(".tools")).toBeNull();
    expect(Array.from(sent.querySelectorAll(".delivery li")).map((li) => li.textContent)).toEqual(["Queued for @quill. @quill was idle when it was sent.", "Answered. Go to the answer"]);
    await user.click(within(sent).getByRole("button", { name: "Go to the answer" }));
    expect(document.activeElement).toBe(answer);
    expect(answer.querySelector(".returned-title")?.textContent).toBe("@quill answered.");
    expect(answer.querySelector(".returned-body")?.textContent).toContain(REPLIES.recipient);
    expect(answer.matches(".process")).toBe(false);
    expect(document.body.textContent).not.toContain("bot_mode_dm.py");
    expect(Array.from(document.querySelectorAll(".msg.user")).map((m) => m.textContent)).toEqual([expect.stringContaining("Ask Quill what the backup window is.")]);
    const head = within(sent).getByRole("button", { name: /Messaged @quill/ });
    await user.click(head);
    expect(sent.querySelector(".returned-body")).toBeNull();

    await user.click(botRow("quill"));
    await waitFor(() => expect(hermes.profile).toBe("quill"));
    await waitFor(() => expect(cards()).toHaveLength(1));
    const [from] = cards();
    expect(from.querySelector(".returned-title")?.textContent).toBe("Message from hermes (@hermes)");
    expect(from.querySelector(".returned-body strong")?.textContent).toBe("backup window");
    expect(document.querySelectorAll(".msg.user")).toHaveLength(0);
    expect(document.body.textContent).not.toContain("Message from 🤖");
  });

  it("says only catalogue words in the switch and in each card", { timeout: 30_000 }, async () => {
    const p = pseudoLocale();
    const { hermes, user } = await delivered(p);
    const head = document.querySelector<HTMLElement>(".sb-bots .bots-head")!;
    expect(untranslated(head)).toEqual([]);
    expect(tip()).toBe(p.bots.messaging.tipOn);
    expect(toast()).toBe(p.bots.messaging.turnedOn);
    const [sent, answer] = cards();
    expect(sent.querySelector(".returned-title")?.textContent).toBe(p.chat.agent.sent("@quill"));
    expect(cards().flatMap(said)).toEqual([]);
    expect(answer.querySelector(".returned-head")?.getAttribute("title")).toBe(p.chat.returned.hide);

    await user.click(botRow("quill"));
    await waitFor(() => expect(hermes.profile).toBe("quill"));
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0].querySelector(".returned-title")?.textContent).toBe(p.chat.agent.from("hermes", "hermes"));
    expect(cards().flatMap(said)).toEqual([]);
  });
});

describe("A Messaged card's Open chip", () => {
  const chats = () => document.querySelector<HTMLElement>('.sidebar [role=tab][data-mode="chats"]')!;
  const chips = (card: HTMLElement) => Array.from(card.querySelectorAll<HTMLElement>(".sent-open button")).map((b) => b.textContent?.trim());
  /** Hermes's own bot asked a peer's bot and a bot on this connection, as its history stores the calls. */
  const asked = (target: string) => (s: FakeHermes) => {
    s.transcripts["hermes-bot"] = [
      { role: "assistant", text: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "message_agent", arguments: JSON.stringify({ target, message: ASK }) } }] },
      { role: "tool", tool_call_id: "call_1", name: "message_agent", args: { target, message: ASK }, result: JSON.stringify({ status: "queued", delivery_id: "d-1", to: `@${target}` }) },
    ];
  };

  it("opens the bot it names as a visit, which Chats ends", { timeout: 30_000 }, async () => {
    const { hermes, user } = await delivered();
    const [sent, answer] = cards();
    expect(chips(sent)).toEqual(["Open @quill"]);
    expect(chips(answer)).toEqual([]);
    expect(within(sent).getByRole("button", { name: "Open @quill" }).title).toBe("Open @quill's Bot Chat");
    await user.click(within(sent).getByRole("button", { name: "Open @quill" }));
    await waitFor(() => expect(hermes.profile).toBe("quill"));
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0].querySelector(".returned-title")?.textContent).toBe("Message from hermes (@hermes)");
    await user.click(chats());
    await waitFor(() => expect(hermes.profile).toBe("default"));
  });

  it("is the handle as text for a peer's bot, with no chip", { timeout: 30_000 }, async () => {
    const { user } = await launch(asked("lab/quill"));
    await user.click(botRow("default"));
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0].querySelector(".returned-title")?.textContent).toBe("Messaged @lab/quill");
    expect(chips(cards()[0])).toEqual([]);
  });

  it("says its words from the catalogue", { timeout: 30_000 }, async () => {
    const p = pseudoLocale();
    await delivered(p);
    const chip = cards()[0].querySelector<HTMLElement>(".sent-open button")!;
    expect(chip.textContent?.trim()).toBe(p.chat.agent.open("@quill"));
    expect(chip.title).toBe(p.chat.agent.openTip("@quill"));
    expect(cards().flatMap(said)).toEqual([]);
  });
});
