// Bot setup in a Bot Chat (ADR 0231): the review card drawn in place of the bot's setup block, its earlier drafts, a
// block that doesn't parse, and the Setup started line. Which block is which comes from the Bot Chat's stored rows,
// read on open and after each reply (`useBotSetup`); what the card offers and what a choice does, from botSetupCard.ts;
// what Set it up writes, from botSetupApply.ts. The pane keeps the pending edits above the transcript, so a card
// scrolled out of the rendered window keeps them. What Connect takes for an MCP server is kept there too, in memory
// only, until Set it up sends it, and so is a picture the owner uploads; leaving the Bot Chat drops both (#85 owner
// call 4, ADR 0235). Set up again's card shows each change as before → after, and folds what stays as it is under one
// line per group.
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronRight, CircleAlert, FileText, Hourglass, ImagePlus, Pencil, Plug, RotateCcw, Sparkles, TriangleAlert } from "lucide-react";
import { BOT_PICTURE_DATA, pictureKey, setPicture } from "../hermes/botPictures";
import { BOT_SETUP_COLORS, BOT_SETUP_DESCRIPTION_MAX, BOT_SETUP_FENCE, BOT_SETUP_PICTURES } from "../hermes/botSetupBrief";
import { BOT_SETUP_COLOR_HEX, choose, fencedBlocks, planCard, tickable, type Choice, type ListedItem, type Plan, type PlanItem } from "../hermes/botSetupCard";
import { rememberAsked, restartState, setupItems, type CardMiss, type CardState, type PictureUploads } from "../hermes/botSetupApply";
import { connected, mcpOffer, type McpOffer, type McpSecrets } from "../hermes/botSetupMcp";
import type { Note } from "../hermes/botSetup";
import type { BotSetupStart } from "../hermes/botSetupStart";
import type { Chat, Item } from "../hermes/model";
import type { BotSetupCardRead, BotSetupRead, BotSetupRun, Hermes } from "../hermes/transport";
import { ProfileError } from "../hermes/profiles";
import type { Caution } from "../hermes/toolsets";
import { errorText } from "../hermes/values";
import { useLocale, type Locale } from "../i18n/locale";
import { composing, Spinner } from "./bits";
import { PICTURE_TYPES, readPictureFile } from "./pictureFile";
import { failureText } from "./profileFailure";
import { cautionText } from "./ToolsetSettings";
import { TurnCard } from "./TurnCard";

export type BotSetupApi = Pick<Hermes, "readBotSetup" | "applyBotSetup" | "retryBotSetupItem" | "reloadBotSetupMcp" | "botSetupRestart" | "resumeBotSetup">;

type ItemRun = CardState | { kind: "working" };

/** The Restart row after a ready turn sent at `since`, for the toolsets Set it up applied. */
type Restart = { since: number; toolsets: { name: string; on: boolean }[]; state: "waiting" | "checking" | ReturnType<typeof restartState> | { failed: string } };

/** What a setup block in the transcript is: the live card, an earlier draft, the unreadable newest, or none of Bot setup's. */
type BlockRole = "live" | "draft" | "unreadable" | "pending" | "failed" | "plain";

export type SetupHost = {
  bot: string;
  read?: { kind: "read"; read: BotSetupRead } | { kind: "failed"; error: unknown };
  plan?: Plan;
  roleOf(itemId: string, source: string): BlockRole;
  choose(c: Choice): void;
  runs: Readonly<Record<string, ItemRun>>;
  outcome?: BotSetupRun;
  busy: boolean;
  /** Why Set it up can't go now. */
  blocked?: "offline" | "replying";
  setUp(): void;
  retry(item: ListedItem, accept: boolean): void;
  /** What Connect took for each MCP server, by item key. Never shown again. */
  secrets: McpSecrets;
  /** Keeps `values` for an MCP server, which only Set it up sends. */
  connect(item: ListedItem, values: Record<string, string>): void;
  /** The owner's uploaded pictures, by picture key. Only Set it up sends one. */
  uploads: PictureUploads;
  /** Keeps an uploaded picture, given as a data URL, and answers its key. */
  upload(dataUrl: string): string;
  reloadMcp(): void;
  /** `replying`: Hermes didn't reload, since a reply runs on it. */
  mcpReload?: "working" | "replying" | { failed: string };
  reload(): void;
  send(text: string): void;
  restart?: Restart;
  checkRestart(): void;
  start?: BotSetupStart;
  startAgain(): void;
};

export const SetupContext = createContext<SetupHost | undefined>(undefined);
export const SetupItemContext = createContext<string | undefined>(undefined);

const setupIdOf = (r: BotSetupRead) => (r.parse.kind === "card" ? r.parse.card.setupId : r.parse.setupId);
const cardRead = (host: Pick<SetupHost, "read">): BotSetupCardRead | undefined =>
  host.read?.kind === "read" && host.read.read.parse.kind === "card" ? (host.read.read as BotSetupCardRead) : undefined;

/**
 * The pane's Bot setup for `chat`, a Bot Chat, or undefined without `api`. Its rows are read when it opens and each
 * time a reply ends, while it holds a setup or a reply names one; a Bot Chat that holds none is read once per open.
 * A setup found is picked up where its rows say it stands (`resumeBotSetup`), once per open.
 */
