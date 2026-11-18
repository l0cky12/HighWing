// Hermes's computer_use in the transcript (ADR 0216): one card per run of calls, a line per call. The wire's quirks are
// dealt with before anything here reads an item: stored history's `tool_call` wrapper is unwrapped in transport.ts, and
// a result is trimmed by `keptResult` before the chat keeps it. So every function here reads tool items alone, live or
// saved, and a run is never stored: `foldRuns` derives it on each render.
import type { Catalogue } from "../i18n/locale";
import { agentSend } from "./agentMessages";
import { beginsTurn, isWaiting, turnStart, type ApprovalItem, type Chat, type Item } from "./model";
import { isObj } from "./values";

/** Hermes's tool name (tools/computer_use, v0.23.2). */
export const COMPUTER_USE = "computer_use";

/** How much of a capture's element list the chat keeps. A long SOM list costs about 40 KB a step. */
export const KEPT_CAPTURE_CHARS = 2000;

const KEPT_META = ["mode", "width", "height", "elements"] as const;

/**
 * A `computer_use` result as the chat keeps it: the shape Hermes sent, less what nobody reads in a transcript. Image
 * parts and the duplicate `text_summary` go, a capture's text is cut to `KEPT_CAPTURE_CHARS`, and `meta` keeps the
 * capture's size. It stays Hermes's shape, so one reader serves live results and Saved copies alike. Only
 * `toolResultText` calls it, and its data-URL pass still runs after (ADR 0061).
 */
export function keptResult(result: unknown): unknown {
  if (!isObj(result) || result._multimodal !== true) return result;
  const { text_summary: _summary, content, meta, ...rest } = result;
  const texts = (Array.isArray(content) ? content : []).flatMap((part) =>
    isObj(part) && part.type === "text" && typeof part.text === "string" ? [{ type: "text", text: cut(part.text) }] : [],
  );
  const size = isObj(meta) ? Object.fromEntries(KEPT_META.flatMap((k) => (meta[k] === undefined ? [] : [[k, meta[k]]]))) : undefined;
  return { ...rest, content: texts, ...(size && { meta: size }) };
}

const cut = (text: string) => (text.length > KEPT_CAPTURE_CHARS ? `${text.slice(0, KEPT_CAPTURE_CHARS)}…` : text);

type ToolItem = Extract<Item, { kind: "tool" }>;

/** How an input reaches the screen. Foreground raises the window and moves focus; Hermes asks again for each. */
export type Delivery = "background" | "foreground";

/**
 * What one call asked for, read from its args. `verb`: Hermes's own action name (`capture`, `click`, `type`, …).
 * `line`: the call as Hermes's Approval words it ("click at (619, 777)", "type 'echo hi'", "scroll down x3").
 * `app`: the window it aimed at, when it named one.
 */
export type CuAction = { verb: string; line: string; app?: string; delivery?: Delivery };

/** What Hermes's own verdict told the model to do next, when it gave one. */
export type Verdict = "done" | "verify" | "escalate";

/**
 * How a call came out. Stored history keeps no results, so a call read from it is `unrecorded`, never a guess.
 * `refused`: Hermes's `human_has_control`, said before any Approval. `denied`: the owner answered Deny.
 */
export type CuOutcome =
  | { kind: "pending" }
  | { kind: "done"; note?: string; verdict?: Verdict; hint?: string; capture?: { app?: string; size?: string; elements?: number } }
  | { kind: "failed"; why: string; hint?: string }
  | { kind: "denied" }
  | { kind: "refused"; why: string }
  | { kind: "stopped" }
  | { kind: "unrecorded" };

/** One computer_use call. `n`: its place among the turn's calls, from 1, so a split run keeps counting. */
export type CuStep = {
  id: string;
  n: number;
  at?: number;
  durationS?: number;
  action: CuAction;
  outcome: CuOutcome;
  /** The reasoning Hermes streamed just before this call, folded in so a reasoning model doesn't split the card. */
  thought?: string;
};

/** A line of a run card: a step with the Approvals that gated it, or another tool called between two steps. */
export type RunLine = { kind: "step"; step: CuStep; asks: ApprovalItem[] } | { kind: "tool"; tool: ToolItem };

export type RunState = "asking" | "acting" | "refused" | "stopped" | "done";

/**
 * One computer-use run: the span of a turn from a computer_use call to the last one that follows it with no assistant
 * text, message, error or other Question between. `items`: the source items it stands for, in order. `id`: `cu-` and
 * the first step's id, stable across renders.
 */
export type CuRun = {
  kind: "cu-run";
  id: string;
  items: readonly Item[];
  lines: RunLine[];
  steps: number;
  /** The first call's start to the last call's end, in ms; `to` is absent while a call runs or without times. */
  span: { from?: number; to?: number };
  state: RunState;
};

