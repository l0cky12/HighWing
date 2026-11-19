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

/**
 * Written after the "@" of a bot picked from the menu (ADR 0234): a ZERO WIDTH JOINER, which joins the "@" in the
 * caret's steps and in the text box's own, so it adds no stop and no width. Typing and dictation never produce it, and
 * it is part of the words, so a draft, Undo and Redo keep it. It goes no further than the composer (`withoutPick`).
 */
export const PICK_MARK = "\u200D";

/**
 * Which "@handle" words name a bot to ask. `named`: any, typed or picked. `picked`: only one the menu wrote. `none`:
 * none, so every "@handle" is plain words.
 */
export type AskRule = "named" | "picked" | "none";

export function completeMention(text: string, start: number, caret: number, handle: string): { text: string; caret: number } {
  const after = text.slice(caret);
  const word = `@${PICK_MARK}${handle}`;
  return { text: `${text.slice(0, start)}${word}${after.startsWith(" ") ? "" : " "}${after}`, caret: start + word.length + 1 };
}

const MARKED = new RegExp(`@${PICK_MARK}+`, "g");
/** The words as Hermes should read them: the pick mark gone from every "@" that has one. */
export const withoutPick = (text: string): string => text.replace(MARKED, "@");

/** `start` and `end` cover the pick mark, so taking the pill out takes the mark with it. */
export type Mention<B> = { start: number; end: number; bot: B; picked: boolean };

const MENTION = new RegExp(`(?<=^|\\s)@(${PICK_MARK})?(${HANDLE_CHAR}+)(?=[.,?!:;]*(?:\\s|$))`, "gu");

/**
 * Each "@handle" at the start or after a space that ends at a space, the end, or a run of . , ? ! : ; before either; a
 * handle matches in any case, as in the menu. `picked`: the menu wrote it. Which of them ask a bot is `mentionsFor`.
 */
export function mentionsIn<B extends { readonly handle: string }>(text: string, bots: readonly B[]): Mention<B>[] {
  const by = new Map(bots.map((b) => [caseOnly(b.handle), b]));
  return [...text.matchAll(MENTION)].flatMap((m) => {
    const bot = by.get(caseOnly(m[2]));
    return bot ? [{ start: m.index, end: m.index + m[0].length, bot, picked: m[1] !== undefined }] : [];
  });
}

/** The mentions a chat's rule counts: the pills, the bots asked, and whether the message names any. */
export const mentionsFor = <B extends { readonly handle: string }>(text: string, bots: readonly B[], rule: AskRule): Mention<B>[] =>
  rule === "none" ? [] : mentionsIn(text, bots).filter((m) => rule === "named" || m.picked);

/** The words with each typed "@handle" of these bots picked, as an Edit puts back what an ask sent. */
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
