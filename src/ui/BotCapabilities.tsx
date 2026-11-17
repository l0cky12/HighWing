// New profile's Skills, Tools and MCP servers (ADR 0195), and what applying them came to once Hermes made the profile.
// Each area keeps Hermes's defaults unless the owner picks Choose, which reads what there is to choose from then. MCP
// servers can't be chosen: Hermes has no way to copy them to a new profile without their secrets, so a note says so.
// The stages and their outcomes are botSetup.ts; this draws them.
import { useEffect, useId, useRef, useState } from "react";
import {
  allApplied,
  retrySkill,
  retryToolset,
  skillOptions,
  toolsetOptions,
  type BotSetup,
  type Choice,
  type Miss,
  type Note,
  type SetupApis,
  type SetupItem,
  type SkillOption,
  type ToolsetOption,
} from "../hermes/botSetup";
import { SkillsError } from "../hermes/skills";
import { UnsupportedServerError, type Caution, type Toolset } from "../hermes/toolsets";
import { errorText } from "../hermes/values";
import { useLocale, type Locale } from "../i18n/locale";
import { Spinner } from "./bits";
import type { Notice } from "./ProfileSettings";
import { SettingNote } from "./SettingRows";
import { cautionText } from "./ToolsetSettings";

/** What there is to choose from in one area, read on Choose. `unsupported` without a message: nothing to read it with. */
type Inventory<T> = { kind: "unread" } | { kind: "reading" } | { kind: "read"; options: T[] } | { kind: "failed"; message: string } | { kind: "unsupported"; message?: string };

type Option = { name: string };

/**
 * One area's choice. `read` lists the options; `start` is what Choose begins with; `locked` is the value an option keeps
 * whatever is picked, if any; `unsupported` tells a read the server can't answer from one that failed.
 */
function useArea<T extends Option>(
  read: (() => Promise<T[]>) | undefined,
  start: (options: T[]) => string[],
  locked: (option: T) => boolean | undefined,
  unsupported: (e: unknown) => boolean,
) {
  const [inventory, setInventory] = useState<Inventory<T>>(read ? { kind: "unread" } : { kind: "unsupported" });
  const [choice, setChoice] = useState<Choice<string>>({ kind: "defaults" });
  // Each Choose's number: a read that ends after Hermes's defaults were picked again, or the form closed, chooses nothing.
  const wanted = useRef(0);
  useEffect(() => () => void wanted.current++, []);

  const chosenFrom = (options: T[]) => (options.length ? setChoice({ kind: "chosen", on: new Set(start(options)) }) : setChoice({ kind: "defaults" }));
  const choose = async () => {
    if (!read || inventory.kind === "reading") return;
    if (inventory.kind === "read") return chosenFrom(inventory.options);
    const n = ++wanted.current;
    setInventory({ kind: "reading" });
    try {
      const options = await read();
      if (n !== wanted.current) return setInventory({ kind: "read", options });
      setInventory({ kind: "read", options });
      chosenFrom(options);
    } catch (e) {
      if (n === wanted.current) setInventory(unsupported(e) ? { kind: "unsupported", message: errorText(e) } : { kind: "failed", message: errorText(e) });
    }
  };
  const useDefaults = () => {
    wanted.current++;
    if (inventory.kind === "reading") setInventory({ kind: "unread" });
    setChoice({ kind: "defaults" });
  };
  const set = (names: readonly string[], on: boolean) =>
    setChoice((c) => {
      if (c.kind !== "chosen" || inventory.kind !== "read") return c;
      const next = new Set(c.on);
      for (const name of names) {
        const option = inventory.options.find((o) => o.name === name);
        if (!option || locked(option) !== undefined) continue;
        if (on) next.add(name);
        else next.delete(name);
      }
      return { kind: "chosen", on: next };
    });
  return { inventory, choice, choose, useDefaults, set, locked };
}

export type BotSetupState = ReturnType<typeof useBotSetup>;

/** The New form's Skills and Tools choices, read from `profile` (the profile in use) through `apis` when the owner chooses. */
export function useBotSetup(apis: SetupApis | undefined, profile: string) {
  const skills = useArea<SkillOption>(
    apis && (async () => skillOptions(await apis.skills.rows(profile))),
    (options) => options.map((o) => o.name),
    (o) => (o.locked ? true : undefined),
    (e) => e instanceof SkillsError && e.kind === "unsupported",
  );
  const toolsets = useArea<ToolsetOption>(
    apis && (async () => toolsetOptions(await apis.toolsets.list(profile))),
    (options) => options.filter((o) => o.on).map((o) => o.name),
    (o) => (o.changeable ? undefined : o.on),
    (e) => e instanceof UnsupportedServerError,
  );
  const setup: BotSetup = { skills: skills.choice, toolsets: toolsets.choice };
  return { setup, skills, toolsets };
}

