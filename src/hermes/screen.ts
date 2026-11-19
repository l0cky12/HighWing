// The side panel's Screen: a profile's Bot Desktop on the Hermes server (ADR 0039). It is Hermes's own headless Xfce
// screen, where the agent's `computer_use` and its browser run. The owner watches it live, and can take over (for a
// sign-in, a 2FA code or a CAPTCHA) and hand back. Hermes owns all of it: whether the screen runs, and who may drive it
// (the lease). This app asks with `display.*` over `/api/ws` and draws the RFB stream Rust relays from
// `/api/display/ws` (src-tauri/src/display.rs). Wire shapes: `tui_gateway/methods_display.py` and
// `hermes_cli/web_routers/display.py`, read at v2026.9.24.

import type { ScreenDisplay } from "./screenClipboard";
import { isObj } from "./values";
import type { HoldOutcome } from "./screenControl";

/** Who may drive the screen. The holder's viewer id never leaves Hermes; `viewer_hash` lets a holder know itself. */
export type DisplayLease = { holder: "agent" | "human"; viewer_hash?: string | null; since: number; epoch: number; reason?: string };

/** `display.status`, as far as this app reads it. */
export type DisplayStatus = {
  supported: boolean;
  installed: boolean;
  missing: string[];
  running: boolean;
  geometry?: string;
  install_command?: string | null;
  blocker?: string | null;
  /** Read only through `browserOf`. */
  browser?: string | null;
  /** `gateway`, or `terminal:<backend>` for a screen in the terminal's sandbox. */
  placement?: string;
  /** The X display the screen runs on (`:42`), while it runs. */
  display?: string | null;
  /** Null where Hermes can't read them, such as a screen in a sandbox. */
  memory_available_mb?: number | null;
  memory_limit_mb?: number | null;
  lease: DisplayLease;
  profile_key: string;
};

/**
 * The Chrome or Chromium the agent's browser and the Bot Desktop's dock open, as `display.status` reports it for the
 * profile asked about. Hermes sends `browser: null` also where it doesn't look: a server that isn't Linux, and a screen
 * in the terminal's sandbox, which brings its own (tools/bot_desktop/runtime.py at f0d94882). So only a null from a
 * Linux server's own screen means none.
 */
export type ServerBrowser =
  | { kind: "found"; path: string }
  | { kind: "missing" }
  | { kind: "unknown"; why: "older-hermes" | "not-linux" | "in-sandbox" };

export function browserOf(s: DisplayStatus): ServerBrowser {
  if (typeof s.browser === "string" && s.browser) return { kind: "found", path: s.browser };
  if (!s.supported) return { kind: "unknown", why: "not-linux" };
  if (s.placement?.startsWith("terminal:")) return { kind: "unknown", why: "in-sandbox" };
  if (s.browser === undefined) return { kind: "unknown", why: "older-hermes" };
  return { kind: "missing" };
}

/** Hermes's own fix for no browser (`chromium_missing_hint`, hermes_cli/browser_runtime.py); pm's store serves every profile. */
export const BROWSER_FIX = "hermes pm install chromium";

/** `cli.exec`'s answer (tui_gateway/methods_tools.py at bf0203a): `blocked` with a `hint` when Hermes won't run it. */
export type CliResult = { blocked: boolean; hint?: string | null; code: number; output: string };

/** One line of `computer-use doctor --json`'s check matrix. */
export type DoctorCheck = { name: string; status: "pass" | "fail" | "skip"; message: string; hint?: string };

/**
 * `computer-use doctor --json`, read (tools/computer_use/doctor.py): exit 0 is `overall: ok`, 1 is degraded, 2 is no
 * driver, and then Hermes prints a sentence, not JSON. `report` is there only when the output held the JSON.
 */
export type DoctorAnswer = { blocked: boolean; hint?: string | null; code: number; output: string; report?: { overall: string; driver_version?: string; checks: DoctorCheck[] } };

