// The Screen's logic (screen.ts, ADR 0039): what to show for each `display.status`, how the lease is read, the
// WebSocket-shaped relay noVNC drives, and `display.*` over the transport against FakeHermes.
import { describe, expect, it, vi } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { connect } from "./transport";
import { RelayedSocket, browserOf, isOlder, isUnavailable, parseDoctor, phaseOf, viewerHash, type DisplayLease, type DisplayStatus, type ScreenSocket } from "./screen";

const agent: DisplayLease = { holder: "agent", viewer_hash: null, since: 1, epoch: 0 };
const status = (s: Partial<DisplayStatus>): DisplayStatus => ({ supported: true, installed: true, missing: [], running: false, lease: agent, profile_key: "/h", ...s });

describe("What the Screen shows", () => {
  it("reads each state of the screen from display.status", () => {
    expect(phaseOf(status({ supported: false }))).toEqual({ kind: "unsupported" });
    expect(phaseOf(status({ installed: false, missing: ["Xvnc"], install_command: "sudo pacman -S tigervnc" }))).toEqual({
      kind: "not-installed",
      missing: ["Xvnc"],
      command: "sudo pacman -S tigervnc",
    });
    expect(phaseOf(status({ blocker: "only 900 MB free; the screen needs 1536 MB" }))).toEqual({ kind: "blocked", why: "only 900 MB free; the screen needs 1536 MB" });
    expect(phaseOf(status({}))).toEqual({ kind: "stopped" });
    expect(phaseOf(status({ running: true }))).toEqual({ kind: "live" });
  });

  it("reads the server's browser, and tells a none apart from a null Hermes sends where it doesn't look", () => {
    expect(browserOf(status({ browser: "/usr/bin/chromium" }))).toEqual({ kind: "found", path: "/usr/bin/chromium" });
    expect(browserOf(status({ browser: null }))).toEqual({ kind: "missing" });
    expect(browserOf(status({ browser: null, placement: "gateway" }))).toEqual({ kind: "missing" });
    expect(browserOf(status({}))).toEqual({ kind: "unknown", why: "older-hermes" });
    expect(browserOf(status({ browser: null, supported: false }))).toEqual({ kind: "unknown", why: "not-linux" });
    expect(browserOf(status({ browser: null, placement: "terminal:docker" }))).toEqual({ kind: "unknown", why: "in-sandbox" });
  });

  it("names the lease's holder by the same hash Hermes does, and never trusts an older lease", async () => {
    // Python: hashlib.sha256(b"abc").hexdigest()[:12]
    expect(await viewerHash("abc")).toBe("ba7816bf8f01");
    const mine: DisplayLease = { holder: "human", viewer_hash: "ba7816bf8f01", since: 2, epoch: 3 };
    expect(isOlder(mine, { ...agent, epoch: 2 })).toBe(true);
    expect(isOlder(mine, { ...agent, epoch: 4 })).toBe(false);
  });

  it("tells a Hermes without the screen apart from other failures", () => {
    expect(isUnavailable(Object.assign(new Error("unknown method: display.status"), { code: -32601 }))).toBe(true);
    expect(isUnavailable(new Error("Method not found"))).toBe(true);
    expect(isUnavailable(new Error("Not connected to Hermes."))).toBe(false);
  });
});