export function useBotSetup(chat: Chat, api: BotSetupApi | undefined, bot: string, connected: boolean, send: (text: string) => void): SetupHost | undefined {
  const chatId = chat.id;
  const running = !!chat.running;
  const [read, setRead] = useState<SetupHost["read"]>();
  const [pending, setPending] = useState<Choice[]>([]);
  const [runs, setRuns] = useState<Record<string, ItemRun>>({});
  const [outcome, setOutcome] = useState<BotSetupRun>();
  const [busy, setBusy] = useState(false);
  const [restart, setRestart] = useState<Restart>();
  const [start, setStart] = useState<BotSetupStart>();
  const [secrets, setSecrets] = useState<McpSecrets>({});
  const [uploads, setUploads] = useState<PictureUploads>({});
  const [mcpReload, setMcpReload] = useState<SetupHost["mcpReload"]>();
  const shown = useRef({ chatId, reads: 0, started: false, readOnce: false, holds: false, afterSetUp: false, setupId: null as string | null });
  // What the last Set it up ran on: a retry compares against what the card read then, not against a later reload.
  const ranOn = useRef<{ read: BotSetupCardRead; items: ReadonlyMap<string, ListedItem> }>(undefined);
  const mentions = chat.items.some((i) => i.kind === "assistant" && i.text.includes(BOT_SETUP_FENCE));

  // What a setup's card holds is that setup's alone: Set up again's Keep history starts another in the same Bot Chat.
  const forgetSetup = useCallback(() => {
    ranOn.current = undefined;
    setPending([]);
    setRuns({});
    setOutcome(undefined);
    setRestart(undefined);
    setStart(undefined);
    setSecrets({});
    setUploads({});
    setMcpReload(undefined);
  }, []);
  useEffect(() => {
    shown.current = { chatId, reads: 0, started: false, readOnce: false, holds: false, afterSetUp: false, setupId: null };
    setRead(undefined);
    forgetSetup();
  }, [chatId, forgetSetup]);

  const here = (id: string) => shown.current.chatId === id;
  // What a Set it up or Retry hears belongs to the setup it ran on: Keep history may start another here meanwhile.
  const ours = (setupId: string) => here(chatId) && shown.current.setupId === setupId;
  const load = useCallback(() => {
    if (!api) return;
    const n = ++shown.current.reads;
    api.readBotSetup(chatId).then(
      (r) => {
        if (!here(chatId) || n !== shown.current.reads) return;
        const setupId = setupIdOf(r);
        if (shown.current.readOnce && setupId !== shown.current.setupId) {
          Object.assign(shown.current, { started: false, afterSetUp: false });
          forgetSetup();
        }
        Object.assign(shown.current, { readOnce: true, holds: setupId !== null, setupId });
        setRead({ kind: "read", read: r });
        if (shown.current.afterSetUp) {
          shown.current.afterSetUp = false;
          setPending([]);
        }
        if (shown.current.holds && !shown.current.started) {
          shown.current.started = true;
          // A pick-up that failed, as one does while a profile switch reconnects, is tried on the next read.
          api.resumeBotSetup().then(
            (s) => here(chatId) && setStart(s),
            () => here(chatId) && (shown.current.started = false),
          );
        }
      },
      (e: unknown) => here(chatId) && n === shown.current.reads && setRead({ kind: "failed", error: e }),
    );
  }, [api, chatId, forgetSetup]);

  useEffect(() => {
    if (!api || running || !connected) return;
    if (shown.current.readOnce && !shown.current.holds && !mentions) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `mentions` is read when a reply ends, not watched: a block streaming in is read once its reply is over
  }, [api, chatId, running, connected, load]);

  const r = read?.kind === "read" && read.read.parse.kind === "card" ? (read.read as BotSetupCardRead) : undefined;
  const plan = useMemo(() => r && planCard(r.parse.card, r.setup.now, r.accepted, pending), [r, pending]);

  // The last assistant item holding each block's text: an identical block earlier is a draft of it.
  const lastWith = useMemo(() => {
    const at = new Map<string, string>();
    for (const i of chat.items) if (i.kind === "assistant") for (const b of fencedBlocks(i.text, BOT_SETUP_FENCE)) at.set(b.trim(), i.id);
    return at;
  }, [chat.items]);

  const checkRestart = useCallback(() => {
    if (!api) return;
    setRestart((was) => {
      if (!was) return was;
      api.botSetupRestart(chatId, was.since).then(
        (found) => here(chatId) && setRestart((now) => now && { ...now, state: restartState(found, now.toolsets) }),
        (e: unknown) => here(chatId) && setRestart((now) => now && { ...now, state: { failed: errorText(e) } }),
      );
      return { ...was, state: "checking" };
    });
  }, [api, chatId]);
  useEffect(() => {
    if (restart?.state === "waiting" && !running) checkRestart();
  }, [restart?.state, running, checkRestart]);

  if (!api) return undefined;
  const hearFor = (setupId: string) => (key: string, state: ItemRun) => ours(setupId) && setRuns((p) => ({ ...p, [key]: state }));
  const dropSecretsOfAdded = (states: Readonly<Record<string, ItemRun>>) =>
    setSecrets((was) => Object.fromEntries(Object.entries(was).filter(([k]) => states[k]?.kind !== "reload" && states[k]?.kind !== "applied")));
  const retry = (item: ListedItem, cautions: Caution[], using: McpSecrets) => {
    const on = ranOn.current;
    if (!on) return;
    const setupId = on.read.parse.card.setupId;
    const hear = hearFor(setupId);
    hear(item.key, { kind: "working" });
    api.retryBotSetupItem(on.read, on.items.get(item.key) ?? item, cautions, using, uploads).then(
      (state) => {
        hear(item.key, state);
        if (ours(setupId)) dropSecretsOfAdded({ [item.key]: state });
      },
      (e: unknown) => hear(item.key, { kind: "failed", miss: { kind: "said", text: errorText(e) } }),
    );
  };
  return {
    bot,
    read,
    plan,
    roleOf(itemId, source) {
      if (!read) return "pending";
      if (read.kind === "failed") return "failed";
      const rr = read.read;
      if (setupIdOf(rr) === null) return "plain";
      const s = source.trim();
      const last = lastWith.get(s) === itemId;
      if (rr.parse.kind === "card" && "live" in rr && rr.live?.trim() === s && last) return "live";
      if (rr.unreadable?.trim() === s && last) return "unreadable";
      return rr.blocks.some((b) => b.trim() === s) ? "draft" : "pending";
    },
    choose: (c) => setPending((p) => [...p.filter((x) => x.key !== c.key), c]),
    runs,
    outcome,
    busy,
    blocked: !connected ? "offline" : running ? "replying" : undefined,
    setUp() {
      if (!r || !plan || busy) return;
      setBusy(true);
      setOutcome(undefined);
      setRestart(undefined);
      setRuns({});
      setMcpReload(undefined);
      const items = setupItems(plan, r.parse.accepted);
      ranOn.current = { read: r, items: new Map(items.map((i) => [i.key, i])) };
      const setupId = r.parse.card.setupId;
      api.applyBotSetup(r, plan, hearFor(setupId), secrets, uploads).then(
        (out) => {
          setBusy(false);
          if (!ours(setupId)) return;
          setOutcome(out);
          dropSecretsOfAdded(out.states);
          shown.current.afterSetUp = true;
          const applied = items.filter((i) => out.states[i.key]?.kind === "applied");
          const toolsets = applied.flatMap((i) => (i.kind === "toolset" ? [{ name: i.name ?? i.key, on: i.after === "on" }] : []));
          if (out.readyAt !== undefined && (toolsets.length || applied.some((i) => i.kind === "persona"))) setRestart({ since: out.readyAt, toolsets, state: "waiting" });
          if (out.readyAt === undefined) load();
        },
        (e: unknown) => {
          setBusy(false);
          if (!ours(setupId)) return;
          setOutcome({ states: {}, readyFailed: { kind: "said", text: errorText(e) } });
        },
      );
    },
    retry(item, accept) {
      const was = runs[item.key];
      retry(item, accept && was?.kind === "confirm" ? was.cautions : [], secrets);
    },
    secrets,
    connect: (item, values) => setSecrets((was) => ({ ...was, [item.key]: values })),
    uploads,
    upload(dataUrl) {
      const key = pictureKey(dataUrl);
      setUploads((was) => ({ ...was, [key]: dataUrl }));
      return key;
    },
    mcpReload,
    reloadMcp() {
      if (busy || mcpReload === "working") return;
      setMcpReload("working");
      api.reloadBotSetupMcp(chatId).then(
        (done) => {
          if (!here(chatId)) return;
          if (done === "replying") return setMcpReload(done);
          setMcpReload(undefined);
          const owed = Object.fromEntries((r?.mcpReload ?? []).map((k) => [k, { kind: "applied" } as const]));
          setRuns((p) => ({ ...owed, ...Object.fromEntries(Object.entries(p).map(([k, s]) => [k, s.kind === "reload" ? { kind: "applied" } : s])) }));
        },
        (e: unknown) => here(chatId) && setMcpReload({ failed: errorText(e) }),
      );
    },
    reload: load,
    send,
    restart,
    checkRestart,
    start,
    startAgain: () =>
      void api.resumeBotSetup("again").then(
        (s) => here(chatId) && setStart(s),
        () => {},
      ),
  };
}

