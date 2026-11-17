import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { BOT_CHAT_TITLE } from "../../src/hermes/bots";
import { row, type FakeHermes } from "../../src/hermes/fakeHermes";
import { boot, shot } from "../harness";

// Bot mode's chat list panel (ADR 0066): a right-click on a bot's row opens Chat, Settings and Delete (ADR 0194). Every
// bot here is FakeHermes data: Scribe has a Bot Chat, Scratch is a disposable bot made for deleting.
const seed = (s: FakeHermes) => {
  s.sessions = [row("disk", 0.5, { title: "Disk usage" })];
  s.otherProfiles = {
    scribe: [row("scribe-bot", 0.01, { title: BOT_CHAT_TITLE, hidden: true })],
    scratch: [],
  };
  s.transcripts = {
    "scribe-bot": [
      { role: "user", text: "Draft the release notes for 0.9" },
      { role: "assistant", text: "Release notes drafted: three fixes." },
    ],
  };
  s.profileMeta = {
    scribe: { description: "Fake bot: writes release notes", ui_meta: { "hermes-bots": { title: "Scribe", color: "#44aa77" } } },
    scratch: { description: "Disposable test bot", ui_meta: { "hermes-bots": { title: "Scratch", color: "#aa6644" } } },
  };
};

/** Opens Scribe's Bot Chat from the Bots view, which puts the chat list panel in bot mode. */
async function botMode() {
  const { app, server } = await boot({ seed });
  await app.getByRole("button", { name: "Bots", exact: true }).click();
  await app.getByRole("dialog", { name: "Bots" }).getByRole("button", { name: /^Scribe\./ }).click();
  await expect.element(app.getByText("Draft the release notes for 0.9")).toBeVisible();
  const panel = app.getByRole("complementary");
  await expect.element(panel.getByRole("heading", { name: "Bots" })).toBeVisible();
  const rowOf = (name: string) => panel.getByRole("button", { name: new RegExp(`^${name}\\.`) });
  await expect.element(rowOf("Scratch")).toBeVisible();
  return { app, server, panel, rowOf };
}

/** What was written to the server's profiles: opening a Bot Chat writes its own read mark, which isn't the menu's. */
const writes = (server: FakeHermes) => server.restRequests.filter((r) => r.method !== "GET" && r.path.startsWith("/api/profiles")).map((r) => `${r.method} ${r.path}`);

it("opens Chat, Settings and Delete on a right-click on a bot in the chat list panel, switching nothing", async () => {
  const { app, server, rowOf } = await botMode();
  await shot("bot-mode");
  await rowOf("Scratch").click({ button: "right" });
  await shot("right-clicked");
  const menu = app.getByRole("menu", { name: "More for Scratch" });
  await expect.element(menu).toBeVisible();
  expect(menu.getByRole("menuitem").elements().map((e) => e.textContent)).toEqual(["Chat", "Settings", "Delete"]);
  // Scribe's Bot Chat is still the one open.
  await expect.element(rowOf("Scribe")).toHaveAttribute("aria-current", "true");
  await expect.element(rowOf("Scratch")).not.toHaveAttribute("aria-current");
  await userEvent.keyboard("{Escape}");
  await expect.element(menu).not.toBeInTheDocument();
  expect(writes(server)).toEqual([]);
});

it("Settings edits that bot and its row reads the change back", async () => {
  const { app, server, rowOf } = await botMode();
  await rowOf("Scratch").click({ button: "right" });
  await app.getByRole("menuitem", { name: "Settings" }).click();
  const dialog = app.getByRole("dialog", { name: "Edit bot: Scratch" });
  await expect.element(dialog.getByLabelText("Name in Bot Mode")).toHaveValue("Scratch");
  await dialog.getByLabelText("Description").fill("Disposable test bot, edited from the panel");
  await shot("settings-editor");
  await dialog.getByRole("button", { name: /Save changes/ }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(rowOf("Scratch").getByText("Disposable test bot, edited from the panel")).toBeVisible();
  await shot("settings-saved");
  expect(writes(server)).toEqual(["PUT /api/profiles/scratch/description"]);
  expect(server.profileMeta.scratch.description).toBe("Disposable test bot, edited from the panel");
});

it("Delete asks first, naming the bot; Cancel deletes nothing, and confirming deletes only that bot", async () => {
  const { app, server, panel, rowOf } = await botMode();
  await rowOf("Scratch").click({ button: "right" });
  await app.getByRole("menuitem", { name: "Delete" }).click();
  const question = app.getByRole("alertdialog", { name: /Delete profile “scratch”\?/ });
  await expect.element(question).toBeVisible();
  await shot("delete-confirm");
  await question.getByRole("button", { name: "Cancel" }).click();
  await expect.element(question).not.toBeInTheDocument();
  expect(writes(server), "Cancel sends nothing").toEqual([]);

  await rowOf("Scratch").click({ button: "right" });
  await app.getByRole("menuitem", { name: "Delete" }).click();
  await question.getByLabelText("Type scratch to confirm").fill("scratch");
  await question.getByRole("button", { name: /Delete profile/ }).click();
  await expect.element(rowOf("Scratch")).not.toBeInTheDocument();
  await expect.element(panel.getByRole("button", { name: /^Scribe\./ })).toHaveAttribute("aria-current", "true");
  await shot("deleted");
  expect(writes(server)).toEqual(["DELETE /api/profiles/scratch"]);
  expect(Object.keys(server.otherProfiles)).toEqual(["scribe"]);
});
