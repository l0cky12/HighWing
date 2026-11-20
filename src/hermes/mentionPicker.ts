type Named = { readonly handle: string; readonly name: string };

export const HANDLE_CHAR = "[\\p{L}\\p{M}\\p{N}_-]";

// toLowerCase writes a word-final capital sigma as the final form, which a typed prefix doesn't end in.
const caseOnly = (s: string): string => s.normalize("NFC").toLowerCase().replaceAll("ς", "σ");
const words = (s: string): string[] => caseOnly(s).split(/[^\p{L}\p{M}\p{N}]+/u);

export function matchBots<B extends Named>(query: string, bots: readonly B[]): B[] {
  const q = caseOnly(query);
  const exact = (b: B) => caseOnly(b.handle) === q;
  const hits = bots.filter((b) => caseOnly(b.handle).startsWith(q) || words(b.name).some((w) => w.startsWith(q)));
  return [...hits.filter(exact), ...hits.filter((b) => !exact(b))];
}

// U+200D, not U+2060: Unicode never breaks a grapheme before a ZERO WIDTH JOINER (UAX #29, rule GB9), so the caret
// takes no extra stop between "@" and the handle (ADR 0234).
export const PICK_MARK = "\u200D";

export type AskRule = "named" | "picked" | "none";

export function completeMention(text: string, start: number, caret: number, handle: string): { text: string; caret: number } {
  const after = text.slice(caret);
  const word = `@${PICK_MARK}${handle}`;
  return { text: `${text.slice(0, start)}${word}${after.startsWith(" ") ? "" : " "}${after}`, caret: start + word.length + 1 };
}

const MARKED = new RegExp(`@${PICK_MARK}+`, "g");
export const withoutPick = (text: string): string => text.replace(MARKED, "@");

export type Mention<B> = { start: number; end: number; bot: B; picked: boolean };

const MENTION = new RegExp(`(?<=^|\\s)@(${PICK_MARK})?(${HANDLE_CHAR}+)(?=[.,?!:;]*(?:\\s|$))`, "gu");

export function mentionsIn<B extends { readonly handle: string }>(text: string, bots: readonly B[]): Mention<B>[] {
  const by = new Map(bots.map((b) => [caseOnly(b.handle), b]));
  return [...text.matchAll(MENTION)].flatMap((m) => {
    const bot = by.get(caseOnly(m[2]));
    return bot ? [{ start: m.index, end: m.index + m[0].length, bot, picked: m[1] !== undefined }] : [];
  });
}

export const mentionsFor = <B extends { readonly handle: string }>(text: string, bots: readonly B[], rule: AskRule): Mention<B>[] =>
  rule === "none" ? [] : mentionsIn(text, bots).filter((m) => rule === "named" || m.picked);

export function withPicks(text: string, bots: readonly { readonly handle: string }[]): string {
  let out = "";
  let from = 0;
  for (const m of mentionsIn(text, bots)) {
    if (m.picked) continue;
    out += `${text.slice(from, m.start + 1)}${PICK_MARK}`;
    from = m.start + 1;
  }
  return out + text.slice(from);
}
