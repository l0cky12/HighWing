// The bots (ADR 0066), in the chat list's Bots mode (ADR 0195, ADR 0203): one row per bot, which is a Hermes profile,
// with its picture, its name, its Bot Chat's last message and what it is doing. The name's tip is the bot's description.
// A row opens the bot's Bot Chat, found by title every time (bots.ts); the pen beside it starts an ordinary chat in the
// bot's profile. Above the rows, New bot makes a profile through Settings → Profiles' New profile form, and the new
// bot's row is shown once the roster is read again (ADR 0164); Reload reads the roster now. A right-click on a row
// opens its menu (ADR 0194): Chat, Settings, Edit persona (ADR 0206), Clone, Pin, Hide and Delete, through Settings →
// Profiles' own dialogs and `Hermes.editBot`, which never writes over a change made elsewhere (ADR 0189). Every word
// comes from the catalogue (ADR 0100).
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { ArrowRight, ChevronDown, ChevronRight, Copy, EyeOff, Eye, Loader, MessageSquare, Pin, PinOff, Plus, RefreshCw, Settings2, ShieldAlert, Sparkles, SquarePen, Trash2 } from "lucide-react";
import { agentMessaging, type Bot, type BotActivity, type BotLook, type MessagingSave } from "../hermes/bots";
import { predatesBotMessaging } from "../hermes/capabilities";
import type { EditResult, Edits } from "../hermes/fieldMerge";
import { PROFILE_ROUTES, profileFailure, type ProfileAction, type ProfileRow } from "../hermes/profiles";
import { Age, Spinner, composing } from "./bits";
import type { Chat } from "../hermes/model";
import { Menu } from "./ChatMenu";
import { CloneProfileDialog } from "./CloneProfile";
import { pick } from "./keybindings";
import { DeleteProfile, MenuEntry, ProfileForm, blocked, failureText, useSwitchTo, type FormFocus, type FormResult, type ProfilesWiring } from "./ProfileSettings";
import { useLocale } from "../i18n/locale";

/** How often the roster is read again while the bots show. Hermes's desktop polls every 5 seconds; this is enough. */
export const BOTS_REFRESH_MS = 15_000;

const NO_SUBSCRIBE = () => () => {};
const NO_SNAPSHOT = () => undefined;

/**
 * What Edit bot, Pin and Hide need to change a bot's look: `Hermes.botLook` to open Edit bot on, and `Hermes.editBot`.
 * `messaging`: `Hermes.setAgentMessaging`, for Bot messaging's switch.
 */
export type BotEditWiring = {
  look: (profile: string) => Promise<BotLook | undefined>;
  edit: (profile: string, edits: Edits<BotLook>) => Promise<EditResult<BotLook>>;
  messaging: (on: boolean) => Promise<MessagingSave>;
};

function MessagingSwitch({ roster, why, save, onNote }: { roster: readonly Bot[]; why?: string; save: BotEditWiring["messaging"]; onNote: (text: string) => void }) {
  const l = useLocale();
  const w = l.bots.messaging;
  const [busy, setBusy] = useState(false);
  const now = agentMessaging(roster);
  const kept = (profiles: readonly string[]) => w.kept(w.and(profiles.map((p) => roster.find((b) => b.profile === p)?.name ?? p)), profiles.length);
  const tip = why ?? (now.on && now.keptOnBy.length ? kept(now.keptOnBy.map((b) => b.profile)) : now.on ? w.tipOn : w.tipOff);
  const flip = async () => {
    setBusy(true);
    const saved = await save(!now.on);
    setBusy(false);
    onNote(saved.kind === "kept" ? kept(saved.by) : saved.kind === "failed" ? w.failed(failureText(l, saved.failure, "default")) : saved.now.on ? w.turnedOn : w.turnedOff);
  };
  return (
    <div className="bots-messaging" title={tip}>
      <span id="bots-messaging-label">{w.label}</span>
      <button className="switch" role="switch" aria-checked={now.on} aria-labelledby="bots-messaging-label" aria-busy={busy || undefined} disabled={!!why || busy} onClick={() => void flip()}>
        <span className="switch-knob" />
      </button>
    </div>
  );
}

