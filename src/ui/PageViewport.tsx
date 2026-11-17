// The size a web page in the Preview lays out at: the box it has (Responsive), a size the owner types, or a device's.
// Only the page's viewport changes. Its user agent, touch and pixel density stay this computer's.
import { useEffect, useState, type RefObject } from "react";

import type { PageSize } from "./tauriPreview";

export type { PageSize };
/** `null`: the page fills the Preview's box. `device`: the size is that device's, as picked. */
export type PageViewport = (PageSize & { device?: string }) | null;

export const DEVICES: readonly (PageSize & { name: string })[] = [
  { name: "iPhone SE", width: 375, height: 667 },
  { name: "iPhone XR", width: 414, height: 896 },
  { name: "iPhone 12 Pro", width: 390, height: 844 },
  { name: "iPhone 14 Pro Max", width: 430, height: 932 },
  { name: "Pixel 7", width: 412, height: 915 },
  { name: "Samsung Galaxy S8+", width: 360, height: 740 },
  { name: "Samsung Galaxy S20 Ultra", width: 412, height: 915 },
  { name: "iPad Mini", width: 768, height: 1024 },
  { name: "iPad Air", width: 820, height: 1180 },
  { name: "iPad Pro", width: 1024, height: 1366 },
  { name: "Surface Pro 7", width: 912, height: 1368 },
  { name: "Surface Duo", width: 540, height: 720 },
  { name: "Galaxy Z Fold 5", width: 344, height: 882 },
  { name: "Asus Zenbook Fold", width: 853, height: 1280 },
  { name: "Samsung Galaxy A51/71", width: 412, height: 914 },
  { name: "Nest Hub", width: 1024, height: 600 },
  { name: "Nest Hub Max", width: 1280, height: 800 },
];

/** The sides a typed size may have, as in Chrome's device toolbar. */
export const SIDE = { min: 50, max: 9999 } as const;

/** A side as typed: plain digits within `SIDE`. Anything else (empty, a sign, a fraction, an exponent, a space) is no side. */
export function parseSide(text: string): number | undefined {
  if (!/^[1-9][0-9]*$/.test(text)) return undefined;
  const n = Number(text);
  return n >= SIDE.min && n <= SIDE.max ? n : undefined;
}

/**
 * The ground a page at a picked size keeps around it, in CSS pixels. The Preview's box has the pane's resize handle
 * over its edge, and the page's view makes room for it (pagePlacement.ts): a page drawn against that edge would lose a
 * strip, and with it the size it lays out at.
 */
export const STAGE_INSET = 8;

/** How far a page of `size` is scaled down to fit `box`, inside its `STAGE_INSET`. Never up: a small page shows at its own size. */
export const fitScale = (box: PageSize, size: PageSize): number =>
  Math.min(
    1,
    (box.width - 2 * STAGE_INSET) / size.width,
    (box.height - 2 * STAGE_INSET) / size.height,
  );

/** The size of `el`'s content box, kept current. */
export function useBoxSize(
  el: RefObject<HTMLElement | null>,
): PageSize | undefined {
  const [size, setSize] = useState<PageSize>();
  useEffect(() => {
    const box = el.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const measure = () =>
      setSize((s) =>
        s?.width === box.clientWidth && s.height === box.clientHeight
          ? s
          : { width: box.clientWidth, height: box.clientHeight },
      );
    const watch = new ResizeObserver(measure);
    watch.observe(box);
    measure();
    return () => watch.disconnect();
  }, [el]);
  return size;
}

/** The select's value for a typed size, which no device has. */
const TYPED = "typed";

const SIZE_ONLY =
  "Sets only the size the page lays out at. The page still sees this computer's browser, pointer and screen density.";

/**
 * The row under the address: a device, or Responsive, and the width and height. Typing a size makes it Responsive at
 * that size; picking Responsive gives the page the box again. `box`: the Preview's box, shown while the page fills it.
 */
export function ViewportBar({
  value,
  box,
  scale,
  onChange,
}: {
  value: PageViewport;
  box: PageSize | undefined;
  scale: number;
  onChange: (v: PageViewport) => void;
}) {
  const shown = value ?? (box && { width: box.width, height: box.height });
  const sizeKey = value ? `${value.width}x${value.height}` : "";
  const typed = (side: "width" | "height", n: number) => {
    const other = side === "width" ? "height" : "width";
    const keep = value?.[other] ?? parseSide(String(box?.[other] ?? ""));
    if (keep !== undefined) onChange({ [side]: n, [other]: keep } as PageSize);
  };
  return (
    <div
      className="preview-viewport"
      role="group"
      aria-label="Page size"
      title={SIZE_ONLY}
    >
      <select
        className="select"
        aria-label="Device"
        value={value ? (value.device ?? TYPED) : ""}
        onChange={(e) => {
          const device = DEVICES.find((d) => d.name === e.target.value);
          onChange(
            device
              ? {
                  width: device.width,
                  height: device.height,
                  device: device.name,
                }
              : null,
          );
        }}
      >
        <option value="">Responsive</option>
        {/* A typed size reads Responsive too, but is its own option, so picking Responsive then still clears it. Only
            while there is one: the arrow keys would stop on it. */}
        {value && !value.device && (
          <option value={TYPED} hidden>
            Responsive
          </option>
        )}
        <optgroup label="Standard">
          {DEVICES.map((d) => (
            <option key={d.name} value={d.name}>
              {d.name} ({d.width} × {d.height})
            </option>
          ))}
        </optgroup>
      </select>
      {/* Keyed by the size, so a draft (an invalid one, say) goes once another size applies. */}
      <SideField
        key={`w${sizeKey}`}
        label="Width"
        value={value?.width}
        placeholder={shown?.width}
        onCommit={(n) => typed("width", n)}
      />
      <span aria-hidden>×</span>
      <SideField
        key={`h${sizeKey}`}
        label="Height"
        value={value?.height}
        placeholder={shown?.height}
        onCommit={(n) => typed("height", n)}
      />
      {value && scale < 1 && (
        <span
          className="preview-viewport-scale"
          title={`Scaled to fit the Preview. The page still lays out at ${value.width} × ${value.height}.`}
        >
          {Math.round(scale * 100)}%
        </span>
      )}
    </div>
  );
}

/** One side. It applies on Enter or on leaving the field, only as a whole number within `SIDE`; Escape puts it back. */
function SideField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: number | undefined;
  placeholder: number | undefined;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string>();
  const invalid = draft !== undefined && parseSide(draft) === undefined;
  const commit = () => {
    if (draft === undefined) return;
    const n = parseSide(draft);
    if (n === undefined) return;
    setDraft(undefined);
    if (n !== value) onCommit(n);
  };
  return (
    <input
      aria-label={label}
      aria-invalid={invalid || undefined}
      title={
        invalid
          ? `A whole number of CSS pixels, from ${SIDE.min} to ${SIDE.max}`
          : undefined
      }
      inputMode="numeric"
      spellCheck={false}
      placeholder={
        placeholder === undefined ? label : String(Math.round(placeholder))
      }
      value={draft ?? (value === undefined ? "" : String(value))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape" && draft !== undefined) {
          e.preventDefault();
          setDraft(undefined);
        }
      }}
    />
  );
}
