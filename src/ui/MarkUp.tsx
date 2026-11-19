// Mark up (ADR 0225): a dialog over the chat pane where the owner drags one box on a staged image and types a note
// about it. Confirming draws the box into a copy of the image and hands it to the composer, which swaps it in for the
// original; Cancel changes nothing. The image shown is the chip's own thumbnail, so anything the chip draws can be
// marked.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { SquareDashedMousePointer, X } from "lucide-react";
import { dragBox, type Rect } from "../hermes/annotations";
import { NOTE_MAX, markedType, type Marked, type MarkedType } from "../hermes/markup";
import { LIMITS } from "../hermes/transport";
import { errorText, formatBytes } from "../hermes/values";
import type { Attachment } from "../hermes/model";

/** How far the pointer moves, in screen pixels, before a press becomes a drag. */
const DRAG_PX = 4;
/** The smallest box kept, in image pixels a side. */
const MIN_BOX = 4;
/** The largest image marked, in pixels: past this the webview may not give a canvas that big. */
export const MAX_PIXELS = 100_000_000;
/** The annotation blue (annotate.rs `outline`), so a marked image looks like a Preview annotation. */
const BLUE = "rgb(37, 99, 235)";

type Point = { x: number; y: number };

export function MarkUpDialog({
  file,
  src,
  n,
  onConfirm,
  onCancel,
}: {
  file: Attachment;
  /** The chip's thumbnail: the image as the webview decoded it. */
  src: string;
  /** The box's number: one more than the boxes already drawn on this image. */
  n: number;
  /** Stages the marked copy; a string is why it couldn't, and the dialog stays open with the box and note. */
  onConfirm: (marked: Marked) => Promise<string | void>;
  onCancel: () => void;
}) {
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [rect, setRect] = useState<Rect>();
  const [note, setNote] = useState("");
  const [drag, setDrag] = useState<{ from: Point; to: Point }>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const img = useRef<HTMLImageElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);

  useEffect(() => stage.current?.focus(), [size]);

  /** A pointer position in the image's natural pixels, even off the image, as a drag past its edge goes. */
  const placeOf = (e: { clientX: number; clientY: number }): Point | undefined => {
    const r = stage.current?.getBoundingClientRect();
    if (!size || !r?.width || !r.height) return undefined;
    return { x: ((e.clientX - r.left) * size.width) / r.width, y: ((e.clientY - r.top) * size.height) / r.height };
  };

  // The press, and where the drag is now once it has moved far enough. A ref, so a release in the same frame as the last
  // move still lands; `drag` only draws it.
  const press = useRef<{ from: Point; to?: Point }>(undefined);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || adding || !size) return;
    const at = placeOf(e);
    if (!at || at.x < 0 || at.y < 0 || at.x >= size.width || at.y >= size.height) return;
    press.current = { from: at };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    const r = stage.current?.getBoundingClientRect();
    if (!p || !size || !r?.width) return;
    const to = placeOf(e) ?? p.from;
    if (!p.to && (Math.hypot(to.x - p.from.x, to.y - p.from.y) * r.width) / size.width < DRAG_PX) return;
    p.to = to;
    setDrag({ from: p.from, to });
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    press.current = undefined;
    setDrag(undefined);
    if (!p?.to || !size) return;
    const box = dragBox(p.from, placeOf(e) ?? p.to, size);
    if (box.width < MIN_BOX || box.height < MIN_BOX) return;
    // One box a Mark up: a new drag moves it, and the note stays.
    setError(undefined);
    setRect(box);
    requestAnimationFrame(() => noteRef.current?.focus());
  };

  const confirm = async () => {
    const im = img.current;
    if (!rect || adding || !im) return;
    setAdding(true);
    setError(undefined);
    try {
      const type = markedType(file.name);
      const bytes = await drawMarked(im, rect, n, type);
      if (bytes.size > LIMITS.image.bytes)
        throw new Error(`the marked image is ${formatBytes(bytes.size)}, over the ${formatBytes(LIMITS.image.bytes)} Hermes takes`);
      const why = await onConfirm({ bytes, type, n, rect, note });
      if (why) {
        setError(why);
        setAdding(false);
      }
    } catch (e) {
      setError(`Couldn't mark up the image: ${errorText(e)}`);
      setAdding(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void confirm();
      return;
    }
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    if (press.current) {
      press.current = undefined;
      setDrag(undefined);
    } else if (!adding) onCancel();
  };

  const place = (r: Rect) =>
    size && {
      left: `${(r.x / size.width) * 100}%`,
      top: `${(r.y / size.height) * 100}%`,
      width: `${(r.width / size.width) * 100}%`,
      height: `${(r.height / size.height) * 100}%`,
    };
  const tooBig = size && size.width * size.height > MAX_PIXELS;

  return (
    <div className="markup" role="dialog" aria-modal="true" aria-label={`Mark up ${file.name}`} onKeyDown={onKeyDown}>
      <div className="annotate-bar markup-bar">
        <SquareDashedMousePointer size={14} aria-hidden />
        <span className="annotate-hint">
          {rect ? "Drag again to move the box. Esc cancels." : "Drag a box over what you mean. Esc cancels."}
        </span>
        <button className="icon-btn" title="Cancel" aria-label="Cancel the mark up" disabled={adding} onClick={onCancel}>
          <X size={15} />
        </button>
      </div>
      {(error || tooBig) && (
        <div className="attach-note failed" role="alert">
          {error ?? `This image is too large to mark up (${size?.width} × ${size?.height}).`}
        </div>
      )}
      <div className="markup-body">
        <div className="markup-frame">
          <div
            ref={stage}
            className={tooBig ? "markup-stage" : "markup-stage drawing"}
            // As large as the frame allows both ways, never past the image's own size, so a box lands where it's drawn.
            style={
              size
                ? {
                    aspectRatio: `${size.width} / ${size.height}`,
                    width: `min(calc(100cqw - 32px), calc((100cqh - 32px) * ${size.width / size.height}), ${size.width}px)`,
                  }
                : undefined
            }
            tabIndex={0}
            aria-label={`${file.name}: drag to draw a box`}
            aria-busy={!size}
            onPointerDown={tooBig ? undefined : onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            <img
              ref={img}
              src={src}
              alt=""
              draggable={false}
              onLoad={(e) => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
            />
            {rect && (
              <div className="markup-box" style={place(rect)}>
                <span className="markup-badge">{n}</span>
              </div>
            )}
            {drag && size && <div className="markup-box dragging" style={place(dragBox(drag.from, drag.to, size))} />}
          </div>
        </div>
        <div className="markup-side">
          {rect ? (
            <label className="markup-note">
              <span className="markup-badge">{n}</span>
              <input
                ref={noteRef}
                type="text"
                aria-label={`Note for box ${n}`}
                placeholder="What about this part?"
                maxLength={NOTE_MAX}
                value={note}
                disabled={adding}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    void confirm();
                  }
                }}
              />
            </label>
          ) : (
            <p className="markup-empty">Draw a box, then say what it is about.</p>
          )}
          <p className="annotate-small">The image is sent with the box drawn on it. The note goes in your message, where you can edit it. Nothing is sent until you send.</p>
          <div className="markup-actions">
            <button className="btn primary" disabled={adding || !rect} onClick={() => void confirm()}>
              {adding ? "Adding…" : "Add to message"}
            </button>
            <button className="link-btn" disabled={adding} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The image with the box drawn on it, at its natural size: a blue band inside the box's edge, with its number in a
 * blue badge at its top-left corner. `img` is drawn as the webview decoded it, photo orientation applied.
 */
export async function drawMarked(img: HTMLImageElement, rect: Rect, n: number, type: MarkedType): Promise<Blob> {
  const { naturalWidth: w, naturalHeight: h } = img;
  if (w * h > MAX_PIXELS) throw new Error(`the image is too large to mark up (${w} × ${h})`);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("the webview can't draw images");
  g.drawImage(img, 0, 0, w, h);
  const line = Math.max(3, Math.round(Math.max(w, h) / 320));
  const { x, y, width, height } = rect;
  g.strokeStyle = BLUE;
  g.lineWidth = line;
  g.strokeRect(x + line / 2, y + line / 2, Math.max(0, width - line), Math.max(0, height - line));
  // The badge sits just outside the box's top-left corner when there's room, else just inside.
  const badge = line * 6;
  const by = y >= badge ? y - badge : y;
  const label = String(n);
  g.font = `bold ${Math.round(badge * 0.7)}px sans-serif`;
  const bw = Math.max(badge, g.measureText(label).width + badge * 0.5);
  g.fillStyle = BLUE;
  g.fillRect(x, by, bw, badge);
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(label, x + bw / 2, by + badge / 2 + 1);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("the marked image couldn't be encoded"))), type, 0.92),
  );
}
