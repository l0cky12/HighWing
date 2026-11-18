import { fromMarkdown } from "mdast-util-from-markdown";

/** Hermes's two "send to the whole roster" handles. groupRooms.ts reserves the same set when it makes a draft. */
export const EVERYONE_HANDLES: ReadonlySet<string> = new Set(["all", "everyone"]);

/** Anything with a handle can sit in a roster, so callers pass rich seats and get the same objects back. */
type Handled = { readonly handle: string };
type Named = Handled & { readonly name: string };

export type Target<S> = { readonly kind: "everyone" } | { readonly kind: "seat"; readonly seat: S };

/**
 * One `@` in the text. `at` is the UTF-16 index of the `@`; `raw` is what Hermes captured after it, so the mention is
 * exactly `text.slice(at, at + 1 + raw.length)`.
 *
 * The kinds are a 2x2 of "did the owner mean a mention" (at a word start, outside code) by "does Hermes route on it":
 *   meant + routed         -> plain
 *   not meant + routed     -> inCode | glued  (carry `target`: it goes there anyway)
 *   meant + not routed     -> trailing | unknown  (no `target`: it reaches nobody)
 *   not meant + not routed -> not reported (`me@example.com`, `` `@Injectable` ``): no surprise, so no line.
 * A mention both glued and in code is `inCode`.
 */
export type Mention<S> = { readonly at: number; readonly raw: string } & (
  | { readonly kind: "plain"; readonly target: Target<S> }
  | { readonly kind: "inCode"; readonly target: Target<S> }
  | { readonly kind: "glued"; readonly target: Target<S>; /** The run of non-space text before the `@`, cut to the last 32 characters (with a leading ellipsis). */ readonly before: string }
  | { readonly kind: "trailing"; readonly meant: Target<S>; /** What Hermes took for part of the name, e.g. "." or ":-". */ readonly tail: string }
  | { readonly kind: "unknown" }
);
export type MentionNote<S> = Exclude<Mention<S>, { kind: "plain" }>;

/** Who answers the first round. `seats` is non-empty, unique and in roster order, as Hermes returns it. */
export type Recipients<S> =
  | { readonly kind: "everyone"; readonly because: "nobodyNamed" | "allNamed" }
  | { readonly kind: "seats"; readonly seats: readonly [S, ...S[]] };

export type GoesTo<S> = { readonly to: Recipients<S>; readonly mentions: readonly Mention<S>[] };

/** Hermes's `_MENTION_RE` as Python runs it: re.IGNORECASE adds U+0130, U+0131, U+017F and U+212A to [A-Za-z]. JS /i does not. */
const HERMES_MENTION = /@([A-Za-z0-9\u0130\u0131\u017f\u212a][A-Za-z0-9._:\-\u0130\u0131\u017f\u212a]*)/g;
const TAIL = new Set([".", "_", ":", "-"]);
const GLUE = /^[\p{L}\p{N}_]$/u;
const BEFORE_MAX = 32;

/** str.casefold() on what the regex can capture: toLowerCase, except the long s folds to s. */
const fold = (raw: string): string => raw.toLowerCase().replaceAll("\u017f", "s");

/** The character before the `@` is a letter, digit or underscore, so the `@` is stuck to a word. */
function gluedAt(text: string, at: number): boolean {
  if (at === 0) return false;
  const low = text.charCodeAt(at - 1);
  const pair = at >= 2 && low >= 0xdc00 && low <= 0xdfff && text.charCodeAt(at - 2) >= 0xd800 && text.charCodeAt(at - 2) <= 0xdbff;
  return GLUE.test(text.slice(pair ? at - 2 : at - 1, at));
}

function runBefore(text: string, at: number): string {
  let from = at;
  while (from > 0 && at - from < BEFORE_MAX && !/\s/.test(text[from - 1])) from--;
  if (/[\udc00-\udfff]/.test(text[from] ?? "")) from++;
  return from > 0 && !/\s/.test(text[from - 1]) ? `\u2026${text.slice(from, at)}` : text.slice(from, at);
}

type Range = { readonly from: number; readonly to: number };

/**
 * The Markdown parser is quadratic on a few shapes (a few thousand nested list items took 11 s, 30000 unclosed image
 * openers 2 s), and this runs on every keystroke. Text past this size, or with a line that opens 24 block quotes or
 * list items, is not read for code. Routing never depends on code, so that only drops the "in code" note.
 */
const MAX_PARSED = 16 * 1024;
const NESTED = /^(?:[ \t]*(?:[>*+-]|\d+[.)])){24}/m;

/**
 * Code as CommonMark reads it, because that is how the bots' models read the message: inline code, fenced code and an
 * indented block. An unclosed backtick is not code, and an unclosed fence runs to the end. The message goes out
 * trimmed, so leading spaces are not read as an indented block; offsets stay in the text given.
 */
function codeRanges(text: string): readonly Range[] {
  if (!text.includes("@") || text.length > MAX_PARSED || NESTED.test(text)) return [];
  type Node = { type: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: Node[] };
  const lead = text.length - text.trimStart().length;
  const found: Range[] = [];
  const stack: Node[] = [fromMarkdown(text.trimStart()) as Node];
  for (let node = stack.pop(); node; node = stack.pop()) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if ((node.type === "inlineCode" || node.type === "code") && start !== undefined && end !== undefined) found.push({ from: start + lead, to: end + lead });
    else if (node.children) stack.push(...node.children);
  }
  return found.sort((a, b) => a.from - b.from);
}

