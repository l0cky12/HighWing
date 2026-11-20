import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { BOT_SETUP_FENCE, botSetupMarkerId, type BotSetupNewBlock } from "../../src/hermes/botSetupBrief";
import { botSetupBegin } from "../../src/hermes/botSetupStart";
import { BOT_CHAT_TITLE } from "../../src/hermes/bots";
import type { FakeHermes } from "../../src/hermes/fakeHermes";
import { boot, shot } from "../harness";

const at0232 = (s: FakeHermes) => {
  s.health = { ...s.health, version: "0.23.2", displayVersion: "0.23.2" };
  s.status = { ...s.status, version: "0.23.2" };
};

/** The bot's reply to the turn `session` is running, streamed and stored as Hermes does. */
function reply(server: FakeHermes, session: string, chatId: string, text: string) {
  server.event(session, "message.start");
  server.event(session, "message.delta", { text });
  server.storeMessage(chatId, { role: "assistant", text });
  server.event(session, "message.complete", { text, status: "complete" });
}

const VERSION_READ = { timeout: 5000 };

const BLOCK: BotSetupNewBlock = {
  v: 1,
  persona: "You are Travel Buddy, a practical trip planner. Compare trains and places to stay side by side. Never book or pay for anything.",
  description: "Plans weekend trips.",
  model: null,
  color: "teal",
  callOwner: "Liam",
  skills: [],
  toolsets: [],
  mcp: [],
  copy: [],
};

const seeded = (server: FakeHermes) => server.requests.filter((r) => r.method === "session.create" && Array.isArray(r.params.messages));
const prompts = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit").map((r) => [r.params.text, r.params.display_kind ?? null]);
const botChatOf = (server: FakeHermes, profile: string) => server.otherProfiles[profile]?.find((s) => s.title === BOT_CHAT_TITLE)?.id;

for (const scheme of ["light", "dark"] as const)
  it(`shows the name dialog: empty, with a name and its id, and with Skip's menu open (${scheme})`, async () => {
    localStorage.setItem("hermes-chat.appearance", JSON.stringify({ scheme }));
    const { app } = await boot({ seed: at0232 });
    const panel = app.getByRole("complementary");
    await panel.getByRole("tab", { name: /^Bots/ }).click();
    await panel.getByRole("button", { name: "New bot" }).click();
    const dialog = app.getByRole("dialog", { name: "New bot" });
    await expect.element(dialog.getByLabelText("Name")).toHaveFocus();
    await shot("empty");
    await dialog.getByLabelText("Name").fill("Travel Buddy");
    await expect.element(dialog.getByText("travel-buddy")).toBeVisible();
    await shot("named");
    await dialog.getByRole("button", { name: /^Skip/ }).click();
    const menu = app.getByRole("menu", { name: "Skip the questions" });
    await expect.element(menu.getByRole("menuitem", { name: /Start blank/ })).toHaveFocus();
    await Promise.all(menu.element().getAnimations().map((a) => a.finished));
    await shot("skip-menu");
  });

it("names a bot, opens its Bot Chat as a visit with Bot setup started, the bot asks first, and its card sets it up", async () => {
  const { app, server } = await boot({ seed: at0232 });
  const panel = app.getByRole("complementary");
  await panel.getByRole("tab", { name: /^Bots/ }).click();
  await panel.getByRole("button", { name: "New bot" }).click();
  const dialog = app.getByRole("dialog", { name: "New bot" });
  await dialog.getByLabelText("Name").fill("Travel Buddy");
  await dialog.getByRole("button", { name: "Create" }).click();

  await expect.poll(() => prompts(server), { message: "the hidden begin turn", ...VERSION_READ }).toHaveLength(1);
  await expect.element(dialog).not.toBeInTheDocument();
  expect(server.restRequests.filter((r) => r.method === "POST").map((r) => [r.path, r.body]), "one create, with the name alone").toEqual([["/api/profiles", { name: "travel-buddy" }]]);
  const [create] = seeded(server);
  expect(create.params, "the brief seeded hidden in the new bot's Bot Chat").toMatchObject({ profile: "travel-buddy", title: BOT_CHAT_TITLE, messages: [{ role: "user", display_kind: "hidden" }] });
  const id = botSetupMarkerId(String((create.params.messages as { content: string }[])[0].content));
  expect(prompts(server), "the begin turn, hidden, with the brief's id").toEqual([[botSetupBegin(id!), "hidden"]]);
  await expect.element(app.getByText("Setup started")).toBeVisible();
  await shot("setup-started");

  const session = String(server.last("prompt.submit")!.params.session_id);
  reply(server, session, botChatOf(server, "travel-buddy")!, "Hi, I'm Travel Buddy. What should I call you?");
  await expect.element(app.getByText("Hi, I'm Travel Buddy. What should I call you?")).toBeVisible();
  await expect.element(app.getByPlaceholder("Message Travel Buddy")).toBeVisible();
  expect(app.getByText(/highwing:bot-setup/).elements(), "no hidden row is drawn").toEqual([]);
  await shot("first-question");

  await app.getByPlaceholder("Message Travel Buddy").fill("Liam");
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => String(server.last("prompt.submit")?.params.text ?? "").split("\n")[0], { message: "the answer Hermes got" }).toBe("Liam");
  const card = `Thanks, Liam. Here's how I'd set myself up.\n\n\`\`\`${BOT_SETUP_FENCE}\n${JSON.stringify(BLOCK)}\n\`\`\``;
  reply(server, String(server.last("prompt.submit")!.params.session_id), botChatOf(server, "travel-buddy")!, card);
  const about = app.getByRole("region", { name: "About Travel Buddy" });
  await expect.element(about).toBeVisible();
  about.element().closest(".msg.returned")!.scrollIntoView({ block: "start" });
  await shot("card");
  await app.getByRole("button", { name: "Set it up", exact: true }).click();
  await expect.poll(() => server.souls["travel-buddy"], { message: "the persona Set it up wrote" }).toBe(BLOCK.persona);
  expect(server.profileMeta["travel-buddy"]?.description, "the description Set it up wrote").toBe(BLOCK.description);
  await expect.poll(() => prompts(server).filter(([text]) => String(text).startsWith("[highwing:bot-setup ready")), { message: "the hidden ready turn" }).toHaveLength(1);
  await shot("set-up");
});

