// Generate with AI on the New profile form's Persona (ADR 0195). It rewrites only what the owner typed, on an explicit
// click, through one stateless `llm.oneshot` as the profile in use on its Text generation model. The answer is a
// suggestion the owner can edit, then Replace persona or Discard; nothing reaches the persona box or Hermes otherwise.
// Hermes has no cancel: Stop, a newer ask and closing the dialog only drop the answer when it comes.
import { useEffect, useId, useRef, useState } from "react";
import { Wand2 } from "lucide-react";
import { ASK_DEADLINE_MS } from "../hermes/artifacts";
import type { Call } from "../hermes/instructionsAI";
import { shortName } from "../hermes/models";
import { PERSONA_INPUT_MAX, personaCut, rephraseCall, rephraseFrom } from "../hermes/personaRephrase";
import { deadline } from "../hermes/remoteFiles";
import { errorText } from "../hermes/values";
import { useLocale } from "../i18n/locale";
import { Spinner } from "./bits";

/** How the form reaches Hermes: one `llm.oneshot` on Text generation's task, and that task's model in the profile in use. */
export type RephraseWiring = { ask: (call: Call) => Promise<string>; model: () => Promise<{ provider: string; model: string }> };

/**
 * Where a rewrite stands. `asking`: call `n` is out, written from `before`. `suggestion`: Hermes's answer, as the owner
 * edits it, written from `before`; Replace persona asks again first when the box no longer holds that. `cut`: only the
 * first `PERSONA_INPUT_MAX` characters of `before` were sent.
 */
export type Rephrase =
  | { kind: "idle" }
  | { kind: "asking"; n: number; before: string }
  | { kind: "suggestion"; before: string; text: string; cut: boolean }
  | { kind: "failed"; message: string };

type ModelRead = { kind: "reading" } | { kind: "read"; provider: string; model: string } | { kind: "failed"; message: string };

/**
 * The rewrite's state and actions for one open form. `text`: the persona box now. `why`: what keeps Generate with AI
 * from running now, shown under the field; undefined when it can.
 */
