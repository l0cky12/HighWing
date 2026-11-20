// @vitest-environment jsdom
// The picture picker (ADR 0235) on its own: its two tabs, the grid by keyboard, a set pick, an upload by Browse
// files, paste and drop through the crop step, the files it refuses, and how it closes. jsdom decodes and draws
// nothing, so `fakePictureCanvas.ts` stands in for both; `pictureCrop.test.ts` covers the square that is drawn.
import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOT_PICTURE_URLS } from "../hermes/botPictures";
import { pictureKey } from "../hermes/botSetupCard";
import { en } from "../i18n/en";
import { LocaleContext, localeFor, type Locale } from "../i18n/locale";
import { pseudoLocale, untranslated } from "../i18n/pseudo";
import { dropClaimed } from "./dropClaim";
import { FAKE_PICTURE, fakeCrop } from "./fakePictureCanvas";
import { CENTERED, CROP_FRAME_PX, sourceRect } from "./pictureCrop";
import { PICTURE_INPUT_MAX_BYTES } from "./pictureFile";
import { PicturePicker, type PickerTab } from "./PicturePicker";

type DropEvent = { payload: { type: "enter" | "over" | "drop"; paths?: string[]; position: { x: number; y: number } } | { type: "leave" } };
const tauri = vi.hoisted(() => ({ drop: undefined as ((e: never) => void) | undefined, invoke: undefined as unknown as (cmd: string, args: Record<string, unknown>) => Promise<unknown> }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: (e: never) => void) => {
      tauri.drop = handler;
      return () => (tauri.drop = undefined);
    },
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: Record<string, unknown>) => tauri.invoke(cmd, args) }));
vi.mock("./pictureCanvas", () => import("./fakePictureCanvas"));

const f = en.profiles.form;
const p = f.picker;
const t = en.chat.botSetup;
const words = (name: keyof typeof BOT_PICTURE_URLS) => t.pictureNamed(t.pictures[name], t.pictureFor[name]);
const png = (name = "me.png", bytes = "\x89PNG\r\n\x1a\nmine") => new File([bytes], name, { type: "image/png" });
const sized = (size: number) => Object.defineProperty(png("big.png"), "size", { value: size });
const MIDDLE = fakeCrop(sourceRect(FAKE_PICTURE, CROP_FRAME_PX, CENTERED));
/** The picker's box on the page, which jsdom doesn't lay out. */
const BOX = { left: 100, top: 100, right: 400, bottom: 400 };
const nativeDrop = (payload: DropEvent["payload"]) => act(async () => tauri.drop?.({ payload } as never));