export const setupFence = (language: string, source: string, plain: ReactNode): ReactNode =>
  language === BOT_SETUP_FENCE ? <SetupBlock source={source} plain={plain} /> : plain;

function SetupBlock({ source, plain }: { source: string; plain: ReactNode }) {
  const host = useContext(SetupContext);
  const itemId = useContext(SetupItemContext);
  const loc = useLocale();
  const l = loc.chat.botSetup;
  if (!host || !itemId) return plain;
  const role = host.roleOf(itemId, source);
  const title = l.title(host.bot);
  switch (role) {
    case "plain":
      return plain;
    case "draft":
      return <Draft title={title} note={l.draft} plain={plain} />;
    case "unreadable":
      return <Unreadable host={host} source={source} />;
    case "pending":
    case "failed":
      return (
        <TurnCard kind="bot-setup" icon={<Sparkles size={14} aria-hidden />} heading={title} tips={{ hide: l.hide, show: l.show }}>
          {role === "pending" || host.read?.kind !== "failed" ? (
            <p className="bot-setup-note">
              <Spinner /> {l.reading}
            </p>
          ) : (
            <div className="bot-setup-note" role="alert">
              {l.readFailed(host.read.error instanceof ProfileError ? failureText(loc, host.read.error.failure, host.bot) : errorText(host.read.error))}{" "}
              <button className="btn" onClick={host.reload}>
                <RotateCcw size={13} aria-hidden /> {l.tryAgain}
              </button>
            </div>
          )}
        </TurnCard>
      );
    case "live": {
      const read = cardRead(host);
      return read && host.plan ? <Card host={host} read={read} plan={host.plan} /> : plain;
    }
  }
}

function Draft({ title, note, plain }: { title: string; note: string; plain: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="msg returned bot-setup-draft">
      <button className="returned-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <FileText size={14} aria-hidden />
        <span className="returned-title">
          {title} <span className="bot-setup-draft-note">· {note}</span>
        </span>
        <ChevronRight size={13} className={`chev ${open ? "open" : ""}`} aria-hidden />
      </button>
      {open && plain}
    </div>
  );
}

function Unreadable({ host, source }: { host: SetupHost; source: string }) {
  const l = useLocale().chat.botSetup;
  return (
    <TurnCard kind="bot-setup unreadable" icon={<TriangleAlert size={14} aria-hidden />} heading={l.unreadable} tips={{ hide: l.hide, show: l.show }}>
      <p className="bot-setup-note">{l.unreadableWhy(host.bot)}</p>
      <details className="bot-setup-sent">
        <summary>{l.showSent(host.bot)}</summary>
        <pre translate="no">{source}</pre>
      </details>
      <div className="bot-setup-foot">
        <button className="btn" disabled={!!host.blocked} onClick={() => host.send(l.redrawAsk)}>
          <RotateCcw size={13} aria-hidden /> {l.redraw(host.bot)}
        </button>
      </div>
    </TurnCard>
  );
}

const GROUPS = [
  { id: "about", kinds: ["persona", "description", "model", "color", "picture", "remember"] },
  { id: "skills", kinds: ["skill"] },
  { id: "tools", kinds: ["toolset"] },
  { id: "mcp", kinds: ["mcp"] },
] as const;

