// The Restart gateway button's API (gatewayRestart.ts, ADR 0203) against the fake dashboard's restart routes
// (fakeGateways.ts): a restart counts only once Hermes reads the gateway back as running, and every other ending says why.
import { describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { connect } from "./transport";
import { GatewayRestartApi, type RestartTiming } from "./gatewayRestart";
import type { RestMethod } from "./pipe";

const FAST: RestartTiming = { sleep: () => Promise.resolve(), pollMs: 100, commandLimitMs: 2000, backLimitMs: 500 };

async function setUp() {
  const server = new FakeHermes();
  server.otherProfiles = { work: [] };
  const fake = server.gateways;
  fake.env.default = { TELEGRAM_BOT_TOKEN: "123456789:AAAAdummydummydummydummydummydummy00" };
  fake.enabled.default = { telegram: true };
  fake.gateway.default = { running: true, platforms: {} };
  const pipe = await server.openPipe(() => {}, "default");
  const rest = async (m: RestMethod, p: string, b?: unknown) => JSON.parse(await pipe.request(m, p, b === undefined ? undefined : JSON.stringify(b)));
  return { server, fake, api: new GatewayRestartApi(rest, FAST) };
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
});
