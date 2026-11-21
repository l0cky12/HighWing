// A card for any Question but an Approval (#390, #26): what Hermes asks, and the owner's answer. A password, secret,
// code or login lives only in the card's DOM fields until it goes to Hermes; the card then keeps only that it was
// answered (ADR 0146, ADR 0244).
import { useCallback, useId, useRef, useState, type KeyboardEvent } from "react";
import { KeyRound, MessageCircleQuestion } from "lucide-react";
import { endedNote, type ClarifyQuestion, type QuestionAnswer, type QuestionItem } from "../hermes/model";
import { useDeliberate, visible } from "./ApprovalCard";

type Card = Exclude<QuestionItem, { kind: "approval" }>;

/** Hermes marks the choice it recommends with this (`tools/clarify_tool.py` `mark_recommended`); it isn't the answer. */
const RECOMMENDED = "(Recommended)";
const bare = (choice: string) => (choice.endsWith(RECOMMENDED) ? choice.slice(0, -RECOMMENDED.length).trim() : choice);

/** A locked Clarify answer as the owner gave it: a multiple-choice one is a JSON list. */
function shownAnswer(q: ClarifyQuestion, answer: string | null): string {
  if (answer === null) return "Skipped";
  if (!q.multiSelect) return answer;
  try {
    const picked: unknown = JSON.parse(answer);
    return Array.isArray(picked) ? picked.map(String).join(", ") : answer;
  } catch {
    return answer;
  }
}

/** Enter in a field answers, unless an input method is composing. */
const onEnter = (act: () => void) => (e: KeyboardEvent) => {
  if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
  e.preventDefault();
  act();
};

/** What a waiting card asks, in its head. */
function asking(i: Card): string {
  switch (i.kind) {
    case "clarify":
      return "Hermes is asking";
    case "sudo":
      return "Hermes needs the sudo password";
    case "secret":
      return `Hermes needs a value for ${i.envVar}`;
    case "vault.unlock_prompt":
      return `Hermes needs your ${visible(i.displayName)} master password`;
    case "vault.save_login":
      return `Save a login for ${visible(i.site)}?`;
    case "vault.code":
      return i.site ? `Hermes needs a one-time code for ${visible(i.site)}` : "Hermes needs a one-time code";
  }
}
const ANSWERED: Record<Card["kind"], string> = {
  clarify: "Answered",
  sudo: "Password sent",
  secret: "Value sent",
  "vault.unlock_prompt": "Password sent",
  "vault.save_login": "Login sent",
  "vault.code": "Code sent",
};

/**
 * A card takes no focus when it arrives, so typing elsewhere never answers it; it answers only from its own buttons and
 * fields. Buttons ignore a double click and a click just after the transcript moved (`useDeliberate`). Offline, they
 * stay focusable but do nothing, so a reconnect doesn't drop the owner's place, and a typed value stays in its field.
 */
export function QuestionCard({ item, offline, movedAt = 0, onAnswer }: { item: Card; offline: boolean; movedAt?: number; onAnswer: (a: QuestionAnswer) => void }) {
  const deliberate = useDeliberate(movedAt);
  const closed = item.answer ?? item.ended;
  const card = useRef<HTMLDivElement>(null);
  const headId = useId();
  // As on an Approval card: when the fields and buttons go, focus stays on the card instead of falling to the page.
  const keepFocus = useCallback((body: HTMLDivElement | null) => {
    return () => void (body?.contains(document.activeElement) && card.current?.isConnected && card.current.focus());
  }, []);
  const head = item.answer === "skipped" ? "Skipped" : item.answer ? ANSWERED[item.kind] : item.ended ? endedNote(item.ended) : asking(item);
  const Icon = item.kind === "clarify" ? MessageCircleQuestion : KeyRound;
  const send = (a: QuestionAnswer) => !offline && onAnswer(a);
  return (
    <div ref={card} tabIndex={-1} role="group" aria-labelledby={headId} data-item={item.id} className={`approval question ${closed ? "answered" : ""}`}>
      <div className="approval-head" id={headId}>
        <Icon size={15} aria-hidden />
        {head}
      </div>
      {item.kind === "clarify" ? (
        <Clarify item={item} open={!closed} offline={offline} deliberate={deliberate} keepFocus={keepFocus} send={send} />
      ) : (
        <Masked item={item} open={!closed} offline={offline} deliberate={deliberate} keepFocus={keepFocus} send={send} />
      )}
    </div>
  );
}