describe("The relayed stream noVNC drives", () => {
  function relay() {
    let onData!: (b: ArrayBuffer) => void;
    let onClose!: (code: number, reason: string) => void;
    const sent: Uint8Array[] = [];
    const sock: ScreenSocket & { closed: number } = { closed: 0, send: (b) => void sent.push(b), close: () => void sock.closed++ };
    const open = vi.fn(async (_t: string, d: typeof onData, c: typeof onClose) => {
      onData = d;
      onClose = c;
      return sock;
    });
    return { open, sent, sock, data: (b: number[]) => onData(new Uint8Array(b).buffer), close: (code: number) => onClose(code, "control-taken") };
  }

  it("opens on the next task and hands over bytes that came before noVNC was listening", async () => {
    const r = relay();
    const ws = await RelayedSocket.open(r.open, "ticket-1");
    expect(r.open.mock.calls[0][0]).toBe("ticket-1");
    expect(ws.readyState).toBe(0);
    r.data([82, 70, 66]);
    const got: number[][] = [];
    ws.onmessage = (e) => void got.push([...new Uint8Array(e.data)]);
    const opened = vi.fn();
    ws.onopen = opened;
    await new Promise((d) => setTimeout(d, 0));
    expect(opened).toHaveBeenCalledOnce();
    expect(ws.readyState).toBe(1);
    expect(got).toEqual([[82, 70, 66]]);
  });

  it("copies what it sends, since noVNC reuses its buffer at once", async () => {
    const r = relay();
    const ws = await RelayedSocket.open(r.open, "t");
    await new Promise((d) => setTimeout(d, 0));
    const buffer = new Uint8Array([1, 2, 3]);
    ws.send(buffer.subarray(0, 2));
    buffer[0] = 9;
    expect([...r.sent[0]]).toEqual([1, 2]);
  });

  it("reports Hermes's close code, and closes normally itself so control goes back to the agent", async () => {
    const r = relay();
    const ws = await RelayedSocket.open(r.open, "t");
    await new Promise((d) => setTimeout(d, 0));
    const closed = vi.fn();
    ws.onclose = closed;
    r.close(4000);
    expect(ws.closeCode).toBe(4000);
    // Rust lets go of its end of a stream Hermes closed.
    expect(r.sock.closed).toBe(1);
    expect(closed).toHaveBeenCalledWith({ code: 4000, reason: "control-taken", wasClean: false });
    ws.send(new Uint8Array([1]));
    expect(r.sent).toHaveLength(0);

    const r2 = relay();
    const ws2 = await RelayedSocket.open(r2.open, "t");
    await new Promise((d) => setTimeout(d, 0));
    ws2.close();
    expect(r2.sock.closed).toBe(1);
    expect(ws2.closeCode).toBe(1000);
  });
});

