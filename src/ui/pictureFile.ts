// A bot picture the owner picks from a file, under Edit bot's rules (ADR 0189), which Bot setup's Upload your own…
// shares (ADR 0235): PNG, JPEG or WebP, up to the 2 MB Hermes stores.
import { BOT_PICTURE_MAX_BYTES } from "../hermes/bots";

export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp"];

export type PictureRead = { kind: "read"; dataUrl: string } | { kind: "format" | "tooBig" | "unread" };

/** The file as a data URL, or why it can't be a bot's picture. Never rejects. */
export function readPictureFile(file: File): Promise<PictureRead> {
  if (!PICTURE_TYPES.includes(file.type)) return Promise.resolve({ kind: "format" });
  if (file.size > BOT_PICTURE_MAX_BYTES) return Promise.resolve({ kind: "tooBig" });
  return new Promise((done) => {
    const reader = new FileReader();
    reader.onload = () => done(typeof reader.result === "string" ? { kind: "read", dataUrl: reader.result } : { kind: "unread" });
    reader.onerror = () => done({ kind: "unread" });
    reader.readAsDataURL(file);
  });
}
