// Slash commands typed in the composer (GLOSSARY.md "Slash command", ADR 0015). A small explicit registry: actions this
// app already has, and Hermes commands whose behaviour was read in Hermes's source at the deployed `bf0203a`. Nothing
// typed is forwarded to Hermes as a command unless it is in this list; any other text starting with "/" is sent as an
// ordinary message.
import { catalogSkills, type SkillCall } from "./skillCommands";
import { EFFORTS } from "./models";
import { hermesCommands } from "./hermesCommands";
import { isObj } from "./values";
import type { PlainMethod, SessionProtocol } from "./sessionProtocol";

/**
 * `local`: an action of this app, which may write to Hermes through the same calls its buttons use. `server`: a command
 * Hermes runs for the chat's live session, by a route of its own. `hermes`: one of Hermes's commands from its catalog,
 * run through `slash.exec` as Hermes's own desktop runs it (hermesCommands.ts). `aliases`: Hermes's other names for it,
 * which resolve only when typed whole. `args`: the argument hint, `<required>` or `[optional]`. `subcommands`: the words
 * the menu suggests after the name. `suggests`: the menu suggests the profile's models instead. `destructive`: asks
 * first, as the chat list's Delete does, and runs only when typed whole. `unavailable`: why it never runs from here.
 */
export type CommandDef = {
  name: string;
  aliases?: readonly string[];
  args?: string;
  description: string;
  scope: "local" | "server" | "hermes";
  subcommands?: readonly string[];
  suggests?: "models";
  destructive?: boolean;
  unavailable?: string;
};

export const COMMANDS: readonly CommandDef[] = [
  { name: "help", description: "Show every command you can use here", scope: "local" },
  // Hermes's `/reset`, and its `/clear`, which Hermes's desktop also takes as a new chat.
  { name: "new", aliases: ["reset", "clear"], description: "Start a new chat", scope: "local" },
  // Hermes's `/title` renames the session, as Rename does.
  { name: "rename", aliases: ["title"], args: "<title>", description: "Rename this chat in every Hermes client", scope: "local" },
  { name: "delete", description: "Delete this chat in every Hermes client, after asking", scope: "local", destructive: true },
  // `command.dispatch` `_cmd_steer` (tui_gateway/methods_tools.py): queued for after the running reply's next tool call.
  { name: "steer", aliases: ["s"], args: "<message>", description: "Tell the running reply something after its next tool call, without stopping it", scope: "server" },
  // `prompt.btw` (tui_gateway/methods_prompt.py at the deployed `f0d94882`), as Hermes's own clients send it, not
  // `command.dispatch`: it answers later, as a `btw.complete` event (ADR 0070).
  { name: "btw", args: "<question>", description: "Ask a side question about this chat without interrupting the reply or adding to the chat", scope: "server" },
  // `slash.exec` `/context`, answered from the live session (tui_gateway/methods_slash.py `_format_live_context_output`).
  { name: "context", aliases: ["ctx"], args: "[all]", subcommands: ["all"], description: "Show what fills this chat's context window, as Hermes counts it", scope: "server" },
  // `command.dispatch` `_cmd_goal` (tui_gateway/methods_tools.py at `bf0203a`). Typed, it opens Set a goal, which shows
  // the check before anything is saved (ADR 0187).
  { name: "goal", args: "[outcome]", description: "Set a goal Hermes keeps working toward until a check proves it done", scope: "server" },
  // The model picker's own switch (`hermes.setModel`), not Hermes's `/model`, whose mirror drops a model Hermes asks to
  // confirm and refuses mid-reply after its worker already ran it. Hermes's desktop hides its `/model` for its picker.
  { name: "model", args: "[model]", suggests: "models", description: "Show this chat's model, or switch it", scope: "local" },
  // The reasoning pill's switch, as the picker sets it. Hermes's `/reasoning` changes only its slash worker's agent.
  { name: "reasoning", args: "[level]", subcommands: EFFORTS, description: "Show or set this chat's reasoning effort", scope: "local" },
  // The context inspector's Compact now: Hermes moves the chat to a new stored session, which this app follows.
  // Hermes's options for it (`here N`, `--preview`) are refused rather than sent to the chat as a message.
  { name: "compress", aliases: ["compact"], args: "[options]", description: "Compact this chat's context now, between replies", scope: "local" },
];

/** `/steer`, which the composer also uses for a message sent into a running reply (ADR 0057). */
export const STEER: CommandDef = COMMANDS.find((c) => c.name === "steer")!;

/** Why `arg` can't go with `def`, or undefined when it can. */
export function argProblem(def: CommandDef, arg: string): string | undefined {
  return def.args?.startsWith("<") && !arg ? `/${def.name} needs ${def.args}.` : undefined;
}

