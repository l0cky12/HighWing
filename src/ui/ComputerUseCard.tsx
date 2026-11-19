// A computer-use run in the transcript (ADR 0216): one card with a line per action Hermes took on its Bot Desktop, who
// holds the screen now, and Watch live, which opens the side panel's Screen. Above the composer, a note when Hermes's
// last step was refused because a person holds the screen. The run is `foldRuns`'s (computerUse.ts); who holds the
// screen is the connection's ScreenControl's, through `ScreenDesk`.
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Ban, Check, ChevronRight, CircleAlert, Hand, Minus, MonitorOff, MonitorPlay, Square, X } from "lucide-react";
import { screenUse, type CuRun, type CuStep, type RunLine } from "../hermes/computerUse";
import { afterRead, afterTurnOn, noticeOf, type DesktopNotice, type TurnOnFailed } from "../hermes/computerUseReadiness";
import { isWaiting, type ApprovalChoice, type Chat, type Item } from "../hermes/model";
import { withoutBidi } from "../hermes/preview";
import type { ScreenHolder, ScreenState } from "../hermes/screenControl";
import type { Caution, Toolset, ToolsetsApi } from "../hermes/toolsets";
import { errorText } from "../hermes/values";
import { useLocale } from "../i18n/locale";
import { ApprovalCard } from "./ApprovalCard";
import { Spinner } from "./bits";
import { cautionText } from "./ToolsetSettings";

/** Who holds the shown profile's screen, and what the card and the notes can do about it. App provides it. */
export type ScreenDesk = {
  screen?: ScreenState;
  onWatch?: () => void;
  onHandBack?: () => Promise<void>;
  /** The shown profile's toolsets, for a Bot Chat's Desktop control notice. Absent while not connected. */
  toolsets?: { profile: string; api: Pick<ToolsetsApi, "list" | "cautions" | "set" | "subscribe" | "pending"> };
};

const ScreenDeskContext = createContext<ScreenDesk>({});

export function ScreenDeskProvider({ value, children }: { value: ScreenDesk; children: ReactNode }) {
  return <ScreenDeskContext.Provider value={value}>{children}</ScreenDeskContext.Provider>;
}

/**
 * The chat's own Stop, the composer's (ADR 0223), for the Stop on its live run. `lastRun`: the id of the current turn's
 * last run, the one that is live while the reply is `running`, and that offers Hand back once a Stop has taken the screen.
 * ChatPane provides it.
 */
export type RunStop = { onStop: () => void; stopping: boolean; running: boolean; lastRun?: string };

const RunStopContext = createContext<RunStop | undefined>(undefined);

export const RunStopProvider = RunStopContext.Provider;

type Words = ReturnType<typeof useLocale>["chat"]["computerUse"];

/** `m:ss` of a span in ms. */
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The time now, ticking once a second while `live`. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  return now;
}

/** `step N · m:ss` while the run is live, `N steps · m:ss` after; no time without the steps' times. */
function counter(run: CuRun, live: boolean, latest: number, now: number, l: Words): string {
  const { from, to } = run.span;
  const end = live ? now : to;
  return [live ? l.step(latest) : l.steps(run.steps), from !== undefined && end !== undefined && clock(end - from)].filter(Boolean).join(" · ");
}

const holderWords = (holder: ScreenHolder, l: Words) =>
  holder.kind === "agent" ? l.holder.agent : holder.kind === "you" ? l.holder.you : holder.kind === "you-before" ? l.holder.youBefore : l.holder.someone;

