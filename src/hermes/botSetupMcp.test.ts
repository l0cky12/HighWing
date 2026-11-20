import { describe, expect, it } from "vitest";
import { addMcp, connected, mcpOffer, type McpSources } from "./botSetupMcp";
import type { CatalogEntry, McpChange, McpServer, ServerForm } from "./mcp";

const entry = (name: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  name,
  description: "",
  transport: "stdio",
  authType: "none",
  requiredEnv: [],
  command: "npx",
  args: ["-y", `@example/${name}`],
  needsInstall: false,
  bootstrap: [],
  postInstall: "",
  installed: false,
  ...extra,
});
const server = (name: string, extra: Partial<McpServer> = {}): McpServer => ({
  name,
  transport: "stdio",
  command: "uvx",
  args: [`${name}-mcp`],
  envKeys: [],
  auth: "none",
  enabled: true,
  toolFilter: false,
  changeable: true,
  ...extra,
});

const sources: McpSources = {
  catalog: [
    entry("airbnb"),
    entry("brave", { requiredEnv: [{ name: "BRAVE_API_KEY", prompt: "Your Brave key", required: true }, { name: "BRAVE_REGION", prompt: "", required: false }] }),
    entry("github", { transport: "http", url: "https://api.example.com/mcp", authType: "oauth", command: undefined, args: [] }),
    entry("built", { needsInstall: true, bootstrap: ["git clone https://example.com/built", "npm ci"], command: "node", args: ["built/index.js"] }),
  ],
  bots: {
    Research: {
      path: "/srv/hermes/profiles/research",
      servers: [
        server("search", { envKeys: ["SEARCH_KEY"], toolFilter: true }),
        server("notes", { transport: "http", url: "https://notes.example/mcp", auth: "header", command: undefined, args: [] }),
        server("ours", { command: "/srv/hermes/profiles/research/mcp-installs/ours/run", args: [] }),
        server("ours-arg", { command: "python3", args: ["/srv/hermes/profiles/research/tool.py"] }),
        server("neighbour", { command: "python3", args: ["/srv/hermes/profiles/research-2/tool.py"] }),
        server("linear", { transport: "http", url: "https://linear.example/mcp", auth: "oauth", command: undefined, args: [] }),
        server("plugged", { plugin: "acme", changeable: false }),
        server("odd name", { changeable: false }),
        server("mystery", { transport: "unknown", command: undefined, args: [] }),
      ],
    },
  },
};

describe("mcpOffer", () => {
  it("shows a catalog entry's command first, and asks Connect for its declared env vars", () => {
    expect(mcpOffer(sources, "airbnb")).toMatchObject({ kind: "catalog", runs: ["npx -y @example/airbnb"], secrets: [] });
    expect(mcpOffer(sources, "brave")).toMatchObject({
      kind: "catalog",
      secrets: [
        { key: "BRAVE_API_KEY", prompt: "Your Brave key", required: true },
        { key: "BRAVE_REGION", required: false },
      ],
    });
    expect(mcpOffer(sources, "built")?.runs).toEqual(["git clone https://example.com/built", "npm ci", "node built/index.js"]);
  });

  it("copies another bot's server as Hermes lists it, asking for every env var and bearer token afresh", () => {
    expect(mcpOffer(sources, "search", "Research")).toMatchObject({ kind: "copy", runs: ["uvx search-mcp"], secrets: [{ key: "SEARCH_KEY", required: true }], toolFilter: true });
    expect(mcpOffer(sources, "notes", "Research")).toMatchObject({ kind: "copy", runs: ["https://notes.example/mcp"], secrets: [{ key: "MCP_NOTES_API_KEY", required: true, bearer: true }] });
  });

  it("refuses a copy whose command or arguments point into the source bot's folder, and only that folder", () => {
    expect(mcpOffer(sources, "ours", "Research")).toMatchObject({ kind: "refused", why: "path" });
    expect(mcpOffer(sources, "ours-arg", "Research")).toMatchObject({ kind: "refused", why: "path" });
    expect(mcpOffer(sources, "neighbour", "Research")?.kind).toBe("copy");
  });

  it("compares paths after resolving `.`, `..`, repeated and trailing slashes, on folder boundaries, POSIX or Windows", () => {
    const judged = (folder: string, ...args: string[]) => {
      const s: McpSources = { catalog: [], bots: { Research: { path: folder, servers: [server("x", { command: "python3", args })] } } };
      return mcpOffer(s, "x", "Research")?.kind;
    };
    const refused = [
      "/srv/hermes/profiles/./research/run",
      "/srv/hermes/profiles/other/../research/run",
      "/srv//hermes/profiles/research//run",
      "/srv/hermes/profiles/research/",
      "/srv/hermes/profiles/research",
      "--dir=/srv/hermes/./profiles/research/x",
    ];
    for (const a of refused) expect([a, judged("/srv/hermes/profiles/research", a)]).toEqual([a, "refused"]);
    expect(judged("/srv/hermes/profiles/research/", "/srv/hermes/profiles/research/run")).toBe("refused");
    const allowed = ["/srv/hermes/profiles/research-2/run", "/srv/hermes/profiles/researcher", "/srv/hermes/profiles/research/../research-2/run", "/srv/hermes/profiles/./research2"];
    for (const a of allowed) expect([a, judged("/srv/hermes/profiles/research", a)]).toEqual([a, "copy"]);

    expect(judged("C:\\Users\\lena\\.hermes\\profiles\\research", "c:\\users\\lena\\.hermes\\profiles\\.\\research\\run.py")).toBe("refused");
    expect(judged("C:\\Users\\lena\\.hermes\\profiles\\research", "C:/Users/lena/.hermes/profiles/x/../research/run.py")).toBe("refused");
    expect(judged("C:\\Users\\lena\\.hermes\\profiles\\research", "C:\\Users\\lena\\.hermes\\profiles\\research-2\\run.py")).toBe("copy");
  });

  it("names an OAuth server, a plugin's, one whose name can't be sent and one Hermes can't say how it connects, without adding them", () => {
    expect(mcpOffer(sources, "github")).toMatchObject({ kind: "refused", why: "oauth" });
    expect(mcpOffer(sources, "linear", "Research")).toMatchObject({ kind: "refused", why: "oauth" });
    expect(mcpOffer(sources, "plugged", "Research")).toMatchObject({ kind: "refused", why: "plugin" });
    expect(mcpOffer(sources, "odd name", "Research")).toMatchObject({ kind: "refused", why: "name" });
    expect(mcpOffer(sources, "mystery", "Research")).toMatchObject({ kind: "refused", why: "transport" });
  });

  it("knows only what Hermes lists", () => {
    expect(mcpOffer(sources, "made-up")).toBeUndefined();
    expect(mcpOffer(sources, "airbnb", "Research")).toBeUndefined();
    expect(mcpOffer(sources, "search", "Nobody")).toBeUndefined();
  });
});

