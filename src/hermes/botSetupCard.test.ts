// Bot setup's review card as data (botSetupCard.ts, ADR 0231): which block is the live card, what it would change in
// Hermes, and what survives Set it up and a reload. Rows are shaped as Hermes stores them. All data is synthetic.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BOT_SETUP_CAPS, BOT_SETUP_COLORS, BOT_SETUP_FENCE, botSetupBrief, type BotSetupAgainBlock, type BotSetupNewBlock } from "./botSetupBrief";
import {
  ACCEPTED_FENCE,
  BOT_SETUP_COLOR_HEX,
  acceptedRecord,
  acceptedRecordBlock,
  choose,
  fencedBlocks,
  parseSetup,
  planCard,
  previewWithoutSetup,
  readAcceptedRecord,
  readBlock,
  tickable,
  tickedCount,
  type AcceptedRecord,
  type Card,
  type HermesNow,
  type ListedItem,
  type Plan,
  type PlanItem,
  type SetupRow,
} from "./botSetupCard";
import { lookOf } from "./bots";

const block = (over: Partial<BotSetupNewBlock> = {}): BotSetupNewBlock => ({
  v: 1,
  persona: "You are Travel Buddy. You plan trips. Never book or pay for anything. Check before you email anyone.",
  description: "Plans trips: flights, trains, places to stay.",
  model: null,
  color: "teal",
  picture: null,
  callOwner: "Liam",
  skills: [{ name: "find-nearby", on: true }],
  toolsets: [{ name: "browser", on: true }],
  mcp: [{ catalog: "airbnb" }],
  copy: [{ from: "Research Assistant", skills: ["deep-research"], toolsets: ["web"], mcp: ["brave-search"] }],
  ...over,
});

const now = (over: Partial<HermesNow> = {}): HermesNow => ({
  persona: "",
  description: "",
  model: "claude-sonnet-4.5",
  color: null,
  picture: null,
  memory: [],
  skills: [
    { name: "find-nearby", enabled: false },
    { name: "weather", enabled: true },
  ],
  toolsets: [
    { name: "browser", enabled: false },
    { name: "web", enabled: false },
    { name: "terminal", enabled: true },
  ],
  models: ["claude-sonnet-4.5", "gpt-6.1-sol"],
  mcp: { catalog: ["airbnb", "github"], servers: [] },
  bots: [{ name: "Research Assistant", skills: ["deep-research"], toolsetsOn: ["web"], mcp: ["brave-search"] }],
  ...over,
});

const inventory = { models: [], skills: [], toolsets: [], bots: [] };
const brief = (id: string): SetupRow => ({ role: "user", display_kind: "hidden", content: botSetupBrief({ id, name: "Travel Buddy", inventory }) });
const briefAgain = (id: string, persona: string): SetupRow => ({
  role: "user",
  display_kind: "hidden",
  content: botSetupBrief({ id, name: "Travel Buddy", inventory, current: { persona, description: "Plans trips.", model: null, color: "#14b8a6", picture: null, skillsOn: [], toolsetsOn: [] } }),
});
const keeping = (over: Partial<BotSetupAgainBlock> = {}): BotSetupAgainBlock => ({ ...block(), persona: null, description: null, color: null, ...over });
const fenced = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;
const reply = (id: number, body: string, words = "Here's how I'd set myself up."): SetupRow => ({ id, role: "assistant", content: `${words}\n\n${fenced(BOT_SETUP_FENCE, body)}` });
const said = (id: number, role: "user" | "assistant", content: string): SetupRow => ({ id, role, content });

/** The card of rows that must hold one. */
const cardOf = (rows: SetupRow[]) => {
  const r = parseSetup(rows);
  if (r.kind !== "card") throw new Error(`no card: ${JSON.stringify(r)}`);
  return r;
};
const item = (plan: Plan, key: string): PlanItem => {
  const found = plan.items.find((i) => i.key === key);
  if (!found) throw new Error(`no item ${key} in ${plan.items.map((i) => i.key).join(", ")}`);
  return found;
};
const listedItem = (plan: Plan, key: string): ListedItem => {
  const i = item(plan, key);
  if (i.status === "notFound" || i.status === "unavailable") throw new Error(`${key} is ${i.status}`);
  return i;
};
/** The card's plan once the owner made `changes` on the card as shown, each keyed by its item. */
const onCard = (card: Card, h: HermesNow, changes: Record<string, { ticked?: boolean; to?: string | null }>, accepted: AcceptedRecord | null = null): Plan => {
  const shown = planCard(card, h, accepted);
  return planCard(card, h, accepted, Object.entries(changes).map(([key, change]) => choose(listedItem(shown, key), change)));
};

/** Hermes after Set it up wrote every ticked item of `plan` with the accepted values. */
function applied(before: HermesNow, plan: Plan, record = acceptedRecord(plan)): HermesNow {
  const memory = [...before.memory];
  const servers = [...(before.mcp?.servers ?? [])];
  const h: HermesNow = { ...before, memory, mcp: before.mcp && { ...before.mcp, servers } };
  for (const a of record.items) {
    if (!a.ticked) continue;
    const name = a.key.slice(a.key.indexOf(":") + 1);
    if (a.kind === "persona") h.persona = a.to;
    if (a.kind === "description") h.description = a.to;
    if (a.kind === "model") h.model = a.to;
    if (a.kind === "color") h.color = a.to;
    if (a.kind === "remember" && a.to) memory.push(`The owner's name is ${a.to}.`);
    if (a.kind === "skill") h.skills = [...h.skills.filter((s) => s.name !== name), { name, enabled: a.to === "on" }];
    if (a.kind === "toolset") h.toolsets = h.toolsets.map((t) => (t.name === name ? { ...t, enabled: a.to === "on" } : t));
    if (a.kind === "mcp") servers.push(name);
  }
  return h;
}

