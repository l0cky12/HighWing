// A picture file the owner chooses for a bot, under Hermes's rules for `profiles.set_asset`: PNG, JPEG or WebP, up to
// 2 MB. Edit bot's picker and Bot setup's card (ADR 0235) both read one here, and say why with the same words.
import { BOT_PICTURE_MAX_BYTES } from "../hermes/bots";
import type { Locale } from "../i18n/locale";

export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp"];

export type PictureFileProblem = "format" | "tooBig" | "unread";

/** The file as a data URL, or why it can't be a bot's picture. Never rejects. */
export function readPictureFile(file: File): Promise<{ ok: true; dataUrl: string } | { ok: false; why: PictureFileProblem }> {
  if (!PICTURE_TYPES.includes(file.type)) return Promise.resolve({ ok: false, why: "format" });
  if (file.size > BOT_PICTURE_MAX_BYTES) return Promise.resolve({ ok: false, why: "tooBig" });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? { ok: true, dataUrl: reader.result } : { ok: false, why: "unread" });
    reader.onerror = () => resolve({ ok: false, why: "unread" });
    reader.readAsDataURL(file);
  });
}

export const pictureProblemText = (f: Locale["profiles"]["form"], why: PictureFileProblem) =>
  why === "format" ? f.pictureFormat : why === "tooBig" ? f.pictureTooBig : f.pictureUnread;
