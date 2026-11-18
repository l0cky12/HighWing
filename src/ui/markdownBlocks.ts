import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import { transcriptSyntax } from "./markdownMath";

export type Block = { start: number; text: string; refs: boolean; open: boolean };

/**
 * `whole`: a block defines a link reference or footnote, which can change how any other block renders, so the text has
 * to be rendered in one piece.
 */
export type Blocks = { text: string; blocks: Block[]; whole: boolean };

const fences = new WeakMap<object, number>();
const countFence = (type: "code" | "math") =>
  function (this: { stack: { type: string }[] }) {
    // The node, under the fragment its content is gathered into by the time the closing fence comes.
    const node = [...this.stack].reverse().find((n) => n.type === type);
    if (node) fences.set(node, (fences.get(node) ?? 0) + 1);
  };
const countFences = { enter: { codeFencedFence: countFence("code"), mathFlowFence: countFence("math") } };

const options = { ...transcriptSyntax, mdastExtensions: [...transcriptSyntax.mdastExtensions, countFences] };

function endsInOpenCode(node: Nodes, source: string): boolean {
  for (;;) {
    if (node.type === "code" || node.type === "math")
      return !source.slice(node.position?.end.offset ?? source.length).trim() && (fences.get(node) ?? 0) < 2;
    if (!("children" in node) || !node.children.length) return false;
    node = node.children[node.children.length - 1];
  }
}

const definesRefs = (node: Nodes): boolean =>
  node.type === "definition" || node.type === "footnoteDefinition" || ("children" in node && node.children.some(definesRefs));

function lex(text: string, base: number): Block[] {
  const blocks: Block[] = [];
  const ends: number[] = [];
  for (const node of fromMarkdown(text, options).children) {
    const at = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? text.length;
    // From the start of its line: a fence or list indented a little keeps its indentation, which shapes its content.
    const start = blocks.length ? text.lastIndexOf("\n", at - 1) + 1 : 0;
    const last = blocks[blocks.length - 1];
    if (last && start <= last.start) {
      last.refs ||= definesRefs(node);
      last.open = endsInOpenCode(node, text);
      ends[ends.length - 1] = Math.max(ends[ends.length - 1], end);
      continue;
    }
    blocks.push({ start, text: "", refs: definesRefs(node), open: endsInOpenCode(node, text) });
    ends.push(end);
  }
  for (const [i, b] of blocks.entries()) {
    b.text = text.slice(b.start, ends[i]);
    b.start += base;
  }
  return blocks;
}

/**
 * Text added at the end can grow or end the last block, or turn it into part of the block before (a paragraph "2"
 * becomes item 2 of the list above it once "." comes). It can't change how a block's first line reads, so nothing
 * before the second last block moves.
 */
export function splitBlocks(text: string, prev?: Blocks): Blocks {
  // The parser drops a byte order mark at the start of a document before counting offsets, and one starting a later
  // block would be dropped there too were the block parsed on its own: such a text renders in one piece.
  if (text.includes("\uFEFF")) return { text, blocks: [], whole: true };
  const from = prev && text.startsWith(prev.text) ? (prev.blocks[prev.blocks.length - 2]?.start ?? 0) : 0;
  const kept = from ? prev!.blocks.slice(0, -2) : [];
  const blocks = [...kept, ...lex(text.slice(from), from)];
  return { text, blocks, whole: blocks.some((b) => b.refs) };
}
