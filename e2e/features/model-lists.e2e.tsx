import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { boot, shot } from "../harness";

it("hides OpenRouter from the model lists in Settings → Providers: the composer and Settings → Model offer none of its models, and Hermes gets nothing", async () => {
  const { app, server } = await boot({
    seed: (s) => {
      s.modelOptionsResult = { providers: s.modelConfig.catalog.map((p) => ({ ...p, authenticated: true })) };
    },
  });
  await app.getByPlaceholder("Message Hermes").click();
  await userEvent.keyboard("{Control>},{/Control}");
  await app.getByRole("tab", { name: /Providers/ }).click();
  const lists = app.getByRole("region", { name: "Model lists" });
  const openrouter = lists.getByRole("switch", { name: "OpenRouter" });
  await expect.element(openrouter).toHaveAttribute("aria-checked", "true");
  await openrouter.click();
  await expect.element(openrouter, { message: "the switch is off, and the row stays to turn it back on" }).toHaveAttribute("aria-checked", "false");
  await shot("openrouter hidden");

  await app.getByRole("tab", { name: /Model/ }).click();
  const provider = app.getByRole("combobox", { name: "Main provider" });
  await expect.element(provider, { message: "the main model stays on OpenRouter" }).toHaveValue("openrouter");
  await expect.element(app.getByText("OpenRouter is hidden in Highwing's model lists, so its models aren't offered for a new pick.").first()).toBeVisible();
  await shot("settings model keeps its model");

  await app.getByRole("button", { name: "Back to chat" }).click();
  await app.getByRole("button", { name: /^Model:/ }).click();
  const list = app.getByRole("dialog", { name: "Choose a model" });
  await expect.element(list.getByRole("group", { name: "Nous Portal" })).toBeVisible();
  await expect.element(list.getByRole("group", { name: "OpenRouter" }), { message: "OpenRouter's section is gone from the composer's list" }).not.toBeInTheDocument();
  await shot("composer list without openrouter");

  const writes = [...server.restRequests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`), ...server.requests.filter((r) => r.method === "config.set").map((r) => r.method)];
  expect(writes, "what hiding sent to Hermes").toEqual([]);
});