function Card({ host, read, plan }: { host: SetupHost; read: BotSetupCardRead; plan: Plan }) {
  const l = useLocale().chat.botSetup;
  const ran = Object.keys(host.runs).length > 0;
  const count = setupItems(plan, read.parse.accepted).length;
  const owed = read.readyOwed;
  const out = host.outcome;
  // Try again and Apply anyway change an item after Set it up, so the count is read from each item's state now.
  const judged = Object.values(host.runs).filter((s) => s.kind !== "waiting");
  const canSetUp = !host.busy && !host.blocked && host.mcpReload !== "working" && (count > 0 || owed);
  const again = read.parse.card.again;
  const folded = (i: PlanItem) => again && i.status === "same" && !host.runs[i.key];
  const row = (item: PlanItem) => <Row key={item.key} host={host} read={read} item={item} />;
  return (
    <TurnCard kind="bot-setup" icon={<Sparkles size={14} aria-hidden />} heading={again ? l.againTitle(host.bot) : l.title(host.bot)} tips={{ hide: l.hide, show: l.show }} data-card={plan.cardId}>
      {judged.length > 0 ? (
        <p className="bot-setup-note" role="status">
          {l.appliedOf(judged.filter((s) => s.kind === "applied").length, judged.length)}
        </p>
      ) : (
        <p className="bot-setup-note">{again ? l.againIntro(host.bot) : l.intro(host.bot)}</p>
      )}
      {GROUPS.map((g) => {
        const items = plan.items.filter((i) => (g.kinds as readonly string[]).includes(i.kind));
        if (!items.length) return null;
        const offered = items.filter(tickable).filter((i) => !rememberAsked(read.parse.accepted, i));
        return (
          <section key={g.id} className="bot-setup-group" aria-label={g.id === "about" ? l.about(host.bot) : l[g.id]}>
            <h4 className="bot-setup-group-head">
              <span>{g.id === "about" ? l.about(host.bot) : l[g.id]}</span>
              {!ran && offered.length > 0 && <span>{l.ticked(offered.filter((i) => i.ticked).length, offered.length)}</span>}
            </h4>
            <ul className="bot-setup-items">
              {items.filter((i) => !folded(i)).map(row)}
              {items.some(folded) && <Unchanged>{items.filter(folded).map(row)}</Unchanged>}
            </ul>
          </section>
        );
      })}
      {host.restart && <RestartRow host={host} restart={host.restart} />}
      <div className="bot-setup-foot">
        <button className="btn primary" disabled={!canSetUp} onClick={host.setUp}>
          {host.busy && <Spinner />} {l.setUp}
        </button>
        <span className="bot-setup-foot-note">
          {host.busy
            ? l.settingUp
            : host.blocked === "offline"
              ? l.offline
              : host.blocked === "replying"
                ? l.waitReply(host.bot)
                : count > 0
                  ? l.changes(count)
                  : owed
                    ? l.readyOwed(host.bot)
                    : l.nothing}
        </span>
      </div>
      {out?.readyFailed && (
        <p className="bot-setup-bad small" role="alert">
          {l.readyFailed(host.bot, out.readyFailed.kind === "notShown" ? l.notShown(out.readyFailed.profile) : out.readyFailed.text)}
        </p>
      )}
    </TurnCard>
  );
}

function Unchanged({ children }: { children: ReactNode[] }) {
  const l = useLocale().chat.botSetup;
  const [open, setOpen] = useState(false);
  return (
    <li className="bot-setup-unchanged">
      <button className="link-btn small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronRight size={13} className={`chev ${open ? "open" : ""}`} aria-hidden /> {l.unchanged(children.length)}
      </button>
      {open && <ul className="bot-setup-items">{children}</ul>}
    </li>
  );
}

const colorName = (l: Locale["chat"]["botSetup"], hex: string | null) => {
  const named = BOT_SETUP_COLORS.find((c) => BOT_SETUP_COLOR_HEX[c] === hex);
  return named ? l.colors[named] : (hex ?? l.hermesColor);
};

/** What Hermes did besides an applied change, in Settings' words. */
function noteText(l: Locale, n: Note, label: string) {
  const w = l.profiles.form.setup.note;
  return n.kind === "installing" ? w.installing(n.keys, label) : n.kind === "warning" ? w.warning(n.text, label) : n.kind === "mcpBack" ? w.mcpBack(label) : w.everywhereBack(label);
}