/** What the composer holds once a command is picked: its name, and a space for its argument if it takes one. */
export const completion = (def: CommandDef) => `/${def.name}${takesArg(def) ? " " : ""}`;

const takesArg = (def: CommandDef) => !!(def.args || def.subcommands?.length || def.suggests);

/**
 * What typed "/" text is. `command`: `def` with its argument, found `via` its name, an alias, or a prefix. `unclear`:
 * a name that more than one thing starts (`candidates`), or a prefix of a destructive command, so nothing runs.
 */
export type Typed = Resolved & { arg: string };
type Resolved = { kind: "command"; def: CommandDef; via: "name" | "alias" | "prefix" } | { kind: "unclear"; name: string; candidates: string[] };

/** What the "/" menu offers: command names for `query`, or what follows `def`'s name (its subcommands or models). */
export type CommandMenu = { stage: "name"; query: string } | { stage: "arg"; def: CommandDef; query: string };

/**
 * The commands "/" reaches in a composer: the app's own (COMMANDS) and Hermes's from its catalog (hermesCommands.ts).
 * `others` is every other exact name "/" reaches there, lower case: the skills and extension commands offered.
 */
export type CommandSet = {
  readonly all: readonly CommandDef[];
  /** The command `text` runs, or undefined when it is an ordinary message, a skill or an extension command. */
  typed(text: string, others: readonly string[]): Typed | undefined;
  /** What the "/" menu shows while `text` is typed, with the caret at its end. */
  menu(text: string, others: readonly string[]): CommandMenu | undefined;
  /** The commands for a name query, best first. Whatever `typed` would run for "/query" is first. */
  match(query: string): CommandDef[];
};

/**
 * The app's commands, then those of `hermes` that the app doesn't do itself under a name or alias of its own.
 *
 * A typed name is resolved as Hermes's command line resolves one at the deployed `bf0203a` (`cli.py
 * _expand_slash_prefix`), not as its docs say ("the first match in registry order"), which its code doesn't do: a name
 * or alias typed whole; then, among every name and alias that starts with it (skills and extension commands too), the
 * one, or the one shortest. A tie names them all and runs nothing. A skill or extension command found that way is the
 * caller's to run. The command is sent to Hermes under its own name, which Hermes's side effects are keyed on.
 */
export function commandSet(hermes: readonly CommandDef[] = []): CommandSet {
  const keys = new Map<string, CommandDef>();
  const all: CommandDef[] = [];
  const add = (def: CommandDef) => {
    if (keys.has(def.name)) return;
    const aliases = (def.aliases ?? []).filter((a) => !keys.has(a));
    const kept = { ...def, ...(def.aliases && { aliases }) };
    all.push(kept);
    for (const k of [def.name, ...aliases]) keys.set(k, kept);
  };
  COMMANDS.forEach(add);
  hermes.forEach(add);

  const resolve = (typedName: string, others: readonly string[]): Resolved | undefined => {
    const n = typedName.toLowerCase();
    const exact = keys.get(n);
    if (exact) return { kind: "command", def: exact, via: exact.name === n ? "name" : "alias" };
    if (others.includes(n)) return undefined;
    const found = [...new Set([...keys.keys(), ...others])].filter((k) => k.startsWith(n)).sort();
    if (!found.length) return undefined;
    const targets = new Set(found.map((k) => keys.get(k) ?? k));
    const shortest = found.filter((k) => k.length === Math.min(...found.map((f) => f.length)));
    const pick = targets.size === 1 ? found[0] : shortest.length === 1 ? shortest[0] : undefined;
    if (pick === undefined) return { kind: "unclear", name: n, candidates: found };
    const def = keys.get(pick);
    if (!def) return undefined;
    // A one-letter slip shouldn't lead to deleting a chat: Hermes has no such command, and no question before it.
    if (def.destructive) return { kind: "unclear", name: n, candidates: [def.name] };
    return { kind: "command", def, via: "prefix" };
  };

  return {
    all,
    typed(text, others) {
      const m = /^\/(\S+)([\s\S]*)$/.exec(text);
      const r = m && resolve(m[1], others);
      if (!m || !r) return undefined;
      const arg = m[2].trim();
      if (r.kind === "unclear") return { ...r, arg };
      // Words after a command that takes none are a message: "/help me read this log".
      return takesArg(r.def) || !arg ? { ...r, arg } : undefined;
    },
    menu(text, others) {
      if (/^\/\S*$/.test(text)) return { stage: "name", query: text.slice(1).toLowerCase() };
      const m = /^\/(\S+)[ \t]+([^\n]*)$/.exec(text);
      const r = m && resolve(m[1], others);
      if (!m || r?.kind !== "command" || r.def.unavailable) return undefined;
      // Models are found by any of their words; a subcommand is one word.
      if (r.def.suggests) return { stage: "arg", def: r.def, query: m[2] };
      return r.def.subcommands?.length && /^\S*$/.test(m[2]) ? { stage: "arg", def: r.def, query: m[2].toLowerCase() } : undefined;
    },
    match(query) {
      const q = query.toLowerCase();
      const r = q ? resolve(q, []) : undefined;
      const names = (c: CommandDef) => [c.name, ...(c.aliases ?? [])];
      const words = (c: CommandDef) => c.description.toLowerCase().split(/\W+/);
      // Hermes's menu tiers (`slash_fuzzy.py`): exact, prefix, substring, then a word of the description.
      const tiers = [
        all.filter((c) => names(c).includes(q)),
        r?.kind === "command" ? [r.def] : [],
        all.filter((c) => names(c).some((k) => k.startsWith(q))),
        all.filter((c) => c.name.includes(q)),
        all.filter((c) => words(c).some((w) => w.startsWith(q))),
      ];
      return [...new Set(tiers.flat())];
    },
  };
}

