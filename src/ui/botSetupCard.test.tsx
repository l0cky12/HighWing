// @vitest-environment jsdom
// Bot setup's card in the app (ADR 0231): drawn in place of the bot's setup block in a Bot Chat only, earlier drafts
// folded, an unreadable block with its redraw button, names Hermes doesn't list, the model row on a new bot's card,
// in-place edits by keyboard, Set it up with Try again and Apply anyway, and the Setup started line.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BOT_SETUP_FENCE, botSetupBrief, type BotSetupNewBlock } from "../hermes/botSetupBrief";
import { botSetupBegin } from "../hermes/botSetupStart";
import { BOT_CHAT_TITLE } from "../hermes/bots";
import { FakeHermes, row, type TranscriptMessage } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { en } from "../i18n/en";
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

const ID = "c0ffee00-0000-4000-8000-000000000001";
const BLOCK: BotSetupNewBlock = {
  v: 1,
  persona: "You are Hermes, a careful trip planner. Never book or pay for anything.",
  description: "Plans trips.",
  model: null,
  color: "teal",
  callOwner: "Lena",
  skills: [
    { name: "recipes", on: true },
    { name: "flight-tracker", on: true },
  ],
  toolsets: [{ name: "computer_use", on: true }],
  mcp: [],
  copy: [],
};
const fenced = (body: string) => `\`\`\`${BOT_SETUP_FENCE}\n${body}\n\`\`\``;
const card = (block: BotSetupNewBlock = BLOCK) => `Here's how I'd set myself up.\n\n${fenced(JSON.stringify(block))}`;

/** A Bot Chat that holds a setup: the hidden brief and begin turn, the interview, then the bot's replies `replies`. */
const interview = (...replies: string[]): TranscriptMessage[] => [
  { role: "user", text: botSetupBrief({ id: ID, name: "Hermes", inventory: { models: [], skills: [], toolsets: [], bots: [] } }), display_kind: "hidden" },
  { role: "user", text: botSetupBegin(ID), display_kind: "hidden" },
  { role: "assistant", text: "Hi, I'm Hermes. What should I call you?" },
  { role: "user", text: "Lena" },
  ...replies.flatMap((text, i): TranscriptMessage[] => [{ role: "assistant", text }, ...(i < replies.length - 1 ? [{ role: "user" as const, text: "Change it." }] : [])]),
];

let launches = 0;

/** Signed in to Hermes 0.23.2, Bots mode, Hermes's Bot Chat open with `rows`. */
async function inBotChat(rows: TranscriptMessage[], setup: (server: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.health = { ...server.health, version: "0.23.2", displayVersion: "0.23.2" };
  server.status = { ...server.status, version: "0.23.2" };
  server.sessions = [row("hermes-bot", 1, { title: BOT_CHAT_TITLE, hidden: true }), row("side", 0, { title: "Notes" })];
  server.transcripts = { "hermes-bot": rows, side: [{ role: "user", text: "Show me the block." }, { role: "assistant", text: card() }] };
  server.souls.default = "You are Hermes.";
  server.profileModel.default = { model: "claude-sonnet-4-5", provider: "anthropic", reasoning_effort: "high", fast: false };
  server.profileMeta.default = { description: "Helps with anything.", ui_meta: { "hermes-bots": { title: "Hermes" } } };
  server.uiMetaRevisions.default = { "hermes-bots": 1 };
  for (const name of ["notes", "recipes"])
    server.skills.add("default", { dir: `/home/lena/.hermes/skills/${name}`, source: "bundled" }, `---\nname: ${name}\ndescription: The ${name} skill\n---\nDo ${name}.\n`);
  server.skills.disabled.default = new Set(["recipes"]);
  setup(server);
  // Stored rows have ids, which the card's read of the rows goes by.
  for (const rows of Object.values(server.transcripts)) rows.forEach((m, i) => (m.row_id ??= i + 1));
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `lena@setup-${++launches}`, url: "", username: "lena" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  const user = userEvent.setup();
  await user.click(document.querySelector<HTMLElement>('.sidebar [role=tab][data-mode="bots"]')!);
  await waitFor(() => expect(document.querySelector(".sb-bots .bots-row")).toBeTruthy());
  await user.click(document.querySelector<HTMLElement>('.sb-bots .bots-row[data-profile="default"] .bots-open')!);
  await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "hermes-bot")?.runtimeId).toBeTruthy());
  await act(async () => void (await hermes.idle()));
  return { server, hermes, user };
}

