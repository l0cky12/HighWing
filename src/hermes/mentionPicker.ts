type Named = { readonly handle: string; readonly name: string };

export const HANDLE_CHAR = "[\\p{L}\\p{N}_-]";

// toLowerCase writes a word-final capital sigma as the final form, which a typed prefix doesn't end in.
const caseOnly = (s: string): string => s.normalize("NFC").toLowerCase().replaceAll("ς", "σ");
const words = (s: string): string[] => caseOnly(s).split(/[^\p{L}\p{M}\p{N}]+/u);

export function matchBots<B extends Named>(query: string, bots: readonly B[]): B[] {
  const q = caseOnly(query);
  return bots.filter((b) => caseOnly(b.handle).startsWith(q) || words(b.name).some((w) => w.startsWith(q)));
}

export function completeMention(text: string, start: number, caret: number, handle: string): { text: string; caret: number } {
  const after = text.slice(caret);
  const word = `@${handle}`;
  return { text: `${text.slice(0, start)}${word}${/^\s/.test(after) ? "" : " "}${after}`, caret: start + word.length + 1 };
}

export type Mention<B> = { start: number; end: number; bot: B };

const MENTION = new RegExp(`(?<=^|\\s)@(${HANDLE_CHAR}+)`, "gu");

export function mentionsIn<B extends { readonly handle: string }>(text: string, bots: readonly B[]): Mention<B>[] {
  const by = new Map(bots.map((b) => [b.handle, b]));
  return [...text.matchAll(MENTION)].flatMap((m) => {
    const bot = by.get(m[1]);
    return bot ? [{ start: m.index, end: m.index + m[0].length, bot }] : [];
  });
}