const EVERYONE: Target<never> = { kind: "everyone" };

/**
 * Hermes's first-round routing of an owner's message (`resolve_mentions` with default_all=True), plus what the owner
 * should be told about each `@`. `to` is folded from the routed mentions in this one pass, so the two never disagree.
 * Total: any string, any roster. Trimming the text never changes `to`.
 */
export function goesTo<S extends Handled>(text: string, roster: readonly S[]): GoesTo<S> {
  const bySeat = new Map(roster.map((s) => [fold(s.handle), s]));
  const targetOf = (handle: string): Target<S> | undefined => {
    if (EVERYONE_HANDLES.has(handle)) return EVERYONE;
    const seat = bySeat.get(handle);
    return seat && { kind: "seat", seat };
  };
  const code = codeRanges(text);
  const mentions: Mention<S>[] = [];
  const routed = new Set<string>();
  let everyone = false;
  let c = 0;
  for (const m of text.matchAll(HERMES_MENTION)) {
    const [, raw] = m;
    const at = m.index;
    const handle = fold(raw);
    const target = targetOf(handle);
    while (c < code.length && code[c].to <= at) c++;
    const inCode = c < code.length && code[c].from <= at;
    const glued = gluedAt(text, at);
    if (target) {
      if (target.kind === "everyone") everyone = true;
      else routed.add(handle);
      mentions.push(!glued && !inCode ? { at, raw, kind: "plain", target } : inCode ? { at, raw, kind: "inCode", target } : { at, raw, kind: "glued", target, before: runBefore(text, at) });
    } else if (!glued && !inCode) {
      let stem = raw.length;
      while (stem > 0 && TAIL.has(raw[stem - 1])) stem--;
      const meant = stem < raw.length ? targetOf(fold(raw.slice(0, stem))) : undefined;
      mentions.push(meant ? { at, raw, kind: "trailing", meant, tail: raw.slice(stem) } : { at, raw, kind: "unknown" });
    }
  }
  const [first, ...rest] = roster.filter((s) => routed.has(fold(s.handle)));
  const to: Recipients<S> = everyone ? { kind: "everyone", because: "allNamed" } : first ? { kind: "seats", seats: [first, ...rest] } : { kind: "everyone", because: "nobodyNamed" };
  return { to, mentions };
}

/** Every handle Hermes would capture, folded as Hermes folds it. For asksOwner and carryOnDraft, which read bot replies. */
export function mentionedHandles(text: string): string[] {
  return [...text.matchAll(HERMES_MENTION)].map((m) => fold(m[1]));
}

/** The `@word` the caret sits at the end of, when that `@` starts a word. The query is the non-space run after it, so non-ASCII letters stay in it. */
export type Typing = { readonly from: number; readonly query: string };

export function pickerAt(text: string, caret: number): Typing | undefined {
  let i = Math.min(caret, text.length);
  while (i > 0 && text[i - 1] !== "@" && !/\s/.test(text[i - 1])) i--;
  if (i === 0 || text[i - 1] !== "@" || gluedAt(text, i - 1)) return undefined;
  return { from: i - 1, query: text.slice(i, caret) };
}

export type PickerRow<S> = { readonly kind: "seat"; readonly seat: S } | { readonly kind: "everyone" };

export const rowHandle = (row: PickerRow<Handled>): string => (row.kind === "seat" ? row.seat.handle : "all");

const letters = (s: string): string => s.normalize("NFC").toLowerCase();
const words = (s: string): string[] => letters(s).split(/[^\p{L}\p{M}\p{N}]+/u);

/**
 * Rows for a query, in roster order with Everyone last. A bot matches when the query starts its handle or starts any
 * word of its name. Both sides are NFC-normalised and lowercased, never accent-folded: "å" finds "Ångström", "Å" does
 * not find "Ada". An empty query returns every row.
 */
export function pickerRows<S extends Named>(query: string, roster: readonly S[], everyoneName: string): readonly PickerRow<S>[] {
  const q = letters(query);
  const hit = (handle: string, name: string) => letters(handle).startsWith(q) || words(name).some((w) => w.startsWith(q));
  const rows: PickerRow<S>[] = roster.filter((s) => hit(s.handle, s.name)).map((seat) => ({ kind: "seat", seat }));
  return hit("all", everyoneName) ? [...rows, { kind: "everyone" }] : rows;
}

/** Replaces the typed word with `@handle ` and says where the caret lands. What follows the caret is kept. */
export function completeMention(text: string, caret: number, typing: Typing, row: PickerRow<Handled>): { text: string; caret: number } {
  const handle = rowHandle(row);
  return { text: `${text.slice(0, typing.from)}@${handle} ${text.slice(caret)}`, caret: typing.from + handle.length + 2 };
}

export type KeyAction = "next" | "prev" | "pick" | "close" | "send" | "none";

/**
 * What a key does in the room composer. A key pressed while an input method composes belongs to it. With the picker
 * open (it has rows), the arrows move, Enter and Tab pick and Escape closes. Closed, Enter without Shift sends.
 */
export function keyAction(k: { key: string; shift: boolean; composing: boolean; pickerOpen: boolean }): KeyAction {
  if (k.composing) return "none";
  if (k.pickerOpen) return { ArrowDown: "next", ArrowUp: "prev", Enter: "pick", Tab: "pick", Escape: "close" }[k.key] as KeyAction | undefined ?? "none";
  return k.key === "Enter" && !k.shift ? "send" : "none";
}
