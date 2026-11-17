// A message's images go where its marks put them: the composer's numbers become each image's place among those sent,
// and a stored message's marks place its `@image:` lines, read back in the order Hermes stored them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { peelImages } from "./branch";
import { localChatCache } from "./chatCache";
import { FakeHermes, row } from "./fakeHermes";
import { carried, markText, placeImages, sentText, withMarks } from "./inlineImages";
import type { Attachment } from "./model";
import { sentImage } from "./sentImages";
import { connect } from "./transport";

const image = (path: string, name = "image.png"): Attachment => ({ path, name, size: 10, kind: "image" });
const file = (path: string, name: string): Attachment => ({ path, name, size: 10, kind: "file" });
const shot = (path: string) => sentImage(path)!;

describe("withMarks", () => {
  it("puts marks at the cursor a space from the words beside them, and says where the cursor goes after them", () => {
    expect(withMarks("look here please", 10, ["[image 2: a.png]"])).toEqual({ text: "look here [image 2: a.png] please", end: 27 });
    expect(withMarks("look", 4, ["[image 2: a.png]", "[image 3: b.png]"])).toEqual({ text: "look [image 2: a.png] [image 3: b.png]", end: 38 });
    expect(withMarks("line one\n", 9, ["[image 2: a.png]"]).text).toBe("line one\n[image 2: a.png]");
  });
});

describe("markText", () => {
  it("keeps a name with brackets or line breaks from ending the mark or the line", () => {
    expect(markText(2, "a]b[c\nd.png")).toBe("[image 2: a_b_c_d.png]");
    expect(placeImages(markText(1000, "late.png"), []).pieces).toEqual(["[image 1000: late.png]"]);
    expect(sentText(markText(1000, "late.png"), [image("/s/k.png", "late.png")], new Map([["/s/k.png", 1000]]))).toBe("[image 1: late.png]");
  });
});

describe("sentText", () => {
  it("numbers each mark by its image's place among the images sent, files not counted", () => {
    const staged = [image("/s/1.png", "first.png"), file("/s/notes.txt", "notes.txt"), image("/s/5.png", "image.png"), image("/s/4.png", "image.png")];
    const numbers = new Map([["/s/1.png", 1], ["/s/5.png", 5], ["/s/4.png", 4]]);
    expect(sentText("see [image 4: image.png] then\n[image 5: image.png] end", staged, numbers)).toBe("see [image 3: image.png] then\n[image 2: image.png] end");
  });

  it("drops a mark whose image is no longer staged, and a second mark for one image, leaving the words around them", () => {
    const staged = [image("/s/1.png"), image("/s/2.png", "b.png")];
    const numbers = new Map([["/s/1.png", 1], ["/s/2.png", 2]]);
    expect(sentText("a [image 7: gone.png] b [image 2: b.png] c [image 2: b.png]", staged, numbers)).toBe("a b [image 2: b.png] c ");
  });
});

describe("placeImages", () => {
  const images = [shot("/h/images/u1.png"), shot("/h/images/u2.png"), shot("/h/images/u3.png")];

  it("places each marked image where its mark is and keeps the rest above the words", () => {
    expect(placeImages("before [image 3: c.png] after", images)).toEqual({
      above: [images[0], images[1]],
      pieces: ["before ", { image: images[2], name: "c.png" }, " after"],
    });
  });

  it("shows every image above words without marks, as before", () => {
    expect(placeImages("just words", images)).toEqual({ above: images, pieces: ["just words"] });
  });

  it("leaves as words a mark for an image the message doesn't have, or a second mark for one it placed", () => {
    expect(placeImages("[image 9: x.png] [image 2: b.png][image 2: b.png]", images)).toEqual({
      above: [images[0], images[2]],
      pieces: ["[image 9: x.png] ", { image: images[1], name: "b.png" }, "[image 2: b.png]"],
    });
  });

  it("reads a stored message's marks against its @image lines, in the order Hermes stored them", () => {
    const stored = "two shots: [image 2: second.png] here\n@image:/h/images/u1.png\n@image:/h/images/u2.png";
    const { rest, images: back } = peelImages(stored);
    expect(placeImages(rest, back)).toEqual({ above: [shot("/h/images/u1.png")], pieces: ["two shots: ", { image: shot("/h/images/u2.png"), name: "second.png" }, " here"] });
  });
});

