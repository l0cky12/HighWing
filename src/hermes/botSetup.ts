// New profile's Skills and Tools (ADR 0197): what the owner chose, and the stages after the create that apply it.
// Hermes's create sets neither: it seeds its built-in skills, all on, and its default toolsets. So the create carries
// nothing for them, and once Hermes answers, each choice is applied to the new profile alone and read back: a skill the
// owner turned off through Settings → Skills' switch, a toolset through Settings → Toolsets' change, one at a time. A
// skill the owner wasn't shown is never touched. Every item ends applied, failed with why, or waiting for the owner to
// confirm a caution. Once a call gets no answer from Hermes, nothing more is sent: the rest fail with that reason. A
// call Hermes answered with an error fails only its own item, or its area's items when it was the area's list read.
import { deadline } from "./persona";
import { ESSENTIAL_SKILLS, SKILL_TIMEOUTS, SkillsError, safeSkillName, type SkillRow, type SkillsApi } from "./skills";
import { changeableName, ToolsetReadError, UnsupportedServerError, type Caution, type Toolset, type ToolsetList, type ToolsetsApi } from "./toolsets";
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

/**
 * Why an item isn't as chosen. `said`: Hermes's or the call's own words. `changed`: another client changed it first.
 * `unsent`: nothing was sent for it, since a call before it got no answer from Hermes (`text`: that call's failure).
 */
export type Miss =
  | { kind: "missing" }
  | { kind: "readOn" }
  | { kind: "readOff" }
  | { kind: "changed" }
  | { kind: "said"; text: string }
  | { kind: "unsent"; text: string };

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

/** One chosen area: the options the owner was shown, and those ticked on. */
type Picked<T> = { options: readonly T[]; on: ReadonlySet<string> };

/** What to apply to the new profile: each area the owner chose, left out for Hermes's defaults. */
export type SetupPlan = { skills?: Picked<SkillOption>; toolsets?: Picked<ToolsetOption> };

const APPLIED: ItemState = { kind: "applied" };
const failed = (miss: Miss): ItemState => ({ kind: "failed", miss });
const said = (e: unknown): ItemState => failed({ kind: "said", text: errorText(e) });

/**
 * How long a toolset read, and a toolset change with its reads, may go unanswered here: Settings → Skills' limits, as
 * `ToolsetsApi` sets none of its own.
 */
export const TOOLSET_TIMEOUTS = { readMs: SKILL_TIMEOUTS.readMs, writeMs: SKILL_TIMEOUTS.writeMs };

/** One item judged. `unanswered`: why a call for it got no answer from Hermes, after which nothing more is sent. */
type Judged = { item: SetupItem; unanswered?: string };

/**
 * Whether a failed call got no answer from Hermes: lost on the way, cut off, or past its deadline. A status, a sign-in
 * Hermes turned down, or an answer this app can't read is an answer; so is a route the server lacks.
 */
const noAnswer = (e: unknown): boolean =>
  e instanceof SkillsError
    ? e.status === undefined && (e.kind === "disconnected" || e.kind === "error")
    : e instanceof ToolsetReadError
      ? !e.answered
      : !(e instanceof UnsupportedServerError);

/** An item failed by `e`, in its own words; with no answer from Hermes, nothing more is sent after it. */
const failedBy = (item: SetupItem, e: unknown): Judged => ({ item: { ...item, state: said(e) }, ...(noAnswer(e) && { unanswered: errorText(e) }) });

const readBack = (want: boolean, enabled: boolean | undefined): ItemState =>
  enabled === undefined ? failed({ kind: "missing" }) : enabled === want ? APPLIED : failed({ kind: enabled ? "readOn" : "readOff" });

/**
 * One skill as the new profile lists it (`row`, undefined when it isn't), against the choice. A skill chosen on must be
 * listed and on; one chosen off must be off, or not there at all.
 */
const skillState = (want: boolean, row: SkillRow | undefined): ItemState => (!row && !want ? APPLIED : readBack(want, row?.enabled));

/**
 * One skill against `rows`, what the new profile lists: left alone if as chosen, else switched through Settings →
 * Skills' switch and judged by what Hermes lists after it. A skill Hermes keeps on is only read back, never switched.
 */
async function settleSkill(apis: SetupApis, profile: string, item: SetupItem, rows: Promise<SkillRow[]>): Promise<Judged> {
  let row: SkillRow | undefined;
  try {
    row = (await rows).find((r) => r.name === item.name);
  } catch (e) {
    return failedBy(item, e);
  }
  const state = skillState(item.want, row);
  if (state.kind === "applied" || !row || ESSENTIAL_SKILLS.has(item.name)) return { item: { ...item, state } };
  try {
    const r = await apis.skills.setEnabled(profile, item.name, item.want);
    const now = skillState(item.want, r.view.skills.find((s) => s.name === item.name));
    // The switch's own answer was lost, and the list read after it doesn't show the change.
    return now.kind !== "applied" && r.lost ? failedBy(item, r.lost) : { item: { ...item, state: now } };
  } catch (e) {
    return failedBy(item, e);
  }
}