export function ComputerUseCard({
  run,
  offline,
  movedAt,
  onAnswer,
}: {
  run: CuRun;
  offline: boolean;
  movedAt: number;
  onAnswer: (approvalId: string, choice: ApprovalChoice, confirmed?: boolean) => void;
}) {
  const l = useLocale().chat.computerUse;
  const { screen, onWatch, onHandBack } = useContext(ScreenDeskContext);
  const stop = useContext(RunStopContext);
  const [open, setOpen] = useState(true);
  // Live while the reply runs, between two calls too; a call left running by a dropped connection isn't.
  const live = !!stop?.running && run.id === stop.lastRun;
  const state = live && run.state === "done" ? "acting" : run.state;
  const latest = [...run.lines].reverse().find((x) => x.kind === "step");
  const now = useNow(live);
  return (
    <div className={`msg returned cu-run ${state}`} data-item={run.id} data-calls={callIds(run.items) || undefined} tabIndex={-1}>
      <button className="returned-head" aria-expanded={open} title={open ? l.hide : l.show} onClick={() => setOpen((o) => !o)}>
        {live ? <Spinner /> : <MonitorPlay size={14} aria-hidden />}
        <span className="returned-title">
          {l.title} · <span className="cu-counter">{counter(run, live, latest?.kind === "step" ? latest.step.n : run.steps, now, l)}</span>
        </span>
        <span className={`cu-state ${state}`}>{l.state[state]}</span>
        <ChevronRight size={13} className={`chev ${open ? "open" : ""}`} aria-hidden />
      </button>
      <div className="cu-bar">
        {screen && <span className={`cu-holder ${screen.holder.kind}`}>{holderWords(screen.holder, l)}</span>}
        {live && stop && (
          <button className="preview-chip cu-stop" title={stop.stopping ? l.stopping : l.stopTip} disabled={stop.stopping || offline} onClick={stop.onStop}>
            <Square size={10} fill="currentColor" aria-hidden />
            <span>{stop.stopping ? l.stopping : l.stop}</span>
          </button>
        )}
        {screen?.holder.kind === "you" && run.state === "stopped" && run.id === stop?.lastRun && onHandBack && <HandBack onHandBack={onHandBack} />}
        {onWatch && (
          <button className="preview-chip cu-watch" title={l.watchTip} onClick={onWatch}>
            <MonitorPlay size={12} aria-hidden />
            <span>{l.watch}</span>
          </button>
        )}
      </div>
      {open && (
        <ol className="cu-steps">
          {run.lines.map((line) => (
            <Line key={line.kind === "step" ? line.step.id : line.tool.id} line={line} run={run} latest={live && line === latest} offline={offline} movedAt={movedAt} onAnswer={onAnswer} />
          ))}
        </ol>
      )}
    </div>
  );
}

const callIds = (items: readonly Item[]) => items.flatMap((i) => (i.kind === "tool" && i.callId ? [i.callId] : [])).join(" ");

function Line({
  line,
  run,
  latest,
  offline,
  movedAt,
  onAnswer,
}: {
  line: RunLine;
  run: CuRun;
  latest: boolean;
  offline: boolean;
  movedAt: number;
  onAnswer: (approvalId: string, choice: ApprovalChoice, confirmed?: boolean) => void;
}) {
  const l = useLocale().chat.computerUse;
  const [open, setOpen] = useState(false);
  const tool = run.items.find((i) => i.id === (line.kind === "step" ? line.step.id : line.tool.id));
  const details = tool?.kind === "tool" && open && (
    <div className="tool-body">
      {line.kind === "step" && line.step.thought && (
        <>
          <div className="tool-label">{l.details.thought}</div>
          <div className="thought-body">{line.step.thought}</div>
        </>
      )}
      {line.kind === "step" && (line.step.outcome.kind === "done" || line.step.outcome.kind === "failed") && line.step.outcome.hint && (
        <>
          <div className="tool-label">{l.details.hint}</div>
          <div className="thought-body">{line.step.outcome.hint}</div>
        </>
      )}
      <div className="tool-label">{l.details.args}</div>
      <pre>{withoutBidi(JSON.stringify(tool.args ?? {}, null, 2))}</pre>
      {tool.result !== undefined && (
        <>
          <div className="tool-label">{l.details.result}</div>
          <pre>{withoutBidi(tool.result)}</pre>
        </>
      )}
    </div>
  );
  if (line.kind === "tool")
    return (
      <li className="cu-step tool">
        <button className="tool-line" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {line.tool.status === "running" ? <Spinner /> : <ChevronRight size={13} className={`chev ${open ? "open" : ""}`} />}
          <span className="tool-name">{line.tool.name}</span>
          <span className="tool-preview">{line.tool.preview && withoutBidi(line.tool.preview)}</span>
        </button>
        {details}
      </li>
    );
  const { step, asks } = line;
  return (
    <li className={`cu-step ${step.outcome.kind} ${latest ? "latest" : ""}`.trimEnd()} data-item={step.id} data-call={tool?.kind === "tool" ? tool.callId : undefined}>
      <button className="tool-line" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="cu-n">{step.n}</span>
        <OutcomeIcon step={step} />
        <span className="cu-action">{withoutBidi(step.action.line)}</span>
        {step.action.app && <span className="cu-app">{withoutBidi(step.action.app)}</span>}
        {step.action.delivery === "foreground" && (
          <span className="cu-tag" title={l.foregroundTip}>
            {l.foreground}
          </span>
        )}
        <Outcome step={step} asking={asks.some(isWaiting)} />
        {step.durationS != null && step.outcome.kind !== "pending" && <span className="tool-dur">{Math.round(step.durationS * 10) / 10}s</span>}
      </button>
      {details}
      {asks.map((ask) => (
        <ApprovalCard key={ask.id} item={ask} offline={offline} movedAt={movedAt} app={step.action.app} onAnswer={(c, confirmed) => onAnswer(ask.id, c, confirmed)} />
      ))}
    </li>
  );
}

