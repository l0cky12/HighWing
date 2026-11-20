// The picture picker (ADR 0235), which Edit bot and Bot setup's card both open: a popover with the pictures Highwing
// ships on one tab, and on the other a place to drop, paste or browse for the owner's own image. An upload is then
// fitted to the circle every client cuts a bot's picture to, and comes out as a 256 px PNG. Either way the picker
// gives a data URL, and what opened it saves that as it always saved a picture.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { BOT_PICTURE_URLS } from "../hermes/botPictures";
import { BOT_PICTURES, type BotPictureName } from "../hermes/botSetupBrief";
import { pictureKey } from "../hermes/botSetupCard";
import { useLocale } from "../i18n/locale";
import { useReturnFocus } from "./bits";
import { claimDrops } from "./dropClaim";
import { trapTab } from "./modal";
import { clipboardImages, pasteAttaches } from "./pasted";
import { drawCrop, loadPicture, type LoadedPicture } from "./pictureCanvas";
import { CENTERED, CROP_FRAME_PX, MAX_ZOOM, clampCrop, placed, sourceRect, zoomTo, type Crop } from "./pictureCrop";
import { PICTURE_TYPES, pictureFileProblem, pictureProblemText, readPicturePath, type PictureFileProblem } from "./pictureFile";

/** One of the set's pictures, with its bytes as a data URL and their key. */
export type SetPicture = { name: BotPictureName; key: string; url: string };

export const SET_PICTURES: readonly SetPicture[] = BOT_PICTURES.map((name) => ({ name, key: pictureKey(BOT_PICTURE_URLS[name]), url: BOT_PICTURE_URLS[name] }));

export type PickerTab = "pictures" | "upload";

const next = (at: number, n: number) => (at + 1) % n;
const prev = (at: number, n: number) => (at - 1 + n) % n;
const STEP: Record<string, (at: number, n: number, columns?: number) => number> = {
  ArrowRight: next,
  ArrowLeft: prev,
  ArrowDown: (at, n, columns) => (!columns ? next(at, n) : at + columns < n ? at + columns : at),
  ArrowUp: (at, n, columns) => (!columns ? prev(at, n) : at >= columns ? at - columns : at),
  Home: () => 0,
  End: (_, n) => n - 1,
};

/**
 * The set as a radiogroup, the pick marked. It is one tab stop: arrow keys, Home and End move through it, and Enter
 * or Space chooses the picture in focus. `columns`: how many the grid shows in a row, or none for a strip, where up
 * and down step as left and right do. `picked`: the key of the picture shown as chosen.
 */
export function PictureSet({ set, picked, columns, className, onPick }: { set: readonly SetPicture[]; picked: string | null; columns?: number; className: string; onPick: (picture: SetPicture) => void }) {
  const l = useLocale().chat.botSetup;
  const group = useRef<HTMLDivElement>(null);
  const stop = Math.max(0, set.findIndex((p) => p.key === picked));
  const move = (e: KeyboardEvent, at: number) => {
    const step = STEP[e.key];
    if (!step) return;
    e.preventDefault();
    group.current?.querySelectorAll<HTMLElement>("[role=radio]")[step(at, set.length, columns)]?.focus();
  };
  return (
    <div ref={group} className={className} role="radiogroup" aria-label={l.pictureSet}>
      {set.map((p, i) => {
        const words = l.pictureNamed(l.pictures[p.name], l.pictureFor[p.name]);
        return (
          <button key={p.name} type="button" role="radio" aria-checked={p.key === picked} aria-label={words} title={words} tabIndex={i === stop ? 0 : -1} onClick={() => onPick(p)} onKeyDown={(e) => move(e, i)}>
            <img src={p.url} alt="" />
          </button>
        );
      })}
    </div>
  );
}

type Step = { kind: PickerTab } | { kind: "crop"; picture: LoadedPicture };

/**
 * The popover. It sits in `anchor`, which also holds what opened it: a press anywhere else closes it, as Esc does,
 * and focus goes back to the opener. `tab`: the one it opens on. `onUse` gets the chosen picture as a data URL, the
 * set's own bytes or the PNG of an upload, and the picker closes.
 */