describe("finding the live card", () => {
  it("is the newest block that parses after the newest brief marker", () => {
    const rows = [brief("s1"), said(2, "assistant", "What should I call you?"), said(3, "user", "Liam"), reply(4, JSON.stringify(block())), said(5, "user", "Make it blue."), reply(6, JSON.stringify(block({ color: "blue" })))];
    const r = cardOf(rows);
    expect(r.card.setupId).toBe("s1");
    expect(r.card.at).toEqual({ index: 5, rowId: 6, nth: 0 });
    expect(r.card.block.color).toBe("blue");
    expect(r.newerUnreadable).toBeUndefined();
    expect(r.accepted).toBeNull();
  });

  it("ignores a block before the newest marker: it belongs to an earlier setup", () => {
    const rows = [brief("old"), reply(2, JSON.stringify(block({ color: "red" }))), brief("new"), said(4, "assistant", "What should I call you?")];
    expect(parseSetup(rows)).toEqual({ kind: "none", setupId: "new" });
    const later = cardOf([...rows, reply(5, JSON.stringify(block({ color: "pink" })))]);
    expect(later.card.setupId).toBe("new");
    expect(later.card.block.color).toBe("pink");
  });

  it("finds no setup without a marker, and none in the owner's own words or the bot's", () => {
    expect(parseSetup([])).toEqual({ kind: "none", setupId: null });
    expect(parseSetup([reply(1, JSON.stringify(block()))])).toEqual({ kind: "none", setupId: null });
    const marker = (brief("x").content as string).split("\n")[0];
    expect(parseSetup([said(1, "assistant", marker), reply(2, JSON.stringify(block()))]).kind).toBe("none");
  });

  // #85: "The newest valid setup block after the newest brief marker shows as the card." A redraw that doesn't parse
  // doesn't take the card away; it is returned beside it, for the "draw it again" button.
  it("keeps the newest valid block live when a newer one doesn't parse, and reports the newer one", () => {
    const rows = [brief("s1"), reply(2, JSON.stringify(block())), said(3, "user", "Make it blue."), reply(4, '{"v": 1, "persona": ')];
    const r = cardOf(rows);
    expect(r.card.at.rowId).toBe(2);
    expect(r.newerUnreadable).toMatchObject({ at: { index: 3, rowId: 4, nth: 0 }, source: '{"v": 1, "persona": ', reason: "not JSON" });
    // A valid block after the unreadable one clears it.
    expect(cardOf([...rows, reply(5, JSON.stringify(block({ color: "blue" })))]).newerUnreadable).toBeUndefined();
  });

  it("is unreadable when no block after the marker parses", () => {
    const r = parseSetup([brief("s1"), reply(2, "not json"), reply(3, JSON.stringify({ ...block(), v: 2 }))]);
    expect(r).toMatchObject({ kind: "unreadable", setupId: "s1", at: { index: 2, rowId: 3 }, reason: "v: not 1" });
  });

  it("reads only blocks with the setup fence, and only in the bot's rows", () => {
    const body = JSON.stringify(block());
    expect(parseSetup([brief("s1"), said(2, "assistant", fenced("json", body))])).toEqual({ kind: "none", setupId: "s1" });
    expect(parseSetup([brief("s1"), said(2, "user", fenced(BOT_SETUP_FENCE, body))])).toEqual({ kind: "none", setupId: "s1" });
    expect(cardOf([brief("s1"), said(2, "assistant", `Here it is.\n\`\`\`${BOT_SETUP_FENCE}\n${body}`)]).card.block).toEqual(block());
  });

  it("gives an identical redraw the same card id, and a changed one a new id", () => {
    const a = cardOf([brief("s1"), reply(2, JSON.stringify(block()))]).card.id;
    const spaced = JSON.stringify(block(), null, 2);
    expect(cardOf([brief("s1"), reply(7, spaced)]).card.id).toBe(a);
    expect(cardOf([brief("s1"), reply(2, JSON.stringify(block({ color: "blue" })))]).card.id).not.toBe(a);
    expect(cardOf([brief("s2"), reply(2, JSON.stringify(block()))]).card.id).not.toBe(a);
  });
});

describe("fenced blocks", () => {
  it("takes the fence's language from its info string and reads ~~~ fences too", () => {
    expect(fencedBlocks("a\n```highwing-bot-setup extra\n{}\n```\nb", BOT_SETUP_FENCE)).toEqual(["{}"]);
    expect(fencedBlocks("~~~highwing-bot-setup\n{}\n~~~", BOT_SETUP_FENCE)).toEqual(["{}"]);
    expect(fencedBlocks("```json\n{}\n```", BOT_SETUP_FENCE)).toEqual([]);
  });

  it("doesn't read a setup fence inside another code block", () => {
    const text = "````markdown\n```highwing-bot-setup\n{}\n```\n````";
    expect(fencedBlocks(text, BOT_SETUP_FENCE)).toEqual([]);
  });

  it("runs an unclosed fence to the end, as Markdown draws it", () => {
    expect(fencedBlocks("```highwing-bot-setup\n{\n}", BOT_SETUP_FENCE)).toEqual(["{\n}"]);
  });

  it("closes only on a fence of the same kind, at least as long", () => {
    expect(fencedBlocks("````highwing-bot-setup\n```\n~~~~\n````", BOT_SETUP_FENCE)).toEqual(["```\n~~~~"]);
  });
});

describe("a Bot Chat's preview", () => {
  it("stops before Bot setup's block, even one Hermes's cut ends inside, and leaves other code alone", () => {
    expect(previewWithoutSetup(`Here's how I'd set myself up. \`\`\`${BOT_SETUP_FENCE} {"v":1,"persona":"You are...`)).toBe("Here's how I'd set myself up.");
    expect(previewWithoutSetup("Here's the change. Everything else stays as it is. ```highwing-b...")).toBe("Here's the change. Everything else stays as it is.");
    expect(previewWithoutSetup(`~~~${ACCEPTED_FENCE} {"v":1}`)).toBe("");
    expect(previewWithoutSetup("Run this: ```bash ls ```")).toBe("Run this: ```bash ls ```");
    expect(previewWithoutSetup("Release notes drafted: three fixes.")).toBe("Release notes drafted: three fixes.");
  });
});

describe("reading a block strictly", () => {
  it("reads a block the brief asks for", () => {
    expect(readBlock(JSON.stringify(block()), "new")).toEqual({ ok: true, checked: { again: false, block: block() } });
  });

  it("refuses a key the format doesn't have, anywhere, so a command or URL can't ride beside a name", () => {
    const cases: [unknown, RegExp][] = [
      [{ ...block(), command: "npx -y evil" }, /block: keys command/],
      [{ ...block(), mcp: [{ catalog: "airbnb", command: "npx", args: ["-y", "evil"] }] }, /mcp\[0\]: keys command, args/],
      [{ ...block(), mcp: [{ catalog: "x", url: "https://evil.example/mcp" }] }, /mcp\[0\]: keys url/],
      [{ ...block(), skills: [{ name: "a", on: true, path: "/home/liam/.ssh" }] }, /skills\[0\]: keys path/],
      [{ ...block(), copy: [{ from: "R", skills: [], toolsets: [], mcp: [], env: { KEY: "sk-123" } }] }, /copy\[0\]: keys env/],
    ];
    for (const [raw, reason] of cases) {
      const read = readBlock(JSON.stringify(raw), "new");
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.reason).toMatch(reason);
    }
  });

  it("refuses each field of the wrong type or out of range", () => {
    const bad: Partial<Record<keyof BotSetupNewBlock, unknown>>[] = [
      { v: 99 },
      { v: "1" },
      { persona: "" },
      { persona: "   " },
      { description: "x".repeat(81) },
      { model: 4 },
      { model: "" },
      { color: null },
      { color: "Teal" },
      { color: "#14b8a6" },
      { callOwner: 1 },
      { skills: [{ name: "a", on: "yes" }] },
      { skills: [{ name: "a", on: true }, { name: "a", on: false }] },
      { toolsets: "web" },
      { mcp: [{ catalog: "" }] },
      { copy: [{ from: "R", skills: "deep-research", toolsets: [], mcp: [] }] },
    ];
    for (const over of bad) expect(readBlock(JSON.stringify({ ...block(), ...over }), "new"), JSON.stringify(over)).toMatchObject({ ok: false });
    const missing: Record<string, unknown> = { ...block() };
    delete missing.copy;
    expect(readBlock(JSON.stringify(missing), "new")).toEqual({ ok: false, reason: "block: keys copy" });
    expect(readBlock(JSON.stringify({ ...block(), description: "x".repeat(80) }), "new").ok).toBe(true);
  });

  it("never throws, on any junk", () => {
    // A small deterministic generator, so a failure reproduces.
    let seed = 0x2f6b;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    const atoms = ["{", "}", "[", "]", '"', ":", ",", "null", "true", "1", "-", "v", "persona", "\\u0000", "```", "\n", "highwing-bot-setup", "~~~", "__proto__", "constructor"];
    const valid = JSON.stringify(block());
    for (let i = 0; i < 2000; i++) {
      const junk = i % 3 === 0 ? valid.slice(0, rand(valid.length)) + atoms[rand(atoms.length)] + valid.slice(rand(valid.length)) : Array.from({ length: rand(40) }, () => atoms[rand(atoms.length)]).join("");
      expect(() => readBlock(junk, "new")).not.toThrow();
      expect(() => readAcceptedRecord(junk)).not.toThrow();
      expect(() => parseSetup([brief("s1"), { role: "assistant", content: `\`\`\`${BOT_SETUP_FENCE}\n${junk}` }, { role: "user", content: `\`\`\`${ACCEPTED_FENCE}\n${junk}` }])).not.toThrow();
    }
    const odd: unknown[] = [null, undefined, 5, "x", [], {}, { role: 5 }, { role: "user", content: [{ type: "image" }, null, 3] }, { role: "assistant", content: { text: "x" } }];
    expect(() => parseSetup(odd as SetupRow[])).not.toThrow();
    for (const v of ["null", "[]", '"x"', "1", '{"__proto__": {"v": 1}}']) expect(readBlock(v, "new").ok).toBe(false);
  });
});