type Area<T extends Option> = ReturnType<typeof useArea<T>>;

/** Skills, Tools and MCP servers, after Persona on the New form. */
export function BotCapabilities({ state, profile, disabled }: { state: BotSetupState; profile: string; disabled: boolean }) {
  const l = useLocale();
  const s = l.profiles.form.setup;
  return (
    <>
      <AreaPicker
        area={state.skills}
        title={s.skills}
        filterLabel={s.filterSkills}
        defaultsHint={s.skillsDefaults}
        chosenHint={s.skillsFrom(profile)}
        emptyNote={s.noBuiltIn(profile)}
        disabled={disabled}
        describe={(o: SkillOption) => ({ label: o.name, detail: o.description, lockedWhy: o.locked && s[o.locked] })}
      />
      <AreaPicker
        area={state.toolsets}
        title={s.tools}
        filterLabel={s.filterTools}
        defaultsHint={s.toolsDefaults}
        chosenHint={s.toolsFrom(profile)}
        emptyNote={s.unsupported}
        disabled={disabled}
        describe={(o: ToolsetOption) => ({ label: o.label, detail: o.description, lockedWhy: o.changeable ? undefined : s.unchangeable })}
      />
      <fieldset className="bot-setup">
        <legend className="field-label">{s.mcp}</legend>
        <SettingNote>{s.mcpNote}</SettingNote>
      </fieldset>
    </>
  );
}

function AreaPicker<T extends Option>({
  area,
  title,
  filterLabel,
  defaultsHint,
  chosenHint,
  emptyNote,
  disabled,
  describe,
}: {
  area: Area<T>;
  title: string;
  filterLabel: string;
  defaultsHint: string;
  chosenHint: string;
  emptyNote: string;
  disabled: boolean;
  describe: (o: T) => { label: string; detail: string; lockedWhy?: string };
}) {
  const s = useLocale().profiles.form.setup;
  const group = useId();
  const hintId = useId();
  const [filter, setFilter] = useState("");
  const { inventory, choice } = area;
  const choosing = choice.kind === "chosen" || inventory.kind === "reading";
  const options = inventory.kind === "read" ? inventory.options : [];
  const needle = filter.trim().toLowerCase();
  const shown = needle ? options.filter((o) => [o.name, describe(o).label, describe(o).detail].some((t) => t.toLowerCase().includes(needle))) : options;
  const on = choice.kind === "chosen" ? choice.on : new Set<string>();
  const isOn = (o: T) => area.locked(o) ?? on.has(o.name);
  const cannot = inventory.kind === "unsupported";
  return (
    <fieldset className="bot-setup" disabled={disabled}>
      <legend className="field-label">{title}</legend>
      <div className="bot-setup-modes">
        <label>
          <input type="radio" name={group} checked={!choosing} onChange={area.useDefaults} /> {s.defaults}
        </label>
        <label>
          <input type="radio" name={group} checked={choosing} disabled={cannot} aria-describedby={hintId} onChange={() => void area.choose()} /> {s.choose}
        </label>
      </div>
      <div id={hintId} className="set-hint">
        {cannot ? (inventory.message ? s.unsupportedWhy(inventory.message) : s.unsupported) : choice.kind === "chosen" ? chosenHint : defaultsHint}
      </div>
      {inventory.kind === "reading" && (
        <div className="small muted" role="status">
          <Spinner /> {s.reading}
        </div>
      )}
      {inventory.kind === "failed" && (
        <div className="small sign-in-error" role="alert">
          {s.readFailed(inventory.message)}{" "}
          <button type="button" className="link-btn" onClick={() => void area.choose()}>
            {s.tryAgain}
          </button>
        </div>
      )}
      {inventory.kind === "read" && !options.length && <div className="small muted">{emptyNote}</div>}
      {choice.kind === "chosen" && (
        <>
          <div className="bot-setup-tools">
            <input type="search" aria-label={filterLabel} placeholder={filterLabel} value={filter} onChange={(e) => setFilter(e.target.value)} />
            <span className="small muted" aria-live="polite">
              {s.count(options.filter(isOn).length, options.length)}
            </span>
            <button type="button" className="link-btn" onClick={() => area.set(shown.map((o) => o.name), true)}>
              {s.allOn}
            </button>
            <button type="button" className="link-btn" onClick={() => area.set(shown.map((o) => o.name), false)}>
              {s.allOff}
            </button>
          </div>
          <div className="bot-setup-list">
            {shown.map((o) => (
              <OptionRow key={o.name} option={o} {...describe(o)} on={isOn(o)} locked={area.locked(o) !== undefined} onChange={(next) => area.set([o.name], next)} />
            ))}
            {!shown.length && <div className="small muted bot-setup-none">{s.noneMatch}</div>}
          </div>
        </>
      )}
    </fieldset>
  );
}

