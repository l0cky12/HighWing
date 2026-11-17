// An image sent with a message is known only by where Hermes stored it: read from Hermes's answer, from the stored
// message's last lines, and from a kept Saved copy or outbox row. Only a full server path to an image file ever counts,
// and only the ones Hermes's answer named while this app sent them are read without the owner asking.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedSignIn } from "./account";
import { peelImages, typedText } from "./branch";
import { localChatCache } from "./chatCache";
import { FakeHermes, row } from "./fakeHermes";
import type { Item, OutgoingItem, SentImage } from "./model";
import type { FileView } from "./preview";
import { forgetConnectionLocally, forgetProfileLocally, renameProfileLocally } from "./profileLocalData";
import { SENT_HERE_KEPT, SentImageStore, sentHereOf, sentImage, sentNames, sentWith, withSentHere } from "./sentImages";
import { connect } from "./transport";

const shot = (path: string, name?: string) => sentImage(path, name)!;

describe("sentImage", () => {
  it("takes a full path on the server to an image file, with the name it had here", () => {
    expect(sentImage("/home/lena/.hermes/images/upload_1.png", "clipboard.png")).toEqual({ path: "/home/lena/.hermes/images/upload_1.png", name: "clipboard.png" });
    expect(sentImage("/srv/a b/images/photo.JPEG")).toEqual({ path: "/srv/a b/images/photo.JPEG" });
    for (const ext of ["jpg", "gif", "webp", "bmp"]) expect(sentImage(`/x/images/y.${ext}`)?.path).toBe(`/x/images/y.${ext}`);
  });

  it.each([
    ["a web address", "https://example.com/cat.png"],
    ["a protocol-relative address", "//example.com/cat.png"],
    ["a relative path", "images/upload_1.png"],
    ["a path under ~", "~/Pictures/cat.png"],
    ["a Windows path", "C:\\Users\\lena\\cat.png"],
    ["a file that isn't an image", "/home/lena/.hermes/images/id_rsa"],
    ["an SVG", "/srv/images/logo.svg"],
    ["a NUL byte", "/srv/cat\0.png"],
  ])("refuses %s", (_, path) => {
    expect(sentImage(path)).toBeUndefined();
  });

  it("takes only an image in a folder named images, where Hermes keeps the images it is sent", () => {
    for (const path of ["/home/u/.hermes/images/upload_ab12.png", "/home/u/.hermes/cache/images/clip.png"]) expect(sentImage(path)).toEqual({ path });
  });

  it.each([
    ["any other file on the server", "/private/payroll.png"],
    ["a way out of the images folder", "/a/images/../secret.png"],
    ["an empty part", "/a//images/x.png"],
    ["a part that is a dot", "/a/./images/x.png"],
    ["an image in a folder inside images", "/a/images/b/x.png"],
  ])("refuses %s", (_, path) => {
    expect(sentImage(path)).toBeUndefined();
  });

  it("refuses what isn't a string, and drops a name that isn't one", () => {
    expect(sentImage(undefined)).toBeUndefined();
    expect(sentImage({ path: "/a.png" })).toBeUndefined();
    expect(sentImage("/h/images/a.png", 7)).toEqual({ path: "/h/images/a.png" });
  });
});

describe("peelImages", () => {
  it("takes Hermes's @image: line off a stored message", () => {
    expect(peelImages("Here is the error page\n@image:/hermes/images/upload_1.png")).toEqual({ rest: "Here is the error page", images: [shot("/hermes/images/upload_1.png")] });
  });

  it("takes every image, in the order sent, quoted or not", () => {
    const stored = "Two shots\n\n@image:/i/images/one.png\n@image:`/i/images/two words.png`\n@image:\"/i/images/it's.jpg\"\n@image:'/i/images/say \"hi\".gif'";
    expect(peelImages(stored)).toEqual({ rest: "Two shots", images: ["/i/images/one.png", "/i/images/two words.png", "/i/images/it's.jpg", '/i/images/say "hi".gif'].map((p) => shot(p)) });
  });

  it("finds the images after the attached context, which typedText then takes off", () => {
    const stored = "Look at this\n\n--- Attached Context ---\n\n## notes.txt\nThe router rebooted.\n@image:/i/images/one.png";
    const { rest, images } = peelImages(stored);
    expect(images).toEqual([shot("/i/images/one.png")]);
    expect(typedText(rest)).toBe("Look at this");
  });

  it("takes the older hint and the placeholders with it", () => {
    expect(peelImages("What do you see in this image?\n\n[Image attached at: /i/images/upload_x.png]\n[image]")).toEqual({ rest: "What do you see in this image?", images: [shot("/i/images/upload_x.png")] });
    expect(peelImages("Shot\n@image:/i/images/a.png\n[screenshot detail=high]")).toEqual({ rest: "Shot", images: [shot("/i/images/a.png")] });
  });

  it("leaves the message as it was when any image line names a path it won't read", () => {
    for (const stored of ["Shot\n@image:/i/images/a.png\n@image:https://example.com/b.png", "Shot\n@image:~/.ssh/id_rsa", "Shot\n@image:notes.txt", "Shot\n@image:/private/payroll.png", "Shot\n[Image attached at: C:\\shots\\a.png]"])
      expect(peelImages(stored)).toEqual({ rest: stored, images: [] });
  });

  it("leaves a message without image lines as it was, placeholders and all", () => {
    for (const stored of ["Just words", "Words\n[image]", "@image:/i/images/a.png is what I sent\nthen more", ""]) expect(peelImages(stored)).toEqual({ rest: stored, images: [] });
  });
});