describe("the plan", () => {
  const card = (b = block(), setupId = "s1") => cardOf([brief(setupId), reply(2, JSON.stringify(b))]).card;

  it("lists every row in the card's order, with Hermes's value before and the block's after", () => {
    const plan = planCard(card(), now());
    expect(plan.items.map((i) => `${i.key} ${i.status}`)).toEqual([
      "persona change",
      "description change",
      "model same",
      "color change",
      "picture same",
      "remember change",
      "skill:find-nearby change",
      "skill:deep-research change",
      "toolset:browser change",
      "toolset:web change",
      "mcp:airbnb change",
      "mcp:brave-search change",
    ]);
    expect(listedItem(plan, "skill:deep-research")).toMatchObject({ before: "absent", after: "on", from: "Research Assistant", status: "change", ticked: true });
    expect(listedItem(plan, "toolset:web")).toMatchObject({ before: "off", after: "on", from: "Research Assistant" });
    expect(listedItem(plan, "mcp:brave-search")).toMatchObject({ before: "absent", after: "added", from: "Research Assistant" });
    expect(listedItem(plan, "remember")).toMatchObject({ before: null, after: "Liam" });
  });

  it("keeps description and model as separate items", () => {
    const plan = planCard(card(block({ model: "gpt-6.1-sol" })), now());
    expect(listedItem(plan, "description")).toMatchObject({ kind: "description", status: "change" });
    expect(listedItem(plan, "model")).toMatchObject({ kind: "model", before: "claude-sonnet-4.5", after: "gpt-6.1-sol", status: "change", ticked: true });
  });

  // Owner call 6: on a new bot the model row is greyed "Already in use" and not counted, unless the bot proposes another.
  it("shows the model already in use as a row that isn't counted, unless the block proposes another model", () => {
    const keep = planCard(card(), now());
    expect(listedItem(keep, "model")).toEqual({ kind: "model", key: "model", name: "claude-sonnet-4.5", proposed: "claude-sonnet-4.5", before: "claude-sonnet-4.5", after: "claude-sonnet-4.5", over: [], status: "same", ticked: true });
    expect(tickable(item(keep, "model"))).toBe(false);
    expect(tickedCount(keep)).toBe(10);
    const sameNamed = planCard(card(block({ model: "claude-sonnet-4.5" })), now());
    expect(listedItem(sameNamed, "model").status).toBe("same");
    expect(tickedCount(sameNamed)).toBe(10);
    const other = planCard(card(block({ model: "gpt-6.1-sol" })), now());
    expect(tickedCount(other)).toBe(11);
  });

  it("matches every name against what Hermes lists; a name it doesn't list can't be ticked", () => {
    const b = block({
      model: "gpt-9-imaginary",
      skills: [{ name: "flight-tracker", on: true }],
      toolsets: [{ name: "teleport", on: true }],
      mcp: [{ catalog: "made-up-server" }],
      copy: [
        { from: "Research Assistant", skills: ["not-theirs"], toolsets: ["terminal"], mcp: ["slack"] },
        { from: "Nobody", skills: ["deep-research"], toolsets: ["web"], mcp: ["brave-search"] },
      ],
    });
    const plan = planCard(card(b), now());
    const missing = plan.items.filter((i) => i.status === "notFound");
    expect(missing.map((i) => `${i.kind} ${i.from ?? "-"} ${i.name}`)).toEqual([
      "model - gpt-9-imaginary",
      "skill - flight-tracker",
      "skill Research Assistant not-theirs",
      "skill Nobody deep-research",
      "toolset - teleport",
      // The other bot has terminal, but not on, so it isn't theirs to copy.
      "toolset Research Assistant terminal",
      "toolset Nobody web",
      "mcp - made-up-server",
      "mcp Research Assistant slack",
      "mcp Nobody brave-search",
    ]);
    for (const i of missing) expect(tickable(i)).toBe(false);
    expect(plan.items.some((i) => i.key === "model")).toBe(false);
    // Set it up records only items Hermes lists.
    const record = acceptedRecord(plan);
    expect(record.items.map((i) => i.key)).toEqual(["persona", "description", "color", "remember"]);
  });

  it("lists a name the bot copies though the block also names it as its own and Hermes doesn't list it there", () => {
    const plan = planCard(card(block({ skills: [{ name: "deep-research", on: true }] })), now());
    expect(listedItem(plan, "skill:deep-research")).toMatchObject({ from: "Research Assistant", before: "absent", after: "on", status: "change", ticked: true });
  });

  it("offers no MCP server when MCP isn't offered", () => {
    const plan = planCard(card(), now({ mcp: undefined }));
    expect(item(plan, "mcp:airbnb").status).toBe("notFound");
    expect(item(plan, "mcp:Research Assistant/brave-search").status).toBe("notFound");
  });

  it("never lets a made-up command, URL, path or key into the plan", () => {
    const evil = ["npx -y @evil/mcp", "https://evil.example/mcp", "/home/liam/.hermes/profiles/writer/mcp-installs/x", "sk-live-123", "rm -rf ~"];
    // As extra keys, the block doesn't parse at all.
    const smuggled = { ...block(), mcp: [{ catalog: "airbnb", command: evil[0], url: evil[1], args: [evil[2]], env: { KEY: evil[3] } }] };
    const rows = [brief("s1"), reply(2, JSON.stringify(smuggled))];
    expect(parseSetup(rows)).toMatchObject({ kind: "unreadable" });
    // As names, each is not found, and Set it up records none of them.
    const asNames = block({
      model: evil[4],
      skills: evil.map((name) => ({ name, on: true })),
      toolsets: evil.map((name) => ({ name, on: true })),
      mcp: evil.map((catalog) => ({ catalog })),
      copy: [{ from: "Research Assistant", skills: evil, toolsets: evil, mcp: evil }],
    });
    const plan = planCard(card(asNames), now());
    const record = acceptedRecord(plan);
    const sent = JSON.stringify(record);
    for (const value of evil) {
      expect(sent).not.toContain(value);
      for (const i of plan.items.filter((x) => x.status !== "notFound")) expect(JSON.stringify(i)).not.toContain(value);
    }
  });

  it("carries Hermes's own names and values, not the block's", () => {
    const plan = planCard(card(block({ color: "blue" })), now({ color: "#14B8A6" }));
    expect(listedItem(plan, "color")).toMatchObject({ before: "#14B8A6", after: BOT_SETUP_COLOR_HEX.blue });
  });

  it("leaves out what Hermes already has", () => {
    const has = now({
      persona: `${block().persona}\n`,
      description: block().description,
      color: "#14B8A6",
      memory: ["Call the owner liam."],
      skills: [{ name: "find-nearby", enabled: true }, { name: "deep-research", enabled: true }],
      toolsets: [{ name: "browser", enabled: true }, { name: "web", enabled: true }],
      mcp: { catalog: ["airbnb"], servers: ["airbnb", "brave-search"] },
    });
    const plan = planCard(card(), has);
    expect(plan.items.filter((i) => i.status !== "same")).toEqual([]);
    expect(tickedCount(plan)).toBe(0);
  });

  it("turns a skill or toolset off when the block says so", () => {
    const plan = planCard(card(block({ skills: [{ name: "weather", on: false }], toolsets: [{ name: "terminal", on: false }], copy: [] })), now());
    expect(listedItem(plan, "skill:weather")).toMatchObject({ before: "on", after: "off", status: "change" });
    expect(listedItem(plan, "toolset:terminal")).toMatchObject({ before: "on", after: "off", status: "change" });
  });

  it("leaves out the Remember row when the block has no name for the owner", () => {
    expect(planCard(card(block({ callOwner: null })), now()).items.some((i) => i.kind === "remember")).toBe(false);
  });
});

