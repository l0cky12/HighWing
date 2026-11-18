// The staging desk: each chat keeps its staged files, an annotation goes only to its own chat's composer (or waits for
// it), and every file the desk staged is deleted once nothing needs it.
import { describe, expect, it, vi } from "vitest";
import type { Attachment } from "./model";
import { ScreenshotDesk, type ScreenshotApi, type ScreenshotSink } from "./screenshots";
import { stagedFiles } from "./unsaved";

/** A Rust side that records what it was asked to delete. */
function fakeApi() {
  const discarded: string[] = [];
  const api: ScreenshotApi = { discard: async (path) => void discarded.push(path) };
  return { api, discarded };
}

const file = (path: string): Attachment => ({ path, name: path.split("/").pop()!, size: 10, kind: "image" });
const tick = () => new Promise((r) => setTimeout(r, 0));
const page = { url: "http://x.example/", takenAtMs: 1 };

/** A composer on the chat whose Draft key is `key`. `attached`: the files it was asked to check. */
function sink(keep: (paths: string[]) => string[] = (p) => p, key = "chat-a") {
  const attached: string[][] = [];
  const notes: string[] = [];
  const s: ScreenshotSink = { key, check: async (paths) => (attached.push(paths), keep(paths).map(file)), note: (t) => void notes.push(t) };
  return { s, attached, notes };
}

describe("Staging desk", () => {
  it("deletes a pasted file once it is sent, held while its message is in the outbox, and at once after signing out", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    const pasted = "/home/lena/.cache/hermes-chat/captures/1/0/clipboard.png";
    desk.own([pasted]);
    desk.hold([pasted]);
    desk.release([pasted]);
    desk.dispose();
    await tick();
    expect(rust.discarded).toEqual([]);
    desk.sent("chat-a", [{ path: pasted, name: "clipboard.png", size: 1, kind: "image" }], true);
    desk.own(["/home/lena/.cache/hermes-chat/captures/1/1/late.png"]);
    await tick();
    expect(rust.discarded).toEqual([pasted, "/home/lena/.cache/hermes-chat/captures/1/1/late.png"]);
  });

  it("deletes a pasted file once the owner removes it, and never one the owner picked from their folders", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    const pasted = "/run/user/1000/hermes-chat/captures/1/0/clipboard.png";
    desk.own([pasted]);
    desk.change({ kind: "added", key: "chat-a", attachments: [file(pasted), file("/home/lena/Pictures/rack.png")] });
    desk.change({ kind: "removed", key: "chat-a", paths: ["/home/lena/Pictures/rack.png", pasted] });
    desk.change({ kind: "removed", key: "chat-a", paths: [pasted] });
    await tick();
    expect(desk.stagedIn("chat-a")).toEqual([]);
    expect(rust.discarded).toEqual([pasted]);
  });

  it("puts pasted files back in the chat they were sent from when Hermes didn't confirm the message, and deletes them once it did", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    const composer = sink();
    desk.attachTo(composer.s);
    desk.own(["/c/1/0/a.png"]);
    desk.change({ kind: "added", key: "chat-a", attachments: [file("/c/1/0/a.png")] });
    const sending = [file("/c/1/0/a.png"), file("/home/lena/rack.png")];
    desk.hold(["/c/1/0/a.png"]);
    desk.change({ kind: "sent", key: "chat-a", paths: ["/c/1/0/a.png"] });
    expect(desk.stagedIn("chat-a")).toEqual([]);

    desk.sent("chat-a", sending, false);
    await tick();
    expect(desk.stagedIn("chat-a").map((a) => a.path)).toEqual(["/c/1/0/a.png"]);
    expect(composer.notes).toEqual(["Hermes didn't confirm it got your message, so its files are back here. Send them again, or remove them."]);
    expect(rust.discarded).toEqual([]);

    desk.hold(["/c/1/0/a.png"]);
    desk.change({ kind: "sent", key: "chat-a", paths: ["/c/1/0/a.png"] });
    desk.sent("chat-a", [file("/c/1/0/a.png")], true);
    await tick();
    expect(rust.discarded).toEqual(["/c/1/0/a.png"]);
  });

  it("keeps a file its message is sending after signing out, then releases it after outbox reconciliation", () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    desk.own(["/c/1/0/a.png"]);
    desk.hold(["/c/1/0/a.png"]);
    desk.release(["/c/1/0/a.png"]);
    desk.dispose();
    expect(rust.discarded).toEqual([]);
    desk.finish(["/c/1/0/a.png"]);
    expect(rust.discarded).toEqual(["/c/1/0/a.png"]);
  });
});

