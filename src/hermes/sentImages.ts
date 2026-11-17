// Images sent with a message: which paths a bubble may read from Hermes, what the bubble shows of a message's files,
// and the images read in this run. Hermes's stored text grammar for them is `peelImages` in branch.ts.
import type { Item, SentImage, SentImagePath } from "./model";
import { isServerPath, type FileView } from "./preview";
import { errorText } from "./values";

/** The image files `image.attach_bytes` stores (`tui_gateway/prompt_attachments.py`). No SVG, no icon. */
const SENT_IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp)$/i;

/**
 * The one way a `SentImage` is made, wherever one comes in: Hermes's answer to `image.attach_bytes`, a stored message's
 * text, and a kept Saved copy or outbox row. Only a full path on the server to an image file in a folder named `images`
 * passes, where Hermes keeps the images it is sent (`<profile home>/images/upload_*`, and `cache/images` for a
 * browser's paste). A stored message's text can be typed by anyone who can message the profile, so a line naming any
 * other file on the server, a web address, `~/.ssh/id_rsa`, or a path through `..`, is never asked of Hermes.
 */
export function sentImage(path: unknown, name?: unknown): SentImage | undefined {
  if (typeof path !== "string" || !path.startsWith("/") || !isServerPath(path) || !SENT_IMAGE_NAME.test(path)) return undefined;
  const parts = path.slice(1).split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..") || parts.at(-2) !== "images") return undefined;
  return { path: path as SentImagePath, ...(typeof name === "string" && name && { name }) };
}

/** What a bubble calls an image: its file name here, or else the last part of its path on Hermes. */
export const sentImageName = (image: SentImage) => image.name ?? image.path.slice(image.path.lastIndexOf("/") + 1);

/**
 * The names of the files sent with a message, for an export: those it went with here, and for each image read back
 * from Hermes, which has no name here, the last part of its path.
 */
export const sentNames = (item: Pick<Extract<Item, { kind: "user" }>, "attachments" | "images">) => [
  ...(item.attachments ?? []),
  ...(item.images ?? []).filter((i) => i.name === undefined).map(sentImageName),
];

/**
 * What a message's bubble shows of what went with it: the images Hermes has, and a chip for each other name. An image
 * takes the place of one chip of its name. A message Hermes didn't take keeps every name as a chip.
 */
export function sentWith(item: Pick<Extract<Item, { kind: "user" }>, "attachments" | "images" | "outgoing">): { images: SentImage[]; chips: string[] } {
  const images = item.outgoing?.state === "failed" ? [] : (item.images ?? []);
  const chips = [...(item.attachments ?? [])];
  for (const { name } of images) {
    const at = name === undefined ? -1 : chips.indexOf(name);
    if (at >= 0) chips.splice(at, 1);
  }
  return { images, chips };
}

/** How one sent image stands in its bubble. `why`: a sentence for the owner. */
export type SentImageLoad = { state: "loading" } | { state: "shown"; src: string } | { state: "failed"; why: string };
type Settled = Exclude<SentImageLoad, { state: "loading" }>;

/** The most characters of `data:` URL a store keeps. One image at Hermes's 16 MB limit is about 21.4 M. */
const BUDGET = 48 * 1024 * 1024;

const keyOf = (path: SentImagePath, session: string | undefined) => `${session ?? ""}\0${path}`;

/**
 * The sent images read in this run, for one connection and profile, so a chat opened again draws them at once and no
 * Item, Saved copy or outbox row ever holds their bytes. `read` is `Hermes.readServerFile`. The images shown least
 * recently go once the store is past `budget`. A failure isn't kept, so asking again reads again, and two bubbles asking
 * for one image at once read it once.
 */
export class SentImageStore {
  private readonly shown = new Map<string, string>();
  private size = 0;
  private readonly reading = new Map<string, Promise<Settled>>();

  constructor(
    private readonly read: (path: string, session?: string) => Promise<FileView>,
    private readonly budget = BUDGET,
  ) {}

  /** The image's `data:` URL if it was read already. */
  peek(path: SentImagePath, session?: string): string | undefined {
    const key = keyOf(path, session);
    const src = this.shown.get(key);
    if (src === undefined) return undefined;
    this.shown.delete(key);
    this.shown.set(key, src);
    return src;
  }

  /** Reads the image, or joins the read already going. Never rejects. */
  load(path: SentImagePath, session?: string): Promise<Settled> {
    const src = this.peek(path, session);
    if (src !== undefined) return Promise.resolve({ state: "shown", src });
    const key = keyOf(path, session);
    let reading = this.reading.get(key);
    if (!reading) {
      reading = this.read(path, session)
        .then(
          (view): Settled => {
            if (view.kind !== "image") return { state: "failed", why: view.kind === "unsupported" ? view.reason : "Hermes's answer isn't an image." };
            this.keep(key, view.src);
            return { state: "shown", src: view.src };
          },
          (e): Settled => ({ state: "failed", why: errorText(e) }),
        )
        .finally(() => this.reading.delete(key));
      this.reading.set(key, reading);
    }
    return reading;
  }

  /** Lets go of an image the webview couldn't draw, so it is read again next time. */
  drop(path: SentImagePath, session?: string) {
    this.forget(keyOf(path, session));
  }

  private forget(key: string) {
    const src = this.shown.get(key);
    if (src === undefined) return;
    this.shown.delete(key);
    this.size -= src.length;
  }

  private keep(key: string, src: string) {
    this.forget(key);
    this.shown.set(key, src);
    this.size += src.length;
    for (const [k, v] of this.shown) {
      if (this.size <= this.budget || k === key) break;
      this.shown.delete(k);
      this.size -= v.length;
    }
  }
}
