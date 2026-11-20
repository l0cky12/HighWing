// The document formats the Preview draws itself (ADR 0186): a PDF page by page with pdf.js, a Word file converted to
// HTML by mammoth. Each is known by its name or type and checked by its first bytes, since both come from files the
// owner didn't make.

export type DocumentFormat = "pdf" | "docx";

const FORMATS: Record<DocumentFormat, { extension: string; mime: string; magic: number[]; what: string }> = {
  pdf: { extension: "pdf", mime: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46, 0x2d], what: "a PDF" },
  // A .docx is a zip archive; mammoth says so when the archive inside isn't a Word document.
  docx: {
    extension: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    magic: [0x50, 0x4b, 0x03, 0x04],
    what: "a Word document",
  },
};

/** The most of a document the Preview reads: Hermes's own limit for a file it previews as an image. */
export const DOCUMENT_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

const formats = Object.keys(FORMATS) as DocumentFormat[];

/** The document format a file is, by its extension or else its type. */
export function documentFormatOf(name: string, mime?: string): DocumentFormat | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase();
  return formats.find((f) => FORMATS[f].extension === ext) ?? formats.find((f) => FORMATS[f].mime === mime?.toLowerCase());
}

/** Whether `bytes` start the way a file of `format` does. */
export const looksLike = (format: DocumentFormat, bytes: Uint8Array) => FORMATS[format].magic.every((b, i) => bytes[i] === b);

/** Why bytes named as `format` can't be shown as it. */
export const notA = (format: DocumentFormat) => `This file is named like ${FORMATS[format].what}, but its bytes aren't one.`;

/** The most a Word file may unpack to before mammoth opens it: a small zip can unpack to gigabytes. */
export const DOCX_UNPACKED_MAX_BYTES = 100 * 1024 * 1024;

/**
 * What a zip archive's files unpack to, in all, counted by unpacking them, since its directory's sizes can lie: the
 * number, or `over` as soon as it passes `max`, or undefined when it isn't a zip this can read (no end record, a
 * directory that doesn't end where the end record says, Zip64, or a method other than stored or deflated, which a
 * Word file never uses). Each file is the bytes the zip's directory points at, as mammoth's unzip reads them.
 */
export async function zipUnpacked(bytes: Uint8Array, max: number): Promise<number | "over" | undefined> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  let end = bytes.length - 22;
  // The end record is the last 22 bytes, unless a comment of up to 64 KB follows it.
  while (end >= Math.max(0, bytes.length - 22 - 0xffff) && u32(end) !== 0x06054b50) end--;
  if (end < 0 || end < bytes.length - 22 - 0xffff) return undefined;
  let at = u32(end + 16);
  // mammoth's unzip moves every offset by however far the directory's offset and size miss the end record.
  if (at + u32(end + 12) !== end) return undefined;
  let total = 0;
  // Every entry up to the end record, not the count the end record gives, since mammoth's unzip reads them all.
  for (; at + 46 <= end && u32(at) === 0x02014b50; at += 46 + u16(at + 28) + u16(at + 30) + u16(at + 32)) {
    const [method, packed, local] = [u16(at + 10), u32(at + 20), u32(at + 42)];
    if (local + 30 > bytes.length || u32(local) !== 0x04034b50) return undefined;
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    const data = bytes.subarray(start, start + packed);
    if (method === 0) total += data.length;
    else if (method !== 8) return undefined;
    else {
      const source = new ReadableStream<Uint8Array<ArrayBuffer>>({ start: (c) => (c.enqueue(data.slice()), c.close()) });
      const reader = source.pipeThrough(new DecompressionStream("deflate-raw")).getReader();
      try {
        for (let r = await reader.read(); !r.done; r = await reader.read()) {
          total += r.value.length;
          if (total > max) return "over";
        }
      } catch {
        return undefined;
      } finally {
        void reader.cancel().catch(() => {});
      }
    }
    if (total > max) return "over";
  }
  return at === end ? total : undefined;
}

