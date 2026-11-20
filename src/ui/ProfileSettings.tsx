// Settings → Profiles (ADR 0156): every profile Hermes lists, made, cloned, renamed, described, given a model and
// deleted from one place. Switching stays in the chat list's header (ADR 0001): Open here goes through the same
// question and guard. Every word comes from the catalogue (ADR 0100).
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Brain, Copy, FolderOpen, Keyboard, MoreHorizontal, Pencil, Plus, Puzzle, RefreshCw, Sparkles, Trash2, TriangleAlert, Wand2 } from "lucide-react";
import { BOT_LOOK_SAME, BOT_PICTURE_MAX_BYTES, type BotLook } from "../hermes/bots";
import type { CapabilityStore } from "../hermes/capabilities";
import { allSaved, editsOf, rebase, type EditResult, type Edits, type FieldOutcome } from "../hermes/fieldMerge";
import type { CatalogProvider } from "../hermes/modelSettings";
import { asReadBack, type PersonaApi, type Soul } from "../hermes/persona";
import type { ProfileCloneApi } from "../hermes/profileClone";
import type { BotSetupRefusal } from "../hermes/botSetupStart";
import type { NewBotHow } from "../hermes/newBot";
import type { PendingRename } from "../hermes/profileLocalData";
import {
  DISPLAY_NAME_MAX,
  PROFILE_FIELDS_SAME,
  PROFILE_ROUTES,
  ProfileError,
  nameIssue,
  profileFailure,
  profileFieldsOf,
  type ProfileAction,
  type ProfileFailure,
  type ProfileFields,
  type ProfileRow,
  type ProfilesApi,
} from "../hermes/profiles";
import { errorText } from "../hermes/values";
import { useLocale, type Locale } from "../i18n/locale";
import { Spinner, composing } from "./bits";
import { Menu } from "./ChatMenu";
import { CloneProfileDialog } from "./CloneProfile";
import { NewBot } from "./NewBot";
import { useModal } from "./modal";
import { RephraseButton, RephrasePanel, usePersonaRephrase } from "./PersonaRephrase";
import type { Writer } from "../hermes/writingModel";
import { SettingNote, SettingsSection } from "./SettingRows";
import { HeadPart, useInPage } from "./SettingsPage";

/** What keeps a profile from being renamed now: a reply running in it (`title`, when known), or a queue about to send. */
export type ProfileBusy = { kind: "reply"; title?: string } | { kind: "queue" };

/** What Settings → Profiles needs from the app. */
export type ProfilesWiring = {
  api: ProfilesApi;
  /** The Clone profile dialog's API (ADR 0074); without it there is no Clone. */
  clone?: ProfileCloneApi;
  /** What the connected Hermes lacks; a route found missing disables its action. */
  capabilities?: CapabilityStore;
  /** The profile the app shows. */
  inUse: string;
  connected: boolean;
  /** Unread chats in a profile not shown, as the switcher's last check found them. */
  unread: (name: string) => number | undefined;
  /** The models Settings → Model offers, for the model pickers. */
  catalog: () => Promise<CatalogProvider[]>;
  /** Whether work running in `name` keeps it from being renamed now. */
  busy: (name: string) => ProfileBusy | undefined;
  /** Queued and Failed messages holding text in `name`, which deleting it loses. */
  lostMessages: (name: string) => number;
  /** How many scheduled jobs `name` has; undefined when that couldn't be read. */
  jobCount: (name: string) => Promise<number | undefined>;
  /** The Approval or Question waiting in the profile in use, which switching away asks about first, as the switcher does. */
  leaving?: string;
  /**
   * Switches the app to `name` through the switcher's own path: its guard asks about unsaved edits first. Resolves
   * false when the owner stayed. `keepSettings`: Settings stays open (a delete goes on after the switch).
   */
  switchTo: (name: string, keepSettings?: boolean) => Promise<boolean>;
  /** This computer's data for the profiles on this connection (profileLocalData.ts). */
  local: {
    /** A rename made on the server whose move here may not have finished. */
    pending: () => PendingRename | undefined;
    note: (from: string, to: string) => void;
    clear: () => void;
    /** Moves this computer's data from `from` to `to`; when `from` is in use, the app moves to `to` in place. */
    renamed: (from: string, to: string) => Promise<void>;
    /** Forgets this computer's data for `name`. */
    deleted: (name: string) => Promise<void>;
  };
  /** Shows Settings → Memory or Skills on `name`. */
  showTab: (tab: "memory" | "skills", name: string) => void;
  copyText: (text: string) => Promise<void>;
  /**
   * Write with AI on Edit's Persona (ADR 0206), run as the profile edited on the model that writes for it
   * (writingModel.ts, ADR 0209). Given only while connected.
   */
  rephrase?: (profile: string) => Writer;
  /** Each profile's SOUL.md, which Edit reads as it opens and saves with the form (ADR 0206); without it Edit has no Persona. */
  persona?: PersonaApi;
  /** Told whether the open form holds a persona Hermes doesn't have, and whose, so leaving the screen asks first. */
  onPersonaDirty?: (dirty: boolean, profile: string) => void;
  /** Bumped each time the owner discards an unsaved persona on leaving: an open form closes, dropping it. */
  personaDiscards?: number;
  /**
   * Makes a bot named `name` from New bot or New profile (ADR 0231) and opens it as a Bot visit, with Bot setup's
   * interview started unless `how` is blank or Hermes runs none. Resolves the new profile's id, and whether the app
   * went to it. Rejects when the create failed.
   */
  makeBot: (name: string, how: NewBotHow) => Promise<{ profile: string; visited: boolean }>;
  /** Why this Hermes runs no Bot setup (`Hermes.botSetupOff`), for the name dialog to say. */
  botSetupOff: () => BotSetupRefusal | undefined;
};

/** How long a rename or delete runs before its button says the gateway is being stopped. */
const STOPPING_AFTER_MS = 1500;

/** A note the tab shows above the list after something happened. `open`: offer to open that profile. `command`: a command to copy. */
export type Notice = { tone: "muted" | "warn" | "bad"; text: string; open?: string; command?: string };

type Dialog =
  | { kind: "new" }
  | { kind: "edit"; row: ProfileRow; focus?: FormFocus }
  | { kind: "delete"; row: ProfileRow }
  | { kind: "clone"; source: string; name?: string };

const NO_STORE = { subscribe: () => () => {}, getSnapshot: () => undefined };

/** The words for a failed profile call. */
export function failureText(l: Locale, f: ProfileFailure, name: string): string {
  const w = l.profiles;
  switch (f.kind) {
    case "noRoute":
      return w.noRoute(PROFILE_ROUTES[f.action]);
    case "gone":
      return w.form.gone(name);
    case "refused":
      return f.detail ? w.form.refused(f.detail) : w.form.refusedNoReason;
    case "lost":
      return w.form.lost(f.message);
    case "unsent":
      return f.message;
    case "contended":
      return w.form.contended;
    case "noCheck":
      return w.form.noCheck;
    case "pictureUnconfirmed":
      return w.form.pictureUnconfirmed;
  }
}