describe("carried", () => {
  it("keeps a place where it was in the words through edits before it, after it, at it, and over it", () => {
    expect(carried(5, "hello world", "oh hello world")).toBe(8);
    expect(carried(5, "hello world", "hello world!!")).toBe(5);
    expect(carried(5, "hello world", "hello, world")).toBe(5);
    expect(carried(7, "hello world", "hello there")).toBe(11);
    expect(carried(7, "hello world", "help")).toBe(4);
  });

  it("follows an edit in repeated words from where it began", () => {
    expect(carried(2, "aaa!", "aaaa!", 0)).toBe(3);
    expect(carried(2, "aaa!", "aaaa!", 3)).toBe(2);
    expect(carried(2, "aaaa!", "aaa!", 0)).toBe(1);
  });
});

describe("A message's marks on the way to Hermes and back", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  const nas = { mode: "ssh" as const, sshTarget: "lena@hermes", url: "", username: "lena" };
  const placedIn = (hermes: Awaited<ReturnType<typeof connect>>) => {
    const sent = hermes.getSnapshot().chats.find((c) => c.id === "c1")!.items.find((i) => i.kind === "user")!;
    if (sent.kind !== "user") throw new Error("no message");
    return placeImages(sent.text, sent.images ?? []);
  };

  it("keeps each image where its mark is through a failed send, Retry, the Saved copy and the history Hermes stored", async () => {
    const server = new FakeHermes();
    server.sessions = [row("c1", 0)];
    server.files = { "/home/lena/a/image.png": "\x89PNG top", "/home/lena/b/image.png": "\x89PNG marked" };
    const hermes = await connect(server.openPipe, undefined, localChatCache(nas));
    await hermes.sync();
    await hermes.open("c1");
    const { attachments } = await hermes.checkAttachments(["/home/lena/a/image.png", "/home/lena/b/image.png"]);
    const text = "before [image 2: image.png]\nafter";
    const submit = server.handlers["prompt.submit"];
    server.handlers["prompt.submit"] = (r) => server.fail(r.id, 5000, "Hermes is busy");
    await hermes.send("c1", text, attachments);
    await hermes.idle();
    server.handlers["prompt.submit"] = submit;
    const failed = hermes.getSnapshot().chats.find((c) => c.id === "c1")!.items.find((i) => i.kind === "user")!;
    await hermes.retry("c1", failed.id);
    await hermes.idle();

    const submits = server.requests.filter((r) => r.method === "prompt.submit").map((r) => r.params.text);
    expect(submits).toEqual([text, text]);
    const uploads = server.requests.filter((r) => r.method === "image.attach_bytes").map((r) => r.params.content_base64);
    expect(uploads.slice(-2)).toEqual([btoa("\x89PNG top"), btoa("\x89PNG marked")]);
    const sent = placedIn(hermes);
    expect(sent.pieces).toEqual(["before ", { image: expect.objectContaining({ path: expect.stringMatching(/\/images\//) }), name: "image.png" }, "\nafter"]);
    expect(sent.above).toHaveLength(1);
    const [topPath, markedPath] = [sent.above[0].path, (sent.pieces[1] as { image: { path: string } }).image.path];
    expect(server.serverFiles[markedPath]).toBe("\x89PNG marked");
    expect(server.serverFiles[topPath]).toBe("\x89PNG top");
    await hermes.close();

    for (const cache of [localChatCache(nas), localChatCache({ ...nas, sshTarget: "lena@elsewhere" })]) {
      const relaunched = await connect(server.openPipe, undefined, cache);
      await relaunched.sync();
      await relaunched.open("c1");
      await relaunched.idle();
      const back = placedIn(relaunched);
      expect(back.above.map((i) => i.path)).toEqual([topPath]);
      expect(back.pieces).toEqual(["before ", { image: expect.objectContaining({ path: markedPath }), name: "image.png" }, "\nafter"]);
      await relaunched.close();
    }
  });
});