function Row({ host, read, item }: { host: SetupHost; read: BotSetupCardRead; item: PlanItem }) {
  const loc = useLocale();
  const l = loc.chat.botSetup;
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [whole, setWhole] = useState(false);
  const [showNow, setShowNow] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    editButton.current?.focus();
  }, [editing]);
  const closeEditor = () => {
    refocus.current = true;
    setEditing(false);
  };
  const listed = item.status !== "notFound" && item.status !== "unavailable" ? item : undefined;
  const run: ItemRun | undefined = host.runs[item.key] ?? (item.status === "same" && read.mcpReload.includes(item.key) ? { kind: "reload" } : undefined);
  // The Remember row is applied once the bot's memory lists the name, which the card reads back as nothing to change.
  const done = item.status === "same" && (run?.kind === "applied" || run?.kind === "waiting");
  const addedAwaitingReload = item.status === "same" && run?.kind === "reload";
  // An item changed elsewhere since Set it up shows its tick, not its run, so only a tick writes over the change.
  const shownRun: ItemRun | undefined = done
    ? { kind: "applied" }
    : addedAwaitingReload
      ? run
      : item.status === "same" || item.status === "elsewhere"
        ? undefined
        : (run ?? (rememberAsked(read.parse.accepted, item) ? { kind: "waiting" } : undefined));
  const offer = listed?.kind === "mcp" && read.setup.mcp && listed.name !== undefined ? mcpOffer(read.setup.mcp, listed.name, listed.from) : undefined;
  const label = labelOf(l, read, item);
  const beforeAfter = read.parse.card.again && tickable(item);
  const src = pictureSrc(host, read);
  const value = listed ? (
    valueOf(l, listed, beforeAfter, src)
  ) : item.status === "unavailable" && item.name ? (
    <span className="bot-setup-value">
      {" · "}
      <PictureName pictureKey={`set:${item.name}`} now={null} src={src} />
    </span>
  ) : undefined;
  const edited = listed && listed.over.length > 0 && listed.after !== listed.proposed;
  const refused = item.status === "notFound" ? item.why : undefined;
  const badge = refused
    ? l.mcpCantAdd
    : item.status === "notFound"
      ? l.notFound
      : item.status === "unavailable"
        ? l.unavailable
        : item.from !== undefined
          ? l.from(item.from)
          : (item.kind === "skill" || item.kind === "toolset") && item.status === "change"
            ? l.suggested
            : undefined;
  const editable = listed && !host.busy && !shownRun && (item.kind === "persona" || item.kind === "description" || item.kind === "color" || (item.kind === "model" && read.setup.now.models.length > 1));
  const ticked = tickable(item) && item.ticked;
  const sub =
    item.status === "notFound"
      ? refused
        ? refused === "path"
          ? l.mcpRefused.path(item.from ?? "")
          : l.mcpRefused[refused]
        : l.notFoundWhy
      : item.status === "unavailable"
        ? l.pictureOff(failureText(loc, item.off, read.profile))
        : item.status === "same" && !done && !addedAwaitingReload
        ? item.kind === "model"
          ? l.inUse
          : item.kind === "remember"
            ? l.remembered(host.bot)
            : l.already
        : item.status === "elsewhere" && !shownRun
          ? l.elsewhere
          : !shownRun && item.kind === "remember"
            ? l.rememberWhere(host.bot)
            : !shownRun && (item.kind === "skill" || item.kind === "toolset")
              ? beforeAfter
                ? l.fromTo(l.state[item.before], l.state[item.after])
                : item.after === "on"
                  ? l.turnOn
                  : l.turnOff
              : !shownRun && item.kind === "picture"
                ? pictureWhy(l, item.after)
                : undefined;
  const dim = item.status === "notFound" || item.status === "unavailable" || (item.status === "same" && !done && !addedAwaitingReload);
  return (
    <li className={`bot-setup-item${dim ? " dim" : ""}`}>
      <span className="bot-setup-mark">
        {shownRun ? (
          <RunIcon run={shownRun} />
        ) : (
          <input
            type="checkbox"
            aria-labelledby={id}
            checked={ticked}
            disabled={!tickable(item) || host.busy}
            onChange={() => listed && host.choose(choose(listed, { ticked: !ticked }))}
          />
        )}
      </span>
      <div className="bot-setup-body">
        <div className="bot-setup-head">
          <span id={id} className={`bot-setup-label${item.status === "notFound" ? " gone" : ""}`} translate={item.kind === "skill" || item.kind === "mcp" ? "no" : undefined}>
            {label}
          </span>
          {value}
          {edited && <span className="bot-setup-edited"> · {l.edited}</span>}
          <span className="bot-setup-spacer" />
          {badge && <span className={`badge${item.status === "notFound" ? " warn" : ""}`}>{badge}</span>}
          {editable && !editing && (
            <button ref={editButton} className="icon-btn bot-setup-edit" title={l.edit(label)} aria-label={l.edit(label)} onClick={() => setEditing(true)}>
              <Pencil size={13} aria-hidden />
            </button>
          )}
        </div>
        {listed?.kind === "persona" && !editing && (
          <>
            <div className={`bot-setup-persona${whole ? "" : " clamped"}`} translate="no">
              {listed.after}
            </div>
            {listed.after.length > 280 && (
              <button className="link-btn small" onClick={() => setWhole((w) => !w)}>
                {whole ? l.showLess : l.showAll}
              </button>
            )}
            {beforeAfter && (
              <button className="link-btn small" aria-expanded={showNow} onClick={() => setShowNow((n) => !n)}>
                {showNow ? l.hideNow : l.showNow}
              </button>
            )}
            {beforeAfter && showNow && (
              <div className="bot-setup-persona was" role="group" aria-label={l.personaNow} translate="no">
                {listed.before.trim() || l.none}
              </div>
            )}
          </>
        )}
        {sub && <div className="bot-setup-sub">{sub}</div>}
        {listed?.kind === "picture" && !shownRun && <PictureStrip host={host} item={listed} src={src} />}
        {listed && offer && offer.kind !== "refused" && !shownRun && tickable(item) && <McpDetail host={host} item={listed} offer={offer} onConnect={() => setConnecting(true)} />}
        {shownRun && <RunText host={host} item={item} run={shownRun} locale={loc} connectFilled={!!(listed && offer && host.secrets[listed.key] && connected(offer, host.secrets[listed.key]))} onConnect={() => setConnecting(true)} />}
        {connecting && listed && offer && offer.kind !== "refused" && (
          <ConnectEditor
            name={listed.name ?? ""}
            offer={offer}
            onCancel={() => setConnecting(false)}
            onDone={(values) => {
              setConnecting(false);
              host.connect(listed, values);
            }}
          />
        )}
        {editing && listed && (
          <Editor
            item={listed}
            label={label}
            models={read.setup.now.models}
            onCancel={closeEditor}
            onDone={(to) => {
              host.choose(choose(listed, { to } as { to: ListedItem["after"] }));
              closeEditor();
            }}
          />
        )}
      </div>
    </li>
  );
}

function labelOf(l: Locale["chat"]["botSetup"], read: BotSetupCardRead, item: PlanItem): string {
  if (item.status === "notFound") return item.name;
  switch (item.kind) {
    case "persona":
      return l.persona;
    case "description":
      return l.description;
    case "model":
      return l.model;
    case "color":
      return l.color;
    case "picture":
      return l.picture;
    case "remember":
      return l.remember(item.after ?? "");
    case "toolset":
      return read.setup.labels[item.name ?? ""] ?? item.name ?? item.key;
    default:
      return item.name ?? item.key;
  }
}

/** Where to draw a picture key from: the set, the card's uploads, or the picture Hermes has now. */
const pictureSrc =
  (host: SetupHost, read: BotSetupCardRead) =>
  (key: string): string | undefined => {
    const name = setPicture(key);
    if (name) return BOT_PICTURE_DATA[name];
    return host.uploads[key] ?? (key === read.setup.now.picture ? (read.setup.picture ?? undefined) : undefined);
  };

