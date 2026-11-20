// Set up again's question, from a bot's menu (ADR 0231): Keep history or Start fresh, before anything is sent. Start
// fresh counts the memory entries it deletes, says they can't come back, and turns the button red; it is never offered
// for the main bot. While the Bot Chat is replying or waiting on the owner, neither can go, and the dialog says why.
// Every word comes from the catalogue (ADR 0100).
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { TriangleAlert } from "lucide-react";
import type { AgainAsk, AgainBusy, AgainStart, FreshEnd } from "../hermes/botSetupAgain";
import type { Bot } from "../hermes/bots";
import type { MemoryEntry } from "../hermes/memory";
import { errorText } from "../hermes/values";
import { useLocale, type Locale } from "../i18n/locale";
import { Spinner, composing } from "./bits";
import { useModal } from "./modal";

type Counted = { at: "counting" } | { at: "counted"; entries: readonly MemoryEntry[] } | { at: "failed"; why: string };

export function SetUpAgain({
  bot,
  busy,
  entries,
  returnTo,
  onGo,
  onClose,
}: {
  bot: Bot;
  /** Why the Bot Chat can't take Set up again now, as last known. */
  busy?: AgainBusy;
  /** The bot's memory entries, which Start fresh deletes. */
  entries: () => Promise<readonly MemoryEntry[]>;
  returnTo: RefObject<HTMLElement | null>;
  onGo: (ask: AgainAsk) => void;
  onClose: () => void;
}) {
  const l = useLocale();
  const w = l.bots.again;
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  const titleId = useId();
  const whyId = useId();
  const group = useId();
  const [fresh, setFresh] = useState(false);
  const [memory, setMemory] = useState<Counted>({ at: "counting" });
  const main = bot.isDefault || bot.profile === "default";
  const [reading] = useState(() => (main ? undefined : entries()));
  useEffect(() => {
    if (!reading) return;
    let live = true;
    reading.then(
      (read) => live && setMemory({ at: "counted", entries: read }),
      (e: unknown) => live && setMemory({ at: "failed", why: errorText(e) }),
    );
    return () => void (live = false);
  }, [reading]);

  const count = memory.at === "counted" ? memory.entries.length : undefined;
  const why = busy ? w.busy[busy](bot.name) : undefined;
  const go = () => {
    if (why) return;
    if (!fresh) return onGo({ how: "keep" });
    if (memory.at === "counted") onGo({ how: "fresh", entries: memory.entries });
  };

  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        className="leave-dialog again-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && !e.defaultPrevented && !composing(e)) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          {w.title(bot.name)}
        </h2>
        <p>
          {w.what(bot.name)} {main && w.defaultWhat(bot.name)}
        </p>
        {main ? (
          <p className="muted">{w.noFreshDefault}</p>
        ) : (
          <div className="again-how" role="radiogroup" aria-label={w.how}>
            <label className="again-choice">
              <input type="radio" name={group} checked={!fresh} onChange={() => setFresh(false)} />
              <span>
                <strong>{w.keep}</strong> {w.keepWhat(bot.name)}
              </span>
            </label>
            <label className={`again-choice${memory.at === "failed" ? " off" : ""}`}>
              <input type="radio" name={group} checked={fresh} disabled={memory.at === "failed"} onChange={() => setFresh(true)} />
              <span>
                <strong>{w.fresh}</strong> {w.freshWhat(bot.name, count)}
              </span>
            </label>
          </div>
        )}
        {memory.at === "failed" && <p className="muted">{w.memoryUnread(memory.why)}</p>}
        {fresh && memory.at === "counting" && (
          <p className="muted">
            <Spinner /> {w.counting}
          </p>
        )}
        {fresh && count !== undefined && (
          <p className="again-warn">
            <TriangleAlert size={14} aria-hidden /> {w.freshWarn(bot.name, count)}
          </p>
        )}
        {why && (
          <p id={whyId} className="sign-in-error" role="alert">
            {why}
          </p>
        )}
        <div className="confirm-actions">
          <button className="btn" onClick={onClose}>
            {l.common.cancel}
          </button>
          {/* Stays focusable while it can't run, so its reason is read with it. */}
          <button
            className={`btn ${fresh ? "danger" : "primary"}`}
            autoFocus
            disabled={fresh && memory.at !== "counted"}
            aria-disabled={!!why || undefined}
            aria-describedby={why ? whyId : undefined}
            onClick={go}
          >
            {fresh ? w.goFresh : w.go}
          </button>
        </div>
      </div>
    </div>
  );
}

type Words = Locale["bots"]["again"];

const refusedNote = (w: Words, bot: string, reason: Extract<FreshEnd, { kind: "refused" }>["reason"]) =>
  reason === "default" ? w.isDefault : reason === "replying" || reason === "waiting" ? w.busy[reason](bot) : w.off;

/** Why Keep history's brief wasn't sent, in the owner's words; undefined when it went. */
export const keptNote = (w: Words, bot: string, start: AgainStart): string | undefined => (start.kind === "refused" ? refusedNote(w, bot, start.reason) : undefined);

/** What Start fresh didn't do, in the owner's words; undefined when all of it went. */
export function freshNote(w: Words, bot: string, end: FreshEnd): string | undefined {
  switch (end.kind) {
    case "refused":
      return refusedNote(w, bot, end.reason);
    case "titleKept":
      return w.titleKept(bot, end.restored);
    case "stopped":
      return w.stopped[end.left](bot, end.why);
    case "fresh": {
      const notes = [
        end.missed.retitle !== undefined && w.notRetitled(end.missed.retitle),
        end.missed.memory !== undefined ? w.memoryMissed(end.missed.memory) : end.memoryLeft > 0 && w.memoryLeft(end.memoryLeft),
      ].filter((n): n is string => !!n);
      return notes.length ? notes.join(" ") : undefined;
    }
  }
}