/** What Hermes did besides the change, from its `saved` answer. */
const notesOf = (r: { installing?: string; warning?: string; mcpBack?: boolean; everywhereBack?: boolean }): Note[] => [
  ...(r.installing ? [{ kind: "installing" as const, keys: r.installing }] : []),
  ...(r.warning ? [{ kind: "warning" as const, text: r.warning }] : []),
  ...(r.mcpBack ? [{ kind: "mcpBack" as const }] : []),
  ...(r.everywhereBack ? [{ kind: "everywhereBack" as const }] : []),
];

/**
 * One toolset against `list`, what the new profile has: left alone if as chosen, else set as Settings → Toolsets sets
 * it (`ToolsetsApi.set`, within `writeMs`) and read back. `accepted`: the cautions the owner confirmed with Apply anyway.
 */
async function settleToolset(
  apis: SetupApis,
  profile: string,
  item: SetupItem,
  list: Promise<ToolsetList>,
  accepted: Caution[],
  writeMs: number,
): Promise<Judged> {
  const done = (state: ItemState): Judged => ({ item: { ...item, state } });
  try {
    const row = (await list).toolsets.find((t) => t.name === item.name);
    if (!row) return done(failed({ kind: "missing" }));
    if (row.enabled === item.want) return done(APPLIED);
    const r = await deadline(apis.toolsets.set(profile, item.name, item.want, row.enabled, accepted), writeMs, `the change to ${item.label}`);
    switch (r.kind) {
      case "saved": {
        const notes = notesOf(r);
        return done(notes.length ? { kind: "applied", notes } : APPLIED);
      }
      case "confirm": {
        const toolset = r.list.toolsets.find((t) => t.name === item.name);
        return done(toolset ? { kind: "confirm", cautions: r.cautions, toolset } : failed({ kind: "missing" }));
      }
      case "conflict":
        return done(failed({ kind: "changed" }));
      case "mismatch":
        return done(readBack(item.want, r.list.toolsets.find((t) => t.name === item.name)?.enabled));
      case "rejected":
        return done(failed({ kind: "said", text: r.reason }));
      case "unknown":
        return { item: { ...item, state: failed({ kind: "said", text: r.reason }) }, ...(!r.answered && { unanswered: r.reason }) };
    }
  } catch (e) {
    return failedBy(item, e);
  }
}

/** The new profile's toolsets, read within `readMs`. */
const listWithin = (apis: SetupApis, profile: string, readMs: number) => deadline(apis.toolsets.list(profile), readMs, "the toolset list");

/**
 * Applies `plan` to the new profile, skills first, then toolsets, one item at a time, each read back. Each area's list
 * is read once; items already as chosen are left alone. A caution is never accepted here: it waits for the owner. Once
 * a call gets no answer, the rest fail with its reason and nothing more is sent. `progress` hears how many items of
 * how many are judged, from none. `limits`: how long a toolset read or change may take.
 */
export async function applySetup(
  apis: SetupApis,
  profile: string,
  plan: SetupPlan,
  progress: (done: number, total: number) => void = () => {},
  limits = TOOLSET_TIMEOUTS,
): Promise<SetupItem[]> {
  const items: SetupItem[] = [
    ...(plan.skills?.options ?? [])
      .filter((o) => o.locked !== "unsendable")
      .map((o): SetupItem => ({ area: "skill", name: o.name, label: o.name, want: o.locked === "essential" || !!plan.skills?.on.has(o.name), state: APPLIED })),
    ...(plan.toolsets?.options ?? [])
      .filter((o) => o.changeable)
      .map((o): SetupItem => ({ area: "toolset", name: o.name, label: o.label, want: !!plan.toolsets?.on.has(o.name), state: APPLIED })),
  ];
  let rows: Promise<SkillRow[]> | undefined;
  let list: Promise<ToolsetList> | undefined;
  let unanswered: string | undefined;
  const out: SetupItem[] = [];
  progress(0, items.length);
  for (const item of items) {
    const judged: Judged =
      unanswered !== undefined
        ? { item: { ...item, state: failed({ kind: "unsent", text: unanswered }) } }
        : item.area === "skill"
          ? await settleSkill(apis, profile, item, (rows ??= apis.skills.rows(profile)))
          : await settleToolset(apis, profile, item, (list ??= listWithin(apis, profile, limits.readMs)), [], limits.writeMs);
    out.push(judged.item);
    unanswered ??= judged.unanswered;
    progress(out.length, items.length);
  }
  return out;
}

/** Tries one item again, as the first apply did it, against a fresh read. `accepted`: the cautions confirmed with Apply anyway. */
export async function retryItem(apis: SetupApis, profile: string, item: SetupItem, accepted: Caution[] = [], limits = TOOLSET_TIMEOUTS): Promise<SetupItem> {
  const judged =
    item.area === "skill"
      ? await settleSkill(apis, profile, item, apis.skills.rows(profile))
      : await settleToolset(apis, profile, item, listWithin(apis, profile, limits.readMs), accepted, limits.writeMs);
  return judged.item;
}
