// Bot setup's review card (ADR 0231), as data: which setup block in a Bot Chat is the live card, what it would change
// in Hermes, and what the owner accepted at Set it up. Pure: the transport reads the rows and Hermes's lists, and the
// card UI draws what this returns.
// The block is the bot's words, so nothing in it reaches Hermes as given. Every skill, toolset, model, MCP server and
// bot it names is matched against what Hermes lists, and the plan carries Hermes's own spelling of it. A name Hermes
// doesn't list is a row that can't be ticked. A key the format doesn't have makes the whole block unreadable, so a
// command, URL or key can't ride in beside a name.
// What the owner did to an item is a Choice: its tick and value, and the bot's value they chose over. The card the app
// draws is the bot's proposal, then what was accepted at Set it up, then the owner's pending choices. A newer block
// keeps each choice unless the bot changed that same item (ADR 0231, `plan` in fieldMerge.ts), so neither a redraw nor
// a reload offers to write the bot's value over the owner's.
import {
  BOT_SETUP_BLOCK_KEYS,
  BOT_SETUP_BLOCK_VERSION,
  BOT_SETUP_COLORS,
  BOT_SETUP_CURRENT_HEADER,
  BOT_SETUP_DESCRIPTION_MAX,
  BOT_SETUP_FENCE,
  botSetupMarkerId,
  type BotSetupAgainBlock,
  type BotSetupColor,
  type BotSetupCopy,
  type BotSetupNewBlock,
  type BotSetupOtherBot,
  type BotSetupToggle,
} from "./botSetupBrief";
import { plan as mergeEdit } from "./fieldMerge";
import type { SkillRow } from "./skills";
import { textOf } from "./storedTranscript";
import type { Toolset } from "./toolsets";
import { isObj } from "./values";

/** A Bot Chat row as Hermes stores it (`GET /api/sessions/{id}/messages`), hidden rows included: the brief is one. */
export type SetupRow = { id?: number; role?: string; content?: unknown; display_kind?: unknown };

/** Where a block is: its row's place in the rows read, that row's stored id when it has one, and which block of the row. */
export type BlockAt = { index: number; rowId?: number; nth: number };

/** A block that doesn't parse. `source`: what the bot wrote, for the card to show. `reason`: for tests and Diagnostics. */
export type Unreadable = { at: BlockAt; source: string; reason: string };

/**
 * The live card of a Bot Chat's newest setup. `none`: no brief marker, or no block after the newest one.
 * `card`: the newest block that parses; `newerUnreadable` is a block after it that doesn't, which the card UI shows as
 * unreadable with its "draw it again" button. `accepted`: the newest record of this setup that a row carries.
 * `unreadable`: no block after the marker parses; this is the newest.
 */
export type ParseResult =
  | { kind: "none"; setupId: string | null }
  | { kind: "card"; card: Card; newerUnreadable?: Unreadable; accepted: AcceptedRecord | null }
  | ({ kind: "unreadable"; setupId: string } & Unreadable);

/**
 * Which block a brief asks for. `again`: Set up again's, where null keeps a value. `againPersonaLeftOut`: the same, but
 * the brief left the persona out as too long, so the block's persona must be null.
 */
export type BriefKind = "new" | "again" | "againPersonaLeftOut";

export type CardBlock = { again: false; block: BotSetupNewBlock } | { again: true; block: BotSetupAgainBlock };

/** One setup block, checked. `id`: the brief marker's id and a hash of the block, so an identical redraw is the same card. */
export type Card = { id: string; setupId: string; at: BlockAt } & CardBlock;

/** The value each kind of item has in Hermes, before and after. A skill copied from another bot is `absent` before. */
export type ItemValues = {
  persona: string;
  description: string;
  model: string | null;
  /** A Bot Mode colour as `lookOf` reads it: lowercase hex, or null for Hermes's own. */
  color: string | null;
  /** The owner's name, once the bot's memory lists an entry with it. */
  remember: string | null;
  skill: "on" | "off" | "absent";
  toolset: "on" | "off";
  mcp: "added" | "absent";
};
export type ItemKind = keyof ItemValues;

