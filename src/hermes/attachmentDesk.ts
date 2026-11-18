// The files staged in each chat's composer. Rust stages a pasted file or a Preview annotation in a private folder; the
// desk hands an annotation to the composer on screen. The desk keeps every chat's staged attachments, keyed as its
// Draft is, so they wait there across chat switches until the owner sends or removes them (ADR 0145). It remembers
// which staged files are its own, so each one is deleted once nothing needs it any more. Nothing here sends anything to
// Hermes.

import type { AnnotationLabel } from "./annotations";
import { highestMark } from "./inlineImages";
import type { Attachment } from "./model";
import { stagedFiles } from "./unsaved";

export type AttachmentDeskApi = {
  discard: (path: string) => Promise<void>;
};

/**
 * The composer on screen. `key` is its chat's Draft key (drafts.ts `draftKey`), where its files are staged. `check`
 * resolves to the files Hermes can take, and shows why it refused any (one too large, say). `place` hears the files
 * `check` took once they are staged, to mark where they go in the words. `note` shows a line above the composer.
 * `insert` puts text at the composer's cursor. `chat`: the chat's title, for the annotation review card.
 */
export type ComposerSink = {
  key: string;
  chat?: string;
  check: (paths: string[]) => Promise<Attachment[]>;
  place?: (staged: readonly Attachment[]) => void;
  note: (text: string) => void;
  insert?: (text: string) => void;
};

/**
 * Every way a chat's staged attachments change, each chat's under its Draft key. `added`: attached in the composer, or
 * back from a message Hermes didn't confirm. `sent`: they went with a message, which holds them from then on (`hold`,
 * `sent`, `finish`). `removed`: the owner took them out. `gone`: the chat was deleted or archived. A file the desk owns
 * is staged in one chat at a time, so it is deleted once it is removed, its chat goes, or its message no longer needs
 * it; signing out deletes them all (`dispose`). A file the owner picked from their own folders can be in several.
 */
export type Staging =
  | { kind: "added"; key: string; attachments: readonly Attachment[] }
  | { kind: "sent" | "removed"; key: string; paths: readonly string[] }
  | { kind: "gone"; key: string };

const NONE: readonly Attachment[] = [];
const UNNUMBERED: ReadonlyMap<string, number> = new Map();

const RESTORED = "Hermes didn't confirm it got your message, so its files are back here. Send them again, or remove them.";

/**
 * An annotation waiting for a composer to show it: its words, for the composer's text, and `to`, the Draft key of the
 * only composer it may go to, since it describes a page the owner saw while that chat was theirs.
 */
type Waiting = { paths: string[]; words: string; to: string; live: () => boolean };

export class AttachmentDesk {
  private readonly listeners = new Set<() => void>();
  private readonly mine = new Set<string>();
  private waiting: Waiting[] = [];
  private readonly sending = new Set<string>();
  private readonly staged = new Map<string, readonly Attachment[]>();
  private readonly numbers = new Map<string, { of: ReadonlyMap<string, number>; next: number }>();
  private sink?: ComposerSink;
  /** The chat whose composer was last on screen: an annotation goes there while a covering Preview hides it. */
  private last?: { chat?: string; key: string };
  private disposed = false;
  /** Where each staged annotation came from, for its chip (ADR 0094), and how many moves the Preview's page had made then. */
  private readonly annotations = new Map<string, { url: string; takenAtMs: number; moves: number }>();
  private pageMoves = 0;
  private lastAnnotation = 0;
  private labels: ReadonlyMap<string, AnnotationLabel> = new Map();

  constructor(
    private readonly api: AttachmentDeskApi,
    private readonly reveal?: () => void,
    private readonly words: (key: string) => string = () => "",
  ) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  own(paths: readonly string[]) {
    if (this.disposed) return void paths.forEach((p) => void this.api.discard(p).catch(() => {}));
    for (const p of paths) this.mine.add(p);
  }