describe("sentWith", () => {
  const a = shot("/i/images/upload_1.png", "clipboard.png");
  const user = (over: Partial<Extract<Item, { kind: "user" }>>) => ({ kind: "user" as const, id: "u1", text: "Hi", ...over });

  it("shows each image Hermes has in place of its name, and every other file by name", () => {
    expect(sentWith(user({ attachments: ["clipboard.png", "notes.txt"], images: [a] }))).toEqual({ images: [a], chips: ["notes.txt"] });
  });

  it("drops one name for each image, so a second file of the same name keeps its chip", () => {
    expect(sentWith(user({ attachments: ["clipboard.png", "clipboard.png"], images: [a] })).chips).toEqual(["clipboard.png"]);
  });

  it("shows names only until Hermes has the images, and when it didn't take the message", () => {
    expect(sentWith(user({ attachments: ["clipboard.png"] }))).toEqual({ images: [], chips: ["clipboard.png"] });
    expect(sentWith(user({ attachments: ["clipboard.png"], images: [a], outgoing: { state: "failed" } }))).toEqual({ images: [], chips: ["clipboard.png"] });
  });

  it("shows a message read back, which has no names, by its images alone", () => {
    expect(sentWith(user({ images: [shot("/i/images/upload_2.png")] }))).toEqual({ images: [shot("/i/images/upload_2.png")], chips: [] });
  });
});

describe("sentNames", () => {
  it("names each file sent here, and each image read back by the last part of its path", () => {
    const live = { attachments: ["clipboard.png", "notes.txt"], images: [shot("/i/images/upload_1.png", "clipboard.png")] };
    expect(sentNames(live)).toEqual(["clipboard.png", "notes.txt"]);
    expect(sentNames({ images: [shot("/i/images/upload_2.png"), shot("/i/images/upload_3.jpg")] })).toEqual(["upload_2.png", "upload_3.jpg"]);
    expect(sentNames({})).toEqual([]);
  });
});