/**
 * Whether Set it up has anything to do for an item. `change`: Hermes differs from `after`; ticked by default.
 * `elsewhere`: the owner accepted `after`, and Hermes has since been changed to `before` from somewhere else; unticked,
 * so it isn't overwritten unless the owner ticks it. `same`: Hermes already has it, so it isn't counted or written.
 */
export type ItemStatus = { status: "change"; ticked: boolean } | { status: "elsewhere"; ticked: boolean } | { status: "same" };

type Proposal<K extends ItemKind> = { kind: K; key: string; name?: string; from?: string; before: ItemValues[K]; proposed: ItemValues[K] };

/**
 * One row Hermes lists. `key`: unique in the plan (`persona`, `skill:<name>`). `name`: Hermes's own spelling. `from`:
 * the bot it is copied from, as Hermes lists that bot. `before`: Hermes's value now. `proposed`: the block's value.
 * `after`: the value on the card, which the owner may have chosen instead. `over`: the bot's value the owner's choice
 * on the item was made over, or `proposed` when no choice holds.
 */
export type ListedItem = { [K in ItemKind]: Proposal<K> & { after: ItemValues[K]; over: ItemValues[K] } & ItemStatus }[ItemKind];

/** A name the block gave that Hermes doesn't list. Shown with the block's own spelling; never ticked, never sent. */
export type NotFoundItem = { kind: "model" | "skill" | "toolset" | "mcp"; key: string; name: string; from?: string; status: "notFound" };

export type PlanItem = ListedItem | NotFoundItem;

/** The card's items in the card's order: about the bot, then skills, toolsets and MCP servers. */
export type Plan = { cardId: string; items: PlanItem[] };

/**
 * What the plan is read against: the bot as Hermes has it now, and what Hermes lists. `mcp` undefined: MCP isn't
 * offered, so every MCP server the block names is not found. `memory`: the bot's memory entries, as text.
 */
export type HermesNow = {
  persona: string;
  description: string;
  model: string | null;
  color: string | null;
  memory: readonly string[];
  skills: readonly Pick<SkillRow, "name" | "enabled">[];
  toolsets: readonly Pick<Toolset, "name" | "enabled">[];
  models: readonly string[];
  mcp?: { catalog: readonly string[]; servers: readonly string[] };
  bots: readonly Pick<BotSetupOtherBot, "name" | "skills" | "toolsetsOn" | "mcp">[];
};

type ChoiceOf<K extends ItemKind> = { kind: K; key: string; proposed: ItemValues[K]; ticked: boolean; to: ItemValues[K] };

/** The owner's tick and value for an item (`to`), and the block's value they chose it over (`proposed`). */
export type Choice = { [K in ItemKind]: ChoiceOf<K> }[ItemKind];

/** A choice as Set it up left it, with Hermes's value then (`from`). */
export type AcceptedItem = { [K in ItemKind]: ChoiceOf<K> & { from: ItemValues[K] } }[ItemKind];

/**
 * What the owner accepted in a setup, last made on card `card`. It rides in the hidden ready-turn row (ACCEPTED_FENCE).
 * Each record holds every item accepted so far, so the newest record is the whole of it.
 */
export type AcceptedRecord = { v: 1; card: string; items: AcceptedItem[] };

/** The fenced block that carries an accepted record in the ready-turn row. */
export const ACCEPTED_FENCE = "highwing-bot-setup-accepted";

/** What each block colour is stored as in the Bot Mode block. Edit bot's colour box writes hex, and the roster shows only hex. */
export const BOT_SETUP_COLOR_HEX: Readonly<Record<BotSetupColor, string>> = {
  red: "#ef4444",
  orange: "#f97316",
  amber: "#f59e0b",
  green: "#22c55e",
  teal: "#14b8a6",
  blue: "#3b82f6",
  indigo: "#6366f1",
  purple: "#a855f7",
  pink: "#ec4899",
  gray: "#6b7280",
};

