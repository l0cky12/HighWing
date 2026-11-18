// Hermes's computer_use in the transcript (ADR 0213). Stored history's `tool_call` wrapper is unwrapped in
// transport.ts, and a result is trimmed by `keptResult` before the chat keeps it.
import { isObj } from "./values";

/** Hermes's tool name (tools/computer_use, v0.23.2). */
export const COMPUTER_USE = "computer_use";

/** How much of a capture's element list the chat keeps. A long SOM list costs about 40 KB a step. */
export const KEPT_CAPTURE_CHARS = 2000;

const KEPT_META = ["mode", "width", "height", "elements"] as const;

/**
 * A `computer_use` result as the chat keeps it: the shape Hermes sent, less what nobody reads in a transcript. Image
 * parts and the duplicate `text_summary` go, a capture's text is cut to `KEPT_CAPTURE_CHARS`, and `meta` keeps the
 * capture's size. It stays Hermes's shape, so one reader serves live results and Saved copies alike. Only
 * `toolResultText` calls it, and its data-URL pass still runs after (ADR 0061).
 */
export function keptResult(result: unknown): unknown {
  if (!isObj(result) || result._multimodal !== true) return result;
  const { text_summary: _summary, content, meta, ...rest } = result;
  const texts = (Array.isArray(content) ? content : []).flatMap((part) =>
    isObj(part) && part.type === "text" && typeof part.text === "string" ? [{ type: "text", text: cut(part.text) }] : [],
  );
  const size = isObj(meta) ? Object.fromEntries(KEPT_META.flatMap((k) => (meta[k] === undefined ? [] : [[k, meta[k]]]))) : undefined;
  return { ...rest, content: texts, ...(size && { meta: size }) };
}

const cut = (text: string) => (text.length > KEPT_CAPTURE_CHARS ? `${text.slice(0, KEPT_CAPTURE_CHARS)}…` : text);
