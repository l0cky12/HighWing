import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import type { FakeHermes } from "../../src/hermes/fakeHermes";
import { boot, shot } from "../harness";

const seed = (s: FakeHermes) => {
  s.otherProfiles = { scout: [] };
  s.souls = { default: "# Default persona\n", scout: "" };
  s.oneshotAnswer = (c) => (c.input.includes("<soul>") ? "# Scout\n\nCalm, exact, brief." : "# Scout\n\nCalm and exact. Never guesses.");
};

const oneshots = (server: FakeHermes) => server.requests.filter((r) => r.method === "llm.oneshot").map((r) => r.params);
const writes = (server: FakeHermes) => server.restRequests.filter((r) => r.method !== "GET").map((r) => [`${r.method} ${r.path}`, r.body]);

it("writes a SOUL.md for a profile not in use from notes, and only Save writes it, to that profile", async () => {
  const { app, server } = await boot({ seed });
  await app.getByPlaceholder("Message Hermes").click();
  await userEvent.keyboard("{Control>},{/Control}");
  await app.getByRole("tab", { name: /Persona/ }).click();
  await app.getByRole("combobox", { name: "Profile" }).selectOptions("scout");
  const editor = app.getByRole("textbox", { name: "SOUL.md for the scout profile" });
  await expect.element(editor).toHaveValue("");

  await app.getByRole("button", { name: "Write with AI…" }).click();
  await app.getByLabelText("Notes for Hermes").fill("A calm scout. Never guesses.");
  expect(oneshots(server), "opening the panel and typing asks Hermes nothing").toEqual([]);
  await shot("notes");
  await app.getByRole("button", { name: "Write with AI", exact: true }).click();
  const suggestion = app.getByRole("textbox", { name: "Suggested SOUL.md" });
  await expect.element(suggestion).toHaveValue("# Scout\n\nCalm and exact. Never guesses.");
  expect(oneshots(server)[0], "one call, on the picked profile, with no chat").toMatchObject({ profile: "scout" });
  expect(oneshots(server)[0].session_id).toBeUndefined();
  await shot("suggested");

  await suggestion.fill("# Scout\n\nCalm and exact. Never guesses. Short answers.");
  await app.getByRole("button", { name: "Apply" }).click();
  await expect.element(editor).toHaveValue("# Scout\n\nCalm and exact. Never guesses. Short answers.");
  expect(writes(server), "Apply writes nothing").toEqual([]);
  await app.getByRole("button", { name: "Save", exact: true }).click();
  await expect.element(app.getByText(/Saved SOUL.md/)).toBeVisible();
  await shot("saved");
  expect(server.souls).toEqual({ default: "# Default persona\n", scout: "# Scout\n\nCalm and exact. Never guesses. Short answers." });
});
