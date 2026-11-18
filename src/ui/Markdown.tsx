import { Fragment, isValidElement, memo, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import type { Element } from "hast";
import { invoke } from "@tauri-apps/api/core";
import { Check, CodeXml, Copy, Image as ImageIcon, Workflow } from "lucide-react";
import "katex/dist/katex.min.css";
import { PathLink, PreviewLink } from "./previewContext";
import { splitBlocks, type Blocks } from "./markdownBlocks";
import { languageOf, rehypePlugins, remarkPlugins } from "./markdownPipeline";
import { drawDiagram, drawnAlready, subscribeTheme, themeNow, type Drawing } from "./mermaid";
import { errorText } from "../hermes/values";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? textOf(node.props.children) : "";
}

function useDrawing(source: string, wanted: boolean, box: RefObject<HTMLElement | null>): Drawing | undefined {
  const theme = useSyncExternalStore(subscribeTheme, themeNow, themeNow);
  const [drawn, setDrawn] = useState<{ source: string; drawing: Drawing }>();
  const already = wanted ? drawnAlready(source, theme) : undefined;
  useEffect(() => {
    if (!wanted || already || !box.current) return;
    let live = true;
    const draw = () => void drawDiagram(source, theme).then((drawing) => live && setDrawn({ source, drawing }));
    if (typeof IntersectionObserver === "undefined") {
      draw();
      return () => void (live = false);
    }
    const view = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      view.disconnect();
      draw();
    });
    view.observe(box.current);
    return () => {
      live = false;
      view.disconnect();
    };
  }, [source, theme, wanted, already, box]);
  return already ?? (wanted && drawn?.source === source ? drawn.drawing : undefined);
}

function CodeBlock({ code, children }: { code: Element | undefined; children?: ReactNode }) {
  const language = (code && languageOf(code)) || "";
  const box = useRef<HTMLDivElement>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [showSource, setShowSource] = useState(false);
  const diagram = language === "mermaid" && code?.properties.dataGrowing === undefined;
  const drawing = useDrawing(diagram ? textOf(children) : "", diagram, box);
  const svg = drawing && "svg" in drawing ? drawing.svg : undefined;
  return (
    <div className="code" ref={box}>
      <div className="code-head">
        <span>{language}</span>
        {svg !== undefined && (
          <button className="code-view" onClick={() => setShowSource(!showSource)}>
            {showSource ? <Workflow size={13} /> : <CodeXml size={13} />}
            {showSource ? "Diagram" : "Source"}
          </button>
        )}
        <button
          className="code-copy"
          onClick={() => {
            const show = (state: "copied" | "failed") => {
              setCopy(state);
              setTimeout(() => setCopy("idle"), 1200);
            };
            navigator.clipboard.writeText(textOf(children)).then(
              () => show("copied"),
              () => show("failed"),
            );
          }}
        >
          {copy === "copied" ? <Check size={13} /> : <Copy size={13} />}
          {copy === "copied" ? "Copied" : copy === "failed" ? "Couldn't copy" : "Copy"}
        </button>
      </div>
      {drawing && "note" in drawing && <div className="code-note">{drawing.note}</div>}
      {svg !== undefined && !showSource ? <div className="code-diagram" dangerouslySetInnerHTML={{ __html: svg }} /> : <pre>{children}</pre>}
    </div>
  );
}

/** react-markdown has already emptied `data:` and other sources it doesn't allow. */
function MarkdownImage({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  const [load, setLoad] = useState<"loading" | { dataUrl: string } | { failed: string }>();
  if (!src) return <img alt={alt} title={title} />;
  if (typeof load === "object" && "dataUrl" in load) return <img src={load.dataUrl} alt={alt} title={title} />;
  let host = src;
  try {
    host = new URL(src, location.href).host || src;
  } catch {}
  const image = `${alt ? `${alt}: image` : "Image"} from ${host}`;
  return (
    <button
      type="button"
      className="md-image"
      title={src}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (load === "loading") return;
        setLoad("loading");
        // `//host/p.png` has no scheme for Rust to read; the app's own page is `tauri:` on Linux, so it can't lend one.
        invoke<string>("markdown_image_load", { url: src.startsWith("//") ? `https:${src}` : src }).then(
          (dataUrl) => setLoad({ dataUrl }),
          (error: unknown) => setLoad({ failed: errorText(error) }),
        );
      }}
    >
      <ImageIcon size={13} />
      {load === "loading" ? `${image}, loading…` : load ? `${image} didn't load. ${load.failed} Click to try again.` : `${image}, click to load`}
    </button>
  );
}

// Made once, not on each render: a new `pre` function is a new component type to React, which remounts every code
// block on each streamed delta.
const components: Components = {
  pre: ({ node, children }) => <CodeBlock code={node?.children.find((child) => child.type === "element")}>{children}</CodeBlock>,
  a: ({ node, href, title, children }) => {
    const { dataPath, dataFolder } = node?.properties ?? {};
    return typeof dataPath === "string" ? (
      <PathLink written={dataPath} folder={dataFolder !== undefined} title={title}>
        {children}
      </PathLink>
    ) : (
      <PreviewLink href={href} title={title}>
        {children}
      </PreviewLink>
    );
  },
  img: ({ src, alt, title }) => {
    const address = typeof src === "string" ? src : undefined;
    return <MarkdownImage key={address} src={address} alt={alt} title={title} />;
  },
};

const Part = memo(
  function Part({ text, query, growing, live }: { text: string; query: string; growing: boolean; live: boolean }) {
    const [, guessed] = useReducer((n: number) => n + 1, 0);
    const plugins = useMemo(() => rehypePlugins(query, growing ? text : undefined, live ? guessed : undefined), [query, growing, text, live]);
    return (
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={plugins} components={components}>
        {text}
      </ReactMarkdown>
    );
  },
  (a, b) => a.text === b.text && a.query === b.query && a.growing === b.growing,
);

export const Markdown = memo(function Markdown({ text, query = "", streaming = false }: { text: string; query?: string; streaming?: boolean }) {
  const streamed = useRef(false);
  const split = useRef<Blocks | undefined>(undefined);
  streamed.current ||= streaming;
  if (!streamed.current) return <Part text={text} query={query} growing={false} live={false} />;
  const blocks = (split.current = splitBlocks(text, split.current));
  if (blocks.whole) return <Part text={text} query={query} growing={streaming && !!blocks.blocks[blocks.blocks.length - 1]?.open} live={streaming} />;
  const last = blocks.blocks.length - 1;
  // A "\n" between blocks, as between the top-level elements of the text rendered in one piece.
  return blocks.blocks.map((b, i) => (
    <Fragment key={i}>
      {i > 0 && "\n"}
      <Part text={b.text} query={query} growing={streaming && i === last && b.open} live={streaming} />
    </Fragment>
  ));
});
