// The two things the picture picker needs a browser for (ADR 0243): decoding an upload, and drawing the square the
// owner framed into a PNG. Tests in jsdom, which has neither, swap this module for `fakePictureCanvas.ts`.
import { PICTURE_PX } from "./pictureCrop";

/** A decoded upload. `url` shows it in the crop step; `release` frees it once that step is over. */
export type LoadedPicture = { url: string; width: number; height: number; image: CanvasImageSource; release: () => void };

/** The file decoded, or undefined when the webview can't read it as an image. */
export async function loadPicture(file: Blob): Promise<LoadedPicture | undefined> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    return undefined;
  }
  if (!image.naturalWidth || !image.naturalHeight) {
    URL.revokeObjectURL(url);
    return undefined;
  }
  return { url, width: image.naturalWidth, height: image.naturalHeight, image, release: () => URL.revokeObjectURL(url) };
}

/** The square `source` of the picture, in its own pixels, as a 256 px PNG data URL. Throws when the webview can't draw it. */
export function drawCrop(picture: LoadedPicture, source: { x: number; y: number; size: number }): string {
  const canvas = Object.assign(document.createElement("canvas"), { width: PICTURE_PX, height: PICTURE_PX });
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(picture.image, source.x, source.y, source.size, source.size, 0, 0, PICTURE_PX, PICTURE_PX);
  return canvas.toDataURL("image/png");
}