describe("SentImageStore", () => {
  const png = "/i/images/a.png" as SentImage["path"];
  const image = (src = "data:image/png;base64,AA"): FileView => ({ kind: "image", src });
  const allSentHere = () => true;
  const reader = (answer: (path: string) => Promise<FileView>) => {
    const reads: string[] = [];
    return { reads, read: (path: string) => (reads.push(path), answer(path)) };
  };
  const turn = () => new Promise((r) => setTimeout(r, 0));

  it("reads an image once however many ask, and has it at once after", async () => {
    const r = reader(async () => image());
    const store = new SentImageStore(r.read, allSentHere);
    const both = await Promise.all([store.load(png, "c1"), store.load(png, "c1")]);
    expect(both).toEqual([{ state: "shown", src: "data:image/png;base64,AA" }, { state: "shown", src: "data:image/png;base64,AA" }]);
    expect(store.look(png, "c1")).toEqual({ state: "shown", src: "data:image/png;base64,AA" });
    expect(r.reads).toEqual([png]);
  });

  it("says why it couldn't, naming the dashboard's machine, and reads again when asked again", async () => {
    let n = 0;
    const r = reader(() => (n++ ? Promise.resolve({ kind: "unsupported", reason: "This file isn't an image." }) : Promise.reject(new Error("There's no file at this path on the dashboard's machine."))));
    const store = new SentImageStore(r.read, allSentHere);
    expect(await store.load(png, "c1")).toEqual({ state: "failed", why: "Couldn't read it from the dashboard's machine. There's no file at this path on the dashboard's machine." });
    expect(await store.load(png, "c1")).toEqual({ state: "failed", why: "This file isn't an image." });
    expect(store.look(png, "c1")).toEqual({ state: "loading" });
  });

  it("reads by itself only an image this app sent in that chat, and any other only once the owner asks", async () => {
    const r = reader(async () => image());
    const store = new SentImageStore(r.read, (chat, path) => chat === "c1" && path === png);
    const planted = "/i/images/planted.png" as SentImage["path"];
    expect(store.look(planted, "c1")).toEqual({ state: "ask" });
    expect(await store.load(planted, "c1")).toEqual({ state: "ask" });
    expect(await store.load(png, "c2"), "sent here, but in another chat").toEqual({ state: "ask" });
    expect(await store.load(png, undefined), "outside a chat").toEqual({ state: "ask" });
    expect(r.reads, "nothing read before the owner asks").toEqual([]);

    expect(await store.load(png, "c1")).toEqual({ state: "shown", src: "data:image/png;base64,AA" });
    expect(await store.load(planted, "c1", true)).toEqual({ state: "shown", src: "data:image/png;base64,AA" });
    expect(r.reads).toEqual([png, planted]);
  });

  it("reads at most three images at once, and the rest in the order asked, as each read ends either way", async () => {
    const answers = new Map<string, { ok: (v: FileView) => void; fail: (e: Error) => void }>();
    const r = reader((path) => new Promise((ok, fail) => answers.set(path, { ok, fail })));
    const store = new SentImageStore(r.read, allSentHere);
    const paths = [1, 2, 3, 4, 5].map((n) => `/i/images/${n}.png` as SentImage["path"]);
    const loads = paths.map((p) => store.load(p, "c1"));
    await turn();
    expect(r.reads).toEqual(paths.slice(0, 3));

    answers.get(paths[1])!.ok(image());
    await turn();
    expect(r.reads).toEqual(paths.slice(0, 4));
    answers.get(paths[0])!.fail(new Error("Not connected to Hermes."));
    await turn();
    expect(r.reads).toEqual(paths);

    for (const p of paths.slice(2)) answers.get(p)!.ok(image());
    expect((await Promise.all(loads)).map((l) => l.state)).toEqual(["failed", "shown", "shown", "shown", "shown"]);
  });

  it("lets the least recently shown images go past its budget", async () => {
    const store = new SentImageStore(async (path) => image(`data:image/png;base64,${path}`), allSentHere, 80);
    const [one, two, three] = ["/i/images/1.png", "/i/images/2.png", "/i/images/3.png"] as SentImage["path"][];
    await store.load(one, "c");
    await store.load(two, "c");
    store.look(one, "c");
    await store.load(three, "c");
    expect([one, two, three].map((p) => store.look(p, "c").state)).toEqual(["shown", "loading", "shown"]);
  });
});

/** A localStorage of this test's own. */
function memoryStorage() {
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
}

