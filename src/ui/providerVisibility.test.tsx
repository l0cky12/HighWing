// @vitest-environment jsdom
// Hiding a provider from Highwing's model lists (ADR 0235), driven through the signed-in app against a fake Hermes:
// Settings → Providers' switches, then the composer's list, Compare, /model, and a restart. Each test checks what the
// lists offer and that nothing about it reaches Hermes.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { connectionScope } from "../hermes/connections";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { getUIPrefs, setProviderHidden, setUIPrefs } from "../hermes/uiPrefs";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const connection = { mode: "ssh" as const, sshTarget: "lena@hermes", url: "", username: "lena" };
const scope = connectionScope(connection);

/** OpenAI's GPT-5 is offered twice: by OpenAI, and through OpenRouter, which is the provider that counts. */
const catalog = {
  model: "gpt-5",
  provider: "openai",
  providers: [
    { slug: "openai", name: "OpenAI", models: ["gpt-5", "gpt-4.1"], authenticated: true },
    { slug: "openrouter", name: "OpenRouter", models: ["openai/gpt-5", "deepseek/deepseek-v4-flash"], authenticated: true },
  ],
};

const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const trigger = () => screen.getByRole("button", { name: /^Model:/ });
const picker = () => screen.getByRole("dialog", { name: /Choose a model|Pick a model to compare with/ });
const sections = () => [...picker().querySelectorAll(".model-section")].map((g) => [g.getAttribute("aria-label"), [...g.querySelectorAll(".model-name")].map((n) => n.textContent)]);
const writes = (server: FakeHermes) => [
  ...server.requests.filter((r) => r.method === "config.set").map((r) => r.params),
  ...server.restRequests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`),
];

async function launch() {
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  server.modelOptionsResult = catalog;
  server.restModelOptions = catalog;
  server.profileModel.default = { model: "gpt-5", provider: "openai", reasoning_effort: "medium", fast: false };
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={connection} onSignOut={async () => {}} />);
  await screen.findByRole("button", { name: /Nightly backup/ });
  await act(() => hermes.loadModels());
  await act(async () => void (await hermes.idle()));
  return { server, hermes, user };
}

describe("Settings → Providers → Model lists", () => {
  it("lists each provider with an on switch, and hides one from the composer's list by keyboard, sending nothing", async () => {
    setUIPrefs({ modelFavorites: ["openrouter/deepseek/deepseek-v4-flash", "openai/gpt-4.1"] });
    const { server, user } = await launch();
    await user.click(screen.getByRole("button", { name: /Settings/ }));
    await user.click(await screen.findByRole("tab", { name: /Providers/ }));
    const lists = await screen.findByRole("region", { name: "Model lists" });
    const openrouter = await within(lists).findByRole("switch", { name: "OpenRouter" });
    expect(within(lists).getAllByRole("switch").map((s) => [s.getAttribute("aria-labelledby") && document.getElementById(s.getAttribute("aria-labelledby")!)!.textContent, s.getAttribute("aria-checked")])).toEqual([
      ["OpenAI", "true"],
      ["OpenRouter", "true"],
    ]);
    openrouter.focus();
    await user.keyboard(" ");
    expect(openrouter.getAttribute("aria-checked")).toBe("false");
    expect(getUIPrefs().hiddenProviders).toEqual({ [scope]: ["openrouter"] });
    // Favorites and everything Hermes has stay as they were.
    expect(getUIPrefs().modelFavorites).toEqual(["openrouter/deepseek/deepseek-v4-flash", "openai/gpt-4.1"]);
    expect(writes(server)).toEqual([]);
    // Still listed, so it can be shown again.
    await user.click(openrouter);
    expect(openrouter.getAttribute("aria-checked")).toBe("true");
    expect(getUIPrefs().hiddenProviders).toEqual({});
  });

  it("warns when every provider is hidden, and the composer's list says how to show them again", async () => {
    setProviderHidden(scope, "openai", true);
    setProviderHidden(scope, "openrouter", true);
    const { user } = await launch();
    await user.click(trigger());
    expect(sections()).toEqual([]);
    expect(within(picker()).getByText("Every provider is hidden in Highwing's model lists. Settings → Providers shows them again.")).toBeTruthy();
    // The model in use stays, and says why it isn't listed.
    expect(trigger().getAttribute("aria-label")).toBe("Model: gpt-5");
    expect(within(picker()).getByRole("note").textContent).toBe("gpt-5 stays as it is. OpenAI is hidden in Highwing's model lists, so its models aren't offered for a new pick.");
  });
});

describe("A hidden provider in the composer", () => {
  it("leaves the list, Favorites and search, keeping the same model through OpenAI", async () => {
    setUIPrefs({ modelFavorites: ["openrouter/deepseek/deepseek-v4-flash", "openai/gpt-4.1"] });
    setProviderHidden(scope, "openrouter", true);
    const { user } = await launch();
    await user.click(trigger());
    expect(sections()).toEqual([
      ["Favorites", ["gpt-4.1"]],
      ["OpenAI", ["gpt-5"]],
    ]);
    await user.keyboard("gpt-5");
    expect(sections()).toEqual([["OpenAI", ["gpt-5"]]]);
    await user.clear(within(picker()).getByRole("textbox", { name: "Search models" }));
    await user.keyboard("deepseek");
    expect(sections()).toEqual([]);
    expect(within(picker()).getByText("No model matches.")).toBeTruthy();
  });

  it("leaves Compare's list too", async () => {
    setProviderHidden(scope, "openrouter", true);
    const { user } = await launch();
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    await user.click(trigger());
    await user.click(within(picker()).getByRole("button", { name: "Compare with another model" }));
    expect(screen.getByRole("dialog", { name: "Pick a model to compare with" })).toBeTruthy();
    expect(sections()).toEqual([["OpenAI", ["gpt-5", "gpt-4.1"]]]);
  });

  it("keeps a pick made before the provider was hidden, says so, and switches nothing on its own", async () => {
    setUIPrefs({ modelPicker: { profile: "default", provider: "openrouter", model: "deepseek/deepseek-v4-flash" } });
    setProviderHidden(scope, "openrouter", true);
    const { server, user } = await launch();
    expect(trigger().getAttribute("aria-label")).toBe("Model: deepseek/deepseek-v4-flash");
    await user.click(trigger());
    expect(within(picker()).getByRole("note").textContent).toBe(
      "deepseek-v4-flash stays as it is. OpenRouter is hidden in Highwing's model lists, so its models aren't offered for a new pick.",
    );
    expect(getUIPrefs().modelPicker).toEqual({ profile: "default", provider: "openrouter", model: "deepseek/deepseek-v4-flash" });
    expect(writes(server)).toEqual([]);
  });

  it("is kept across a restart, and showing it again brings back its models and its kept stars", async () => {
    setUIPrefs({ modelFavorites: ["openrouter/deepseek/deepseek-v4-flash"] });
    setProviderHidden(scope, "openrouter", true);
    const first = await launch();
    cleanup();
    await first.hermes.close();
    // A restart reads the stored document afresh.
    const { user } = await launch();
    await user.click(trigger());
    expect(sections().map(([title]) => title)).toEqual(["OpenAI"]);
    await user.keyboard("{Escape}");
    act(() => void setProviderHidden(scope, "openrouter", false));
    await user.click(trigger());
    expect(sections()).toEqual([
      ["Favorites", ["deepseek/deepseek-v4-flash"]],
      ["OpenAI", ["gpt-5", "gpt-4.1"]],
      ["OpenRouter", ["openai/gpt-5"]],
    ]);
  });

  it("applies to this connection only", async () => {
    setProviderHidden(connectionScope({ ...connection, sshTarget: "lena@elsewhere" }), "openrouter", true);
    const { user } = await launch();
    await user.click(trigger());
    expect(sections().map(([title]) => title)).toEqual(["OpenAI", "OpenRouter"]);
  });
});

describe("/model with a hidden provider", () => {
  const modelSwitches = (server: FakeHermes) => server.requests.filter((r) => r.method === "config.set" && r.params.key === "model");
  const names = () => within(screen.getByRole("listbox", { name: "Models" })).getAllByRole("option").map((o) => [o.querySelector(".cmd-name")!.textContent, o.textContent]);

  it("suggests none of its models, and refuses one typed whole, saying how to show it, with nothing sent", async () => {
    setUIPrefs({ modelFavorites: ["openrouter/deepseek/deepseek-v4-flash"] });
    setProviderHidden(scope, "openrouter", true);
    const { server, user } = await launch();
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    await waitFor(() => expect(composer()).toBeTruthy());
    await user.click(composer());
    await user.keyboard("/model ");
    expect(names().map(([n]) => n)).toEqual(["gpt-5", "gpt-4.1"]);
    expect(names().every(([, text]) => !text!.includes("OpenRouter"))).toBe(true);
    await user.keyboard("deepseek");
    expect(screen.queryByRole("listbox", { name: "Models" })).toBeNull();

    await user.clear(composer());
    await user.keyboard("/model openrouter:openai/gpt-5");
    await user.keyboard("{Escape}{Enter}");
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /^\/model can't run: OpenRouter is hidden in Highwing's model lists, so "openrouter:openai\/gpt-5" isn't picked\. Settings → Providers shows it again\.$/,
    );
    expect(modelSwitches(server)).toEqual([]);

    // The same model through OpenAI switches as before.
    await user.clear(composer());
    await user.keyboard("/model gpt-5");
    await user.keyboard("{Escape}{Enter}");
    await waitFor(() => expect(modelSwitches(server).map((r) => r.params.value)).toEqual([expect.stringMatching(/^gpt-5 --provider openai/)]));
  });
});
