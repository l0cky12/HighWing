import { fromMarkdown } from "mdast-util-from-markdown";

export const EVERYONE_HANDLES: ReadonlySet<string> = new Set(["all", "everyone"]);

type Handled = { readonly handle: string };
type Named = Handled & { readonly name: string };

export type Target<S> = { readonly kind: "everyone" } | { readonly kind: "seat"; readonly seat: S };

export type Mention<S> = { readonly at: number; readonly raw: string } & (
  | { readonly kind: "plain"; readonly target: Target<S> }
  | { readonly kind: "inCode"; readonly target: Target<S> }
  | { readonly kind: "glued"; readonly target: Target<S>; readonly before: string }
  | { readonly kind: "trailing"; readonly meant: Target<S>; readonly tail: string }
  | { readonly kind: "unknown" }
);
export type MentionNote<S> = Exclude<Mention<S>, { kind: "plain" }>;

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

// The Markdown parser slows faster than the text grows on deeply nested lists, and this runs on every keystroke.
const MAX_PARSED = 16 * 1024;
const NESTED_TOO_DEEP = /^(?:[ \t]*(?:[>*+-]|\d+[.)])){24}/m;
const tooCostlyToParse = (text: string): boolean => text.length > MAX_PARSED || NESTED_TOO_DEEP.test(text);

function codeRanges(text: string): readonly Range[] {
  if (!text.includes("@") || tooCostlyToParse(text)) return [];
  type Node = { type: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: Node[] };
  const sentFrom = text.length - text.trimStart().length;
  const found: Range[] = [];
  const stack: Node[] = [fromMarkdown(text.trimStart()) as Node];
  for (let node = stack.pop(); node; node = stack.pop()) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if ((node.type === "inlineCode" || node.type === "code") && start !== undefined && end !== undefined) found.push({ from: start + sentFrom, to: end + sentFrom });
    else if (node.children) stack.push(...node.children);
  }
  return found.sort((a, b) => a.from - b.from);
}

const EVERYONE: Target<never> = { kind: "everyone" };

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

export function mentionedHandles(text: string): string[] {
  return [...text.matchAll(HERMES_MENTION)].map((m) => fold(m[1]));
}

export type Typing = { readonly from: number; readonly query: string };

export function pickerAt(text: string, caret: number): Typing | undefined {
  let i = Math.min(caret, text.length);
  while (i > 0 && text[i - 1] !== "@" && !/\s/.test(text[i - 1])) i--;
  if (i === 0 || text[i - 1] !== "@" || gluedAt(text, i - 1)) return undefined;
  return { from: i - 1, query: text.slice(i, caret) };
}

export type PickerRow<S> = { readonly kind: "seat"; readonly seat: S } | { readonly kind: "everyone" };

export const rowHandle = (row: PickerRow<Handled>): string => (row.kind === "seat" ? row.seat.handle : "all");

const caseOnly = (s: string): string => s.normalize("NFC").toLowerCase();
const words = (s: string): string[] => caseOnly(s).split(/[^\p{L}\p{M}\p{N}]+/u);

export function pickerRows<S extends Named>(query: string, roster: readonly S[], everyoneName: string): readonly PickerRow<S>[] {
  const q = caseOnly(query);
  const hit = (handle: string, name: string) => caseOnly(handle).startsWith(q) || words(name).some((w) => w.startsWith(q));
  const rows: PickerRow<S>[] = roster.filter((s) => hit(s.handle, s.name)).map((seat) => ({ kind: "seat", seat }));
  return hit("all", everyoneName) ? [...rows, { kind: "everyone" }] : rows;
}

export function completeMention(text: string, caret: number, typing: Typing, row: PickerRow<Handled>): { text: string; caret: number } {
  const handle = rowHandle(row);
  return { text: `${text.slice(0, typing.from)}@${handle} ${text.slice(caret)}`, caret: typing.from + handle.length + 2 };
}

export type KeyAction = "next" | "prev" | "pick" | "close" | "send" | "none";

export function keyAction(k: { key: string; shift: boolean; composing: boolean; pickerOpen: boolean }): KeyAction {
  if (k.composing) return "none";
  if (k.pickerOpen) {
    switch (k.key) {
      case "ArrowDown":
        return "next";
      case "ArrowUp":
        return "prev";
      case "Enter":
      case "Tab":
        return "pick";
      case "Escape":
        return "close";
      default:
        return "none";
    }
  }
  return k.key === "Enter" && !k.shift ? "send" : "none";
}