/** Why `action` can't run now, or nothing: not connected, or the server lacks its route. */
export function blocked(l: Locale, connected: boolean, lacks: (a: ProfileAction) => boolean, action: ProfileAction): string | undefined {
  if (!connected) return l.profiles.notConnected;
  if (lacks(action)) return l.profiles.noRoute(PROFILE_ROUTES[action]);
  return undefined;
}

/** A profile's name as shown: `default`'s display name first, when it has one. */
export const rowName = (l: Locale, p: Pick<ProfileRow, "name" | "displayName">) => (p.displayName && p.displayName !== p.name ? l.profiles.named(p.displayName, p.name) : p.name);

/**
 * Switching to a profile through the switcher's question, then its guard, for a screen that switches as part of
 * something else (a delete of the profile in use). `question`: the question while it's asked, for the screen to draw
 * on top of any dialog, which stays.
 */
export function useSwitchTo(wiring: Pick<ProfilesWiring, "leaving" | "switchTo">) {
  const [ask, setAsk] = useState<{ to: string; answer: (go: boolean) => void }>();
  /** Resolves whether the app switched. */
  const switchTo = (name: string, keepSettings = false) =>
    new Promise<boolean>((done) => {
      const go = () => void wiring.switchTo(name, keepSettings).then(done, () => done(false));
      if (!wiring.leaving) return go();
      setAsk({
        to: name,
        answer: (yes) => {
          setAsk(undefined);
          if (yes) go();
          else done(false);
        },
      });
    });
  const question = ask && <SwitchQuestion to={ask.to} note={wiring.leaving ?? ""} onStay={() => ask.answer(false)} onGo={() => ask.answer(true)} />;
  return { switchTo, question };
}

