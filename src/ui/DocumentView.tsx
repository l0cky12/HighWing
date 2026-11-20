import { memo, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { AlertTriangle } from "lucide-react";
import { asTsv, type DocumentFormat, type Table } from "../hermes/documents";
import { sandboxedHtml } from "../hermes/preview";
import { errorText, formatBytes } from "../hermes/values";
import { Spinner } from "./bits";

const PDF_MAX_PAGES = 100;

const DOCX_STYLE = `<style>
body { margin: 0; padding: 28px 32px 48px; font: 15px/1.6 system-ui, sans-serif; color: #1f2328; background: #fff; overflow-wrap: anywhere; }
main { max-width: 760px; margin: 0 auto; }
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; margin: 12px 0; }
td, th { border: 1px solid #d0d7de; padding: 4px 8px; vertical-align: top; }
td > p, th > p { margin: 0; }
</style>`;

type Drawn = { loading: true } | { error: string } | { pages: number } | { html: string };

export function DocumentView({ format, bytes, name, size }: { format: DocumentFormat; bytes: Uint8Array; name: string; size: number }) {
  const [state, setState] = useState<Drawn>({ loading: true });
  const pages = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    let destroy = () => {};
    const failed = (e: unknown) => live && setState({ error: errorText(e) });
    import("./documentRender").then(async ({ openPdf, docxHtml }) => {
      if (format === "docx") {
        const html = await docxHtml(bytes);
        if (live) setState({ html });
        return;
      }
      const task = openPdf(bytes);
      destroy = () => void task.destroy();
      if (!live) return destroy();
      const pdf = await task.promise;
      setState({ pages: pdf.numPages });
      const into = pages.current;
      for (let n = 1; n <= Math.min(pdf.numPages, PDF_MAX_PAGES) && live && into; n++) {
        const page = await pdf.getPage(n);
        const width = (into.clientWidth || 800) * (window.devicePixelRatio || 1);
        const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.setAttribute("role", "img");
        canvas.setAttribute("aria-label", `Page ${n} of ${pdf.numPages}`);
        into.append(canvas);
        await page.render({ canvas, viewport }).promise;
      }
    }).catch(failed);
    return () => {
      live = false;
      destroy();
    };
  }, [format, bytes]);

  if ("error" in state)
    return (
      <div className="preview-state preview-error" role="alert">
        <AlertTriangle size={18} />
        <div>
          <div className="preview-state-title">Couldn't show this document</div>
          <div>{state.error}</div>
        </div>
      </div>
    );
  const cut = "pages" in state && state.pages > PDF_MAX_PAGES;
  return (
    <div className="preview-text">
      <div className="preview-bar">
        <span className="preview-foot">
          {format === "pdf" ? "PDF" : "Word document"} · {formatBytes(size)}
          {"pages" in state && ` · ${state.pages} ${state.pages === 1 ? "page" : "pages"}`}
        </span>
        {cut && <span className="preview-truncated">Showing the first {PDF_MAX_PAGES} pages.</span>}
      </div>
      {"loading" in state && (
        <div className="preview-state" role="status">
          <Spinner /> Drawing {name.split("/").pop()}…
        </div>
      )}
      {format === "pdf" ? (
        <div className="preview-pdf" ref={pages} />
      ) : (
        "html" in state && (
          <iframe className="preview-frame doc" title={`Rendered ${name}`} sandbox="" referrerPolicy="no-referrer" srcDoc={sandboxedHtml(DOCX_STYLE + state.html)} />
        )
      )}
    </div>
  );
}

/** About the most cells a table draws (ADR 0236): the rows that would pass it are left out. */
const TABLE_MAX_CELLS = 10_000;

type Cell = { row: number; col: number };
type Selection = { anchor: Cell; focus: Cell };

const DELIMITED: Record<Table["delimiter"], string> = { ",": "CSV", "\t": "Tab-separated", ";": "Semicolon-separated" };
const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const span = (a: number, b: number) => [Math.min(a, b), Math.max(a, b)] as const;

/**
 * A row of a table, drawn again only when the columns selected in it change. `cols`: the first and last selected, or
 * undefined when none is.
 */
const TableRow = memo(function TableRow({ cells, row, width, cols }: { cells: string[]; row: number; width: number; cols?: readonly [number, number] }) {
  const Tag = row === 0 ? "th" : "td";
  return (
    <tr>
      {Array.from({ length: width }, (_, col) => {
        const selected = !!cols && col >= cols[0] && col <= cols[1];
        return (
          <Tag key={col} data-row={row} data-col={col} aria-selected={selected} className={selected ? "selected" : undefined}>
            {cells[col] ?? ""}
          </Tag>
        );
      })}
    </tr>
  );
});

/**
 * A CSV or TSV file as a table under a sticky header row, up to `TABLE_MAX_CELLS` cells. A drag, a Shift+click or the
 * Shift+arrow keys select a range of cells, which Ctrl+C copies as tab-separated text. Open as text shows the file's text.
 */
