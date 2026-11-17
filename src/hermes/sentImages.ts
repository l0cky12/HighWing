// Images sent with a message: which paths a bubble may read from Hermes, which of them this app sent, what the bubble
// shows of a message's files, and the images read in this run. Hermes's stored text grammar for them is `peelImages` in
// branch.ts.
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

/**
 * An image this app sent: the chat it went in, and the path Hermes answered `image.attach_bytes` with. Hermes keeps no
 * record of who attached the images a stored message names (it stores them as `@image:` lines in the message's text, as
 * anyone who can message the profile could type them), so this app keeps its own, per connection and profile
 * (chatCache.ts), and reads by itself only the images it finds there.
 */
export type SentHere = { chat: string; path: SentImagePath };

/** The most images a profile's record keeps, the newest. */
export const SENT_HERE_KEPT = 2000;

/** The record as kept, leaving out any entry that isn't an image path sent in a chat. */
export function sentHereOf(v: unknown): SentHere[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((e) => {
    const image = sentImage(e?.path);
    return typeof e?.chat === "string" && e.chat && image ? [{ chat: e.chat, path: image.path }] : [];
  });
}

/** `kept` with `images` sent in `chat` added last, each once, keeping only the newest `SENT_HERE_KEPT`. */
export function withSentHere(kept: readonly SentHere[], chat: string, images: readonly SentImage[]): SentHere[] {
  const added = images.map(({ path }) => ({ chat, path }));
  const again = (e: SentHere) => added.some((a) => a.chat === e.chat && a.path === e.path);
  return [...kept.filter((e) => !again(e)), ...added].slice(-SENT_HERE_KEPT);
}

/**
 * How one sent image stands in its bubble. `ask`: this app didn't send it, so it is read only when the owner asks.
 * `why`: a sentence for the owner.
 */
export type SentImageLoad = { state: "loading" } | { state: "ask" } | { state: "shown"; src: string } | { state: "failed"; why: string };

/** The most characters of `data:` URL a store keeps. One image at Hermes's 16 MB limit is about 21.4 M. */
const BUDGET = 48 * 1024 * 1024;

/** The most images a store reads at once. The rest wait their turn, first asked first read. */
const READS_AT_ONCE = 3;

const keyOf = (path: SentImagePath, chat: string | undefined) => `${chat ?? ""}\0${path}`;

/**
 * The sent images read in this run, for one connection and profile, so a chat opened again draws them at once and no
 * Item, Saved copy or outbox row ever holds their bytes. `read` is `Hermes.readHostFile`: Hermes writes the images it
 * is sent on the dashboard's own machine, which for a profile with an SSH terminal isn't where its tools read paths.
 * `sentHere` says whether this app sent the image in that chat (`SentHere`). The images shown least recently go once
 * the store is past `budget`. A failure isn't kept, so asking again reads again, and two bubbles asking for one image at
 * once read it once.
 */
export class SentImageStore {
  private readonly shown = new Map<string, string>();
  private size = 0;
  private readonly reading = new Map<string, Promise<SentImageLoad>>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly read: (path: string) => Promise<FileView>,
    private readonly sentHere: (chat: string, path: SentImagePath) => boolean,
    private readonly budget = BUDGET,
  ) {}

  /**
   * How the image in `chat` stands before anything more is read: shown if it was read already, else read only if this
   * app sent it there or the owner asked (`asked`). Any other image is a line in a stored message, which could name any
   * image on the dashboard's machine, so nothing reads it until the owner does.
   */
  look(path: SentImagePath, chat: string | undefined, asked = false): SentImageLoad {
    const key = keyOf(path, chat);
    const src = this.shown.get(key);
    if (src !== undefined) {
      this.shown.delete(key);
      this.shown.set(key, src);
      return { state: "shown", src };
    }
    return asked || (chat !== undefined && this.sentHere(chat, path)) ? { state: "loading" } : { state: "ask" };
  }

  /** Reads the image if `look` lets it, or joins the read already going or waiting. Never rejects. */
  load(path: SentImagePath, chat: string | undefined, asked = false): Promise<SentImageLoad> {
    const now = this.look(path, chat, asked);
    if (now.state !== "loading") return Promise.resolve(now);
    const key = keyOf(path, chat);
    let reading = this.reading.get(key);
    if (!reading) {
      reading = this.inTurn(() => this.read(path))
        .then(
          (view): SentImageLoad => {
            if (view.kind !== "image") return { state: "failed", why: view.kind === "unsupported" ? view.reason : "Hermes's answer isn't an image." };
            this.keep(key, view.src);
            return { state: "shown", src: view.src };
          },
          (e): SentImageLoad => ({ state: "failed", why: `Couldn't read it from the dashboard's machine. ${errorText(e)}` }),
        )
        .finally(() => this.reading.delete(key));
      this.reading.set(key, reading);
    }
    return reading;
  }

  /** Lets go of an image the webview couldn't draw, so it is read again next time. */
  drop(path: SentImagePath, chat: string | undefined) {
    this.forget(keyOf(path, chat));
  }

  /** Runs `work` once fewer than `READS_AT_ONCE` reads are running; a finished read hands its turn to the next. */
  private async inTurn<T>(work: () => Promise<T>): Promise<T> {
    if (this.running < READS_AT_ONCE) this.running++;
    else await new Promise<void>((go) => this.waiting.push(go));
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
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
