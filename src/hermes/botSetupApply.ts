// Set it up on Bot setup's card (ADR 0231): what the card is read against, each ticked item written and read back, and
// the hidden ready turn that ends the interview. ADR 0197's rules carry over: one item at a time, each ending applied,
// failed with why, or waiting on a toolset caution, and once a call gets no answer nothing more is sent.
// Every write goes through the route Settings already uses for it, checked against what the card read, so a change
// made elsewhere since isn't overwritten: SOUL.md by its content, the description and the model by `ProfilesApi.edit`,
// the colour by the Bot Mode block's revision (ADR 0189). Description and model are two writes, since `edit` still
// sends the model after a description write that got no answer.
import { settleItem, noAnswer, type ItemState, type SetupApis as CapabilityApis, type SetupItem } from "./botSetup";
import { acceptedRecordBlock, tickable, type AcceptedRecord, type Card, type HermesNow, type ListedItem, type Plan } from "./botSetupCard";
import type { Bot, BotLook } from "./bots";
import type { EditResult, FieldOutcome } from "./fieldMerge";
import type { MemoryApi } from "./memory";
import type { ModelCatalog } from "./models";
import { PersonaError, type PersonaApi, type Soul } from "./persona";
import { ProfileError, type ProfileFields, type ProfilesApi } from "./profiles";
import type { SkillsApi } from "./skills";
import type { Caution, Toolset } from "./toolsets";
import { errorText } from "./values";

/** What Set it up reads and writes, each call naming the bot's profile. */
export type SetupApis = CapabilityApis & {
  skills: Pick<SkillsApi, "rows" | "setEnabled" | "copy">;
  persona: Pick<PersonaApi, "read" | "save">;
  profiles: Pick<ProfilesApi, "list" | "edit">;
  memory: Pick<MemoryApi, "load">;
  /** The server's bots, as the roster reads them. */
  bots(): Promise<Bot[]>;
  /** The models the bot's profile can switch to, when Hermes lists them. */
  models(): Promise<ModelCatalog | undefined>;
  editBot(profile: string, edits: { color: { from: string | null; to: string | null } }): Promise<EditResult<BotLook>>;
};

/**
 * The bot as the card was drawn against it. `soul`: SOUL.md as read, which the persona is saved over only while
 * Hermes still has it. `model`: the profile's model as `ProfilesApi.edit` compares it. `providers`: each listed
 * model's provider. `copyFrom`: the profile of each bot the block copies from, by its name. `labels`: each toolset's.
 */
export type SetupNow = {
  now: HermesNow;
  soul: Soul;
  model: ProfileFields["model"];
  providers: Readonly<Record<string, string>>;
  copyFrom: Readonly<Record<string, string>>;
  labels: Readonly<Record<string, string>>;
};

const named = <T extends { name: string }>(rows: readonly T[]) => rows.map((r) => r.name);

/** The bot `profile` as Hermes has it now, and what it lists, read for `card`. Rejects when a read fails. */
export async function readSetupNow(apis: SetupApis, profile: string, card: Card): Promise<SetupNow> {
  const [soul, rows, roster, skills, toolsets, catalog, memory] = await Promise.all([
    apis.persona.read(profile),
    apis.profiles.list(),
    apis.bots(),
    apis.skills.rows(profile),
    apis.toolsets.list(profile),
    apis.models(),
    // A memory Highwing can't read only leaves the Remember row to offer again.
    apis.memory.load(profile).catch(() => undefined),
  ]);
  const row = rows.find((r) => r.name === profile);
  if (!row) throw new Error(`Hermes lists no profile named ${profile}.`);
  const providers: Record<string, string> = {};
  for (const p of catalog?.providers ?? []) for (const m of p.models) providers[m.model] ??= p.slug;
  const sources = card.block.copy.flatMap((c) => roster.filter((b) => b.name.trim() === c.from && b.profile !== profile));
  const bots = await Promise.all(
    sources.map(async (b) => {
      const [theirSkills, theirToolsets] = await Promise.all([apis.skills.rows(b.profile), apis.toolsets.list(b.profile)]);
      return { name: b.name, skills: named(theirSkills), toolsetsOn: named(theirToolsets.toolsets.filter((t) => t.enabled)) };
    }),
  );
  const model = row.model?.trim() || null;
  return {
    now: {
      persona: soul.content,
      description: row.description,
      model,
      color: roster.find((b) => b.profile === profile)?.color?.toLowerCase() ?? null,
      memory: memory ? Object.values(memory.resources).flatMap((r) => r.entries.map((e) => e.text)) : [],
      skills,
      toolsets: toolsets.toolsets,
      models: [...new Set([...(model ? [model] : []), ...Object.keys(providers)])],
      bots,
    },
    soul,
    model: row.provider || row.model ? { provider: row.provider ?? "", model: row.model ?? "" } : null,
    providers,
    copyFrom: Object.fromEntries(sources.map((b) => [b.name, b.profile])),
    labels: Object.fromEntries(toolsets.toolsets.map((t) => [t.name, t.label])),
  };
}

