import { GlobalWorkerOptions, getDocument, type PDFDocumentLoadingTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import mammoth from "mammoth/mammoth.browser.js";
import { DOCX_UNPACKED_MAX_BYTES, zipUnpacked } from "../hermes/documents";
import { formatBytes } from "../hermes/values";

GlobalWorkerOptions.workerSrc = workerUrl;

/** A copy of `bytes` the library may take: pdf.js moves its buffer to the worker, which would empty the view's own. */
const copy = (bytes: Uint8Array) => bytes.slice().buffer;

const assets = (folder: string) => new URL(`${import.meta.env.BASE_URL}pdfjs/${folder}/`, location.href).href;

export const openPdf = (bytes: Uint8Array): PDFDocumentLoadingTask =>
  getDocument({
    data: copy(bytes),
    wasmUrl: assets("wasm"),
    standardFontDataUrl: assets("standard_fonts"),
    cMapUrl: assets("cmaps"),
    iccUrl: assets("iccs"),
  });

/**
 * A Word document's body as HTML, its pictures inline as `data:` URLs. mammoth never reads files the document links to
 * (`externalFileAccess` is off by default).
 */
export async function docxHtml(bytes: Uint8Array): Promise<string> {
  const unpacked = await zipUnpacked(bytes, DOCX_UNPACKED_MAX_BYTES);
  if (unpacked === undefined) throw new Error("This file isn't a Word document the preview can read.");
  if (unpacked === "over") throw new Error(`It unpacks to more than ${formatBytes(DOCX_UNPACKED_MAX_BYTES)}, the most the preview opens of a Word document.`);
  return (await mammoth.convertToHtml({ arrayBuffer: copy(bytes) })).value;
}