/** The first `{...}` object in `text`; Hermes can print warnings after it, and a stray brace in one is not part of it. */
function firstObject(text: string): unknown {
  const start = text.indexOf("{");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; start >= 0 && i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

const DOCTOR_STATUSES = new Set(["pass", "fail", "skip"]);

export function parseDoctor(r: CliResult): DoctorAnswer {
  const answer: DoctorAnswer = { blocked: r.blocked, hint: r.hint, code: r.code, output: r.output };
  const json = firstObject(r.output);
  if (!isObj(json) || !Array.isArray(json.checks)) return answer;
  const checks = json.checks.flatMap((c): DoctorCheck[] =>
    isObj(c) && typeof c.name === "string" && typeof c.status === "string" && DOCTOR_STATUSES.has(c.status) && typeof c.message === "string"
      ? [{ name: c.name, status: c.status as DoctorCheck["status"], message: c.message, ...(typeof c.hint === "string" && { hint: c.hint }) }]
      : [],
  );
  return { ...answer, report: { overall: typeof json.overall === "string" ? json.overall : "", ...(typeof json.driver_version === "string" && { driver_version: json.driver_version }), checks } };
}

/** `display.observe`: a single-use ticket for `/api/display/ws`, good for 30 s, and the viewer id minted for it. */
export type DisplayObserve = DisplayStatus & { ticket: string; viewer_id: string };

/** An RFB stream Rust relays. `onData` gets the screen's bytes; `onClose` once, with the WebSocket close code. */
export type ScreenSocket = { send(bytes: Uint8Array): void; close(): void };
export type OpenScreenSocket = (
  ticket: string,
  onData: (bytes: ArrayBuffer) => void,
  onClose: (code: number, reason: string) => void,
) => Promise<ScreenSocket>;

export interface ScreenApi {
  status(): Promise<DisplayStatus>;
  start(): Promise<DisplayStatus>;
  /** Hermes refuses while a person holds the screen; this never forces it. */
  stop(): Promise<DisplayStatus>;
  /** `hermes pm install chromium` on the server, through `cli.exec` (screenApps.ts, ADR 0193). */
  installBrowser(): Promise<CliResult>;
  /** `hermes -p <profile> computer-use doctor --json`. `cli.exec` ignores its `profile` parameter, so `-p` is in argv (ADR 0215). */
  doctor(): Promise<DoctorAnswer>;
  /** Which of `programs` are on the PATH Hermes's own commands get, through `shell.exec`. */
  findPrograms(programs: readonly string[]): Promise<string[]>;
  /** Deletes the profile's dock layout, so the screen's next start writes it again with what is installed now. */
  resetDock(profileKey: string): Promise<void>;
  /**
   * The text on the screen's clipboard, through `xclip` over `shell.exec` (screenClipboard.ts), until `signal` aborts.
   * "" when it has none.
   */
  readClipboard(where: ScreenDisplay, signal?: AbortSignal): Promise<string>;
  /** A stream ticket, as this connection's viewer (screenControl.ts), so a re-attach keeps the lease it holds. */
  observe(): Promise<DisplayObserve>;
  /** Takes the screen for the owner, minting a viewer when this connection has none. */
  takeOver(reason?: string): Promise<HoldOutcome>;
  /** Gives back the screen this connection's viewer holds. */
  handBack(): Promise<void>;
  openSocket: OpenScreenSocket;
}

/** Hermes's close codes on `/api/display/ws`. */
export const CLOSE_CONTROL_TAKEN = 4000;
export const CLOSE_SCREEN_GONE = 4001;

/** JSON-RPC "method not found": this Hermes predates the Bot Desktop. */
export function isUnavailable(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === -32601) return true;
  const message = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
  return message.includes("method not found") || message.includes("unknown method");
}

/** What the Screen shows before it can stream, from `display.status`; `live` once there is a screen to watch. */
export type ScreenPhase =
  | { kind: "unsupported" }
  | { kind: "not-installed"; missing: string[]; command?: string }
  | { kind: "blocked"; why: string }
  | { kind: "stopped" }
  | { kind: "live" };

export function phaseOf(s: DisplayStatus): ScreenPhase {
  if (!s.supported) return { kind: "unsupported" };
  if (s.running) return { kind: "live" };
  if (!s.installed) return { kind: "not-installed", missing: s.missing ?? [], ...(s.install_command && { command: s.install_command }) };
  if (s.blocker) return { kind: "blocked", why: s.blocker };
  return { kind: "stopped" };
}

/** The first 12 hex digits of the viewer id's SHA-256, as Hermes names the lease's holder. */
export async function viewerHash(viewerId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(viewerId));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

/** A lease older than the one already known: an answer overtaken by a broadcast. */
export const isOlder = (known: DisplayLease | undefined, next: DisplayLease) => !!known && next.epoch < known.epoch;

/**
 * A WebSocket-shaped stand-in that noVNC drives (its `Websock.attach` takes any object with these members), backed by
 * the stream Rust relays. noVNC sets `onopen`, `onmessage`, `onclose` and `onerror` after it is handed the channel, so
 * the open event goes out on the next task, and bytes or a close that came before then are held until it has.
 */
export class RelayedSocket {
  binaryType = "arraybuffer";
  protocol = "";
  readyState = 0; // CONNECTING
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  /** The close code, once closed, for telling Hermes's 4000 (control taken) from a plain end. */
  closeCode: number | undefined;
  private socket: ScreenSocket | undefined;
  private held: (ArrayBuffer | { code: number; reason: string })[] = [];

  /** Opens the relayed stream with `ticket`; rejects if Rust can't. */
  static async open(open: OpenScreenSocket, ticket: string): Promise<RelayedSocket> {
    const s = new RelayedSocket();
    s.socket = await open(
      ticket,
      (bytes) => s.deliver(bytes),
      (code, reason) => s.deliver({ code, reason }),
    );
    setTimeout(() => s.opened(), 0);
    return s;
  }

  private deliver(e: ArrayBuffer | { code: number; reason: string }) {
    if (this.readyState === 0) this.held.push(e);
    else this.dispatch(e);
  }

  private dispatch(e: ArrayBuffer | { code: number; reason: string }) {
    if (this.readyState === 3) return;
    if (e instanceof ArrayBuffer) return this.onmessage?.({ data: e });
    this.readyState = 3; // CLOSED
    this.closeCode = e.code;
    // Hermes closed it: Rust lets go of its end too.
    this.socket?.close();
    this.onclose?.({ code: e.code, reason: e.reason, wasClean: e.code === 1000 });
  }

  private opened() {
    if (this.readyState !== 0) return;
    this.readyState = 1; // OPEN
    this.onopen?.(new Event("open"));
    for (const e of this.held.splice(0)) this.dispatch(e);
  }

  /** noVNC hands over a view of a send buffer it reuses at once, so the bytes are copied before they go. */
  send(data: ArrayBuffer | Uint8Array) {
    if (this.readyState !== 1) return;
    this.socket?.send(data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0)));
  }

  /** Closes normally (1000), which hands control the owner took back to the agent. */
  close() {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.closeCode = 1000;
    this.held = [];
    this.socket?.close();
    this.onclose?.({ code: 1000, reason: "", wasClean: true });
  }
}