const t = en.chat.botSetup;
const liveCard = () => document.querySelector<HTMLElement>(".msg.returned.bot-setup[data-card]");
const waitCard = () => waitFor(() => expect(liveCard()).toBeTruthy(), { timeout: 5000 });
const group = (name: string) => within(liveCard()!).getByRole("region", { name });
const box = (name: string | RegExp) => within(liveCard()!).getByRole("checkbox", { name });

describe("Bot setup's card, in a Bot Chat", { timeout: 30_000 }, () => {
  it("is drawn in place of the block, grouped, with names Hermes doesn't list unticked and the model greyed as in use", async () => {
    await inBotChat(interview(card()));
    await waitCard();
    expect(document.querySelector(`.msg.assistant .code`)).toBeNull();
    expect(within(liveCard()!).getByText(t.title("Hermes"))).toBeTruthy();
    expect(within(group(t.about("Hermes"))).getByText(t.ticked(4, 4))).toBeTruthy();
    expect(within(group(t.skills)).getByText(t.ticked(1, 1))).toBeTruthy();

    const missing = box("flight-tracker") as HTMLInputElement;
    expect([missing.checked, missing.disabled]).toEqual([false, true]);
    expect(within(group(t.skills)).getByText(t.notFound)).toBeTruthy();
    const model = box(t.model) as HTMLInputElement;
    expect([model.checked, model.disabled]).toEqual([false, true]);
    expect(within(group(t.about("Hermes"))).getByText(t.inUse)).toBeTruthy();
    expect(within(liveCard()!).getByText(t.changes(6))).toBeTruthy();
  });

  it("stays a plain code block in a chat that isn't a Bot Chat", async () => {
    const { user } = await inBotChat(interview(card()));
    await user.click(document.querySelector<HTMLElement>('.sidebar [role=tab][data-mode="chats"]')!);
    // A chat whose last message is a reply the owner has read is settled, under Archived (ADR 0202).
    await user.click(screen.getByRole("button", { name: /^Archived/ }));
    await user.click(await screen.findByText("Notes"));
    await waitFor(() => expect(document.querySelector(".code")?.textContent).toContain(BOT_SETUP_FENCE));
    expect(liveCard()).toBeNull();
  });

  it("folds an earlier draft away and draws the newest block as the live card", async () => {
    await inBotChat(interview(card({ ...BLOCK, description: "An older draft." }), card()));
    await waitCard();
    const drafts = document.querySelectorAll(".bot-setup-draft");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].textContent).toContain(t.draft);
    expect(drafts[0].compareDocumentPosition(liveCard()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(liveCard()!).getByText(/Plans trips\./)).toBeTruthy();
  });

  it("says a block that doesn't parse couldn't be read, and its button asks the bot to draw it again", async () => {
    const { server, user } = await inBotChat(interview(`Here you go.\n\n${fenced('{"v":1,"persona":')}`));
    const unreadable = await screen.findByText(t.unreadable);
    const shown = unreadable.closest<HTMLElement>(".msg.returned")!;
    expect(within(shown).getByText(t.unreadableWhy("Hermes"))).toBeTruthy();
    await user.click(within(shown).getByRole("button", { name: t.redraw("Hermes") }));
    // Sent as the owner's own message, with the note a Bot Chat's messages carry.
    await waitFor(() => expect(server.requests.filter((r) => r.method === "prompt.submit").map((r) => String(r.params.text).split("\n")[0])).toEqual([t.redrawAsk]));
  });

  it("works by keyboard: Space unticks an item, and an edit is made and kept with Enter or dropped with Escape", async () => {
    const { user } = await inBotChat(interview(card()));
    await waitCard();
    const persona = box(t.persona);
    persona.focus();
    await user.keyboard(" ");
    expect((persona as HTMLInputElement).checked).toBe(false);
    expect(within(liveCard()!).getByText(t.changes(5))).toBeTruthy();

    within(liveCard()!).getByRole("button", { name: t.edit(t.description) }).focus();
    await user.keyboard("{Enter}");
    const field = within(liveCard()!).getByRole("textbox", { name: t.description });
    expect(document.activeElement).toBe(field);
    await user.keyboard("{Control>}a{/Control}Books nothing.{Enter}");
    await waitFor(() => expect(within(liveCard()!).getByText(/Books nothing\./)).toBeTruthy());
    expect(within(liveCard()!).getByText(new RegExp(t.edited))).toBeTruthy();
    const editDescription = () => within(liveCard()!).getByRole("button", { name: t.edit(t.description) });
    expect(document.activeElement).toBe(editDescription());

    await user.keyboard("{Enter}{Control>}a{/Control}Never mind{Escape}");
    expect(within(liveCard()!).queryByRole("textbox", { name: t.description })).toBeNull();
    expect(within(liveCard()!).getByText(/Books nothing\./)).toBeTruthy();
    expect(document.activeElement).toBe(editDescription());
  });

  it("sets up what's ticked, then shows a failure with Try again and a toolset caution with Apply anyway", async () => {
    const { server, user } = await inBotChat(interview(card()), (s) => (s.skills.toggleRefusal = { status: 400, detail: "Skill changes are locked on this server." }));
    await waitCard();
    await user.click(within(liveCard()!).getByRole("button", { name: t.setUp }));
    await waitFor(() => expect(within(liveCard()!).getByRole("button", { name: t.applyAnyway })).toBeTruthy());
    expect(server.souls.default).toBe(BLOCK.persona);
    const skills = group(t.skills);
    expect(within(skills).getByText(/Skill changes are locked on this server\./)).toBeTruthy();
    expect(within(skills).getByRole("button", { name: t.tryAgain })).toBeTruthy();

    server.skills.toggleRefusal = undefined;
    await user.click(within(skills).getByRole("button", { name: t.tryAgain }));
    await waitFor(() => expect(within(group(t.skills)).getByText(t.applied)).toBeTruthy());
    await user.click(within(liveCard()!).getByRole("button", { name: t.applyAnyway }));
    await waitFor(() => expect(server.enabledToolsets("default").has("computer_use")).toBe(true));
  });
});

