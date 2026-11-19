// Bot setup in a Bot Chat (ADR 0231): the review card drawn in place of the bot's setup block, its earlier drafts, a
// block that doesn't parse, and the Setup started line. Which block is which comes from the Bot Chat's stored rows,
// read on open and after each reply (`useBotSetup`); what the card offers and what a choice does, from botSetupCard.ts;
// what Set it up writes, from botSetupApply.ts. The pane keeps the pending edits above the transcript, so a card
// scrolled out of the rendered window keeps them.
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronRight, CircleAlert, FileText, Hourglass, Pencil, RotateCcw, Sparkles, TriangleAlert } from "lucide-react";
import { BOT_SETUP_COLORS, BOT_SETUP_DESCRIPTION_MAX, BOT_SETUP_FENCE } from "../hermes/botSetupBrief";
import { BOT_SETUP_COLOR_HEX, choose, fencedBlocks, planCard, tickable, tickedCount, type Choice, type ListedItem, type Plan, type PlanItem } from "../hermes/botSetupCard";
import { restartState, tickedItems, type CardState } from "../hermes/botSetupApply";
import type { Note } from "../hermes/botSetup";
import type { BotSetupStart } from "../hermes/botSetupStart";
import type { Chat, Item } from "../hermes/model";
import type { BotSetupCardRead, BotSetupRead, BotSetupRun, Hermes } from "../hermes/transport";
import { errorText } from "../hermes/values";
import { useLocale, type Locale } from "../i18n/locale";
import { composing, Spinner } from "./bits";
import { cautionText } from "./ToolsetSettings";
import { TurnCard } from "./TurnCard";

/** What a Bot Chat's pane asks of the transport for Bot setup. */
export type BotSetupApi = Pick<Hermes, "readBotSetup" | "applyBotSetup" | "retryBotSetupItem" | "botSetupRestart" | "resumeBotSetup">;

type ItemRun = CardState | { kind: "working" };

/** The Restart row after a ready turn sent at `since`, for the toolsets Set it up applied. */
type Restart = { since: number; toolsets: { name: string; on: boolean }[]; state: "waiting" | "checking" | ReturnType<typeof restartState> | { failed: string } };

/** What a setup block in the transcript is: the live card, an earlier draft, the unreadable newest, or none of Bot setup's. */
type BlockRole = "live" | "draft" | "unreadable" | "pending" | "failed" | "plain";

/** One Bot Chat's Bot setup, for the blocks and lines its transcript draws. */
export type SetupHost = {
  bot: string;
  read?: { kind: "read"; read: BotSetupRead } | { kind: "failed"; why: string };
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
  reload(): void;
  send(text: string): void;
  restart?: Restart;
  checkRestart(): void;
  start?: BotSetupStart;
  startAgain(): void;
};

