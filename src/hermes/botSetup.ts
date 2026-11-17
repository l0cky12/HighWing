// New profile's Skills and Tools (ADR 0195): what the owner chose, and the stages after the create that apply it.
// Hermes's create sets neither: it seeds its built-in skills, all on, and its default toolsets. So the create carries
// nothing for them, and once Hermes answers, each choice is applied to the new profile alone and read back: a skill the
// owner turned off through Settings → Skills' switch, a toolset through Settings → Toolsets' change, one at a time. A
// skill the owner wasn't shown is never touched. Every item ends applied, failed with why, or waiting for the owner to
// confirm a caution.
import { ESSENTIAL_SKILLS, safeSkillName, type SkillRow, type SkillsApi } from "./skills";
import { changeableName, type Caution, type Toolset, type ToolsetList, type ToolsetsApi } from "./toolsets";
import { errorText } from "./values";

/** Hermes's defaults for a new profile, or exactly the set `on`. */
export type Choice<T> = { kind: "defaults" } | { kind: "chosen"; on: ReadonlySet<T> };

/** The skills and toolsets (each by the name Hermes lists it by) a new profile starts with. */
export type BotSetup = { skills: Choice<string>; toolsets: Choice<string> };

export const choosing = (s: BotSetup) => s.skills.kind === "chosen" || s.toolsets.kind === "chosen";

/**
 * A built-in skill the owner can have on or off in the new profile. `locked`: it stays on whatever is picked, because
 * Hermes keeps it on (`essential`) or because its name isn't one this app sends to Hermes (`unsendable`).
 */
export type SkillOption = { name: string; description: string; locked?: "essential" | "unsendable" };

const lockOf = (name: string): SkillOption["locked"] => (ESSENTIAL_SKILLS.has(name) ? "essential" : safeSkillName(name) ? undefined : "unsendable");

/** The built-in skills listed for a profile, which Hermes also seeds a new profile with. */
export const skillOptions = (rows: readonly SkillRow[]): SkillOption[] =>
  rows.filter((r) => r.source === "bundled").map((r) => ({ name: r.name, description: r.description, locked: lockOf(r.name) }));

/** A toolset a new profile can have on or off. `on`: as the listed profile has it. `changeable` false: left as Hermes sets it. */
export type ToolsetOption = { name: string; label: string; description: string; on: boolean; changeable: boolean };

export const toolsetOptions = (list: ToolsetList): ToolsetOption[] =>
  list.toolsets.map((t) => ({ name: t.name, label: t.label, description: t.description, on: t.enabled, changeable: changeableName(t.name) }));

/** Why an item isn't as chosen. `said`: Hermes's or the call's own words. `changed`: another client changed it first. */
export type Miss = { kind: "missing" } | { kind: "readOn" } | { kind: "readOff" } | { kind: "changed" } | { kind: "said"; text: string };

/**
 * What Hermes did besides a toolset change it read back as chosen (`ToolsetChange` `saved`), for the owner to hear.
 * `installing`: it started installing these on the server. `warning`: it answered with this error anyway. `mcpBack`: it
 * cleared the platform's `no_mcp`. `everywhereBack`: it took the toolset off `agent.disabled_toolsets`.
 */
export type Note = { kind: "installing"; keys: string } | { kind: "warning"; text: string } | { kind: "mcpBack" } | { kind: "everywhereBack" };

/**
 * Where one item stands. `applied`: read back as chosen, with what else Hermes did, if anything. `confirm`: a toolset
 * change Hermes would make only once the owner accepts `cautions`.
 */
export type ItemState = { kind: "applied"; notes?: Note[] } | { kind: "failed"; miss: Miss } | { kind: "confirm"; cautions: Caution[]; toolset: Toolset };

export type SetupItem = { area: "skill" | "toolset"; name: string; label: string; want: boolean; state: ItemState };

export const allApplied = (items: readonly SetupItem[]) => items.every((i) => i.state.kind === "applied");

/** The skills and toolsets APIs the stages call, each naming the new profile. */
export type SetupApis = { skills: Pick<SkillsApi, "rows" | "setEnabled">; toolsets: Pick<ToolsetsApi, "list" | "set"> };

const APPLIED: ItemState = { kind: "applied" };
const failed = (miss: Miss): ItemState => ({ kind: "failed", miss });

const readBack = (want: boolean, enabled: boolean | undefined): ItemState =>
  enabled === undefined ? failed({ kind: "missing" }) : enabled === want ? APPLIED : failed({ kind: enabled ? "readOn" : "readOff" });

/**
 * One skill as the new profile lists it (`row`, undefined when it isn't), against the choice. A skill chosen on must be
 * listed and on; one chosen off must be off, or not there at all. The first apply and Try again both judge by this.
 */
const skillState = (want: boolean, row: SkillRow | undefined): ItemState => (!row && !want ? APPLIED : readBack(want, row?.enabled));

/** Turns one listed skill on or off through Settings → Skills' switch, and judges what Hermes lists after it. */
async function setSkill(apis: SetupApis, profile: string, item: SetupItem): Promise<SetupItem> {
  try {
    const r = await apis.skills.setEnabled(profile, item.name, item.want);
    const state = skillState(item.want, r.view.skills.find((s) => s.name === item.name));
    return { ...item, state: state.kind !== "applied" && r.lost ? failed({ kind: "said", text: r.lost.message }) : state };
  } catch (e) {
    return { ...item, state: failed({ kind: "said", text: errorText(e) }) };
  }
}

