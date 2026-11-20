// `pictureCanvas.ts` for tests in jsdom, which decodes and draws nothing. A file whose bytes start "not an image"
// doesn't decode; any other is a 400 × 300 image, and its crop is a PNG-shaped data URL that names the square drawn.
import type { LoadedPicture } from "./pictureCanvas";

export const FAKE_PICTURE = { width: 400, height: 300 };
let loaded = 0;

/** The data URL `drawCrop` gives for the square at `x`, `y` of side `size`. */
export const fakeCrop = (source: { x: number; y: number; size: number }) =>
  `data:image/png;base64,${btoa(`\x89PNG\r\n\x1a\ncropped ${[source.x, source.y, source.size].map((n) => Math.round(n)).join(" ")}`)}`;

export async function loadPicture(file: Blob): Promise<LoadedPicture | undefined> {
  if ((await file.slice(0, 12).text()) === "not an image") return undefined;
  return { ...FAKE_PICTURE, url: `blob:fake-picture-${++loaded}`, image: {} as CanvasImageSource, release: () => {} };
}

export const drawCrop = (_picture: LoadedPicture, source: { x: number; y: number; size: number }) => fakeCrop(source);