function OutcomeIcon({ step }: { step: CuStep }) {
  switch (step.outcome.kind) {
    case "pending":
      return <Spinner />;
    case "done":
      return <Check size={13} className="cu-icon" aria-hidden />;
    case "failed":
      return <CircleAlert size={13} className="cu-icon" aria-hidden />;
    case "denied":
      return <Ban size={13} className="cu-icon" aria-hidden />;
    case "refused":
      return <Hand size={13} className="cu-icon" aria-hidden />;
    case "stopped":
      return <Square size={12} className="cu-icon" aria-hidden />;
    case "unrecorded":
      return <Minus size={13} className="cu-icon" aria-hidden />;
  }
}

function Outcome({ step, asking }: { step: CuStep; asking: boolean }) {
  const l = useLocale().chat.computerUse;
  const o = step.outcome;
  let text: string;
  let title: string | undefined;
  if (o.kind === "pending" && asking) text = l.state.asking;
  else if (o.kind === "done") {
    text = o.note ?? (o.capture ? l.capture(o.capture.size, o.capture.app, o.capture.elements) : "");
    if (o.verdict === "verify" || o.verdict === "escalate") text = [text, l.outcome[o.verdict]].filter(Boolean).join(" · ");
    title = o.hint;
  } else if (o.kind === "failed") {
    text = o.why;
    title = o.hint;
  } else if (o.kind === "refused") {
    text = l.outcome.refused;
    title = o.why;
  } else if (o.kind === "unrecorded") {
    text = l.outcome.unrecorded;
    title = l.outcome.unrecordedTip;
  } else text = l.outcome[o.kind];
  return (
    <span className="cu-outcome" title={title}>
      {withoutBidi(text)}
    </span>
  );
}

/**
 * Above the composer while the chat's last computer_use step was refused because a person holds the screen, and one
 * still does (ADR 0216). The owner who holds it here can hand it back; one held from a dropped connection is handed back
 * from the Screen. It goes once the lease is back with Hermes.
 */
export function HumanHasControlBanner({ chat }: { chat: Pick<Chat, "items" | "running" | "turnAfter"> }) {
  const l = useLocale().chat.computerUse.banner;
  const { screen, onWatch, onHandBack } = useContext(ScreenDeskContext);
  const refused = screenUse(chat)?.refused;
  const holder = screen?.holder;
  if (!refused || !holder || holder.kind === "agent") return null;
  return (
    <div className="cu-banner" role="status" title={refused}>
      <Hand size={14} aria-hidden />
      <span className="cu-banner-text">{holder.kind === "you" ? l.you : holder.kind === "you-before" ? l.youBefore : l.someone}</span>
      {holder.kind === "you" && onHandBack && <HandBack onHandBack={onHandBack} primary />}
      {holder.kind !== "you" && onWatch && (
        <button className="btn" onClick={onWatch}>
          <MonitorPlay size={14} /> {l.openScreen}
        </button>
      )}
    </div>
  );
}