/** A picture's name: the set's, or what any other picture is to the bot. `now`: the key of the picture Hermes has. */
const pictureName = (l: Locale["chat"]["botSetup"], key: string | null, now: string | null) => {
  const name = setPicture(key);
  return name ? l.pictures[name] : key === null ? l.noPicture : key === now ? l.pictureNow : l.pictureYours;
};

function PictureName({ pictureKey: key, now, src }: { pictureKey: string | null; now: string | null; src: (key: string) => string | undefined }) {
  const l = useLocale().chat.botSetup;
  const shown = key === null ? undefined : src(key);
  return (
    <>
      {shown && <img className="bot-setup-thumb" src={shown} alt="" />}
      {pictureName(l, key, now)}
    </>
  );
}

const pictureWhy = (l: Locale["chat"]["botSetup"], key: string | null) => {
  const name = setPicture(key);
  return name && l.pictureFor[name];
};

function valueOf(l: Locale["chat"]["botSetup"], item: ListedItem, beforeAfter: boolean, src: (key: string) => string | undefined): ReactNode {
  const was = (now: ReactNode) =>
    beforeAfter && (
      <>
        <span className="bot-setup-was">{now}</span>
        {" → "}
      </>
    );
  const model = (m: string | null) => (
    <span className="mono" translate="no">
      {m ?? "—"}
    </span>
  );
  const color = (hex: string | null) => (
    <>
      {hex && <span className="bot-setup-swatch" style={{ background: hex }} aria-hidden />} {colorName(l, hex)}
    </>
  );
  switch (item.kind) {
    case "description":
      return (
        <span className="bot-setup-value">
          {" · "}
          {was(item.before.trim() || l.none)}
          {item.after}
        </span>
      );
    case "model":
      return (
        <span className="bot-setup-value">
          {" · "}
          {was(model(item.before))}
          {model(item.after)}
        </span>
      );
    case "color":
      return (
        <span className="bot-setup-value">
          {" · "}
          {was(color(item.before))}
          {color(item.after)}
        </span>
      );
    case "picture":
      return (
        <span className="bot-setup-value">
          {" · "}
          {was(<PictureName pictureKey={item.before} now={item.before} src={src} />)}
          <PictureName pictureKey={item.after} now={item.before} src={src} />
        </span>
      );
    case "toolset":
      return (
        <span className="bot-setup-value mono" translate="no">
          {" "}
          {item.name}
        </span>
      );
    default:
      return null;
  }
}

/**
 * The set as a strip of radio buttons, the bot's pick marked, then the picture Hermes has now and the owner's upload
 * when they aren't of the set. Choosing one ticks the row. Upload your own… takes a file under Edit bot's rules.
 */
