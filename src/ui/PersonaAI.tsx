// Write with AI for a SOUL.md (personaAI.ts), under the persona editor on Settings → Persona and in the New bot form.
// Opening it reads nothing. Only Write or Improve sends one stateless `llm.oneshot` (no chat, no tools), on the
// writing profile's Text generation model, read just before the call. The answer is an editable suggestion that only
// Apply puts in the editor, so the editor's own Save or Create stays the one thing that writes to the server.
//
// The state lives in `usePersonaAI`, held by the form, so the panel can unmount (New bot's leave question replaces
// the form) without losing notes, a call or a suggestion.
import { useEffect, useId, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { safeReason, soulCall, soulFrom, sourceOf, NOTES_MAX, SOUL_MAX, type Call, type Source } from "../hermes/personaAI";
import { shortName } from "../hermes/models";
import { deadline } from "../hermes/remoteFiles";
import { ASK_DEADLINE_MS } from "../hermes/artifacts";
import { errorText } from "../hermes/values";
import { useLocale } from "../i18n/locale";
import { Spinner } from "./bits";

/** The model a session-less `llm.oneshot` runs on for a profile (modelSettings.ts `textModel`). */
export type TextModel = { provider: string; model: string; followsMain: boolean };

/** How Write with AI reaches Hermes, for the profile whose model writes. */
export type PersonaWriter = {
  /** The profile whose Text generation model writes, which the panel names. */
  profile: string;
  model: () => Promise<TextModel>;
  /** One `llm.oneshot` on `profile`, with no chat; resolves with Hermes's text. */
  ask: (call: Call) => Promise<string>;
};

/**
 * `writing`: the call numbered `id` is out. `suggested`: Hermes's answer, as the owner edits it, with the editor text it
 * was written from (`from`), so a changed editor isn't replaced without asking.
 */
type Phase =
  | { kind: "idle"; note?: { tone: "muted" | "bad"; text: string } }
  | { kind: "writing"; id: number }
  | { kind: "suggested"; text: string; from: string; by: string; confirm: boolean };

export type PersonaAIState = ReturnType<typeof usePersonaAI>;

/**
 * Write with AI's notes, call and suggestion for one editor. A call is dropped when the connection goes or the writing
 * profile changes, and its answer when it comes after Stop, a newer call, or the form closing.
 */
export function usePersonaAI(writer: PersonaWriter | undefined, connected: boolean) {
  const w = useLocale().personaAI;
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const latest = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const drop = (why: string) => {
    latest.current++;
    setPhase({ kind: "idle", note: { tone: "muted", text: why } });
  };

  const writing = phase.kind === "writing";
  const bound = useRef({ connected, profile: writer?.profile });
  useEffect(() => {
    const was = bound.current;
    bound.current = { connected, profile: writer?.profile };
    if (writing && (!connected || was.profile !== writer?.profile)) drop(w.lost);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a change of connection or writing profile drops the call
  }, [connected, writer?.profile]);

  async function write(source: Source, from: string) {
    if (!writer || writing || !connected) return;
    const id = ++latest.current;
    const current = () => alive.current && latest.current === id;
    setPhase({ kind: "writing", id });
    try {
      const m = await deadline(writer.model(), ASK_DEADLINE_MS);
      if (!current()) return;
      const name = shortName(m.model) || w.defaultModel;
      const by = w.by(writer.profile, `${m.provider ? `${m.provider} · ` : ""}${m.followsMain ? w.mainModel(name) : name}`);
      const answer = await deadline(writer.ask(soulCall(source)), ASK_DEADLINE_MS);
      if (!current()) return;
      setPhase({ kind: "suggested", text: soulFrom(answer), from, by, confirm: false });
    } catch (e) {
      if (current()) setPhase({ kind: "idle", note: { tone: "bad", text: w.failed(safeReason(errorText(e))) } });
    }
  }

  return { writer, connected, open, setOpen, notes, setNotes, phase, setPhase, write, drop, held: !!notes.trim() || phase.kind !== "idle" };
}

export function PersonaAI({
  ai,
  writer,
  text,
  locked,
  persist,
  onApply,
}: {
  ai: PersonaAIState;
  /** `ai.writer`, once the caller has checked there is one. */
  writer: PersonaWriter;
  /** The editor's text now. */
  text: string;
  /** The editor can't take text now (a save or reload is under way). */
  locked: boolean;
  /** What writes the editor's text to the server: the persona's Save, or the New bot form's Create. */
  persist: "save" | "create";
  onApply: (text: string) => void;
}) {
  const l = useLocale();
  const w = l.personaAI;
  const { connected, open, setOpen, notes, setNotes, phase, setPhase } = ai;
  const writeBtn = useRef<HTMLButtonElement>(null);
  const openBtn = useRef<HTMLButtonElement>(null);
  const suggestionBox = useRef<HTMLTextAreaElement>(null);
  const notesId = useId();
  const notesHint = useId();
  const suggestionId = useId();

  // Focus follows the call: to the suggestion when it comes, back to the button when the call ends without one.
  const was = useRef(phase.kind);
  useEffect(() => {
    const from = was.current;
    was.current = phase.kind;
    if (from === phase.kind) return;
    if (phase.kind === "suggested" && from === "writing") suggestionBox.current?.focus();
    else if (phase.kind === "idle" && from !== "suggested") writeBtn.current?.focus();
  }, [phase.kind]);

  const writing = phase.kind === "writing";
  const source = sourceOf(text, notes);
  const issue =
    "issue" in source
      ? source.issue === "empty"
        ? w.issues.empty
        : source.issue === "notesLong"
          ? w.issues.notesLong(l.fmt.number(NOTES_MAX))
          : w.issues.textLong(l.fmt.number(SOUL_MAX))
      : undefined;
  const improving = !!text.trim();

  function apply(force: boolean) {
    if (phase.kind !== "suggested" || locked || !phase.text.trim()) return;
    if (!force && text !== phase.from) return setPhase({ ...phase, confirm: true });
    onApply(phase.text);
    setPhase({ kind: "idle", note: { tone: "muted", text: persist === "save" ? w.appliedSave : w.appliedCreate } });
  }

  if (!open)
    return (
      <div className="persona-ai">
        <button ref={openBtn} type="button" className="link-btn persona-ai-open" aria-expanded={false} onClick={() => setOpen(true)}>
          <Sparkles size={13} /> {w.open}
        </button>
      </div>
    );

  return (
    <div className="persona-ai persona-ai-panel" role="group" aria-label={w.write} aria-busy={writing}>
      <div className="persona-ai-head">
        <button
          type="button"
          className="link-btn persona-ai-open"
          aria-expanded
          disabled={writing}
          onClick={() => {
            setOpen(false);
            requestAnimationFrame(() => openBtn.current?.focus());
          }}
        >
          <Sparkles size={13} /> {w.close}
        </button>
      </div>
      <label className="field-label" htmlFor={notesId}>
        {w.notes}
      </label>
      <textarea
        id={notesId}
        className="persona-text persona-ai-notes"
        aria-describedby={notesHint}
        rows={3}
        value={notes}
        readOnly={writing}
        onChange={(e) => setNotes(e.target.value)}
      />
      <div id={notesHint} className="set-hint">
        {improving ? w.notesImprove : w.notesWrite} {w.uses(writer.profile)}
      </div>

      {writing ? (
        <p className="persona-ai-working small" role="status">
          <Spinner /> {w.writing}
          <button type="button" className="btn" onClick={() => ai.drop(w.stopped)}>
            {w.stop}
          </button>
        </p>
      ) : (
        <div className="persona-actions persona-actions-left">
          <button
            ref={writeBtn}
            type="button"
            className="btn"
            disabled={!connected || !!issue}
            aria-describedby={notesHint}
            onClick={() => {
              if (!("issue" in source)) void ai.write(source, text);
            }}
          >
            <Sparkles size={14} /> {improving ? w.improve : w.write}
          </button>
        </div>
      )}
      {!connected ? <p className="muted small persona-note">{w.disconnected}</p> : issue && notes.trim() && <p className="muted small persona-note">{issue}</p>}
      {phase.kind === "idle" && phase.note && (
        <p className={`small persona-note ${phase.note.tone === "bad" ? "sign-in-error" : "muted"}`} role={phase.note.tone === "bad" ? "alert" : "status"}>
          {phase.note.text}
        </p>
      )}

      {phase.kind === "suggested" && (
        <div className="persona-ai-suggestion">
          <label className="field-label" htmlFor={suggestionId}>
            {w.suggestion}
          </label>
          <textarea
            id={suggestionId}
            ref={suggestionBox}
            className="persona-text persona-ai-text"
            value={phase.text}
            maxLength={SOUL_MAX}
            spellCheck={false}
            rows={8}
            onChange={(e) => setPhase({ ...phase, text: e.target.value, confirm: false })}
          />
          <div className="set-hint">
            {phase.by}. {w.suggestionHint}
          </div>
          {phase.confirm ? (
            <div className="confirm" role="alertdialog" aria-label={w.changed}>
              <span>{w.changed}</span>
              <div className="confirm-actions">
                <button type="button" className="btn" autoFocus onClick={() => setPhase({ ...phase, confirm: false })}>
                  {w.keep}
                </button>
                <button type="button" className="btn danger" disabled={locked} onClick={() => apply(true)}>
                  {w.replace}
                </button>
              </div>
            </div>
          ) : (
            <div className="persona-actions persona-actions-left">
              <button type="button" className="btn primary" disabled={locked || !phase.text.trim()} onClick={() => apply(false)}>
                {w.apply}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setPhase({ kind: "idle" });
                  requestAnimationFrame(() => writeBtn.current?.focus());
                }}
              >
                {w.discard}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
