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
  /** Milliseconds on a clock that only goes forward; the limits below are measured on it. */
  now: () => number;
  /** Between two reads. */
  pollMs: number;
  /** How long the restart command may run before the outcome is called unconfirmed. */
  commandLimitMs: number;
  /** How long the gateway may take to read back as running once the command is done. */
  backLimitMs: number;
};

export const RESTART_TIMING: RestartTiming = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => performance.now(),
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

/**
 * Hermes answers a restart asked for the same profile within `GATEWAY_RESTART_COOLDOWN_SECONDS` (10) of the last one
 * with that one's pid, though it has ended (`_spawn_gateway_restart`, `hermes_cli/web_server.py`); plus a margin.
 */
const COOLDOWN_MS = 10_500;

const LATE: unique symbol = Symbol("late");

const lastLines = (lines: string[]) =>
  clean(
    lines
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-3)
      .join(" "),
  );

export class GatewayRestartApi {
  /** Each profile's last restart: its pid, and when Hermes answered with it. */
  private last = new Map<string, { pid: number; at: number }>();

  constructor(
    private rest: GatewayRestartRest,
    private timing: RestartTiming = RESTART_TIMING,
  ) {}

  async status(profile: string): Promise<GatewayStatus> {
    return statusOf(await this.rest("GET", `api/status?${q(profile)}`));
  }

  /** The request's answer, or LATE once `ms` have passed without one: the REST call itself may wait for minutes. */
  private within<T>(request: Promise<T>, ms: number): Promise<T | typeof LATE> {
    return Promise.race([request, this.timing.sleep(Math.max(0, ms)).then((): typeof LATE => LATE)]);
  }

  /** Restarts the profile's gateway and waits until Hermes reads it back as running, or says why not. */
  async restart(profile: string): Promise<RestartOutcome> {
    const { sleep, now, pollMs } = this.timing;
    const seconds = (ms: number) => Math.round(ms / 1000);
    const before = this.last.get(profile);
    if (before) await sleep(Math.max(0, before.at + COOLDOWN_MS - now()));
    let pid: number | undefined;
    // A restart asked inside Hermes's cooldown gets the last one back; it has a new pid only once the cooldown is over.
    for (let tries = 0; ; tries++) {
      try {
        const res = await this.within(this.rest("POST", `api/gateway/restart?${q(profile)}`), this.timing.commandLimitMs);
        if (res === LATE) return { kind: "unconfirmed", why: `Hermes didn't answer the restart request within ${seconds(this.timing.commandLimitMs)} seconds.` };
        pid = isObj(res) && typeof res.pid === "number" ? res.pid : undefined;
      } catch (e) {
        const f = failureOf(e);
        if (f.status === 405 || (f.status === 404 && f.reason === "Not Found"))
          return { kind: "failed", why: "This Hermes server has no gateway restart route (/api/gateway/restart). Updating Hermes adds it." };
        return { kind: "failed", why: clean(f.reason) };
      }
      if (pid !== undefined) this.last.set(profile, { pid, at: now() });
      if (pid === undefined || pid !== before?.pid) break;
      if (tries === 1) return { kind: "unconfirmed", why: "Hermes kept answering with the restart before this one, so this change may not be applied yet. Try again in a few seconds." };
      await sleep(COOLDOWN_MS);
    }

    if (pid !== undefined) {
      let done: Command | undefined;
      let heard: Command | undefined;
      const by = now() + this.timing.commandLimitMs;
      while (!done && now() < by) {
        await sleep(pollMs);
        const c = await this.within(this.rest("GET", "api/actions/gateway-restart/status").then(commandOf, () => undefined), by - now());
        if (c === LATE || !c) continue;
        heard = c;
        if (c.pid === pid && !c.running) done = c;
      }
      if (!done)
        return {
          kind: "unconfirmed",
          why: !heard
            ? `Hermes didn't say how the restart went within ${seconds(this.timing.commandLimitMs)} seconds.`
            : heard.pid !== pid
              ? "Another gateway restart started on the server while this one ran, so Hermes can't say how this one went."
              : `The restart was still running after ${seconds(this.timing.commandLimitMs)} seconds.`,
        };
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
    const by = now() + this.timing.backLimitMs;
    do {
      const s = await this.within(this.status(profile).catch(() => undefined), by - now());
      if (s !== LATE && s) {
        last = s;
        if (s.running && s.state === "running") return { kind: "restarted" };
      }
      await sleep(pollMs);
    } while (now() < by);
    const state = last ? (last.running ? `it reports "${last.state ?? "unknown"}"` : "it isn't running") : "its state couldn't be read";
    return { kind: "unconfirmed", why: `The restart command finished, but the gateway doesn't read back as running: ${state}.` };
  }
}