/** Where an item stands at Set it up: ADR 0197's states, and `waiting` for the Remember row, which the bot saves. */
export type CardState = ItemState | { kind: "waiting" };

/** One item's write judged. `unanswered`: why its call got no answer from Hermes, after which nothing more is sent. */
export type Step = { state: CardState; unanswered?: string };

const APPLIED: Step = { state: { kind: "applied" } };
const said = (text: string, unanswered = false): Step => ({ state: { kind: "failed", miss: { kind: "said", text } }, ...(unanswered && { unanswered: text }) });
const ELSEWHERE: Step = { state: { kind: "failed", miss: { kind: "changed" } } };

/** A field `ProfilesApi.edit` or `Hermes.editBot` wrote, judged. */
function fieldStep<V>(o: FieldOutcome<V> | undefined): Step {
  if (!o) return said("Hermes didn't say what became of it.");
  if (o.kind === "saved") return APPLIED;
  if (o.kind === "changedElsewhere") return ELSEWHERE;
  return said(new ProfileError(o.failure).message, o.failure.kind === "lost" || o.failure.kind === "unsent");
}

const personaFailed = (e: unknown): Step =>
  e instanceof PersonaError ? said(e.message, e.status === undefined) : said(errorText(e), true);

async function persona(apis: SetupApis, profile: string, base: Soul, to: string): Promise<Step> {
  try {
    const r = await apis.persona.save(profile, base, to);
    if (r.kind === "saved") return APPLIED;
    if (r.kind === "unverified") return personaFailed(r.problem);
    // `changed`: written, then read back as other text, so another client wrote it too.
    return ELSEWHERE;
  } catch (e) {
    return personaFailed(e);
  }
}

const judged = ({ item, unanswered }: { item: SetupItem; unanswered?: string }): Step => ({ state: item.state, ...(unanswered !== undefined && { unanswered }) });

/** A skill another bot has, copied as Settings → Skills copies one, then turned on and read back. */
async function copySkill(apis: SetupApis, profile: string, from: string, item: SetupItem): Promise<Step> {
  try {
    const theirs = await apis.skills.rows(from);
    const row = theirs.find((r) => r.name === item.name);
    if (!row) return { state: { kind: "failed", miss: { kind: "missing" } } };
    await apis.skills.copy(from, profile, row, named(theirs));
  } catch (e) {
    return said(errorText(e), noAnswer(e));
  }
  return judged(await settleItem(apis, profile, item));
}

/** Writes one item of the card and reads it back. `accepted`: the cautions the owner confirmed with Apply anyway. */
export async function applyItem(apis: SetupApis, profile: string, read: SetupNow, item: ListedItem, accepted: Caution[] = []): Promise<Step> {
  const capability = (area: SetupItem["area"], want: boolean): SetupItem => {
    const name = item.name ?? item.key;
    return { area, name, label: area === "toolset" ? (read.labels[name] ?? name) : name, want, state: APPLIED.state as SetupItem["state"] };
  };
  switch (item.kind) {
    case "persona":
      return persona(apis, profile, read.soul, item.after);
    case "description":
      return fieldStep((await apis.profiles.edit(profile, { description: { from: item.before, to: item.after } })).fields.description);
    case "model": {
      const provider = item.after === null ? undefined : read.providers[item.after];
      if (item.after === null || provider === undefined) return said(`Hermes doesn't list a provider for ${item.after ?? "no model"}.`);
      return fieldStep((await apis.profiles.edit(profile, { model: { from: read.model, to: { provider, model: item.after } } })).fields.model);
    }
    case "color":
      return fieldStep((await apis.editBot(profile, { color: { from: item.before, to: item.after } })).fields.color);
    case "remember":
      return { state: { kind: "waiting" } };
    case "skill": {
      const skill = capability("skill", item.after === "on");
      const from = item.from === undefined ? undefined : read.copyFrom[item.from];
      if (item.before === "absent" && from !== undefined) return copySkill(apis, profile, from, skill);
      return judged(await settleItem(apis, profile, skill));
    }
    case "toolset":
      return judged(await settleItem(apis, profile, capability("toolset", item.after === "on"), accepted));
    case "mcp":
      return said("MCP servers can't be set up from the card yet.");
  }
}

/** The items Set it up writes, in the card's order: those ticked. */
export const tickedItems = (plan: Plan) => plan.items.filter((i): i is ListedItem => tickable(i) && i.ticked);

/**
 * Runs Set it up over `items`, one at a time, each through `apply`. The Remember row is never a call: it waits for the
 * bot's ready turn. Once a call gets no answer, every item after it fails as not tried, and nothing more is sent.
 * `hear` learns each item's state as it changes, `working` while its call runs.
 */
