import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { boot, shot } from "../harness";

it("changes the main model: Hermes stores it, and Settings shows it when opened again", async () => {
  const { app, server } = await boot();
  await app.getByPlaceholder("Message Hermes").click();
  await userEvent.keyboard("{Control>},{/Control}");
  await app.getByRole("tab", { name: /Model/ }).click();
  const model = app.getByRole("combobox", { name: "Main model" });
  await expect.element(model).toHaveValue("z-ai/glm-5.3-flash");

  await model.click();
  await app.getByRole("listbox", { name: "Main model" }).getByRole("option", { name: "deepseek/deepseek-v4-pro" }).click();
  await app.getByRole("button", { name: "Apply main model" }).click();
  await expect.element(app.getByText("Applied. New chats use it.")).toBeVisible();
  await shot("applied");

  await app.getByRole("button", { name: "Back to chat" }).click();
  await app.getByRole("button", { name: "Settings", exact: true }).click();
  await app.getByRole("tab", { name: /Model/ }).click();
  await expect.element(model, { message: "Settings, opened again, reads the model back from Hermes" }).toHaveValue("deepseek/deepseek-v4-pro");
  await shot("reopened");

  const writes = server.restRequests.filter((r) => r.method !== "GET").map((r) => [`${r.method} ${r.path}`, r.body]);
  expect(writes, "what Settings wrote to Hermes").toEqual([["POST /api/model/set", { scope: "main", provider: "openrouter", model: "deepseek/deepseek-v4-pro" }]]);
});

it("turns off notifications about finished job runs, on this computer only (#28)", async () => {
  const { app, server } = await boot();
  await app.getByPlaceholder("Message Hermes").click();
  await userEvent.keyboard("{Control>},{/Control}");
  await app.getByRole("tab", { name: /General/ }).click();
  await app.getByRole("group", { name: /^General: / }).getByRole("button", { name: "Chats", exact: true }).click();
  const toggle = app.getByRole("switch", { name: "Notify when a job runs" });
  await expect.element(toggle).toHaveAttribute("aria-checked", "true");
  toggle.element().scrollIntoView({ block: "center" });
  await shot("on");

  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-checked", "false");
  await shot("off");
  expect(server.restRequests.filter((r) => r.method !== "GET"), "nothing written to Hermes").toEqual([]);
});
