const GLUE = /^[\p{L}\p{N}_]$/u;

type Handled = { readonly handle: string };
type Named = Handled & { readonly name: string };

function gluedAt(text: string, at: number): boolean {
  if (at === 0) return false;
  const low = text.charCodeAt(at - 1);
  const pair = at >= 2 && low >= 0xdc00 && low <= 0xdfff && text.charCodeAt(at - 2) >= 0xd800 && text.charCodeAt(at - 2) <= 0xdbff;
  return GLUE.test(text.slice(pair ? at - 2 : at - 1, at));
}

export type Typing = { readonly from: number; readonly query: string };

export function pickerAt(text: string, caret: number): Typing | undefined {
  let i = Math.min(caret, text.length);
  while (i > 0 && text[i - 1] !== "@" && !/\s/.test(text[i - 1])) i--;
  if (i === 0 || text[i - 1] !== "@" || gluedAt(text, i - 1)) return undefined;
  return { from: i - 1, query: text.slice(i, caret) };
}

export type PickerRow<S> = { readonly kind: "seat"; readonly seat: S };

export const rowHandle = (row: PickerRow<Handled>): string => row.seat.handle;

// toLowerCase writes a word-final capital sigma as the final form, which a typed prefix doesn't end in.
const caseOnly = (s: string): string => s.normalize("NFC").toLowerCase().replaceAll("ς", "σ");
const words = (s: string): string[] => caseOnly(s).split(/[^\p{L}\p{M}\p{N}]+/u);

export function pickerRows<S extends Named>(query: string, roster: readonly S[]): readonly PickerRow<S>[] {
  const q = caseOnly(query);
  return roster.filter((s) => caseOnly(s.handle).startsWith(q) || words(s.name).some((w) => w.startsWith(q))).map((seat) => ({ kind: "seat", seat }));
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
