// Hermes's own slash commands, as its `commands.catalog` lists them for the profile (ADR 0225). Each is offered in the
// composer and runs the way Hermes's own desktop runs it, through `slash.exec` (runServerCommand), unless this app does
// it with a feature of its own (commands.ts, COMMANDS) or can't do it here, which `UNAVAILABLE` says why. Read in
// Hermes's source at the deployed `bf0203a`: the catalog (`tui_gateway/command_discovery.py`), the desktop's routes
// (`apps/desktop/src/lib/desktop-slash-commands.ts`) and what `slash.exec` does with each (`methods_tools.py`).
import { isObj } from "./values";
import type { CommandDef } from "./commands";

const HISTORY = "Hermes would rewrite the history this chat shows, and this app wouldn't see it.";
const DISPLAY = "It changes how Hermes's own command line shows things; this app has its own settings for that.";
const BILLING = "Hermes would open a browser on its server. Manage your Nous plan on the Nous portal.";

/**
 * Hermes commands that never run from this app, and what to do instead. Each would change something the app shows
 * without the app hearing of it, act on the slash worker's process rather than this chat, or needs a screen of
 * Hermes's own clients (Hermes's desktop handles all of these itself, never through `slash.exec`).
 */
const UNAVAILABLE: Record<string, string> = {
  undo: `${HISTORY} Use Edit under your message instead: it keeps the old version as a branch.`,
  retry: `${HISTORY} Use Regenerate under the reply instead: it keeps the old version as a branch.`,
  branch: "Use Branch from here, under a message.",
  resume: "Open the chat from the chat list, or find it with Ctrl+K.",
  sessions: "Open the chat from the chat list, or find it with Ctrl+K.",
  queue: "A message you send while a reply runs waits in this chat's queue (Settings → General → Follow-up behavior).",
  bg: "This app can't show a background session's answer yet.",
  agents: "The Subagents panel above the composer shows them while they run.",
  save: "Use Export… in the chat header's More menu.",
  export: "Hermes would write a profile archive on its server, from its own command line.",
  import: "Hermes would read a profile archive on its server, from its own command line.",
  config: "Settings shows the profile's configuration, with its secrets kept out of the window.",
  handoff: "Hermes's own desktop hands a chat off from a screen of its own, which this app doesn't have.",
  rollback: "Hermes would restore files from its command line's checkpoints, not this chat's.",
  browser: "Hermes would connect its command line's browser, not this chat's.",
  yolo: "Use the YOLO switch in the status bar, which sets it for this chat.",
  prompt: "Hermes would open an editor on its server. Type the message here instead.",
  wake: "The wake word listens on the computer Hermes runs on.",
  subscription: BILLING,
  topup: BILLING,
  skin: DISPLAY,
  timestamps: DISPLAY,
  palette: DISPLAY,
  battery: DISPLAY,
  focus: DISPLAY,
  density: DISPLAY,
  mouse: DISPLAY,
  journey: "Hermes's own desktop shows the learning journey on a screen of its own, which this app doesn't have.",
  pet: "Hermes's pets live in its own clients.",
  hatch: "Hermes's pets live in its own clients.",
};

/** Why a command Hermes marks for its own clients only (`CommandDef.desktop`) doesn't run here. */
const BY_DESKTOP: Record<string, string> = {
  terminal: "Hermes runs it only in its terminal command line.",
  settings: "Sign in from Settings → Providers.",
  "composer-voice": "Use the microphone button in the composer.",
};

/** `/skills` subcommands that answer in text; the rest (search, browse, install, …) are interactive in Hermes's CLI. */
const SKILLS_IN_TEXT = new Set(["pending", "approve", "reject", "diff", "approval"]);

/** Hermes's mirror refuses these while a reply runs, after its slash worker has already run them (`_MUTATES_WHILE_RUNNING`). */
const NOT_WHILE_RUNNING = new Set(["personality"]);

/**
 * The commands a `commands.catalog` answer lists, less skills (skillCommands.ts offers those): Hermes's built-ins,
 * quick commands and plugin commands, in the catalog's order, each with its aliases, argument hint and subcommands.
 * Empty for an answer that isn't a catalog.
 */
export function hermesCommands(catalog: unknown): CommandDef[] {
  if (!isObj(catalog) || !Array.isArray(catalog.pairs)) return [];
  const skills = isObj(catalog.skills) ? catalog.skills : {};
  const canon = isObj(catalog.canon) ? catalog.canon : {};
  const sub = isObj(catalog.sub) ? catalog.sub : {};
  const meta = isObj(catalog.commands) ? catalog.commands : {};
  const aliases = new Map<string, string[]>();
  for (const [alias, to] of Object.entries(canon))
    if (typeof to === "string" && alias.toLowerCase() !== to.toLowerCase()) aliases.set(to.toLowerCase(), [...(aliases.get(to.toLowerCase()) ?? []), alias.slice(1).toLowerCase()]);
  const seen = new Set<string>();
  const out: CommandDef[] = [];
  for (const pair of catalog.pairs) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string" || !/^\/\S+$/.test(pair[0]) || pair[0] in skills) continue;
    const key = pair[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const name = key.slice(1);
    const text = typeof pair[1] === "string" ? pair[1] : "";
    // Hermes puts the argument hint in the description: "Switch model (usage: /model [model] …)".
    const usage = /\s*\(usage: \/\S+\s*(.*)\)\s*$/.exec(text);
    const subs = Array.isArray(sub[key]) ? sub[key].filter((s): s is string => typeof s === "string" && /^[a-z0-9]/i.test(s)) : [];
    const entry = isObj(meta[key]) ? meta[key] : {};
    const unavailable = UNAVAILABLE[name] ?? (typeof entry.desktop === "string" ? BY_DESKTOP[entry.desktop] : undefined);
    out.push({
      name,
      description: (usage ? text.slice(0, usage.index) : text).trim() || "A Hermes command",
      scope: "hermes",
      ...(aliases.has(key) && { aliases: aliases.get(key) }),
      ...(usage?.[1].trim() ? { args: usage[1].trim() } : subs.length || entry.argument_mode ? { args: "[options]" } : {}),
      ...(subs.length && { subcommands: subs }),
      ...(unavailable && { unavailable }),
    });
  }
  return out;
}

/**
 * Why a Hermes command can't run now, or undefined when it can. `arg`: what the owner is running it with; undefined
 * while the menu only lists it. `running`: a reply runs in the chat.
 */
export function hermesRefusal(def: CommandDef, arg: string | undefined, running: boolean): string | undefined {
  if (def.unavailable) return def.unavailable;
  if (def.name === "skills" && arg !== undefined && !SKILLS_IN_TEXT.has(arg.split(/\s+/)[0].toLowerCase()))
    return `Only /skills ${[...SKILLS_IN_TEXT].join(", ")} run here. Settings → Skills finds, installs and turns skills on and off.`;
  if (running && NOT_WHILE_RUNNING.has(def.name)) return `Hermes changes it only between replies. Wait for this one to finish.`;
  return undefined;
}
