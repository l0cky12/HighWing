import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { BOT_SETUP_FENCE, botSetupMarkerId, type BotSetupAgainBlock } from "../../src/hermes/botSetupBrief";
import { BOT_CHAT_TITLE } from "../../src/hermes/bots";
import { row, type FakeHermes } from "../../src/hermes/fakeHermes";
import { APPEARANCE_KEY } from "../../src/ui/appearance";
import { boot, shot } from "../harness";

const BOT = "travel-buddy";
const OLD = "travel-chat";
const PERSONA =
  "You are Travel Buddy, a practical travel planner. You help plan trips from start to finish: flights and trains, places to stay and a day-by-day plan. Compare the options side by side with price and travel time.\n\nNever book, buy or pay for anything. Check first before you email anyone.";

const BLOCK: BotSetupAgainBlock = {
  v: 1,
  persona: `${PERSONA} Prefer trains to flights for any trip under six hours.`,
  description: "Plans trips, by train where it can.",
  model: null,
  color: null,
  callOwner: null,
  skills: [{ name: "rail-europe", on: true }],
  toolsets: [{ name: "terminal", on: false }],
  mcp: [],
  copy: [],
};

const seed = (s: FakeHermes) => {
  s.health = { ...s.health, version: "0.23.2", displayVersion: "0.23.2" };
  s.status = { ...s.status, version: "0.23.2" };
  s.learningRoutes = true;
  s.sessions = [row("hermes-bot", 2, { title: BOT_CHAT_TITLE, hidden: true }), row("disk", 3, { title: "Disk usage" })];
  s.otherProfiles = { [BOT]: [row(OLD, 0.5, { title: BOT_CHAT_TITLE, hidden: true }), row("trip", 1, { title: "Rome in May" })] };
  s.transcripts = {
    "hermes-bot": [{ role: "assistant", text: "The backup finished at 03:10. Two files were skipped.", row_id: 1 }],
    [OLD]: [
      { role: "user", text: "Rome to Florence on Friday morning?", row_id: 1 },
      { role: "assistant", text: "The 09:10 Frecciarossa is quickest at 1 h 32 min, €39.", row_id: 2 },
    ],
  };
  s.profileMeta = {
    default: { description: "Helps with anything.", ui_meta: { "hermes-bots": { title: "Hermes" } } },
    [BOT]: { description: "Plans trips: flights, trains and places to stay.", ui_meta: { "hermes-bots": { title: "Travel Buddy", color: "#14b8a6" } } },
  };
  s.uiMetaRevisions = { default: { "hermes-bots": 1 }, [BOT]: { "hermes-bots": 1 } };
  s.souls[BOT] = PERSONA;
  s.profileModel[BOT] = { model: "claude-sonnet-4-5", provider: "anthropic", reasoning_effort: "medium", fast: false };
  s.skills.profiles.add(BOT);
  for (const name of ["find-nearby", "deep-research", "rail-europe"])
    s.skills.add(BOT, { dir: `/home/owner/.hermes/profiles/${BOT}/skills/${name}`, source: "bundled" }, `---\nname: ${name}\ndescription: The ${name} skill\n---\nDo ${name}.\n`);
  s.skills.disabled[BOT] = new Set(["rail-europe"]);
  s.memory[BOT] = {
    memory: ["Rome trip is in May.", "The owner's home station is Milano Centrale."],
    profile: ["The owner wants to be called Lena.", "Prefers a window seat."],
  };
};

const store = (server: FakeHermes) => server.otherProfiles[BOT];
const prompts = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit");

function reply(server: FakeHermes, session: string, chatId: string, text: string) {
  server.event(session, "message.start");
  server.event(session, "message.delta", { text });
  server.storeMessage(chatId, { role: "assistant", text });
  server.event(session, "message.complete", { text, status: "complete" });
}

async function botMode(scheme: "dark" | "light") {
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ scheme }));
  const { app, server } = await boot({ seed });
  const panel = app.getByRole("complementary");
  await panel.getByRole("tab", { name: /^Bots/ }).click();
  const rowOf = (name: string) => panel.getByRole("button", { name: new RegExp(`^${name}\\b`) }).first();
  await expect.element(rowOf("Travel Buddy")).toBeVisible();
  const ask = async (name: string) => {
    await rowOf(name).click({ button: "right" });
    await app.getByRole("menuitem", { name: "Set up again…" }).click();
    return app.getByRole("dialog", { name: `Set up ${name} again?` });
  };
  return { app, server, rowOf, ask };
}