describe("Set up again", () => {
  const has = now({ persona: "You are Travel Buddy. Never book anything.", description: "Plans trips.", color: "#3B82F6" });

  it("plans no write for a null persona, description or colour: each row shows the value Hermes keeps", () => {
    const r = cardOf([briefAgain("s1", has.persona), reply(2, JSON.stringify(keeping()))]);
    expect(r.card).toMatchObject({ again: true, block: { persona: null, description: null, color: null } });
    const plan = planCard(r.card, has);
    expect(listedItem(plan, "persona")).toMatchObject({ before: has.persona, after: has.persona, status: "same" });
    expect(listedItem(plan, "description")).toMatchObject({ before: "Plans trips.", after: "Plans trips.", status: "same" });
    expect(listedItem(plan, "color")).toMatchObject({ before: "#3B82F6", after: "#3B82F6", status: "same" });
    const record = acceptedRecord(plan);
    expect(record.items.filter((i) => ["persona", "description", "color"].includes(i.kind))).toEqual([]);
  });

  it("writes a persona, description or colour the block does change", () => {
    const b = keeping({ persona: "You are Travel Buddy. Never book anything. Check prices daily.", color: "pink" });
    const plan = planCard(cardOf([briefAgain("s1", has.persona), reply(2, JSON.stringify(b))]).card, has);
    expect(listedItem(plan, "persona")).toMatchObject({ after: b.persona, status: "change", ticked: true });
    expect(listedItem(plan, "color")).toMatchObject({ after: BOT_SETUP_COLOR_HEX.pink, status: "change", ticked: true });
    expect(listedItem(plan, "description").status).toBe("same");
  });

  it("keeps a choice on an item the newer block leaves as Hermes has it, though Hermes changed it", () => {
    const rows = [briefAgain("s1", has.persona), reply(2, JSON.stringify(keeping()))];
    const { card } = cardOf(rows);
    const redrawn = cardOf([...rows, reply(3, JSON.stringify(keeping({ callOwner: "Lee" })))]).card;
    for (const [key, to, theirs] of [["persona", "You are B.", "You are C."], ["description", "Books trains.", "Plans cruises."], ["color", "#ec4899", "#22c55e"]] as const) {
      const pending = [choose(listedItem(planCard(card, has), key), { to })];
      const moved = { ...has, [key]: theirs };
      expect(listedItem(planCard(redrawn, moved, null, pending), key), key).toMatchObject({ status: "change", ticked: true, before: theirs, after: to });
      const record = acceptedRecord(planCard(card, has, null, pending));
      const later = planCard(redrawn, moved, record);
      expect(listedItem(later, key), key).toMatchObject({ status: "elsewhere", ticked: false, after: to });
      expect(acceptedRecord(later, record).items.find((i) => i.key === key), key).toMatchObject({ to });
    }
  });

  it("lists what the bot has on and the block leaves alone, with nothing to do; a new bot's card lists only what its block names", () => {
    const b = keeping({ skills: [{ name: "find-nearby", on: true }], toolsets: [{ name: "browser", on: true }], copy: [] });
    const plan = planCard(cardOf([briefAgain("s1", has.persona), reply(2, JSON.stringify(b))]).card, has);
    expect(plan.items.filter((i) => i.kind === "skill" || i.kind === "toolset").map((i) => [i.key, i.status])).toEqual([
      ["skill:find-nearby", "change"],
      ["toolset:browser", "change"],
      ["skill:weather", "same"],
      ["toolset:terminal", "same"],
    ]);
    expect(acceptedRecord(plan).items.map((i) => i.key).filter((k) => /^(skill|toolset):/.test(k))).toEqual(["skill:find-nearby", "toolset:browser"]);
    const fresh = planCard(cardOf([brief("s2"), reply(2, JSON.stringify(block({ toolsets: [], copy: [] })))]).card, has);
    expect(fresh.items.filter((i) => i.kind === "skill" || i.kind === "toolset").map((i) => i.key)).toEqual(["skill:find-nearby"]);
  });

  it("refuses a persona when the brief left the persona out", () => {
    const long = `You are Travel Buddy. ${"Rule. ".repeat(BOT_SETUP_CAPS.persona / 6)}`;
    const rows = [briefAgain("s1", long), reply(2, JSON.stringify(keeping({ persona: "You are Travel Buddy." })))];
    expect(parseSetup(rows)).toMatchObject({ kind: "unreadable", reason: "persona: not null, though the brief left it out" });
    expect(cardOf([...rows, reply(3, JSON.stringify(keeping()))]).card.block.persona).toBeNull();
  });

  it("reads a block that changes everything as Set up again's", () => {
    expect(cardOf([briefAgain("s1", has.persona), reply(2, JSON.stringify(block()))]).card).toMatchObject({ again: true, block: block() });
  });

  it("refuses a block that keeps a value when the brief was a new bot's", () => {
    for (const over of [{ persona: null }, { description: null }, { color: null }]) {
      const rows = [brief("s1"), reply(2, JSON.stringify({ ...block(), ...over }))];
      expect(parseSetup(rows), JSON.stringify(over)).toMatchObject({ kind: "unreadable", reason: "a new bot's block keeps nothing: persona, description and color can't be null" });
    }
  });
});