describe("Bot setup's card after Set it up", { timeout: 30_000 }, () => {
  it("offers no Try again on an item changed elsewhere since, until the owner ticks it", async () => {
    const { server, user } = await inBotChat(interview(card()));
    await waitCard();
    // The description's write gets no answer, and meanwhile the dashboard changes it.
    server.restTap = (r) => {
      if (r.method !== "PUT" || !r.path.endsWith("/description")) return;
      server.restTap = undefined;
      server.profileMeta.default = { ...server.profileMeta.default, description: "Edited in the dashboard." };
      throw new Error("The connection dropped.");
    };
    await user.click(within(liveCard()!).getByRole("button", { name: t.setUp }));
    const row = () => within(group(t.about("Hermes"))).getByRole("checkbox", { name: t.description }).closest<HTMLElement>(".bot-setup-item")!;
    await waitFor(() => expect(within(row()).getByText(t.elsewhere)).toBeTruthy(), { timeout: 5000 });
    expect(within(row()).queryByRole("button", { name: t.tryAgain })).toBeNull();
    expect((box(t.description) as HTMLInputElement).checked).toBe(false);
    expect(server.profileMeta.default?.description).toBe("Edited in the dashboard.");
  });
});

describe("The Setup started line", { timeout: 30_000 }, () => {
  it("says the setup didn't start when the bot never replied, with Hermes's words and Try again, which sends the begin turn again", async () => {
    const rows = interview().slice(0, 2);
    const { server, user } = await inBotChat(rows);
    const line = await screen.findByText(t.notStarted, undefined, { timeout: 5000 });
    const shown = line.closest<HTMLElement>(".bot-setup-line")!;
    expect(shown.textContent).toContain(t.noReply);
    expect(server.requests.filter((r) => r.method === "prompt.submit")).toEqual([]);
    await user.click(within(shown).getByRole("button", { name: t.tryAgain }));
    await waitFor(() => expect(server.requests.filter((r) => r.method === "prompt.submit").map((r) => r.params.text)).toEqual([botSetupBegin(ID)]));
  });

  it("is a centred divider once the bot replied", async () => {
    await inBotChat(interview(card()));
    await waitCard();
    expect(await screen.findByText(t.started)).toBeTruthy();
  });

  it("isn't shown in a Bot Chat that holds no setup, where a setup block stays plain code", async () => {
    const { hermes } = await inBotChat([{ role: "user", text: "Hi." }, { role: "assistant", text: `Hello.\n\n${fenced("{}")}` }]);
    await waitFor(() => expect(document.querySelector(".code")?.textContent).toContain(BOT_SETUP_FENCE));
    await act(async () => void (await hermes.idle()));
    expect(screen.queryByText(t.started)).toBeNull();
    expect(liveCard()).toBeNull();
  });
});
