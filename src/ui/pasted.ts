// What a paste carries that the app takes as files. The composer attaches them, and the picture picker (ADR 0235)
// takes an image from them.
/**
 * What a paste into the composer attaches. The webview pastes the text itself, except for a file copy, whose text is
 * only the files' paths.
 */
export type PasteAttaches =
  /** Files copied in a file manager: a `text/uri-list` of `file://` URIs, which WebKitGTK names but hides. Rust reads it. */
  | { kind: "copied files" }
  /** Files the paste event carries as bytes: a screenshot, or files copied in Explorer (Chromium). */
  | { kind: "files"; files: File[]; keepText: boolean }
  /** No text the page can see: WebKitGTK hides a clipboard image, and the text beside it, from the paste event. */
  | { kind: "clipboard images" }
  | { kind: "nothing" };

export function pasteAttaches(data: { types: readonly string[]; files: ArrayLike<File>; getData(type: string): string }): PasteAttaches {
  const files = Array.from(data.files);
  const text = data.getData("text/plain");
  if (files.length) return { kind: "files", files, keepText: !!text };
  const uris = data.getData("text/uri-list").split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  if (data.types.includes("text/uri-list") && uris.every((u) => u.startsWith("file:"))) return { kind: "copied files" };
  return text ? { kind: "nothing" } : { kind: "clipboard images" };
}

/**
 * The images on the clipboard, as files. WebKitGTK leaves a paste event's `files` empty even for a screenshot, but the
 * async clipboard API, asked during the paste, has it. Empty when there are none or the clipboard can't be read.
 */
export async function clipboardImages(): Promise<File[]> {
  try {
    const items = await navigator.clipboard.read();
    return await Promise.all(
      items.flatMap((item) => {
        const type = item.types.find((t) => t.startsWith("image/"));
        return type ? [item.getType(type).then((b) => new File([b], "", { type }))] : [];
      }),
    );
  } catch {
    return [];
  }
}