/** The bytes of a base64 `data:` URL, or undefined when it isn't one. */
export function dataUrlBytes(url: string): Uint8Array | undefined {
  const m = /^data:[^,]*;base64,/.exec(url);
  if (!m) return undefined;
  try {
    return Uint8Array.from(atob(url.slice(m[0].length)), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/** What separates the fields of a table file: a comma, a tab, or a semicolon, as Excel writes CSV where the decimal mark is a comma. */
export type Delimiter = "," | "\t" | ";";

/**
 * A CSV or TSV file as rows of fields, the first its header. `width`: the most fields any row has. `cut`: the read
 * stopped part way through the file, so its last row, likely incomplete, was dropped.
 */
export type Table = { delimiter: Delimiter; rows: string[][]; width: number; cut: boolean };

/**
 * The rows of delimited text, read as RFC 4180 says: a field in double quotes holds delimiters, line breaks and quotes
 * written twice. It is lenient where a bot's file breaks the rules: a quote inside an unquoted field is kept as it is,
 * text after a closing quote joins the field, and a quote never closed runs to the end. A blank line is no row, and a
 * leading byte-order mark is no text. `ended`: the text stops at the end of a row, not part way through one.
 */
export function parseDelimited(text: string, delimiter: Delimiter, maxRows = Infinity): { rows: string[][]; ended: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRow = () => {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    field = "";
  };
  while (at < text.length && rows.length < maxRows) {
    if (text[at] === '"' && field === "") {
      for (at++; ; ) {
        const close = text.indexOf('"', at);
        if (close < 0) {
          field += text.slice(at);
          at = text.length;
          break;
        }
        field += text.slice(at, close);
        at = close + 1;
        if (text[at] !== '"') break;
        field += '"';
        at++;
      }
      continue;
    }
    let stop = at;
    while (stop < text.length && text[stop] !== delimiter && text[stop] !== "\n" && text[stop] !== "\r") stop++;
    field += text.slice(at, stop);
    at = stop;
    if (at === text.length) break;
    if (text[at] === delimiter) {
      row.push(field);
      field = "";
      at++;
      continue;
    }
    at += text[at] === "\r" && text[at + 1] === "\n" ? 2 : 1;
    endRow();
  }
  const ended = row.length === 0 && field === "";
  if (!ended && rows.length < maxRows) endRow();
  return { rows, ended };
}

/** The rows sampled to tell a file's delimiter. */
const SAMPLE_ROWS = 20;

/**
 * The delimiter a table file uses: a tab for a `.tsv`, and otherwise whichever of comma, tab and semicolon splits its
 * first rows into the same number of fields, more than one. When none does, the one that splits the header into the
 * most fields, and a comma when nothing splits it.
 */
export function delimiterOf(name: string, text: string): Delimiter {
  if (/\.tsv$/i.test(name)) return "\t";
  let best: Delimiter = ",";
  let bestScore = 0;
  for (const d of [",", "\t", ";"] as const) {
    const { rows, ended } = parseDelimited(text.slice(0, 64 * 1024), d, SAMPLE_ROWS);
    // The sample can stop part way through its last row.
    if (!ended && rows.length > 1) rows.pop();
    const width = rows[0]?.length ?? 0;
    const score = width < 2 ? 0 : width + (rows.every((r) => r.length === width) ? 1e6 : 0);
    if (score > bestScore) [best, bestScore] = [d, score];
  }
  return best;
}

/** A CSV or TSV file's text as a table. `cut`: the text is only the file's first part. */
export function parseTable(name: string, text: string, cut: boolean): Table {
  const delimiter = delimiterOf(name, text);
  const { rows, ended } = parseDelimited(text, delimiter);
  if (cut && !ended) rows.pop();
  return { delimiter, rows, width: rows.reduce((w, r) => Math.max(w, r.length), 0), cut };
}

/**
 * Cells as tab-separated text, the way a spreadsheet copies them, so they paste back into one cell for cell. A cell
 * holding a tab, a line break or a quote goes in quotes, with its quotes written twice.
 */
export const asTsv = (cells: string[][]) =>
  cells.map((r) => r.map((c) => (/[\t\n\r"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join("\t")).join("\n");