describe("Each chat's staged attachments", () => {
  it("keeps each chat's files apart, lists them all for Settings, and deletes a chat's own once it goes", async () => {
    const rust = fakeApi();
    // Desks of the tests above that never signed out still list theirs.
    const others = stagedFiles.getSnapshot();
    const desk = new ScreenshotDesk(rust.api);
    desk.own(["/c/1/0/a.png", "/c/1/1/b.png"]);
    desk.change({ kind: "added", key: "chat-a", attachments: [file("/c/1/0/a.png"), file("/home/lena/notes.txt")] });
    desk.change({ kind: "added", key: "chat-b", attachments: [file("/c/1/1/b.png")] });
    desk.change({ kind: "added", key: "chat-a", attachments: [file("/c/1/0/a.png")] });
    expect(desk.stagedIn("chat-a").map((a) => a.name)).toEqual(["a.png", "notes.txt"]);
    expect(desk.stagedIn("chat-b").map((a) => a.name)).toEqual(["b.png"]);
    expect(stagedFiles.getSnapshot()).toEqual([...others, "a.png", "notes.txt", "b.png"]);

    desk.change({ kind: "gone", key: "chat-a" });
    await tick();
    expect(desk.stagedIn("chat-a")).toEqual([]);
    expect(rust.discarded).toEqual(["/c/1/0/a.png"]);
    expect(stagedFiles.getSnapshot()).toEqual([...others, "b.png"]);

    desk.dispose();
    await tick();
    expect(rust.discarded).toEqual(["/c/1/0/a.png", "/c/1/1/b.png"]);
    expect(stagedFiles.getSnapshot()).toEqual(others);
  });

  it("stages a file it owns in one chat at a time, and one the owner picked from their folders in any", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    desk.own(["/c/1/0/a.png"]);
    desk.change({ kind: "added", key: "chat-a", attachments: [file("/c/1/0/a.png"), file("/home/lena/notes.txt")] });
    desk.change({ kind: "added", key: "chat-b", attachments: [file("/c/1/0/a.png"), file("/home/lena/notes.txt")] });
    expect(desk.stagedIn("chat-a").map((a) => a.path)).toEqual(["/home/lena/notes.txt"]);
    expect(desk.stagedIn("chat-b").map((a) => a.path)).toEqual(["/c/1/0/a.png", "/home/lena/notes.txt"]);
    desk.change({ kind: "removed", key: "chat-b", paths: ["/c/1/0/a.png"] });
    await tick();
    expect(rust.discarded).toEqual(["/c/1/0/a.png"]);
  });

  it("numbers each chat's staged images as they are added, files not counted, and never gives a number twice", () => {
    const desk = new ScreenshotDesk(fakeApi().api);
    const notes: Attachment = { path: "/home/lena/notes.txt", name: "notes.txt", size: 3, kind: "file" };
    desk.change({ kind: "added", key: "chat-a", attachments: [file("/c/a.png"), notes, file("/c/b.png")] });
    desk.change({ kind: "added", key: "chat-b", attachments: [file("/c/x.png")] });
    expect([...desk.numbersIn("chat-a")]).toEqual([["/c/a.png", 1], ["/c/b.png", 2]]);
    expect([...desk.numbersIn("chat-b")]).toEqual([["/c/x.png", 1]]);
    desk.change({ kind: "removed", key: "chat-a", paths: ["/c/b.png"] });
    desk.change({ kind: "added", key: "chat-a", attachments: [file("/c/c.png")] });
    expect([...desk.numbersIn("chat-a")]).toEqual([["/c/a.png", 1], ["/c/c.png", 3]]);
    // Undo can still bring back a mark for one that went with a message.
    desk.change({ kind: "sent", key: "chat-a", paths: ["/c/a.png", "/c/c.png", notes.path] });
    desk.change({ kind: "added", key: "chat-a", attachments: [file("/c/d.png")] });
    expect([...desk.numbersIn("chat-a")]).toEqual([["/c/d.png", 4]]);
  });

  it("numbers past every mark in the chat's Draft, so a mark kept from before a restart names no new image", () => {
    const words: Record<string, string> = { "chat-a": "see [image 2: old.png] and [image 7: older.png]" };
    const desk = new ScreenshotDesk(fakeApi().api, undefined, (key) => words[key] ?? "");
    desk.change({ kind: "added", key: "chat-a", attachments: [file("/c/new.png")] });
    desk.change({ kind: "added", key: "chat-b", attachments: [file("/c/other.png")] });
    expect([...desk.numbersIn("chat-a")]).toEqual([["/c/new.png", 8]]);
    expect([...desk.numbersIn("chat-b")]).toEqual([["/c/other.png", 1]]);
    // The owner deletes the old marks; Undo could bring them back, so their numbers stay taken.
    desk.reserve("chat-b", 7);
    words["chat-b"] = "";
    desk.change({ kind: "added", key: "chat-b", attachments: [file("/c/later.png")] });
    expect(desk.numbersIn("chat-b").get("/c/later.png")).toBe(8);
  });

  it("tells the composer that checked an annotation once it is staged, and deletes one the composer refused", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    const placed: string[][] = [];
    const { s } = sink((p) => p.filter((x) => !x.includes("huge")));
    desk.attachTo({ ...s, place: (staged) => void placed.push(staged.map((a) => a.path)) });
    const to = { key: "chat-a", live: () => true };
    await desk.annotate("/c/0/annotation-1.png", "", page, to);
    await desk.annotate("/c/1/huge.png", "", page, to);
    await tick();
    expect(placed).toEqual([["/c/0/annotation-1.png"]]);
    expect([...desk.numbersIn("chat-a")]).toEqual([["/c/0/annotation-1.png", 1]]);
    expect(rust.discarded).toEqual(["/c/1/huge.png"]);
  });

  it("deletes a file staged after signing out", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    desk.own(["/c/1/0/a.png"]);
    desk.dispose();
    await tick();
    expect(rust.discarded).toEqual(["/c/1/0/a.png"]);
    desk.change({ kind: "added", key: "chat-a", attachments: [file("/c/1/0/late.png")] });
    expect(desk.stagedIn("chat-a")).toEqual([]);
  });
});

