// @vitest-environment jsdom
// Set it up on Bot setup's card through the real transport against FakeHermes as Hermes 0.23.2 (ADR 0231, "Set it
// up"): what goes to Hermes and in what order, each write read back, nothing sent after a lost answer, a change made
// elsewhere kept, the hidden ready turn, and the card after a reload. What the card offers is botSetupCard.test.ts's.
import { afterEach, describe, expect, it, vi } from "vitest";
import { botSetupReady } from "./botSetupApply";
import { BOT_SETUP_FENCE, botSetupBrief, type BotSetupNewBlock } from "./botSetupBrief";
import { ACCEPTED_FENCE, choose, fencedBlocks, planCard, tickable, tickedCount, type ListedItem, type Plan } from "./botSetupCard";
import { SETUP_RECORD_PREFIX, localChatCache } from "./chatCache";
import { FakeHermes, row, type RestRequest } from "./fakeHermes";
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