describe("colours", () => {
  it("maps every block colour to a hex colour Bot Mode stores and the roster shows", () => {
    expect(Object.keys(BOT_SETUP_COLOR_HEX).sort()).toEqual([...BOT_SETUP_COLORS].sort());
    const hexes = Object.values(BOT_SETUP_COLOR_HEX);
    expect(new Set(hexes).size).toBe(hexes.length);
    for (const hex of hexes) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
      // As lookOf reads it back from ui_meta, so the item reads applied after Set it up writes it.
      expect(lookOf({ ui_meta: { "hermes-bots": { color: hex } } }).color).toBe(hex);
    }
    expect(BOT_SETUP_COLOR_HEX.teal).toBe("#14b8a6");
  });
});

describe("the picture", () => {
  const card = (b: BotSetupNewBlock | BotSetupAgainBlock = block(), again = false) =>
    cardOf([again ? briefAgain("s1", "You are Travel Buddy.") : brief("s1"), reply(2, JSON.stringify(b))]).card;

  it("offers the set's picture the block names, ticked, by its key and never its bytes", () => {
    const plan = planCard(card(block({ picture: "plane" })), now());
    expect(listedItem(plan, "picture")).toMatchObject({ kind: "picture", name: "plane", before: null, proposed: "set:plane", after: "set:plane", status: "change", ticked: true });
    expect(tickedCount(plan)).toBe(tickedCount(planCard(card(), now())) + 1);
    expect(acceptedRecord(plan).items.find((i) => i.kind === "picture")).toMatchObject({ from: null, to: "set:plane", ticked: true });
  });

  it("shows a name the set doesn't have as not found, never ticked: a URL, a data URL, a path or another name", () => {
    for (const picture of ["https://example.com/face.png", "data:image/png;base64,iVBORw0KGgo=", "/home/owner/face.png", "Plane", "dragon"]) {
      const plan = planCard(card(block({ picture })), now());
      const i = item(plan, "picture:" + picture);
      expect(i).toMatchObject({ kind: "picture", name: picture, status: "notFound" });
      expect(tickable(i)).toBe(false);
      expect(acceptedRecord(plan).items.some((a) => a.kind === "picture")).toBe(false);
    }
  });

  it("refuses a picture that isn't a name, so no image data or object rides in the block", () => {
    for (const picture of [{ url: "https://example.com/face.png" }, ["plane"], 5, ""]) expect(readBlock(JSON.stringify({ ...block(), picture }), "new").ok).toBe(false);
  });

  it("reads a block drawn before the picture was added as keeping the picture", () => {
    const { picture: _, ...old } = block({ picture: "plane" });
    const read = readBlock(JSON.stringify(old), "new");
    expect(read.ok && read.checked.block.picture).toBeNull();
    const plan = planCard(card({ ...old, picture: null }), now({ picture: "set:moon" }));
    expect(listedItem(plan, "picture")).toMatchObject({ before: "set:moon", after: "set:moon", status: "same", ticked: true });
    expect(tickable(item(plan, "picture"))).toBe(false);
  });

  it("is unavailable, with why, where Hermes can't save a picture, and the other items still apply", () => {
    const off = { kind: "noCheck" } as const;
    const plan = planCard(card(block({ picture: "plane" })), now({ pictureOff: off }));
    expect(item(plan, "picture")).toEqual({ kind: "picture", key: "picture", name: "plane", status: "unavailable", off });
    expect(tickable(item(plan, "picture"))).toBe(false);
    expect(acceptedRecord(plan).items.some((a) => a.kind === "picture")).toBe(false);
    expect(tickedCount(plan)).toBe(tickedCount(planCard(card(block({ picture: "plane" })), now())) - 1);
  });

  it("on Set up again, shows a picture the bot keeps as it is, unticked, with nothing to write", () => {
    for (const has of ["set:moon", "photo:0123456789abcdef", null] as const) {
      const plan = planCard(card(keeping(), true), now({ picture: has }));
      const i = listedItem(plan, "picture");
      expect(i).toMatchObject({ before: has, after: has, status: "same" });
      expect(tickable(i) && i.ticked).toBe(false);
      expect(acceptedRecord(plan).items.some((a) => a.kind === "picture")).toBe(false);
    }
  });

  it("on Set up again, offers a picture the bot changes as before → after", () => {
    const plan = planCard(card(keeping({ picture: "sun" }), true), now({ picture: "photo:0123456789abcdef" }));
    expect(listedItem(plan, "picture")).toMatchObject({ before: "photo:0123456789abcdef", after: "set:sun", status: "change", ticked: true });
  });

  it("keeps the owner's choice of another picture, or their upload, through a redraw that leaves the picture alone", () => {
    const first = planCard(card(block({ picture: "plane" })), now());
    for (const to of ["set:moon", "photo:fedcba9876543210"] as const) {
      const chosen = choose(listedItem(first, "picture"), { to });
      expect(listedItem(planCard(card(block({ picture: "plane", color: "blue" })), now(), null, [chosen]), "picture")).toMatchObject({ after: to, status: "change" });
    }
  });

  it("records pictures by key, and refuses a record whose picture is anything else", () => {
    const plan = planCard(card(block({ picture: "plane" })), now());
    const record = acceptedRecord(plan);
    expect(readAcceptedRecord(JSON.stringify(record))).toEqual(record);
    for (const to of ["https://example.com/face.png", "data:image/png;base64,iVBORw0KGgo=", "set:Plane", "photo:12"]) {
      const bad = { ...record, items: record.items.map((i) => (i.kind === "picture" ? { ...i, to } : i)) };
      expect(readAcceptedRecord(JSON.stringify(bad))).toBeNull();
    }
  });
});