export function PicturePicker({ anchor, set = SET_PICTURES, picked, tab, onUse, onClose }: { anchor: RefObject<HTMLElement | null>; set?: readonly SetPicture[]; picked: string | null; tab: PickerTab; onUse: (dataUrl: string) => void; onClose: () => void }) {
  const f = useLocale().profiles.form;
  const p = f.picker;
  useReturnFocus();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const ids = useId();
  const [step, setStep] = useState<Step>({ kind: tab });
  const [note, setNote] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const held = useRef<LoadedPicture | undefined>(undefined);
  const open = useRef(true);

  const show = (next: Step) => {
    held.current?.release();
    held.current = next.kind === "crop" ? next.picture : undefined;
    setStep(next);
  };
  const refuse = (why: PictureFileProblem) => setNote(pictureProblemText(f, why));
  const take = async (file: File | PictureFileProblem | undefined) => {
    if (!file) return;
    if (typeof file === "string") return refuse(file);
    const why = pictureFileProblem(file);
    const picture = why ? undefined : await loadPicture(file);
    if (!open.current) return picture?.release();
    if (!picture) return refuse(why ?? "unread");
    setNote(undefined);
    show({ kind: "crop", picture });
  };
  const takeRef = useRef(take);
  takeRef.current = take;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
      held.current?.release();
    };
  }, []);

  // Not `useDismiss`: that closes when the window loses focus, which Browse files' own dialog makes it do.
  useEffect(() => {
    const away = (e: Event) => anchor.current?.contains(e.target as Node) || onCloseRef.current();
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [anchor]);

  // Tauri's native drop gives a path, which Rust reads. The claim keeps the composer under the picker from attaching
  // the same file.
  useEffect(() => {
    const over = (x: number, y: number) => {
      const r = box.current?.getBoundingClientRect();
      return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    const release = claimDrops(over);
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "leave") return setDragging(false);
      const scale = window.devicePixelRatio || 1;
      const here = over(payload.position.x / scale, payload.position.y / scale);
      if (payload.type !== "drop") return setDragging(here);
      setDragging(false);
      if (here && payload.paths[0]) void readPicturePath(payload.paths[0]).then((file) => takeRef.current(file));
    });
    return () => {
      release();
      void unlisten.then((stop) => stop());
    };
  }, []);

  // Where the native drop is off (Windows), a drop arrives as HTML5, with its bytes. These are the element's own
  // listeners because the pane's are too: React's would run after them, too late to keep the drop from the composer.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const mine = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return false;
      e.preventDefault();
      e.stopPropagation();
      return true;
    };
    const over = (e: DragEvent) => {
      if (!mine(e)) return;
      e.dataTransfer!.dropEffect = "copy";
      setDragging(true);
    };
    const leave = (e: DragEvent) => mine(e) && !el.contains(e.relatedTarget as Node) && setDragging(false);
    const drop = (e: DragEvent) => {
      if (!mine(e)) return;
      setDragging(false);
      void takeRef.current(e.dataTransfer!.files[0]);
    };
    el.addEventListener("dragenter", over);
    el.addEventListener("dragover", over);
    el.addEventListener("dragleave", leave);
    el.addEventListener("drop", drop);
    return () => {
      el.removeEventListener("dragenter", over);
      el.removeEventListener("dragover", over);
      el.removeEventListener("dragleave", leave);
      el.removeEventListener("drop", drop);
    };
  }, []);

  // A paste anywhere while the picker is open, since a press on its background leaves focus on nothing.
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const got = e.clipboardData && pasteAttaches(e.clipboardData);
      if (!got || got.kind === "nothing") return;
      e.preventDefault();
      e.stopPropagation();
      if (got.kind === "files") void takeRef.current(got.files[0]);
      else if (got.kind === "clipboard images") void clipboardImages().then((files) => takeRef.current(files[0]));
      else
        void invoke<string[]>("attach_copied_files")
          .then((paths) => (paths[0] ? readPicturePath(paths[0]) : undefined))
          .then(
            (file) => takeRef.current(file),
            () => takeRef.current("unread"),
          );
    };
    document.addEventListener("paste", paste, true);
    return () => document.removeEventListener("paste", paste, true);
  }, []);

  // Focus goes into the picker when it opens, and to the crop step and back as a file comes and goes. A tab pressed
  // keeps it.
  const cropping = step.kind === "crop";
  const stepKind = useRef(step.kind);
  stepKind.current = step.kind;
  useEffect(() => {
    const first = { pictures: '[role="radio"][tabindex="0"]', upload: ".picture-browse", crop: ".picture-crop-frame" }[stepKind.current];
    box.current?.querySelector<HTMLElement>(first)?.focus();
  }, [cropping]);
  // Each step has its own height, and the chat or the dialog the picker sits in may have to scroll to show all of it.
  useEffect(() => {
    box.current?.scrollIntoView?.({ block: "nearest" });
  }, [step.kind]);

  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") {
      // A dialog this sits in traps Tab too, and would take it for its own.
      e.stopPropagation();
      trapTab(e, box.current);
    }
  };
  const tabKeys = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.currentTarget.querySelector<HTMLElement>('[role="tab"][aria-selected="false"]')?.focus();
    show({ kind: step.kind === "pictures" ? "upload" : "pictures" });
  };

  const alert = note && (
    <div className="picture-note" role="alert">
      {note}
    </div>
  );
  return (
    <div ref={box} className="status-popover picture-picker" role="dialog" aria-label={step.kind === "crop" ? p.fit : p.title} onKeyDown={keys}>
      {step.kind === "crop" ? (
        <CropStep
          picture={step.picture}
          note={alert}
          onCancel={() => show({ kind: "upload" })}
          onUse={(source) => {
            let made: string;
            try {
              made = drawCrop(step.picture, source);
            } catch {
              return refuse("unread");
            }
            onUse(made);
            onClose();
          }}
        />
      ) : (
        <>
          <div className="picture-tabs" role="tablist" aria-label={p.title} onKeyDown={tabKeys}>
            {(["pictures", "upload"] as const).map((kind) => (
              <button key={kind} type="button" role="tab" id={`${ids}${kind}`} aria-selected={step.kind === kind} aria-controls={`${ids}panel`} tabIndex={step.kind === kind ? 0 : -1} onClick={() => show({ kind })}>
                {p[kind]}
              </button>
            ))}
          </div>
          <div id={`${ids}panel`} role="tabpanel" aria-labelledby={`${ids}${step.kind}`}>
            {step.kind === "pictures" ? (
              <PictureSet
                set={set}
                picked={picked}
                columns={5}
                className="picture-grid"
                onPick={(picture) => {
                  onUse(picture.url);
                  onClose();
                }}
              />
            ) : (
              <div className={`picture-drop${dragging ? " over" : ""}`}>
                <span>{p.drop}</span>
                <span>{p.or}</span>
                <input
                  ref={input}
                  type="file"
                  hidden
                  accept={PICTURE_TYPES.join(",")}
                  aria-label={p.browse}
                  onChange={(e) => {
                    void take(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <button type="button" className="btn picture-browse" onClick={() => input.current?.click()}>
                  {p.browse}
                </button>
                <span className="picture-hint">{f.pictureHint}</span>
              </div>
            )}
          </div>
          {alert}
        </>
      )}
    </div>
  );
}

const NUDGE: Record<string, [number, number]> = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] };

