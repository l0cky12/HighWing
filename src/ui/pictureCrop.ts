// Fitting an uploaded picture to a bot's picture (ADR 0243). Every client cuts a bot's picture to a circle, so the
// owner places the image under one: the frame is a square with the circle inscribed, and Highwing keeps the square.
// Nothing here touches the DOM (`pictureCanvas.ts` draws).

/** The side of the PNG Highwing makes from an upload, the size of the pictures it ships. */
export const PICTURE_PX = 256;
/** The side of the crop step's frame, in CSS pixels. */
export const CROP_FRAME_PX = 200;
export const MAX_ZOOM = 4;

export type Size = { width: number; height: number };

/** `zoom`: 1 is the image just covering the frame. `x`, `y`: how far the image's middle sits from the frame's, in frame pixels. */
export type Crop = { zoom: number; x: number; y: number };

export const CENTERED: Crop = { zoom: 1, x: 0, y: 0 };

const between = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const zoomOf = (zoom: number) => between(Number.isFinite(zoom) ? zoom : 1, 1, MAX_ZOOM);
const scaleOf = (image: Size, frame: number, zoom: number) => (frame / Math.min(image.width, image.height)) * zoom;

/** `crop` with the image still covering the whole frame, so the circle never shows an empty corner. */
export function clampCrop(image: Size, frame: number, crop: Crop): Crop {
  const zoom = zoomOf(crop.zoom);
  const scale = scaleOf(image, frame, zoom);
  const reach = (side: number) => Math.max(0, (side * scale - frame) / 2);
  return { zoom, x: between(crop.x, -reach(image.width), reach(image.width)), y: between(crop.y, -reach(image.height), reach(image.height)) };
}

/** `crop` at another zoom, with what is in the frame's middle staying there. */
export function zoomTo(image: Size, frame: number, crop: Crop, zoom: number): Crop {
  const by = zoomOf(zoom) / zoomOf(crop.zoom);
  return clampCrop(image, frame, { zoom, x: crop.x * by, y: crop.y * by });
}

/** Where the image is drawn in the frame, in frame pixels. */
export function placed(image: Size, frame: number, crop: Crop): { left: number; top: number; width: number; height: number } {
  const c = clampCrop(image, frame, crop);
  const scale = scaleOf(image, frame, c.zoom);
  const width = image.width * scale;
  const height = image.height * scale;
  return { left: (frame - width) / 2 + c.x, top: (frame - height) / 2 + c.y, width, height };
}

/** The square of the image, in its own pixels, that the frame shows: what is drawn into the PNG. */
export function sourceRect(image: Size, frame: number, crop: Crop): { x: number; y: number; size: number } {
  const c = clampCrop(image, frame, crop);
  const scale = scaleOf(image, frame, c.zoom);
  const size = frame / scale;
  return { x: between(image.width / 2 - c.x / scale - size / 2, 0, image.width - size), y: between(image.height / 2 - c.y / scale - size / 2, 0, image.height - size), size };
}
