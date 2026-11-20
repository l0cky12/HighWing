// A file the owner gives the picture picker for a bot (ADR 0243), in Edit bot (ADR 0189) and on Bot setup's card
// (ADR 0236): PNG, JPEG or WebP. The crop step turns it into a 256 px PNG, far under the 2 MB Hermes stores, so the
// file itself may be much larger, up to what Rust reads of a dropped image (`PREVIEW_MAX_BYTES` in transport.rs). A
// drop and Browse files then refuse the same files.
import { invoke } from "@tauri-apps/api/core";
import type { LocalFile } from "../hermes/pipe";
import type { Locale } from "../i18n/locale";
import { readPreview } from "./previews";

export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const PICTURE_INPUT_MAX_BYTES = 25 * 1024 * 1024;

export type PictureFileProblem = "format" | "tooBig" | "unread";

/** Why a file can't be a bot's picture, judged before its bytes are read. */
export const pictureFileProblem = (file: { type: string; size: number }): PictureFileProblem | undefined =>
  !PICTURE_TYPES.includes(file.type) ? "format" : file.size > PICTURE_INPUT_MAX_BYTES ? "tooBig" : undefined;

const TYPE_OF: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

/**
 * A file the owner dropped or copied, which the webview knows only by its path: Rust reads it, as it does for the
 * composer's thumbnail of a dropped image. Its type is its name's, which is all Rust goes by too.
 */
export async function readPicturePath(path: string): Promise<File | PictureFileProblem> {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const type = TYPE_OF[name.slice(name.lastIndexOf(".") + 1).toLowerCase()];
  if (!type) return "format";
  try {
    const [stat] = await invoke<LocalFile[]>("hermes_stat_files", { paths: [path] });
    if ((stat?.size ?? 0) > PICTURE_INPUT_MAX_BYTES) return "tooBig";
    return new File([await readPreview(path)], name, { type });
  } catch {
    return "unread";
  }
}

export const pictureProblemText = (f: Locale["profiles"]["form"], why: PictureFileProblem) =>
  why === "format" ? f.pictureFormat : why === "tooBig" ? f.pictureTooBig : f.pictureUnread;