/** The last turn's use of the Bot Desktop, for follow mode and the banner. `key`: its last run's id. */
export type ScreenUse = { key: string; running: boolean; steps: number; since?: number; refused?: string };

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function json(s: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(s);
    return isObj(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const POINTER = new Set(["click", "double_click", "right_click", "middle_click", "triple_click"]);
const quoted = (s: string) => `'${s.length > 60 ? `${s.slice(0, 60)}…` : s}'`;

function actionOf(args: Record<string, unknown> = {}): CuAction {
  const verb = text(args.action) || "computer_use";
  const at = Array.isArray(args.coordinate) && args.coordinate.length === 2 ? `(${args.coordinate.join(", ")})` : undefined;
  let line = verb;
  if (POINTER.has(verb)) line = at ? `${verb} at ${at}` : args.element !== undefined ? `${verb} element #${String(args.element)}` : verb;
  else if (verb === "type" && typeof args.text === "string") line = `type ${quoted(args.text)}`;
  else if (verb === "key" && text(args.keys)) line = `key ${quoted(text(args.keys))}`;
  else if (verb === "scroll") line = ["scroll", text(args.direction), num(args.amount) !== undefined ? `x${num(args.amount)}` : ""].filter(Boolean).join(" ");
  else if (verb === "wait" && num(args.seconds) !== undefined) line = `wait ${num(args.seconds)}s`;
  const app = text(args.app);
  const delivery = args.delivery_mode === "foreground" || args.delivery_mode === "background" ? args.delivery_mode : undefined;
  return { verb, line, ...(app && { app }), ...(delivery && { delivery }) };
}

const VERDICTS: Record<string, Verdict> = { done: "done", verify_fresh_state: "verify", escalate: "escalate" };

/** A capture's first line: `capture mode=som 1280x800 app=Xfdesktop`. */
function captureOf(line: string, meta: unknown): { app?: string; size?: string; elements?: number } | undefined {
  const m = /^capture\b(.*)$/m.exec(line);
  if (!m) return undefined;
  const size = /\b(\d+x\d+)\b/.exec(m[1])?.[1];
  const app = /\bapp=(\S+)/.exec(m[1])?.[1];
  const elements = num(isObj(meta) ? meta.elements : undefined) ?? num(Number(/^(\d+) interactable element/m.exec(line)?.[1] ?? NaN));
  return { ...(app && { app }), ...(size && { size }), ...(elements !== undefined && { elements }) };
}

function outcomeOf(tool: ToolItem): CuOutcome {
  if (tool.status === "running") return { kind: "pending" };
  if (tool.status === "stopped") return { kind: "stopped" };
  if (tool.result === undefined) return { kind: "unrecorded" };
  const r = json(tool.result);
  if (!r) return { kind: "done", note: tool.result.trim() };
  if (text(r.error).startsWith("BLOCKED: Action denied")) return { kind: "denied" };
  if (r.code === "human_has_control") return { kind: "refused", why: text(r.error) || text(r.message) };
  let answer = r;
  let capture: ReturnType<typeof captureOf>;
  if (r._multimodal === true) {
    const first = Array.isArray(r.content) && isObj(r.content[0]) ? text(r.content[0].text) : "";
    const split = first.indexOf("\n\ncapture ");
    const payload = isObj(r.action_result) ? r.action_result : first.startsWith("{") ? json(split < 0 ? first : first.slice(0, split)) : undefined;
    capture = captureOf(payload ? (split < 0 ? "" : first.slice(split + 2)) : first, r.meta);
    if (payload) answer = payload;
    else return { kind: "done", ...(capture && { capture }) };
  }
  const verdict = isObj(answer.verdict) ? answer.verdict : undefined;
  const hint = text(verdict?.hint);
  if (answer.ok === false || (text(answer.error) && answer.ok !== true)) return { kind: "failed", why: text(answer.message) || text(answer.error) || "It failed.", ...(hint && { hint }) };
  const note = text(answer.message).replace(/^✅\s*/u, "");
  const decision = VERDICTS[text(verdict?.decision)];
  return { kind: "done", ...(note && { note }), ...(decision && { verdict: decision }), ...(hint && { hint }), ...(capture && { capture }) };
}

const isCu = (i: Item): i is ToolItem & { name: typeof COMPUTER_USE } => i.kind === "tool" && i.name === COMPUTER_USE;

/** The step a tool item is, or undefined for any other tool. The tool's name decides, as for `agentSend`. */
export function stepOf(tool: ToolItem, n: number): CuStep | undefined {
  if (!isCu(tool)) return undefined;
  return {
    id: tool.id,
    n,
    ...(tool.at !== undefined && { at: tool.at }),
    ...(tool.durationS !== undefined && { durationS: tool.durationS }),
    action: actionOf(tool.args),
    outcome: outcomeOf(tool),
  };
}

/** An Approval Hermes asked for a computer_use action: `approvalItem` parsed a cua pattern key off it. */
const isCuAsk = (i: Item): i is ApprovalItem & { cua: CuAsk } => i.kind === "approval" && i.cua !== undefined;

/** What may sit between two calls of one run without ending it. */
const absorbed = (i: Item) => i.kind === "thinking" || isCuAsk(i) || (i.kind === "tool" && !agentSend(i));

/**
 * Items with each computer-use run folded into one `CuRun`, everything else as it came, in order. Pure; ChatPane calls
 * it on every render. Reasoning inside a run goes with the step after it, an Approval with the step before it, and
 * reasoning or tools after the run's last step stay outside it.
 */
export function foldRuns(items: readonly Item[]): (Item | CuRun)[] {
  const out: (Item | CuRun)[] = [];
  let n = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (beginsTurn(it)) n = 0;
    if (!isCu(it)) {
      out.push(it);
      continue;
    }
    let end = i;
    for (let k = i + 1; k < items.length && absorbed(items[k]); k++) if (isCu(items[k]) || (isCuAsk(items[k]) && k === end + 1)) end = k;
    const run = runOf(items.slice(i, end + 1), n, items[end + 1]);
    n += run.steps;
    out.push(run);
    i = end;
  }
  return out;
}

function runOf(items: readonly Item[], before: number, next: Item | undefined): CuRun {
  const lines: RunLine[] = [];
  let thought: string[] = [];
  let last: Extract<RunLine, { kind: "step" }> | undefined;
  for (const it of items) {
    if (it.kind === "thinking") thought.push(it.text.trim());
    else if (isCu(it)) {
      const step = stepOf(it, before + lines.filter((l) => l.kind === "step").length + 1)!;
      const said = thought.filter(Boolean).join("\n\n");
      last = { kind: "step", step: said ? { ...step, thought: said } : step, asks: [] };
      lines.push(last);
      thought = [];
    } else if (isCuAsk(it) && last) last.asks.push(it);
    else if (it.kind === "tool") lines.push({ kind: "tool", tool: it });
  }
  const steps = lines.flatMap((l) => (l.kind === "step" ? [l] : []));
  const first = steps[0].step;
  const end = steps[steps.length - 1].step;
  const stopped = steps.some((l) => l.step.outcome.kind === "stopped") || (next?.kind === "assistant" && !!next.interrupted);
  const state: RunState = steps.some((l) => l.asks.some(isWaiting))
    ? "asking"
    : steps.some((l) => l.step.outcome.kind === "pending")
      ? "acting"
      : end.outcome.kind === "refused"
        ? "refused"
        : stopped
          ? "stopped"
          : "done";
  const to = end.at !== undefined && end.outcome.kind !== "pending" ? end.at + (end.durationS ?? 0) * 1000 : undefined;
  return { kind: "cu-run", id: `cu-${first.id}`, items, lines, steps: steps.length, span: { ...(first.at !== undefined && { from: first.at }), ...(to !== undefined && { to }) }, state };
}

/** The last turn's computer_use, or undefined if it made none. */
export function screenUse(chat: Pick<Chat, "items" | "running">): ScreenUse | undefined {
  const turn = chat.items.slice(turnStart(chat.items));
  const calls = turn.filter(isCu);
  if (!calls.length) return undefined;
  const lastRun = foldRuns(turn).filter((b): b is CuRun => b.kind === "cu-run").at(-1)!;
  const end = stepOf(calls[calls.length - 1], calls.length)!.outcome;
  return {
    key: lastRun.id,
    running: !!chat.running,
    steps: calls.length,
    ...(calls[0].at !== undefined && { since: calls[0].at }),
    ...(end.kind === "refused" && { refused: end.why }),
  };
}

/**
 * A cua Approval's details, parsed from the request at the boundary (`approvalItem`). `verb` and `scope` come from
 * `pattern_key` (`cua:<verb>:<background|foreground>`), the one field Hermes grants by, so a grant covers one verb in
 * one delivery mode and the other mode still asks. `bring_to_front` is a verb of its own: Hermes asks for it as a second
 * scope when a call keeps the window raised. `target`: the command with its `computer_use: ` prefix and `[FOREGROUND —
 * …]` note taken off ("click at (619, 777)", "type 'echo …'").
 */
export type CuAsk = { verb: string; scope: Delivery; target: string; patternKey: string };

const PATTERN = /^cua:([a-z_]+):(background|foreground)$/;
const FOREGROUND_NOTE = /\s*\[FOREGROUND\b[^\]]*\]\s*$/;

/** The cua details of an `approval` request's params, or undefined when its pattern key isn't a cua one. */
export function askOf(params: Record<string, unknown>): CuAsk | undefined {
  const patternKey = text(params.pattern_key);
  const key = PATTERN.exec(patternKey);
  if (!key) return undefined;
  const target = text(params.command).replace(`${COMPUTER_USE}: `, "").replace(FOREGROUND_NOTE, "").trim();
  return { verb: key[1], scope: key[2] as Delivery, target, patternKey };
}

/** The other way an input is delivered: what a grant for `scope` leaves asking. */
export const otherScope = (scope: Delivery): Delivery => (scope === "background" ? "foreground" : "background");

type AskWords = Catalogue["chat"]["computerUse"]["ask"];

/** What a grant of `ask` covers, in the owner's words: "background clicks", "foreground key presses". */
export function grantWords(ask: CuAsk, l: AskWords): string {
  const noun: string | undefined = Object.hasOwn(l.noun, ask.verb) ? l.noun[ask.verb as keyof typeof l.noun] : undefined;
  return l.covers(ask.scope, noun ?? l.otherNoun(ask.verb.replaceAll("_", " ")));
}