let disk: Record<string, { size: number; bytes?: string }> = {};
let invoked: string[] = [];
beforeEach(() => {
  disk = {};
  invoked = [];
  // Chromium's answers a promise, which an effect must not hand back to React.
  Element.prototype.scrollIntoView = vi.fn(async () => {});
  tauri.invoke = async (cmd, args) => {
    invoked.push(cmd);
    if (cmd === "hermes_stat_files") return (args.paths as string[]).map((path) => ({ path, name: path, size: disk[path]?.size }));
    if (cmd === "hermes_read_preview") {
      const bytes = disk[args.path as string]?.bytes;
      if (bytes === undefined) throw "it isn't an image";
      return new TextEncoder().encode(bytes).buffer;
    }
    if (cmd === "attach_copied_files") return Object.keys(disk);
    throw `no ${cmd}`;
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const at = this.classList.contains("picture-picker") ? BOX : { left: 0, top: 0, right: 0, bottom: 0 };
    return { ...at, x: at.left, y: at.top, width: at.right - at.left, height: at.bottom - at.top, toJSON: () => ({}) };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Host({ tab, picked, used }: { tab: PickerTab; picked: string | null; used: (dataUrl: string) => void }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div>
      <span ref={anchor}>
        <button onClick={() => setOpen(true)}>Open</button>
        {open && <PicturePicker anchor={anchor} picked={picked} tab={tab} onUse={used} onClose={() => setOpen(false)} />}
      </span>
      <button>Elsewhere</button>
    </div>
  );
}

async function opened(tab: PickerTab, { picked = null as string | null, locale = undefined as Locale | undefined, applyAccept = true } = {}) {
  const used = vi.fn<(dataUrl: string) => void>();
  const user = userEvent.setup({ applyAccept });
  const view = render(
    <LocaleContext.Provider value={locale ?? localeFor("en", [])}>
      <Host tab={tab} picked={picked} used={used} />
    </LocaleContext.Provider>,
  );
  await user.click(screen.getByRole("button", { name: "Open" }));
  return { used, user, view, opener: screen.getByRole("button", { name: "Open" }) };
}
const dialog = () => screen.getByRole("dialog");
const tabOf = (name: string) => within(dialog()).getByRole("tab", { name });
const selected = () => within(dialog()).getAllByRole("tab").filter((el) => el.getAttribute("aria-selected") === "true").map((el) => el.textContent);
const browse = () => within(dialog()).getByLabelText(p.browse, { selector: "input" });
const radio = (name: keyof typeof BOT_PICTURE_URLS) => within(dialog()).getByRole("radio", { name: words(name) });
const cropping = () => screen.findByRole("dialog", { name: p.fit });
const noteText = async () => (await within(dialog()).findByRole("alert")).textContent;

describe("The picture picker", () => {
  it("opens on the tab it was asked for, and a press or an arrow key shows the other", async () => {
    const { user } = await opened("upload");
    expect(dialog().getAttribute("aria-label")).toBe(p.title);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(selected()).toEqual([p.upload]);
    expect(within(dialog()).getByText(p.drop)).toBeTruthy();
    expect(within(dialog()).getByText(f.pictureHint)).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog()).getByRole("button", { name: p.browse }));
    expect(within(dialog()).queryByRole("radiogroup")).toBeNull();

    await user.click(tabOf(p.pictures));
    expect(selected()).toEqual([p.pictures]);
    expect(within(dialog()).getAllByRole("radio")).toHaveLength(10);
    expect(within(dialog()).queryByText(p.drop)).toBeNull();

    tabOf(p.pictures).focus();
    await user.keyboard("{ArrowRight}");
    expect(selected()).toEqual([p.upload]);
    expect(document.activeElement).toBe(tabOf(p.upload));
    await user.keyboard("{ArrowLeft}");
    expect(selected()).toEqual([p.pictures]);
    expect(document.activeElement).toBe(tabOf(p.pictures));
  });

  it("marks the picture the bot has, moves through the grid of five across with the arrow keys, and Enter chooses", async () => {
    const { user, used, opener } = await opened("pictures", { picked: pictureKey(BOT_PICTURE_URLS.moon) });
    expect(within(dialog()).getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true")).toEqual([radio("moon")]);
    expect(document.activeElement).toBe(radio("moon"));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(radio("sun"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(radio("leaf"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(radio("leaf"));
    await user.keyboard("{ArrowUp}{ArrowLeft}{ArrowLeft}");
    expect(document.activeElement).toBe(radio("plane"));
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(radio("compass"));
    await user.keyboard("{Home}{End}{ArrowUp}");
    expect(document.activeElement).toBe(radio("pen"));
    expect(used).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    expect(used.mock.calls).toEqual([[BOT_PICTURE_URLS.pen]]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("chooses with Space or a press too, and gives the set's own bytes", async () => {
    const { user, used } = await opened("pictures");
    expect(document.activeElement).toBe(radio("plane"));
    await user.keyboard(" ");
    expect(used.mock.calls).toEqual([[BOT_PICTURE_URLS.plane]]);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(radio("pot"));
    expect(used.mock.calls).toEqual([[BOT_PICTURE_URLS.plane], [BOT_PICTURE_URLS.pot]]);
  });

  it("takes a browsed file to the crop step: Cancel goes back, and Use picture gives the PNG of what is in the frame", async () => {
    const { user, used, opener } = await opened("upload");
    await user.upload(browse(), png());
    const crop = await cropping();
    expect(within(crop).queryByRole("tab")).toBeNull();
    expect(document.activeElement).toBe(within(crop).getByRole("group", { name: p.move }));

    await user.click(within(crop).getByRole("button", { name: en.common.cancel }));
    expect(selected()).toEqual([p.upload]);
    expect(used).not.toHaveBeenCalled();

    await user.upload(browse(), png());
    await user.click(within(await cropping()).getByRole("button", { name: p.use }));
    expect(used.mock.calls).toEqual([[MIDDLE]]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("draws the square the owner moved and zoomed to", async () => {
    const { user, used } = await opened("upload");
    await user.upload(browse(), png());
    const crop = await cropping();
    fireEvent.change(within(crop).getByLabelText(p.zoom), { target: { value: "2" } });
    within(crop).getByRole("group", { name: p.move }).focus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowDown}");
    await user.click(within(crop).getByRole("button", { name: p.use }));
    const moved = fakeCrop(sourceRect(FAKE_PICTURE, CROP_FRAME_PX, { zoom: 2, x: -24, y: 8 }));
    expect(moved).not.toBe(fakeCrop(sourceRect(FAKE_PICTURE, CROP_FRAME_PX, { zoom: 2, x: 0, y: 0 })));
    expect(used.mock.calls).toEqual([[moved]]);
  });

  it("takes a pasted image to the crop step, whichever tab is showing, and leaves pasted words alone", async () => {
    const { used, user } = await opened("pictures");
    const words = { types: ["text/plain"], files: [], getData: (type: string) => (type === "text/plain" ? "hello" : "") };
    expect(fireEvent.paste(document.body, { clipboardData: words })).toBe(true);
    expect(dialog().getAttribute("aria-label")).toBe(p.title);

    const image = { types: ["Files"], files: [png("shot.png")], getData: () => "" };
    expect(fireEvent.paste(document.body, { clipboardData: image })).toBe(false);
    await user.click(within(await cropping()).getByRole("button", { name: p.use }));
    expect(used.mock.calls).toEqual([[MIDDLE]]);
  });

  it("takes an image copied in a file manager, which Rust reads by its path", async () => {
    disk = { "/home/owner/Pictures/cat.webp": { size: 900, bytes: "RIFF cat" } };
    await opened("upload");
    fireEvent.paste(document.body, { clipboardData: { types: ["text/uri-list"], files: [], getData: () => "" } });
    await cropping();
    expect(invoked).toEqual(["attach_copied_files", "hermes_stat_files", "hermes_read_preview"]);
  });

  it("says why for a file that isn't a PNG, JPEG or WebP, one over 25 MB, and one that doesn't decode, and takes a 20 MB photo", async () => {
    const { user } = await opened("upload", { applyAccept: false });
    await user.upload(browse(), new File(["GIF89a"], "face.gif", { type: "image/gif" }));
    expect(await noteText()).toBe(f.pictureFormat);
    await user.upload(browse(), sized(PICTURE_INPUT_MAX_BYTES + 1));
    await waitFor(async () => expect(await noteText()).toBe(f.pictureTooBig));
    await user.upload(browse(), new File(["not an image"], "torn.png", { type: "image/png" }));
    await waitFor(async () => expect(await noteText()).toBe(f.pictureUnread));
    expect(selected()).toEqual([p.upload]);

    await user.upload(browse(), sized(20 * 1024 * 1024));
    expect(within(await cropping()).queryByRole("alert")).toBeNull();
  });

  it("takes a file dropped on it by its path, read by Rust, and claims the drop so the composer under it doesn't attach the file", async () => {
    disk = { "/home/owner/face.png": { size: 3_000_000, bytes: "\x89PNG face" }, "/home/owner/huge.jpg": { size: PICTURE_INPUT_MAX_BYTES + 1, bytes: "x" } };
    const { user, used } = await opened("upload");
    expect([dropClaimed(150, 150), dropClaimed(50, 50)]).toEqual([true, false]);

    await nativeDrop({ type: "over", position: { x: 150, y: 150 } });
    expect(dialog().querySelector(".picture-drop.over")).toBeTruthy();
    await nativeDrop({ type: "over", position: { x: 50, y: 50 } });
    expect(dialog().querySelector(".picture-drop.over")).toBeNull();

    await nativeDrop({ type: "drop", paths: ["/home/owner/face.png"], position: { x: 50, y: 50 } });
    expect(invoked).toEqual([]);
    await nativeDrop({ type: "drop", paths: ["/home/owner/anim.gif"], position: { x: 150, y: 150 } });
    expect(await noteText()).toBe(f.pictureFormat);
    expect(invoked).toEqual([]);
    await nativeDrop({ type: "drop", paths: ["/home/owner/huge.jpg"], position: { x: 150, y: 150 } });
    await waitFor(async () => expect(await noteText()).toBe(f.pictureTooBig));
    expect(invoked).toEqual(["hermes_stat_files"]);
    await nativeDrop({ type: "drop", paths: ["/home/owner/gone.png"], position: { x: 150, y: 150 } });
    await waitFor(async () => expect(await noteText()).toBe(f.pictureUnread));

    await nativeDrop({ type: "drop", paths: ["/home/owner/face.png"], position: { x: 150, y: 150 } });
    await user.click(within(await cropping()).getByRole("button", { name: p.use }));
    expect(used.mock.calls).toEqual([[MIDDLE]]);
    expect(dropClaimed(150, 150)).toBe(false);
    expect(tauri.drop).toBeUndefined();
  });

  it("takes a file dropped as HTML5, where the native drop is off, and keeps that drop from what is under it", async () => {
    const { view } = await opened("pictures");
    const under = vi.fn();
    view.container.addEventListener("drop", under);
    view.container.addEventListener("dragover", under);
    const dataTransfer = { types: ["Files"], files: [png()], dropEffect: "none" };
    expect(fireEvent.dragOver(dialog(), { dataTransfer })).toBe(false);
    expect(fireEvent.drop(dialog(), { dataTransfer })).toBe(false);
    await cropping();
    expect(under).not.toHaveBeenCalled();
    // A drag that carries no file is the page's own, and passes.
    fireEvent.dragOver(dialog(), { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(under).toHaveBeenCalledTimes(1);
  });

  it("closes on Esc and on a press elsewhere, with focus back on what opened it, but not when the window loses focus to Browse files' dialog", async () => {
    const { user, used, opener } = await opened("upload");
    fireEvent.blur(window);
    expect(screen.queryByRole("dialog")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);

    await user.click(opener);
    await user.upload(browse(), png());
    await cropping();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(opener);
    fireEvent.mouseDown(within(dialog()).getByText(p.drop));
    expect(screen.queryByRole("dialog")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(used).not.toHaveBeenCalled();
  });

  it("keeps Tab inside it", async () => {
    const { user } = await opened("upload");
    const inside = () => dialog().contains(document.activeElement);
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(inside()).toBe(true);
    }
    await user.tab({ shift: true });
    expect(inside()).toBe(true);
  });

  it("shows only catalogue words, on both tabs, with a note, and in the crop step", async () => {
    const locale = pseudoLocale();
    const l = locale.profiles.form.picker;
    const { user } = await opened("pictures", { locale, applyAccept: false });
    expect(untranslated(dialog())).toEqual([]);
    await user.click(within(dialog()).getByRole("tab", { name: l.upload }));
    await user.upload(within(dialog()).getByLabelText(l.browse, { selector: "input" }), new File(["GIF89a"], "face.gif", { type: "image/gif" }));
    await within(dialog()).findByRole("alert");
    expect(untranslated(dialog())).toEqual([]);
    await user.upload(within(dialog()).getByLabelText(l.browse, { selector: "input" }), png());
    await screen.findByRole("dialog", { name: l.fit });
    expect(untranslated(dialog())).toEqual([]);
  });

  it("has its words in Spanish too", () => {
    const es = localeFor("es", []).profiles.form;
    expect([es.picker.title, es.picker.pictures, es.picker.upload, es.picker.drop, es.picker.or, es.picker.browse, es.picker.use, es.pictureHint]).toEqual([
      "Elegir una imagen",
      "Imágenes",
      "Subir",
      "Arrastra, suelta o pega una imagen",
      "o",
      "Buscar archivos",
      "Usar la imagen",
      "PNG, JPEG o WebP",
    ]);
    for (const key of ["fit", "move", "use", "drop", "browse", "title"] as const) expect(es.picker[key], key).not.toBe(p[key]);
  });
});
