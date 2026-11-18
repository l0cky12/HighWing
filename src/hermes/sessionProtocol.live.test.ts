// The canonical session protocol against a REAL canonical gateway (ADR 0174): skipped unless HERMES_LIVE_CANONICAL is
// set.
//
// It starts chats and a project, so run it against a throwaway gateway only. `tools/canonical-gateway.py` starts one:
//
//   HERMES_LIVE_CANONICAL=http://127.0.0.2:47552/ HERMES_LIVE_USER=owner HERMES_LIVE_PASSWORD=… HERMES_LIVE_STUB=1 \
//   npx vitest run src/hermes/sessionProtocol.live.test.ts
import { describe, expect, it } from "vitest";
import { CANONICAL_FLOWS, flowSocket, type FlowGateway, type Wire } from "./canonicalFlows";
import type { OpenPipe, Pipe } from "./pipe";
import { explainSignIn, signInError } from "./setup";
import { ProtocolMismatchError, connect, toSource } from "./transport";

declare const process: { env: Record<string, string | undefined> };
const BASE = process.env.HERMES_LIVE_CANONICAL;
const STUB = !!process.env.HERMES_LIVE_STUB;
const PROFILE = "default";
const MODELLESS = new Set([
  "names the canonical protocol in gateway.ready",
  "answers each JSON-RPC method the app sends as canonicalVerbs.ts records",
  "renames with session.mutate fenced on the revision, and answers a retried request as the first",
  "refuses a session.mutate whose payload doesn't fit its operation, and leaves the revision where it was",
  "keeps one revision for a session whether it is edited with session.mutate or PATCH /api/sessions/{id}",
]);

async function signedIn() {
  let cookie = "";
  const rest = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, BASE), { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) cookie = [...cookie.split("; ").filter((p) => p && !p.startsWith(c.split("=")[0] + "=")), c.split(";")[0]].join("; ");
    return res;
  };
  const login = await rest("POST", "auth/password-login", { provider: "basic", username: process.env.HERMES_LIVE_USER, password: process.env.HERMES_LIVE_PASSWORD });
  if (!login.ok) throw new Error(`sign-in failed: ${login.status}`);

  /** One `/api/ws` connection, opened with a fresh ticket as the Rust relay opens it. */
  const wire = async (onText: (text: string) => void): Promise<Wire> => {
    const { ticket } = (await (await rest("POST", "api/auth/ws-ticket")).json()) as { ticket: string };
    const url = new URL(`api/ws?ticket=${encodeURIComponent(ticket)}&profile=${PROFILE}`, BASE);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    await new Promise((open, failed) => {
      ws.onopen = open;
      ws.onerror = () => failed(new Error("the WebSocket failed"));
    });
    ws.onmessage = (m) => onText(String(m.data));
    return { send: (text) => ws.send(text), close: () => ws.close() };
  };
  const losing = new Set<string>();
  const gateway: FlowGateway = {
    socket: () => flowSocket(wire, (method) => losing.delete(method)),
    loseNextAnswer: (method) => losing.add(method),
    createProfile: async (name) => void (await rest("POST", "api/profiles", { name, clone_from: "default" })),
    rest: async (method, path, body) => {
      const res = await rest(method, path, body);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
  };
  return { rest, wire, gateway };
}

// One sign-in for the whole file: Hermes allows an address ten a minute.
let shared: ReturnType<typeof signedIn> | undefined;
const signIn = () => (shared ??= signedIn());

describe.skipIf(!BASE)("a real canonical gateway", () => {
  it("is turned away by the app, which sends it nothing", async () => {
    const live = await signIn();
    const sent: string[] = [];
    let socket: Wire | undefined;
    const openPipe: OpenPipe = async (onEvent) => {
      socket = await live.wire((text) => onEvent({ kind: "frame", text }));
      const pipe: Partial<Pipe> = {
        route: { kind: "url", url: BASE!, addresses: [] },
        send: async (frame) => (sent.push(frame), socket!.send(frame)),
        close: async () => socket!.close(),
      };
      return pipe as Pipe;
    };
    const failed = await connect(openPipe).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failed).toBeInstanceOf(ProtocolMismatchError);
    expect(sent).toEqual([]);
    expect(explainSignIn(signInError(failed), { mode: "url", sshTarget: "", url: BASE!, username: "owner", password: "" })).toMatchObject({
      stage: "chat",
      problem: "Highwing can't talk to this server yet.",
    });
    socket?.close();
  }, 60_000);

  it("refuses a session edit over REST that names no revision", async () => {
    const live = await signIn();
    const s = await live.gateway.socket();
    const sid = (await s.rpc("session.create", { source: "gui" })).result!.session_id as string;
    const patched = await live.rest("PATCH", `api/sessions/${sid}?profile=${PROFILE}`, { title: "Renamed over REST" });
    expect(patched.status).toBe(409);
    expect(((await patched.json()) as { detail: string }).detail).toMatch(/^client_upgrade_required/);
    s.close();
  }, 60_000);

  it.skipIf(!STUB)("files a chat as Hermes Desktop's once a turn has run in it", async () => {
    const live = await signIn();
    const s = await live.gateway.socket();
    const sid = (await s.rpc("session.create", { source: "gui" })).result!.session_id as string;
    const row = async () => {
      const { sessions } = (await (await live.rest("GET", `api/sessions?profile=${PROFILE}&limit=50&order=recent`)).json()) as { sessions: { id: string; source: string; created_source: string }[] };
      return sessions.find((r) => r.id === sid)!;
    };
    expect(await row()).toMatchObject({ source: "gui", created_source: "desktop" });
    await s.rpc("prompt.submit", { session_id: sid, text: "hello", submission_id: crypto.randomUUID() });
    await s.event("message.complete", sid);
    // Hermes files the chat as one of its own local chats, started on the desktop: the app would show it as Hermes
    // Desktop's, not as its own.
    const after = await row();
    expect(after).toMatchObject({ source: "local", created_source: "desktop" });
    expect(toSource(after.source, after.created_source)).toBe("desktop");
    s.close();
  }, 120_000);

  for (const flow of CANONICAL_FLOWS) it.skipIf(!STUB && !MODELLESS.has(flow.name))(flow.name, async () => flow.run((await signIn()).gateway), 300_000);
});
