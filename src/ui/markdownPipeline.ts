import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import katex from "katex";
import { fromHtmlIsomorphic } from "hast-util-from-html-isomorphic";
import { toText } from "hast-util-to-text";
import { SKIP, visit } from "unist-util-visit";
import type { Element, ElementContent, Root } from "hast";
import type { VFile } from "vfile";
import { escapeRe } from "./bits";
import { remarkTranscriptSyntax } from "./markdownMath";
import { findPaths, hrefPath, type PathMention } from "../hermes/paths";

type HastNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

const classes = (node: { properties?: Record<string, unknown> }) => {
  const className = node.properties?.className;
  return Array.isArray(className) ? className.map(String) : [];
};

/** Typeset math is left alone: its text is KaTeX's glyphs and a copy of the TeX for screen readers, not words to find. */
function rehypeFind(query: string) {
  return () => (tree: HastNode) => {
    if (!query) return;
    const re = new RegExp(`(${escapeRe(query)})`, "gi");
    const walk = (node: HastNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child): HastNode[] => {
        if (child.type !== "text" || !child.value) {
          if (!classes(child).some((c) => c.startsWith("katex"))) walk(child);
          return [child];
        }
        return child.value
          .split(re)
          .flatMap((part, i): HastNode[] =>
            !part ? [] : i % 2 ? [{ type: "element", tagName: "mark", properties: { className: ["hit"] }, children: [{ type: "text", value: part }] }] : [{ type: "text", value: part }],
          );
      });
    };
    walk(tree);
  };
}

const rehypePaths = () => (tree: HastNode) => {
  const data = (m: PathMention) => ({ dataPath: m.written, ...(m.folder && { dataFolder: true }) });
  // A word that runs on into what is beside it is only part of a path: `src/__init__.py` is `src/`, then `init` in
  // bold, then `.py`, and `src/` alone would open the wrong place.
  const runsOn = (n: HastNode | undefined, side: "before" | "after") => {
    if (n?.type === "element") return n.tagName !== "br";
    const v = n?.type === "text" ? (n.value ?? "") : "";
    return side === "before" ? /[\p{L}\p{N}_~/.-]$/u.test(v) : /^(?:[\p{L}\p{N}_~/-]|\.[\p{L}\p{N}])/u.test(v);
  };
  const walk = (node: HastNode, before = false, after = false) => {
    if (!node.children) return;
    const where = node.tagName === "code" ? "code" : "prose";
    const siblings = node.children;
    const glued = (i: number, side: "before" | "after") =>
      side === "before" ? (i === 0 ? before : runsOn(siblings[i - 1], side)) : i === siblings.length - 1 ? after : runsOn(siblings[i + 1], side);
    node.children = siblings.flatMap((child, i): HastNode[] => {
      if (child.type === "text" && child.value) {
        const text = child.value;
        const spans = findPaths(text, where).filter((s) => !(s.start === 0 && glued(i, "before")) && !(s.end === text.length && glued(i, "after")));
        if (!spans.length) return [child];
        const out: HastNode[] = [];
        let at = 0;
        for (const s of spans) {
          if (s.start > at) out.push({ type: "text", value: text.slice(at, s.start) });
          out.push({ type: "element", tagName: "a", properties: data(s.mention), children: [{ type: "text", value: text.slice(s.start, s.end) }] });
          at = s.end;
        }
        if (at < text.length) out.push({ type: "text", value: text.slice(at) });
        return out;
      }
      if (child.tagName === "a") {
        const { href, ...rest } = child.properties ?? {};
        const mention = typeof href === "string" ? hrefPath(href) : undefined;
        if (mention) child.properties = { ...rest, ...data(mention) };
      } else if (child.tagName !== "pre" && !classes(child).some((c) => c.startsWith("katex") || c === "language-math")) walk(child, glued(i, "before"), glued(i, "after"));
      return [child];
    });
  };
  walk(tree);
};

function lru<V>(limit: number) {
  const held = new Map<string, { value: V; weight: number }>();
  let weights = 0;
  return {
    get(key: string): V | undefined {
      const hit = held.get(key);
      if (!hit) return undefined;
      held.delete(key);
      held.set(key, hit);
      return hit.value;
    },
    set(key: string, value: V, weight: number) {
      held.set(key, { value, weight });
      weights += weight;
      for (const [old, { weight }] of held) {
        if (weights <= limit) break;
        held.delete(old);
        weights -= weight;
      }
    },
  };
}

// The highlighter is made once: rehype-highlight builds a fresh highlight.js instance, with every grammar to compile
// again, each time the plugin is attached, and ReactMarkdown attaches its plugins on every render.
const highlightCode = rehypeHighlight({ detect: true });

