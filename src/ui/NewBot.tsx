// New bot and Settings → Profiles' New profile (ADR 0231, "Making a bot"): one name box. Create makes the bot and its
// Bot Chat interviews the owner; Skip, beside the box, makes it blank or copies another bot instead. Any name is taken:
// a faint line names the id Hermes's own clients will show for it. Every word comes from the catalogue (ADR 0100).
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { ChevronDown, Copy, FileText } from "lucide-react";
import type { BotSetupRefusal } from "../hermes/botSetupStart";
import { MakeStopped, type MakeStop, type NewBotHow } from "../hermes/newBot";
import { profileFailure, profileIdFor, type ProfileRow } from "../hermes/profiles";
import { useLocale } from "../i18n/locale";
import { Spinner, composing } from "./bits";
import { Menu } from "./ChatMenu";
import { useModal } from "./modal";
import { failureText } from "./profileFailure";

/** The Skip menu's width in styles.css, so it opens right-aligned under Skip. */
const SKIP_MENU_WIDTH = 300;

/** Where the dialog is: taking a name, making the bot one way, or stopped after the create went out. */
type Phase = { at: "naming"; failed?: string } | { at: "making"; how: NewBotHow } | { at: "stuck"; how: NewBotHow; stop: MakeStop };

export function NewBot({
  heading,
  list,
  off,
  returnTo,
  make,
  onCopy,
  onClose,
}: {
  heading: string;
  /** The profiles Hermes lists, for the id line. */
  list: () => Promise<ProfileRow[]>;
  /** Why this Hermes runs no Bot setup, so Create makes the bot without the interview. */
  off?: BotSetupRefusal;
  returnTo: RefObject<HTMLElement | null>;
  /**
   * Makes the bot named `name` and goes to it, or carries on `from` where an earlier make stopped. Rejects with the
   * create's failure, or with `MakeStopped`, and the dialog stays open.
   */
  make: (name: string, how: NewBotHow, from?: MakeStop) => Promise<void>;
  /** Copy a bot: Clone profile with `id` filled in as the copy's name. Without it the Skip menu has no Copy. */
  onCopy?: (id: string) => void;
  onClose: () => void;
}) {
  const l = useLocale();
  const w = l.bots.make;
  const box = useRef<HTMLDivElement>(null);
  const skipBtn = useRef<HTMLButtonElement>(null);
  const keys = useModal(box, returnTo);
  const titleId = useId();
  const nameId = useId();
  const idLine = useId();
  const blankWhat = useId();
  const copyWhat = useId();
  const [name, setName] = useState("");
  const [rows, setRows] = useState<ProfileRow[]>();
  const [skipAt, setSkipAt] = useState<{ x: number; y: number }>();
  const [phase, setPhase] = useState<Phase>({ at: "naming" });
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    list().then(
      (r) => live.current && setRows(r),
      () => {},
    );
    return () => void (live.current = false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read once, when the dialog opens: Create lists them again
  }, []);

  const typed = name.trim();
  const idFor = (listed: readonly ProfileRow[]) => profileIdFor(typed, new Set(listed.map((r) => r.name)));
  const id = rows && typed ? idFor(rows) : undefined;
  const making = phase.at === "making";
  const stuck = phase.at === "stuck" ? phase : undefined;
  const why = typed ? undefined : w.nameFirst;
  const offWhy = off && off !== "hasBotChat" ? w.off[off] : undefined;
  const failed = phase.at === "naming" ? phase.failed : stuck && w[stuck.stop.at](stuck.stop.profile, failureText(l, stuck.stop.failure, stuck.stop.profile));

  const createdAfterAll = async (profile: string) => (await list()).some((r) => r.name === profile);

  const go = async (how: NewBotHow, from?: MakeStop) => {
    setSkipAt(undefined);
    if (making || (!from && (why || stuck))) return;
    setPhase({ at: "making", how });
    try {
      if (from?.at === "unsure" && !(await createdAfterAll(from.profile))) {
        if (live.current) setPhase({ at: "naming", failed: w.notMade(from.profile) });
        return;
      }
      await make(typed, how, from);
      if (live.current) onClose();
    } catch (e) {
      if (!live.current) return;
      if (e instanceof MakeStopped) setPhase({ at: "stuck", how, stop: e.stop });
      else if (from) setPhase({ at: "stuck", how, stop: { ...from, failure: profileFailure(e, "create") } });
      else setPhase({ at: "naming", failed: w.failed(failureText(l, profileFailure(e, "create"), id ?? typed)) });
    }
  };

  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && !making && onClose()}>
      <div
        ref={box}
        className="leave-dialog profile-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && !e.defaultPrevented && !composing(e) && !making) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          {heading}
        </h2>
        <div className="field">
          <label className="field-label" htmlFor={nameId}>
            {w.name}
          </label>
          <div className="new-bot-name">
            <input
              id={nameId}
              autoFocus
              spellCheck={false}
              value={name}
              readOnly={making || !!stuck}
              aria-describedby={id ? idLine : undefined}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !composing(e)) {
                  e.preventDefault();
                  void go("setup");
                }
              }}
            />
            <button
              ref={skipBtn}
              className="btn"
              aria-haspopup="menu"
              aria-expanded={!!skipAt}
              disabled={making || !!stuck}
              onClick={() => {
                const r = skipBtn.current!.getBoundingClientRect();
                setSkipAt(skipAt ? undefined : { x: r.right - SKIP_MENU_WIDTH, y: r.bottom + 4 });
              }}
            >
              {w.skip} <ChevronDown size={14} aria-hidden />
            </button>
          </div>
          {id && (
            <div id={idLine} className="set-hint">
              {w.idBefore} <code translate="no">{id}</code>.
            </div>
          )}
        </div>
        <p className="muted">{offWhy ?? w.next(typed)}</p>
        {failed && (
          <p className="sign-in-error" role="alert">
            {failed}
          </p>
        )}
        <div className="confirm-actions">
          <button className="btn" onClick={onClose} disabled={making}>
            {l.common.cancel}
          </button>
          {stuck ? (
            <button className="btn primary" onClick={() => void go(stuck.how, stuck.stop)}>
              {w.checkAgain}
            </button>
          ) : (
            // Stays focusable while it can't run, so its reason is read with it.
            <button className="btn primary" disabled={making} aria-disabled={!!why || undefined} title={why} onClick={() => void go("setup")}>
              {making && <Spinner />} {making ? w.creating : w.create}
            </button>
          )}
        </div>
        {skipAt && (
          <Menu label={w.skipMenu} x={skipAt.x} y={skipAt.y} onClose={() => setSkipAt(undefined)}>
            <button role="menuitem" className="menu-item new-bot-skip" aria-disabled={!!why || undefined} aria-describedby={blankWhat} title={why} onClick={() => !why && void go("blank")}>
              <span className="menu-icon">
                <FileText size={15} />
              </span>
              <span className="menu-label">{w.blank}</span>
              <span id={blankWhat} className="new-bot-skip-what">
                {w.blankHint}
              </span>
            </button>
            {onCopy && (
              <button
                role="menuitem"
                className="menu-item new-bot-skip"
                aria-describedby={copyWhat}
                onClick={() => {
                  setSkipAt(undefined);
                  // No name yet: Clone suggests one of its own.
                  onCopy(typed ? idFor(rows ?? []) : "");
                }}
              >
                <span className="menu-icon">
                  <Copy size={15} />
                </span>
                <span className="menu-label">{w.copy}</span>
                <span id={copyWhat} className="new-bot-skip-what">
                  {w.copyHint}
                </span>
              </button>
            )}
          </Menu>
        )}
      </div>
    </div>
  );
}