  /** The chat an annotation goes to: the composer on screen, or the one last on screen. The review card names it. */
  target = (): { chat?: string; key: string } | undefined =>
    this.disposed ? undefined : this.sink ? { chat: this.sink.chat, key: this.sink.key } : this.last;

  /** The next annotation's number, 1 to 999, counted for as long as this signed-in window lasts. */
  nextAnnotation(): number {
    this.lastAnnotation = (this.lastAnnotation % 999) + 1;
    return this.lastAnnotation;
  }

  /**
   * Stages an annotation Rust has marked (`path`) in the composer on screen, and its `words` at the composer's cursor.
   * It goes only to the chat `to.key` names, which the review card showed (`target`): with that composer off screen, it
   * waits and asks for it to show (`reveal`), and another composer coming first deletes it. Once `to.live` says the
   * annotation was cancelled (the page moved, the Preview went), it is deleted wherever it is. False, with the image
   * deleted, when it was cancelled already.
   */
  async annotate(path: string, words: string, from: { url: string; takenAtMs: number }, to: { key: string; live: () => boolean }): Promise<boolean> {
    if (this.disposed || !to.live()) {
      void this.api.discard(path).catch(() => {});
      return false;
    }
    this.mine.add(path);
    this.annotations.set(path, { ...from, moves: this.pageMoves });
    this.relabel();
    // Revealing the chat re-renders at once, which ends the Preview's overlay: asked on the next task, it comes once
    // the caller has finished adding, so the annotation, queued below first, isn't taken for cancelled.
    if (!this.sink) setTimeout(() => this.reveal?.(), 0);
    await this.deliver({ paths: [path], words, to: to.key, live: to.live });
    return true;
  }

  /** The Preview's page moved (a load, or its own address changing): annotations staged before now are stale. */
  pageMoved() {
    this.pageMoves++;
    if (this.annotations.size) this.relabel();
  }

  /** What each staged annotation's chip says about the page it came from, by path. */
  annotationLabels = (): ReadonlyMap<string, AnnotationLabel> => this.labels;

  private relabel() {
    this.labels = new Map([...this.annotations].map(([p, a]) => [p, { url: a.url, takenAtMs: a.takenAtMs, stale: a.moves !== this.pageMoves }]));
    for (const fn of [...this.listeners]) fn();
  }

  attachTo(sink: ComposerSink): () => void {
    this.sink = sink;
    this.last = { chat: sink.chat, key: sink.key };
    const waiting = this.waiting;
    this.waiting = [];
    for (const w of waiting) void this.deliver(w);
    return () => {
      if (this.sink === sink) this.sink = undefined;
    };
  }

  private async deliver(w: Waiting): Promise<void> {
    const sink = this.sink;
    if (!sink) return void this.waiting.push(w);
    if (sink.key !== w.to || !w.live()) return this.release(w.paths);
    const kept = await sink.check(w.paths);
    if (!w.live()) return this.release(w.paths);
    // The composer went while it checked them (another chat opened, or Settings): try again with the one on screen now,
    // unless signing out already deleted them.
    if (this.sink !== sink) return this.deliver({ ...w, paths: w.paths.filter((p) => this.mine.has(p)) });
    this.change({ kind: "added", key: sink.key, attachments: kept });
    if (kept.length) sink.place?.(kept);
    this.release(w.paths.filter((p) => !kept.some((a) => a.path === p)));
    if (kept.length && w.words) sink.insert?.(w.words);
  }

  /** The attachments staged in the chat whose Draft key is `key`, in the order they were added. */
  stagedIn = (key: string): readonly Attachment[] => this.staged.get(key) ?? NONE;