/** The image under the circle: drag or the arrow keys move it, the slider zooms, and Use picture gives the square in the frame. */
function CropStep({ picture, note, onCancel, onUse }: { picture: LoadedPicture; note: ReactNode; onCancel: () => void; onUse: (source: { x: number; y: number; size: number }) => void }) {
  const l = useLocale();
  const p = l.profiles.form.picker;
  const [crop, setCrop] = useState<Crop>(CENTERED);
  const drag = useRef<{ x: number; y: number; from: Crop } | undefined>(undefined);
  const moveTo = (next: Crop) => setCrop(clampCrop(picture, CROP_FRAME_PX, next));
  const dragged = (e: PointerEvent) => {
    const d = drag.current;
    if (d) moveTo({ ...d.from, x: d.from.x + e.clientX - d.x, y: d.from.y + e.clientY - d.y });
  };
  const at = placed(picture, CROP_FRAME_PX, crop);
  return (
    <>
      <div
        className="picture-crop-frame"
        role="group"
        aria-label={p.move}
        title={p.move}
        tabIndex={0}
        style={{ width: CROP_FRAME_PX, height: CROP_FRAME_PX }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, from: crop };
        }}
        onPointerMove={dragged}
        onPointerUp={() => (drag.current = undefined)}
        onPointerCancel={() => (drag.current = undefined)}
        onKeyDown={(e) => {
          const by = NUDGE[e.key];
          if (!by) return;
          e.preventDefault();
          moveTo({ ...crop, x: crop.x + by[0], y: crop.y + by[1] });
        }}
      >
        <img src={picture.url} alt="" draggable={false} style={at} />
        <span className="picture-crop-mask" aria-hidden />
      </div>
      <input className="picture-zoom" type="range" min={1} max={MAX_ZOOM} step={0.01} value={crop.zoom} aria-label={p.zoom} onChange={(e) => setCrop(zoomTo(picture, CROP_FRAME_PX, crop, Number(e.target.value)))} />
      {note}
      <div className="picture-crop-actions">
        <button type="button" className="btn" onClick={onCancel}>
          {l.common.cancel}
        </button>
        <button type="button" className="btn primary" onClick={() => onUse(sourceRect(picture, CROP_FRAME_PX, crop))}>
          {p.use}
        </button>
      </div>
    </>
  );
}
