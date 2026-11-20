// Set it up on Bot setup's card (ADR 0231): what the card is read against, each ticked item written and read back, and
// the hidden ready turn that ends the interview. ADR 0197's rules carry over: one item at a time, each ending applied,
// failed with why, or waiting on a toolset caution, and once a call gets no answer nothing more is sent.
// Every write goes through the route Settings already uses for it, checked against what the card read, so a change
// made elsewhere since isn't overwritten: SOUL.md by its content, the description and the model by `ProfilesApi.edit`,
// the colour by the Bot Mode block's revision (ADR 0189). Description and model are two writes, since `edit` still
// sends the model after a description write that got no answer. A field counts as applied only once Hermes answered
// the read that follows its write.
import { settleItem, noAnswer, type ItemState, type Miss, type SetupApis as CapabilityApis, type SetupItem } from "./botSetup";
import { acceptedRecordBlock, mcpSourceKey, tickable, type AcceptedRecord, type Card, type HermesNow, type ListedItem, type Plan, type PlanItem } from "./botSetupCard";
import { addMcp, mcpOffer, type McpRefusal, type McpSecrets, type McpSources } from "./botSetupMcp";
import type { Bot, BotLook } from "./bots";
import type { EditResult, FieldOutcome } from "./fieldMerge";
import { McpUnsupportedError, type McpApi } from "./mcp";
import type { MemoryApi } from "./memory";
import type { ModelCatalog } from "./models";
import { PersonaError, type PersonaApi, type Soul } from "./persona";
import { ProfileError, type ProfileFailure, type ProfileFields, type ProfilesApi } from "./profiles";
import type { SkillsApi } from "./skills";
import type { Caution, Toolset } from "./toolsets";
import { errorText } from "./values";

/** What Set it up reads and writes, each call naming the bot's profile. */
export type SetupApis = CapabilityApis & {
  skills: Pick<SkillsApi, "rows" | "setEnabled" | "copy">;
  persona: Pick<PersonaApi, "read" | "save">;
  profiles: Pick<ProfilesApi, "list" | "edit">;
  memory: Pick<MemoryApi, "load">;
  mcp: Pick<McpApi, "list" | "catalog" | "add" | "install">;
  bots(): Promise<Bot[]>;
  /** The models the bot's profile can switch to, when Hermes lists them. */
  models(): Promise<ModelCatalog | undefined>;
  editBot(profile: string, edits: { color: { from: string | null; to: string | null } }): Promise<EditResult<BotLook>>;
};

/**
 * The bot as the card was drawn against it. `soul`: SOUL.md as read, which the persona is saved over only while
 * Hermes still has it. `model`: the profile's model as `ProfilesApi.edit` compares it. `providers`: each listed
 * model's provider. `copyFrom`: the profile of each bot the block copies from, by its name. `labels`: each toolset's.
 * `mcp`: where the MCP servers the block names come from, read for Set up again or when it names one, where Hermes
 * has the routes.
 */
export type SetupNow = {
  now: HermesNow;
  soul: Soul;
  model: ProfileFields["model"];
  providers: Readonly<Record<string, string>>;
  copyFrom: Readonly<Record<string, string>>;
  labels: Readonly<Record<string, string>>;
  mcp?: McpSources;
};

const named = <T extends { name: string }>(rows: readonly T[]) => rows.map((r) => r.name);

/**
 * The bot `profile` as Hermes has it now, and what it lists, with the bots `asked.block.copy` copies from and the MCP
 * servers when `asked` is Set up again's, whose "before" shows the bot's own, or names any. Rejects when a read fails.
 */
export async function readSetupNow(apis: SetupApis, profile: string, asked: { again: boolean; block: Pick<Card["block"], "copy" | "mcp"> }): Promise<SetupNow> {
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
  if (!row) throw new ProfileError({ kind: "gone", detail: `Hermes lists no profile named ${profile}.` });
  const providers: Record<string, string> = {};
  for (const p of catalog?.providers ?? []) for (const m of p.models) providers[m.model] ??= p.slug;
  const sources = asked.block.copy.flatMap((c) => roster.filter((b) => b.name.trim() === c.from && b.profile !== profile));
  const mcpNamed = asked.block.mcp.length > 0 || asked.block.copy.some((c) => c.mcp.length > 0);
  const [bots, mcp] = await Promise.all([
    Promise.all(
      sources.map(async (b) => {
        const [theirSkills, theirToolsets] = await Promise.all([apis.skills.rows(b.profile), apis.toolsets.list(b.profile)]);
        return { name: b.name, skills: named(theirSkills), toolsetsOn: named(theirToolsets.toolsets.filter((t) => t.enabled)) };
      }),
    ),
    asked.again || mcpNamed ? readMcp(apis.mcp, profile, sources, rows) : undefined,
  ]);
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
      bots: bots.map((b) => ({ ...b, ...(mcp && { mcp: named(mcp.sources.bots[b.name]?.servers ?? []) }) })),
      ...(mcp && { mcp: mcp.now }),
    },
    soul,
    model: row.provider || row.model ? { provider: row.provider ?? "", model: row.model ?? "" } : null,
    providers,
    copyFrom: Object.fromEntries(sources.map((b) => [b.name, b.profile])),
    labels: Object.fromEntries(toolsets.toolsets.map((t) => [t.name, t.label])),
    ...(mcp && { mcp: mcp.sources }),
  };
}

