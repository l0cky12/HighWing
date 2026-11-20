import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { BOT_CHAT_TITLE } from "../../src/hermes/bots";
import { BOT_PICTURE_URLS } from "../../src/hermes/botPictures";
import { row, type FakeHermes } from "../../src/hermes/fakeHermes";
import { APPEARANCE_KEY } from "../../src/ui/appearance";
import { boot, settled, shot } from "../harness";

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

async function botMode() {
  const { app, server } = await boot({ seed });
  const panel = app.getByRole("complementary");
  await panel.getByRole("tab", { name: /^Bots/ }).click();
  await expect.element(panel.getByRole("tab", { name: /^Bots/ })).toHaveAttribute("aria-selected", "true");
  const rowOf = (name: string) => panel.getByRole("button", { name: new RegExp(`^${name}\\.`) });
  await rowOf("Scribe").click();
  await expect.element(app.getByText("Draft the release notes for 0.9")).toBeVisible();
  await expect.element(rowOf("Scratch")).toBeVisible();
  return { app, server, panel, rowOf };
}

/** What was written to the server's profiles: opening a Bot Chat writes its own read mark, which isn't the menu's. */
const writes = (server: FakeHermes) => server.restRequests.filter((r) => r.method !== "GET" && r.path.startsWith("/api/profiles")).map((r) => `${r.method} ${r.path}`);

it("opens Chat, Settings, Edit persona…, Clone, Pin, Hide and Delete on a right-click on a bot in the chat list panel, switching nothing", async () => {
  const { app, server, rowOf } = await botMode();
  await shot("bot-mode");
  await rowOf("Scratch").click({ button: "right" });
  await shot("right-clicked");
  const menu = app.getByRole("menu", { name: "More for Scratch" });
  await expect.element(menu).toBeVisible();
  expect(menu.getByRole("menuitem").elements().map((e) => e.textContent)).toEqual(["Chat", "Settings", "Edit persona…", "Clone…", "Pin", "Hide", "Delete"]);
  // Scribe's Bot Chat is still the one open.
  await expect.element(rowOf("Scribe")).toHaveAttribute("aria-current", "true");
  await expect.element(rowOf("Scratch")).not.toHaveAttribute("aria-current");
  await userEvent.keyboard("{Escape}");
  await expect.element(menu).not.toBeInTheDocument();
  expect(writes(server)).toEqual([]);
});

it("Settings edits that bot and its row reads the change back", async () => {
  const { app, server, panel, rowOf } = await botMode();
  await rowOf("Scratch").click({ button: "right" });
  await app.getByRole("menuitem", { name: "Settings" }).click();
  const dialog = app.getByRole("dialog", { name: "Edit bot: Scratch" });
  await expect.element(dialog.getByLabelText("Name in Bot Mode")).toHaveValue("Scratch");
  await dialog.getByLabelText("Description").fill("Disposable test bot, edited from the panel");
  await shot("settings-editor");
  await dialog.getByRole("button", { name: /Save changes/ }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(panel.getByRole("button", { name: /^Scratch\. Disposable test bot, edited from the panel\./ })).toBeInTheDocument();
  await shot("settings-saved");
  expect(writes(server)).toEqual(["PUT /api/profiles/scratch/description"]);
  expect(server.profileMeta.scratch.description).toBe("Disposable test bot, edited from the panel");
});

async function picksPicture(scheme: "dark" | "light") {
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ scheme }));
  const { app, server, panel, rowOf } = await botMode();
  await rowOf("Scratch").click({ button: "right" });
  await app.getByRole("menuitem", { name: "Settings" }).click();
  const dialog = app.getByRole("dialog", { name: "Edit bot: Scratch" });
  await dialog.getByRole("button", { name: "Change the picture" }).click();
  const picker = dialog.getByRole("dialog", { name: "Choose a picture" });
  await expect.element(picker.getByRole("tab", { name: "Pictures" })).toHaveAttribute("aria-selected", "true");
  await expect.element(picker.getByRole("radio")).toHaveLength(10);
  await settled(picker);
  await shot(`${scheme}-picture-picker`);
  await picker.getByRole("radio", { name: "Compass · for planning" }).click();
  await expect.element(picker).not.toBeInTheDocument();
  await expect.element(dialog.getByRole("button", { name: "Remove picture" })).toBeVisible();
  await shot(`${scheme}-picture-chosen`);
  await dialog.getByRole("button", { name: /Save changes/ }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(server.requests.filter((r) => r.method === "profiles.set_asset").map((r) => r.params)).toEqual([{ name: "scratch", asset: "avatar", data: BOT_PICTURE_URLS.compass }]);
  expect(server.botAvatars.scratch).toBe(BOT_PICTURE_URLS.compass);
  expect(panel.getByRole("button", { name: /^Scratch\./ }).element().querySelector("img")?.getAttribute("src")).toBe(BOT_PICTURE_URLS.compass);
}

it("Settings' picture picker opens on Pictures, and the one chosen is saved as the set's own bytes, in the dark theme", () => picksPicture("dark"));
it("does the same in the light theme", () => picksPicture("light"));

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

it("makes a bot from New bot above the rows, and Reload reads the bots again", async () => {
  const { app, server, panel, rowOf } = await botMode();
  await shot("new-bot-and-reload");
  await panel.getByRole("button", { name: "New bot" }).click();
  const dialog = app.getByRole("dialog", { name: "New bot" });
  await dialog.getByLabelText("Name").fill("Ada");
  await dialog.getByRole("button", { name: /^Skip/ }).click();
  await app.getByRole("menuitem", { name: /Start blank/ }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(rowOf("Ada")).toHaveAttribute("aria-current", "true");
  await shot("new-bot-made");
  expect(writes(server)).toEqual(["POST /api/profiles"]);

  server.profileMeta.ada = { ui_meta: { "hermes-bots": { title: "Ada Lovelace" } } };
  await panel.getByRole("button", { name: "Reload bots" }).click();
  await expect.element(panel.getByText("Ada Lovelace")).toBeVisible();
});