describe("The images this app sent", () => {
  const nas: SavedSignIn = { mode: "ssh", sshTarget: "lena@hermes", url: "", username: "lena" };
  beforeEach(memoryStorage);
  afterEach(() => vi.unstubAllGlobals());

  it("are read back only as image paths sent in a chat", () => {
    const kept = [
      { chat: "c1", path: "/i/images/a.png" },
      { chat: "", path: "/i/images/b.png" },
      { chat: 7, path: "/i/images/c.png" },
      { chat: "c1", path: "/home/lena/.ssh/id_rsa" },
      { chat: "c1", path: "/private/payroll.png" },
      ["c1", "/i/images/d.png"],
      null,
    ];
    expect(sentHereOf(kept)).toEqual([{ chat: "c1", path: "/i/images/a.png" }]);
    expect(sentHereOf({ chat: "c1", path: "/i/images/a.png" })).toEqual([]);
  });

  it(`keep the newest ${SENT_HERE_KEPT}, each once`, () => {
    let kept = withSentHere([], "c1", []);
    for (let i = 0; i < SENT_HERE_KEPT + 5; i++) kept = withSentHere(kept, "c1", [shot(`/i/images/${i}.png`)]);
    expect(kept).toHaveLength(SENT_HERE_KEPT);
    expect(kept[0]).toEqual({ chat: "c1", path: "/i/images/5.png" });
    const again = withSentHere(kept, "c1", [shot("/i/images/5.png")]);
    expect(again).toHaveLength(SENT_HERE_KEPT);
    expect(again.at(-1)).toEqual({ chat: "c1", path: "/i/images/5.png" });
    expect(withSentHere(again, "c2", [shot("/i/images/5.png")]).slice(-2)).toEqual([
      { chat: "c1", path: "/i/images/5.png" },
      { chat: "c2", path: "/i/images/5.png" },
    ]);
  });

  it("are kept per connection and profile, and move or go with the profile and the connection", async () => {
    localChatCache(nas).saveSentHere("default", "c1", [shot("/i/images/a.png", "clipboard.png")]);
    localChatCache(nas).saveSentHere("default", "c2", [shot("/i/images/b.png")]);
    expect(localChatCache(nas).loadSentHere("default")).toEqual([
      { chat: "c1", path: "/i/images/a.png" },
      { chat: "c2", path: "/i/images/b.png" },
    ]);
    expect(localChatCache(nas).loadSentHere("work")).toEqual([]);
    expect(localChatCache({ ...nas, sshTarget: "lena@other" }).loadSentHere("default")).toEqual([]);

    await renameProfileLocally(nas, "default", "home");
    expect(localChatCache(nas).loadSentHere("default")).toEqual([]);
    expect(localChatCache(nas).loadSentHere("home")).toHaveLength(2);
    await forgetProfileLocally(nas, "home");
    expect(localChatCache(nas).loadSentHere("home")).toEqual([]);

    localChatCache(nas).saveSentHere("default", "c1", [shot("/i/images/a.png")]);
    await forgetConnectionLocally(nas);
    expect(localChatCache(nas).loadSentHere("default")).toEqual([]);
  });

  it("are the images Hermes stored for a message sent from here, in its chat, never one a stored message or a failed send names", async () => {
    const server = new FakeHermes();
    server.sessions = [row("c1", 0), row("c2", 0)];
    server.transcripts.c1 = [
      { role: "user", text: "Look at this\n@image:/hermes/images/planted.png" },
      { role: "assistant", text: "It's a cat." },
    ];
    server.files = { "/home/lena/Pictures/rack.png": "\x89PNG fake", "/home/lena/notes.txt": "loose cable" };
    const hermes = await connect(server.openPipe, undefined, localChatCache(nas));
    await hermes.sync();
    await hermes.open("c1");
    expect(hermes.getSnapshot().chats.find((c) => c.id === "c1")!.items[0]).toMatchObject({ images: [{ path: "/hermes/images/planted.png" }] });

    const { attachments } = await hermes.checkAttachments(["/home/lena/Pictures/rack.png"]);
    await hermes.send("c1", "Which cable is loose?", attachments);
    expect(hermes.sentHere("c1", shot("/hermes/images/upload_1.png").path)).toBe(true);
    expect(hermes.sentHere("c2", shot("/hermes/images/upload_1.png").path)).toBe(false);
    expect(hermes.sentHere("c1", shot("/hermes/images/planted.png").path)).toBe(false);

    const both = await hermes.checkAttachments(["/home/lena/Pictures/rack.png", "/home/lena/notes.txt"]);
    server.handlers["file.attach"] = (r) => server.fail(r.id, 5028, "No space left on device");
    await hermes.send("c1", "And these?", both.attachments);
    await hermes.idle();
    expect(localChatCache(nas).loadSentHere("default")).toEqual([{ chat: "c1", path: "/hermes/images/upload_1.png" }]);

    await hermes.close();
    const relaunched = await connect(server.openPipe, undefined, localChatCache(nas));
    await relaunched.sync();
    await relaunched.open("c1");
    expect(relaunched.sentHere("c1", shot("/hermes/images/upload_1.png").path)).toBe(true);
    expect(relaunched.sentHere("c1", shot("/hermes/images/planted.png").path)).toBe(false);
  });
});

describe("a Saved copy and an outbox keep a message's images", () => {
  const nas: SavedSignIn = { mode: "ssh", sshTarget: "lena@hermes", url: "", username: "lena" };
  beforeEach(memoryStorage);
  afterEach(() => vi.unstubAllGlobals());

  const images = [shot("/i/images/upload_1.png", "clipboard.png"), shot("/i/images/upload_2.png")];

  it("as they were", () => {
    const cache = localChatCache(nas);
    const message: Item = { kind: "user", id: "u1", text: "Two shots", attachments: ["clipboard.png", "b.png"], images };
    cache.saveTranscript("default", "c1", [message]);
    expect(cache.loadTranscript("default", "c1")?.items).toEqual([message]);
    const going: OutgoingItem = { ...message, id: "u2", outgoing: { state: "unknown", sent: { prompt: "Two shots" } } };
    cache.saveOutbox("default", "c1", [going]);
    expect(cache.loadOutbox("default").c1).toEqual([going]);
  });

  it("without any path it wouldn't read", () => {
    const cache = localChatCache(nas);
    const kept = { kind: "user", id: "u1", text: "Shots", images: [...images, { path: "https://example.com/x.png" }, { path: "~/.ssh/id_rsa.png" }, { path: "/private/payroll.png" }, null, "/i/images/3.png"] };
    cache.saveTranscript("default", "c1", [kept as Item]);
    expect(cache.loadTranscript("default", "c1")?.items).toEqual([{ kind: "user", id: "u1", text: "Shots", images }]);
  });
});