function OptionRow<T extends Option>({
  option,
  label,
  detail,
  lockedWhy,
  on,
  locked,
  onChange,
}: {
  option: T;
  label: string;
  detail: string;
  lockedWhy?: string;
  on: boolean;
  locked: boolean;
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  const why = useId();
  // A locked box stays focusable, so its reason is read with it, and ignores a change.
  return (
    <div className="bot-setup-item">
      <input
        id={id}
        type="checkbox"
        checked={on}
        aria-disabled={locked || undefined}
        aria-describedby={lockedWhy ? why : undefined}
        onChange={(e) => !locked && onChange(e.target.checked)}
      />
      <label htmlFor={id}>
        <span className="mono" translate="no">
          {label}
        </span>
        {label !== option.name && (
          <span className="mono muted small" translate="no">
            {" "}
            ({option.name})
          </span>
        )}
        {detail && (
          <span className="muted small bot-setup-detail" translate="no">
            {detail}
          </span>
        )}
        {lockedWhy && (
          <span id={why} className="muted small bot-setup-detail">
            {lockedWhy}
          </span>
        )}
      </label>
    </div>
  );
}

/** What Hermes would do besides the change, which Apply anyway accepts (Settings → Toolsets' own words). */
function Cautions({ cautions, toolset }: { cautions: Caution[]; toolset: Toolset }) {
  const l = useLocale();
  return (
    <div className="small">
      {l.profiles.form.setup.confirmFirst}
      {cautions.map((c, n) => (
        <div key={n} className="profile-conflict">
          {cautionText(c, toolset, l.toolsets.caution)}
        </div>
      ))}
    </div>
  );
}

/** Why an item isn't as chosen, in the catalogue's words. */
function missText(l: Locale, m: Miss): string {
  const s = l.profiles.form.setup;
  switch (m.kind) {
    case "missing":
      return s.missing;
    case "readOn":
      return s.readOn;
    case "readOff":
      return s.readOff;
    case "changed":
      return s.changedElsewhere;
    case "said":
      return m.text;
  }
}

const itemName = (l: Locale, i: SetupItem) => (i.area === "skill" ? l.profiles.form.setup.skill(i.label) : l.profiles.form.setup.toolset(i.label));

/** What Hermes did besides the change, for one applied item, in the catalogue's words. */
function noteText(l: Locale, n: Note, label: string): string {
  const w = l.profiles.form.setup.note;
  switch (n.kind) {
    case "installing":
      return w.installing(n.keys, label);
    case "warning":
      return w.warning(n.text, label);
    case "mcpBack":
      return w.mcpBack(label);
    case "everywhereBack":
      return w.everywhereBack(label);
  }
}

const notesOf = (l: Locale, items: readonly SetupItem[]) => items.flatMap((i) => (i.state.kind === "applied" ? (i.state.notes ?? []).map((n) => noteText(l, n, i.label)) : []));

/**
 * The notice a create with chosen skills or tools closes with: created with them only when every item read back as
 * chosen and the model was set, else, in the bad tone, what isn't as chosen. Either repeats what else Hermes did.
 */
export function outcomeNotice(l: Locale, name: string, items: readonly SetupItem[], modelError?: string): Notice {
  const s = l.profiles.form.setup;
  const notes = notesOf(l, items);
  const warned = items.some((i) => i.state.kind === "applied" && i.state.notes?.some((n) => n.kind === "warning"));
  if (allApplied(items) && !modelError) return { tone: warned ? "warn" : "muted", text: [s.createdWith(name), ...notes].join(" "), open: name };
  const missed = [...items.filter((i) => i.state.kind !== "applied").map((i) => itemName(l, i)), ...(modelError ? [s.theModel] : [])];
  return { tone: "bad", text: [s.keptPartly(name, missed.join(", ")), ...notes].join(" "), open: name };
}

/** How deleting the profile the form made ended: gone, gone with this computer's data for it left, or not deleted. */
export type Removal = { kind: "deleted" } | { kind: "localKept" } | { kind: "failed"; why: string };

/**
 * What applying the owner's choices came to, for a profile Hermes made. Shown only when something isn't as chosen:
 * each such item with why, Try again or Apply anyway, what else Hermes did for those applied, and the profile's fate,
 * Delete it or Keep it as is. Once every item is applied, Done closes with the notice a full success gets.
 * `modelError`: Hermes didn't set the model chosen. `remove` deletes the profile.
 */
export function SetupOutcome({
  name,
  first,
  modelError,
  apis,
  remove,
  onFinish,
}: {
  name: string;
  first: SetupItem[];
  modelError?: string;
  apis: SetupApis;
  remove: () => Promise<Removal>;
  onFinish: (notice: Notice, select?: string) => void;
}) {
  const l = useLocale();
  const s = l.profiles.form.setup;
  const [items, setItems] = useState(first);
  const [working, setWorking] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);
  const key = (i: SetupItem) => `${i.area}:${i.name}`;
  const missed = items.filter((i) => i.state.kind !== "applied");
  const notes = notesOf(l, items);
  const done = allApplied(items) && !modelError;
  const busy = working !== undefined || deleting;

  const again = async (item: SetupItem, accept: boolean) => {
    setWorking(key(item));
    const next =
      item.area === "skill" ? await retrySkill(apis, name, item) : await retryToolset(apis, name, item, accept && item.state.kind === "confirm" ? item.state.cautions : []);
    if (!live.current) return;
    setItems((all) => all.map((i) => (key(i) === key(item) ? next : i)));
    setWorking(undefined);
  };
  const del = async () => {
    setDeleting(true);
    setDeleteError(undefined);
    const r = await remove();
    if (!live.current) return;
    if (r.kind === "deleted") return onFinish({ tone: "warn", text: s.deleted(name) });
    if (r.kind === "localKept") return onFinish({ tone: "bad", text: s.deletedLocalKept(name) });
    setDeleteError(s.deleteFailed(r.why));
    setDeleting(false);
  };
  const finish = () => onFinish(outcomeNotice(l, name, items, modelError), name);

  return (
    <>
      <p role="alert">{done ? s.allApplied : s.outcomeTitle(name)}</p>
      {items.length > 0 && <p className="muted small">{s.applied(items.length - missed.length, items.length)}</p>}
      {modelError && <p className="sign-in-error small">{l.profiles.form.modelNotSet(modelError)}</p>}
      {missed.length > 0 && (
        <ul className="bot-setup-outcome" aria-label={s.notApplied}>
          {missed.map((i) => (
            <li key={key(i)}>
              <span className="bot-setup-outcome-name">{itemName(l, i)}</span>{" "}
              <span className="muted small">{i.want ? s.wantOn : s.wantOff}</span>
              {i.state.kind === "failed" && (
                // Hermes's or the call's own words are data, not the catalogue's.
                <div className="small" translate={i.state.miss.kind === "said" ? "no" : undefined}>
                  {missText(l, i.state.miss)}
                </div>
              )}
              {i.state.kind === "confirm" && <Cautions cautions={i.state.cautions} toolset={i.state.toolset} />}
              <button className="btn" disabled={busy} onClick={() => void again(i, i.state.kind === "confirm")}>
                {working === key(i) ? (
                  <>
                    <Spinner /> {s.working}
                  </>
                ) : i.state.kind === "confirm" ? (
                  s.applyAnyway
                ) : (
                  s.retry
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {notes.length > 0 && (
        <ul className="bot-setup-outcome" aria-label={s.alsoDid}>
          {notes.map((n) => (
            <li key={n} className="small">
              {n}
            </li>
          ))}
        </ul>
      )}
      {deleteError && (
        <p className="sign-in-error small" role="alert">
          {deleteError}
        </p>
      )}
      <div className="confirm-actions">
        {done ? (
          <button className="btn primary" autoFocus onClick={finish}>
            {s.done}
          </button>
        ) : (
          <>
            <button className="btn danger" disabled={busy} onClick={() => void del()}>
              {deleting && <Spinner />} {deleting ? s.deleting : s.deleteIt(name)}
            </button>
            <button className="btn primary" autoFocus disabled={busy} onClick={finish}>
              {s.keep}
            </button>
          </>
        )}
      </div>
    </>
  );
}