// ---- Reading the rows --------------------------------------------------------------------------------------------

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Each fenced code block in `text` whose language is `lang`, as CommonMark reads fences. An unclosed one runs to the end. */
export function fencedBlocks(text: string, lang: string): string[] {
  const out: string[] = [];
  let open: { fence: string; lang: string; body: string[] } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (open) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === open.fence[0] && close[1].length >= open.fence.length) {
        if (open.lang === lang) out.push(open.body.join("\n"));
        open = null;
      } else open.body.push(line);
      continue;
    }
    const m = FENCE_OPEN.exec(line);
    if (!m || (m[1][0] === "`" && m[2].includes("`"))) continue;
    open = { fence: m[1], lang: m[2].trim().split(/\s+/)[0] ?? "", body: [] };
  }
  if (open?.lang === lang) out.push(open.body.join("\n"));
  return out;
}

class Bad extends Error {}

const keysExactly = (o: Record<string, unknown>, keys: readonly string[], what: string) => {
  const have = Object.keys(o);
  const odd = [...have.filter((k) => !keys.includes(k)), ...keys.filter((k) => !have.includes(k))];
  if (odd.length) throw new Bad(`${what}: keys ${odd.join(", ")}`);
};

const text = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new Bad(`${what}: not text`);
  return v.trim();
};

const list = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) throw new Bad(`${what}: not a list`);
  return v;
};

const unique = <T>(items: T[], name: (t: T) => string, what: string): T[] => {
  const seen = new Set(items.map(name));
  if (seen.size !== items.length) throw new Bad(`${what}: a name twice`);
  return items;
};

const toggles = (v: unknown, what: string): BotSetupToggle[] =>
  unique(
    list(v, what).map((t, i) => {
      if (!isObj(t)) throw new Bad(`${what}[${i}]: not an object`);
      keysExactly(t, ["name", "on"], `${what}[${i}]`);
      if (typeof t.on !== "boolean") throw new Bad(`${what}[${i}].on: not true or false`);
      return { name: text(t.name, `${what}[${i}].name`), on: t.on };
    }),
    (t) => t.name,
    what,
  );

const names = (v: unknown, what: string): string[] => unique(list(v, what).map((n, i) => text(n, `${what}[${i}]`)), (n) => n, what);

const orNull = <T>(v: unknown, read: (v: unknown) => T): T | null => (v === null ? null : read(v));

const keepsNothing = (b: BotSetupAgainBlock): b is BotSetupNewBlock => b.persona !== null && b.description !== null && b.color !== null;

/**
 * The block a fenced body holds, read strictly as the kind `brief` asked for: the exact keys, each of its type, colour
 * from the list. Never throws.
 */
