// MCP servers on Bot setup's card (ADR 0231, "MCP servers on the card"). Hermes shows env values half-masked
// (`hermes_cli/web_server_mcp.py` `_redact_mcp_env`), so Connect asks for each env var and bearer token afresh.
import type { Step } from "./botSetupApply";
import { formProblem, envKeyFor, serverNameOk, type CatalogEntry, type McpApi, type McpChange, type McpServer, type ServerForm } from "./mcp";

/** What the card's MCP servers are read from: Hermes's catalog, and each source bot's servers and folder, by its name. */
export type McpSources = {
  catalog: readonly CatalogEntry[];
  bots: Readonly<Record<string, { path?: string; servers: readonly McpServer[] }>>;
};

/**
 * Why the card names a server but won't add it. `oauth`: Hermes signs in only to a server that exists, and one can't be
 * added turned off. `plugin`: a plugin provides it. `name`: the app can't send its name. `path`: it runs from the
 * source bot's own folder. `transport`: Hermes doesn't say how it connects.
 */
export type McpRefusal = "oauth" | "plugin" | "name" | "path" | "transport";

/** A value Connect asks for: an env var by its name, or (`bearer`) an HTTP server's token, kept as `MCP_<NAME>_API_KEY`. */
export type McpSecret = { key: string; prompt?: string; required: boolean; bearer?: true };

/**
 * An MCP server on the card as it would be added. `runs`: the commands, or the address, shown before anything else.
 * `toolFilter`: the source server offers only some of its tools, which isn't copied.
 */
export type McpOffer =
  | { kind: "catalog"; entry: CatalogEntry; runs: string[]; secrets: McpSecret[] }
  | { kind: "copy"; server: McpServer; runs: string[]; secrets: McpSecret[]; toolFilter: boolean }
  | { kind: "refused"; why: McpRefusal; runs: string[] };

/** What Connect took, by the item's key and then the secret's: held in the app's memory only, sent at Set it up. */
export type McpSecrets = Readonly<Record<string, Readonly<Record<string, string>>>>;

const line = (command: string | undefined, args: readonly string[]) => [command ?? "", ...args].filter(Boolean).join(" ");

const PATH_ENDS = String.raw`(?![^/\s"'=:;,])`;
const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const namesFolder = (text: string, folder: string) => {
  const f = folder.replace(/\/+$/, "");
  return !!f && new RegExp(escaped(f) + PATH_ENDS).test(text);
};

function catalogOffer(entry: CatalogEntry): McpOffer {
  const runs = [...(entry.needsInstall ? entry.bootstrap : []), entry.url ?? line(entry.command, entry.args)].filter(Boolean);
  if (entry.authType === "oauth") return { kind: "refused", why: "oauth", runs };
  if (!serverNameOk(entry.name)) return { kind: "refused", why: "name", runs };
  return { kind: "catalog", entry, runs, secrets: entry.requiredEnv.map((e) => ({ key: e.name, ...(e.prompt && { prompt: e.prompt }), required: e.required })) };
}

function copyOffer(server: McpServer, folder: string | undefined): McpOffer {
  const runs = [server.transport === "http" ? (server.url ?? "") : line(server.command, server.args)].filter(Boolean);
  const why: McpRefusal | undefined = server.plugin
    ? "plugin"
    : !server.changeable
      ? "name"
      : server.transport === "unknown"
        ? "transport"
        : server.auth === "oauth"
          ? "oauth"
          : folder && [server.command ?? "", ...server.args].some((a) => namesFolder(a, folder))
            ? "path"
            : undefined;
  if (why) return { kind: "refused", why, runs };
  const secrets: McpSecret[] =
    server.transport === "http"
      ? server.auth === "header"
        ? [{ key: envKeyFor(server.name), required: true, bearer: true }]
        : []
      : server.envKeys.map((key) => ({ key, required: true }));
  return { kind: "copy", server, runs, secrets, toolFilter: server.toolFilter };
}

/** The server named `name`, from the catalog or, with `from`, from that bot's list; undefined when it lists none. */
export function mcpOffer(sources: McpSources, name: string, from?: string): McpOffer | undefined {
  if (from === undefined) {
    const entry = sources.catalog.find((e) => e.name === name);
    return entry && catalogOffer(entry);
  }
  const bot = sources.bots[from];
  const server = bot?.servers.find((s) => s.name === name);
  return server && copyOffer(server, bot.path);
}

/** Whether Connect has every value `offer` needs. */
export const connected = (offer: McpOffer, values: Readonly<Record<string, string>> = {}) =>
  offer.kind === "refused" || offer.secrets.every((s) => !s.required || !!values[s.key]?.trim());

const said = (text: string, unanswered = false): Step => ({ state: { kind: "failed", miss: { kind: "said", text } }, ...(unanswered && { unanswered: text }) });

const stepOfChange = (c: McpChange): Step => (c.kind === "saved" ? { state: { kind: "reload" } } : said(c.reason, c.kind === "unconfirmed" && !c.list));

/**
 * Adds the server `offer` describes to `profile`, with the values Connect took, and reads it back. Waits on Connect
 * while a value it needs is missing, and sends nothing then.
 */
export async function addMcp(
  mcp: Pick<McpApi, "add" | "install">,
  profile: string,
  name: string,
  offer: Exclude<McpOffer, { kind: "refused" }>,
  values: Readonly<Record<string, string>> = {},
): Promise<Step> {
  if (!connected(offer, values)) return { state: { kind: "connect" } };
  if (offer.kind === "catalog") return stepOfChange(await mcp.install(profile, offer.entry, values));
  const s = offer.server;
  const form: ServerForm =
    s.transport === "http"
      ? { transport: "http", name, url: s.url ?? "", auth: s.auth, ...(s.auth === "header" && { bearerToken: values[envKeyFor(name)] }) }
      : { transport: "stdio", name, command: s.command ?? "", args: s.args, env: s.envKeys.map((key) => ({ key, value: values[key] ?? "" })) };
  const problem = formProblem(form, false, []);
  return problem ? said(problem) : stepOfChange(await mcp.add(profile, form));
}
