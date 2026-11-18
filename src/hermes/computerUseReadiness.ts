// Whether Hermes's `computer_use` can run for the shown profile, prerequisite by prerequisite (ADR 0215). Each verdict
// is Hermes's own words where it has them (doctor's check messages and hints, `display.status`'s blocker), and a coded
// sentence of this app's where it doesn't, so the screen writes it in the owner's language.
import { isUnavailable, type DisplayStatus, type DoctorAnswer, type ScreenApi } from "./screen";
import type { ToolsetList } from "./toolsets";
import { errorText } from "./values";

/** The toolset Hermes names `computer_use`, which the owner switches in Settings → Toolsets. */
export const COMPUTER_USE_TOOLSET = "computer_use";

/** The row list, in order. `CHECKS` has one function for each, so a prerequisite can't be listed and left unread. */
export const PREREQS = ["toolset", "driver", "packages", "memory", "placement", "control"] as const;
export type PrereqId = (typeof PREREQS)[number];

/** A sentence a verdict says: Hermes's own, or one of this app's. */
export type Say =
  | { kind: "hermes"; text: string }
  | { kind: "olderHermes" }
  | { kind: "blocked" }
  | { kind: "readFailed"; error: string }
  | { kind: "toolsetOff" }
  | { kind: "toolsetNotListed" }
  | { kind: "driverNotInstalled" }
  | { kind: "unsupportedHost" }
  | { kind: "packagesMissing"; missing: string[] }
  | { kind: "screenRunning" }
  | { kind: "screenStopped" }
  | { kind: "memory"; availableMb: number; limitMb: number }
  | { kind: "memoryNotReported" }
  | { kind: "onGateway" }
  | { kind: "inSandbox"; backend: string }
  | { kind: "placementRefused" }
  | { kind: "placementNotReported" }
  | { kind: "humanHolds" }
  | { kind: "handBack" }
  | { kind: "agentHolds" };

export type Fix = { kind: "command"; command: string } | { kind: "hint"; say: Say } | { kind: "toolsets" };

export type Verdict = { kind: "ok"; detail?: Say } | { kind: "bad"; why: Say; fix?: Fix } | { kind: "unknown"; why: Say };

export type ReadinessCheck = { id: PrereqId; verdict: Verdict };

/** Every prerequisite, in `PREREQS` order. */
export type Readiness = ReadinessCheck[];

export const isReady = (r: Readiness) => r.every((c) => c.verdict.kind === "ok");

/** What each read came to. A read that failed is an answer: its prerequisites are unknown, never green. */
export type ReadinessAnswers = {
  doctor: PromiseSettledResult<DoctorAnswer>;
  status: PromiseSettledResult<DisplayStatus>;
  toolsets: PromiseSettledResult<ToolsetList>;
};

const hermes = (text: string): Say => ({ kind: "hermes", text });
const unknown = (why: Say): Verdict => ({ kind: "unknown", why });
const bad = (why: Say, fix?: Fix): Verdict => ({ kind: "bad", why, ...(fix && { fix }) });
const firstLine = (text: string) => text.trim().split("\n")[0].trim();

const unreadable = (e: unknown): Say => (isUnavailable(e) ? { kind: "olderHermes" } : { kind: "readFailed", error: errorText(e) });

/** What `hermes computer-use` prints when this Hermes has no such command. */
const NO_COMMAND = /invalid choice|unrecognized arguments|no such command|usage:/i;

function driver(a: ReadinessAnswers): Verdict {
  if (a.doctor.status === "rejected") return unknown(unreadable(a.doctor.reason));
  const d = a.doctor.value;
  if (d.blocked) return unknown(d.hint ? hermes(d.hint) : { kind: "blocked" });
  if (d.code === 2 && !d.report) {
    if (NO_COMMAND.test(d.output)) return unknown({ kind: "olderHermes" });
    const fix = /Run: (hermes [^\n]+)/.exec(d.output)?.[1];
    return bad(firstLine(d.output) ? hermes(firstLine(d.output)) : { kind: "driverNotInstalled" }, fix ? { kind: "command", command: fix.trim() } : undefined);
  }
  const failing = d.report?.checks.filter((c) => c.status === "fail") ?? [];
  if (d.code === 0) return { kind: "ok", detail: hermes(d.report?.driver_version ? `cua-driver ${d.report.driver_version}` : firstLine(d.output)) };
  const hint = failing.find((c) => c.hint)?.hint;
  const why = failing.length ? failing.map((c) => c.message).join(" ") : firstLine(d.output);
  return bad(hermes(why || d.output.trim()), hint ? { kind: "hint", say: hermes(hint) } : undefined);
}