async function keepHistory(scheme: "dark" | "light") {
  const { app, server, rowOf } = await botMode(scheme);
  await rowOf("Travel Buddy").click({ button: "right" });
  const menu = app.getByRole("menu", { name: "More for Travel Buddy" });
  await expect.element(menu.getByRole("menuitem", { name: "Set up again…" })).toBeVisible();
  await Promise.all(menu.element().getAnimations().map((a) => a.finished));
  await shot(`${scheme}-menu`);
  await menu.getByRole("menuitem", { name: "Set up again…" }).click();

  const dialog = app.getByRole("dialog", { name: "Set up Travel Buddy again?" });
  await expect.element(dialog.getByRole("radio", { name: /^Keep history/ })).toBeChecked();
  await expect.element(dialog.getByText(/Deletes Travel Buddy's 4 memory entries\./)).toBeVisible();
  await shot(`${scheme}-keep-history`);

  await dialog.getByRole("radio", { name: /^Start fresh/ }).click();
  await expect.element(dialog.getByText("The 4 memory entries can't be brought back. Travel Buddy's other chats stay as they are.")).toBeVisible();
  await expect.element(dialog.getByRole("button", { name: "Start fresh" })).toHaveClass(/danger/);
  await shot(`${scheme}-start-fresh`);

  await dialog.getByRole("radio", { name: /^Keep history/ }).click();
  const wrote = server.restRequests.length;
  await dialog.getByRole("button", { name: "Set up again" }).click();
  await expect.poll(() => prompts(server), { message: "the one hidden brief turn" }).toHaveLength(1);
  const [brief] = prompts(server);
  expect(brief.params, "sent hidden, into the bot's profile").toMatchObject({ profile: BOT, display_kind: "hidden" });
  expect(botSetupMarkerId(String(brief.params.text)), "under a new setup id").toBeTruthy();
  expect(server.requests.filter((r) => r.method === "session.create"), "nothing seeded").toEqual([]);
  expect(server.restRequests.slice(wrote).filter((r) => r.method !== "GET" && r.body?.unread === undefined).map((r) => `${r.method} ${r.path}`), "nothing written before Set it up").toEqual([]);
  expect(Object.values(server.memory[BOT]).flat(), "the memory stays").toHaveLength(4);

  const chat = app.getByRole("main");
  const session = String(brief.params.session_id);
  reply(server, session, OLD, "Here's how I'm set up now: a travel planner on claude-sonnet-4-5, with find-nearby and deep-research. What would you like to change?");
  await expect.element(chat.getByText(/What would you like to change\?/)).toBeVisible();
  await expect.element(chat.getByText("Setup started")).toBeVisible();
  await expect.element(chat.getByText("The 09:10 Frecciarossa is quickest at 1 h 32 min, €39.")).toBeVisible();
  expect(app.getByText(/highwing:bot-setup/).elements(), "no hidden row is drawn").toEqual([]);

  await app.getByPlaceholder("Message Travel Buddy").fill("Prefer trains for short trips, add the rail-europe skill, and I don't need the terminal.");
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => prompts(server)).toHaveLength(2);
  reply(server, String(prompts(server)[1].params.session_id), OLD, `Here's the change. Everything else stays as it is.\n\n\`\`\`${BOT_SETUP_FENCE}\n${JSON.stringify(BLOCK)}\n\`\`\``);

  const about = app.getByRole("region", { name: "About Travel Buddy" });
  await expect.element(about).toBeVisible();
  await expect.element(app.getByText("Set up Travel Buddy again", { exact: true })).toBeVisible();
  await expect.element(about.getByText("Plans trips: flights, trains and places to stay.")).toHaveClass("bot-setup-was");
  await expect.element(app.getByRole("region", { name: "Skills" }).getByText("Off → On")).toBeVisible();
  await expect.element(app.getByRole("region", { name: "Tools" }).getByText("On → Off")).toBeVisible();
  await expect.element(about.getByRole("button", { name: "2 more that don't change" })).toBeVisible();
  await expect.element(app.getByRole("region", { name: "Skills" }).getByRole("button", { name: "2 more that don't change" })).toBeVisible();
  await expect.element(app.getByText("4 changes. Nothing changes until you press Set it up.")).toBeVisible();
  about.element().closest(".msg.returned")!.scrollIntoView({ block: "start" });
  await shot(`${scheme}-card-before-after`);

  await about.getByRole("button", { name: "Show what it is now" }).click();
  const now = about.getByRole("group", { name: "The persona now" });
  await expect.element(now).toMatchTextContent("Check first before you email anyone.");
  await expect.element(now).not.toMatchTextContent("Prefer trains");
  await about.getByRole("button", { name: "2 more that don't change" }).click();
  await expect.element(about.getByRole("checkbox", { name: "Model" })).toBeDisabled();
  about.element().closest(".msg.returned")!.scrollIntoView({ block: "start" });
  await shot(`${scheme}-card-unfolded`);

  await app.getByRole("button", { name: "Set it up", exact: true }).click();
  await expect.poll(() => server.profileMeta[BOT].description).toBe(BLOCK.description);
  await expect.poll(() => server.souls[BOT]).toBe(BLOCK.persona);
  await expect.poll(() => server.skills.disabled[BOT]?.has("rail-europe")).toBe(false);
  await expect.poll(() => server.enabledToolsets(BOT).has("terminal")).toBe(false);
}

async function startFresh(scheme: "dark" | "light") {
  const { app, server, ask } = await botMode(scheme);
  const dialog = await ask("Travel Buddy");
  await dialog.getByRole("radio", { name: /^Start fresh/ }).click();
  await expect.element(dialog.getByRole("button", { name: "Start fresh" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Start fresh" }).click();
  await expect.poll(() => prompts(server), { message: "the new Bot Chat's hidden begin turn" }).toHaveLength(1);

  const old = store(server).find((s) => s.id === OLD)!;
  expect(old, "the old Bot Chat, archived and shown again under its own name").toMatchObject({ archived: true, hidden: false });
  expect(old.title).toMatch(/^Earlier Bot Chat with Travel Buddy, /);
  expect(Object.values(server.memory[BOT]).flat(), "every memory entry gone").toEqual([]);
  const made = store(server).filter((s) => s.title === BOT_CHAT_TITLE);
  expect(made.map((s) => s.id), "one new Bot Chat").not.toContain(OLD);
  expect(made).toHaveLength(1);
  const [create] = server.requests.filter((r) => r.method === "session.create");
  expect(create.params, "the brief seeded hidden").toMatchObject({ profile: BOT, title: BOT_CHAT_TITLE, messages: [{ role: "user", display_kind: "hidden" }] });
  expect(store(server).find((s) => s.id === "trip"), "the bot's other chat stays").toMatchObject({ archived: false, title: "Rome in May" });

  const chat = app.getByRole("main");
  reply(server, String(prompts(server)[0].params.session_id), made[0].id, "I'm starting from a clean slate. Here's how I'm set up now. What would you like to change?");
  await expect.element(chat.getByText(/What would you like to change\?/)).toBeVisible();
  await expect.element(chat.getByText("Setup started")).toBeVisible();
  expect(chat.getByText("The 09:10 Frecciarossa is quickest at 1 h 32 min, €39.").elements(), "the old history isn't in the new Bot Chat").toEqual([]);
  await shot(`${scheme}-fresh-started`);
}

for (const scheme of ["dark", "light"] as const) {
  it(`asks Keep history or Start fresh, sends one hidden brief, and draws the card as before → after with what stays folded (${scheme})`, () => keepHistory(scheme));
  it(`Start fresh archives the Bot Chat, clears the counted memory and opens a new seeded one (${scheme})`, () => startFresh(scheme));
}

it("offers the main bot Keep history only", async () => {
  const { ask } = await botMode("dark");
  const dialog = await ask("Hermes");
  await expect.element(dialog.getByText("Start fresh isn't offered for the main bot.")).toBeVisible();
  expect(dialog.getByRole("radio").elements()).toEqual([]);
  await shot("dark-main-bot");
});