export function readBlock(source: string, brief: BriefKind): { ok: true; checked: CardBlock } | { ok: false; reason: string } {
  try {
    let raw: unknown;
    try {
      raw = JSON.parse(source);
    } catch {
      throw new Bad("not JSON");
    }
    if (!isObj(raw)) throw new Bad("not a JSON object");
    keysExactly(raw, BOT_SETUP_BLOCK_KEYS, "block");
    if (raw.v !== BOT_SETUP_BLOCK_VERSION) throw new Bad(`v: not ${BOT_SETUP_BLOCK_VERSION}`);
    const description = orNull(raw.description, (v) => {
      const d = text(v, "description");
      if (d.length > BOT_SETUP_DESCRIPTION_MAX) throw new Bad(`description: over ${BOT_SETUP_DESCRIPTION_MAX} characters`);
      return d;
    });
    const color = orNull(raw.color, (v) => {
      const c = BOT_SETUP_COLORS.find((c) => c === v);
      if (!c) throw new Bad("color: not one of the colours");
      return c;
    });
    const copy = list(raw.copy, "copy").map((c, i): BotSetupCopy => {
      if (!isObj(c)) throw new Bad(`copy[${i}]: not an object`);
      keysExactly(c, ["from", "skills", "toolsets", "mcp"], `copy[${i}]`);
      return { from: text(c.from, `copy[${i}].from`), skills: names(c.skills, `copy[${i}].skills`), toolsets: names(c.toolsets, `copy[${i}].toolsets`), mcp: names(c.mcp, `copy[${i}].mcp`) };
    });
    const mcp = unique(
      list(raw.mcp, "mcp").map((m, i) => {
        if (!isObj(m)) throw new Bad(`mcp[${i}]: not an object`);
        keysExactly(m, ["catalog"], `mcp[${i}]`);
        return { catalog: text(m.catalog, `mcp[${i}].catalog`) };
      }),
      (m) => m.catalog,
      "mcp",
    );
    // Built in the format's key order, so the same block always hashes to the same card id.
    const block: BotSetupAgainBlock = {
      v: BOT_SETUP_BLOCK_VERSION,
      persona: orNull(raw.persona, (v) => text(v, "persona")),
      description,
      model: orNull(raw.model, (v) => text(v, "model")),
      color,
      callOwner: orNull(raw.callOwner, (v) => text(v, "callOwner")),
      skills: toggles(raw.skills, "skills"),
      toolsets: toggles(raw.toolsets, "toolsets"),
      mcp,
      copy,
    };
    if (brief === "new") {
      if (!keepsNothing(block)) throw new Bad("a new bot's block keeps nothing: persona, description and color can't be null");
      return { ok: true, checked: { again: false, block } };
    }
    if (brief === "againPersonaLeftOut" && block.persona !== null) throw new Bad("persona: not null, though the brief left it out");
    return { ok: true, checked: { again: true, block } };
  } catch (e) {
    return { ok: false, reason: e instanceof Bad ? e.message : "unreadable" };
  }
}

/** Two 32-bit FNV-1a hashes over the text, as hex. */
function fingerprint(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}

const cardIdOf = (setupId: string, block: BotSetupAgainBlock) => `${setupId}:${fingerprint(JSON.stringify(block))}`;
const setupOf = (cardId: string) => cardId.slice(0, cardId.lastIndexOf(":"));

const rowText = (row: SetupRow) => textOf(row.content);

function briefKind(brief: string): BriefKind {
  const lines = brief.split(/\r?\n/);
  const at = lines.findIndex((l) => l === BOT_SETUP_CURRENT_HEADER);
  if (at < 0) return "new";
  try {
    const current: unknown = JSON.parse(lines[at + 1] ?? "");
    return isObj(current) && typeof current.persona === "string" ? "again" : "againPersonaLeftOut";
  } catch {
    return "againPersonaLeftOut";
  }
}

/**
 * The live card of the newest setup in a Bot Chat's rows, oldest first. A block before the newest brief marker belongs
 * to an earlier setup and is ignored. A newer block that doesn't parse leaves the newest one that does as the live
 * card, as #85 asks; it is returned beside it so the owner can ask for a redraw. Never throws.
 */
export function parseSetup(rows: readonly SetupRow[]): ParseResult {
  let marker = -1;
  let setupId: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const id = rows[i]?.role === "user" ? botSetupMarkerId(rowText(rows[i])) : null;
    if (id !== null) [marker, setupId] = [i, id];
  }
  if (setupId === null) return { kind: "none", setupId: null };
  const kind = briefKind(rowText(rows[marker]));
  let card: Card | null = null;
  let newer: Unreadable | null = null;
  for (let index = marker + 1; index < rows.length; index++) {
    const row = rows[index];
    if (row?.role !== "assistant") continue;
    const blocks = fencedBlocks(rowText(row), BOT_SETUP_FENCE);
    for (let nth = 0; nth < blocks.length; nth++) {
      const at: BlockAt = { index, nth, ...(typeof row.id === "number" && { rowId: row.id }) };
      const read = readBlock(blocks[nth], kind);
      if (read.ok) [card, newer] = [{ id: cardIdOf(setupId, read.checked.block), setupId, at, ...read.checked }, null];
      else newer = { at, source: blocks[nth], reason: read.reason };
    }
  }
  if (!card) return newer ? { kind: "unreadable", setupId, ...newer } : { kind: "none", setupId };
  let accepted: AcceptedRecord | null = null;
  for (let index = marker + 1; index < rows.length; index++) {
    if (rows[index]?.role !== "user") continue;
    for (const source of fencedBlocks(rowText(rows[index]), ACCEPTED_FENCE)) {
      const record = readAcceptedRecord(source);
      if (record && setupOf(record.card) === setupId) accepted = record;
    }
  }
  return { kind: "card", card, accepted, ...(newer && { newerUnreadable: newer }) };
}