/** How a request to Hermes goes: a JSON-RPC call on `/api/ws`. */
export type Rpc = (method: PlainMethod, params: Record<string, unknown>) => Promise<unknown>;

/** What a server command came back with: text to show, or a message Hermes wants sent as the chat's next turn. */
/**
 * What a server command came back with. `output`: text to show. `send`: a message Hermes wants sent as the chat's next
 * turn. `skill`: Hermes built a skill message for the next turn, which goes as the skill call `call` (sent again
 * through `command.dispatch`, so its text isn't kept here, ADR 0015), shown as `display`. `prefill`: text Hermes puts back
 * in the composer to edit.
 */
export type CommandResult =
  | { kind: "output"; text: string }
  | { kind: "send"; message: string; notice?: string }
  | { kind: "skill"; call: SkillCall; display: string; notice?: string }
  | { kind: "prefill"; text: string; notice?: string };

const NO_SUCH_METHOD = -32601;

/**
 * The registry's server commands Hermes lists (`listed`); those a quick or plugin command of the same name replaces
 * (`replaced`); and those that might be replaced by one Hermes couldn't list (`unsure`). `skills`: the skills Hermes
 * would run as commands, key to description (`skillCommands.catalogSkills`), undefined when it can't say.
 */
export type ServerCommandList = { listed: Set<string>; replaced: Set<string>; unsure: Set<string>; skills?: Map<string, string>; hermes: CommandDef[] };

/**
 * Commands that go through `command.dispatch`, which runs a quick command (any shell command) or a plugin command before
 * Hermes's own of the same name (`_dispatch_quick`, `_dispatch_plugin`). `session.control`'s goal actions go through it
 * too, so one named `goal` replaces those as well. `slash.exec /context` is answered from the live
 * session before any of those (`_live_slash_command_output`), and `/btw` is a method of its own, so nothing can replace
 * either.
 */
const REPLACEABLE = new Set(["steer", "goal"]);

/**
 * The registry's server commands that this Hermes lists in `commands.catalog` for `profile`, the catalog the official
 * clients' menus are built from. A replaceable command whose name a quick or plugin command takes is `replaced`, and
 * `unsure` when Hermes's discovery of those failed: a failed skill discovery overwrites the warning a failed quick
 * command discovery left (`command_discovery.command_catalog`). Neither is run from here. Rejects saying why when Hermes
 * has no catalog.
 */
export async function listServerCommands(rpc: Rpc, profile: string): Promise<ServerCommandList> {
  const res = await rpc("commands.catalog", { profile }).catch((e) => {
    throw isObj(e) && e.code === NO_SUCH_METHOD ? new Error("This Hermes doesn't list its commands. Update Hermes to use them here; Settings → Diagnostics shows what it supports.") : e;
  });
  if (!isObj(res)) throw new Error("Hermes gave no list of its commands.");
  const failed =
    (typeof res.plugin_discovery_error === "string" && !!res.plugin_discovery_error) ||
    /(quick_commands|plugin command|skill) discovery unavailable/.test(String(res.warning ?? ""));
  // `canon`: every listed name and alias, lower-cased, to the command's own name. Quick commands are listed under
  // "User commands" and plugin commands in `plugin_commands`, by name without the slash.
  const canon = isObj(res.canon) ? res.canon : {};
  const taken = new Set<string>(Object.keys(isObj(res.plugin_commands) ? res.plugin_commands : {}).map((k) => `/${k.toLowerCase()}`));
  // Quick commands are listed under "User commands" and plugin commands under "Plugin commands".
  for (const c of Array.isArray(res.categories) ? res.categories : [])
    if (isObj(c) && (c.name === "User commands" || c.name === "Plugin commands") && Array.isArray(c.pairs))
      for (const p of c.pairs) if (Array.isArray(p) && typeof p[0] === "string") taken.add(p[0].toLowerCase());
  const server = COMMANDS.filter((c) => c.scope === "server").map((c) => c.name);
  const replaced = new Set(server.filter((n) => REPLACEABLE.has(n) && taken.has(`/${n}`)));
  const unsure = new Set(server.filter((n) => REPLACEABLE.has(n) && failed && !replaced.has(n)));
  const skills = catalogSkills(res, taken, failed);
  return {
    listed: new Set(server.filter((n) => canon[`/${n}`] === `/${n}` && !replaced.has(n) && !unsure.has(n))),
    replaced,
    unsure,
    ...(skills && { skills }),
    hermes: hermesCommands(res),
  };
}