type Parts = {
  open: boolean;
  offline: boolean;
  deliberate: ReturnType<typeof useDeliberate>;
  keepFocus: (body: HTMLDivElement | null) => () => void;
  send: (a: QuestionAnswer) => void;
};

/** Each question with its answer locked, or the ways to answer it; Skip skips every question not locked yet. */
function Clarify({ item, open, offline, deliberate, keepFocus, send }: Parts & { item: Extract<Card, { kind: "clarify" }> }) {
  const someLocked = Object.keys(item.locked).length > 0;
  return (
    <>
      <ol className="question-list">
        {item.questions.map((q) => (
          <li key={q.qid} className="question-row">
            <div className="question-text">{visible(q.question)}</div>
            {q.qid in item.locked ? (
              <div className="question-locked">{visible(shownAnswer(q, item.locked[q.qid]))}</div>
            ) : (
              open && <ClarifyAnswer q={q} offline={offline} deliberate={deliberate} keepFocus={keepFocus} lock={(answer) => send({ kind: "lock", qid: q.qid, answer })} />
            )}
          </li>
        ))}
      </ol>
      {open && (
        <div className="approval-actions" ref={keepFocus}>
          <button className="btn" aria-disabled={offline || undefined} onClick={deliberate(() => send({ kind: "skip" }))}>
            {someLocked ? "Skip the rest" : "Skip"}
          </button>
        </div>
      )}
    </>
  );
}

/**
 * One question's answer. A single choice locks as it is picked; several are ticked, then locked together with Lock
 * answer. Any question also takes words of the owner's own, as Hermes's clarify does.
 */
function ClarifyAnswer({ q, offline, deliberate, keepFocus, lock }: Pick<Parts, "offline" | "deliberate" | "keepFocus"> & { q: ClarifyQuestion; lock: (answer: string) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [words, setWords] = useState("");
  const typed = words.trim();
  const answer = q.multiSelect ? (picked.length || typed ? JSON.stringify([...picked.map(bare), ...(typed ? [typed] : [])]) : "") : typed;
  const go = () => !offline && answer && lock(answer);
  const fieldId = useId();
  return (
    <div className="question-answer" ref={keepFocus}>
      {q.choices.length > 0 && (
        <div className="question-choices" role={q.multiSelect ? "group" : undefined} aria-label={q.multiSelect ? "Choices" : undefined}>
          {q.choices.map((c) =>
            q.multiSelect ? (
              <label key={c} className="question-choice">
                <input type="checkbox" checked={picked.includes(c)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c] : p.filter((x) => x !== c)))} />
                {visible(c)}
              </label>
            ) : (
              <button key={c} className="btn" aria-disabled={offline || undefined} onClick={deliberate(() => !offline && lock(bare(c)))}>
                {visible(c)}
              </button>
            ),
          )}
        </div>
      )}
      <div className="question-own">
        <label htmlFor={fieldId} className="sr-only">
          {q.choices.length ? "Or your own answer" : "Your answer"}
        </label>
        <input
          id={fieldId}
          className="question-field"
          value={words}
          placeholder={q.choices.length ? "Or type your own answer" : "Type your answer"}
          onChange={(e) => setWords(e.target.value)}
          onKeyDown={onEnter(go)}
        />
        {(q.multiSelect || !q.choices.length || typed) && (
          <button className="btn primary" aria-disabled={offline || !answer || undefined} onClick={deliberate(go)}>
            Lock answer
          </button>
        )}
      </div>
    </div>
  );
}

type ValueCard = Exclude<Card, { kind: "clarify" }>;

/** A field a card takes its answer in. `masked`: a password field. */
type Field = { label: string; placeholder: string; masked: boolean };

/**
 * What a card takes its answer in: its fields, the answer they make, the button that sends it, and where the answer
 * goes. Every field must be filled to send.
 */
type Form = { fields: Field[]; answer: (values: string[]) => QuestionAnswer; sendLabel: string; note: string };

const one = (field: Field, note: string): Form => ({ fields: [field], answer: ([value]) => ({ kind: "value", value }), sendLabel: "Send", note });

