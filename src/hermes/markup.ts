// Mark up (ADR 0225): the box the owner draws on a staged image, its note, and the words they add to the message. The
// composer's dialog draws the box into a copy of the image (MarkUp.tsx); these are its shapes and its words. Nothing
// here knows about the Preview's pages: a staged image has no address, still or view.

import { withoutBidi } from "./preview";
import type { Rect } from "./annotations";

/** The longest note a box keeps; the words cut it to this. */
export const NOTE_MAX = 300;

/**
 * What a confirmed Mark up hands the composer: the marked bytes, and the box with its note. `n` is the box's number on
 * this image, as its badge shows: an image marked up again gets box 2, and so on.
 */
export type Marked = { bytes: Blob; type: MarkedType; n: number; rect: Rect; note: string };
export type MarkedType = "image/png" | "image/jpeg";

/** A JPEG stays a JPEG, so a photo doesn't balloon; everything else (screenshots, GIF, WebP, BMP) becomes a PNG. */
export const markedType = (name: string): MarkedType => (/\.jpe?g$/i.test(name) ? "image/jpeg" : "image/png");

/** The marked copy's name: the original's stem, with the extension its bytes now have. */
export function markedName(name: string, type: MarkedType): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (type === "image/jpeg") return `${stem}.${ext === "jpeg" ? "jpeg" : "jpg"}`;
  return `${stem}.png`;
}

/**
 * The words a Mark up adds at the composer's cursor, naming the box as its badge on the image does and the image as
 * Hermes gets it: `Box 1 on shot.png: the Save button is cut off`. The note goes on one line, its direction
 * overrides defused, cut to `NOTE_MAX`.
 */
export function markupWords(name: string, n: number, note: string): string {
  const one = withoutBidi(note.replace(/\s+/g, " ").trim());
  const cut = one.length > NOTE_MAX ? `${one.slice(0, NOTE_MAX - 1)}…` : one;
  return `Box ${n} on ${name}${cut ? `: ${cut}` : "."}`;
}