/**
 * Stage (a): makes each skill of `options` on or off on the new profile as chosen. It reads the new profile's skills,
 * leaves alone those already as chosen, and switches the rest one at a time, each read back. Only skills the owner was
 * shown are ever switched; a locked one is only read back.
 */
export async function applySkills(apis: SetupApis, profile: string, options: readonly SkillOption[], on: ReadonlySet<string>): Promise<SetupItem[]> {
  const items: SetupItem[] = options
    .filter((o) => o.locked !== "unsendable")
    .map((o) => ({ area: "skill", name: o.name, label: o.name, want: o.locked === "essential" || on.has(o.name), state: failed({ kind: "missing" }) }));
  let rows: SkillRow[];
  try {
    rows = await apis.skills.rows(profile);
  } catch (e) {
    const miss: Miss = { kind: "said", text: errorText(e) };
    return items.map((i) => ({ ...i, state: failed(miss) }));
  }
  const out: SetupItem[] = [];
  for (const item of items) {
    const row = rows.find((r) => r.name === item.name);
    const state = skillState(item.want, row);
    out.push(state.kind === "applied" || !row ? { ...item, state } : await setSkill(apis, profile, item));
  }
  return out;
}

/** Tries one skill again, as the first apply did it: against a fresh read, switched only if it isn't as chosen. */
export async function retrySkill(apis: SetupApis, profile: string, item: SetupItem): Promise<SetupItem> {
  const [next] = await applySkills(apis, profile, [{ name: item.name, description: "" }], new Set(item.want ? [item.name] : []));
  return { ...item, state: next.state };
}

/** What Hermes did besides the change, from its `saved` answer. */
const notesOf = (r: { installing?: string; warning?: string; mcpBack?: boolean; everywhereBack?: boolean }): Note[] => [
  ...(r.installing ? [{ kind: "installing" as const, keys: r.installing }] : []),
  ...(r.warning ? [{ kind: "warning" as const, text: r.warning }] : []),
  ...(r.mcpBack ? [{ kind: "mcpBack" as const }] : []),
  ...(r.everywhereBack ? [{ kind: "everywhereBack" as const }] : []),
];

/** Sets one toolset, as Hermes had it `current`, then reads it back (`ToolsetsApi.set`). */
async function setToolset(apis: SetupApis, profile: string, item: SetupItem, current: boolean, accepted: Caution[]): Promise<SetupItem> {
  try {
    const r = await apis.toolsets.set(profile, item.name, item.want, current, accepted);
    switch (r.kind) {
      case "saved": {
        const notes = notesOf(r);
        return { ...item, state: notes.length ? { kind: "applied", notes } : APPLIED };
      }
      case "confirm": {
        const toolset = r.list.toolsets.find((t) => t.name === item.name);
        return { ...item, state: toolset ? { kind: "confirm", cautions: r.cautions, toolset } : failed({ kind: "missing" }) };
      }
      case "conflict":
        return { ...item, state: failed({ kind: "changed" }) };
      case "mismatch":
        return { ...item, state: readBack(item.want, r.list.toolsets.find((t) => t.name === item.name)?.enabled) };
      case "rejected":
      case "unknown":
        return { ...item, state: failed({ kind: "said", text: r.reason }) };
    }
  } catch (e) {
    return { ...item, state: failed({ kind: "said", text: errorText(e) }) };
  }
}
/** One toolset against `list`, what Hermes has now: left alone if as chosen, else set and read back. */
async function settleToolset(apis: SetupApis, profile: string, item: SetupItem, list: ToolsetList, accepted: Caution[]): Promise<SetupItem> {
  const row = list.toolsets.find((t) => t.name === item.name);
  if (!row) return { ...item, state: failed({ kind: "missing" }) };
  if (row.enabled === item.want) return { ...item, state: APPLIED };
  return setToolset(apis, profile, item, row.enabled, accepted);
}

/**
 * Stage (b): makes each toolset of `options` on or off as chosen, on the new profile. Those it already has as chosen
 * are left alone; the rest are set one at a time. A caution is never accepted here: it waits for the owner.
 */
export async function applyToolsets(apis: SetupApis, profile: string, options: readonly ToolsetOption[], on: ReadonlySet<string>): Promise<SetupItem[]> {
  const items: SetupItem[] = options.filter((o) => o.changeable).map((o) => ({ area: "toolset", name: o.name, label: o.label, want: on.has(o.name), state: failed({ kind: "missing" }) }));
  let list: ToolsetList;
  try {
    list = await apis.toolsets.list(profile);
  } catch (e) {
    const miss: Miss = { kind: "said", text: errorText(e) };
    return items.map((i) => ({ ...i, state: failed(miss) }));
  }
  const out: SetupItem[] = [];
  for (const item of items) out.push(await settleToolset(apis, profile, item, list, []));
  return out;
}

/** Tries one toolset again, as the first apply did it, against a fresh read. `accepted`: the cautions the owner confirmed with Apply anyway. */
export async function retryToolset(apis: SetupApis, profile: string, item: SetupItem, accepted: Caution[] = []): Promise<SetupItem> {
  try {
    return await settleToolset(apis, profile, item, await apis.toolsets.list(profile), accepted);
  } catch (e) {
    return { ...item, state: failed({ kind: "said", text: errorText(e) }) };
  }
}
