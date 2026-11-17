// The composer's image marks drawn as chips over its text (ADR 0200). The words stay one plain textarea, so typing,
// IME, selection, undo and the slash menu work as they always did. A mirror laid out as the textarea is finds where each
// mark is, and a chip with the image's thumbnail, name and size covers it there. While the cursor or a selection is in
// a mark, or the mark wraps onto a second line, its words show instead.
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ImageMark } from "../hermes/inlineImages";
import type { Attachment } from "../hermes/model";
import { formatBytes } from "../hermes/values";
import type { Preview } from "./previews";

export type ComposerMark = ImageMark & { file: Attachment };

type Box = { left: number; top: number; width: number; height: number };

/** What the mirror copies from the textarea, so its text wraps where the textarea's does. */
const LAYOUT = [
  "boxSizing", "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "tabSize", "textIndent",
  "textTransform", "whiteSpace", "wordBreak", "overflowWrap", "wordSpacing", "paddingTop", "paddingLeft", "paddingBottom",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
] as const;

export function InlineMarks({
  ta,
  text,
  marks,
  selection,
  previews,
}: {
  ta: RefObject<HTMLTextAreaElement | null>;
  text: string;
  marks: readonly ComposerMark[];
  selection: readonly [number, number];
  previews: (path: string) => Preview | undefined;
}) {
  const mirror = useRef<HTMLDivElement>(null);
  const [boxes, setBoxes] = useState<(Box | undefined)[]>([]);
  const [width, resized] = useReducer((_: number, w: number) => w, 0);

  useEffect(() => {
    const t = ta.current;
    if (!t) return;
    const sync = () => {
      if (mirror.current) mirror.current.scrollTop = t.scrollTop;
    };
    const watch = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => resized(t.clientWidth * 10_000 + t.clientHeight));
    watch?.observe(t);
    t.addEventListener("scroll", sync);
    void document.fonts?.ready.then(() => resized(-1));
    return () => {
      watch?.disconnect();
      t.removeEventListener("scroll", sync);
    };
  }, [ta]);

  useLayoutEffect(() => {
    const t = ta.current;
    const m = mirror.current;
    if (!t || !m) return;
    const cs = getComputedStyle(t);
    for (const p of LAYOUT) m.style[p] = cs[p];
    m.style.borderStyle = "solid";
    m.style.borderColor = "transparent";
    // The textarea's scrollbar narrows its text; the mirror has none, so it gives the same width as padding.
    const bar = t.offsetWidth - t.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
    m.style.paddingRight = `${parseFloat(cs.paddingRight) + Math.max(0, bar)}px`;
    Object.assign(m.style, { left: `${t.offsetLeft}px`, top: `${t.offsetTop}px`, width: `${t.offsetWidth}px`, height: `${t.offsetHeight}px` });
    m.scrollTop = t.scrollTop;
    const origin = m.getBoundingClientRect();
    const spans = m.querySelectorAll<HTMLElement>("[data-mark]");
    setBoxes(
      [...spans].map((s) => {
        const rects = s.getClientRects();
        if (rects.length !== 1) return undefined;
        const r = rects[0];
        return { left: r.left - origin.left - m.clientLeft, top: r.top - origin.top - m.clientTop + m.scrollTop, width: r.width, height: r.height };
      }),
    );
  }, [ta, text, marks, width]);

  const pieces: ReactNode[] = [];
  let from = 0;
  marks.forEach((k, i) => {
    pieces.push(text.slice(from, k.start), <span key={i} data-mark>{text.slice(k.start, k.end)}</span>);
    from = k.end;
  });
  pieces.push(text.slice(from), "\n");
  const [a, b] = selection;
  return (
    <div ref={mirror} className="inline-marks" aria-hidden>
      {pieces}
      {marks.map((k, i) => {
        const box = boxes[i];
        if (!box || (a < k.end && b > k.start)) return null;
        const preview = previews(k.file.path);
        const url = preview && "url" in preview ? preview.url : undefined;
        return (
          <span key={`chip:${i}`} className="inline-mark" style={{ ...box, left: box.left - 1, width: box.width + 2 }} data-inline-image={k.n}>
            {url ? <img src={url} alt="" /> : <span className="inline-mark-blank" />}
            <span className="inline-mark-name">{k.file.name}</span>
            <span className="inline-mark-size">{formatBytes(k.file.size)}</span>
          </span>
        );
      })}
    </div>
  );
}