describe("what the owner accepted", () => {
  const rowsWith = (b: BotSetupNewBlock) => [brief("s1"), reply(2, JSON.stringify(b))];
  const readyRow = (id: number, record: Parameters<typeof acceptedRecordBlock>[0]): SetupRow => ({
    id,
    role: "user",
    display_kind: "hidden",
    content: `Set it up is done. Save the owner's name with your memory tool.\n\n${acceptedRecordBlock(record)}`,
  });

  it("records each tick and in-place edit under the card's id, and reads it back from its block", () => {
    const { card } = cardOf(rowsWith(block()));
    const plan = onCard(card, now(), { persona: { to: "You are B." }, color: { to: "#3b82f6" }, "toolset:browser": { ticked: false } });
    const record = acceptedRecord(plan);
    expect(record.card).toBe(card.id);
    expect(record.items.find((i) => i.key === "persona")).toEqual({ kind: "persona", key: "persona", over: [block().persona], ticked: true, from: "", to: "You are B." });
    expect(record.items.find((i) => i.key === "color")).toMatchObject({ over: [BOT_SETUP_COLOR_HEX.teal], from: null, to: "#3b82f6" });
    expect(record.items.find((i) => i.key === "toolset:browser")).toEqual({ kind: "toolset", key: "toolset:browser", over: [], ticked: false, from: "off", to: "on" });
    expect(record.items.some((i) => i.key === "model")).toBe(false);
    const text = acceptedRecordBlock(record);
    expect(fencedBlocks(text, ACCEPTED_FENCE).map(readAcceptedRecord)).toEqual([record]);
  });

  it("refuses a record that is half right", () => {
    const good = { v: 1, card: "s1:x", items: [{ kind: "persona", key: "persona", over: ["A"], ticked: true, from: "", to: "B" }] };
    expect(readAcceptedRecord(JSON.stringify(good))).toEqual(good);
    const bad = [
      { ...good, v: 2 },
      { ...good, card: 1 },
      { ...good, items: [{ ...good.items[0], kind: "shell" }] },
      { ...good, items: [{ ...good.items[0], key: "skill:x" }] },
      { ...good, items: [{ ...good.items[0], ticked: "yes" }] },
      { ...good, items: [{ ...good.items[0], over: "A" }] },
      { ...good, items: [{ kind: "skill", key: "skill:x", over: ["on"], ticked: true, from: "absent", to: "npx evil" }] },
      { ...good, items: [{ kind: "skill", key: "skill:x", over: ["off", "npx evil"], ticked: true, from: "absent", to: "on" }] },
      { ...good, items: [{ kind: "color", key: "color", over: [null], ticked: true, from: null, to: "url(https://evil.example)" }] },
    ];
    for (const r of bad) expect(readAcceptedRecord(JSON.stringify(r)), JSON.stringify(r)).toBeNull();
  });

  // The design's case: persona A proposed, the owner edits it to B, B is applied, the app reloads.
  it("offers nothing after Set it up applied an edit and the app reloads", () => {
    const rows = rowsWith(block());
    const { card } = cardOf(rows);
    const before = now();
    const plan = onCard(card, before, { persona: { to: "You are B, edited in place." }, description: { to: "Edited too." } });
    const record = acceptedRecord(plan);
    const after = applied(before, plan, record);

    // Without the record, the block would offer to write A over B.
    expect(listedItem(planCard(card, after), "persona")).toMatchObject({ status: "change", before: "You are B, edited in place.", after: block().persona });

    // Kept on this computer until the ready-turn row reads back.
    const local = planCard(card, after, record);
    expect(local.items.filter((i) => i.status !== "same")).toEqual([]);
    expect(tickedCount(local)).toBe(0);

    // Read back from the hidden ready-turn row.
    const reloaded = cardOf([...rows, readyRow(3, record), said(4, "assistant", "I'm set up.")]);
    expect(reloaded.accepted).toEqual(record);
    expect(planCard(reloaded.card, after, reloaded.accepted).items.filter((i) => i.status !== "same")).toEqual([]);
  });

  it("shows a change made elsewhere after Set it up as that, unticked, instead of writing over it", () => {
    const { card } = cardOf(rowsWith(block()));
    const before = now();
    const plan = onCard(card, before, { persona: { to: "You are B." } });
    const record = acceptedRecord(plan);
    const later = { ...applied(before, plan, record), persona: "You are C, from Edit bot.", color: "#ec4899" };
    const again = planCard(card, later, record);
    expect(listedItem(again, "persona")).toMatchObject({ status: "elsewhere", ticked: false, before: "You are C, from Edit bot.", after: "You are B." });
    expect(listedItem(again, "color")).toMatchObject({ status: "elsewhere", ticked: false, before: "#ec4899", after: BOT_SETUP_COLOR_HEX.teal });
    expect(tickedCount(again)).toBe(0);
  });

  it("offers again, ticked, an item whose write didn't land, and keeps an unticked item unticked", () => {
    const { card } = cardOf(rowsWith(block()));
    const before = now();
    const plan = onCard(card, before, { "skill:find-nearby": { ticked: false } });
    const record = acceptedRecord(plan);
    const partly = applied(before, plan, { ...record, items: record.items.filter((i) => i.key !== "toolset:web") });
    const again = planCard(card, partly, record);
    expect(listedItem(again, "toolset:web")).toMatchObject({ status: "change", ticked: true, before: "off", after: "on" });
    expect(listedItem(again, "skill:find-nearby")).toMatchObject({ status: "change", ticked: false });
    expect(tickedCount(again)).toBe(1);
  });

  it("reads the Remember row against the name the owner accepted", () => {
    const { card } = cardOf(rowsWith(block()));
    const record = acceptedRecord(onCard(card, now(), { remember: { to: "Lee" } }));
    expect(listedItem(planCard(card, now({ memory: ["Call the owner Lee."] }), record), "remember")).toMatchObject({ status: "same", before: "Lee", after: "Lee" });
    expect(listedItem(planCard(card, now(), record), "remember")).toMatchObject({ status: "change", ticked: true, before: null, after: "Lee" });
  });

  // The owner accepts persona B over the proposed A; a newer block changes only the colour.
  it("keeps an accepted edit on a newer block that leaves that item alone", () => {
    const rows = rowsWith(block());
    const first = cardOf(rows).card;
    const before = now();
    const plan = onCard(first, before, { persona: { to: "You are B." } });
    const record = acceptedRecord(plan);
    const after = applied(before, plan, record);
    const redrawn = cardOf([...rows, readyRow(3, record), said(4, "user", "Make it blue."), reply(5, JSON.stringify(block({ color: "blue" })))]);
    expect(redrawn.card.id).not.toBe(first.id);
    expect(redrawn.accepted).toEqual(record);
    const next = planCard(redrawn.card, after, redrawn.accepted);
    expect(listedItem(next, "persona")).toMatchObject({ status: "same", after: "You are B." });
    expect(listedItem(next, "color")).toMatchObject({ status: "change", ticked: true, after: BOT_SETUP_COLOR_HEX.blue });
    expect(tickedCount(next)).toBe(1);
    // The bot changing the persona itself is a new offer.
    const rewritten = cardOf([...rows, readyRow(3, record), reply(5, JSON.stringify(block({ persona: "You are C." })))]);
    expect(listedItem(planCard(rewritten.card, after, rewritten.accepted), "persona")).toMatchObject({ status: "change", ticked: true, before: "You are B.", after: "You are C." });
  });

  it("keeps a pending edit and untick on a newer block that leaves those items alone", () => {
    const first = cardOf(rowsWith(block())).card;
    const shown = planCard(first, now());
    const pending = [choose(listedItem(shown, "persona"), { to: "You are B." }), choose(listedItem(shown, "toolset:browser"), { ticked: false })];
    const redrawn = cardOf([...rowsWith(block()), reply(3, JSON.stringify(block({ color: "blue" })))]).card;
    const next = planCard(redrawn, now(), null, pending);
    expect(listedItem(next, "persona")).toMatchObject({ status: "change", ticked: true, after: "You are B." });
    expect(listedItem(next, "toolset:browser")).toMatchObject({ status: "change", ticked: false });
    const rewritten = cardOf([...rowsWith(block()), reply(3, JSON.stringify(block({ persona: "You are C.", toolsets: [] })))]).card;
    expect(listedItem(planCard(rewritten, now(), null, pending), "persona")).toMatchObject({ status: "change", ticked: true, after: "You are C." });
  });

  it("keeps a choice the bot caught up with when the bot goes back to the value it was made over", () => {
    const first = cardOf(rowsWith(block())).card;
    const pending = [choose(listedItem(planCard(first, now()), "persona"), { to: "You are B." })];
    const echoed = cardOf([...rowsWith(block()), reply(3, JSON.stringify(block({ persona: "You are B." })))]).card;
    const plan = planCard(echoed, now(), null, pending);
    const record = acceptedRecord(plan);
    expect(record.items.find((i) => i.key === "persona")).toMatchObject({ over: [block().persona], to: "You are B." });
    const back = cardOf([...rowsWith(block()), reply(5, JSON.stringify(block({ color: "blue" })))]).card;
    expect(listedItem(planCard(back, applied(now(), plan, record), record), "persona")).toMatchObject({ status: "same", after: "You are B." });
  });

  it("keeps a choice the bot caught up with in the record, though Hermes already has the owner's value", () => {
    const has = now({ persona: "You are B." });
    const first = cardOf(rowsWith(block({ persona: "You are A-bot." }))).card;
    const pending = [choose(listedItem(planCard(first, has), "persona"), { to: "You are B." })];
    const echoed = cardOf(rowsWith(block({ persona: "You are B." }))).card;
    const record = acceptedRecord(planCard(echoed, has, null, pending));
    const back = cardOf(rowsWith(block({ persona: "You are A-bot." }))).card;
    expect(listedItem(planCard(back, has, record), "persona")).toMatchObject({ status: "same", after: "You are B." });
    expect(record.items.find((i) => i.key === "persona")).toMatchObject({ over: ["You are A-bot."], to: "You are B." });
  });

  it("makes a new choice on a kept item over the values the holding choice was made over", () => {
    const again = (b: BotSetupAgainBlock) => cardOf([briefAgain("s1", "You are Z."), reply(2, JSON.stringify(b))]).card;
    const first = again(keeping({ persona: "You are A." }));
    const start = now({ persona: "You are Z." });
    const plan = planCard(first, start, null, [choose(listedItem(planCard(first, start), "persona"), { to: "You are B." })]);
    const record = acceptedRecord(plan);
    const moved = { ...applied(start, plan, record), persona: "You are C." };
    const kept = again(keeping());
    const untick = choose(listedItem(planCard(kept, moved, record), "persona"), { ticked: false });
    const second = acceptedRecord(planCard(kept, moved, record, [untick]), record);
    const back = listedItem(planCard(again(keeping({ persona: "You are A." })), moved, second), "persona");
    expect(back).toMatchObject({ after: "You are B." });
    expect(tickable(back) && back.ticked).toBe(false);
    expect(untick).toMatchObject({ over: ["You are A.", "You are C."], to: "You are B.", ticked: false });
  });

  it("forgets an earlier accepted value once the owner chooses the bot's own value again", () => {
    const start = now({ persona: "You are Z." });
    const card = cardOf(rowsWith(block({ persona: "You are A." }))).card;
    const plan = planCard(card, start, null, [choose(listedItem(planCard(card, start), "persona"), { to: "You are B." })]);
    const record = acceptedRecord(plan);
    const movedToA = { ...applied(start, plan, record), persona: "You are A." };
    const back = choose(listedItem(planCard(card, movedToA, record), "persona"), { to: "You are A." });
    const second = acceptedRecord(planCard(card, movedToA, record, [back]), record);
    expect(listedItem(planCard(card, movedToA, second), "persona")).toMatchObject({ status: "same", after: "You are A." });
  });

  it("uses the owner's latest choice on an item", () => {
    const { card } = cardOf(rowsWith(block()));
    const edit = choose(listedItem(planCard(card, now()), "persona"), { to: "You are B." });
    const untick = choose(listedItem(planCard(card, now(), null, [edit]), "persona"), { ticked: false });
    expect(listedItem(planCard(card, now(), null, [edit, untick]), "persona")).toMatchObject({ status: "change", ticked: false, after: "You are B." });
  });

  it("keeps an untick through a Set it up that found Hermes already had the bot's value", () => {
    const { card } = cardOf(rowsWith(block()));
    const off = now();
    const untick = choose(listedItem(planCard(card, off), "skill:find-nearby"), { ticked: false });
    const on = now({ skills: [{ name: "find-nearby", enabled: true }] });
    const record = acceptedRecord(planCard(card, on, null, [untick]));
    const row = listedItem(planCard(card, off, record), "skill:find-nearby");
    expect(row).toMatchObject({ before: "off", after: "on" });
    expect(tickable(row) && row.ticked).toBe(false);
  });

  // Persona B is applied, a toolset fails, and Try again sets up only the toolset.
  it("keeps what an earlier Set it up applied in the record a retry leaves", () => {
    const { card } = cardOf(rowsWith(block()));
    const before = now();
    const plan = onCard(card, before, { persona: { to: "You are B." } });
    const first = acceptedRecord(plan);
    const partly = applied(before, plan, { ...first, items: first.items.filter((i) => i.key !== "toolset:web") });
    const retry = planCard(card, partly, first);
    expect(tickedCount(retry)).toBe(1);
    const second = acceptedRecord(retry, first);
    const done = applied(partly, retry, second);
    const reloaded = cardOf([...rowsWith(block()), readyRow(3, first), readyRow(4, second)]);
    expect(reloaded.accepted).toEqual(second);
    const again = planCard(reloaded.card, done, reloaded.accepted);
    expect(listedItem(again, "persona")).toMatchObject({ status: "same", after: "You are B." });
    expect(again.items.filter((i) => i.status !== "same")).toEqual([]);
  });

  it("finds the record of an identical redraw's card, though the record comes before the redraw", () => {
    const rows = rowsWith(block());
    const first = cardOf(rows).card;
    const record = acceptedRecord(onCard(first, now(), { persona: { to: "You are B." } }));
    const redrawn = cardOf([...rows, readyRow(3, record), said(4, "user", "Draw it again."), reply(5, JSON.stringify(block()))]);
    expect(redrawn.card.id).toBe(first.id);
    expect(redrawn.card.at.rowId).toBe(5);
    expect(redrawn.accepted).toEqual(record);
  });

  it("uses no record from another setup", () => {
    const record = acceptedRecord(onCard(cardOf(rowsWith(block())).card, now(), { persona: { to: "You are B." } }));
    const other = cardOf([brief("s2"), reply(2, JSON.stringify(block())), readyRow(3, record)]);
    expect(other.accepted).toBeNull();
    expect(planCard(other.card, now(), record)).toEqual(planCard(other.card, now()));
  });
});

