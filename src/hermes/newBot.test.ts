// Making a bot from a name (newBot.ts, ADR 0231 "Making a bot") through the real transport against FakeHermes: the id
// Hermes's clients will show, the one create and what it carries, the model Hermes didn't set, and the name written in
// Bot Mode after. Then the inventory a new bot's brief offers. All data is synthetic.
import { afterEach, describe, expect, it } from "vitest";
import type { Bot } from "./bots";
import { FakeHermes } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
import { makeBot, newBotInventory, type InventoryIo, type NewBotIo } from "./newBot";
import { ProfileError } from "./profiles";
import { connect, type Hermes } from "./transport";

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
});

async function signedIn(setup: (s: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.otherProfiles = { work: [] };
  setup(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  await hermes.sync();
  const io = (botMode = true): NewBotIo => ({
    list: () => hermes.manageProfiles.list(),
    create: (f) => hermes.manageProfiles.create(f),
    ...(botMode && { name: (p: string, title: string) => hermes.editBot(p, { title: { from: "", to: title } }) }),
  });
  return { server, hermes, io };
}

const creates = (server: FakeHermes) => server.restRequests.filter((r) => r.method === "POST" && r.path === "/api/profiles").map((r) => r.body);
const configures = (server: FakeHermes) => server.requests.filter((r) => r.method === "profiles.configure").map((r) => r.params.name);
const titleOf = (server: FakeHermes, profile: string) => (server.profileMeta[profile]?.ui_meta?.["hermes-bots"] as { title?: string } | undefined)?.title;

describe("makeBot", () => {
  it("makes the id from the name as Hermes's clients do, and sends only the name when the profile in use has no model of its own", async () => {
    const { server, io } = await signedIn();
    expect(await makeBot(io(), "  Travel Buddy ", "default")).toEqual({ profile: "travel-buddy" });
    expect(creates(server)).toEqual([{ name: "travel-buddy" }]);
  });

  it("sends the profile in use's own model with the name, and no persona or description", async () => {
    const { server, io } = await signedIn((s) => (s.profileModel.work = { model: "gpt-6.1", provider: "openai", reasoning_effort: "medium", fast: false }));
    await makeBot(io(), "Ada", "work");
    expect(creates(server)).toEqual([{ name: "ada", provider: "openai", model: "gpt-6.1" }]);
  });

  it("adds -2 to an id another profile has or Hermes keeps for itself", async () => {
    const { server, io } = await signedIn();
    expect((await makeBot(io(), "Work", "default")).profile).toBe("work-2");
    expect((await makeBot(io(), "Test", "default")).profile).toBe("test-2");
    expect((await makeBot(io(), "Work", "default")).profile).toBe("work-3");
    expect(creates(server).map((b) => b?.name)).toEqual(["work-2", "test-2", "work-3"]);
  });

  it("reads model_error from Hermes's 200: the bot is made, and Hermes's words say why the model wasn't set", async () => {
    const { server, io } = await signedIn((s) => {
      s.profileModel.work = { model: "x/y", provider: "custom", reasoning_effort: "", fast: false };
      s.profileModelError = "Unknown provider 'custom'.";
    });
    expect(await makeBot(io(), "Ada", "work")).toEqual({ profile: "ada", modelError: "Unknown provider 'custom'." });
    expect("ada" in server.otherProfiles).toBe(true);
    expect(titleOf(server, "ada")).toBe("Ada");
  });

  it("writes the typed name as the bot's name in Bot Mode, after the create", async () => {
    const { server, io } = await signedIn();
    await makeBot(io(), "Travel Buddy", "default");
    expect(titleOf(server, "travel-buddy")).toBe("Travel Buddy");
    expect(configures(server)).toEqual(["travel-buddy"]);
  });

  it("writes no name on a Hermes without Bot Mode", async () => {
    const { server, io } = await signedIn();
    await makeBot(io(false), "Travel Buddy", "default");
    expect(configures(server)).toEqual([]);
    expect(creates(server)).toEqual([{ name: "travel-buddy" }]);
  });

  it("rejects with the create's failure and writes nothing more when Hermes refuses the create", async () => {
    const { server, io } = await signedIn((s) => (s.profileCreateError = "Disk full"));
    await expect(makeBot(io(), "Ada", "default")).rejects.toBeInstanceOf(ProfileError);
    expect(configures(server)).toEqual([]);
  });
});

describe("newBotInventory", () => {
  const bot = (profile: string, name: string): Bot => ({ profile, name, handle: profile, description: `${name} bot`, isDefault: false, hasAvatar: false, hidden: false, pinned: false, block: {} as Bot["block"], botChat: null, lastActive: 0 });
  const skill = (name: string, enabled = true) => ({ name, description: "", enabled, source: "bundled", scope: "profile" as const });
  const toolset = (name: string, enabled = true) => ({ name, enabled }) as unknown as Awaited<ReturnType<InventoryIo["toolsets"]>>["toolsets"][number];
  const io: InventoryIo = {
    models: async () => ({ profile: "ada", source: "server", providers: [{ slug: "openai", name: "OpenAI", models: [{ provider: "openai", providerName: "OpenAI", model: "gpt-6.1" }, { provider: "openai", providerName: "OpenAI", model: "gpt-6.1" }] }] }) as never,
    skills: async (p) => {
      if (p === "broken") throw new Error("down");
      return p === "ada" ? [skill("arxiv"), skill("recipes", false)] : [skill("notes"), skill("recipes", false)];
    },
    toolsets: async (p) => ({ profile: p, readAt: 0, toolsets: p === "ada" ? [toolset("web"), toolset("terminal", false)] : [toolset("web", false), toolset("kanban")] }),
  };

  it("offers the bot's own skills and toolsets, the models its profile lists, and what other bots have on, with no MCP", async () => {
    const inv = await newBotInventory(io, "ada", [bot("ada", "Ada"), bot("scribe", "Scribe")]);
    expect(inv).toEqual({
      models: ["gpt-6.1"],
      skills: ["arxiv", "recipes"],
      toolsets: ["web", "terminal"],
      bots: [{ name: "Scribe", description: "Scribe bot", skills: ["notes"], toolsetsOn: ["kanban"] }],
    });
    expect("mcpCatalog" in inv).toBe(false);
  });

  it("leaves a list Hermes didn't answer empty instead of holding the interview back", async () => {
    const inv = await newBotInventory({ ...io, models: () => Promise.reject(new Error("no")) }, "ada", [bot("broken", "Broken")]);
    expect(inv.models).toEqual([]);
    expect(inv.bots).toEqual([{ name: "Broken", description: "Broken bot", skills: [], toolsetsOn: ["kanban"] }]);
  });
});
