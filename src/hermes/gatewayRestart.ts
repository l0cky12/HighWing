// The Restart gateway button's reads and write (ADR 0203), through the dashboard's routes at `da9c2bd`:
//
// - `GET /api/status?profile=` says whether the profile's gateway runs (`gateway_running`, `gateway_state`), how many
//   replies it is running (`active_agents`), and, for a profile the shared multiplexer serves, every profile that
//   process carries (`gateway_shared_with`) (`hermes_cli/web_routers/status.py`).
// - `POST /api/gateway/restart?profile=` with no body starts `hermes gateway restart --interrupt` in the background and
//   answers `{ok, pid, name}` (`hermes_cli/web_routers/actions.py`). It cuts running replies.
// - `GET /api/actions/gateway-restart/status` follows it: `{running, exit_code, pid, lines}`. One record serves every
//   profile, so only an answer with the restart's own `pid` is about this restart.
//
// Exit 0 isn't proof: with a systemd unit whose restart failed and linger off, the command exits 0 without restarting.
// So a restart counts as done only once `/api/status` reads the gateway back as running.

import type { RestMethod } from "./pipe";
import { redactSecrets } from "./secrets";
import { failureOf } from "./toolsets";
import { isObj, textOrEmpty } from "./values";

export type GatewayStatus = {
  running: boolean;
  /** Hermes's word for it: `running`, `starting`, `draining`, `degraded`, `startup_failed`, `stopped`. */
  state: string | undefined;
  /** Replies the gateway is running now; a restart cuts them off. */
  activeAgents: number;
  /** The profiles the same gateway process serves, this one included, when it's the shared multiplexer; else empty. */
  sharedWith: string[];
};

export type RestartOutcome = { kind: "restarted" } | { kind: "failed"; why: string } | { kind: "unconfirmed"; why: string };

export type RestartTiming = {
  sleep: (ms: number) => Promise<void>;
  /** Between two reads. */
  pollMs: number;
  /** How long the restart command may run before the outcome is called unconfirmed. */
  commandLimitMs: number;
  /** How long the gateway may take to read back as running once the command is done. */
  backLimitMs: number;
};

export const RESTART_TIMING: RestartTiming = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs: 1000,
  commandLimitMs: 90_000,
  backLimitMs: 30_000,
};

export type GatewayRestartRest = (method: RestMethod, pathAndQuery: string, body?: unknown) => Promise<unknown>;

const q = (profile: string) => `profile=${encodeURIComponent(profile)}`;
const clean = (text: string) => redactSecrets(text).text;

export function statusOf(v: unknown): GatewayStatus {
  const o = isObj(v) ? v : {};
  const n = typeof o.active_agents === "number" && Number.isFinite(o.active_agents) ? Math.max(0, Math.floor(o.active_agents)) : 0;
  return {
    running: o.gateway_running === true,
    state: textOrEmpty(o.gateway_state) || undefined,
    activeAgents: n,
    sharedWith: Array.isArray(o.gateway_shared_with) ? o.gateway_shared_with.filter((p): p is string => typeof p === "string" && p !== "") : [],
  };
}

type Command = { running: boolean; exitCode: number | undefined; pid: number | undefined; lines: string[] };

function commandOf(v: unknown): Command {
  const o = isObj(v) ? v : {};
  return {
    running: o.running === true,
    exitCode: typeof o.exit_code === "number" ? o.exit_code : undefined,
    pid: typeof o.pid === "number" ? o.pid : undefined,
    lines: Array.isArray(o.lines) ? o.lines.filter((l): l is string => typeof l === "string") : [],
  };
}

const lastLines = (lines: string[]) =>
  clean(
    lines
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-3)
      .join(" "),
  );

export class GatewayRestartApi {
  constructor(
    private rest: GatewayRestartRest,
    private timing: RestartTiming = RESTART_TIMING,
  ) {}

  async status(profile: string): Promise<GatewayStatus> {
    return statusOf(await this.rest("GET", `api/status?${q(profile)}`));
  }

  /** Restarts the profile's gateway and waits until Hermes reads it back as running, or says why not. */
  async restart(profile: string): Promise<RestartOutcome> {
    let pid: number | undefined;
    try {
      const res = await this.rest("POST", `api/gateway/restart?${q(profile)}`);
      pid = isObj(res) && typeof res.pid === "number" ? res.pid : undefined;
    } catch (e) {
      const f = failureOf(e);
      if (f.status === 405 || (f.status === 404 && f.reason === "Not Found"))
        return { kind: "failed", why: "This Hermes server has no gateway restart route (/api/gateway/restart). Updating Hermes adds it." };
      return { kind: "failed", why: clean(f.reason) };
    }
    const { sleep, pollMs } = this.timing;
    const tries = (ms: number) => Math.max(1, Math.ceil(ms / pollMs));

    if (pid !== undefined) {
      let done: Command | undefined;
      let replaced = false;
      for (let i = 0; i < tries(this.timing.commandLimitMs) && !done; i++) {
        await sleep(pollMs);
        let c: Command;
        try {
          c = commandOf(await this.rest("GET", "api/actions/gateway-restart/status"));
        } catch {
          continue;
        }
        replaced = c.pid !== pid;
        if (!replaced && !c.running) done = c;
      }
      if (!done)
        return replaced
          ? { kind: "unconfirmed", why: "Another gateway restart started on the server while this one ran, so Hermes can't say how this one went." }
          : { kind: "unconfirmed", why: `The restart was still running after ${Math.round(this.timing.commandLimitMs / 1000)} seconds.` };
      if (done.exitCode !== undefined && done.exitCode !== 0) {
        const said = lastLines(done.lines);
        return { kind: "failed", why: `The restart command failed (exit ${done.exitCode})${said ? `: ${said}` : "."}` };
      }
      // Exit 0 with the old gateway left running, which `/api/status` can't tell from a restarted one (`hermes_cli/gateway.py`).
      if (done.lines.some((l) => /linger is not enabled/i.test(l))) {
        const fix = done.lines.map((l) => l.trim()).find((l) => /^Run:\s+sudo loginctl enable-linger/.test(l));
        return {
          kind: "failed",
          why: `Hermes couldn't restart the gateway's service because linger isn't enabled for its user on the server.${fix ? ` ${clean(fix.replace(/\s+/g, " "))}` : ""}`,
        };
      }
    }

    let last: GatewayStatus | undefined;
    for (let i = 0; i < tries(this.timing.backLimitMs); i++) {
      try {
        last = await this.status(profile);
        if (last.running && last.state === "running") return { kind: "restarted" };
      } catch {
        // Read again on the next try.
      }
      await sleep(pollMs);
    }
    const state = last ? (last.running ? `it reports "${last.state ?? "unknown"}"` : "it isn't running") : "its state couldn't be read";
    return { kind: "unconfirmed", why: `The restart command finished, but the gateway doesn't read back as running: ${state}.` };
  }
}