function PictureStrip({ host, item, src }: { host: SetupHost; item: Extract<ListedItem, { kind: "picture" }>; src: (key: string) => string | undefined }) {
  const loc = useLocale();
  const l = loc.chat.botSetup;
  const f = loc.profiles.form;
  const group = useId();
  const input = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string>();
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const pick = (to: string) => host.choose(choose(item, { to: to as typeof item.after, ticked: true }));
  const others = [...new Set([item.before, item.after].flatMap((k) => (k !== null && !setPicture(k) ? [k] : [])))];
  const options = [
    ...BOT_SETUP_PICTURES.map((p) => ({ key: `set:${p}`, label: l.pictures[p] })),
    ...others.map((k) => ({ key: k, label: pictureName(l, k, item.before) })),
  ].flatMap((o) => {
    const shown = src(o.key);
    return shown ? [{ ...o, src: shown }] : [];
  });
  const upload = async (file: File | undefined) => {
    if (!file) return;
    const read = await readPictureFile(file);
    if (!live.current) return;
    if (read.kind !== "read") return setNote(read.kind === "format" ? f.pictureFormat : read.kind === "tooBig" ? f.pictureTooBig : f.pictureUnread);
    setNote(undefined);
    pick(host.upload(read.dataUrl));
  };
  return (
    <div className="bot-setup-pictures">
      <div className="bot-setup-strip" role="radiogroup" aria-label={l.pictureSet}>
        {options.map((o) => {
          const botsPick = item.name !== undefined && o.key === item.proposed;
          return (
            <label key={o.key} className="bot-setup-pic" title={botsPick ? l.botsPick(o.label, host.bot) : o.label}>
              <input type="radio" className="sr-only" name={group} checked={item.after === o.key} disabled={host.busy} onChange={() => pick(o.key)} />
              <img src={o.src} alt="" />
              <span className="sr-only">{botsPick ? l.botsPick(o.label, host.bot) : o.label}</span>
              {botsPick && <Sparkles size={11} className="bot-setup-pick" aria-hidden />}
            </label>
          );
        })}
      </div>
      <div className="bot-setup-run">
        <input
          ref={input}
          type="file"
          hidden
          accept={PICTURE_TYPES.join(",")}
          aria-label={l.pictureUpload}
          onChange={(e) => {
            void upload(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <button className="btn" disabled={host.busy} onClick={() => input.current?.click()}>
          <ImagePlus size={13} aria-hidden /> {l.pictureUpload}
        </button>
        <span className="bot-setup-sub">{f.pictureHint}</span>
      </div>
      {note && (
        <div className="bot-setup-sub bot-setup-bad" role="alert">
          {note}
        </div>
      )}
    </div>
  );
}

function RunIcon({ run }: { run: ItemRun }) {
  switch (run.kind) {
    case "working":
      return <Spinner />;
    case "applied":
      return <Check size={14} className="bot-setup-ok" aria-hidden />;
    case "failed":
      return <CircleAlert size={14} className="bot-setup-bad" aria-hidden />;
    case "confirm":
      return <TriangleAlert size={14} className="bot-setup-warn" aria-hidden />;
    case "waiting":
    case "reload":
      return <Hourglass size={14} className="bot-setup-warn" aria-hidden />;
    case "connect":
      return <Plug size={14} className="bot-setup-warn" aria-hidden />;
  }
}

function RunText({ host, item, run, locale: loc, connectFilled, onConnect }: { host: SetupHost; item: PlanItem; run: ItemRun; locale: Locale; connectFilled: boolean; onConnect: () => void }) {
  const l = loc.chat.botSetup;
  const listed = item.status !== "notFound" && item.status !== "unavailable" ? item : undefined;
  const again = (accept: boolean) => listed && host.retry(listed, accept);
  switch (run.kind) {
    case "working":
      return <div className="bot-setup-sub">{l.working}</div>;
    case "waiting":
      return (
        <div className="bot-setup-run">
          <div className="bot-setup-sub bot-setup-warn">{l.waitingMemory(host.bot)}</div>
          <button className="btn" disabled={host.blocked === "offline"} onClick={host.reload}>
            {l.checkAgain}
          </button>
        </div>
      );
    case "connect":
      return (
        <div className="bot-setup-run">
          <div className={connectFilled ? "bot-setup-sub" : "bot-setup-sub bot-setup-warn"}>{connectFilled ? l.mcpReady : l.waitingConnect}</div>
          {connectFilled && (
            <button className="btn" disabled={host.busy || host.blocked === "offline" || host.mcpReload === "working"} onClick={() => again(false)}>
              {l.setUp}
            </button>
          )}
          <button className="btn" disabled={host.blocked === "offline"} onClick={onConnect}>
            <Plug size={13} aria-hidden /> {l.connect}
          </button>
        </div>
      );
    case "reload": {
      const r = host.mcpReload;
      return (
        <div className="bot-setup-run">
          <div className="bot-setup-sub bot-setup-warn">
            {r === "replying" ? l.reloadReplying : l.waitingReload(host.bot)}
            {typeof r === "object" && (
              <div className="bot-setup-bad" role="alert" translate="no">
                {l.reloadFailed(r.failed)}
              </div>
            )}
          </div>
          <button className="btn" disabled={!!host.blocked || host.busy || r === "working"} onClick={host.reloadMcp}>
            {r === "working" ? <Spinner /> : <RotateCcw size={13} aria-hidden />} {l.reloadMcp}
          </button>
        </div>
      );
    }
    case "applied": {
      const label = listed?.kind === "toolset" ? labelOf(l, cardRead(host)!, item) : (listed?.name ?? "");
      return (
        <div className="bot-setup-sub">
          {item.kind === "remember"
            ? l.remembered(host.bot)
            : item.kind === "mcp"
              ? l.mcpReloaded
              : item.kind === "skill" && item.from !== undefined
                ? l.copied(item.from)
                : l.applied}
          {run.notes?.map((n, i) => (
            <div key={i}>{noteText(loc, n, label)}</div>
          ))}
        </div>
      );
    }
    case "failed": {
      const m = run.miss;
      return (
        <div className="bot-setup-run">
          <div className="bot-setup-sub bot-setup-bad" role="alert">
            <MissText miss={m} profile={cardRead(host)?.profile ?? host.bot} locale={loc} />
          </div>
          {m.kind !== "changed" && (
            <button className="btn" disabled={host.blocked === "offline" || (item.kind === "mcp" && host.mcpReload === "working")} onClick={() => again(false)}>
              <RotateCcw size={13} aria-hidden /> {l.tryAgain}
            </button>
          )}
        </div>
      );
    }
    case "confirm":
      return (
        <div className="bot-setup-run">
          <div className="bot-setup-sub bot-setup-warn">
            {l.confirmFirst}
            {run.cautions.map((c, i) => (
              <div key={i} className="profile-conflict">
                {cautionText(c, run.toolset, loc.toolsets.caution)}
              </div>
            ))}
          </div>
          <button className="btn" disabled={host.blocked === "offline"} onClick={() => again(true)}>
            {l.applyAnyway}
          </button>
        </div>
      );
  }
}

function MissText({ miss: m, profile, locale: loc }: { miss: CardMiss; profile: string; locale: Locale }) {
  const l = loc.chat.botSetup;
  switch (m.kind) {
    case "said":
      return <span translate="no">{m.text}</span>;
    case "unsent":
      return (
        <>
          {l.unsent} <span translate="no">{m.text}</span>
        </>
      );
    case "changed":
      return l.changedElsewhere;
    case "profile":
      return failureText(loc, m.failure, profile);
    case "noProvider":
      return l.noProvider(m.model);
    case "notShown":
      return l.notShown(m.profile);
    case "mcpRefused":
      return m.why === "path" ? l.mcpRefused.path(m.from ?? "") : l.mcpRefused[m.why];
    default:
      return l[m.kind];
  }
}

function McpDetail({ host, item, offer, onConnect }: { host: SetupHost; item: ListedItem; offer: Exclude<McpOffer, { kind: "refused" }>; onConnect: () => void }) {
  const l = useLocale().chat.botSetup;
  const url = offer.kind === "copy" ? offer.server.transport === "http" : !!offer.entry.url;
  const given = host.secrets[item.key];
  const needs = offer.secrets.filter((s) => s.required).map((s) => (s.bearer ? l.bearer : s.key));
  return (
    <>
      <div className="bot-setup-sub">
        {offer.kind === "catalog" ? l.mcpCatalog : l.mcpCopy(item.from ?? "")} {url ? l.mcpUrl : l.mcpRuns}{" "}
        {offer.runs.map((r, i) => (
          <code key={i} className="bot-setup-runs" translate="no">
            {r}
          </code>
        ))}
      </div>
      {offer.kind === "copy" && <div className="bot-setup-sub">{l.mcpNotCopied(offer.toolFilter)}</div>}
      {offer.secrets.length > 0 && (
        <div className="bot-setup-run">
          <div className="bot-setup-sub">{given && connected(offer, given) ? l.mcpReady : needs.length > 0 && l.mcpNeeds(needs.join(", "))}</div>
          <button className="btn" disabled={host.busy} onClick={onConnect}>
            <Plug size={13} aria-hidden /> {l.connect}
          </button>
        </div>
      )}
    </>
  );
}

function ConnectEditor({ name, offer, onDone, onCancel }: { name: string; offer: Exclude<McpOffer, { kind: "refused" }>; onDone: (values: Record<string, string>) => void; onCancel: () => void }) {
  const l = useLocale().chat.botSetup;
  const [values, setValues] = useState<Record<string, string>>({});
  const filled = Object.fromEntries(Object.entries(values).flatMap(([k, v]) => (v.trim() ? [[k, v.trim()]] : [])));
  const ok = connected(offer, filled);
  return (
    <div className="bot-setup-editor bot-setup-connect" role="group" aria-label={`${l.connect} ${name}`}>
      <p className="bot-setup-sub">{l.connectIntro}</p>
      {offer.secrets.map((s) => (
        <label key={s.key} className="bot-setup-secret">
          <span>
            <span className="mono" translate="no">
              {s.bearer ? l.bearer : s.key}
            </span>
            {!s.required && ` (${l.connectOptional})`}
            {s.prompt && <span className="bot-setup-sub"> · {s.prompt}</span>}
          </span>
          <input
            className="bot-setup-field"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={values[s.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [s.key]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onCancel();
              } else if (e.key === "Enter" && !composing(e) && ok) {
                e.preventDefault();
                onDone(filled);
              }
            }}
          />
        </label>
      ))}
      <p className="bot-setup-sub">{l.connectWriteOnly}</p>
      <div className="bot-setup-editor-actions">
        <button className="btn" disabled={!ok} onClick={() => onDone(filled)}>
          {l.connect}
        </button>
        <button className="btn" onClick={onCancel}>
          {l.cancel}
        </button>
      </div>
    </div>
  );
}

function Editor({ item, label, models, onDone, onCancel }: { item: ListedItem; label: string; models: readonly string[]; onDone: (to: string | null) => void; onCancel: () => void }) {
  const l = useLocale().chat.botSetup;
  const [v, setV] = useState(typeof item.after === "string" ? item.after : "");
  const ok = v.trim().length > 0;
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Enter" && !composing(e) && (item.kind !== "persona" || e.ctrlKey || e.metaKey) && ok) {
      e.preventDefault();
      onDone(item.kind === "persona" ? v : v.trim());
    }
  };
  const field =
    item.kind === "persona" ? (
      <textarea className="bot-setup-field" autoFocus rows={8} aria-label={label} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={keys} />
    ) : item.kind === "description" ? (
      <input className="bot-setup-field" autoFocus aria-label={label} maxLength={BOT_SETUP_DESCRIPTION_MAX} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={keys} />
    ) : item.kind === "model" ? (
      <select className="bot-setup-field" autoFocus aria-label={label} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={keys}>
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    ) : (
      <select className="bot-setup-field" autoFocus aria-label={label} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={keys}>
        {BOT_SETUP_COLORS.map((c) => (
          <option key={c} value={BOT_SETUP_COLOR_HEX[c]}>
            {l.colors[c]}
          </option>
        ))}
      </select>
    );
  return (
    <div className="bot-setup-editor">
      {field}
      <div className="bot-setup-editor-actions">
        <button className="btn" disabled={!ok} onClick={() => onDone(item.kind === "persona" ? v : v.trim())}>
          {l.done}
        </button>
        <button className="btn" onClick={onCancel}>
          {l.cancel}
        </button>
      </div>
    </div>
  );
}