function toolset(a: ReadinessAnswers): Verdict {
  if (a.toolsets.status === "rejected") return unknown({ kind: "readFailed", error: errorText(a.toolsets.reason) });
  const t = a.toolsets.value.toolsets.find((x) => x.name === COMPUTER_USE_TOOLSET);
  if (!t) return unknown({ kind: "toolsetNotListed" });
  return t.enabled ? { kind: "ok" } : bad({ kind: "toolsetOff" }, { kind: "toolsets" });
}

/** A row read from `display.status`: unknown for every one of them when it couldn't be read. */
function fromStatus(a: ReadinessAnswers, row: (s: DisplayStatus) => Verdict): Verdict {
  return a.status.status === "rejected" ? unknown(unreadable(a.status.reason)) : row(a.status.value);
}

const inSandbox = (s: DisplayStatus) => !!s.placement?.startsWith("terminal:");

const CHECKS: Record<PrereqId, (a: ReadinessAnswers) => Verdict> = {
  toolset,
  driver,
  packages: (a) =>
    fromStatus(a, (s) => {
      if (!s.supported) return bad({ kind: "unsupportedHost" });
      if (!s.installed) return bad({ kind: "packagesMissing", missing: s.missing }, s.install_command ? { kind: "command", command: s.install_command } : undefined);
      return { kind: "ok", detail: { kind: s.running ? "screenRunning" : "screenStopped" } };
    }),
  memory: (a) =>
    fromStatus(a, (s) => {
      if (s.blocker && !inSandbox(s) && s.placement !== "refused") return bad(hermes(s.blocker));
      const { memory_available_mb: available, memory_limit_mb: limit } = s;
      return typeof available === "number" && typeof limit === "number" ? { kind: "ok", detail: { kind: "memory", availableMb: available, limitMb: limit } } : unknown({ kind: "memoryNotReported" });
    }),
  placement: (a) =>
    fromStatus(a, (s) => {
      if (s.placement === "refused") return bad(s.blocker ? hermes(s.blocker) : { kind: "placementRefused" });
      if (s.placement === "gateway") return { kind: "ok", detail: { kind: "onGateway" } };
      if (inSandbox(s)) return s.blocker ? bad(hermes(s.blocker)) : { kind: "ok", detail: { kind: "inSandbox", backend: s.placement!.slice("terminal:".length) } };
      return unknown({ kind: "placementNotReported" });
    }),
  control: (a) =>
    fromStatus(a, (s) => (s.lease.holder === "human" ? bad({ kind: "humanHolds" }, { kind: "hint", say: { kind: "handBack" } }) : { kind: "ok", detail: { kind: "agentHolds" } })),
};

/**
 * Pure. `driver`: doctor's exit code 0 is ok, 1 is degraded (each failing check's message, the first hint as the fix), 2
 * is no driver, and a blocked answer or an unknown command is unknown (an older Hermes). `memory`: a blocker on a
 * screen Hermes runs itself is a memory blocker. `placement`: a screen in a sandbox owns its blocker.
 */
export const readinessOf = (a: ReadinessAnswers): Readiness => PREREQS.map((id) => ({ id, verdict: CHECKS[id](a) }));

/** Asks all three at once and folds the answers. */
export async function checkReadiness(deps: { screen: Pick<ScreenApi, "doctor" | "status">; toolsets: () => Promise<ToolsetList> }): Promise<Readiness> {
  const [doctor, status, toolsets] = await Promise.allSettled([deps.screen.doctor(), deps.screen.status(), deps.toolsets()]);
  return readinessOf({ doctor, status, toolsets });
}
