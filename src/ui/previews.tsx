// Pictures of attached images. The composer's thumbnails: Rust reads the bytes (image files only, up to 25 MB), and
// each becomes a blob: URL that lives only while its image is staged. Nothing is copied to disk. A sent message's
// images: read from Hermes's stored copy on the dashboard's machine as data: URLs (sentImages.ts), never from this
// computer, and by themselves only when this app sent them.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { CloudOff, Image as ImageIcon, ImageOff, Paperclip, SquareDashedMousePointer, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { staleText, type AnnotationLabel } from "../hermes/annotations";
import type { Attachment, SentImage, SentImagePath } from "../hermes/model";
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

  /** Shows `bytes` for `path` at once: a marked-up image the webview drew itself, so its chip never goes blank. */
  put(path: string, bytes: Blob) {
    const was = this.ready.get(path);
    if (was) this.release(was);
    this.reading.delete(path);
    this.ready.set(path, { url: this.urls.createObjectURL(bytes) });
    this.onChange();
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

/**
 * A staged attachment. An image whose preview is read, or still being read, is a square thumbnail with Remove over its
 * corner (ADR 0220). A file, or an image that couldn't be read or shown, is a small chip with a paperclip.
 * `annotation`: where an annotation's image came from, and whether the Preview's page has moved since (ADR 0094).
 * `onMarkUp`: an image the webview has drawn offers Mark up in its other corner (ADR 0227).
 */
export function AttachmentChip({
  file,
  preview,
  annotation,
  onRemove,
  onMarkUp,
}: {
  file: Attachment;
  preview?: Preview;
  annotation?: AnnotationLabel;
  onRemove: () => void;
  onMarkUp?: () => void;
}) {
  // The bytes looked like an image but the webview couldn't draw them.
  const [broken, setBroken] = useState(false);
  const url = preview && "url" in preview && !broken ? preview.url : undefined;
  const why = broken ? "the image couldn't be shown" : preview && "error" in preview ? preview.error : undefined;
  const from = annotation && staleText(annotation);
  const stale = annotation?.stale ? " chip-stale" : "";
  const remove = (
    <button type="button" title="Remove" aria-label={`Remove ${file.name}`} onClick={onRemove}>
      <X size={12} />
    </button>
  );
  if (file.kind === "image" && !why) {
    const title = [`${file.name}, ${formatBytes(file.size)}`, file.path, from].filter(Boolean).join("\n");
    return (
      <span className={`chip chip-card${stale}`} title={title}>
        {url ? <img className="chip-card-img" src={url} alt="" onError={() => setBroken(true)} /> : <span className="chip-card-img chip-card-blank" />}
        <span className="chip-name sr-only">{file.name}</span>
        {annotation?.stale && (
          <span className="chip-note chip-card-note" aria-label={from}>
            page changed
          </span>
        )}
        {url && onMarkUp && (
          <button type="button" className="chip-card-markup" title="Mark up: draw a box and add a note" aria-label={`Mark up ${file.name}`} onClick={onMarkUp}>
            <SquareDashedMousePointer size={12} />
          </button>
        )}
        {remove}
      </span>
    );
  }
  const title = [file.path, from, why && `No preview: ${why}`].filter(Boolean).join("\n");
  return (
    <span className={`chip${stale}`} title={title}>
      <Paperclip size={12} />
      <span className="chip-name">{file.name}</span>
      <span className="chip-size">{formatBytes(file.size)}</span>
      {annotation?.stale && (
        <span className="chip-note" aria-label={from}>
          page changed
        </span>
      )}
      {remove}
    </span>
  );
}

/** The store a sent message's images are read through, one for each connection and profile, given by Main. */
export const SentImageReader = createContext<SentImageStore | undefined>(undefined);

/**
 * The images Hermes stored for a message, above its words. A shown image is a button that opens it in the Preview. One
 * this app didn't send is named, with Show image, and nothing reads it before that click. One that can't be shown is
 * named, with why and Try again. `offline`: nothing is read until Hermes is reachable, and an image not read yet is
 * named, with what it waits for.
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

/**
 * An image a mark places in a message's words (ADR 0220): a pill with a tiny thumbnail once its image is read, else an
 * image icon, and the name the mark gives it. It opens the image in the Preview as the picture above the words does.
 * Hermes keeps no size, so none is shown.
 */
export function InlineSentImage({ image, name, offline }: { image: SentImage; name: string; offline: boolean }) {
  const open = useOpenPreview();
  const { load } = useSentImage(image.path, offline);
  const [broken, setBroken] = useState(false);
  const src = load.state === "shown" && !broken ? load.src : undefined;
  return (
    <button type="button" className="inline-image" title={`${name}\nOpens in the preview`} disabled={!open} onClick={() => open?.({ kind: "server", path: image.path, host: true })}>
      {src ? <img src={src} alt="" onError={() => setBroken(true)} /> : <ImageIcon size={12} aria-hidden />}
      <span className="inline-image-name">{name}</span>
    </button>
  );
}

const NO_STORE: SentImageLoad = { state: "failed", why: "Images from Hermes can't be read here." };

/** A sent image read through the store, read again when `asked` or `attempt` changes. Nothing is read while offline. */
function useSentImage(path: SentImagePath, offline: boolean, asked = false, attempt = 0) {
  const store = useContext(SentImageReader);
  // The chat the message is in: an image is read by itself only if this app sent it in that chat.
  const chat = usePathsIn()?.session;
  const [load, setLoad] = useState<SentImageLoad>(() => store?.look(path, chat) ?? NO_STORE);
  useEffect(() => {
    if (!store) return setLoad(NO_STORE);
    const now = store.look(path, chat, asked);
    setLoad(now);
    if (now.state !== "loading" || offline) return;
    let live = true;
    void store.load(path, chat, asked).then((l) => {
      if (live) setLoad(l);
    });
    return () => {
      live = false;
    };
  }, [store, path, chat, offline, attempt, asked]);
  return { store, chat, load, setLoad };
}

function SentPicture({ image, offline }: { image: SentImage; offline: boolean }) {
  const open = useOpenPreview();
  const [asked, setAsked] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const { store, chat, load, setLoad } = useSentImage(image.path, offline, asked, attempt);
  const name = sentImageName(image);
  if (load.state === "loading" && !offline) return <div className="sent-image-loading" role="img" aria-busy="true" aria-label={`Loading ${name}`} title={name} />;
  if (load.state === "ask")
    return (
      <SentImageTile name={name} why="Not sent from this app, so it loads when you ask." icon={<ImageIcon size={12} aria-hidden />}>
        <button type="button" className="btn" aria-label={`Show image ${name}`} onClick={() => setAsked(true)}>
          Show image
        </button>
      </SentImageTile>
    );
  if (load.state === "failed")
    return (
      <SentImageTile name={name} why={load.why} icon={<ImageOff size={12} aria-hidden />}>
        {store && (
          <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        )}
      </SentImageTile>
    );
  if (load.state !== "shown") return <SentImageTile name={name} why="It shows once Hermes is reachable and the chat has loaded." icon={<CloudOff size={12} aria-hidden />} />;
  return (
    <button type="button" className="sent-image" title={`${name}\nOpens in the preview`} disabled={!open} onClick={() => open?.({ kind: "server", path: image.path, host: true })}>
      <img
        src={load.src}
        alt={name}
        onError={() => {
          store?.drop(image.path, chat);
          setLoad({ state: "failed", why: "The image couldn't be shown." });
        }}
      />
    </button>
  );
}

/** A sent image that isn't drawn: its name, why, and what can be done. */
function SentImageTile({ name, why, icon, children }: { name: string; why: string; icon: ReactNode; children?: ReactNode }) {
  return (
    <span className="sent-image-tile" title={`${name}\n${why}`}>
      {icon}
      <span className="chip-name">{name}</span>
      {children}
      <span className="sent-image-why">{why}</span>
    </span>
  );
}