/** Gives the screen back to Hermes, saying why when it couldn't. */
function HandBack({ onHandBack, primary }: { onHandBack: () => Promise<void>; primary?: boolean }) {
  const l = useLocale().chat.computerUse.banner;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const handBack = async () => {
    setBusy(true);
    setFailed(undefined);
    try {
      await onHandBack();
    } catch (e) {
      setFailed(l.failed(errorText(e)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className={primary ? "btn primary" : "preview-chip cu-hand-back"} disabled={busy} onClick={() => void handBack()}>
        {busy ? <Spinner /> : <Hand size={primary ? 14 : 12} aria-hidden />} {l.handBack}
      </button>
      {failed && (
        <span className="cu-banner-why" role="alert">
          <X size={12} aria-hidden /> {failed}
        </span>
      )}
    </>
  );
}

const noSubscribe = () => () => {};
const noPending = () => undefined;

const failedText = (why: TurnOnFailed, l: ReturnType<typeof useLocale>["chat"]["computerUse"]["desktopOff"]) =>
  why.kind === "mismatch" ? l.mismatch : l[why.kind](why.reason);

/**
 * Above the composer in a Bot Chat whose bot has computer_use off (ADR 0227). Turn on goes through Settings →
 * Toolsets' own check and write, so a caution waits for the owner and a change counts only once Hermes reads it back.
 * Reads on mount, when the window comes back to the front, and when a toolset change from anywhere in the app ends.
 */
export function DesktopOffNotice() {
  const l = useLocale();
  const w = l.chat.computerUse.desktopOff;
  const { toolsets } = useContext(ScreenDeskContext);
  const api = toolsets?.api;
  const profile = toolsets?.profile;
  const [notice, setNotice] = useState<DesktopNotice>({ kind: "hidden" });
  const [dismissed, setDismissed] = useState(false);
  const pending = useSyncExternalStore(api ? api.subscribe : noSubscribe, api ? api.pending : noPending);
  /** Bumped by each read and each Turn on, at its start and end: an answer older than the latest is dropped. */
  const seq = useRef(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);

  const read = useCallback(async () => {
    if (!api || !profile) return;
    const mine = ++seq.current;
    const fresh = await api.list(profile).then(noticeOf, () => undefined);
    if (live.current && mine === seq.current) setNotice((n) => afterRead(n, fresh));
  }, [api, profile]);

  useEffect(() => {
    if (!pending) void read();
  }, [pending, read]);
  useEffect(() => {
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [read]);

  const save = async (row: Toolset, accepted: readonly Caution[]) => {
    if (!api || !profile) return;
    seq.current++;
    setNotice({ kind: "busy", row, step: "saving" });
    let next: DesktopNotice;
    try {
      next = afterTurnOn(row, await api.set(profile, row.name, true, false, [...accepted]));
    } catch (e) {
      // The write reads the list first, so a throw here means nothing was sent.
      next = { kind: "off", row, why: { kind: "readFailed", reason: errorText(e) } };
    }
    seq.current++;
    if (live.current) setNotice(next);
  };

  const turnOn = async (row: Toolset) => {
    if (!api || !profile) return;
    seq.current++;
    setNotice({ kind: "busy", row, step: "checking" });
    let cautions: Caution[];
    try {
      cautions = await api.cautions(profile, row, true);
    } catch (e) {
      seq.current++;
      return live.current ? setNotice({ kind: "off", row, why: { kind: "readFailed", reason: errorText(e) } }) : undefined;
    }
    if (!live.current) return;
    if (cautions.length) setNotice({ kind: "ask", row, cautions });
    else await save(row, []);
  };

  if (dismissed || notice.kind === "hidden") return null;
  return (
    <div className="cu-banner" role="status">
      <MonitorOff size={14} aria-hidden />
      {notice.kind === "off" && (
        <>
          <span className="cu-banner-text">{w.text}</span>
          <button className="btn primary" onClick={() => void turnOn(notice.row)}>
            {w.turnOn}
          </button>
          <button className="btn" onClick={() => setDismissed(true)}>
            {w.notNow}
          </button>
          {notice.why && (
            <span className="cu-banner-why" role="alert">
              <X size={12} aria-hidden /> {failedText(notice.why, w)}
            </span>
          )}
        </>
      )}
      {notice.kind === "busy" && (
        <span className="cu-banner-text">
          <Spinner /> {notice.step === "checking" ? w.checking : w.saving}
        </span>
      )}
      {notice.kind === "ask" && (
        <>
          <span className="cu-banner-text">{w.ask}</span>
          {notice.cautions.map((c) => (
            <span key={JSON.stringify(c)} className="cu-banner-note">
              {cautionText(c, notice.row, l.toolsets.caution)}
            </span>
          ))}
          <button className="btn primary" onClick={() => void save(notice.row, notice.cautions)}>
            {w.anyway}
          </button>
          <button className="btn" onClick={() => setNotice({ kind: "off", row: notice.row })}>
            {w.keepOff}
          </button>
        </>
      )}
      {notice.kind === "on" && (
        <>
          <span className="cu-banner-text">{w.on}</span>
          {notice.installing && <span className="cu-banner-note">{w.installing(notice.installing)}</span>}
          {notice.warning && <span className="cu-banner-note">{w.warning(notice.warning)}</span>}
        </>
      )}
    </div>
  );
}