// ---- The plan ----------------------------------------------------------------------------------------------------

/** Whether two values of a kind are the same in Hermes: text trimmed, none and "" alike, a colour in any case. */
function same(kind: ItemKind, a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => {
    const t = typeof v === "string" ? v.trim() : v === null ? "" : v;
    return kind === "color" && typeof t === "string" ? t.toLowerCase() : t;
  };
  return norm(a) === norm(b);
}

const remembers = (now: HermesNow, name: string | null): string | null => {
  const want = name?.trim().toLowerCase();
  return want && now.memory.some((m) => m.toLowerCase().includes(want)) ? name : null;
};

const listed = <K extends ItemKind>(kind: K, key: string, before: ItemValues[K], proposed: ItemValues[K], extra: { name?: string; from?: string } = {}) =>
  ({ kind, key, ...extra, before, proposed }) as Proposal<ItemKind>;

const notFound = (kind: NotFoundItem["kind"], name: string, from?: string): NotFoundItem => ({
  kind,
  key: `${kind}:${from === undefined ? "" : `${from}/`}${name}`,
  name,
  ...(from !== undefined && { from }),
  status: "notFound",
});

/** The block against Hermes now: one item per row the card shows. */
function planBlock(card: Card, now: HermesNow): (Proposal<ItemKind> | NotFoundItem)[] {
  const b = card.block;
  const items: (Proposal<ItemKind> | NotFoundItem)[] = [];
  const add = (item: Proposal<ItemKind> | NotFoundItem) => {
    const at = items.findIndex((i) => i.key === item.key);
    if (at < 0) items.push(item);
    else if ("status" in items[at] && !("status" in item)) items[at] = item;
  };
  add(listed("persona", "persona", now.persona, b.persona ?? now.persona));
  add(listed("description", "description", now.description, b.description ?? now.description));
  // A block that keeps the model still gets its row, which shows the model as already in use and counts for nothing.
  const model = b.model === null ? now.model : now.models.find((m) => m === b.model);
  add(model === undefined ? notFound("model", b.model ?? "") : listed("model", "model", now.model, model, model === null ? {} : { name: model }));
  add(listed("color", "color", now.color, b.color === null ? now.color : BOT_SETUP_COLOR_HEX[b.color]));
  // Whether Hermes has the Remember row depends on the name the card ends up with, so planCard reads it.
  if (b.callOwner !== null) add(listed("remember", "remember", null, b.callOwner));

  const skillNow = (name: string): ItemValues["skill"] => {
    const row = now.skills.find((s) => s.name === name);
    return row ? (row.enabled ? "on" : "off") : "absent";
  };
  const toolsetNow = (name: string) => now.toolsets.find((t) => t.name === name);
  const skill = (name: string, on: boolean, from?: Pick<BotSetupOtherBot, "name" | "skills">) => {
    const known = from ? from.skills.find((s) => s === name) : now.skills.find((s) => s.name === name)?.name;
    if (known === undefined) return add(notFound("skill", name, from?.name));
    add(listed("skill", `skill:${known}`, skillNow(known), on ? "on" : "off", { name: known, ...(from && { from: from.name }) }));
  };
  const toolset = (name: string, on: boolean, from?: Pick<BotSetupOtherBot, "name" | "toolsetsOn">) => {
    const row = toolsetNow(name);
    if (!row || (from && !from.toolsetsOn.includes(name))) return add(notFound("toolset", name, from?.name));
    add(listed("toolset", `toolset:${row.name}`, row.enabled ? "on" : "off", on ? "on" : "off", { name: row.name, ...(from && { from: from.name }) }));
  };
  const mcp = (name: string, source: readonly string[] | undefined, from?: string) => {
    const known = source?.find((n) => n === name);
    if (known === undefined || !now.mcp) return add(notFound("mcp", name, from));
    add(listed("mcp", `mcp:${known}`, now.mcp.servers.includes(known) ? "added" : "absent", "added", { name: known, ...(from !== undefined && { from }) }));
  };

  // A bot to copy from is matched by its name as the brief listed it. One Hermes doesn't list makes each item not found.
  const copies = b.copy.map((c) => ({ c, bot: now.bots.find((x) => x.name.trim() === c.from) }));
  for (const t of b.skills) skill(t.name, t.on);
  for (const { c, bot } of copies) for (const n of c.skills) bot ? skill(n, true, bot) : add(notFound("skill", n, c.from));
  for (const t of b.toolsets) toolset(t.name, t.on);
  for (const { c, bot } of copies) for (const n of c.toolsets) bot ? toolset(n, true, bot) : add(notFound("toolset", n, c.from));
  for (const m of b.mcp) mcp(m.catalog, now.mcp?.catalog);
  for (const { c, bot } of copies) for (const n of c.mcp) mcp(n, bot?.mcp, bot?.name ?? c.from);
  return items;
}

