// Write with AI on the profile form's Persona (ADR 0197, 0203). It rewrites only what the owner typed, on an explicit
// click, through one stateless `llm.oneshot` on a profile's Text generation model, and puts the answer in the field
// itself; Undo puts the owner's text back. Nothing reaches Hermes's SOUL.md until the form's Create or Save.
// Hermes has no cancel: Stop, a newer ask, closing the dialog and a switch of profile only drop the answer when it comes.
import { useEffect, useRef, useState } from "react";
import { Wand2 } from "lucide-react";
import { ASK_DEADLINE_MS } from "../hermes/artifacts";
import type { Call } from "../hermes/instructionsAI";
import { shortName } from "../hermes/models";
import { PERSONA_INPUT_MAX, personaCut, rephraseCall, rephraseFrom } from "../hermes/personaRephrase";
import { deadline } from "../hermes/remoteFiles";
import { errorText } from "../hermes/values";
import { useLocale } from "../i18n/locale";
import { Spinner } from "./bits";

/** How the form reaches Hermes for one profile: one `llm.oneshot` on Text generation's task, and that task's model. */
export type RephraseWiring = { ask: (call: Call) => Promise<string>; model: () => Promise<{ provider: string; model: string }> };

/**
 * Where a rewrite stands. `asking`: call `n` is out, written from `before`. `replaced`: the field held `before` and now
 * holds Hermes's answer, `after`; `cut`: only the first `PERSONA_INPUT_MAX` characters of `before` were sent.
 */
export type Rephrase =
  | { kind: "idle" }
  | { kind: "asking"; n: number; before: string }
  | { kind: "replaced"; before: string; after: string; cut: boolean }
  | { kind: "failed"; message: string };

type ModelRead = { kind: "reading" } | { kind: "read"; provider: string; model: string } | { kind: "failed"; message: string };

/**
 * The rewrite's state and actions for one open form. `profile`: whose Text generation model writes. `text` and
 * `setText`: the Persona field. `why`: what keeps Write with AI from running now, shown under the field; undefined
 * when it can.
 */
export function usePersonaRephrase({
  wiring,
  connected,
  profile,
  text,
  setText,
}: {
  wiring?: RephraseWiring;
  connected: boolean;
  profile: string;
  text: string;
  setText: (text: string) => void;
}) {
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
      // Wiring goes with the connection, and the model with the profile: a rewrite dropped then is over, so it no
      // longer holds Create or Save back.
      setState((s) => (s.kind === "asking" ? { kind: "idle" } : s));
      setModel({ kind: "reading" });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per open form, and again once it has wiring or another profile writes
  }, [wired, profile]);

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
      if (answer === undefined) return setState({ kind: "failed", message: w.noText });
      setText(answer);
      setState({ kind: "replaced", before, after: answer, cut: personaCut(before) });
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
  const undo = () => {
    if (state.kind !== "replaced") return;
    setText(state.before);
    setState({ kind: "idle" });
  };
  // Undo is offered only while the field still holds the answer: once the owner edits it, the text is theirs.
  const undoable = state.kind === "replaced" && state.after === text;
  return { state, why, runsOn, ask, stop, undo, undoable };
}

export type PersonaRephraseState = ReturnType<typeof usePersonaRephrase>;

/** Write with AI, beside the Persona label. Stays focusable when it can't run, so its reason is read with it. */
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
 * Under the Persona field: why Write with AI can't run or what runs it (`hintId`), then the call in flight with Stop,
 * what replaced the field with Undo, or why it failed. `focusBox` moves focus back to the field when a button goes.
 */
export function RephrasePanel({ r, hintId, focusBox }: { r: PersonaRephraseState; hintId: string; focusBox: () => void }) {
  const w = useLocale().profiles.form.rephrase;
  const { state } = r;
  const close = (then: () => void) => {
    then();
    requestAnimationFrame(focusBox);
  };
  // Stop had focus while the call ran; once the answer is in, the field it went to has it, unless the owner moved on.
  const replaced = state.kind === "replaced";
  useEffect(() => {
    if (replaced && (!document.activeElement || document.activeElement === document.body)) focusBox();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only when an answer lands
  }, [replaced]);
  return (
    <>
      <div id={hintId} className="set-hint">
        {r.why && state.kind !== "asking" ? r.why : r.runsOn}
      </div>
      {state.kind === "asking" && (
        <div className="persona-rephrase-note small" role="status">
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
      {r.undoable && state.kind === "replaced" && (
        <div className="persona-rephrase-note small" role="status">
          {state.cut && `${w.cut(PERSONA_INPUT_MAX)} `}
          {w.replaced}{" "}
          <button className="btn" onClick={() => close(r.undo)}>
            {w.undo}
          </button>
        </div>
      )}
    </>
  );
}
