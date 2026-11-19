import { Fragment, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ImageMark } from "../hermes/inlineImages";
import type { Mention } from "../hermes/mentionPicker";
import type { Attachment } from "../hermes/model";
import { formatBytes } from "../hermes/values";
import type { Preview } from "./previews";
import type { NamedBot } from "./SlashCommands";

export type ComposerMark = (ImageMark & { kind: "image"; file: Attachment }) | (Mention<NamedBot> & { kind: "bot" });

type Box = { left: number; top: number; width: number; height: number };
/** Where a mark is drawn: the chip's box, and the boxes of the mark's other lines, covered with the composer's own colour. */
type Placed = { chip: Box; covers: Box[] };

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
  const [boxes, setBoxes] = useState<(Placed | undefined)[]>([]);
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
        const boxes = [...s.getClientRects()].map((r) => ({
          left: r.left - origin.left - m.clientLeft,
          top: r.top - origin.top - m.clientTop + m.scrollTop,
          width: r.width,
          height: r.height,
        }));
        if (!boxes.length) return undefined;
        const widest = boxes.reduce((w, b) => (b.width > w.width ? b : w));
        return { chip: widest, covers: boxes.filter((b) => b !== widest) };
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
        const placed = boxes[i];
        if (!placed || (a < k.end && b > k.start)) return null;
        const box = placed.chip;
        const at = { ...box, left: box.left - 1, width: box.width + 2 };
        const preview = k.kind === "image" ? previews(k.file.path) : undefined;
        const url = preview && "url" in preview ? preview.url : undefined;
        return (
          <Fragment key={`chip:${i}`}>
            {placed.covers.map((c, j) => (
              <span key={j} className="inline-mark-cover" style={{ ...c, left: c.left - 1, width: c.width + 2 }} />
            ))}
            {k.kind === "bot" ? (
              <span className="inline-mark" style={at} data-mention={k.bot.handle}>
                <span className="inline-mark-pill is-bot" style={k.bot.color ? { color: k.bot.color } : undefined} translate="no">
                  @{k.bot.handle}
                </span>
              </span>
            ) : (
              <span className="inline-mark" style={at} data-inline-image={k.n}>
                <span className="inline-mark-pill">
                  {url ? <img src={url} alt="" /> : <span className="inline-mark-blank" />}
                  <span className="inline-mark-name">{k.file.name}</span>
                  <span className="inline-mark-size">{formatBytes(k.file.size)}</span>
                </span>
              </span>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