/** Whether a choice made on the bot's `c.proposed` holds on a block that proposes `proposed`: unless the bot changed that item. */
function holds(c: Choice, proposed: unknown): boolean {
  const merged = mergeEdit<{ item: unknown }>({ item: { from: c.proposed, to: c.to } }, { item: proposed }, { item: (a, b) => same(c.kind, a, b) });
  return merged.settled.item?.kind !== "changedElsewhere";
}

const leftAlone = (b: BotSetupAgainBlock, kind: ItemKind) => (kind === "persona" || kind === "description" || kind === "model" || kind === "color") && b[kind] === null;

/**
 * The card's plan: the block against Hermes now, with each choice the owner made laid over it, `accepted` at Set it up
 * and then `pending` on the card since, the last of each that holds. A choice made on a block that proposed something
 * else for its item is dropped; a block that keeps the item keeps every choice on it.
 * For an accepted item, Hermes holding the accepted value means nothing to do; Hermes still holding the value it had
 * then offers it again; anything else was changed elsewhere since, and is shown unticked. An item left unticked stays
 * unticked.
 */
export function planCard(card: Card, now: HermesNow, accepted: AcceptedRecord | null = null, pending: readonly Choice[] = []): Plan {
  const kept = accepted && setupOf(accepted.card) === card.setupId ? accepted.items : [];
  const items = planBlock(card, now).map((p): PlanItem => {
    if ("status" in p) return p;
    const choiceOn = <C extends Choice>(choices: readonly C[]) => choices.filter((c) => c.key === p.key && c.kind === p.kind && (leftAlone(card.block, p.kind) || holds(c, p.proposed))).at(-1);
    const a = choiceOn(kept);
    const chosen = choiceOn(pending);
    const held = chosen ?? a;
    const after = held ? held.to : p.proposed;
    const before = p.kind === "remember" ? remembers(now, after as string | null) : p.before;
    const status: ItemStatus = same(p.kind, before, after)
      ? { status: "same" }
      : a?.ticked && !same(p.kind, before, a.from) && same(p.kind, after, a.to)
        ? { status: "elsewhere", ticked: chosen?.ticked ?? false }
        : { status: "change", ticked: held?.ticked ?? true };
    return { ...p, before, after, over: held ? held.proposed : p.proposed, ...status } as ListedItem;
  });
  return { cardId: card.id, items };
}

