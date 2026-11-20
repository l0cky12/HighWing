import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { botSetupMarkerId } from "../../src/hermes/botSetupBrief";
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

it("names a bot, opens its Bot Chat as a visit with Bot setup started, and the bot asks first", async () => {
  const { app, server } = await boot({ seed: at0232 });
  const panel = app.getByRole("complementary");
  await panel.getByRole("tab", { name: /^Bots/ }).click();
  await panel.getByRole("button", { name: "New bot" }).click();
  const dialog = app.getByRole("dialog", { name: "New bot" });
  await dialog.getByLabelText("Name").fill("Travel Buddy");
  await dialog.getByRole("button", { name: "Create" }).click();

  await expect.poll(() => prompts(server), { message: "the hidden begin turn" }).toHaveLength(1);
  await expect.element(dialog).not.toBeInTheDocument();
  expect(server.restRequests.filter((r) => r.method === "POST").map((r) => [r.path, r.body]), "one create, with the name alone").toEqual([["/api/profiles", { name: "travel-buddy" }]]);
  const [create] = seeded(server);
  expect(create.params, "the brief seeded hidden in the new bot's Bot Chat").toMatchObject({ profile: "travel-buddy", title: BOT_CHAT_TITLE, messages: [{ role: "user", display_kind: "hidden" }] });
  const id = botSetupMarkerId(String((create.params.messages as { content: string }[])[0].content));
  expect(prompts(server), "the begin turn, hidden, with the brief's id").toEqual([[botSetupBegin(id!), "hidden"]]);
  await shot("setup-started");

  const session = String(server.last("prompt.submit")!.params.session_id);
  reply(server, session, botChatOf(server, "travel-buddy")!, "Hi, I'm Travel Buddy. What should I call you?");
  await expect.element(app.getByText("Hi, I'm Travel Buddy. What should I call you?")).toBeVisible();
  await expect.element(app.getByPlaceholder("Message Travel Buddy")).toBeVisible();
  expect(app.getByText(/highwing:bot-setup/).elements(), "no hidden row is drawn").toEqual([]);
  await shot("first-question");
});

it("after two answers, a relaunch shows both and sends no second brief or begin", async () => {
  const { app, server, relaunch } = await boot({ seed: at0232 });
  const panel = app.getByRole("complementary");
  await panel.getByRole("tab", { name: /^Bots/ }).click();
  await panel.getByRole("button", { name: "New bot" }).click();
  await app.getByRole("dialog", { name: "New bot" }).getByLabelText("Name").fill("Travel Buddy");
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => prompts(server)).toHaveLength(1);
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