describe("Annotations on the desk (ADR 0094)", () => {
  it("stages an annotation in the composer on screen with its words, labels it stale once the page moves, and forgets it when removed", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    const inserted: string[] = [];
    const { s, attached } = sink();
    desk.attachTo({ ...s, chat: "Fix the app", insert: (t) => void inserted.push(t) });
    expect(desk.target()).toEqual({ chat: "Fix the app", key: "chat-a" });
    expect([desk.nextAnnotation(), desk.nextAnnotation()]).toEqual([1, 2]);

    const path = "/c/1/4/annotation-2.png";
    expect(await desk.annotate(path, "Annotation 2. …", { url: "http://localhost:5173/", takenAtMs: 5 }, { key: "chat-a", live: () => true })).toBe(true);
    expect(attached).toEqual([[path]]);
    expect(inserted).toEqual(["Annotation 2. …"]);
    expect(desk.stagedIn("chat-a").map((a) => a.path)).toEqual([path]);
    expect(desk.annotationLabels().get(path)).toEqual({ url: "http://localhost:5173/", takenAtMs: 5, stale: false });

    desk.pageMoved();
    expect(desk.annotationLabels().get(path)?.stale).toBe(true);

    desk.change({ kind: "removed", key: "chat-a", paths: [path] });
    await tick();
    expect(rust.discarded).toEqual([path]);
    expect(desk.annotationLabels().size).toBe(0);
  });

  it("sends an annotation to the composer last on screen when a covering Preview hides it, and asks for it to show", async () => {
    const rust = fakeApi();
    const reveal = vi.fn();
    const desk = new ScreenshotDesk(rust.api, reveal);
    const inserted: string[] = [];
    const { s } = sink();
    const stop = desk.attachTo({ ...s, chat: "Fix the app", insert: (t) => void inserted.push(t) });
    stop();
    expect(desk.target()).toEqual({ chat: "Fix the app", key: "chat-a" });

    const path = "/c/1/6/annotation-1.png";
    expect(await desk.annotate(path, "Annotation 1.", { url: "http://x.example/", takenAtMs: 1 }, { key: "chat-a", live: () => true })).toBe(true);
    await tick();
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(inserted).toEqual([]);
    desk.attachTo({ ...s, chat: "Fix the app", insert: (t) => void inserted.push(t) });
    await tick();
    expect(inserted).toEqual(["Annotation 1."]);
    expect(desk.stagedIn("chat-a").map((a) => a.path)).toEqual([path]);
    expect(rust.discarded).toEqual([]);
  });

  it("never puts an annotation in another chat's composer: one that comes first deletes it", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api, () => {});
    const a = sink(undefined, "chat-a");
    desk.attachTo({ ...a.s, chat: "Fix the app" })();
    const path = "/c/1/7/annotation-1.png";
    await desk.annotate(path, "Annotation 1.", { url: "http://x.example/", takenAtMs: 1 }, { key: "chat-a", live: () => true });
    const inserted: string[] = [];
    const b = sink(undefined, "chat-b");
    desk.attachTo({ ...b.s, chat: "Other profile's chat", insert: (t) => void inserted.push(t) });
    await tick();
    expect(b.attached).toEqual([]);
    expect(inserted).toEqual([]);
    expect(desk.stagedIn("chat-b")).toEqual([]);
    expect(rust.discarded).toEqual([path]);
    expect(desk.annotationLabels().size).toBe(0);
  });

  it("deletes an annotation cancelled before it reached its composer, even while that composer checked it", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    let live = true;
    let checked!: () => void;
    const inserted: string[] = [];
    desk.attachTo({
      key: "chat-a",
      check: (paths) => new Promise((r) => (checked = () => r(paths.map(file)))),
      note: () => {},
      insert: (t) => void inserted.push(t),
    });
    const adding = desk.annotate("/c/1/8/annotation-1.png", "words", { url: "http://x.example/", takenAtMs: 1 }, { key: "chat-a", live: () => live });
    live = false;
    checked();
    await adding;
    await tick();
    expect(inserted).toEqual([]);
    expect(desk.stagedIn("chat-a")).toEqual([]);
    expect(rust.discarded).toEqual(["/c/1/8/annotation-1.png"]);
  });

  it("reveals a covered chat only once its annotation is handed over, since revealing it ends the Preview's overlay", async () => {
    const rust = fakeApi();
    const inserted: string[] = [];
    const { s } = sink();
    let added = false;
    let overlay = true;
    // As in the app: revealing renders at once, which unmounts the overlay and attaches the chat's composer.
    const desk: ScreenshotDesk = new ScreenshotDesk(rust.api, () => {
      overlay = false;
      desk.attachTo({ ...s, insert: (t) => void inserted.push(t) });
    });
    desk.attachTo(s)();
    const path = "/c/1/9/annotation-1.png";
    await desk.annotate(path, "words", { url: "http://x.example/", takenAtMs: 1 }, { key: "chat-a", live: () => added || overlay });
    added = true;
    await new Promise((r) => setTimeout(r, 5));
    expect(inserted).toEqual(["words"]);
    expect(desk.stagedIn("chat-a").map((a) => a.path)).toEqual([path]);
    expect(rust.discarded).toEqual([]);
  });

  it("still delivers an annotation when its composer re-attaches while it is being checked, as a revealed chat's does", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    let checked!: () => void;
    const stop = desk.attachTo({ key: "chat-a", check: (paths) => new Promise((r) => (checked = () => r(paths.map(file)))), note: () => {} });
    const path = "/c/1/9/annotation-1.png";
    const adding = desk.annotate(path, "words", { url: "http://x.example/", takenAtMs: 1 }, { key: "chat-a", live: () => true });
    stop();
    const inserted: string[] = [];
    const { s } = sink(undefined, "chat-a");
    checked();
    await adding;
    desk.attachTo({ ...s, insert: (t) => void inserted.push(t) });
    await tick();
    expect(inserted).toEqual(["words"]);
    expect(desk.stagedIn("chat-a").map((a) => a.path)).toEqual([path]);
    expect(rust.discarded).toEqual([]);
  });

  it("deletes an annotation at once when it was cancelled before it was handed over", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    expect(desk.target()).toBeUndefined();
    expect(await desk.annotate("/c/1/5/annotation-1.png", "words", { url: "http://x.example/", takenAtMs: 1 }, { key: "chat-a", live: () => false })).toBe(false);
    await tick();
    expect(rust.discarded).toEqual(["/c/1/5/annotation-1.png"]);
    expect(desk.stagedIn("chat-a")).toEqual([]);
  });
});