  change(e: Staging) {
    const now = this.stagedIn(e.key);
    let next: readonly Attachment[];
    let letGo: readonly string[] = [];
    switch (e.kind) {
      case "added":
        if (this.disposed) return this.release(e.attachments.map((a) => a.path));
        next = [...now, ...e.attachments.filter((a) => !now.some((x) => x.path === a.path))];
        // An owned file reaches a second chat only when the owner picks it from the staging folder. It moves here:
        // Rust deletes it once this chat's message no longer needs it, whichever chat still shows it.
        for (const [key, files] of this.staged) {
          const left = files.filter((a) => !(this.mine.has(a.path) && e.attachments.some((x) => x.path === a.path)));
          if (key === e.key || left.length === files.length) continue;
          this.restage(key, left);
        }
        break;
      case "sent":
        next = now.filter((a) => !e.paths.includes(a.path));
        break;
      case "removed":
        next = now.filter((a) => !e.paths.includes(a.path));
        letGo = e.paths;
        break;
      case "gone":
        next = NONE;
        letGo = now.map((a) => a.path);
        this.numbers.delete(e.key);
        break;
    }
    if (next.length === now.length) return this.release(letGo);
    this.restage(e.key, next);
    this.stagedChanged();
    this.release(letGo);
  }

  /**
   * Each staged image's number in the chat's composer, by path: the number its mark there gives (inlineImages.ts). They
   * count up in the order the images were added, for as long as the desk lasts, and past every mark in the chat's
   * Draft (`words`), so a mark that Undo, a restart or a message put back brings back never names another image.
   */
  numbersIn = (key: string): ReadonlyMap<string, number> => this.numbers.get(key)?.of ?? UNNUMBERED;

  /** No staged image in the chat gets a number up to `n`: a mark in its words gives it. */
  reserve(key: string, n: number) {
    const was = this.numbers.get(key) ?? { of: UNNUMBERED, next: 1 };
    if (n >= was.next) this.numbers.set(key, { ...was, next: n + 1 });
  }

  private restage(key: string, files: readonly Attachment[]) {
    const was = this.numbers.get(key) ?? { of: UNNUMBERED, next: 1 };
    if (!files.length) {
      this.staged.delete(key);
      this.numbers.set(key, { of: UNNUMBERED, next: was.next });
      return;
    }
    this.staged.set(key, files);
    let next = Math.max(was.next, highestMark(this.words(key)) + 1);
    const of = new Map(files.flatMap((a) => (a.kind !== "image" ? [] : [[a.path, was.of.get(a.path) ?? next++] as const])));
    this.numbers.set(key, { of, next });
  }

  private stagedChanged() {
    stagedFiles.set(this, [...this.staged.values()].flat());
    for (const fn of [...this.listeners]) fn();
  }

  /**
   * Puts the desk's files sent with a message Hermes didn't confirm back in the chat they were sent from (`key`), so they
   * aren't lost with it; others are deleted. `accepted`: Hermes took the message.
   */
  sent(key: string, attachments: readonly Attachment[], accepted: boolean) {
    const paths = attachments.map((a) => a.path);
    for (const p of paths) this.sending.delete(p);
    if (accepted || this.disposed) return this.release(paths);
    const back = attachments.filter((a) => this.mine.has(a.path));
    if (!back.length) return;
    this.change({ kind: "added", key, attachments: back });
    if (this.sink?.key === key) this.sink.note(RESTORED);
  }

  /** The outbox takes responsibility while sending; no chat holds the files any more, and they stay until it lets go. */
  hold(paths: readonly string[]) {
    for (const p of paths) if (this.mine.has(p)) this.sending.add(p);
  }

  /** Rust has reconciled the outbox; release anything it no longer needs. */
  finish(paths: readonly string[]) {
    for (const p of paths) this.sending.delete(p);
    this.release(paths);
  }

  /**
   * Deletes any of `paths` that are the desk's own files no message is sending. Others are ignored: a file the owner picked from
   * their own folders is never deleted.
   */
  release(paths: readonly string[]) {
    let forgot = false;
    for (const p of paths)
      if (!this.sending.has(p) && this.mine.delete(p)) {
        void this.api.discard(p).catch(() => {});
        forgot = this.annotations.delete(p) || forgot;
      }
    if (forgot) this.relabel();
  }

  dispose() {
    this.disposed = true;
    this.waiting = [];
    this.staged.clear();
    this.numbers.clear();
    this.stagedChanged();
    this.release([...this.mine]);
  }
}