function formOf(item: ValueCard): Form {
  switch (item.kind) {
    case "sudo":
      return one(
        { label: "Sudo password", placeholder: "Sudo password", masked: true },
        "It goes only to Hermes, which keeps it in memory for this chat's later sudo commands. Highwing doesn't keep it.",
      );
    case "secret":
      return one(
        { label: `Value for ${item.envVar}`, placeholder: item.envVar, masked: true },
        `Hermes saves it as ${item.envVar} in this profile on the server. Highwing doesn't keep it.`,
      );
    case "vault.unlock_prompt": {
      const name = visible(item.displayName);
      return one(
        { label: `${name} master password`, placeholder: "Master password", masked: true },
        `It goes only to ${name} on the server, which stays unlocked for this chat. Hermes's model never sees it, and Highwing doesn't keep it.`,
      );
    }
    case "vault.save_login":
      return {
        fields: [
          { label: "User name or email", placeholder: "User name or email", masked: false },
          { label: "Password", placeholder: "Password", masked: true },
        ],
        answer: ([identifier, password]) => ({ kind: "login", identifier, password }),
        sendLabel: "Save",
        note: "Hermes saves it encrypted on the server and fills it into the page. Hermes's model never sees the password, and Highwing keeps neither.",
      };
    case "vault.code":
      return one(
        { label: "One-time code", placeholder: "One-time code", masked: false },
        "Hermes types it into the page. Hermes's model never sees it, and Highwing doesn't keep it.",
      );
  }
}

/** What a card's question is for, above its fields. */
function About({ item }: { item: ValueCard }) {
  switch (item.kind) {
    case "sudo":
      return item.command ? <pre className="approval-cmd">{visible(item.command)}</pre> : null;
    case "secret":
      return (
        <>
          {item.prompt && <div className="approval-desc question-prompt">{visible(item.prompt)}</div>}
          {item.skill && <div className="approval-desc">For the {visible(item.skill)} skill.</div>}
        </>
      );
    case "vault.unlock_prompt":
      return <div className="approval-desc">Hermes wants to sign in to a site with a login saved in {visible(item.displayName)}.</div>;
    case "vault.save_login":
      return <div className="approval-desc">Hermes reached a sign-in page at {visible(item.origin)} and has no login saved for it.</div>;
    case "vault.code":
      return (
        <>
          <div className="approval-desc">The site asks for a one-time code from a text message, an email or an authenticator app.</div>
          {item.hint && <div className="approval-desc question-prompt">{visible(item.hint)}</div>}
        </>
      );
  }
}

/** A question answered with a value or a login: what it is for, and while it waits, its fields. */
function Masked({ item, open, ...parts }: Parts & { item: ValueCard }) {
  return (
    <>
      <About item={item} />
      {open && <ValueFields item={item} {...parts} />}
    </>
  );
}

/**
 * The fields, whose values go to Hermes and nowhere else. They are uncontrolled, so a value is only in its DOM field,
 * never in React's state or props; React knows only whether every field is filled. They show only while the card
 * waits, so the values go however the card closes, and Send clears them as it goes.
 */
function ValueFields({ item, offline, deliberate, keepFocus, send }: Omit<Parts, "open"> & { item: ValueCard }) {
  const form = formOf(item);
  const fields = useRef<(HTMLInputElement | null)[]>([]);
  const [filled, setFilled] = useState(false);
  const baseId = useId();
  const values = () => fields.current.slice(0, form.fields.length).map((f) => f?.value ?? "");
  const complete = () => values().every((v, n) => (form.fields[n].masked ? v !== "" : v.trim() !== ""));
  const go = () => {
    if (offline || !complete()) return;
    send(form.answer(values()));
    for (const f of fields.current) if (f) f.value = "";
    setFilled(false);
  };
  const last = form.fields.length - 1;
  return (
    <div className="question-masked" ref={keepFocus}>
      {form.fields.map((field, n) => (
        <div className="question-own" key={field.label}>
          <label htmlFor={`${baseId}-${n}`} className="sr-only">
            {field.label}
          </label>
          <input
            ref={(el) => void (fields.current[n] = el)}
            id={`${baseId}-${n}`}
            className="question-field"
            type={field.masked ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            placeholder={field.placeholder}
            onInput={() => setFilled(complete())}
            onKeyDown={onEnter(go)}
          />
          {n === last && (
            <>
              <button className="btn primary" aria-disabled={offline || !filled || undefined} onClick={deliberate(go)}>
                {form.sendLabel}
              </button>
              <button className="btn" aria-disabled={offline || undefined} onClick={deliberate(() => send({ kind: "skip" }))}>
                Skip
              </button>
            </>
          )}
        </div>
      ))}
      <div className="approval-desc question-note">{form.note}</div>
    </div>
  );
}
