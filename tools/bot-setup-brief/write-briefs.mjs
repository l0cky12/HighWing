// Writes the briefs that tools/bot-setup-brief/run.py sends to the model, built by src/hermes/botSetupBrief.ts itself,
// for "Travel Buddy" on a server like the owner's. Node strips the module's types, so this runs with no build step:
//     node tools/bot-setup-brief/write-briefs.mjs <out dir>
// new-mcp.txt offers MCP servers (from PR 9 on), new.txt offers none (what New bot sends until then), again.txt is Set
// up again on the bot the interview made.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { botSetupBrief } from "../../src/hermes/botSetupBrief.ts";

const bots = [
  { name: "Research Assistant", description: "Finds and summarises papers.", skills: ["deep-research", "arxiv", "pdf-tools"], toolsetsOn: ["web", "browser", "file"], mcp: ["brave-search"] },
  { name: "Writer", description: "Drafts newsletters.", skills: ["google-workspace"], toolsetsOn: ["file"], mcp: ["notion"] },
];
const inventory = {
  models: ["gpt-6.1-sol", "gpt-6.1-mini", "claude-sonnet-4.5"],
  skills: ["find-nearby", "google-workspace", "deep-research", "pdf-tools", "arxiv", "weather", "calendar-planner"],
  toolsets: ["web", "browser", "terminal", "file", "code_execution", "vision", "image_gen", "memory", "session_search", "clarify", "delegation", "cronjob", "kanban", "todo"],
  bots,
};
const mcpCatalog = ["airbnb", "brave-search", "google-maps", "notion", "github", "slack", "linear"];
const current = {
  persona:
    "You are Travel Buddy, a travel planning assistant. Help plan European train and flight journeys, hotels, day plans and packing lists. Never book or pay for anything. Always check with the owner before emailing anyone.",
  description: "Plans European trips, stays, day plans and packing lists.",
  model: null,
  color: "teal",
  skillsOn: ["find-nearby", "deep-research"],
  toolsetsOn: ["web"],
};

const out = process.argv[2];
if (!out) throw new Error("usage: node tools/bot-setup-brief/write-briefs.mjs <out dir>");
mkdirSync(out, { recursive: true });
const write = (file, input) => writeFileSync(join(out, file), botSetupBrief({ id: "3f2c9a10", name: "Travel Buddy", ...input }));
write("new-mcp.txt", { inventory: { ...inventory, mcpCatalog } });
write("new.txt", { inventory });
write("again.txt", { inventory, current });