export function ProfileSettings({ wiring }: { wiring: ProfilesWiring }) {
  const l = useLocale();
  const w = l.profiles;
  const { api, connected, inUse } = wiring;
  // Drawn again when the server is found to lack a route.
  const store = wiring.capabilities ?? NO_STORE;
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [rows, setRows] = useState<ProfileRow[]>();
  const [listError, setListError] = useState<string>();
  const [reading, setReading] = useState(false);
  const [selected, setSelected] = useState(inUse);
  const selectedNow = useRef(selected);
  selectedNow.current = selected;
  const [dialog, setDialog] = useState<Dialog>();
  const [notice, setNotice] = useState<Notice>();
  const [offer, setOffer] = useState<PendingRename>();
  const [menu, setMenu] = useState<{ row: ProfileRow; x: number; y: number }>();
  const { switchTo, question } = useSwitchTo(wiring);
  const listRef = useRef<HTMLDivElement>(null);
  /** The selected row, where each dialog puts focus back. */
  const selectedRow = useRef<HTMLDivElement>(null);
  /** Counts list reads: only the latest one's answer is shown, so an older read can't put back a row since changed. */
  const readGen = useRef(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);
  const lacking = (a: ProfileAction) => !!wiring.capabilities?.lacksAction("profiles", a);

  /** Reads the list. Resolves to the row selected after it, or undefined when a newer read or a failure took over. */
  const read = async (select?: string): Promise<string | undefined> => {
    const gen = ++readGen.current;
    setReading(true);
    try {
      const listed = await api.list();
      if (!live.current || gen !== readGen.current) return undefined;
      setRows(listed);
      setListError(undefined);
      const kept = (s: string) => (listed.some((p) => p.name === s) ? s : (listed.find((p) => p.name === inUse)?.name ?? listed[0]?.name ?? s));
      const next = select && listed.some((p) => p.name === select) ? select : kept(selectedNow.current);
      setSelected(next);
      // A rename the app closed in the middle of: Hermes renamed it, but this computer's data may not have moved.
      const pending = wiring.local.pending();
      if (pending) {
        const from = listed.some((p) => p.name === pending.from);
        const to = listed.some((p) => p.name === pending.to);
        if (!from && to) setOffer(pending);
        else {
          wiring.local.clear();
          setOffer(undefined);
        }
      }
      return next;
    } catch (e) {
      if (live.current && gen === readGen.current) setListError(failureText(l, profileFailure(e, "create"), ""));
      return undefined;
    } finally {
      if (live.current && gen === readGen.current) setReading(false);
    }
  };
  useEffect(() => {
    if (connected) void read();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per connect; `read` is a new function every render
  }, [connected]);

  const focusRow = (name: string) => requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-profile="${CSS.escape(name)}"]`)?.focus());

  const moveDone = async (p: PendingRename) => {
    setOffer(undefined);
    try {
      await wiring.local.renamed(p.from, p.to);
      wiring.local.clear();
      setNotice({ tone: "muted", text: w.moved(p.to) });
    } catch {
      setNotice({ tone: "warn", text: w.movePartly(p.from, p.to) });
    }
  };

  const openMenu = (row: ProfileRow, x: number, y: number) => {
    setSelected(row.name);
    setMenu({ row, x, y });
  };
  const menuAt = (row: ProfileRow, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    openMenu(row, r.left + 24, r.bottom);
  };

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!rows?.length || composing(e)) return;
    const at = rows.findIndex((p) => p.name === selected);
    const row = rows[at];
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
      setSelected(rows[next].name);
      focusRow(rows[next].name);
    } else if (!row) return;
    else if (e.key === "Enter") {
      e.preventDefault();
      setDialog({ kind: "edit", row });
    } else if (e.key === "Delete") {
      e.preventDefault();
      if (row.name !== "default" && connected && !lacking("remove")) setDialog({ kind: "delete", row });
    } else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      e.preventDefault();
      const el = listRef.current?.querySelector<HTMLElement>(`[data-profile="${CSS.escape(row.name)}"]`);
      if (el) menuAt(row, el);
    }
  };

  const inUseGone = rows !== undefined && !rows.some((p) => p.name === inUse);
  const newBlocked = blocked(l, connected, lacking, "create");

  // Under Settings' page header (ADR 0160) New profile and Reload are the page's actions; every re-read is a labelled Reload.
  const inPage = useInPage();
  const actions = (
    <>
      <button className="btn" disabled={!!newBlocked} title={newBlocked} onClick={() => setDialog({ kind: "new" })}>
        <Plus size={14} aria-hidden /> {w.newProfile}
      </button>
      <button className="btn" title={w.refresh} disabled={!connected || reading} onClick={() => void read()}>
        {reading ? <Spinner /> : <RefreshCw size={14} aria-hidden />} {w.reload}
      </button>
    </>
  );
  return (
    <>
      {inPage && <HeadPart at="actions">{actions}</HeadPart>}
      <SettingsSection bare={inPage} title={w.title} intro={w.intro} more={<p>{w.more}</p>} action={!inPage && actions}>
        {!connected && rows && <SettingNote tone="warn">{w.stale}</SettingNote>}
        {listError && (
          <SettingNote tone="bad" role="alert">
            {listError}{" "}
            <button className="link-btn" disabled={!connected} onClick={() => void read()}>
              {w.tryAgain}
            </button>
          </SettingNote>
        )}
        {inUseGone && connected && (
          <SettingNote tone="warn" role="status">
            {w.inUseGone(inUse)}{" "}
            <button className="link-btn" onClick={() => void switchTo("default")}>
              {w.openDefault}
            </button>
          </SettingNote>
        )}
        {offer && (
          <SettingNote tone="warn" role="status">
            {w.moveOffer(offer.from, offer.to)}{" "}
            <button className="link-btn" onClick={() => void moveDone(offer)}>
              {w.move}
            </button>{" "}
            <button
              className="link-btn"
              onClick={() => {
                wiring.local.clear();
                setOffer(undefined);
              }}
            >
              {w.leave}
            </button>
          </SettingNote>
        )}
        {notice && (
          <SettingNote tone={notice.tone} role={notice.tone === "bad" ? "alert" : "status"}>
            {notice.text}
            {notice.command && (
              <>
                {" "}
                <code translate="no">{notice.command}</code> <CopyButton text={notice.command} copy={wiring.copyText} />
              </>
            )}
            {notice.open && (
              <>
                {" "}
                <button className="link-btn" onClick={() => void switchTo(notice.open!)}>
                  {w.openNow(notice.open)}
                </button>
              </>
            )}{" "}
            <button className="link-btn" onClick={() => setNotice(undefined)}>
              {w.dismiss}
            </button>
          </SettingNote>
        )}
        {!rows && !listError && (
          <div className="profile-rows" aria-busy="true" aria-label={w.loading}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="profile-row skeleton" aria-hidden />
            ))}
          </div>
        )}
        {rows && (
          <div
            ref={listRef}
            className={`profile-rows ${!connected ? "stale" : ""}`}
            role="listbox"
            aria-label={w.list}
            aria-describedby="profiles-keys"
            onKeyDown={onListKey}
          >
            {rows.map((row) => (
              <ProfileRowView
                key={row.name}
                row={row}
                selected={row.name === selected}
                rowRef={row.name === selected ? selectedRow : undefined}
                inUse={row.name === inUse}
                unread={row.name === inUse ? undefined : wiring.unread(row.name)}
                onSelect={() => setSelected(row.name)}
                onEdit={() => setDialog({ kind: "edit", row })}
                onMenu={(x, y) => openMenu(row, x, y)}
                onMenuButton={(el) => menuAt(row, el)}
              />
            ))}
          </div>
        )}
        <details className="set-fold">
          <summary>
            <Keyboard size={14} aria-hidden /> {w.keysTitle}
          </summary>
          <p id="profiles-keys" className="muted small profile-keys">
            {w.keys}
          </p>
        </details>
      </SettingsSection>

      {menu && (
        <Menu label={w.actionsOf(menu.row.name)} x={menu.x} y={menu.y} onClose={() => setMenu(undefined)}>
          <MenuEntry
            icon={<FolderOpen size={15} />}
            label={w.menu.open}
            why={menu.row.name === inUse ? w.openInUse : !connected ? w.notConnected : undefined}
            onPick={() => {
              setMenu(undefined);
              void switchTo(menu.row.name);
            }}
          />
          <MenuEntry
            icon={<Pencil size={15} />}
            label={w.menu.edit}
            onPick={() => {
              setMenu(undefined);
              setDialog({ kind: "edit", row: menu.row });
            }}
          />
          {wiring.clone && (
            <MenuEntry
              icon={<Copy size={15} />}
              label={w.menu.clone}
              why={blocked(l, connected, lacking, "create")}
              onPick={() => {
                setMenu(undefined);
                setDialog({ kind: "clone", source: menu.row.name });
              }}
            />
          )}
          {wiring.persona && (
            <MenuEntry
              icon={<Sparkles size={15} />}
              label={w.menu.persona}
              onPick={() => {
                setMenu(undefined);
                setDialog({ kind: "edit", row: menu.row, focus: "persona" });
              }}
            />
          )}
          <div className="menu-sep" role="separator" />
          {(
            [
              ["memory", <Brain size={15} key="i" />, w.menu.memory],
              ["skills", <Puzzle size={15} key="i" />, w.menu.skills],
            ] as const
          ).map(([tab, icon, label]) => (
            <MenuEntry
              key={tab}
              icon={icon}
              label={label}
              onPick={() => {
                setMenu(undefined);
                wiring.showTab(tab, menu.row.name);
              }}
            />
          ))}
          <div className="menu-sep" role="separator" />
          <MenuEntry
            icon={<Trash2 size={15} />}
            label={w.menu.delete}
            danger
            why={menu.row.name === "default" ? w.builtInKept : blocked(l, connected, lacking, "remove")}
            onPick={() => {
              setMenu(undefined);
              setDialog({ kind: "delete", row: menu.row });
            }}
          />
        </Menu>
      )}

      {dialog?.kind === "new" && (
        <NewBot
          heading={w.form.newTitle}
          list={() => api.list()}
          off={wiring.botSetupOff()}
          returnTo={selectedRow}
          make={async (name, how) => {
            const made = await wiring.makeBot(name, how);
            // Gone to the bot: Settings has closed. Otherwise the new row is selected here, with Open it now.
            if (made.visited) return;
            setNotice({ tone: "muted", text: l.bots.make.made(made.profile), open: made.profile });
            void read(made.profile).then((now) => now && focusRow(now));
          }}
          onCopy={wiring.clone && ((name) => setDialog({ kind: "clone", source: inUse, name }))}
          onClose={() => setDialog((d) => (d?.kind === "new" ? undefined : d))}
        />
      )}
      {dialog?.kind === "edit" && (
        <ProfileForm
          wiring={wiring}
          row={dialog.row}
          focus={dialog.focus}
          rows={rows ?? []}
          lacking={lacking}
          returnTo={selectedRow}
          onDone={(result) => {
            setDialog(undefined);
            setNotice(result.notice);
            void read(result.select).then((now) => now && focusRow(now));
          }}
          // Closed without finishing: what saved meanwhile (Write for me, a field before one that failed) shows.
          onClose={() => {
            setDialog(undefined);
            void read();
          }}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteProfile
          wiring={wiring}
          row={dialog.row}
          returnTo={selectedRow}
          switchAway={() => switchTo("default", true)}
          onDone={(n) => {
            setDialog(undefined);
            setNotice(n);
            // The deleted row is gone: focus goes to the row the list selects now.
            void read().then((now) => now && focusRow(now));
          }}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "clone" && wiring.clone && (
        <CloneProfileDialog
          api={wiring.clone}
          current={dialog.source}
          name={dialog.name}
          returnTo={selectedRow}
          onClose={() => {
            setDialog(undefined);
            void read();
          }}
          onMade={(name) => void read(name)}
          onOpen={(name) => {
            setDialog(undefined);
            void switchTo(name);
          }}
        />
      )}
      {question}
    </>
  );
}

/** One entry of a row menu. With `why` it can't be picked, and says why under its label. */
export function MenuEntry({ icon, label, why, danger, onPick }: { icon: ReactNode; label: string; why?: string; danger?: boolean; onPick: () => void }) {
  const id = useId();
  return (
    <>
      <button
        role="menuitem"
        className={`menu-item ${danger ? "danger" : ""}`}
        aria-disabled={why ? true : undefined}
        aria-describedby={why ? id : undefined}
        title={why}
        onClick={() => !why && onPick()}
      >
        <span className="menu-icon">{icon}</span>
        <span className="menu-label">{label}</span>
      </button>
      {why && (
        <div id={id} className="menu-note">
          {why}
        </div>
      )}
    </>
  );
}

export function CopyButton({ text, copy }: { text: string; copy: (text: string) => Promise<void> }) {
  const l = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <button className="link-btn" onClick={() => void copy(text).then(() => setCopied(true), () => {})}>
      {copied ? l.profiles.del.copied : l.profiles.del.copy}
    </button>
  );
}

/** One profile in the list: its name and badges, its model and skills, and its description. */
function ProfileRowView({
  row,
  rowRef,
  selected,
  inUse,
  unread,
  onSelect,
  onEdit,
  onMenu,
  onMenuButton,
}: {
  row: ProfileRow;
  rowRef?: RefObject<HTMLDivElement | null>;
  selected: boolean;
  inUse: boolean;
  unread?: number;
  onSelect: () => void;
  onEdit: () => void;
  onMenu: (x: number, y: number) => void;
  onMenuButton: (el: HTMLElement) => void;
}) {
  const l = useLocale();
  const w = l.profiles;
  const more = useRef<HTMLButtonElement>(null);
  return (
    <div
      ref={rowRef}
      className={`profile-row ${selected ? "on" : ""}`}
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-profile={row.name}
      onClick={onSelect}
      onFocus={onSelect}
      onDoubleClick={onEdit}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <div className="profile-row-head">
        <span className="profile-row-name">
          {row.displayName && row.displayName !== row.name ? (
            <>
              <span translate="no">{row.displayName}</span> <span className="mono muted" translate="no">({row.name})</span>
            </>
          ) : (
            <span className="mono" translate="no">
              {row.name}
            </span>
          )}
        </span>
        {inUse && <span className="badge ok">{w.inUse}</span>}
        {row.isDefault && <span className="badge">{w.builtIn}</span>}
        {row.gatewayRunning && <span className="badge">{w.gateway}</span>}
        {!!unread && <span className="badge warn">{w.unread(unread)}</span>}
        {row.distribution && <span className="badge">{w.distribution(row.distribution)}</span>}
      </div>
      <div className="profile-row-facts muted small">
        <span>{row.model && row.provider ? w.model(row.model, row.provider) : w.noModel}</span>
        {row.skillCount !== undefined && <span>{w.skills(row.skillCount)}</span>}
      </div>
      <div className="profile-row-foot">
        <span className={`profile-row-desc small ${row.description ? "" : "muted"}`}>
          {row.description ? <span translate="no">{row.description}</span> : w.noDescription}
          {row.description && row.descriptionAuto && (
            <span className="badge profile-auto" title={w.autoTitle}>
              {w.auto}
            </span>
          )}
        </span>
        <span className="profile-row-actions">
          <button
            className="btn"
            tabIndex={-1}
            aria-label={w.editOf(row.name)}
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            <Pencil size={13} aria-hidden /> {w.edit}
          </button>
          <button
            ref={more}
            className="icon-btn"
            tabIndex={-1}
            aria-label={w.actionsOf(row.name)}
            title={w.actionsOf(row.name)}
            aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation();
              onMenuButton(more.current!);
            }}
          >
            <MoreHorizontal size={15} aria-hidden />
          </button>
        </span>
      </div>
    </div>
  );
}

/** The switcher's question before switching while something is left behind (Sidebar.tsx `LeaveProfile`). Stay has focus. */
function SwitchQuestion({ to, note, onStay, onGo }: { to: string; note: string; onStay: () => void; onGo: () => void }) {
  const l = useLocale();
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box);
  const noteId = useId();
  const titleId = useId();
  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && onStay()}>
      <div
        ref={box}
        className="leave-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={noteId}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && !composing(e)) onStay();
        }}
      >
        <h2 id={titleId} className="leave-title">
          {l.profiles.leaving.title(to)}
        </h2>
        <p id={noteId} className="muted">
          {note}
        </p>
        <div className="confirm-actions">
          <button className="btn" autoFocus onClick={onStay}>
            {l.profiles.leaving.stay}
          </button>
          <button className="btn primary" onClick={onGo}>
            {l.profiles.leaving.go}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A field's state after Save: saved, why not, or changed elsewhere since the owner last saw it, with Hermes's value
 * (`theirs`), which nothing was written over.
 */
type FieldState<V = never> = { kind: "saved" } | { kind: "failed"; text: string } | { kind: "changedElsewhere"; theirs: V };

type FormStates = { name?: FieldState; soul?: FieldState<string> } & { [K in keyof ProfileFields]?: FieldState<ProfileFields[K]> } & {
  [K in "title" | "color" | "picture"]?: FieldState<BotLook[K]>;
};

/**
 * What Edit bot adds to the Edit form (ADR 0189): the bot's name in Bot Mode, its colour and its picture. `look`: the
 * look as read when the dialog opened, which is what its saves are checked against. `edit`: `Hermes.editBot`.
 */
export type BotSection = { look: BotLook; edit: (profile: string, edits: Edits<BotLook>) => Promise<EditResult<BotLook>> };

const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp"];
/** What the colour box shows for a bot with Hermes's own colour, or one the box can't show. */
const NO_COLOR = "#888888";

/** The model pickers: a provider from Settings → Model's catalogue, then one of its models or any typed. */
function ModelPicker({
  catalog,
  provider,
  model,
  onChange,
  optional,
  labelId,
  disabled,
}: {
  disabled?: boolean;
  catalog?: CatalogProvider[];
  provider: string;
  model: string;
  onChange: (provider: string, model: string) => void;
  optional: boolean;
  labelId: string;
}) {
  const l = useLocale();
  const f = l.profiles.form;
  const listId = useId();
  const providers = catalog ?? [];
  const known = providers.some((p) => p.slug === provider);
  const models = providers.find((p) => p.slug === provider)?.models ?? [];
  return (
    <div className="profile-model" role="group" aria-labelledby={labelId}>
      <select aria-label={f.provider} value={provider} disabled={disabled} onChange={(e) => onChange(e.target.value, "")}>
        {optional && <option value="">{f.noProvider}</option>}
        {provider && !known && (
          <option value={provider} translate="no">
            {provider}
          </option>
        )}
        {providers.map((p) => (
          <option key={p.slug} value={p.slug} translate="no">
            {p.name}
          </option>
        ))}
      </select>
      <input spellCheck={false} aria-label={f.modelName} list={listId} className="mono" value={model} disabled={!provider || disabled} onChange={(e) => onChange(provider, e.target.value)} />
      <datalist id={listId}>
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  );
}

/** What a finished form tells its screen: what to say, and which row to select. */
export type FormResult = { notice?: Notice; select?: string };

/** A field Edit puts focus in once it can be typed in, for a menu entry that opens Edit at it. */
export type FormFocus = "persona";

/** Edit's read of the profile's SOUL.md as the form opened, or as last saved: what the Persona field is compared with. */
type SoulRead = { kind: "reading" } | { kind: "read"; base: Soul } | { kind: "failed"; message: string };

/**
 * Edit profile and Edit bot. Each changed field is saved through its own route, in order: description, model, the
 * bot's look, the persona, then the name, so the earlier calls still use the old name. A failed field keeps the dialog
 * open, marked with Hermes's words; the fields that saved stay saved. New bot and New profile are the name dialog
 * (NewBot.tsx, ADR 0231).
 *
 * Edit never writes over a change made elsewhere since the dialog opened (ADR 0189): each field is saved only where
 * Hermes still has what the form last showed. One that changed keeps the owner's text, shows Hermes's value with Use
 * Hermes's, and a second Save then replaces it knowingly. The name is changed last, and only once every other field
 * saved.
 *
 * `bot`: Edit bot, which adds the bot's look. Edit's Persona is the profile's SOUL.md, read as the form opens and
 * saved with the other fields, before the name (ADR 0206); `focus` puts focus in it once read.
 */
export function ProfileForm({
  wiring,
  row,
  rows,
  lacking,
  returnTo,
  heading,
  bot,
  focus,
  onDone,
  onClose,
}: {
  wiring: Omit<ProfilesWiring, "showTab">;
  row: ProfileRow;
  rows: readonly Pick<ProfileRow, "name">[];
  lacking: (a: ProfileAction) => boolean;
  returnTo: RefObject<HTMLElement | null>;
  heading?: string;
  bot?: BotSection;
  focus?: FormFocus;
  onDone: (result: FormResult) => void;
  onClose: () => void;
}) {
  const l = useLocale();
  const w = l.profiles;
  const f = w.form;
  const { api, connected } = wiring;
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  const titleId = useId();
  const nameId = useId();
  const nameNote = useId();
  const descId = useId();
  const modelId = useId();
  const soulId = useId();
  const rephraseHint = useId();
  const soulBox = useRef<HTMLTextAreaElement>(null);
  const titleFieldId = useId();
  const colorId = useId();
  const pictureId = useId();
  const isDefault = row.name === "default";
  // What the owner was last shown of each field. A field equal to it isn't sent, and one Hermes has moved off isn't
  // written over.
  const [base, setBase] = useState<{ name: string; profile: ProfileFields; look?: BotLook }>({
    name: isDefault ? (row.displayName ?? "") : row.name,
    profile: profileFieldsOf(row),
    look: bot?.look,
  });
  const [name, setName] = useState(base.name);
  const [description, setDescription] = useState(base.profile.description);
  const [provider, setProvider] = useState(base.profile.model?.provider ?? "");
  const [model, setModel] = useState(base.profile.model?.model ?? "");
  const [title, setTitle] = useState(base.look?.title ?? "");
  const [color, setColor] = useState(base.look?.color ?? null);
  const [picture, setPicture] = useState(base.look?.picture ?? null);
  const [pictureNote, setPictureNote] = useState<string>();
  const pictureInput = useRef<HTMLInputElement>(null);
  const [soul, setSoul] = useState("");
  const [catalog, setCatalog] = useState<CatalogProvider[]>();
  const [catalogError, setCatalogError] = useState<string>();
  const [states, setStates] = useState<FormStates>({});
  const [saving, setSaving] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [writing, setWriting] = useState(false);
  const [writeNote, setWriteNote] = useState<{ tone: "muted" | "bad"; text: string }>();
  /** Asked before leaving with unsaved changes. */
  const [asking, setAsking] = useState(false);
  // The Persona, when the app can read it: the profile's SOUL.md, read once the dialog opens.
  const soulApi = wiring.persona;
  const [soulRead, setSoulRead] = useState<SoulRead>({ kind: "reading" });
  const soulReads = useRef(0);
  const rephrase = usePersonaRephrase({ writer: soulApi ? wiring.rephrase?.(row.name) : undefined, connected, profile: row.name, text: soul, setText: setSoul });
  // The dialog swaps the whole form for the shorter question before leaving. WebKit keeps the form's scroll offset past
  // the shorter view's end, which draws it blank, so each view starts at its top.
  const view = asking ? "asking" : "form";
  useLayoutEffect(() => {
    if (box.current) box.current.scrollTop = 0;
  }, [view]);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    wiring.catalog().then(
      (c) => live.current && setCatalog(c),
      (e: unknown) => live.current && setCatalogError(f.catalogFailed(e instanceof Error ? e.message : String(e))),
    );
    return () => void (live.current = false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the catalogue is read once, when the dialog opens
  }, []);

  /** Reads Edit's SOUL.md into the Persona field; only the newest read counts. */
  const readSoul = async () => {
    if (!soulApi) return;
    const n = ++soulReads.current;
    setSoulRead({ kind: "reading" });
    try {
      const read = await soulApi.read(row.name);
      if (!live.current || n !== soulReads.current) return;
      setSoul(read.content);
      setSoulRead({ kind: "read", base: read });
    } catch (e) {
      if (live.current && n === soulReads.current) setSoulRead({ kind: "failed", message: errorText(e) });
    }
  };
  useEffect(() => {
    void readSoul();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read once, when the dialog opens; Try again reads it again
  }, []);
  const soulReady = soulRead.kind === "read";
  const reportSoul = wiring.onPersonaDirty;
  useEffect(() => {
    if (focus === "persona" && soulReady) soulBox.current?.focus();
  }, [focus, soulReady]);

  const trimmed = name.trim();
  const nameChanged = trimmed !== base.name;
  const formProfile: ProfileFields = { description, model: provider || model.trim() ? { provider, model: model.trim() } : null };
  const profileEdits = editsOf(base.profile, formProfile, PROFILE_FIELDS_SAME);
  const modelTouched = !!profileEdits.model;
  // A model without its provider or its name isn't sent, as Hermes's route takes only the pair.
  if (!provider || !model.trim()) delete profileEdits.model;
  const descChanged = !!profileEdits.description;
  const modelChanged = !!profileEdits.model;
  const formLook = base.look && { ...base.look, title, color, picture };
  const lookEdits = base.look && formLook ? editsOf(base.look, formLook, BOT_LOOK_SAME) : {};
  const lookChanged = Object.keys(lookEdits).length > 0;
  // Compared as Hermes reads SOUL.md back, so a line end it changes on the way isn't an edit.
  const soulChanged = soulRead.kind === "read" && asReadBack(soul) !== asReadBack(soulRead.base.content);
  const dirty = nameChanged || descChanged || modelTouched || lookChanged || soulChanged;
  useEffect(() => reportSoul?.(soulChanged, row.name), [soulChanged, row.name, reportSoul]);
  useEffect(() => () => reportSoul?.(false, ""), [reportSoul]);
  const discards = useRef(wiring.personaDiscards);
  useEffect(() => {
    if (wiring.personaDiscards === discards.current) return;
    discards.current = wiring.personaDiscards;
    onClose();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new discard closes the form
  }, [wiring.personaDiscards]);

  const issue = isDefault
    ? !trimmed
      ? f.displayEmpty
      : trimmed.length > DISPLAY_NAME_MAX
        ? f.displayLong(DISPLAY_NAME_MAX)
        : undefined
    : (() => {
        if (!nameChanged) return undefined;
        const i = nameIssue(trimmed, rows, row.name);
        return i === undefined ? undefined : i === "empty" ? f.issues.empty : i === "invalid" ? f.issues.invalid : f.issues[i](trimmed);
      })();
  const busy = nameChanged && !isDefault ? wiring.busy(row.name) : undefined;
  const busyText = busy ? (busy.kind === "queue" ? f.busyQueue : busy.title ? f.busyReply(busy.title) : f.busyReplyHere) : undefined;
  const why = (a: ProfileAction) => blocked(l, connected, lacking, a);
  const renameWhy = nameChanged ? why("rename") : undefined;
  const descWhy = descChanged ? why("describe") : undefined;
  const modelWhy = modelChanged ? why("setModel") : undefined;
  // A picture's save ends with a write of the Bot Mode block, so it needs both methods.
  const lookWhy = why("botLook");
  const pictureWhy = why("botPicture") ?? lookWhy;
  // A rewrite in flight is about to replace the persona: Save waits for it.
  const rephraseWhy = rephrase.state.kind === "asking" ? f.rephrase.blockedAsking : undefined;
  const saveWhy = (!connected ? w.notConnected : undefined) ?? (issue && nameChanged ? issue : undefined) ?? busyText ?? renameWhy ?? descWhy ?? modelWhy ?? rephraseWhy;
  const nothing = !nameChanged && !descChanged && !modelChanged && !lookChanged && !soulChanged;

  /** Leaves the dialog, asking first when it holds changes; never while a save or Write for me runs. */
  const close = () => {
    if (saving || writing) return;
    if (dirty) setAsking(true);
    else onClose();
  };

  const writeForMe = async () => {
    setWriting(true);
    setWriteNote(undefined);
    try {
      const out = await api.describeAuto(row.name);
      if (!live.current) return;
      if (out.ok) {
        setDescription(out.description);
        // Hermes saved it, as its own; the form starts from it now.
        setBase((b) => ({ ...b, profile: { ...b.profile, description: out.description } }));
        setWriteNote({ tone: "muted", text: f.writeSaved });
      } else setWriteNote({ tone: "bad", text: f.writeFailed(out.reason) });
    } catch (e) {
      if (live.current) setWriteNote({ tone: "bad", text: failureText(l, profileFailure(e, "describeAuto"), row.name) });
    } finally {
      if (live.current) setWriting(false);
    }
  };

  const pickPicture = (file: File | undefined) => {
    if (!file) return;
    if (!PICTURE_TYPES.includes(file.type)) return setPictureNote(f.pictureFormat);
    if (file.size > BOT_PICTURE_MAX_BYTES) return setPictureNote(f.pictureTooBig);
    const reader = new FileReader();
    reader.onload = () => {
      if (!live.current || typeof reader.result !== "string") return;
      setPicture(reader.result);
      setPictureNote(undefined);
    };
    reader.onerror = () => live.current && setPictureNote(f.pictureUnread);
    reader.readAsDataURL(file);
  };

  const save = async () => {
    setSaving(true);
    const next: FormStates = {};
    const show = () => live.current && setStates({ ...next });
    const statesOf = <F extends object>(saved: EditResult<F>) =>
      Object.fromEntries(
        Object.entries<FieldOutcome<unknown> | undefined>(saved.fields).map(([k, o]) => [k, o?.kind === "failed" ? { kind: "failed", text: failureText(l, o.failure, row.name) } : o]),
      ) as { [K in keyof F]?: FieldState<F[K]> };
    // Each family is saved only when it holds an edit, so a rename alone reads and writes nothing else.
    const savedProfile: EditResult<ProfileFields> = Object.keys(profileEdits).length ? await api.edit(row.name, profileEdits) : { fields: {} };
    Object.assign(next, statesOf(savedProfile));
    const profileNext = rebase(base.profile, formProfile, savedProfile);
    if (live.current) {
      setDescription(profileNext.form.description);
      // A model half picked wasn't sent, and stays as the owner left it, and so does what it was picked against: a
      // model Hermes reads back that the inputs don't show isn't one the owner has seen.
      const halfPicked = modelTouched && !modelChanged;
      if (!halfPicked) {
        setProvider(profileNext.form.model?.provider ?? "");
        setModel(profileNext.form.model?.model ?? "");
      }
      setBase((b) => ({ ...b, profile: halfPicked ? { ...profileNext.base, model: b.profile.model } : profileNext.base }));
    }
    show();
    const savedLook: EditResult<BotLook> = bot && lookChanged ? await bot.edit(row.name, lookEdits) : { fields: {} };
    Object.assign(next, statesOf(savedLook));
    const lookNext = base.look && formLook && rebase(base.look, formLook, savedLook);
    if (live.current && lookNext) {
      setTitle(lookNext.form.title);
      setColor(lookNext.form.color);
      setPicture(lookNext.form.picture);
      setBase((b) => ({ ...b, look: lookNext.base }));
    }
    show();
    if (soulChanged && soulApi && soulRead.kind === "read") {
      next.soul = await saveSoul(soulApi, row.name, soulRead.base, soul);
      show();
    }
    // The name changes last, and only under a dialog with nothing left unsaved: a field changed elsewhere isn't.
    let failed = !allSaved(savedProfile) || !allSaved(savedLook) || (!!next.soul && next.soul.kind !== "saved");
    let renamedTo: string | undefined;
    let localFailed = false;
    if (nameChanged && !failed) {
      const from = row.name;
      const timer = row.gatewayRunning ? setTimeout(() => live.current && setStopping(true), STOPPING_AFTER_MS) : undefined;
      if (!isDefault) wiring.local.note(from, trimmed);
      try {
        const done = await api.rename(from, trimmed);
        if (!isDefault) {
          renamedTo = done.name;
          try {
            await wiring.local.renamed(from, done.name);
            wiring.local.clear();
          } catch {
            // Hermes renamed it; what didn't move here stays noted, and the tab offers the move again.
            localFailed = true;
          }
        }
        next.name = { kind: "saved" };
        setBase((b) => ({ ...b, name: isDefault ? (done.displayName ?? trimmed) : done.name }));
        show();
      } catch (e) {
        const failure = profileFailure(e, "rename");
        // Refused or never sent: nothing moved. A lost answer stays noted, so the next list read can offer the move.
        if (!isDefault && failure.kind !== "lost") wiring.local.clear();
        next.name = { kind: "failed", text: failureText(l, failure, row.name) };
        failed = true;
        show();
      } finally {
        clearTimeout(timer);
        if (live.current) setStopping(false);
      }
    }
    if (!live.current) return;
    setSaving(false);
    if (!failed)
      onDone({
        notice: localFailed && renamedTo
          ? { tone: "warn", text: w.movePartly(row.name, renamedTo) }
          : { tone: "muted", text: renamedTo ? w.renamed(row.name, renamedTo) : w.saved(row.name) },
        select: renamedTo ?? row.name,
      });
  };

  /**
   * Writes Edit's Persona as `profile`'s SOUL.md, only where Hermes still has `base` (ADR 0014), and starts the field
   * from what Hermes has after. Changed elsewhere, the owner's text stays, and a second Save replaces Hermes's.
   */
  const saveSoul = async (api: PersonaApi, profile: string, base: Soul, text: string): Promise<FieldState<string>> => {
    const from = (soul: Soul) => live.current && setSoulRead({ kind: "read", base: soul });
    try {
      const out = await api.save(profile, base, text);
      switch (out.kind) {
        case "saved":
          from(out.soul);
          return { kind: "saved" };
        case "conflict":
        case "changed":
          from(out.server);
          return { kind: "changedElsewhere", theirs: out.server.content };
        case "unverified":
          // Hermes said it saved: the field is taken as what it has, so Save doesn't send it again unasked.
          from({ exists: true, content: asReadBack(text) });
          return { kind: "failed", text: f.personaUnverified(out.problem.message) };
      }
    } catch (e) {
      return { kind: "failed", text: f.personaNotSaved(errorText(e)) };
    }
  };

  /**
   * A field's note after Save. For one changed elsewhere, `said` words Hermes's value and Use Hermes's puts it in the
   * input (`use`), which leaves nothing to save for that field.
   */
  const stateNote = <V,>(key: keyof FormStates, said?: (theirs: V) => ReactNode, use?: (theirs: V) => void) => {
    const s = states[key] as FieldState<V> | undefined;
    if (!s) return null;
    if (s.kind !== "changedElsewhere")
      return (
        <div className={`small ${s.kind === "failed" ? "sign-in-error" : "muted"}`} role={s.kind === "failed" ? "alert" : undefined}>
          {s.kind === "saved" ? f.fieldSaved : s.text}
        </div>
      );
    return (
      <div className="small profile-conflict" role="alert">
        <span>{said?.(s.theirs)}</span>
        <button
          className="link-btn"
          disabled={saving}
          onClick={() => {
            use?.(s.theirs);
            setStates(({ [key]: _, ...rest }) => rest);
          }}
        >
          {f.useTheirs}
        </button>
      </div>
    );
  };
  const saidText = (theirs: string) => (theirs.trim() ? f.changedElsewhere(theirs.trim()) : f.changedElsewhereEmpty);

  const nameField = (
    <div className="field">
      <label className="field-label" htmlFor={nameId}>
        {isDefault ? f.displayName : bot ? f.profileName : f.name}
      </label>
      <input
        spellCheck={false}
        id={nameId}
        className={isDefault ? undefined : "mono"}
        autoFocus={!bot}
        value={name}
        readOnly={saving}
        maxLength={isDefault ? DISPLAY_NAME_MAX + 10 : 70}
        aria-invalid={!!issue && nameChanged}
        aria-describedby={nameNote}
        onChange={(e) => setName(e.target.value)}
      />
      <div id={nameNote} className="set-hint">
        {issue && nameChanged ? <span className="sign-in-error">{issue}</span> : isDefault ? f.displayHint : f.nameHint}
      </div>
      {row.gatewayRunning && !isDefault && nameChanged && (
        <SettingNote tone="warn">
          <TriangleAlert size={12} aria-hidden /> {f.gatewayWarn}
        </SettingNote>
      )}
      {busyText && <SettingNote tone="warn">{busyText}</SettingNote>}
      {renameWhy && !states.name && <SettingNote tone="warn">{renameWhy}</SettingNote>}
      {stateNote("name")}
    </div>
  );

  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        className="leave-dialog profile-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && !composing(e)) {
            e.preventDefault();
            if (asking) setAsking(false);
            else close();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          {heading ?? f.editTitle(rowName(l, row))}
        </h2>
        {asking ? (
          <>
            <p className="muted">{f.leaveNote}</p>
            <div className="confirm-actions">
              <button className="btn" autoFocus onClick={() => setAsking(false)}>
                {f.keepEditing}
              </button>
              <button className="btn danger" onClick={onClose}>
                {f.discard}
              </button>
            </div>
          </>
        ) : (
          <>
            {!bot && nameField}
            {bot && (
              <>
                <div className="field">
                  <label className="field-label" htmlFor={titleFieldId}>
                    {f.botName}
                  </label>
                  <input id={titleFieldId} autoFocus value={title} readOnly={saving} disabled={!!lookWhy} onChange={(e) => setTitle(e.target.value)} />
                  <div className="set-hint">{f.botNameHint}</div>
                  {stateNote<string>("title", saidText, setTitle)}
                </div>
                <div className="field">
                  <label className="field-label" htmlFor={colorId}>
                    {f.color}
                  </label>
                  <div className="profile-color">
                    <input id={colorId} type="color" value={/^#[0-9a-f]{6}$/.test(color ?? "") ? color! : NO_COLOR} disabled={saving || !!lookWhy} onChange={(e) => setColor(e.target.value.toLowerCase())} />
                    <span className="small muted">{color === null ? f.colorOwn : <span translate="no">{color}</span>}</span>
                    {color !== null && (
                      <button className="link-btn" disabled={saving || !!lookWhy} onClick={() => setColor(null)}>
                        {f.colorClear}
                      </button>
                    )}
                  </div>
                  {stateNote<string | null>("color", (theirs) => (theirs === null ? f.changedElsewhereEmpty : f.changedElsewhere(theirs)), setColor)}
                </div>
                <div className="field">
                  <span className="field-label" id={pictureId}>
                    {f.picture}
                  </span>
                  <div className="profile-picture" role="group" aria-labelledby={pictureId}>
                    <span className={`bots-face${color ? " has-color" : ""}`} style={color ? { background: color } : undefined} aria-hidden translate="no">
                      {picture ? <img src={picture} alt="" /> : ((title.trim() || row.name)[0] ?? "?").toUpperCase()}
                    </span>
                    <input
                      ref={pictureInput}
                      type="file"
                      hidden
                      accept={PICTURE_TYPES.join(",")}
                      aria-label={f.pictureChoose}
                      onChange={(e) => {
                        pickPicture(e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                    <button className="btn" disabled={saving || !!pictureWhy} title={pictureWhy} onClick={() => pictureInput.current?.click()}>
                      {f.pictureChoose}
                    </button>
                    {picture !== null && (
                      <button className="btn" disabled={saving || !!pictureWhy} title={pictureWhy} onClick={() => setPicture(null)}>
                        {f.pictureRemove}
                      </button>
                    )}
                  </div>
                  <div className="set-hint">{f.pictureHint}</div>
                  {pictureNote && (
                    <div className="small sign-in-error" role="alert">
                      {pictureNote}
                    </div>
                  )}
                  {stateNote<string | null>(
                    "picture",
                    (theirs) =>
                      theirs === null ? (
                        f.changedPictureNone
                      ) : (
                        <>
                          {f.changedPicture} <img className="profile-conflict-picture" src={theirs} alt="" />
                        </>
                      ),
                    setPicture,
                  )}
                </div>
                {lookWhy && <SettingNote tone="warn">{lookWhy}</SettingNote>}
                {!lookWhy && pictureWhy && <SettingNote tone="warn">{pictureWhy}</SettingNote>}
              </>
            )}
            <div className="field">
              <div className="field-label">
                <label htmlFor={descId}>{f.description}</label>
                <button className="btn profile-write" disabled={writing || saving || !!why("describeAuto")} title={why("describeAuto")} onClick={() => void writeForMe()}>
                  {writing ? <Spinner /> : <Wand2 size={13} aria-hidden />} {f.writeForMe}
                </button>
              </div>
              <input id={descId} value={description} onChange={(e) => setDescription(e.target.value)} disabled={writing || saving} />
              {writing && <div className="small muted">{f.writing}</div>}
              {writeNote && (
                <div className={`small ${writeNote.tone === "bad" ? "sign-in-error" : "muted"}`} role={writeNote.tone === "bad" ? "alert" : "status"}>
                  {writeNote.text}
                </div>
              )}
              {stateNote<string>("description", saidText, setDescription)}
            </div>
            <div className="field">
              <span className="field-label" id={modelId}>
                {f.model}
              </span>
              <ModelPicker
                disabled={saving || writing}
                catalog={catalog}
                provider={provider}
                model={model}
                optional={!base.profile.model?.provider}
                labelId={modelId}
                onChange={(p, m) => {
                  setProvider(p);
                  setModel(m);
                }}
              />
              {catalogError && <div className="small muted">{catalogError}</div>}
              {stateNote<ProfileFields["model"]>(
                "model",
                (theirs) => (theirs ? f.changedElsewhere(w.model(theirs.model, theirs.provider)) : f.changedElsewhereEmpty),
                (theirs) => {
                  setProvider(theirs?.provider ?? "");
                  setModel(theirs?.model ?? "");
                },
              )}
            </div>
            {soulApi && (
              <div className="field">
                <div className="field-label">
                  <label htmlFor={soulId}>{f.persona}</label>
                  <RephraseButton r={rephrase} disabled={saving || !soulReady} hintId={rephraseHint} />
                </div>
                <textarea
                  ref={soulBox}
                  id={soulId}
                  className="persona-text profile-soul"
                  rows={8}
                  disabled={!soulReady}
                  readOnly={saving || rephrase.state.kind === "asking"}
                  value={soul}
                  onChange={(e) => setSoul(e.target.value)}
                />
                <div className="set-hint">{f.personaEditHint}</div>
                {soulRead.kind === "reading" && <div className="small muted">{f.personaReading}</div>}
                {soulRead.kind === "failed" && (
                  <div className="small sign-in-error" role="alert">
                    {f.personaUnread(soulRead.message)}{" "}
                    <button className="link-btn" onClick={() => void readSoul()}>
                      {f.personaRetry}
                    </button>
                  </div>
                )}
                <RephrasePanel r={rephrase} hintId={rephraseHint} disabled={saving} focusBox={() => soulBox.current?.focus()} />
                {stateNote<string>("soul", () => f.personaChanged, (theirs) => {
                  rephrase.stop();
                  setSoul(theirs);
                })}
              </div>
            )}
            {bot && nameField}
            <div className="confirm-actions">
              <button className="btn" onClick={close} disabled={saving || writing}>
                {l.common.cancel}
              </button>
              <button className="btn primary" disabled={saving || writing || !!saveWhy || nothing} title={saveWhy ?? (nothing ? f.nothingChanged : undefined)} onClick={() => void save()}>
                {saving && <Spinner />} {stopping ? f.stopping : saving ? f.saving : f.save}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The question before deleting a profile: what goes on the server and on this computer, the counts the app could
 * read, and the profile's name typed to confirm. Deleting the profile in use switches to `default` first, through the
 * switcher's own question and guard; staying deletes nothing.
 */
export function DeleteProfile({
  wiring,
  row,
  returnTo,
  switchAway,
  onDone,
  onClose,
}: {
  wiring: Omit<ProfilesWiring, "showTab">;
  row: ProfileRow;
  returnTo: RefObject<HTMLElement | null>;
  switchAway: () => Promise<boolean>;
  onDone: (notice: Notice) => void;
  onClose: () => void;
}) {
  const l = useLocale();
  const d = l.profiles.del;
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  const titleId = useId();
  const noteId = useId();
  const typedId = useId();
  const [typed, setTyped] = useState("");
  const [counts, setCounts] = useState<{ chats?: number; jobs?: number }>({});
  const [phase, setPhase] = useState<"ask" | "switching" | "deleting" | "stopping">("ask");
  const [problem, setProblem] = useState<string>();
  const inUse = row.name === wiring.inUse;
  const lost = wiring.lostMessages(row.name);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    void wiring.api.chatCount(row.name).then((chats) => live.current && setCounts((c) => ({ ...c, chats })));
    void wiring.jobCount(row.name).then(
      (jobs) => live.current && setCounts((c) => ({ ...c, jobs })),
      () => {},
    );
    return () => void (live.current = false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- counted once, when the dialog opens on its row
  }, []);

  const go = async () => {
    setProblem(undefined);
    if (inUse) {
      setPhase("switching");
      const switched = await switchAway();
      if (!live.current) return;
      if (!switched) {
        setPhase("ask");
        setProblem(d.stayed);
        return;
      }
    }
    setPhase("deleting");
    const timer = row.gatewayRunning ? setTimeout(() => live.current && setPhase("stopping"), STOPPING_AFTER_MS) : undefined;
    try {
      const out = await wiring.api.remove(row.name);
      const forgot = await wiring.local.deleted(row.name).then(
        () => true,
        () => false,
      );
      if (!forgot) return onDone({ tone: "warn", text: d.forgetPartly(row.name) });
      onDone(
        out.kind === "settling"
          ? out.retryCommand
            ? { tone: "warn", text: d.settling(row.name), command: out.retryCommand }
            : { tone: "warn", text: d.settlingNoCommand(row.name) }
          : out.kind === "alreadyGone"
            ? { tone: "muted", text: d.alreadyGone(row.name) }
            : { tone: "muted", text: d.deleted(row.name) },
      );
    } catch (e) {
      if (!live.current) return;
      setProblem(d.failed(failureText(l, e instanceof ProfileError ? e.failure : profileFailure(e, "remove"), row.name)));
      setPhase("ask");
    } finally {
      clearTimeout(timer);
    }
  };

  const busy = phase !== "ask";
  const matches = typed.trim() === row.name;
  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div
        ref={box}
        className="leave-dialog profile-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={noteId}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && !composing(e) && !busy) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          <TriangleAlert size={14} aria-hidden /> {d.title(row.name)}
        </h2>
        <div id={noteId}>
          <p>{d.server}</p>
          <ul className="profile-delete-list">
            <li>{counts.chats !== undefined ? d.chatsCount(counts.chats) : d.chats}</li>
            <li>{row.skillCount !== undefined ? d.partsCount(row.skillCount) : d.parts}</li>
            <li>{d.keys}</li>
            <li>{counts.jobs !== undefined ? d.jobsCount(counts.jobs) : d.jobs}</li>
          </ul>
          {row.gatewayRunning && <p>{d.gateway}</p>}
          <p>{d.local}</p>
          {lost > 0 && <SettingNote tone="warn">{d.lost(lost)}</SettingNote>}
          {inUse && <SettingNote tone="warn">{d.inUse}</SettingNote>}
          <p className="muted">{d.noUndo}</p>
        </div>
        <div className="field">
          <label className="field-label" htmlFor={typedId}>
            {d.confirmLabel(row.name)}
          </label>
          <input spellCheck={false} id={typedId} className="mono" autoFocus value={typed} disabled={busy} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !composing(e) && matches && !busy && void go()} />
        </div>
        {problem && (
          <p className="sign-in-error" role="alert">
            {problem}
          </p>
        )}
        <div className="confirm-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            {l.common.cancel}
          </button>
          <button className="btn danger" disabled={!matches || busy || !wiring.connected} title={!wiring.connected ? l.profiles.notConnected : undefined} onClick={() => void go()}>
            {busy && <Spinner />} {phase === "switching" ? d.switching : phase === "stopping" ? l.profiles.form.stopping : phase === "deleting" ? d.deleting : d.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