function RestartRow({ host, restart }: { host: SetupHost; restart: Restart }) {
  const l = useLocale().chat.botSetup;
  const s = restart.state;
  const ok = s === "rebuilt" || s === "matched" || s === "unchecked";
  const text =
    s === "waiting" || s === "checking"
      ? l.restartWaiting(host.bot)
      : s === "rebuilt"
        ? l.restartRebuilt(host.bot)
        : s === "matched"
          ? l.restartDone(host.bot)
          : s === "unchecked"
            ? l.restartUnchecked(host.bot)
            : s === "notYet"
              ? l.restartNotYet(host.bot)
              : s.failed;
  return (
    <section className="bot-setup-group" aria-label={l.restart}>
      <h4 className="bot-setup-group-head">
        <span>{l.restart}</span>
      </h4>
      <ul className="bot-setup-items">
        <li className="bot-setup-item">
          <span className="bot-setup-mark">{ok ? <Check size={14} className="bot-setup-ok" aria-hidden /> : s === "checking" ? <Spinner /> : <Hourglass size={14} className="bot-setup-warn" aria-hidden />}</span>
          <div className="bot-setup-body">
            <div className="bot-setup-head">
              <span>{l.restartItem(host.bot)}</span>
            </div>
            <div className={`bot-setup-sub${ok ? "" : " bot-setup-warn"}`}>{text}</div>
            {!ok && s !== "waiting" && s !== "checking" && (
              <button className="btn" onClick={host.checkRestart}>
                {l.checkAgain}
              </button>
            )}
          </div>
        </li>
      </ul>
    </section>
  );
}

/** A Bot Chat's hidden brief and begin turn, shown as one line, or why the bot's first reply never came, with Try again. */
export function SetupLine({ item }: { item: Extract<Item, { kind: "returned" }> }) {
  const host = useContext(SetupContext);
  const l = useLocale().chat.botSetup;
  const start = host?.start;
  if (host && start?.kind === "noReply" && start.id === item.setup?.id)
    return (
      <div className="bot-setup-line failed" role="alert" data-item={item.id}>
        <div className="bot-setup-line-head">
          <TriangleAlert size={14} aria-hidden /> {l.notStarted}
        </div>
        <p>
          {start.error ? <span translate="no">{l.hermesSaid(start.error)}</span> : l.noReply} {l.kept(host.bot)}
        </p>
        <button className="btn" disabled={!!host.blocked} onClick={host.startAgain}>
          <RotateCcw size={13} aria-hidden /> {l.tryAgain}
        </button>
      </div>
    );
  return (
    <div className="bot-setup-line" data-item={item.id}>
      <Sparkles size={13} aria-hidden /> <span>{l.started}</span>
    </div>
  );
}
