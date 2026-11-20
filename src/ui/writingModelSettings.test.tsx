// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeHermes, fakeModelConfig } from "../hermes/fakeHermes";
import { getUIPrefs, setProviderHidden, setUIPrefs } from "../hermes/uiPrefs";
import { ModelListScope } from "./modelLists";
import { connect, type Hermes } from "../hermes/transport";
import { appearanceStore } from "./appearance";
import { SettingsScreen } from "./Settings";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const SCOPE = '["connection","c1"]';

function memoryStorage() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
}

function Screen({ hermes, connected = true }: { hermes: Hermes; connected?: boolean }) {
  return (
    <ModelListScope value={SCOPE}>
    <SettingsScreen
      status={connected ? "connected" : "offline"}
      unsecure={false}
      username="lena"
      passwordSaved
      profile="default"
      olderPulled={false}
      cacheBytes={() => 0}
      appearance={appearanceStore(memoryStorage(), document.createElement("html"))}
      listFonts={async () => ({ all: [], mono: [] })}
      modelSettings={hermes.modelSettings}
      listProfiles={async () => ["default", "wazuh"]}
      writing={{ desk: connected ? hermes.writingDesk(() => getUIPrefs().writingModels[SCOPE]) : undefined, scope: SCOPE }}
      onClearCache={() => {}}
      onPullOlder={async () => []}
      onSignOut={async () => {}}
      onClose={() => {}}
    />
    </ModelListScope>
  );
}

async function shown(o: { connected?: boolean; seed?: (s: FakeHermes) => void } = {}) {
  const server = new FakeHermes();
  const wazuh = fakeModelConfig();
  wazuh.model = { provider: "openai-codex", default: "gpt-6.1-sol" };
  wazuh.auxiliary.title_generation = { provider: "auto", model: "" };
  server.profileModelConfigs.set("wazuh", wazuh);
  o.seed?.(server);
  const hermes = await connect(server.openPipe, "default");
  const user = userEvent.setup();
  render(<Screen hermes={hermes} connected={o.connected} />);
  await user.click(screen.getByRole("tab", { name: /Model/ }));
  return { server, user };
}

const section = () => screen.getByRole("heading", { name: "Writing model" }).closest("section")!;
const bot = (name: string) => within(section()).getByText(name, { selector: ".mono" }).parentElement!.textContent;

