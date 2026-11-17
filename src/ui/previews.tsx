// Pictures of attached images. The composer's thumbnails: Rust reads the bytes (image files only, up to 25 MB), and
// each becomes a blob: URL that lives only while its image is staged. Nothing is copied to disk. A sent message's
// images: read from Hermes's stored copy as data: URLs (sentImages.ts), never from this computer.
import { createContext, useContext, useEffect, useState } from "react";
import { CloudOff, ImageOff, Paperclip, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { staleText, type AnnotationLabel } from "../hermes/annotations";
import type { Attachment, SentImage } from "../hermes/model";
import { sentImageName, type SentImageLoad, type SentImageStore } from "../hermes/sentImages";
import { useOpenPreview, usePathsIn } from "./previewContext";
import { asError } from "../hermes/tauriPipe";
import { errorText, formatBytes } from "../hermes/values";

/** A staged image's thumbnail once read, or why it couldn't be read. */
export type Preview = { url: string } | { error: string };

export const readPreview = (path: string): Promise<Blob> =>
  invoke<ArrayBuffer>("hermes_read_preview", { path })
    .catch(asError)
    .then((bytes) => new Blob([bytes]));

/**
 * The composer's thumbnails. `sync` reads newly staged images and releases the URLs of ones no longer staged (removed,
 * sent, or swapped for a new list); `dispose` releases them all. `onChange` fires when a thumbnail is ready or fails.
 */
export class Previews {
  private readonly ready = new Map<string, Preview>();
  /** The read in flight for each path; a read whose path was unstaged meanwhile is thrown away when it lands. */
  private readonly reading = new Map<string, object>();
  private disposed = false;

  constructor(
    private readonly read: (path: string) => Promise<Blob>,
    private readonly onChange: () => void,
    private readonly urls: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL,
  ) {}

  get(path: string): Preview | undefined {
    return this.ready.get(path);
  }

  sync(attachments: readonly Attachment[]) {
    const staged = new Set(attachments.filter((a) => a.kind === "image").map((a) => a.path));
    for (const [path, p] of this.ready)
      if (!staged.has(path)) {
        this.release(p);
        this.ready.delete(path);
      }
    for (const path of this.reading.keys()) if (!staged.has(path)) this.reading.delete(path);
    for (const path of staged) if (!this.ready.has(path) && !this.reading.has(path)) void this.load(path);
  }

  dispose() {
    this.disposed = true;
    this.sync([]);
  }

  private async load(path: string) {
    const token = {};
    this.reading.set(path, token);
    let p: Preview;
    try {
      p = { url: this.urls.createObjectURL(await this.read(path)) };
    } catch (e) {
      p = { error: errorText(e) };
    }
    if (this.disposed || this.reading.get(path) !== token) return this.release(p);
    this.reading.delete(path);
    this.ready.set(path, p);
    this.onChange();
  }

  private release(p: Preview) {
    if ("url" in p) this.urls.revokeObjectURL(p.url);
  }
}

/** A staged attachment: its thumbnail if it is an image that could be read, else a paperclip. */
/** `annotation`: where an annotation's image came from, and whether the Preview's page has moved since (ADR 0094). */
export function AttachmentChip({ file, preview, annotation, onRemove }: { file: Attachment; preview?: Preview; annotation?: AnnotationLabel; onRemove: () => void }) {
  // The bytes looked like an image but the webview couldn't draw them.
  const [broken, setBroken] = useState(false);
  const url = preview && "url" in preview && !broken ? preview.url : undefined;
  const why = broken ? "the image couldn't be shown" : preview && "error" in preview ? preview.error : undefined;
  const from = annotation && staleText(annotation);
  const title = [file.path, from, why && `No preview: ${why}`].filter(Boolean).join("\n");
  return (
    <span className={annotation?.stale ? "chip chip-stale" : "chip"} title={title}>
      {url ? <img className="chip-thumb" src={url} alt="" onError={() => setBroken(true)} /> : <Paperclip size={12} />}
      <span className="chip-name">{file.name}</span>
      <span className="chip-size">{formatBytes(file.size)}</span>
      {annotation?.stale && (
        <span className="chip-note" aria-label={from}>
          page changed
        </span>
      )}
      <button title="Remove" onClick={onRemove}>
        <X size={12} />
      </button>
    </span>
  );
}

/** The store a sent message's images are read through, one for each connection and profile, given by Main. */
export const SentImageReader = createContext<SentImageStore | undefined>(undefined);

/**
 * The images Hermes stored for a message, above its words. A shown image is a button that opens it in the Preview. One
 * that can't be shown is named, with why and Try again. `offline`: nothing is read until Hermes is reachable, and an
 * image not read yet is named, with what it waits for.
 */
export function SentImages({ images, offline }: { images: readonly SentImage[]; offline: boolean }) {
  return (
    <div className="msg-images">
      {images.map((image, i) => (
        <SentPicture key={`${i}:${image.path}`} image={image} offline={offline} />
      ))}
    </div>
  );
}

function SentPicture({ image, offline }: { image: SentImage; offline: boolean }) {
  const store = useContext(SentImageReader);
  const open = useOpenPreview();
  // The chat whose sandbox Hermes reads the path in.
  const session = usePathsIn()?.session;
  const [load, setLoad] = useState<SentImageLoad>(() => {
    const src = store?.peek(image.path, session);
    return src === undefined ? { state: "loading" } : { state: "shown", src };
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!store) return setLoad({ state: "failed", why: "Images from Hermes can't be read here." });
    const src = store.peek(image.path, session);
    if (src !== undefined) return setLoad({ state: "shown", src });
    setLoad({ state: "loading" });
    if (offline) return;
    let live = true;
    void store.load(image.path, session).then((l) => {
      if (live) setLoad(l);
    });
    return () => {
      live = false;
    };
  }, [store, image.path, session, offline, attempt]);
  const name = sentImageName(image);
  if (load.state === "loading" && !offline) return <div className="sent-image-loading" role="img" aria-busy="true" aria-label={`Loading ${name}`} title={name} />;
  if (load.state !== "shown") {
    const why = load.state === "failed" ? load.why : "It shows once Hermes is reachable and the chat has loaded.";
    return (
      <span className="sent-image-failed" title={`${name}\n${why}`}>
        {load.state === "failed" ? <ImageOff size={12} aria-hidden /> : <CloudOff size={12} aria-hidden />}
        <span className="chip-name">{name}</span>
        {store && load.state === "failed" && (
          <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        )}
        <span className="sent-image-why">{why}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="sent-image"
      title={`${name}\nOpens in the preview`}
      disabled={!open}
      onClick={() => open?.({ kind: "server", path: image.path, ...(session && { session }) })}
    >
      <img
        src={load.src}
        alt={name}
        onError={() => {
          store?.drop(image.path, session);
          setLoad({ state: "failed", why: "The image couldn't be shown." });
        }}
      />
    </button>
  );
}