describe("display.* over the connection", () => {
  const running = () => ({ status: { supported: true, installed: true, missing: [], running: true }, lease: { holder: "agent" as const, viewer_hash: null, since: 1, epoch: 0 }, minted: new Set<string>() });

  it("asks for the profile shown, mints a viewer, takes over and hands back, and the snapshot says who holds the screen", async () => {
    const server = new FakeHermes();
    server.display = { status: { supported: true, installed: true, missing: [], running: false, geometry: "1440x900" }, lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 }, minted: new Set() };
    const hermes = await connect(server.openPipe);

    expect((await hermes.screen.status()).running).toBe(false);
    expect(hermes.getSnapshot().screen).toEqual({ profileKey: "/home/lena/.hermes", holder: { kind: "agent" }, epoch: 0 });
    await expect(hermes.screen.observe()).rejects.toThrow(/not running/);
    expect((await hermes.screen.start()).running).toBe(true);
    const seen = await hermes.screen.observe();
    expect(seen).toMatchObject({ ticket: "ticket-viewer-1", viewer_id: "viewer-1" });
    // Observing again keeps the viewer this connection minted, so a re-attach keeps the lease it holds.
    expect((await hermes.screen.observe()).viewer_id).toBe("viewer-1");
    expect(server.requests.filter((r) => r.method === "display.observe").map((r) => r.params.viewer_id)).toEqual([undefined, undefined, "viewer-1"]);

    expect(await hermes.screen.takeOver()).toEqual({ kind: "held" });
    await vi.waitFor(() => expect(hermes.getSnapshot().screen?.holder).toEqual({ kind: "you", since: 2 }));
    expect(await hermes.screen.takeOver()).toEqual({ kind: "already" });
    expect(server.requests.filter((r) => r.method === "display.lease.acquire")).toHaveLength(1);
    await hermes.screen.handBack();
    await vi.waitFor(() => expect(hermes.getSnapshot().screen?.holder).toEqual({ kind: "agent" }));

    const asked = server.requests.filter((r) => r.method.startsWith("display."));
    expect(asked.every((r) => r.params.profile === "default")).toBe(true);
  });

  it("takes the screen without the Screen tab, minting a viewer first, and says when there is none to take", async () => {
    const server = new FakeHermes();
    server.display = running();
    const hermes = await connect(server.openPipe);
    expect(await hermes.screen.takeOver("Stopped from Highwing")).toEqual({ kind: "held" });
    expect(server.requests.filter((r) => r.method.startsWith("display.")).map((r) => r.method)).toEqual(["display.observe", "display.lease.acquire"]);
    expect(server.last("display.lease.acquire")!.params).toMatchObject({ viewer_id: "viewer-1", reason: "Stopped from Highwing" });
    expect(server.display.lease.holder).toBe("human");

    const stopped = new FakeHermes();
    stopped.display = { ...running(), status: { supported: true, installed: true, missing: [], running: false } };
    const other = await connect(stopped.openPipe);
    expect(await other.screen.takeOver()).toMatchObject({ kind: "no-screen", why: expect.stringMatching(/not running/) });
    const none = await connect(new FakeHermes().openPipe);
    expect((await none.screen.takeOver()).kind).toBe("no-screen");
  });

  it("hears who took the screen from Hermes's broadcasts, and only for the profile shown", async () => {
    const server = new FakeHermes();
    server.display = running();
    const hermes = await connect(server.openPipe);
    await hermes.screen.status();
    server.broadcast("display.lease", { profile_key: "/home/lena/.hermes", lease: { holder: "human", viewer_hash: "0123456789ab", since: 3, reason: "a sign-in", epoch: 1 } });
    await vi.waitFor(() => expect(hermes.getSnapshot().screen?.holder).toEqual({ kind: "someone", since: 3, reason: "a sign-in" }));
    server.broadcast("display.lease", { profile_key: "/home/lena/.hermes/profiles/work", lease: { holder: "agent", viewer_hash: null, since: 4, epoch: 9 } });
    server.broadcast("display.lease", { profile_key: "/home/lena/.hermes", lease: { holder: "agent", viewer_hash: null, since: 0, epoch: 0 } });
    // Answered after both broadcasts went out, with the stale epoch-0 lease the fake still keeps.
    await hermes.screen.status();
    expect(hermes.getSnapshot().screen).toMatchObject({ holder: { kind: "someone" }, epoch: 1 });
  });

  it("knows a hold from a connection since dropped is still the owner's", async () => {
    const server = new FakeHermes();
    server.display = running();
    const hermes = await connect(server.openPipe);
    await hermes.screen.takeOver();
    await vi.waitFor(() => expect(hermes.getSnapshot().screen?.holder.kind).toBe("you"));
    server.drop();
    await vi.waitFor(() => expect(hermes.getSnapshot().screen?.holder.kind).toBe("you-before"));
    await hermes.reconnect();
    await hermes.screen.observe();
    expect(hermes.getSnapshot().screen?.holder.kind).toBe("you-before");
    expect(server.display.lease.holder).toBe("human");
  });

  it.each(["another profile", "sign-out"])("hands back the screen the owner holds before leaving for %s, stream or no stream", async (leave) => {
    const server = new FakeHermes();
    server.otherProfiles = { work: [] };
    server.display = running();
    const hermes = await connect(server.openPipe);
    const { viewer_id } = await hermes.screen.observe();
    await hermes.screen.takeOver();
    expect(server.display.lease.holder).toBe("human");
    if (leave === "sign-out") await hermes.close();
    else await hermes.switchProfile("work");
    expect(server.display.lease.holder).toBe("agent");
    const release = server.requests.find((r) => r.method === "display.lease.release")!;
    expect(release.params).toMatchObject({ viewer_id, profile: "default" });
    if (leave === "another profile") expect(hermes.getSnapshot().screen).toBeUndefined();
  });

  it("lands on the profile picked last when one is picked while the screen is still being handed back", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { work: [], home: [] };
    server.display = running();
    const hermes = await connect(server.openPipe);
    await hermes.screen.takeOver();
    const first = hermes.switchProfile("work");
    const second = hermes.switchProfile("home");
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(hermes.getSnapshot()).toMatchObject({ profile: "home", status: "connected" }));
    expect(server.display.lease.holder).toBe("agent");
  });

  it("stays on the profile shown when the owner picks it again while the screen is being handed back", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { work: [] };
    server.display = running();
    const hermes = await connect(server.openPipe);
    await hermes.screen.takeOver();
    await Promise.all([hermes.switchProfile("work"), hermes.switchProfile("default")]);
    expect(hermes.getSnapshot()).toMatchObject({ profile: "default", status: "connected" });
    expect(server.display.lease.holder).toBe("agent");
  });

  it("waits for a hand-back under way before signing out", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { work: [] };
    server.display = running();
    const hermes = await connect(server.openPipe);
    await hermes.screen.takeOver();
    const switching = hermes.switchProfile("work");
    await hermes.close();
    await switching;
    expect(server.display.lease.holder).toBe("agent");
  });

  it("leaves the screen alone when the owner doesn't hold it", async () => {
    const server = new FakeHermes();
    server.display = running();
    const hermes = await connect(server.openPipe);
    await hermes.screen.observe();
    await hermes.close();
    expect(server.requests.some((r) => r.method === "display.lease.release")).toBe(false);
  });

  it("says when this Hermes has no screen, and refuses to open a stream the connection can't relay", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    const failed = await hermes.screen.status().catch((e: unknown) => e);
    expect(isUnavailable(failed)).toBe(true);
    await expect(hermes.screen.openSocket("t", () => {}, () => {})).rejects.toThrow(/can't show the screen/);
  });
});

