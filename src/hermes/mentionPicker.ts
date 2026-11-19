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

export function completeMention(text: string, start: number, caret: number, handle: string): { text: string; caret: number } {
  const after = text.slice(caret);
  const word = `@${handle}`;
  return { text: `${text.slice(0, start)}${word}${after.startsWith(" ") ? "" : " "}${after}`, caret: start + word.length + 1 };
}

export type Mention<B> = { start: number; end: number; bot: B };

const MENTION = new RegExp(`(?<=^|\\s)@(${HANDLE_CHAR}+)(?=[.,?!:;]*(?:\\s|$))`, "gu");

/** Each "@handle" at the start or after a space that ends at a space, the end, or a run of . , ? ! : ; before either; a handle matches in any case, as in the menu. */
export function mentionsIn<B extends { readonly handle: string }>(text: string, bots: readonly B[]): Mention<B>[] {
  const by = new Map(bots.map((b) => [caseOnly(b.handle), b]));
  return [...text.matchAll(MENTION)].flatMap((m) => {
    const bot = by.get(caseOnly(m[1]));
    return bot ? [{ start: m.index, end: m.index + m[0].length, bot }] : [];
  });
}
