// The Restart gateway button's API (gatewayRestart.ts, ADR 0205) against the fake dashboard's restart routes
// (fakeGateways.ts): a restart counts only once Hermes reads the gateway back as running, and every other ending says why.
import { describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { fakeClock } from "./fakeGateways";
import { connect } from "./transport";
import { GatewayRestartApi, type RestartTiming } from "./gatewayRestart";
import type { RestMethod } from "./pipe";

async function setUp() {
  const server = new FakeHermes();
  server.otherProfiles = { work: [] };
  const fake = server.gateways;
  fake.env.default = { TELEGRAM_BOT_TOKEN: "123456789:AAAAdummydummydummydummydummydummy00" };
  fake.enabled.default = { telegram: true };
  fake.gateway.default = { running: true, platforms: {} };
  const pipe = await server.openPipe(() => {}, "default");
  const rest = async (m: RestMethod, p: string, b?: unknown) => JSON.parse(await pipe.request(m, p, b === undefined ? undefined : JSON.stringify(b)));
  const clock = fakeClock();
  fake.now = clock.now;
  const timing: RestartTiming = { ...clock, pollMs: 100, commandLimitMs: 2000, backLimitMs: 500 };
  return { server, fake, rest, clock, timing, api: new GatewayRestartApi(rest, timing) };
}

describe("Gateway restart: status", () => {
  it("reads the asked profile's gateway through the transport", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { work: [] };
    server.gateways.gateway.work = { running: true, platforms: {}, activeAgents: 2, sharedWith: ["default", "work"] };
    const hermes = await connect(server.openPipe, "default");
    expect(await hermes.gatewayRestart.status("work")).toEqual({ running: true, state: "running", activeAgents: 2, sharedWith: ["default", "work"] });
    expect(await hermes.gatewayRestart.status("default")).toEqual({ running: false, state: "stopped", activeAgents: 0, sharedWith: [] });
  });
});