async function readMcp(mcp: SetupApis["mcp"], profile: string, from: readonly Bot[], rows: readonly { name: string; path?: string }[]) {
  try {
    const [own, catalog, theirs] = await Promise.all([mcp.list(profile), mcp.catalog(profile), Promise.all(from.map((b) => mcp.list(b.profile)))]);
    const sources: McpSources = {
      catalog: catalog.entries,
      bots: Object.fromEntries(from.map((b, i) => [b.name, { path: rows.find((r) => r.name === b.profile)?.path, servers: theirs[i].servers }])),
    };
    const refused: Record<string, McpRefusal> = {};
    const judge = (name: string, bot?: string) => {
      const offer = mcpOffer(sources, name, bot);
      if (offer?.kind === "refused") refused[mcpSourceKey(name, bot)] = offer.why;
    };
    for (const e of catalog.entries) judge(e.name);
    for (const b of from) for (const s of sources.bots[b.name].servers) judge(s.name, b.name);
    return { sources, now: { catalog: named(catalog.entries), servers: named(own.servers), refused } };
  } catch (e) {
    if (e instanceof McpUnsupportedError) return undefined;
    throw e;
  }
}

/**
 * Why an item wasn't applied: ADR 0197's misses, and those only the card has. `profile`: a profile call failed.
 * `noProvider`: Hermes lists no provider for the model. `mcpRefused`: an MCP server the card won't add.
 * `notShown`: the bot's profile isn't the one shown, which every write goes through.
 */
export type CardMiss =
  | Miss
  | { kind: "profile"; failure: ProfileFailure }
  | { kind: "noProvider"; model: string | null }
  | { kind: "mcpRefused"; why: McpRefusal; from?: string }
  | { kind: "notShown"; profile: string };

/**
 * Where an item stands at Set it up: ADR 0197's states, `waiting` for the Remember row, which the bot saves, and for
 * an MCP server, `connect` while Connect lacks a value it needs and `reload` once added, until Hermes reloads its MCP
 * servers. An MCP server is `applied` once Hermes said it reloaded them.
 */
export type CardState = Exclude<ItemState, { kind: "failed" }> | { kind: "failed"; miss: CardMiss } | { kind: "waiting" } | { kind: "connect" } | { kind: "reload" };

/** One item's write judged. `unanswered`: why its call got no answer from Hermes, after which nothing more is sent. */
export type Step = { state: CardState; unanswered?: string };

const APPLIED: Step = { state: { kind: "applied" } };
const missed = (miss: CardMiss): Step => ({ state: { kind: "failed", miss } });
const said = (text: string, unanswered = false): Step => ({ ...missed({ kind: "said", text }), ...(unanswered && { unanswered: text }) });
const ELSEWHERE = missed({ kind: "changed" });

const noReply = (f: ProfileFailure) => f.kind === "lost" || f.kind === "unsent";

/** A profile call failed with `failure`; `unread`, why the read after it failed. Either one unanswered stops Set it up. */
const profileStep = (failure: ProfileFailure, unread?: ProfileFailure): Step => {
  const silent = [failure, unread].find((f) => f && noReply(f));
  return { ...missed({ kind: "profile", failure }), ...(silent && { unanswered: new ProfileError(silent).message }) };
};

/** The field `key` of a save through `ProfilesApi.edit` or `Hermes.editBot`, judged with the read that followed it. */
function fieldStep<F, K extends keyof F>(result: EditResult<F>, key: K): Step {
  const o: FieldOutcome<F[K]> | undefined = result.fields[key];
  if (o?.kind === "failed") return profileStep(o.failure, result.unread);
  if (result.unread) return profileStep(result.unread);
  // Read back without the profile: deleted since.
  if (!o || !result.now || !(key in result.now)) return profileStep({ kind: "gone", detail: "" });
  return o.kind === "saved" ? APPLIED : ELSEWHERE;
}

