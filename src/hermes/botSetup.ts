// New profile's Skills and Tools (ADR 0195): what the owner chose, what the create carries, and the stages after it.
// Hermes has no create that sets toolsets, and applies a skill choice only best-effort, so nothing here is taken on
// trust: once Hermes answers the create, each choice is read back from the new profile, and a toolset is set and read
// back one at a time. Every item ends applied, failed with why, or waiting for the owner to confirm a caution.
import { ESSENTIAL_SKILLS, type SkillRow, type SkillsApi } from "./skills";
import { changeableName, type Caution, type Toolset, type ToolsetList, type ToolsetsApi } from "./toolsets";
import { errorText } from "./values";

/** Hermes's defaults for a new profile, or exactly the set `on`. */
export type Choice<T> = { kind: "defaults" } | { kind: "chosen"; on: ReadonlySet<T> };

/** The skills (by folder name) and toolsets (by name) a new profile starts with. */
export type BotSetup = { skills: Choice<string>; toolsets: Choice<string> };

export const DEFAULT_SETUP: BotSetup = { skills: { kind: "defaults" }, toolsets: { kind: "defaults" } };

export const choosing = (s: BotSetup) => s.skills.kind === "chosen" || s.toolsets.kind === "chosen";

/** What the create carries for `setup`: nothing for Hermes's defaults, the skills to keep, or none at all. */
export function createFields(setup: BotSetup): { keepSkills?: string[]; noSkills?: true } {
  if (setup.skills.kind === "defaults") return {};
  const keep = [...setup.skills.on].sort();
  return keep.length ? { keepSkills: keep } : { noSkills: true };
}

/** A built-in skill a new profile can keep. `essential`: Hermes keeps it on whatever is asked. */
export type SkillOption = { name: string; description: string; essential: boolean };

/** The built-in skills listed for a profile: the ones Hermes seeds a new profile with. */
export const skillOptions = (rows: readonly SkillRow[]): SkillOption[] =>
  rows.filter((r) => r.source === "bundled").map((r) => ({ name: r.name, description: r.description, essential: ESSENTIAL_SKILLS.has(r.name) }));

/** A toolset a new profile can have on or off. `on`: as the listed profile has it. `changeable` false: left as Hermes sets it. */
export type ToolsetOption = { name: string; label: string; description: string; on: boolean; changeable: boolean };

export const toolsetOptions = (list: ToolsetList): ToolsetOption[] =>
  list.toolsets.map((t) => ({ name: t.name, label: t.label, description: t.description, on: t.enabled, changeable: changeableName(t.name) }));

/** Why an item isn't as chosen. `said`: Hermes's or the call's own words. `changed`: another client changed it first. */
export type Miss = { kind: "missing" } | { kind: "readOn" } | { kind: "readOff" } | { kind: "changed" } | { kind: "said"; text: string };

/** Where one item stands. `confirm`: a toolset change Hermes would make only once the owner accepts `cautions`. */
export type ItemState = { kind: "applied" } | { kind: "failed"; miss: Miss } | { kind: "confirm"; cautions: Caution[]; toolset: Toolset };

export type SetupItem = { area: "skill" | "toolset"; name: string; label: string; want: boolean; state: ItemState };

export const allApplied = (items: readonly SetupItem[]) => items.every((i) => i.state.kind === "applied");

/** The skills and toolsets APIs the stages call, each naming the new profile. */
export type SetupApis = { skills: Pick<SkillsApi, "rows" | "setEnabled">; toolsets: Pick<ToolsetsApi, "list" | "set"> };

const failed = (miss: Miss): ItemState => ({ kind: "failed", miss });
const readBack = (want: boolean, enabled: boolean | undefined): ItemState =>
  enabled === undefined ? failed({ kind: "missing" }) : enabled === want ? { kind: "applied" } : failed({ kind: enabled ? "readOn" : "readOff" });

/**
 * Each skill of `inventory` as `rows` (the new profile's list) has it. A chosen one must be listed and on; one left out
 * must be missing or off.
 */
export function skillsReadBack(inventory: readonly string[], on: ReadonlySet<string>, rows: readonly SkillRow[]): SetupItem[] {
  return inventory.map((name) => {
    const want = on.has(name);
    const row = rows.find((r) => r.name === name);
    const state = !want && (!row || !row.enabled) ? { kind: "applied" as const } : readBack(want, row?.enabled);
    return { area: "skill", name, label: name, want, state };
  });
}

/** Stage (a): reads the new profile's skills back against the choice the create carried. */
export async function checkSkills(apis: SetupApis, profile: string, inventory: readonly string[], on: ReadonlySet<string>): Promise<SetupItem[]> {
  try {
    return skillsReadBack(inventory, on, await apis.skills.rows(profile));
  } catch (e) {
    const miss: Miss = { kind: "said", text: errorText(e) };
    return inventory.map((name) => ({ area: "skill", name, label: name, want: on.has(name), state: failed(miss) }));
  }
}

/** Turns one skill the way the owner chose it, through Settings → Skills' switch, which reads it back. */
export async function retrySkill(apis: SetupApis, profile: string, item: SetupItem): Promise<SetupItem> {
  try {
    const r = await apis.skills.setEnabled(profile, item.name, item.want);
    if (r.confirmed) return { ...item, state: { kind: "applied" } };
    if (r.lost) return { ...item, state: failed({ kind: "said", text: r.lost.message }) };
    return { ...item, state: readBack(item.want, r.view.skills.find((s) => s.name === item.name)?.enabled) };
  } catch (e) {
    return { ...item, state: failed({ kind: "said", text: errorText(e) }) };
  }
}

/** Sets one toolset, as Hermes had it `current`, then reads it back (`ToolsetsApi.set`). */
async function setToolset(apis: SetupApis, profile: string, item: SetupItem, current: boolean, accepted: Caution[]): Promise<SetupItem> {
  try {
    const r = await apis.toolsets.set(profile, item.name, item.want, current, accepted);
    switch (r.kind) {
      case "saved":
        return { ...item, state: { kind: "applied" } };
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
  for (const item of items) {
    const row = list.toolsets.find((t) => t.name === item.name);
    if (!row) out.push(item);
    else if (row.enabled === item.want) out.push({ ...item, state: { kind: "applied" } });
    else out.push(await setToolset(apis, profile, item, row.enabled, []));
  }
  return out;
}

/** Tries one toolset again, against a fresh read. `accepted`: the cautions the owner confirmed with Apply anyway. */
export async function retryToolset(apis: SetupApis, profile: string, item: SetupItem, accepted: Caution[] = []): Promise<SetupItem> {
  let row: Toolset | undefined;
  try {
    row = (await apis.toolsets.list(profile)).toolsets.find((t) => t.name === item.name);
  } catch (e) {
    return { ...item, state: failed({ kind: "said", text: errorText(e) }) };
  }
  if (!row) return { ...item, state: failed({ kind: "missing" }) };
  if (row.enabled === item.want) return { ...item, state: { kind: "applied" } };
  return setToolset(apis, profile, item, row.enabled, accepted);
}