it("after two answers, a relaunch shows both and sends no second brief or begin", async () => {
  const { app, server, relaunch } = await boot({ seed: at0232 });
  const panel = app.getByRole("complementary");
  await panel.getByRole("tab", { name: /^Bots/ }).click();
  await panel.getByRole("button", { name: "New bot" }).click();
  await app.getByRole("dialog", { name: "New bot" }).getByLabelText("Name").fill("Travel Buddy");
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => prompts(server), VERSION_READ).toHaveLength(1);
  const chatId = botChatOf(server, "travel-buddy")!;
  reply(server, String(server.last("prompt.submit")!.params.session_id), chatId, "What should I call you?");
  const composer = app.getByPlaceholder("Message Travel Buddy");
  for (const [answer, next] of [
    ["Liam", "What do you want me to help with?"],
    ["Planning weekend trips", "How should I talk to you?"],
  ]) {
    await composer.fill(answer);
    await userEvent.keyboard("{Enter}");
    // A Bot Chat's message carries the ask-first rule after the owner's words (ADR 0229).
    await expect.poll(() => String(server.last("prompt.submit")?.params.text ?? "").split("\n")[0], { message: "the answer Hermes got" }).toBe(answer);
    reply(server, String(server.last("prompt.submit")!.params.session_id), chatId, next);
    await expect.element(app.getByRole("main").getByText(next)).toBeVisible();
  }
  const before = { prompts: prompts(server), seeded: seeded(server).length };

  await relaunch();
  // A relaunch opens on the profile the visit left; the bot's row opens its Bot Chat again.
  const again = app.getByRole("complementary");
  await again.getByRole("tab", { name: /^Bots/ }).click();
  await again.getByRole("button", { name: /^Travel Buddy\b/ }).click();
  const chat = app.getByRole("main");
  await expect.element(chat.getByText("Planning weekend trips")).toBeVisible();
  await expect.element(chat.getByText("Liam", { exact: true })).toBeVisible();
  await expect.element(chat.getByText("How should I talk to you?")).toBeVisible();
  await shot("relaunched");
  expect(prompts(server), "nothing sent again").toEqual(before.prompts);
  expect(seeded(server).length, "one brief").toBe(before.seeded);
  expect(server.otherProfiles["travel-buddy"].filter((s) => s.title === BOT_CHAT_TITLE)).toHaveLength(1);
});

it("after a lost create it offers Check again, which finds the bot and opens it without making a second one", async () => {
  const { app, server } = await boot({
    seed: (s) => {
      at0232(s);
      const post = s.rest["POST /api/profiles"];
      const get = s.rest["GET /api/profiles"];
      let unreadable = 0;
      s.rest["POST /api/profiles"] = (req) => {
        post(req);
        unreadable = 1;
        throw new Error("The connection was reset.");
      };
      s.rest["GET /api/profiles"] = (req) => {
        if (unreadable-- > 0) throw new Error("The connection was reset.");
        return get(req);
      };
    },
  });
  const panel = app.getByRole("complementary");
  await panel.getByRole("tab", { name: /^Bots/ }).click();
  await panel.getByRole("button", { name: "New bot" }).click();
  const dialog = app.getByRole("dialog", { name: "New bot" });
  await dialog.getByLabelText("Name").fill("Travel Buddy");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect.element(dialog.getByRole("button", { name: "Check again" })).toBeVisible();
  await shot("check-again");
  await dialog.getByRole("button", { name: "Check again" }).click();
  await expect.poll(() => prompts(server), { message: "the hidden begin turn", ...VERSION_READ }).toHaveLength(1);
  expect(server.restRequests.filter((r) => r.method === "POST").map((r) => r.body), "one create").toEqual([{ name: "travel-buddy" }]);
});