export async function runSetup(
  items: readonly ListedItem[],
  apply: (item: ListedItem) => Promise<Step>,
  hear: (key: string, state: CardState | { kind: "working" }) => void,
): Promise<{ states: Record<string, CardState>; unanswered?: string }> {
  const states: Record<string, CardState> = {};
  let unanswered: string | undefined;
  const set = (key: string, state: CardState) => {
    states[key] = state;
    hear(key, state);
  };
  for (const item of items) {
    if (item.kind === "remember") set(item.key, { kind: "waiting" });
    else if (unanswered !== undefined) set(item.key, { kind: "failed", miss: { kind: "unsent", text: unanswered } });
    else {
      hear(item.key, { kind: "working" });
      const step = await apply(item).catch((e: unknown) => said(errorText(e), true));
      set(item.key, step.state);
      unanswered ??= step.unanswered;
    }
  }
  return { states, ...(unanswered !== undefined && { unanswered }) };
}

/** The ready turn's first line, for the setup with this id. */
export const botSetupReady = (id: string) => `[highwing:bot-setup ready id=${id}]`;

const ITEM_WORDS: { [K in ListedItem["kind"]]: (i: Extract<ListedItem, { kind: K }>) => string } = {
  persona: () => "your persona (SOUL.md)",
  description: (i) => `your description: ${JSON.stringify(i.after)}`,
  model: (i) => `your model: ${i.after ?? "none"}`,
  color: (i) => `your colour: ${i.after ?? "Hermes's own"}`,
  remember: (i) => `what to call the owner: ${JSON.stringify(i.after)}`,
  skill: (i) => `the skill ${i.name} ${i.after === "on" ? "on" : "off"}${i.from ? ` (copied from ${i.from})` : ""}`,
  toolset: (i) => `the toolset ${i.name} ${i.after === "on" ? "on" : "off"}${i.from ? ` (as ${i.from} has it)` : ""}`,
  mcp: (i) => `the MCP server ${i.name}`,
};
const words = (i: ListedItem) => (ITEM_WORDS[i.kind] as (i: ListedItem) => string)(i);

/**
 * The hidden ready turn after Set it up's writes: what was applied and what wasn't, that the interview is over, the
 * owner's name to save with the bot's own memory tool when the Remember row is ticked, and the record of what the
 * owner accepted, which the card is read against from then on.
 */
export function readyTurn(setupId: string, items: readonly ListedItem[], states: Readonly<Record<string, CardState>>, record: AcceptedRecord): string {
  const applied = items.filter((i) => states[i.key]?.kind === "applied");
  const missed = items.filter((i) => i.kind !== "remember" && states[i.key]?.kind !== "applied");
  const remember = items.find((i): i is Extract<ListedItem, { kind: "remember" }> => i.kind === "remember");
  return [
    botSetupReady(setupId),
    "This message comes from the Highwing app, not from the owner, and the owner doesn't see it. The owner pressed Set it up on your card, so Bot setup is over: don't ask the setup questions again, and draw a new card only if the owner asks to change your setup.",
    applied.length ? `Highwing applied and read back: ${applied.map(words).join("; ")}.` : "Highwing applied nothing.",
    ...(missed.length ? [`Not applied, so the card still offers it: ${missed.map(words).join("; ")}.`] : []),
    ...(remember?.after
      ? [`Save one memory entry now with your memory tool, and nothing else: "The owner wants to be called ${remember.after}."`]
      : ["Don't save anything to memory for Bot setup."]),
    "Then tell the owner in one short sentence that you're set up.",
    "",
    "The block below is Highwing's record of what the owner accepted. Don't repeat it or act on it.",
    acceptedRecordBlock(record),
  ].join("\n");
}

/** What `Hermes.botSetupRestart` found. */
export type BotSetupRestart = { kind: "rebuilt" } | { kind: "unchecked" } | { kind: "read"; tools: ReadonlySet<string>; toolsets: readonly Toolset[] };

/**
 * Whether the Restart row is applied (ADR 0231): Hermes said it rebuilt the bot, or the Bot Chat's own `tools.show`
 * matches what Set it up applied. A toolset turned on matches when the chat offers one of its tools, unless its keys
 * aren't set up, which keeps its tools off whatever is on; one turned off, when the chat offers none of its tools that
 * no toolset still on has too. `unchecked`: `tools.show` can't speak for this bot (ADR 0041).
 */
export function restartState(read: BotSetupRestart, applied: readonly { name: string; on: boolean }[]): "rebuilt" | "matched" | "unchecked" | "notYet" {
  if (read.kind !== "read") return read.kind;
  const on = read.toolsets.filter((t) => t.enabled);
  const matches = applied.every(({ name, on: wanted }) => {
    const t = read.toolsets.find((x) => x.name === name);
    if (!t || t.configOnly || !t.tools.length) return true;
    if (wanted) return !t.configured || t.tools.some((n) => read.tools.has(n));
    return t.tools.every((n) => !read.tools.has(n) || on.some((o) => o.name !== name && o.tools.includes(n)));
  });
  return matches ? "matched" : "notYet";
}