/** An item Set it up can write, ticked or not. */
export const tickable = (item: PlanItem): item is ListedItem & { status: "change" | "elsewhere"; ticked: boolean } => item.status === "change" || item.status === "elsewhere";

/** The card's "N changes": items ticked now. Rows already in Hermes, and names Hermes doesn't list, don't count. */
export const tickedCount = (plan: Plan) => plan.items.filter((i) => tickable(i) && i.ticked).length;

/** The owner's choice on an item of the plan: its tick, or a value in place of the one shown. The rest stays as shown. */
export const choose = <I extends ListedItem>(item: I, change: { ticked?: boolean; to?: I["after"] }): Choice =>
  ({ kind: item.kind, key: item.key, proposed: item.proposed, ticked: change.ticked ?? (tickable(item) ? item.ticked : true), to: change.to === undefined ? item.after : change.to }) as Choice;

/**
 * The record of Set it up on `plan`, laid over `previous`, the setup's record so far: every item Set it up could write,
 * ticked or not, and every item the owner set to other than the block's value. An item Hermes already has keeps its
 * earlier record while that still holds, so a retry doesn't forget what an earlier Set it up applied.
 */
export function acceptedRecord(plan: Plan, previous: AcceptedRecord | null = null): AcceptedRecord {
  const earlier = previous && setupOf(previous.card) === setupOf(plan.cardId) ? previous.items : [];
  const items = new Map(earlier.map((a) => [a.key, a]));
  for (const item of plan.items) {
    if (item.status === "notFound") continue;
    const a = items.get(item.key);
    if (tickable(item) || !same(item.kind, item.after, item.proposed))
      items.set(item.key, { kind: item.kind, key: item.key, proposed: item.over, ticked: tickable(item) ? item.ticked : true, from: item.before, to: item.after } as AcceptedItem);
    else if (a && !holds(a, item.over)) items.delete(item.key);
  }
  return { v: 1, card: plan.cardId, items: [...items.values()] };
}

// ---- The record's text ------------------------------------------------------------------------------------------

/** The record as the fenced block the ready-turn row carries, and as it is kept on this computer until that row reads back. */
export const acceptedRecordBlock = (record: AcceptedRecord) => `\`\`\`${ACCEPTED_FENCE}\n${JSON.stringify(record)}\n\`\`\``;

const VALUE_OK: { [K in ItemKind]: (v: unknown) => v is ItemValues[K] } = {
  persona: (v): v is string => typeof v === "string",
  description: (v): v is string => typeof v === "string",
  model: (v): v is string | null => v === null || typeof v === "string",
  color: (v): v is string | null => v === null || (typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v)),
  remember: (v): v is string | null => v === null || typeof v === "string",
  skill: (v): v is ItemValues["skill"] => v === "on" || v === "off" || v === "absent",
  toolset: (v): v is ItemValues["toolset"] => v === "on" || v === "off",
  mcp: (v): v is ItemValues["mcp"] => v === "added" || v === "absent",
};

const isKind = (k: unknown): k is ItemKind => typeof k === "string" && Object.hasOwn(VALUE_OK, k);

/** A record from its block's body, or null for anything else: a record that is half right is not used. Never throws. */
export function readAcceptedRecord(source: string): AcceptedRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.v !== 1 || typeof raw.card !== "string" || !Array.isArray(raw.items)) return null;
  const items: AcceptedItem[] = [];
  for (const i of raw.items) {
    if (!isObj(i) || !isKind(i.kind) || typeof i.key !== "string" || typeof i.ticked !== "boolean") return null;
    if (i.key !== i.kind && !i.key.startsWith(`${i.kind}:`)) return null;
    const ok = VALUE_OK[i.kind];
    if (!ok(i.proposed) || !ok(i.from) || !ok(i.to)) return null;
    items.push({ kind: i.kind, key: i.key, proposed: i.proposed, ticked: i.ticked, from: i.from, to: i.to } as AcceptedItem);
  }
  return { v: 1, card: raw.card, items };
}