/** A dialog a bot's menu opened, on the profile's row as `GET /api/profiles` listed it just before. */
type BotDialog =
  | { kind: "edit"; bot: Bot; row: ProfileRow; rows: ProfileRow[]; look: BotLook; focus?: FormFocus }
  | { kind: "delete"; row: ProfileRow }
  | { kind: "clone"; source: string };

/** Opens a bot's Edit bot or Delete bot on its profile as Hermes lists it now; undefined once Hermes no longer has it. */
async function dialogOn(profiles: Omit<ProfilesWiring, "showTab">, botEdit: BotEditWiring, bot: Bot, kind: "edit" | "delete"): Promise<BotDialog | undefined> {
  const [rows, look] = await Promise.all([profiles.api.list(), kind === "edit" ? botEdit.look(bot.profile) : undefined]);
  const row = rows.find((r) => r.name === bot.profile);
  if (!row || (kind === "edit" && !look)) return undefined;
  return look ? { kind: "edit", bot, row, rows, look } : { kind: "delete", row };
}

/**
 * What Bots mode does besides opening a bot (ADR 0203). `head` goes above the rows: New bot, Reload, and why the last
 * read of the roster failed. `onMenu` is `BotList`'s, for a right-click, Shift+F10 or the Menu key on a row, as the
 * panel's chat rows have (ADR 0194). Chat opens the bot as its row does. Settings is Edit bot, and Edit persona is
 * Edit bot with focus in Persona (ADR 0206). Settings, Edit persona and Delete read the profile from
 * `GET /api/profiles` as they open; only the entry picked last opens. `element`, the menu and every dialog, is drawn
 * outside Bots mode, so a delete that switches away from the open bot's profile runs to its end.
 *
 * `shown`: the bots show, so the roster is read now and every BOTS_REFRESH_MS. It is read again once a dialog closes,
 * and then a row whose focus went with it hands focus to the bot saved (under its new name after a rename), else the
 * Hidden in Hermes fold it went behind, the open bot's row, the first bot's, or the profile switcher. The bot New bot
 * made takes focus once listed. `onRefresh`: Reload's check of what is live. `onNote`: what an action did, or why it
 * couldn't.
 */