describe("the owner's choices, over generated runs", () => {
  type Values = { persona: string; skill: string };
  type Key = keyof Values;
  type Shown = { persona: string | null; skill: "on" | "off" };
  type Owned = { key: Key; away: string[]; to: string; ticked: boolean };
  type Step = { op: "block"; persona: string | null; skill: "on" | "off" } | { op: "choose"; key: Key; to?: string; ticked?: boolean } | { op: "setItUp" } | { op: "hermes"; key: Key; to: string } | { op: "reload" };
  type Run = { start: Values; first: Shown; steps: Step[] };

  const [A, B, C] = ["You are A.", "You are B.", "You are C."];
  const PERSONAS = [A, B, C];
  const SWITCH = ["on", "off"] as const;
  const KEYS = ["persona", "skill"] as const;
  const ROW: Record<Key, string> = { persona: "persona", skill: "skill:find-nearby" };
  const valueArb = (key: Key) => fc.constantFrom<string>(...(key === "persona" ? PERSONAS : SWITCH));
  const keyArb = fc.constantFrom<Key>(...KEYS);
  const stepArb: fc.Arbitrary<Step> = fc.oneof(
    { weight: 4, arbitrary: fc.record({ op: fc.constant("block" as const), persona: fc.constantFrom(null, ...PERSONAS), skill: fc.constantFrom(...SWITCH) }) },
    { weight: 4, arbitrary: keyArb.chain((key) => valueArb(key).map((to): Step => ({ op: "choose", key, to }))) },
    { weight: 2, arbitrary: fc.tuple(keyArb, fc.boolean()).map(([key, ticked]): Step => ({ op: "choose", key, ticked })) },
    { weight: 2, arbitrary: fc.constant<Step>({ op: "setItUp" }) },
    { weight: 2, arbitrary: keyArb.chain((key) => valueArb(key).map((to): Step => ({ op: "hermes", key, to }))) },
    { weight: 1, arbitrary: fc.constant<Step>({ op: "reload" }) },
  );
  const runArb: fc.Arbitrary<Run> = fc.record({
    start: fc.record({ persona: fc.constantFrom(...PERSONAS), skill: fc.constantFrom(...SWITCH) }),
    first: fc.record({ persona: fc.constantFrom(...PERSONAS), skill: fc.constantFrom(...SWITCH) }),
    steps: fc.array(stepArb, { maxLength: 10 }),
  });
  const caughtUp: Run = {
    start: { persona: B, skill: "on" },
    first: { persona: A, skill: "on" },
    steps: [{ op: "choose", key: "persona", to: B }, { op: "block", persona: B, skill: "on" }, { op: "setItUp" }, { op: "block", persona: A, skill: "on" }],
  };
  const untickedWhenKept: Run = {
    start: { persona: C, skill: "on" },
    first: { persona: A, skill: "on" },
    steps: [
      { op: "choose", key: "persona", to: B },
      { op: "setItUp" },
      { op: "hermes", key: "persona", to: C },
      { op: "block", persona: null, skill: "on" },
      { op: "choose", key: "persona", ticked: false },
      { op: "setItUp" },
      { op: "block", persona: A, skill: "on" },
    ],
  };
  const untickedThenSame: Run = {
    start: { persona: A, skill: "off" },
    first: { persona: A, skill: "on" },
    steps: [{ op: "choose", key: "skill", ticked: false }, { op: "hermes", key: "skill", to: "on" }, { op: "setItUp" }, { op: "hermes", key: "skill", to: "off" }],
  };

  const cardFor = (b: Shown) =>
    cardOf([briefAgain("s1", "You are Z."), reply(2, JSON.stringify(keeping({ persona: b.persona, callOwner: null, skills: [{ name: "find-nearby", on: b.skill === "on" }], toolsets: [], mcp: [], copy: [] })))]).card;
  const hermesOf = (v: Values) => now({ persona: v.persona, skills: [{ name: "find-nearby", enabled: v.skill === "on" }] });

  it("never offers, ticked, a value the owner moved away from while their choice holds", () => {
    fc.assert(
      fc.property(runArb, ({ start, first, steps }) => {
        const hermes: Values = { ...start };
        let shown = first;
        let card = cardFor(shown);
        let record: AcceptedRecord | null = null;
        let pending: ReturnType<typeof choose>[] = [];
        let owned = { accepted: [] as Owned[], pending: [] as Owned[] };

        const proposed = (key: Key) => shown[key] ?? hermes[key];
        const holdsNow = (c: Owned) => shown[c.key] === null || [c.to, ...c.away].includes(shown[c.key] as string);
        const active = (key: Key) => owned.pending.filter((c) => c.key === key && holdsNow(c)).at(-1) ?? owned.accepted.find((c) => c.key === key && holdsNow(c));
        const plan = () => planCard(card, hermesOf(hermes), record, pending);
        const check = (trail: string) => {
          const p = plan();
          for (const key of KEYS) {
            const c = active(key);
            const row = listedItem(p, ROW[key]);
            if (!c || !tickable(row) || !row.ticked) continue;
            expect(c.away, `${trail}: ${key} offers ${row.after}, ticked, though the owner chose ${JSON.stringify(c)}`).not.toContain(row.after);
            expect(c.ticked, `${trail}: ${key} is ticked, though the owner unticked it`).toBe(true);
          }
        };

        const trail: string[] = [];
        check("start");
        for (const step of steps) {
          trail.push(JSON.stringify(step));
          if (step.op === "block") {
            shown = { persona: step.persona, skill: step.skill };
            card = cardFor(shown);
          } else if (step.op === "choose") {
            const row = listedItem(plan(), ROW[step.key]);
            if (step.ticked !== undefined && !tickable(row)) continue;
            pending = [...pending, choose(row, step.ticked === undefined ? { to: step.to } : { ticked: step.ticked })];
            const held = active(step.key);
            const to = step.to ?? held?.to ?? proposed(step.key);
            const away = [...new Set([...(held?.away ?? []), proposed(step.key)])].filter((v) => v !== to);
            owned = { ...owned, pending: [...owned.pending, { key: step.key, away, to, ticked: step.ticked ?? (tickable(row) ? row.ticked : true) }] };
          } else if (step.op === "setItUp") {
            const p = plan();
            record = acceptedRecord(p, record);
            for (const key of KEYS) {
              const row = listedItem(p, ROW[key]);
              if (tickable(row) && row.ticked) hermes[key] = String(row.after);
            }
            owned = { accepted: KEYS.flatMap((key) => active(key) ?? []), pending: [] };
            pending = [];
          } else if (step.op === "hermes") {
            hermes[step.key] = step.to;
          } else {
            record = record && readAcceptedRecord(fencedBlocks(acceptedRecordBlock(record), ACCEPTED_FENCE)[0]);
            owned = { ...owned, pending: [] };
            pending = [];
          }
          check(trail.join(" → "));
        }
      }),
      { numRuns: 3000, seed: 1511, examples: [[caughtUp], [untickedWhenKept], [untickedThenSame]] },
    );
  });
});