export function TableView({ table, text, size, truncated }: { table: Table; text: string; size: number; truncated: boolean }) {
  const [textChosen, setAsText] = useState(false);
  const [sel, setSel] = useState<Selection>();
  const grid = useRef<HTMLTableElement>(null);
  const width = Math.max(table.width, 1);
  const drawn = table.rows.slice(0, 1 + Math.max(1, Math.floor(TABLE_MAX_CELLS / width)));
  const records = table.rows.length - 1;
  const shown = drawn.length - 1;
  // The header and one row must fit in the cells drawn, or the file shows only as text.
  const tooWide = width * 2 > TABLE_MAX_CELLS;
  const asText = textChosen || tooWide;

  const focus = sel?.focus;
  useEffect(() => {
    if (focus) grid.current?.querySelector(`[data-row="${focus.row}"][data-col="${focus.col}"]`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [focus]);

  const cellAt = (e: MouseEvent): Cell | undefined => {
    const el = (e.target as Element).closest("[data-row]");
    return el ? { row: Number(el.getAttribute("data-row")), col: Number(el.getAttribute("data-col")) } : undefined;
  };
  const onMouseDown = (e: MouseEvent) => {
    const cell = cellAt(e);
    if (e.button !== 0 || !cell) return;
    // The table selects cells, not the text in them.
    e.preventDefault();
    grid.current?.focus();
    setSel((s) => (e.shiftKey && s ? { ...s, focus: cell } : { anchor: cell, focus: cell }));
  };
  const onMouseOver = (e: MouseEvent) => {
    const cell = cellAt(e);
    if (e.buttons & 1 && cell) setSel((s) => s && { ...s, focus: cell });
  };
  const copy = (s: Selection) => {
    const [r0, r1] = span(s.anchor.row, s.focus.row);
    const [c0, c1] = span(s.anchor.col, s.focus.col);
    const cells = drawn.slice(r0, r1 + 1).map((r) => Array.from({ length: c1 - c0 + 1 }, (_, i) => r[c0 + i] ?? ""));
    void navigator.clipboard?.writeText(asTsv(cells)).catch(() => {});
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const last = { row: drawn.length - 1, col: width - 1 };
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSel({ anchor: { row: 0, col: 0 }, focus: last });
      return;
    }
    if (mod && e.key.toLowerCase() === "c" && sel) {
      e.preventDefault();
      copy(sel);
      return;
    }
    if (e.key === "Escape" && sel) {
      e.stopPropagation();
      setSel(undefined);
      return;
    }
    const step = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (!step) return;
    e.preventDefault();
    const from = sel?.focus ?? { row: 0, col: 0 };
    const to = sel
      ? { row: Math.min(Math.max(from.row + step[0], 0), last.row), col: Math.min(Math.max(from.col + step[1], 0), last.col) }
      : from;
    setSel(e.shiftKey && sel ? { ...sel, focus: to } : { anchor: to, focus: to });
  };

  const rows = sel && span(sel.anchor.row, sel.focus.row);
  const cols = sel && span(sel.anchor.col, sel.focus.col);
  return (
    <div className="preview-text">
      <div className="preview-bar">
        <span className="preview-foot">
          {DELIMITED[table.delimiter]} · {formatBytes(size)} · {count(Math.max(records, 0), "row", "rows")}
          {truncated && " read"} · {count(table.width, "column", "columns")}
        </span>
        {tooWide ? (
          <span className="preview-truncated">This file has {count(width, "column", "columns")}, too many to draw as a table.</span>
        ) : truncated ? (
          <span className="preview-truncated">
            Showing the first {count(shown, "row", "rows")}, from the first {formatBytes(text.length)} of {formatBytes(size)}.
          </span>
        ) : (
          shown < records && <span className="preview-truncated">Showing the first {count(shown, "row", "rows")} of {records.toLocaleString("en-US")}.</span>
        )}
        {!tooWide && (
          <button className="link-btn preview-table-switch" aria-pressed={asText} onClick={() => setAsText(!asText)}>
            {asText ? "Open as table" : "Open as text"}
          </button>
        )}
      </div>
      {asText ? (
        <pre className="preview-pre">{text}</pre>
      ) : table.rows.length === 0 ? (
        <div className="preview-state" role="note">
          This file has no rows.
        </div>
      ) : (
        <div className="preview-table">
          <table
            ref={grid}
            role="grid"
            aria-multiselectable
            aria-label="Table"
            tabIndex={0}
            onMouseDown={onMouseDown}
            onMouseOver={onMouseOver}
            onKeyDown={onKeyDown}
          >
            <thead>
              <TableRow cells={drawn[0]} row={0} width={width} cols={rows && rows[0] === 0 ? cols : undefined} />
            </thead>
            <tbody>
              {drawn.slice(1).map((cells, i) => (
                <TableRow key={i} cells={cells} row={i + 1} width={width} cols={rows && i + 1 >= rows[0] && i + 1 <= rows[1] ? cols : undefined} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