const highlighted = lru<{ className: unknown; children: ElementContent[] }>(500_000);

export const HIGHLIGHT_MAX_CHARS = 100_000;

/** An untagged block's language is guessed from this much of its start, since the guess runs every grammar over it. */
const GUESS_FROM_CHARS = 4_000;

const guessing = (code: Element) => !classes(code).some((c) => /^(lang-|language-|no-?highlight$)/.test(c));

function highlight(code: Element, pre: Element, file: VFile, guessed?: () => void) {
  const text = toText(code, { whitespace: "pre" });
  if (text.length > HIGHLIGHT_MAX_CHARS) return plain(code);
  const one = (code: Element) => highlightCode({ type: "root", children: [{ ...pre, children: [code] }] }, file);
  const run = (code: Element) => {
    if (guessing(code) && text.length > GUESS_FROM_CHARS) {
      const start: Element = { ...code, properties: { ...code.properties, className: classes(code) }, children: [{ type: "text", value: text.slice(0, GUESS_FROM_CHARS) }] };
      one(start);
      const language = classes(start).find((c) => c.startsWith("language-"));
      if (!language) return plain(code);
      code.properties.className = [...classes(code), language];
    }
    one(code);
  };
  const key = JSON.stringify(code.properties.className ?? null) + "\n" + text;
  const hit = highlighted.get(key);
  if (!hit && guessed && guessing(code)) {
    const later = structuredClone(code);
    plain(code);
    setTimeout(() => {
      if (!highlighted.get(key)) {
        run(later);
        highlighted.set(key, { className: later.properties.className, children: later.children }, key.length);
      }
      guessed();
    });
    return;
  }
  if (!hit) {
    run(code);
    highlighted.set(key, structuredClone({ className: code.properties.className, children: code.children }), key.length);
    return;
  }
  const copy = structuredClone(hit);
  code.properties.className = copy.className as Element["properties"]["className"];
  code.children = copy.children;
}

function plain(code: Element) {
  const className = classes(code);
  if (!className.includes("hljs") && !className.includes("no-highlight") && !className.includes("nohighlight"))
    code.properties.className = ["hljs", ...className];
}

const typesetMath = lru<ElementContent[]>(2_000_000);

const frozen = <T,>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) Object.values(Object.freeze(value)).forEach(frozen);
  return value;
};

/** `tex` typeset, or undefined for what KaTeX can't take; TeX it can't parse comes back as itself, in red. */
function typeset(tex: string, display: boolean): ElementContent[] | undefined {
  const key = (display ? "display\n" : "inline\n") + tex;
  let math = typesetMath.get(key);
  if (!math) {
    let html: string;
    try {
      html = katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: "ignore" });
    } catch {
      return undefined;
    }
    math = frozen(fromHtmlIsomorphic(html, { fragment: true }).children as ElementContent[]);
    typesetMath.set(key, math, html.length);
  }
  return math;
}

/**
 * Rehype plugin: highlights each code block, guessing the language of untagged ones, and typesets math (mdast-util-
 * math's `<code class="language-math">`, a block's in a `<pre>`).
 */
function rehypeCode(source?: string, guessed?: () => void) {
  const growing = (node: Element) => source !== undefined && !source.slice(node.position?.end.offset ?? 0).trim();
  return () => (tree: Root, file: VFile) =>
    visit(tree, "element", (node, index, parent) => {
      const code = node.tagName === "pre" ? node.children[0] : node;
      if (code?.type !== "element" || code.tagName !== "code") return;
      const math = classes(code).includes("language-math");
      if (!math && code === node) return;
      if (growing(node)) {
        if (!math) plain(code);
        code.properties.dataGrowing = true;
        return SKIP;
      }
      if (!math) {
        highlight(code, node, file, guessed);
        return SKIP;
      }
      const formula = typeset(toText(code, { whitespace: "pre" }).trim(), code !== node || classes(code).includes("math-display"));
      if (!formula || !parent || index === undefined) return SKIP;
      parent.children.splice(index, 1, ...formula);
      return [SKIP, index + formula.length];
    });
}

export const remarkPlugins = [remarkTranscriptSyntax, remarkBreaks];

const highlightOnly = [rehypeCode(), rehypePaths];

export const rehypePlugins = (query: string, growingIn?: string, guessed?: () => void) =>
  query || growingIn !== undefined || guessed ? [rehypeCode(growingIn, guessed), rehypePaths, ...(query ? [rehypeFind(query)] : [])] : highlightOnly;