const personaFailed = (e: unknown): Step =>
  e instanceof PersonaError ? said(e.message, e.status === undefined) : said(errorText(e), true);

async function persona(apis: SetupApis, profile: string, base: Soul, to: string): Promise<Step> {
  try {
    const r = await apis.persona.save(profile, base, to);
    if (r.kind === "saved") return APPLIED;
    if (r.kind === "unverified") return personaFailed(r.problem);
    // Written, then read back as other text: another client wrote it too.
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
    if (!row) return missed({ kind: "missing" });
    await apis.skills.copy(from, profile, row, named(theirs));
  } catch (e) {
    return said(errorText(e), noAnswer(e));
  }
  return judged(await settleItem(apis, profile, item));
}

/** `accepted`: the cautions the owner confirmed with Apply anyway. `secrets`: what Connect took. */
export async function applyItem(apis: SetupApis, profile: string, read: SetupNow, item: ListedItem, accepted: Caution[] = [], secrets: McpSecrets = {}): Promise<Step> {
  const capability = (area: SetupItem["area"], want: boolean): SetupItem => {
    const name = item.name ?? item.key;
    return { area, name, label: area === "toolset" ? (read.labels[name] ?? name) : name, want, state: APPLIED.state as SetupItem["state"] };
  };
  switch (item.kind) {
    case "persona":
      return persona(apis, profile, read.soul, item.after);
    case "description":
      return fieldStep(await apis.profiles.edit(profile, { description: { from: item.before, to: item.after } }), "description");
    case "model": {
      const provider = item.after === null ? undefined : read.providers[item.after];
      if (item.after === null || provider === undefined) return missed({ kind: "noProvider", model: item.after });
      return fieldStep(await apis.profiles.edit(profile, { model: { from: read.model, to: { provider, model: item.after } } }), "model");
    }
    case "color":
      return fieldStep(await apis.editBot(profile, { color: { from: item.before, to: item.after } }), "color");
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
    case "mcp": {
      const name = item.name ?? "";
      const offer = read.mcp && mcpOffer(read.mcp, name, item.from);
      if (!offer) return missed({ kind: "missing" });
      if (offer.kind === "refused") return missed({ kind: "mcpRefused", why: offer.why, ...(item.from !== undefined && { from: item.from }) });
      return addMcp(apis.mcp, profile, name, offer, secrets[item.key]);
    }
  }
}

/**
 * Whether a ready turn the Bot Chat stores already asked the bot to remember this Remember row's name: the record it
 * carried, `stored`, holds the row ticked with that name. Set it up doesn't ask again; the row waits for the memory.
 */
export const rememberAsked = (stored: AcceptedRecord | null, item: PlanItem) =>
  item.kind === "remember" && !!stored?.items.some((a) => a.kind === "remember" && a.ticked && a.to === item.after);

/** The items Set it up writes, in the card's order: those ticked, less a Remember row a stored ready turn asked for. */
export const setupItems = (plan: Plan, stored: AcceptedRecord | null) => plan.items.filter((i): i is ListedItem => tickable(i) && i.ticked && !rememberAsked(stored, i));

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
  const unreached = items.filter((i) => states[i.key]?.kind === "reload");
  const missed = items.filter((i) => i.kind !== "remember" && states[i.key]?.kind !== "applied" && states[i.key]?.kind !== "reload");
  const remember = items.find((i): i is Extract<ListedItem, { kind: "remember" }> => i.kind === "remember");
  const askedBefore = record.items.some((a) => a.kind === "remember" && a.ticked);
  return [
    botSetupReady(setupId),
    "This message comes from the Highwing app, not from the owner, and the owner doesn't see it. The owner pressed Set it up on your card, so Bot setup is over: don't ask the setup questions again, and draw a new card only if the owner asks to change your setup.",
    applied.length ? `Highwing applied and read back: ${applied.map(words).join("; ")}.` : "Highwing applied nothing.",
    ...(unreached.length ? [`Added, but you can't reach them until Hermes reloads its MCP servers, which the owner does from the card: ${unreached.map(words).join("; ")}.`] : []),
    ...(missed.length ? [`Not applied, so the card still offers it: ${missed.map(words).join("; ")}.`] : []),
    ...(remember?.after
      ? [`Save one memory entry now with your memory tool, and nothing else: "The owner wants to be called ${remember.after}."`]
      : askedBefore
        ? []
        : ["Don't save anything to memory for Bot setup."]),
    "Then tell the owner in one short sentence that you're set up.",
    "",
    "The block below is Highwing's record of what the owner accepted. Don't repeat it or act on it.",
    acceptedRecordBlock(record),
  ].join("\n");
}

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