/**
 * Runs a server command on the chat's live session `sessionId`. `/steer` goes through `command.dispatch` with the
 * argument as its own field, so its words reach Hermes exactly as typed. Every other command goes through `slash.exec`
 * under its own name, as Hermes's own desktop sends it (`runExec`): Hermes answers some from the live session, hands
 * some to `command.dispatch`, and runs the rest in its slash worker. A `slash.exec` Hermes refuses is tried once as
 * `command.dispatch`, and a quick command that is an alias of another runs that one, as the desktop does.
 */
export async function runServerCommand(rpc: Rpc, sessions: Pick<SessionProtocol, "command">, sessionId: string, def: CommandDef, arg: string): Promise<CommandResult> {
  const exec = (line: string) => rpc("slash.exec", { command: line, session_id: sessionId });
  let res: unknown;
  if (def.name === "steer") res = await sessions.command(sessionId, def.name, arg);
  else if (def.scope === "server") res = await exec(`/${def.name}${arg ? ` ${arg}` : ""}`);
  else res = await exec(`/${def.name}${arg ? ` ${arg}` : ""}`).catch((e) => (isObj(e) && e.code === NO_SUCH_METHOD ? Promise.reject(e) : sessions.command(sessionId, def.name, arg)));
  if (isObj(res) && res.type === "alias" && typeof res.target === "string" && res.target.trim())
    res = await exec(res.target.trim().startsWith("/") ? res.target.trim() : `/${res.target.trim()}`);
  return commandResult(def, arg, res);
}

const notice = (res: Record<string, unknown>) => (typeof res.notice === "string" && res.notice.trim() ? { notice: res.notice.trim() } : {});
// Hermes strips colour from its worker's output, but not from a plugin's or a dispatched command's.
const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** What Hermes's answer to `/name arg` asks of the app. */
function commandResult(def: CommandDef, arg: string, res: unknown): CommandResult {
  if (!isObj(res)) throw new Error(`Hermes gave no answer to /${def.name}.`);
  const message = typeof res.message === "string" ? res.message : undefined;
  if (res.type === "send" && message !== undefined) return { kind: "send", message, ...notice(res) };
  if (res.type === "skill" && message?.trim())
    return { kind: "skill", call: { name: def.name, arg }, display: typeof res.display === "string" && res.display.trim() ? res.display.trim() : `/${def.name}${arg ? ` ${arg}` : ""}`, ...notice(res) };
  if (res.type === "prefill" && message !== undefined) return { kind: "prefill", text: message, ...notice(res) };
  if ((res.type === undefined || res.type === "exec" || res.type === "plugin") && typeof res.output === "string") {
    const warning = typeof res.warning === "string" && res.warning.trim() ? `${res.warning.trim()}\n\n` : "";
    return { kind: "output", text: plain(`${warning}${res.output}`).trim() };
  }
  throw new Error(`Hermes answered /${def.name} in a way this app doesn't handle.`);
}

/**
 * Asks Hermes a side question about the chat's live session `sessionId` (`prompt.btw`). Resolves with the task id its
 * `btw.complete` answer will carry; rejects saying why Hermes didn't take it.
 */
export async function askSideQuestion(rpc: Rpc, sessionId: string, question: string): Promise<string> {
  const res = await rpc("prompt.btw", { session_id: sessionId, text: question }).catch((e) => {
    throw isObj(e) && e.code === NO_SUCH_METHOD ? new Error("This Hermes can't answer side questions here. Updating Hermes may add it.") : e;
  });
  if (!isObj(res) || typeof res.task_id !== "string" || !res.task_id) throw new Error("Hermes didn't say it took the question.");
  return res.task_id;
}

/**
 * What a `btw.complete` text says. Hermes sends a failure as the text `error: <why>` (`_spawn_side_agent`), with no
 * field of its own, so an answer that starts that way reads as a failure; its words show either way.
 */
export function sideAnswer(text: unknown): { answer: string } | { error: string } {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return { error: "Hermes had no answer to it." };
  return t.startsWith("error: ") ? { error: t.slice("error: ".length) } : { answer: t };
}