describe("The Writing model setting", () => {
  it("lists which model writes for each bot, and picking one keeps it here, writes nothing to Hermes, and moves only unpinned bots", async () => {
    const { server, user } = await shown();
    await waitFor(() => expect(bot("wazuh")).toBe("wazuh Writes with its own model: openai-codex · gpt-6.1-sol."));
    expect(bot("default")).toBe("default Pinned on the server: openrouter · deepseek-v4-flash, its Text generation model. The Writing model doesn't apply.");
    expect(within(section()).getByText(/Profile descriptions \(Write for me\) are written by the server's Profile descriptions model/)).toBeTruthy();

    await user.selectOptions(within(section()).getByRole("combobox", { name: "Writing model: provider" }), "nous");
    expect(getUIPrefs().writingModels).toEqual({});
    await user.click(within(section()).getByRole("combobox", { name: "Writing model: model" }));
    await user.click(within(screen.getByRole("listbox", { name: "Writing model: model" })).getByRole("option", { name: "hermes-5-70b" }));
    expect(getUIPrefs().writingModels).toEqual({ [SCOPE]: { provider: "nous", model: "hermes-5-70b" } });
    await waitFor(() => expect(bot("wazuh")).toBe("wazuh Uses the Writing model."));
    expect(bot("default")).toMatch(/^default Pinned on the server/);
    expect(server.configWrites).toEqual([]);

    await user.click(within(section()).getByRole("button", { name: "Use each bot's own model" }));
    expect(getUIPrefs().writingModels).toEqual({});
    await waitFor(() => expect(bot("wazuh")).toBe("wazuh Writes with its own model: openai-codex · gpt-6.1-sol."));
  });

  it("reads the bots again once Text generation is unpinned on the same screen", async () => {
    const { user } = await shown();
    await waitFor(() => expect(bot("default")).toMatch(/^default Pinned on the server/));
    await user.click(screen.getByRole("button", { name: "Use the main model for text generation" }));
    await waitFor(() => expect(bot("default")).toBe("default Writes with its own model: openrouter · glm-5.3-flash."));
  });

  it("keeps the user-defined endpoint's URL with a pick from it", async () => {
    const { user } = await shown({
      seed: (s) => s.modelConfig.catalog.push({ slug: "custom:lan", name: "LAN box", models: ["qwen-4"], capabilities: {}, api_url: "http://10.0.0.5:8080/v1" }),
    });
    await within(section()).findByRole("option", { name: "LAN box" });
    await user.selectOptions(within(section()).getByRole("combobox", { name: "Writing model: provider" }), "custom:lan");
    await user.click(within(section()).getByRole("combobox", { name: "Writing model: model" }));
    await user.click(within(screen.getByRole("listbox", { name: "Writing model: model" })).getByRole("option", { name: "qwen-4" }));
    expect(getUIPrefs().writingModels[SCOPE]).toEqual({ provider: "custom:lan", model: "qwen-4", apiUrl: "http://10.0.0.5:8080/v1" });
  });

  it("shows the pick while offline, and says the bot list needs a connection", async () => {
    localStorage.setItem("hermes-ui-prefs", JSON.stringify({ v: 5, writingModels: { [SCOPE]: { provider: "nous", model: "hermes-5-70b" } } }));
    await shown({ connected: false });
    expect(within(section()).getByText("nous · hermes-5-70b")).toBeTruthy();
    expect(within(section()).getByText("Connect to Hermes to see which model each bot writes with.")).toBeTruthy();
  });

  it("is what an unset Project instructions model leaves writing to on a bot with nothing pinned", async () => {
    localStorage.setItem("hermes-ui-prefs", JSON.stringify({ v: 5, writingModels: { [SCOPE]: { provider: "nous", model: "hermes-5-70b" } } }));
    await shown({ seed: (s) => (s.modelConfig.auxiliary.title_generation = { provider: "auto", model: "" }) });
    const card = await screen.findByRole("group", { name: "Project instructions model" });
    expect(card.textContent).toContain("Until you pick one, your Writing model writes them, hermes-5-70b.");
  });
});

describe("The Writing model with a provider hidden in Highwing's model lists (ADR 0235)", () => {
  const provider = () => within(section()).getByRole<HTMLSelectElement>("combobox", { name: "Writing model: provider" });

  it("offers none of its models, keeps a pick already on it with a note, and keeps the pick until another is made", async () => {
    setUIPrefs({ writingModels: { [SCOPE]: { provider: "openrouter", model: "deepseek/deepseek-v4-flash" } } });
    setProviderHidden(SCOPE, "openrouter", true);
    const { user } = await shown();
    await waitFor(() => expect([...provider().options].map((o) => o.textContent)).toEqual(["OpenRouter (hidden in Highwing)", "Nous Portal", "ChatGPT or Codex Subscription"]));
    expect(provider().value).toBe("openrouter");
    expect(within(section()).getByText("OpenRouter is hidden in Highwing's model lists, so its models aren't offered for a new pick.")).toBeTruthy();
    await user.click(within(section()).getByRole("combobox", { name: "Writing model: model" }));
    expect(within(screen.getByRole("listbox", { name: "Writing model: model" })).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "deepseek/deepseek-v4-flashProvider hidden in Highwing",
    ]);
    expect(getUIPrefs().writingModels).toEqual({ [SCOPE]: { provider: "openrouter", model: "deepseek/deepseek-v4-flash" } });
  });

  it("lists every provider when none is hidden", async () => {
    await shown();
    await waitFor(() => expect([...provider().options].map((o) => o.textContent)).toEqual(["Choose a provider…", "OpenRouter", "Nous Portal", "ChatGPT or Codex Subscription"]));
  });
});