describe("computer-use doctor's output", () => {
  const checks = [{ name: "ax", status: "fail", message: "X11 is not reachable; } nor a {", hint: "Set DISPLAY" }];
  const json = JSON.stringify({ checks, overall: "degraded", driver_version: "0.21.0" }, null, 2);

  it("is read even when Hermes prints warning text after the JSON", () => {
    const out = parseDoctor({ blocked: false, code: 1, output: `${json}\nWARNING: stale unit { not json }\n` });
    expect(out.report).toEqual({ overall: "degraded", driver_version: "0.21.0", checks });
  });

  it("keeps a check that has no hint, and drops lines that aren't checks", () => {
    const out = parseDoctor({ blocked: false, code: 0, output: JSON.stringify({ overall: "ok", checks: [{ name: "a", status: "pass", message: "fine" }, { name: 3 }, "x", { name: "b", status: "weird", message: "?" }] }) });
    expect(out.report?.checks).toEqual([{ name: "a", status: "pass", message: "fine" }]);
  });

  it.each([["plain text", "cua-driver: not installed.\n  Run: hermes computer-use install"], ["broken JSON", '{"checks": [ {'], ["JSON that isn't a report", '{"ok": true}']])(
    "leaves no report for %s, and keeps the output to read",
    (_, output) => {
      const out = parseDoctor({ blocked: false, code: 2, output });
      expect(out.report).toBeUndefined();
      expect(out).toMatchObject({ code: 2, output });
    },
  );
});

describe("computer-use doctor over the connection", () => {
  const argvOf = (server: FakeHermes) => server.requests.filter((r) => r.method === "cli.exec").map((r) => r.params.argv);

  it("runs doctor for the profile shown, so a dropped -p would read the default profile's degraded answer, not this one's", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { work: [] };
    server.machine = { programs: new Set(), files: new Set(), pmInstall: { code: 0, output: "" }, browser: "" };
    const hermes = await connect(server.openPipe);
    const first = await hermes.screen.doctor();
    expect(first).toMatchObject({ code: 0, report: { overall: "ok", driver_version: "0.21.0" } });
    await hermes.switchProfile("work");
    server.machine.computerUse = { doctor: { blocked: false, code: 2, output: "cua-driver: not installed.\n  Run: hermes computer-use install" } };
    expect((await hermes.screen.doctor()).code).toBe(2);
    expect(argvOf(server)).toEqual([
      ["-p", "default", "computer-use", "doctor", "--json"],
      ["-p", "work", "computer-use", "doctor", "--json"],
    ]);
    await hermes.close();
  });

  it("says a Hermes with no cli.exec is unavailable", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    expect(isUnavailable(await hermes.screen.doctor().catch((e: unknown) => e))).toBe(true);
    await hermes.close();
  });
});