export function useBotActions({
  profiles,
  botEdit,
  roster,
  load,
  shown,
  onRefresh,
  onNote,
}: {
  profiles: Omit<ProfilesWiring, "showTab">;
  botEdit: BotEditWiring;
  roster?: readonly Bot[];
  load: () => Promise<unknown>;
  shown: boolean;
  onRefresh: () => void;
  onNote: (text: string) => void;
}) {
  const l = useLocale();
  const w = l.bots;
  const [menu, setMenu] = useState<{ bot: Bot; x: number; y: number; open: () => void }>();
  const [dialog, setDialog] = useState<BotDialog>();
  const [making, setMaking] = useState(false);
  /** What had focus when the menu opened, where its dialog puts focus back. */
  const menuFrom = useRef<HTMLElement | null>(null);
  const newBtn = useRef<HTMLButtonElement>(null);
  const { switchTo, question } = useSwitchTo(profiles);
  const store = profiles.capabilities;
  useSyncExternalStore(store?.subscribe ?? NO_SUBSCRIBE, store?.getSnapshot ?? NO_SNAPSHOT);
  const lacking = (a: ProfileAction) => !!store?.lacksAction("profiles", a);
  const { connected } = profiles;
  /** Each open's number: only the last one picked opens its dialog or says why it couldn't. */
  const opens = useRef(0);
  /** Set once the roster is read after a change: the profile whose row takes focus, if focus has gone or `take`. */
  const [settled, setSettled] = useState<{ profile?: string; take?: boolean }>();
  /** Why the last read of the roster failed, until one succeeds. */
  const [failed, setFailed] = useState<string>();
  const [reloading, setReloading] = useState(false);
  const reads = useRef(0);

  const read = async () => {
    const n = ++reads.current;
    try {
      await load();
      if (n === reads.current) setFailed(undefined);
    } catch (e) {
      if (n === reads.current) setFailed((e as Error).message);
    }
  };
  const reread = (profile?: string, take = false) => void read().then(() => setSettled({ profile, take }));

  useEffect(() => {
    if (!shown || !connected) return;
    void read();
    const every = setInterval(() => void read(), BOTS_REFRESH_MS);
    return () => clearInterval(every);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `read` is new every render, so listing it would restart the poll on every render
  }, [shown, connected, load]);

  const reload = () => {
    if (reloading) return;
    setReloading(true);
    onRefresh();
    void read().finally(() => setReloading(false));
  };

  /** `focus`: the Edit field that takes focus once it can be typed in. */
  const open = async (bot: Bot, kind: "edit" | "delete", focus?: FormFocus) => {
    const n = ++opens.current;
    try {
      const opened = await dialogOn(profiles, botEdit, bot, kind);
      if (n !== opens.current) return;
      if (opened) return setDialog(opened.kind === "edit" && focus ? { ...opened, focus } : opened);
      onNote(l.profiles.form.gone(bot.profile));
      reread();
    } catch (e) {
      if (n !== opens.current) return;
      onNote(w.openFailed(bot.name, failureText(l, profileFailure(e, "botLook"), bot.profile)));
    }
  };

  /** Pin, Unpin, Hide or Show: the row is what the owner saw, so its value is what the change is checked against. */
  const toggle = async (bot: Bot, key: "pinned" | "hidden") => {
    const saved = await botEdit.edit(bot.profile, { [key]: { from: bot[key], to: !bot[key] } });
    const outcome = saved.fields[key];
    if (outcome?.kind === "failed") onNote(w.notChanged(bot.name, failureText(l, outcome.failure, bot.profile)));
    // The save read the roster back, so a bot just hidden has gone behind the fold already.
    setSettled({ profile: bot.profile });
  };

  const closeDialog = (note?: string, profile?: string) => {
    setDialog(undefined);
    if (note) onNote(note);
    reread(profile);
  };

  const onMade = (result: FormResult) => {
    setMaking(false);
    const name = result.select;
    const said = result.notice?.text ?? (name ? l.profiles.created(name) : "");
    // No bot selected: the form deleted the one it made, so there is no row to open.
    if (said) profiles.notify({ tone: result.notice?.tone ?? "muted", text: name ? w.made(said).trim() : said, command: result.notice?.command });
    reread(name, true);
  };

  useEffect(() => {
    if (!settled) return;
    setSettled(undefined);
    const rows = ".sb-bots .bots-row";
    const at = (sel: string) => document.querySelector<HTMLElement>(sel);
    const own = settled.profile ? at(`${rows}[data-profile="${CSS.escape(settled.profile)}"] .bots-open`) : null;
    if (settled.take) return void own?.focus();
    const now = document.activeElement;
    if (now && now !== document.body) return;
    (own || (settled.profile && at(".sb-bots .bots-hidden-toggle")) || at(`${rows}.is-current .bots-open`) || at(`${rows} .bots-open`) || at(".sidebar .profile-btn"))?.focus();
  }, [settled]);

  const onMenu = (bot: Bot, x: number, y: number, openBot: () => void) => {
    menuFrom.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMenu({ bot, x, y, open: openBot });
  };

  const newWhy = !connected ? w.notConnected : lacking("create") ? w.noCreateRoute(PROFILE_ROUTES.create) : undefined;
  const lookWhy = blocked(l, connected, lacking, "botLook");
  const messagingWhy = lookWhy ?? (store && predatesBotMessaging(store.getSnapshot().facts) ? w.messaging.tooOld : undefined);
  const head = (
    <>
      <div className="bots-head">
        {roster && <MessagingSwitch roster={roster} why={messagingWhy} save={botEdit.messaging} onNote={onNote} />}
        <button ref={newBtn} className="icon-btn" title={newWhy ?? w.newBot} aria-label={w.newBot} disabled={!!newWhy} onClick={() => setMaking(true)}>
          <Plus size={15} />
        </button>
        <button className="icon-btn" title={w.reload} aria-label={w.reload} aria-disabled={reloading || undefined} disabled={!connected} onClick={reload}>
          <RefreshCw size={14} className={reloading ? "spin" : undefined} />
        </button>
      </div>
      {failed && connected && (
        <p className="bots-note" role="alert">
          {w.readFailed(failed)}
        </p>
      )}
    </>
  );

  const element = (
    <>
      {menu && (
        <Menu label={w.moreFor(menu.bot.name)} x={menu.x} y={menu.y} onClose={() => setMenu(undefined)}>
          <MenuEntry
            icon={<MessageSquare size={15} />}
            label={w.menu.chat}
            onPick={() => {
              setMenu(undefined);
              menu.open();
            }}
          />
          <MenuEntry
            icon={<Settings2 size={15} />}
            label={w.menu.settings}
            why={!connected ? l.profiles.notConnected : undefined}
            onPick={() => {
              setMenu(undefined);
              void open(menu.bot, "edit");
            }}
          />
          {profiles.persona && (
            <MenuEntry
              icon={<Sparkles size={15} />}
              label={w.menu.persona}
              why={!connected ? l.profiles.notConnected : undefined}
              onPick={() => {
                setMenu(undefined);
                void open(menu.bot, "edit", "persona");
              }}
            />
          )}
          {profiles.clone && (
            <MenuEntry
              icon={<Copy size={15} />}
              label={w.menu.clone}
              why={blocked(l, connected, lacking, "create")}
              onPick={() => {
                setMenu(undefined);
                setDialog({ kind: "clone", source: menu.bot.profile });
              }}
            />
          )}
          <div className="menu-sep" role="separator" />
          <MenuEntry
            icon={menu.bot.pinned ? <PinOff size={15} /> : <Pin size={15} />}
            label={menu.bot.pinned ? w.menu.unpin : w.menu.pin}
            why={lookWhy}
            onPick={() => {
              setMenu(undefined);
              void toggle(menu.bot, "pinned");
            }}
          />
          <MenuEntry
            icon={menu.bot.hidden ? <Eye size={15} /> : <EyeOff size={15} />}
            label={menu.bot.hidden ? w.menu.show : w.menu.hide}
            why={lookWhy}
            onPick={() => {
              setMenu(undefined);
              void toggle(menu.bot, "hidden");
            }}
          />
          <div className="menu-sep" role="separator" />
          <MenuEntry
            icon={<Trash2 size={15} />}
            label={w.menu.delete}
            danger
            why={menu.bot.isDefault ? l.profiles.builtInKept : blocked(l, connected, lacking, "remove")}
            onPick={() => {
              setMenu(undefined);
              void open(menu.bot, "delete");
            }}
          />
        </Menu>
      )}
      {making && (
        <ProfileForm
          wiring={profiles}
          rows={roster?.map((b) => ({ name: b.profile }))}
          lacking={lacking}
          returnTo={newBtn}
          heading={w.newBot}
          createLabel={w.createBot}
          noEdit
          onDone={onMade}
          onClose={() => setMaking(false)}
        />
      )}
      {dialog?.kind === "edit" && (
        <ProfileForm
          key={dialog.row.name}
          wiring={profiles}
          row={dialog.row}
          rows={dialog.rows}
          lacking={lacking}
          returnTo={menuFrom}
          heading={w.editTitle(dialog.bot.name)}
          bot={{ look: dialog.look, edit: botEdit.edit }}
          focus={dialog.focus}
          onDone={(result) => closeDialog(result.notice?.text, result.select)}
          // Closed without finishing: what saved meanwhile shows in the rows.
          onClose={() => closeDialog()}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteProfile
          key={dialog.row.name}
          wiring={profiles}
          row={dialog.row}
          returnTo={menuFrom}
          switchAway={() => switchTo("default", true)}
          onDone={(n) => closeDialog(n.command ? `${n.text} ${n.command}` : n.text)}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "clone" && profiles.clone && (
        <CloneProfileDialog
          api={profiles.clone}
          current={dialog.source}
          returnTo={menuFrom}
          onClose={() => closeDialog()}
          onMade={() => void read()}
          onOpen={(name) => {
            closeDialog();
            void switchTo(name);
          }}
        />
      )}
      {question}
    </>
  );
  return { head, onMenu, element };
}

/**
 * The bots' rows: pinned first, hidden ones behind a disclosure, Up and Down between them. A row in another profile
 * than `profile` asks first while `leaving` says what switching leaves behind. `current`: the profile of the bot whose
 * Bot Chat is open. `under`: drawn under the shown profile's bot.
 */
export function BotList({
  bots,
  pictures,
  activity,
  profile,
  current,
  leaving,
  onOpen,
  onNewChat,
  onMenu,
  under,
}: {
  bots: Bot[];
  pictures: Record<string, string>;
  activity: (bot: Bot, roster: readonly Bot[]) => BotActivity;
  profile: string;
  current?: string;
  leaving?: string;
  onOpen: (bot: Bot) => void;
  onNewChat: (bot: Bot) => void;
  /** Opens a bot's menu at a point of the window. `open`: opens the bot as its row does. */
  onMenu: (bot: Bot, x: number, y: number, open: () => void) => void;
  under?: ReactNode;
}) {
  const l = useLocale();
  const w = l.bots;
  const [showHidden, setShowHidden] = useState(false);
  const [asking, setAsking] = useState<{ bot: Bot; then: "open" | "new" }>();

  const go = (bot: Bot, then: "open" | "new") => {
    if (bot.profile !== profile && leaving) return setAsking({ bot, then });
    setAsking(undefined);
    (then === "open" ? onOpen : onNewChat)(bot);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // WebKitGTK sends no contextmenu event for Shift+F10, so the menu's keys are read here, from any button of a row.
    if (pick(e, "chatRow") === "rowMenu") {
      const li = document.activeElement?.closest<HTMLElement>(".bots-row");
      const bot = bots.find((b) => b.profile === li?.dataset.profile);
      if (!li || !bot) return;
      e.preventDefault();
      const r = li.getBoundingClientRect();
      return onMenu(bot, r.left + 24, r.bottom, () => go(bot, "open"));
    }
    if (composing(e) || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(".bots-open, .bots-under button"));
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    rows[at + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
  };

  // Pinned bots first, then Hermes's order. Hidden ones wait behind a disclosure, as in Hermes's own list.
  const shown = bots.filter((b) => !b.hidden).sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const hidden = bots.filter((b) => b.hidden);
  const row = (b: Bot) => [
    <Row
      key={b.profile}
      bot={b}
      picture={pictures[b.profile]}
      activity={activity(b, bots)}
      shown={b.profile === profile}
      current={b.profile === current}
      onOpen={() => go(b, "open")}
      onNewChat={() => go(b, "new")}
      onMenu={(x, y) => onMenu(b, x, y, () => go(b, "open"))}
    />,
    under && b.profile === profile && (
      <li key={`${b.profile}-under`} className="bots-under">
        {under}
      </li>
    ),
  ];

  return (
    <>
      {asking && leaving && (
        <BotSwitchQuestion
          bot={asking.bot}
          leaving={leaving}
          onStay={() => setAsking(undefined)}
          onGo={() => {
            setAsking(undefined);
            (asking.then === "open" ? onOpen : onNewChat)(asking.bot);
          }}
        />
      )}
      <ul className="inbox-list bots-list" aria-label={w.list} onKeyDown={onKeyDown}>
        {shown.map(row)}
        {hidden.length > 0 && (
          <li className="bots-hidden">
            <button className="bots-hidden-toggle" aria-expanded={showHidden} onClick={() => setShowHidden((s) => !s)}>
              {showHidden ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
              {w.hidden(hidden.length)}
            </button>
          </li>
        )}
        {showHidden && hidden.map(row)}
      </ul>
    </>
  );
}

export function BotChatsUnder({
  name,
  chats,
  inbox,
  total,
  selectedId,
  alsoShownId,
  onOpen,
  onAll,
}: {
  name: string;
  chats: readonly Chat[];
  inbox: ReadonlySet<string>;
  total: number;
  selectedId: string | null;
  alsoShownId: string | null;
  onOpen: (id: string) => void;
  onAll: () => void;
}) {
  const w = useLocale().chatList;
  return (
    <ul className="bots-chats" role="group" aria-label={w.chatsOf(name)}>
      {chats.map((c) => (
        <li key={c.id} className={`row${c.id === selectedId ? " sel" : ""}${c.id === alsoShownId && c.id !== selectedId ? " shown" : ""}${c.unread ? " unread" : ""}`}>
          <button className="row-open" data-chat={c.id} aria-current={c.id === selectedId || undefined} onClick={() => onOpen(c.id)}>
            {inbox.has(c.id) ? <span className="bots-chat-mark" role="img" aria-label={w.inInbox} title={w.inInbox} /> : <span className="bots-chat-mark is-none" aria-hidden />}
            <span className="row-title" translate="no">
              {c.title}
            </span>
            <span className="row-meta">{c.running ? <Spinner /> : <Age at={c.updatedAt} />}</span>
          </button>
        </li>
      ))}
      {total > 0 ? (
        <li>
          <button className="bots-under-all" onClick={onAll}>
            {w.allChats(total)}
            <ArrowRight size={12} aria-hidden />
          </button>
        </li>
      ) : (
        <li className="empty-hint">{w.noChats}</li>
      )}
    </ul>
  );
}

export function BotSwitchQuestion({ bot, leaving, onStay, onGo }: { bot: Bot; leaving: string; onStay: () => void; onGo: () => void }) {
  const w = useLocale().bots;
  const stay = useRef(onStay);
  stay.current = onStay;
  // Escape takes the question away wherever focus is, before it reaches anything else.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.stopPropagation();
      stay.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <div className="confirm inbox-leave" role="alertdialog" aria-label={w.switchTitle(bot.profile)}>
      <span>{leaving}</span>
      <div className="confirm-actions">
        <button className="btn" autoFocus onClick={onStay}>
          {w.stay}
        </button>
        <button className="btn primary" onClick={onGo}>
          {w.switchTo(bot.profile)}
        </button>
      </div>
    </div>
  );
}

function Row({
  bot: b,
  picture,
  activity,
  shown,
  current,
  onOpen,
  onNewChat,
  onMenu,
}: {
  bot: Bot;
  picture?: string;
  activity: BotActivity;
  shown: boolean;
  current: boolean;
  onOpen: () => void;
  onNewChat: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const l = useLocale();
  const w = l.bots;
  const preview = b.botChat?.preview || (b.botChat ? w.noMessages : w.noBotChat);
  const age = b.lastActive ? l.fmt.age(b.lastActive) : "";
  const when = age && age !== l.time.now ? w.ago(age) : age;
  const state = activity === "replying" ? w.replying : activity === "needs-you" ? w.needsYou : undefined;
  const label = w.rowLabel(
    [
      b.profile !== b.name.toLowerCase() ? w.rowProfile(b.name, b.profile) : b.name,
      state,
      b.description,
      b.botChat?.preview ? w.rowLast(b.botChat.preview) : preview,
      when && w.rowActive(when),
      shown && w.rowShown,
    ].filter((part): part is string => !!part),
  );
  return (
    <li
      data-profile={b.profile}
      className={`inbox-row bots-row${activity ? ` is-${activity}` : ""}${b.hidden ? " is-hidden" : ""}${current ? " is-current" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <button className="bots-open" aria-label={label} aria-current={current || undefined} onClick={onOpen}>
        <span className={`bots-face${b.color ? " has-color" : ""}`} style={b.color ? { background: b.color } : undefined} aria-hidden translate="no">
          {picture ? <img src={picture} alt="" /> : (b.name.trim()[0] ?? "?").toUpperCase()}
        </span>
        <span className="bots-text">
          <span className="inbox-line">
            <span className="bots-name" title={b.description || undefined} translate="no">
              {b.name}
            </span>
            {state ? (
              <span className={`bots-activity is-${activity}`}>
                {activity === "needs-you" ? <ShieldAlert size={12} aria-hidden /> : <Loader size={12} aria-hidden />}
                {state}
              </span>
            ) : (
              when && (
                <time className="inbox-time" dateTime={new Date(b.lastActive).toISOString()} title={l.fmt.dateTime(b.lastActive)}>
                  {when}
                </time>
              )
            )}
          </span>
          <span className={`bots-preview${b.botChat?.preview ? "" : " is-empty"}`} translate={b.botChat?.preview ? "no" : undefined}>
            {preview}
          </span>
        </span>
      </button>
      <button className="icon-btn bots-new" title={w.newChat(b.name)} aria-label={w.newChat(b.name)} onClick={onNewChat}>
        <SquarePen size={14} />
      </button>
    </li>
  );
}
