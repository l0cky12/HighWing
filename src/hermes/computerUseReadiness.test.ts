// What Diagnostics' Computer use rows say (ADR 0215): `readinessOf` over the answers Hermes recorded
// (src/hermes/fixtures/computer-use/00-readiness, 01-readiness-p) and over the answers a broken setup gives.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { afterRead, afterTurnOn, computerUseToolset, isReady, noticeOf, readinessOf, type DesktopNotice, type PrereqId, type ReadinessAnswers, type Verdict } from "./computerUseReadiness";
import { parseDoctor, type CliResult, type DisplayStatus } from "./screen";
import type { Toolset, ToolsetChange, ToolsetList } from "./toolsets";

const recorded = (file: string): Record<string, unknown>[] =>
  readFileSync(fileURLToPath(new URL(`./fixtures/computer-use/${file}`, import.meta.url)), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { dir: string; frame: { result?: Record<string, unknown> } })
    .filter((l) => l.dir === "in" && l.frame.result)
    .map((l) => l.frame.result!);

const withProfile = recorded("01-readiness-p.jsonl");
const withoutProfile = recorded("00-readiness.jsonl");
const doctorWith = parseDoctor(withProfile[0] as CliResult);
const doctorWithout = parseDoctor(withoutProfile[0] as CliResult);
const screenStatus = withProfile[2] as unknown as DisplayStatus;

const ok = <T>(value: T): PromiseFulfilledResult<T> => ({ status: "fulfilled", value });
const failed = (reason: unknown): PromiseRejectedResult => ({ status: "rejected", reason });

const toolset = (enabled: boolean): Toolset => ({ name: "computer_use", label: "Computer Use", description: "", platform: "cli", platformLabel: "CLI", enabled, configured: true, tools: ["computer_use"], configOnly: false });
const list = (...toolsets: Toolset[]): ToolsetList => ({ profile: "hermes-chat", toolsets, readAt: 0 });

const healthy: ReadinessAnswers = { doctor: ok(doctorWith), status: ok(screenStatus), toolsets: ok(list(toolset(true))) };

const rows = (a: ReadinessAnswers) => Object.fromEntries(readinessOf(a).map((c) => [c.id, c.verdict])) as Record<PrereqId, Verdict>;
const status = (over: Partial<DisplayStatus>): DisplayStatus => ({ ...screenStatus, ...over });
const said = (v: Verdict) => (v.kind === "ok" ? v.detail : v.why);