describe("addMcp", () => {
  const saved = (): McpChange => ({ kind: "saved", list: { profile: "p", servers: [], readAt: 0 } });
  const recorder = () => {
    const sent: unknown[] = [];
    return {
      sent,
      api: {
        add: async (_p: string, form: ServerForm) => (sent.push(["add", form]), saved()),
        install: async (_p: string, e: CatalogEntry, env: Record<string, string>) => (sent.push(["install", e.name, env]), saved()),
      },
    };
  };
  const offer = (name: string, from?: string) => {
    const o = mcpOffer(sources, name, from);
    if (!o || o.kind === "refused") throw new Error(`${name} can't be added`);
    return o;
  };

  it("waits on Connect and sends nothing while a value it needs is missing", async () => {
    const { api, sent } = recorder();
    expect(connected(offer("brave"), { BRAVE_REGION: "eu" })).toBe(false);
    expect(await addMcp(api, "p", "brave", offer("brave"), { BRAVE_API_KEY: "  " })).toEqual({ state: { kind: "connect" } });
    expect(await addMcp(api, "p", "search", offer("search", "Research"))).toEqual({ state: { kind: "connect" } });
    expect(sent).toEqual([]);
  });

  it("sends the values Connect took, never a value read, and waits for the reload once read back", async () => {
    const { api, sent } = recorder();
    expect(await addMcp(api, "p", "brave", offer("brave"), { BRAVE_API_KEY: "bk-1" })).toEqual({ state: { kind: "reload" } });
    expect(await addMcp(api, "p", "search", offer("search", "Research"), { SEARCH_KEY: "sk-2" })).toEqual({ state: { kind: "reload" } });
    expect(await addMcp(api, "p", "notes", offer("notes", "Research"), { MCP_NOTES_API_KEY: "nt-3" })).toEqual({ state: { kind: "reload" } });
    expect(sent).toEqual([
      ["install", "brave", { BRAVE_API_KEY: "bk-1" }],
      ["add", { transport: "stdio", name: "search", command: "uvx", args: ["search-mcp"], env: [{ key: "SEARCH_KEY", value: "sk-2" }] }],
      ["add", { transport: "http", name: "notes", url: "https://notes.example/mcp", auth: "header", bearerToken: "nt-3" }],
    ]);
  });

  it("fails on Hermes's refusal, and stops Set it up when the list couldn't be read again after a write", async () => {
    const refused = await addMcp({ add: async () => ({ kind: "refused", reason: "Server 'search' already exists" }), install: async () => saved() }, "p", "search", offer("search", "Research"), { SEARCH_KEY: "x" });
    expect(refused).toEqual({ state: { kind: "failed", miss: { kind: "said", text: "Server 'search' already exists" } } });
    const lost = await addMcp({ add: async () => ({ kind: "unconfirmed", reason: "connection reset" }), install: async () => saved() }, "p", "search", offer("search", "Research"), { SEARCH_KEY: "x" });
    expect(lost).toMatchObject({ unanswered: "connection reset" });
  });
});
