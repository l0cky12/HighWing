import { expect, it } from "vitest";
import { BOT_SETUP_FENCE, botSetupBrief, type BotSetupNewBlock } from "../../src/hermes/botSetupBrief";
import { botSetupBegin } from "../../src/hermes/botSetupStart";
import { BOT_CHAT_TITLE } from "../../src/hermes/bots";
import { row, type FakeHermes, type TranscriptMessage } from "../../src/hermes/fakeHermes";
import { APPEARANCE_KEY } from "../../src/ui/appearance";
import { boot, shot } from "../harness";

const ID = "c0ffee00-0000-4000-8000-000000000009";
const KEY = "bsk-fresh-4417";
const BLOCK: BotSetupNewBlock = {
  v: 1,
  persona: "You are Hermes, a practical travel planner. Never book, buy or pay for anything.",
  description: "Plans trips: trains, places to stay and day plans.",
  model: null,
  color: "teal",
  callOwner: null,
  skills: [],
  toolsets: [],
  mcp: [{ catalog: "airbnb" }, { catalog: "github" }],
  copy: [{ from: "Research Assistant", skills: [], toolsets: [], mcp: ["brave-search"] }],
};
const card = `Thanks. Here's how I'd set myself up. Untick anything you don't want, or tell me what to change.\n\n\`\`\`${BOT_SETUP_FENCE}\n${JSON.stringify(BLOCK)}\n\`\`\``;

const seed = (s: FakeHermes) => {
  s.health = { ...s.health, version: "0.23.2", displayVersion: "0.23.2" };
  s.status = { ...s.status, version: "0.23.2" };
  s.sessions = [row("hermes-bot", 0.01, { title: BOT_CHAT_TITLE, hidden: true })];
  s.transcripts = {
    "hermes-bot": (
      [
        { role: "user", text: botSetupBrief({ id: ID, name: "Hermes", inventory: { models: [], skills: [], toolsets: [], mcpCatalog: ["airbnb", "github"], bots: [] } }), display_kind: "hidden" },
        { role: "user", text: botSetupBegin(ID), display_kind: "hidden" },
        { role: "assistant", text: "Hi, I'm Hermes.\n\n**Which apps or services should I work with?**" },
        { role: "user", text: "Airbnb, GitHub, and the web search Research Assistant uses." },
        { role: "assistant", text: card },
      ] satisfies TranscriptMessage[]
    ).map((m, i) => ({ ...m, row_id: i + 1 })),
  };
  s.souls.default = "You are Hermes.";
  s.profileModel.default = { model: "claude-sonnet-4-5", provider: "anthropic", reasoning_effort: "medium", fast: false };
  s.profileMeta = {
    default: { description: "Helps with anything.", ui_meta: { "hermes-bots": { title: "Hermes" } } },
    research: { description: "Finds sources.", ui_meta: { "hermes-bots": { title: "Research Assistant" } } },
  };
  s.uiMetaRevisions.default = { "hermes-bots": 1 };
  s.otherProfiles = { research: [] };
  s.skills.profiles.add("research");
  s.mcp.servers.research = { "brave-search": { command: "npx", args: ["-y", "@brave/brave-search-mcp-server"], env: { BRAVE_API_KEY: "bsk-source-0001" } } };
  s.mcp.catalogEntries = [
    { name: "airbnb", description: "Search stays", transport: "stdio", command: "npx", args: ["-y", "@openbnb/mcp-server-airbnb"] },
    { name: "github", description: "Repositories and issues", transport: "http", url: "https://api.githubcopilot.com/mcp/", auth_type: "oauth" },
  ];
  s.liveSessions = [{ id: "rt-elsewhere", session_key: "elsewhere", status: "working", last_active: Math.floor(Date.now() / 1000) }];
};

async function connectAndSetUp(scheme: "dark" | "light") {
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ scheme }));
  const { app, server } = await boot({ seed });
  const panel = app.getByRole("complementary");
  await panel.getByRole("tab", { name: /^Bots/ }).click();
  await panel.getByRole("button", { name: /^Hermes\b/ }).first().click();
  const mcp = app.getByRole("region", { name: "MCP servers" });
  await expect.element(mcp).toBeVisible();
  await expect.element(mcp.getByText("npx -y @openbnb/mcp-server-airbnb")).toBeVisible();
  await expect.element(mcp.getByText("It signs in with OAuth, so the card can't add it. Add it in Settings → MCP servers.")).toBeVisible();
  await expect.element(mcp.getByRole("checkbox", { name: "github" })).toBeDisabled();

  await mcp.getByRole("button", { name: "Connect", exact: true }).click();
  const fields = app.getByRole("group", { name: "Connect brave-search" });
  await fields.getByLabelText("BRAVE_API_KEY").fill(KEY);
  mcp.element().scrollIntoView({ block: "center" });
  await shot(`${scheme}-connect`);
  await fields.getByRole("button", { name: "Connect", exact: true }).click();
  await expect.element(mcp.getByText("Ready. Highwing sends it to Hermes when you press Set it up.")).toBeVisible();
  expect(server.mcp.writes).toEqual([]);
  expect(JSON.stringify(server.requests)).not.toContain(KEY);

  await app.getByRole("button", { name: "Set it up", exact: true }).click();
  const reload = mcp.getByRole("button", { name: "Reload MCP servers" }).first();
  await expect.element(reload).toBeVisible();
  expect(server.mcp.writes.map((w) => w.what)).toEqual(["install airbnb", "add brave-search"]);
  expect(server.mcp.servers.default["brave-search"]?.env).toEqual({ BRAVE_API_KEY: KEY });
  expect(server.requests.filter((r) => r.method === "reload.mcp")).toEqual([]);
  mcp.element().scrollIntoView({ block: "center" });
  await shot(`${scheme}-waiting-reload`);

  await expect.element(reload).toBeDisabled();
  const ready = server.requests.find((r) => r.method === "prompt.submit" && String(r.params.text).startsWith("[highwing:bot-setup ready"));
  const sid = String(ready!.params.session_id);
  server.event(sid, "message.start");
  server.event(sid, "message.delta", { text: "I'm set up. Ask me to plan a trip whenever you like." });
  server.storeMessage("hermes-bot", { role: "assistant", text: "I'm set up. Ask me to plan a trip whenever you like." });
  server.event(sid, "message.complete", { status: "complete" });
  await expect.element(reload).toBeEnabled();
  await reload.click();
  await expect.element(mcp.getByText("Not reloaded yet: a reply is running in a chat on this Hermes, and reloading would cut its MCP servers off. Try again once it's done.").first()).toBeVisible();
  expect(server.requests.filter((r) => r.method === "reload.mcp")).toEqual([]);
  mcp.element().scrollIntoView({ block: "center" });
  await shot(`${scheme}-reload-replying`);

  server.liveSessions = [];
  await reload.click();
  await expect.poll(() => mcp.getByText("Added, and Hermes reloaded it.").elements().length).toBe(2);
  expect(server.requests.filter((r) => r.method === "reload.mcp").map((r) => r.params.confirm)).toEqual([true]);
  mcp.element().scrollIntoView({ block: "center" });
  await shot(`${scheme}-reloaded`);
}

it("shows MCP servers with Connect, adds them at Set it up, and waits on Reload MCP servers while a reply runs, in the dark theme", () => connectAndSetUp("dark"));
it("does the same in the light theme", () => connectAndSetUp("light"));