describe("readinessOf over what Hermes recorded", () => {
  it("is green for every prerequisite when doctor ran with -p and passed", () => {
    const r = readinessOf(healthy);
    expect(r.map((c) => c.id)).toEqual(["toolset", "driver", "packages", "memory", "placement", "control"]);
    expect(r.map((c) => c.verdict.kind)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
    expect(isReady(r)).toBe(true);
    const v = rows(healthy);
    expect(v.driver).toEqual({ kind: "ok", detail: { kind: "hermes", text: "cua-driver 0.21.0" } });
    expect(v.packages).toEqual({ kind: "ok", detail: { kind: "screenRunning" } });
    expect(v.memory).toEqual({ kind: "ok", detail: { kind: "memory", availableMb: 19039, limitMb: 32000 } });
    expect(v.placement).toEqual({ kind: "ok", detail: { kind: "onGateway" } });
    expect(v.control).toEqual({ kind: "ok", detail: { kind: "agentHolds" } });
  });

  it("gives doctor's failing checks in Hermes's words, with the first hint as the fix, when doctor ran without -p", () => {
    expect(doctorWithout.code).toBe(1);
    const v = rows({ ...healthy, doctor: ok(doctorWithout) }).driver;
    expect(v).toEqual({
      kind: "bad",
      why: { kind: "hermes", text: "X11 is not reachable; UI inspection and event injection will fail. X11 is not reachable; screen capture will fail." },
      fix: { kind: "hint", say: { kind: "hermes", text: "Set DISPLAY (X11) — under Wayland, run via XWayland or expose XDG_SESSION_TYPE=x11." } },
    });
  });

  it("reads the recorded cli screen status and display.status the same way", () => {
    const viaCli = JSON.parse((withProfile[1] as CliResult).output) as DisplayStatus;
    expect(rows({ ...healthy, status: ok({ ...screenStatus, ...viaCli }) }).memory.kind).toBe("ok");
    const stopped = rows({ ...healthy, status: ok(status({ running: false, display: null, pid: null } as Partial<DisplayStatus>)) });
    expect(stopped.packages).toEqual({ kind: "ok", detail: { kind: "screenStopped" } });
  });
});

describe("readinessOf over a setup that can't run computer use", () => {
  it("says the toolset is off, and offers Settings → Toolsets", () => {
    expect(rows({ ...healthy, toolsets: ok(list(toolset(false))) }).toolset).toEqual({ kind: "bad", why: { kind: "toolsetOff" }, fix: { kind: "toolsets" } });
  });

  it("doesn't call a toolset this Hermes doesn't list off", () => {
    expect(rows({ ...healthy, toolsets: ok(list()) }).toolset).toEqual({ kind: "unknown", why: { kind: "toolsetNotListed" } });
    expect(rows({ ...healthy, toolsets: failed(new Error("no route")) }).toolset).toEqual({ kind: "unknown", why: { kind: "readFailed", error: "no route" } });
  });

  it("reads doctor's exit code 2 as no driver, with Hermes's own fix command", () => {
    const output = "cua-driver: not installed (looked for 'cua-driver (PATH and canonical install paths)').\n  Run: hermes computer-use install\n";
    expect(rows({ ...healthy, doctor: ok(parseDoctor({ blocked: false, code: 2, output })) }).driver).toEqual({
      kind: "bad",
      why: { kind: "hermes", text: "cua-driver: not installed (looked for 'cua-driver (PATH and canonical install paths)')." },
      fix: { kind: "command", command: "hermes computer-use install" },
    });
  });

  it("is unknown, not red, where Hermes won't run the command or has no such command", () => {
    const blocked = parseDoctor({ blocked: true, hint: "cli.exec is turned off on this server", code: 0, output: "" });
    expect(rows({ ...healthy, doctor: ok(blocked) }).driver).toEqual({ kind: "unknown", why: { kind: "hermes", text: "cli.exec is turned off on this server" } });
    const older = parseDoctor({ blocked: false, code: 2, output: "usage: hermes [-h] ...\nhermes: error: argument command: invalid choice: 'computer-use'" });
    expect(rows({ ...healthy, doctor: ok(older) }).driver).toEqual({ kind: "unknown", why: { kind: "olderHermes" } });
    const noMethod = Object.assign(new Error("unknown method: cli.exec"), { code: -32601 });
    expect(rows({ ...healthy, doctor: failed(noMethod) }).driver).toEqual({ kind: "unknown", why: { kind: "olderHermes" } });
  });

  it("names the packages the screen lacks, with Hermes's install command", () => {
    const missing = status({ installed: false, missing: ["Xvnc", "xfce4-session"], install_command: "sudo apt install tigervnc-standalone-server xfce4" });
    expect(rows({ ...healthy, status: ok(missing) }).packages).toEqual({
      kind: "bad",
      why: { kind: "packagesMissing", missing: ["Xvnc", "xfce4-session"] },
      fix: { kind: "command", command: "sudo apt install tigervnc-standalone-server xfce4" },
    });
    expect(rows({ ...healthy, status: ok(status({ supported: false })) }).packages).toEqual({ kind: "bad", why: { kind: "unsupportedHost" } });
  });

  it("says Hermes's memory blocker for a screen it runs itself", () => {
    const blocker = "Not enough free memory for a desktop: 900 MB available of 32000 MB, 1536 MB needed (bot_desktop.min_free_memory_mb)";
    const v = rows({ ...healthy, status: ok(status({ running: false, blocker, memory_available_mb: 900 })) });
    expect(v.memory).toEqual({ kind: "bad", why: { kind: "hermes", text: blocker } });
    expect(v.placement.kind).toBe("ok");
  });

  it("is unknown for memory where Hermes doesn't report it", () => {
    expect(rows({ ...healthy, status: ok(status({ memory_available_mb: null, memory_limit_mb: null })) }).memory).toEqual({ kind: "unknown", why: { kind: "memoryNotReported" } });
  });

  it("says why a placement is refused, in Hermes's words when it gives them", () => {
    const why = "terminal.backend is modal, which cannot host a screen yet. Set bot_desktop.placement: gateway to allow that explicitly.";
    expect(rows({ ...healthy, status: ok(status({ placement: "refused", blocker: why })) }).placement).toEqual({ kind: "bad", why: { kind: "hermes", text: why } });
    expect(rows({ ...healthy, status: ok(status({ placement: "refused" })) }).placement).toEqual({ kind: "bad", why: { kind: "placementRefused" } });
  });

  it("gives a screen in a sandbox its blocker as the placement's, not as a memory blocker", () => {
    const blocker = "The terminal backend's sandbox image lacks Xvnc. Use the desktop image, or set bot_desktop.placement: gateway.";
    const v = rows({ ...healthy, status: ok(status({ placement: "terminal:docker", running: false, blocker, memory_available_mb: null, memory_limit_mb: null })) });
    expect(v.placement).toEqual({ kind: "bad", why: { kind: "hermes", text: blocker } });
    expect(v.memory.kind).toBe("unknown");
    expect(rows({ ...healthy, status: ok(status({ placement: "terminal:docker" })) }).placement).toEqual({ kind: "ok", detail: { kind: "inSandbox", backend: "docker" } });
  });

  it("says computer_use is refused while a person holds the screen", () => {
    const held = status({ lease: { holder: "human", viewer_hash: "ba7816bf8f01", since: 1, epoch: 3 } });
    const v = rows({ ...healthy, status: ok(held) }).control;
    expect(v).toEqual({ kind: "bad", why: { kind: "humanHolds" }, fix: { kind: "hint", say: { kind: "handBack" } } });
    expect(isReady(readinessOf({ ...healthy, status: ok(held) }))).toBe(false);
  });

  it("makes every row read from display.status unknown, and never green, when it can't be read", () => {
    const v = rows({ ...healthy, status: failed(new Error("Not connected to Hermes.")) });
    for (const id of ["packages", "memory", "placement", "control"] as const) expect(v[id]).toEqual({ kind: "unknown", why: { kind: "readFailed", error: "Not connected to Hermes." } });
    expect(v.driver.kind).toBe("ok");
    expect(isReady(readinessOf({ ...healthy, status: failed(new Error("x")) }))).toBe(false);
  });

  it("calls a Hermes before the Bot Desktop old, not broken", () => {
    const noMethod = Object.assign(new Error("unknown method: display.status"), { code: -32601 });
    expect(rows({ ...healthy, status: failed(noMethod) }).packages).toEqual({ kind: "unknown", why: { kind: "olderHermes" } });
  });

  it("reports a plugin backend's plain-text doctor by its exit code", () => {
    expect(said(rows({ ...healthy, doctor: ok(parseDoctor({ blocked: false, code: 0, output: "Computer Use backend: hypruse (Hyprland) — available.\n" })) }).driver)).toEqual({
      kind: "hermes",
      text: "Computer Use backend: hypruse (Hyprland) — available.",
    });
    expect(rows({ ...healthy, doctor: ok(parseDoctor({ blocked: false, code: 1, output: "Computer Use backend: hypruse (Hyprland) — not available.\n" })) }).driver.kind).toBe("bad");
  });
});

describe("what a Bot Chat's Desktop control notice shows", () => {
  const row = toolset(false);
  const noteOf = (...toolsets: Toolset[]) => noticeOf(list(...toolsets));

  it("is the notice only for a listed computer_use on the cli platform that is off and can be switched", () => {
    expect(noteOf(row)).toEqual({ kind: "off", row });
    expect(noteOf(toolset(true))).toEqual({ kind: "hidden" });
    expect(noteOf()).toEqual({ kind: "hidden" });
    expect(noteOf({ ...row, platform: "discord", platformLabel: "Discord" })).toEqual({ kind: "hidden" });
    expect(noteOf({ ...row, configOnly: true })).toEqual({ kind: "hidden" });
  });

  it("reads the same row the readiness table does", () => {
    expect(computerUseToolset(list(toolset(true)))?.enabled).toBe(true);
    expect(computerUseToolset(list({ ...row, name: "web" }))).toBeUndefined();
  });

  describe("after Turn on", () => {
    const on = list(toolset(true));
    const off = list(row);
    const results: [string, ToolsetChange, DesktopNotice][] = [
      ["saved, with Hermes installing the driver", { kind: "saved", list: on, installing: "cua_driver" }, { kind: "on", installing: "cua_driver" }],
      ["saved after an error Hermes read back as on", { kind: "saved", list: on, warning: "502" }, { kind: "on", warning: "502" }],
      ["saved", { kind: "saved", list: on }, { kind: "on" }],
      ["asked about something new", { kind: "confirm", list: off, cautions: [{ kind: "noMcp", platform: "cli" }] }, { kind: "ask", row, cautions: [{ kind: "noMcp", platform: "cli" }] }],
      ["turned on elsewhere meanwhile", { kind: "conflict", list: on, now: true }, { kind: "hidden" }],
      ["turned off elsewhere meanwhile", { kind: "conflict", list: off, now: false }, { kind: "off", row }],
      ["no longer listed", { kind: "conflict", list: list() }, { kind: "hidden" }],
      ["refused, with the list read again", { kind: "rejected", reason: "nope", list: off }, { kind: "off", row, why: { kind: "rejected", reason: "nope" } }],
      ["refused, with no list", { kind: "rejected", reason: "nope" }, { kind: "off", row, why: { kind: "rejected", reason: "nope" } }],
      ["taken but read back off", { kind: "mismatch", list: off }, { kind: "off", row, why: { kind: "mismatch" } }],
      ["unconfirmed, then read as on", { kind: "unknown", reason: "lost", answered: false, list: on }, { kind: "on" }],
      ["unconfirmed, then read as off", { kind: "unknown", reason: "lost", answered: false, list: off }, { kind: "off", row, why: { kind: "unknown", reason: "lost" } }],
      ["unconfirmed, with no list", { kind: "unknown", reason: "lost", answered: false }, { kind: "off", row, why: { kind: "unknown", reason: "lost" } }],
    ];
    it.each(results)("%s", (_, change, notice) => expect(afterTurnOn(row, change)).toEqual(notice));
  });

  describe("after a read", () => {
    const off: DesktopNotice = { kind: "off", row };
    const hidden: DesktopNotice = { kind: "hidden" };
    const asking: DesktopNotice = { kind: "ask", row, cautions: [] };
    it("shows what was read, and keeps what it is for when the read failed", () => {
      expect(afterRead(hidden, off)).toEqual(off);
      expect(afterRead(off, hidden)).toEqual(hidden);
      expect(afterRead(off, undefined)).toEqual(off);
      expect(afterRead(hidden, undefined)).toEqual(hidden);
    });
    it("leaves a change under way, and the line saying it is on, alone", () => {
      const busy: DesktopNotice = { kind: "busy", row, step: "saving" };
      expect(afterRead(busy, hidden)).toEqual(busy);
      expect(afterRead({ kind: "on" }, hidden)).toEqual({ kind: "on" });
      expect(afterRead({ kind: "on" }, off)).toEqual(off);
    });
    it("drops a question once the toolset is no longer off, and keeps why a Turn on failed while it still is", () => {
      expect(afterRead(asking, off)).toEqual(asking);
      expect(afterRead(asking, hidden)).toEqual(hidden);
      expect(afterRead({ ...off, why: { kind: "mismatch" } }, off)).toEqual({ ...off, why: { kind: "mismatch" } });
    });
  });
});