export const SetupContext = createContext<SetupHost | undefined>(undefined);
/** The transcript item a setup block is in. */
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
  const shown = useRef({ chatId, reads: 0, started: false, readOnce: false, holds: false, afterSetUp: false });
  const mentions = chat.items.some((i) => i.kind === "assistant" && i.text.includes(BOT_SETUP_FENCE));

  useEffect(() => {
    shown.current = { chatId, reads: 0, started: false, readOnce: false, holds: false, afterSetUp: false };
    setRead(undefined);
    setPending([]);
    setRuns({});
    setOutcome(undefined);
    setRestart(undefined);
    setStart(undefined);
  }, [chatId]);

  const here = (id: string) => shown.current.chatId === id;
  const load = useCallback(() => {
    if (!api) return;
    const n = ++shown.current.reads;
    api.readBotSetup(chatId).then(
      (r) => {
        if (!here(chatId) || n !== shown.current.reads) return;
        shown.current.readOnce = true;
        shown.current.holds = setupIdOf(r) !== null;
        setRead({ kind: "read", read: r });
        if (shown.current.afterSetUp) {
          shown.current.afterSetUp = false;
          setPending([]);
        }
        if (shown.current.holds && !shown.current.started) {
          shown.current.started = true;
          api.resumeBotSetup().then(
            (s) => here(chatId) && setStart(s),
            () => {},
          );
        }
      },
      (e: unknown) => here(chatId) && n === shown.current.reads && setRead({ kind: "failed", why: errorText(e) }),
    );
  }, [api, chatId]);

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
  const hear = (key: string, state: ItemRun) => here(chatId) && setRuns((p) => ({ ...p, [key]: state }));
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
      const items = tickedItems(plan);
      api.applyBotSetup(r, plan, hear).then(
        (out) => {
          if (!here(chatId)) return;
          setOutcome(out);
          setBusy(false);
          shown.current.afterSetUp = true;
          const applied = items.filter((i) => out.states[i.key]?.kind === "applied");
          const toolsets = applied.flatMap((i) => (i.kind === "toolset" ? [{ name: i.name ?? i.key, on: i.after === "on" }] : []));
          if (out.readyAt !== undefined && (toolsets.length || applied.some((i) => i.kind === "persona"))) setRestart({ since: out.readyAt, toolsets, state: "waiting" });
          // With a ready turn, the rows are read once its reply ends.
          if (out.readyAt === undefined) load();
        },
        (e: unknown) => {
          if (!here(chatId)) return;
          setOutcome({ states: {}, readyFailed: errorText(e) });
          setBusy(false);
        },
      );
    },
    retry(item, accept) {
      if (!r) return;
      const was = runs[item.key];
      hear(item.key, { kind: "working" });
      api.retryBotSetupItem(r, item, accept && was?.kind === "confirm" ? was.cautions : []).then(
        (state) => hear(item.key, state),
        (e: unknown) => hear(item.key, { kind: "failed", miss: { kind: "said", text: errorText(e) } }),
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

/** Draws Bot setup's fenced block in its place in the transcript, and every other block as code. */
export const setupFence = (language: string, source: string, plain: ReactNode): ReactNode =>
  language === BOT_SETUP_FENCE ? <SetupBlock source={source} plain={plain} /> : plain;

function SetupBlock({ source, plain }: { source: string; plain: ReactNode }) {
  const host = useContext(SetupContext);
  const itemId = useContext(SetupItemContext);
  const l = useLocale().chat.botSetup;
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
              {l.readFailed(host.read.why)}{" "}
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
  { id: "about", kinds: ["persona", "description", "model", "color", "remember"] },
  { id: "skills", kinds: ["skill"] },
  { id: "tools", kinds: ["toolset"] },
  { id: "mcp", kinds: ["mcp"] },
] as const;

function Card({ host, read, plan }: { host: SetupHost; read: BotSetupCardRead; plan: Plan }) {
  const l = useLocale().chat.botSetup;
  const ran = Object.keys(host.runs).length > 0;
  const count = tickedCount(plan);
  const owed = read.readyOwed;
  const out = host.outcome;
  // Try again and Apply anyway change an item after Set it up, so the count is read from each item's state now.
  const judged = Object.values(host.runs).filter((s) => s.kind !== "waiting");
  const canSetUp = !host.busy && !host.blocked && (count > 0 || owed);
  return (
    <TurnCard kind="bot-setup" icon={<Sparkles size={14} aria-hidden />} heading={l.title(host.bot)} tips={{ hide: l.hide, show: l.show }} data-card={plan.cardId}>
      {judged.length > 0 ? (
        <p className="bot-setup-note" role="status">
          {l.appliedOf(judged.filter((s) => s.kind === "applied").length, judged.length)}
        </p>
      ) : (
        <p className="bot-setup-note">{l.intro(host.bot)}</p>
      )}
      {GROUPS.map((g) => {
        const items = plan.items.filter((i) => (g.kinds as readonly string[]).includes(i.kind));
        if (!items.length) return null;
        const offered = items.filter(tickable);
        return (
          <section key={g.id} className="bot-setup-group" aria-label={g.id === "about" ? l.about(host.bot) : l[g.id]}>
            <h4 className="bot-setup-group-head">
              <span>{g.id === "about" ? l.about(host.bot) : l[g.id]}</span>
              {!ran && offered.length > 0 && <span>{l.ticked(offered.filter((i) => i.ticked).length, offered.length)}</span>}
            </h4>
            <ul className="bot-setup-items">
              {items.map((item) => (
                <Row key={item.key} host={host} read={read} item={item} />
              ))}
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
          {l.readyFailed(host.bot, out.readyFailed)}
        </p>
      )}
    </TurnCard>
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
  const [whole, setWhole] = useState(false);
  const listed = item.status !== "notFound" ? item : undefined;
  const run = host.runs[item.key];
  // The Remember row is applied once the bot's memory lists the name, which the card reads back as nothing to change.
  const done = item.status === "same" && (run?.kind === "applied" || run?.kind === "waiting");
  const shownRun: ItemRun | undefined = done ? { kind: "applied" } : item.status === "same" ? undefined : run;
  const label = labelOf(l, read, item);
  const value = listed && valueOf(l, listed);
  const edited = listed && listed.over.length > 0 && listed.after !== listed.proposed;
  const badge = item.status === "notFound" ? l.notFound : item.from !== undefined ? l.from(item.from) : (item.kind === "skill" || item.kind === "toolset") && item.status === "change" ? l.suggested : undefined;
  const editable = listed && !host.busy && !shownRun && (item.kind === "persona" || item.kind === "description" || item.kind === "color" || (item.kind === "model" && read.setup.now.models.length > 1));
  const ticked = tickable(item) && item.ticked;
  const sub =
    item.status === "notFound"
      ? l.notFoundWhy
      : item.status === "same" && !done
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
              ? item.after === "on"
                ? l.turnOn
                : l.turnOff
              : undefined;
  const dim = item.status === "notFound" || (item.status === "same" && !done);
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
            <button className="icon-btn bot-setup-edit" title={l.edit(label)} aria-label={l.edit(label)} onClick={() => setEditing(true)}>
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
          </>
        )}
        {sub && <div className="bot-setup-sub">{sub}</div>}
        {shownRun && <RunText host={host} item={item} run={shownRun} locale={loc} />}
        {editing && listed && (
          <Editor
            item={listed}
            label={label}
            models={read.setup.now.models}
            onCancel={() => setEditing(false)}
            onDone={(to) => {
              host.choose(choose(listed, { to } as { to: ListedItem["after"] }));
              setEditing(false);
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
    case "remember":
      return l.remember(item.after ?? "");
    case "toolset":
      return read.setup.labels[item.name ?? ""] ?? item.name ?? item.key;
    default:
      return item.name ?? item.key;
  }
}

function valueOf(l: Locale["chat"]["botSetup"], item: ListedItem): ReactNode {
  switch (item.kind) {
    case "description":
      return <span className="bot-setup-value"> · {item.after}</span>;
    case "model":
      return (
        <span className="bot-setup-value">
          {" · "}
          <span className="mono" translate="no">
            {item.after ?? "—"}
          </span>
        </span>
      );
    case "color":
      return (
        <span className="bot-setup-value">
          {" · "}
          {item.after && <span className="bot-setup-swatch" style={{ background: item.after }} aria-hidden />} {colorName(l, item.after)}
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
      return <Hourglass size={14} className="bot-setup-warn" aria-hidden />;
  }
}

function RunText({ host, item, run, locale: loc }: { host: SetupHost; item: PlanItem; run: ItemRun; locale: Locale }) {
  const l = loc.chat.botSetup;
  const listed = item.status !== "notFound" ? item : undefined;
  const again = (accept: boolean) => listed && host.retry(listed, accept);
  switch (run.kind) {
    case "working":
      return <div className="bot-setup-sub">{l.working}</div>;
    case "waiting":
      return <div className="bot-setup-sub bot-setup-warn">{l.waitingMemory(host.bot)}</div>;
    case "applied": {
      const label = listed?.kind === "toolset" ? labelOf(l, cardRead(host)!, item) : (listed?.name ?? "");
      return (
        <div className="bot-setup-sub">
          {item.kind === "remember" ? l.remembered(host.bot) : item.kind === "skill" && item.from !== undefined ? l.copied(item.from) : l.applied}
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
            {m.kind === "said" ? (
              <span translate="no">{m.text}</span>
            ) : m.kind === "unsent" ? (
              <>
                {l.unsent} <span translate="no">{m.text}</span>
              </>
            ) : m.kind === "changed" ? (
              l.changedElsewhere
            ) : (
              l[m.kind]
            )}
          </div>
          {m.kind !== "changed" && (
            <button className="btn" disabled={host.blocked === "offline"} onClick={() => again(false)}>
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