describe("Gateway restart: restart", () => {
  it("restarts, and the platform waiting for it connects", async () => {
    const { fake, api } = await setUp();
    expect(await api.restart("default")).toEqual({ kind: "restarted" });
    expect(fake.restarts).toEqual({ default: 1 });
    expect(fake.gateway.default.platforms.telegram).toEqual({ state: "connected" });
  });

  it("starts a stopped gateway, as Hermes's restart does", async () => {
    const { fake, api } = await setUp();
    fake.gateway.default.running = false;
    expect(await api.restart("default")).toEqual({ kind: "restarted" });
    expect(fake.gateway.default.running).toBe(true);
  });

  it("calls a nonzero exit failed, with the command's last lines", async () => {
    const { fake, api } = await setUp();
    fake.restartPlan = { exit: 1, lines: ["Gateway restart failed: unit hermes-gateway.service not found"], comesBack: false };
    const r = await api.restart("default");
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.why).toMatch(/exit 1.*unit hermes-gateway\.service not found/);
    expect(fake.restarts).toEqual({});
  });

  it("doesn't take exit 0 as proof when the gateway doesn't read back as running", async () => {
    const { fake, api } = await setUp();
    fake.gateway.default.running = false;
    fake.restartPlan = { exit: 0, lines: ["Warning: linger is off; the gateway was not restarted."], comesBack: false };
    const r = await api.restart("default");
    expect(r).toEqual({ kind: "unconfirmed", why: "The restart command finished, but the gateway doesn't read back as running: it isn't running." });
  });

  it("calls it failed when Hermes skipped a systemd restart for want of linger, though the old gateway still runs", async () => {
    const { fake, api } = await setUp();
    fake.restartPlan = {
      exit: 0,
      lines: ["⚠ Cannot restart gateway as a service — linger is not enabled.", "  The gateway user service requires linger to function on headless servers.", "  Run:  sudo loginctl enable-linger hermes"],
      comesBack: false,
    };
    const r = await api.restart("default");
    expect(r).toEqual({
      kind: "failed",
      why: "Hermes couldn't restart the gateway's service because linger isn't enabled for its user on the server. Run: sudo loginctl enable-linger hermes",
    });
    expect(fake.restarts).toEqual({});
  });

  it("calls a refused restart failed, with Hermes's reason", async () => {
    const { fake, api } = await setUp();
    fake.refuseRestart = { status: 500, detail: "Failed to restart gateway: the system service needs passwordless sudo (sudo -n failed)" };
    expect(await api.restart("default")).toEqual({ kind: "failed", why: "Failed to restart gateway: the system service needs passwordless sudo (sudo -n failed)" });
    expect(fake.restarts).toEqual({});
  });

  it("says updating Hermes adds the route when the server has none", async () => {
    const { fake, api } = await setUp();
    fake.restartRoute = false;
    const r = await api.restart("default");
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.why).toMatch(/no gateway restart route.*Updating Hermes adds it/);
  });

  it("refuses while another profile's restart is running, as Hermes does", async () => {
    const { fake, api } = await setUp();
    fake.restartPolls = 1000;
    void api.restart("work");
    const r = await api.restart("default");
    expect(r).toEqual({ kind: "failed", why: "Failed to restart gateway: gateway restart already in progress for another profile" });
  });

  it("calls it unconfirmed when the command outlasts the wait", async () => {
    const { fake, api } = await setUp();
    fake.restartPolls = 1000;
    expect(await api.restart("default")).toEqual({ kind: "unconfirmed", why: "The restart was still running after 2 seconds." });
  });

  it("restarts again for a change made right after a restart, past Hermes's cooldown", async () => {
    const { fake, clock, api } = await setUp();
    expect(await api.restart("default")).toEqual({ kind: "restarted" });
    const first = clock.now();
    expect(await api.restart("default")).toEqual({ kind: "restarted" });
    expect(fake.restarts).toEqual({ default: 2 });
    expect(clock.now() - first).toBeGreaterThanOrEqual(10_000);
  });

  it("calls it unconfirmed when Hermes keeps answering with the last restart", async () => {
    const { fake, api } = await setUp();
    expect(await api.restart("default")).toEqual({ kind: "restarted" });
    fake.now = () => 0;
    expect(await api.restart("default")).toEqual({
      kind: "unconfirmed",
      why: "Hermes kept answering with the restart before this one, so this change may not be applied yet. Try again in a few seconds.",
    });
    expect(fake.restarts).toEqual({ default: 1 });
  });

  it("clears the profile's marks the restart applied, and keeps one saved while it ran", async () => {
    const { rest, timing } = await setUp();
    const api: GatewayRestartApi = new GatewayRestartApi((m, p, b) => {
      if (p.startsWith("api/actions/")) api.mark("default", "mcp:git");
      return rest(m, p, b);
    }, timing);
    api.mark("default", "mcp:fs");
    api.mark("work", "gateways:telegram");
    expect(await api.restart("default")).toEqual({ kind: "restarted" });
    expect([...api.marksOf("default")]).toEqual(["mcp:git"]);
    expect([...api.marksOf("work")]).toEqual(["gateways:telegram"]);
  });

  it("keeps a mark saved again while the restart ran, though the restart was asked with it", async () => {
    const { rest, timing } = await setUp();
    let saved = false;
    const api: GatewayRestartApi = new GatewayRestartApi((m, p, b) => {
      if (p.startsWith("api/actions/") && !saved) {
        saved = true;
        api.unmark("default", "mcp:fs");
        api.mark("default", "mcp:fs");
      }
      return rest(m, p, b);
    }, timing);
    api.mark("default", "mcp:fs");
    expect(await api.restart("default")).toEqual({ kind: "restarted" });
    expect([...api.marksOf("default")]).toEqual(["mcp:fs"]);
  });

  it("stops waiting on a read Hermes never answers, once the limit has passed", async () => {
    const { rest, clock, timing } = await setUp();
    const stalled: typeof rest = (m, p, b) => (p.startsWith("api/actions/gateway-restart/status") ? new Promise(() => {}) : rest(m, p, b));
    expect(await new GatewayRestartApi(stalled, timing).restart("default")).toEqual({ kind: "unconfirmed", why: "Hermes didn't say how the restart went within 2 seconds." });
    expect(clock.now()).toBeLessThanOrEqual(2100);
  });
});