export function usePersonaRephrase({ wiring, connected, profile, text }: { wiring?: RephraseWiring; connected: boolean; profile: string; text: string }) {
  const w = useLocale().profiles.form.rephrase;
  const [state, setState] = useState<Rephrase>({ kind: "idle" });
  const [model, setModel] = useState<ModelRead>({ kind: "reading" });
  // Each call's number; an answer whose number isn't the latest was stopped, superseded or closed on, and is dropped.
  const latest = useRef(0);
  // The call out now, if any: a second click before the screen catches up sends nothing.
  const out = useRef<number>(undefined);
  const wired = !!wiring;
  useEffect(() => {
    let live = true;
    wiring?.model().then(
      (m) => live && setModel({ kind: "read", provider: m.provider, model: m.model }),
      (e: unknown) => live && setModel({ kind: "failed", message: errorText(e) }),
    );
    return () => {
      live = false;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- a call counter, not a node: bumping it on close drops any answer still on its way
      latest.current++;
      out.current = undefined;
      // Wiring goes with the connection: a rewrite dropped then is over, so it no longer holds Create back.
      setState((s) => (s.kind === "asking" ? { kind: "idle" } : s));
      setModel({ kind: "reading" });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per open form, and again only once it has wiring
  }, [wired]);

  const why = !connected
    ? w.notConnected
    : !wiring
      ? w.unavailable
      : model.kind === "reading"
        ? w.checking
        : model.kind === "failed"
          ? w.modelUnread(model.message)
          : !model.provider
            ? w.noModel(profile)
            : state.kind === "asking"
              ? w.asking
              : state.kind === "suggestion"
                ? w.open
                : !text.trim()
                  ? w.empty
                  : undefined;
  const runsOn = model.kind === "read" && model.provider ? w.runsOn(shortName(model.model) || model.provider, profile) : undefined;

  const ask = async () => {
    if (why || !wiring || out.current !== undefined) return;
    const n = ++latest.current;
    out.current = n;
    const before = text;
    setState({ kind: "asking", n, before });
    try {
      const answer = rephraseFrom(await deadline(wiring.ask(rephraseCall(before)), ASK_DEADLINE_MS));
      if (latest.current !== n) return;
      setState(answer === undefined ? { kind: "failed", message: w.noText } : { kind: "suggestion", before, text: answer, cut: personaCut(before) });
    } catch (e) {
      if (latest.current === n) setState({ kind: "failed", message: errorText(e) });
    } finally {
      if (out.current === n) out.current = undefined;
    }
  };
  const stop = () => {
    latest.current++;
    out.current = undefined;
    setState({ kind: "idle" });
  };
  const edit = (next: string) => setState((s) => (s.kind === "suggestion" ? { ...s, text: next } : s));
  return { state, why, runsOn, ask, stop, edit, discard: stop };
}

export type PersonaRephraseState = ReturnType<typeof usePersonaRephrase>;

/** Generate with AI, beside the Persona label. Stays focusable when it can't run, so its reason is read with it. */
export function RephraseButton({ r, disabled, hintId }: { r: PersonaRephraseState; disabled: boolean; hintId: string }) {
  const w = useLocale().profiles.form.rephrase;
  const off = disabled || !!r.why;
  return (
    <button className="btn profile-write" aria-disabled={off || undefined} aria-describedby={hintId} onClick={() => !off && void r.ask()}>
      {r.state.kind === "asking" ? <Spinner /> : <Wand2 size={13} aria-hidden />} {w.generate}
    </button>
  );
}

/**
 * Under the Persona field: why Generate with AI can't run or what runs it (`hintId`), then the call in flight with Stop,
 * the editable suggestion with Replace persona and Discard, or why it failed. `text`: the box now. `onReplace` puts the
 * suggestion in the box; `focusBox` moves focus back to it when the panel goes.
 */
export function RephrasePanel({
  r,
  text,
  hintId,
  onReplace,
  focusBox,
}: {
  r: PersonaRephraseState;
  text: string;
  hintId: string;
  onReplace: (text: string) => void;
  focusBox: () => void;
}) {
  const w = useLocale().profiles.form.rephrase;
  const suggestionId = useId();
  const noteId = useId();
  const { state } = r;
  const stale = state.kind === "suggestion" && state.before !== text;
  const close = (then: () => void) => {
    then();
    requestAnimationFrame(focusBox);
  };
  return (
    <>
      <div id={hintId} className="set-hint">
        {r.why && state.kind !== "asking" ? r.why : r.runsOn}
      </div>
      {state.kind === "asking" && (
        <div className="persona-rephrase-asking small" role="status">
          <Spinner /> {w.asking}{" "}
          <button className="btn" onClick={() => close(r.stop)}>
            {w.stop}
          </button>
          <div className="set-hint">{w.stopHint}</div>
        </div>
      )}
      {state.kind === "failed" && (
        <div className="small sign-in-error" role="alert">
          {w.failed(state.message)}
        </div>
      )}
      {state.kind === "suggestion" && (
        <div className="field persona-suggestion">
          <label className="field-label" htmlFor={suggestionId}>
            {w.suggestion}
          </label>
          <textarea
            id={suggestionId}
            className="persona-text profile-soul"
            rows={6}
            autoFocus
            aria-describedby={noteId}
            value={state.text}
            onChange={(e) => r.edit(e.target.value)}
          />
          <div id={noteId} className="set-hint">
            {state.cut && `${w.cut(PERSONA_INPUT_MAX)} `}
            {w.suggestionHint}
          </div>
          {stale && (
            <div className="small profile-conflict" role="alert">
              {w.changed}
            </div>
          )}
          <div className="confirm-actions">
            <button className="btn" onClick={() => close(r.discard)}>
              {w.discard}
            </button>
            <button
              className="btn primary"
              disabled={!state.text.trim()}
              onClick={() =>
                close(() => {
                  onReplace(state.text);
                  r.discard();
                })
              }
            >
              {stale ? w.replaceAnyway : w.replace}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
