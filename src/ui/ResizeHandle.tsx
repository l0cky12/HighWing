// The edge of a panel the owner drags, or focuses and moves with the arrow keys, to make the panel wider or narrower:
// the side panel's left edge (ADR 0039) and the chat list's right edge (ADR 0197). A drag never closes the panel; it
// stops at `min`.
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

/** The step the arrow keys resize by, in px. */
const KEY_STEP = 32;

export function ResizeHandle({
  edge,
  label,
  className,
  width,
  min,
  max,
  onResize,
  onDragging,
}: {
  /** The panel's edge the handle sits on: dragging away from the panel, or the arrow key that points away, widens it. */
  edge: "left" | "right";
  label: string;
  className: string;
  width: number;
  min: number;
  max: number;
  /** `done`: the drag or key press is over, so the width can be kept. */
  onResize: (width: number, done: boolean) => void;
  onDragging?: (on: boolean) => void;
}) {
  const top = Math.max(min, max);
  const clamp = (w: number) => Math.round(Math.min(Math.max(w, min), top));
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);
  const live = useRef({ onResize, onDragging });
  live.current = { onResize, onDragging };
  const grows = edge === "right" ? 1 : -1;

  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.documentElement.classList.remove("resizing");
    live.current.onResize(d.last, true);
    live.current.onDragging?.(false);
  };
  // A panel that goes mid-drag (Ctrl+B hides the chat list) keeps the width it was dragged to and leaves no drag cursor.
  useEffect(() => end, []);

  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.last = clamp(d.width + grows * (e.clientX - d.x));
    onResize(d.last, false);
  };
  return (
    <div
      className={className}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={top}
      aria-valuenow={clamp(width)}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { x: e.clientX, width: clamp(width), last: clamp(width) };
        document.documentElement.classList.add("resizing");
        onDragging?.(true);
      }}
      onPointerMove={move}
      onPointerUp={(e) => {
        move(e);
        end();
      }}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={(e) => {
        const wider = edge === "right" ? "ArrowRight" : "ArrowLeft";
        const narrower = edge === "right" ? "ArrowLeft" : "ArrowRight";
        const widest = edge === "right" ? "End" : "Home";
        const narrowest = edge === "right" ? "Home" : "End";
        const next =
          e.key === wider ? width + KEY_STEP : e.key === narrower ? width - KEY_STEP : e.key === widest ? top : e.key === narrowest ? min : undefined;
        if (next === undefined) return;
        e.preventDefault();
        onResize(clamp(next), true);
      }}
    />
  );
}
