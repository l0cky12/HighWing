// Where a message's images go in its words (ADR 0198). Hermes stores a message's words as they were sent and its images
// as `@image:` lines after them, in the order they were attached (`peelImages`), so a mark in the words, such as
// `[image 2: shot.png]`, says where the second image goes. The model reads the same mark beside the images it is sent.
// An image no mark names is shown above the words, as every image was before.
import type { Attachment, SentImage } from "./model";

/** A mark in a message's words: the image it places (`n`, counted from 1) and the name it shows. */
export type ImageMark = { start: number; end: number; n: number; name: string };

const MARK = /\[image ([1-9]\d{0,8}): ([^[\]\n]{1,255})\]/g;

/** `[image 2: shot.png]`. A name can't end the mark early or break the line. */
export const markText = (n: number, name: string) => `[image ${n}: ${name.replace(/[[\]\r\n]/g, "_").slice(0, 255) || "image"}]`;

/** The marks in `text` that `has` knows, each image's first only: a second mark for one image is just words. */
export function marksIn(text: string, has: (n: number) => boolean): ImageMark[] {
  const seen = new Set<number>();
  return [...text.matchAll(MARK)].flatMap((m) => {
    const n = Number(m[1]);
    if (!has(n) || seen.has(n)) return [];
    seen.add(n);
    return [{ start: m.index, end: m.index + m[0].length, n, name: m[2] }];
  });
}

/**
 * `marks` put in `text` at `at`, a space from any word beside them. `end`: where the cursor goes, after the last.
 */
export function withMarks(text: string, at: number, marks: readonly string[]): { text: string; end: number } {
  const before = text.slice(0, at);
  const after = text.slice(at);
  const put = `${before && !/\s$/.test(before) ? " " : ""}${marks.join(" ")}${after && !/^\s/.test(after) ? " " : ""}`;
  return { text: before + put + after, end: before.length + put.length };
}

/**
 * The words a composer sends: each mark of a staged image renumbered by the image's place among those sent, and named
 * as it is. `numbers`: each staged image's number in the composer, by path. A mark for an image no longer staged goes,
 * and so does a second mark for one image, which would place another image once renumbered.
 */
export function sentText(text: string, attachments: readonly Attachment[], numbers: ReadonlyMap<string, number>): string {
  const images = attachments.filter((a) => a.kind === "image");
  const by = new Map(images.flatMap((a, i) => (numbers.has(a.path) ? [[numbers.get(a.path)!, { n: i + 1, name: a.name }] as const] : [])));
  let out = "";
  let from = 0;
  for (const m of text.matchAll(MARK)) {
    const to = by.get(Number(m[1]));
    out += text.slice(from, m.index);
    from = m.index + m[0].length;
    if (to) out += markText(to.n, to.name);
    else if (out.endsWith(" ") && text[from] === " ") from++;
    by.delete(Number(m[1]));
  }
  return out + text.slice(from);
}

/** A piece of a sent message's words: words, or the image a mark places there with the name the mark gives it. */
export type Piece = string | { image: SentImage; name: string };

/** A sent message's words split at its images' marks, and the images no mark places, which go above the words. */
export function placeImages(text: string, images: readonly SentImage[]): { above: SentImage[]; pieces: Piece[] } {
  const marks = marksIn(text, (n) => n <= images.length);
  if (!marks.length) return { above: [...images], pieces: text ? [text] : [] };
  const pieces: Piece[] = [];
  let from = 0;
  for (const m of marks) {
    if (m.start > from) pieces.push(text.slice(from, m.start));
    pieces.push({ image: images[m.n - 1], name: m.name });
    from = m.end;
  }
  if (from < text.length) pieces.push(text.slice(from));
  const placed = new Set(marks.map((m) => m.n - 1));
  return { above: images.filter((_, i) => !placed.has(i)), pieces };
}

/** The highest image number a mark in `text` gives, or 0. */
export const highestMark = (text: string) => Math.max(0, ...[...text.matchAll(MARK)].map((m) => Number(m[1])));

/**
 * Where place `at` in `before` is in `after`, one edit later. Words put in at `at` go after it, and a place in words
 * the edit took out moves to the end of what replaced them. In repeated words more than one edit gives `after`, as
 * typing `a` into `aaa` anywhere does: `near`, where the edit began if known, picks the one nearest it.
 */
export function carried(at: number, before: string, after: string, near = Infinity): number {
  const shorter = Math.min(before.length, after.length);
  let same = 0;
  while (same < shorter && before[same] === after[same]) same++;
  let tail = 0;
  while (tail < shorter && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const from = Math.min(same, Math.max(shorter - tail, near));
  const kept = Math.min(tail, shorter - from);
  return at <= from ? at : Math.max(after.length - kept, at + after.length - before.length);
}
