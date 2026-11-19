// The canonical session protocol is refused, and the map of what it changes stays whole (ADR 0174): the app turns a
// real canonical gateway's `gateway.ready` away before it sends anything, and every JSON-RPC method the app sends has a
// row in canonicalVerbs.ts saying what that protocol does with it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { APP_METHODS, APP_VERBS, CANONICAL_READY, type AppMethod } from "./canonicalVerbs";
import { protocolOf } from "./capabilities";
import { FakeHermes } from "./fakeHermes";
import type { QuestionItem } from "./model";
import { LegacyProtocol, SESSION_METHODS, negotiate, type Port, type SessionMethod } from "./sessionProtocol";
import { explainSignIn, signInError } from "./setup";
import type { SignInDetails } from "./tauriPipe";
import { ProtocolMismatchError, RpcError, connect, type Hermes } from "./transport";

const SRC = join(__dirname, "..");
const TEST_ONLY = /\.test\.tsx?$|[\\/]fake[A-Z][A-Za-z]*\.ts$|[\\/]canonicalVerbs\.ts$/;
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.tsx?$/.test(e.name) && !TEST_ONLY.test(path) ? [path] : [];
  });
const APP_SOURCE_TEXT = sources(SRC).map((path) => readFileSync(path, "utf8"));
const mapped: string[] = APP_VERBS.map((v) => v.method);
const sendOf = (h: Hermes) => h["request"];

function recordingPort(answers: Record<string, unknown> = {}) {
  const sent: string[] = [];
  const port: Port = {
    call: (async (method: string, params: Record<string, unknown>, options?: { read?: (result: unknown) => unknown }) => {
      sent.push(`${method} ${JSON.stringify(params)}`);
      return options?.read ? options.read(answers[method]) : answers[method];
    }) as Port["call"],
    reply: async (id, result) => void sent.push(`reply ${JSON.stringify({ id, result })}`),
    inHermesQueue: () => false,
    track: () => {},
  };
  return { port, sent };
}

describe("the canonical session protocol", () => {
  it("is what a real gateway's gateway.ready names, and a standalone dashboard's is legacy", () => {
    expect(protocolOf(CANONICAL_READY)).toBe("canonical");
    const { session_authority: _, ...dashboard } = CANONICAL_READY;
    expect(protocolOf(dashboard)).toBe("legacy");
  });

  it("is refused before the app sends the server anything", async () => {
    const server = new FakeHermes();
    server.readyPayload = CANONICAL_READY;
    await expect(connect(server.openPipe)).rejects.toBeInstanceOf(ProtocolMismatchError);
    expect(server.requests).toEqual([]);
    expect(server.restRequests).toEqual([]);
    expect(server.closed).toBe(true);
  });

  it("is explained on the sign-in screen", async () => {
    const server = new FakeHermes();
    server.readyPayload = CANONICAL_READY;
    const d: SignInDetails = { mode: "url", sshTarget: "", url: "http://hermes:9120", username: "lena", password: "pw" };
    const shown = await connect(server.openPipe).catch((e: unknown) => explainSignIn(signInError(e), d));
    expect(shown).toMatchObject({
      stage: "chat",
      problem: "Highwing can't talk to this server yet.",
      fixes: ["This server uses Hermes's newer session protocol. Highwing speaks only the legacy one."],
    });
  });
});

describe("the map of what the canonical protocol does with the app's JSON-RPC methods", () => {
  it("has a row for every method the app sends", () => {
    expectTypeOf<Parameters<Port["call"]>[0]>().toEqualTypeOf<AppMethod>();
    expect(APP_METHODS.filter((m) => !mapped.includes(m)), "add a row to APP_VERBS in canonicalVerbs.ts (ADR 0174)").toEqual([]);
  });

  it("has no row for a method the app stopped sending, and one row a shape", () => {
    const named = (method: string) => APP_SOURCE_TEXT.some((text) => text.includes(`"${method}"`));
    expect(APP_METHODS.filter((m) => !named(m))).toEqual([]);
    const rows = APP_VERBS.map((v) => `${v.method} ${v.shape ?? ""}`);
    expect(rows.filter((r, i) => rows.indexOf(r) !== i)).toEqual([]);
  });

  it("says what an adapter sends for each method the canonical protocol refuses or moved", () => {
    const changed = APP_VERBS.filter((v) => v.route === "refused" || (v.route === "authority" && v.answer !== "ok"));
    expect(changed.filter((v) => !v.canonical).map((v) => v.method)).toEqual([]);
    expect([...new Set(changed.map((v) => v.method))].sort()).toEqual([
      "approval.respond",
      "command.dispatch",
      "config.set",
      "prompt.submit",
      "session.branch",
      "session.close",
      "session.compress",
      "session.create",
      "session.cwd.set",
      "session.interrupt",
      "session.resume",
      "session.status",
      "session.title",
      "session.undo",
      "shell.exec",
    ]);
  });
});

describe("the seam a session's frames leave by", () => {
  const NO_SESSIONS = ["shell.exec"];

  it("picks the legacy protocol for a dashboard, and refuses a canonical gateway", () => {
    const { port, sent } = recordingPort();
    const { session_authority: _, ...dashboard } = CANONICAL_READY;
    expect(negotiate(dashboard, port).kind).toBe("legacy");
    expect(() => negotiate(CANONICAL_READY, port)).toThrow(ProtocolMismatchError);
    expect(() => negotiate(CANONICAL_READY, port)).toThrow("This Hermes server speaks the canonical session protocol, which Highwing doesn't support yet.");
    expect(sent).toEqual([]);
  });

  it("fences every method the map says the canonical protocol changes", () => {
    const noted = [...new Set(APP_VERBS.filter((v) => v.canonical).map((v) => v.method))];
    expect([...SESSION_METHODS, ...NO_SESSIONS].sort(), "SESSION_METHODS in sessionProtocol.ts names the methods with a `canonical` note").toEqual(noted.sort());
    expectTypeOf<Parameters<ReturnType<typeof sendOf>>[0]>().toEqualTypeOf<Exclude<AppMethod, SessionMethod>>();
  });

  it("lets only the protocol's port past the fence", () => {
    const transport = readFileSync(join(__dirname, "transport.ts"), "utf8");
    expect(transport.match(/\bthis\.egress\(/g)).toHaveLength(2);
    expect(transport).toContain("call: (method, params, { file, observe, read } = {}) => this.egress(method, params, file, observe, read),");
  });

  it("words each operation on a legacy connection as the app always has", async () => {
    const { port, sent } = recordingPort({
      "session.create": { session_id: "rt", stored_session_id: "s" },
      "session.resume": { session_id: "rt", running: true, inflight: { assistant: "So far" }, open_requests: [{ id: "srq-1", method: "approval", params: {} }] },
      "prompt.submit": { status: "queued", user_row_id: 7 },
      "session.interrupt": { status: "interrupted" },
      "approval.respond": { resolved: 1 },
      "clarify.lock": { status: "ok", remaining: [] },
      "request.answer": { status: "expired" },
      "session.events.since": { open_requests: [] },
      "config.set": { confirm_required: true, confirm_message: "It costs more" },
    });
    const legacy = new LegacyProtocol(port);
    const card = (kind: string, id: string) => ({ kind, id, requestId: "r1" }) as unknown as QuestionItem;
    expect(await legacy.open({ kind: "chat", profile: "p", source: "gui", folder: "/srv", model: { provider: "custom", model: "fake", effort: "low", fast: false }, seeded: ["Be brief"] })).toMatchObject({
      runtimeId: "rt",
      storedId: "s",
    });
    await legacy.open({ kind: "bot", profile: "p", source: "gui", title: "Bot Chat", seeded: [] });
    await legacy.open({ kind: "bot", profile: "p", source: "gui", title: "Bot Chat", seeded: ["Brief"] });
    expect(await legacy.resume("s", "p")).toMatchObject({ runtimeId: "rt", running: true, inflight: "So far", asking: [{ id: "srq-1" }] });
    await legacy.leave("rt");
    expect(await legacy.submit("rt", { profile: "p", text: "hi", attachments: [], hold: true, context: [] }, () => {})).toEqual({ held: true, userRowId: 7 });
    expect(await legacy.submitHidden("rt", "p", "begin")).toEqual({ held: true, userRowId: 7 });
    expect(await legacy.stop("rt")).toBe(true);
    await legacy.command("rt", "steer", "a\nb");
    await legacy.configure("rt", "p", "reasoning", "low", { scope: "session" });
    expect(await legacy.answer("rt", card("approval", "srq-1"), { kind: "approval", choice: "once" })).toBe("taken");
    expect(await legacy.answer("rt", card("clarify", "srq-2"), { kind: "lock", qid: "q1", answer: "x" })).toBe("done");
    expect(await legacy.answer("rt", card("sudo", "srq-3"), { kind: "settle", result: { password: "pw" } })).toBe("stale");
    expect(await legacy.openRequests("rt")).toEqual([]);
    await legacy.edit("rt", { op: "rename", title: "Bot Chat" });
    await legacy.edit("rt", { op: "folder", profile: "p", cwd: "/srv" });
    await legacy.edit("rt", { op: "branch", count: 2, key: "k" });
    await legacy.edit("rt", { op: "undo" });
    await legacy.edit("rt", { op: "compact" });
    expect(await legacy.edit("rt", { op: "model", profile: "p", pick: { provider: "custom", model: "fake" }, confirmed: true })).toEqual({ confirmRequired: true, confirmMessage: "It costs more" });
    await legacy.info("rt");
    await legacy.approvalProbe("probe");
    expect(sent).toEqual([
      'session.create {"profile":"p","source":"gui","cwd":"/srv","cwd_explicit":true,"messages":[{"role":"user","content":"Be brief","display_kind":"hidden"}],"model":"fake","provider":"custom","reasoning_effort":"low","fast":false}',
      'session.create {"profile":"p","title":"Bot Chat","hidden":true,"follow_profile_config":true,"source":"gui"}',
      'session.create {"profile":"p","title":"Bot Chat","hidden":true,"follow_profile_config":true,"source":"gui","messages":[{"role":"user","content":"Brief","display_kind":"hidden"}]}',
      'session.resume {"session_id":"s","profile":"p","inline_images":false}',
      'session.close {"session_id":"rt"}',
      'prompt.submit {"session_id":"rt","profile":"p","text":"hi","queued":true}',
      'prompt.submit {"session_id":"rt","profile":"p","text":"begin","display_kind":"hidden"}',
      'session.interrupt {"session_id":"rt"}',
      'command.dispatch {"name":"steer","arg":"a\\nb","session_id":"rt"}',
      'config.set {"session_id":"rt","profile":"p","key":"reasoning","value":"low","scope":"session"}',
      'approval.respond {"session_id":"rt","choice":"once","request_id":"r1"}',
      'clarify.lock {"request_id":"srq-2","question_id":"q1","answer":"x"}',
      'request.answer {"id":"srq-3","result":{"password":"pw"}}',
      'session.events.since {"session_id":"rt","last_seen":9007199254740991}',
      'session.title {"session_id":"rt","title":"Bot Chat"}',
      'session.cwd.set {"session_id":"rt","profile":"p","cwd":"/srv"}',
      'session.branch {"session_id":"rt","count":2,"idempotency_key":"k"}',
      'session.undo {"session_id":"rt"}',
      'session.compress {"session_id":"rt"}',
      'config.set {"session_id":"rt","profile":"p","key":"model","value":"fake --provider custom --session","confirm_expensive_model":true}',
      'session.status {"session_id":"rt"}',
      'approval.respond {"session_id":"probe","request_id":"probe","choice":"deny"}',
    ]);
  });

  it("answers by a response frame on a Hermes without the answering methods", async () => {
    const { port, sent } = recordingPort();
    const legacy = new LegacyProtocol({ ...port, call: (method: string) => Promise.reject(new RpcError(-32601, `unknown method: ${method}`)) });
    const card = (kind: string, id: string) => ({ kind, id, requestId: "r1" }) as unknown as QuestionItem;
    expect(await legacy.answer("rt", card("approval", "srq-1"), { kind: "approval", choice: "deny" })).toBe("taken");
    expect(await legacy.answer("rt", card("secret", "srq-2"), { kind: "settle", result: { value: "v" } })).toBe("taken");
    expect(sent).toEqual(['reply {"id":"srq-1","result":{"choice":"deny","all":false}}', 'reply {"id":"srq-2","result":{"value":"v"}}']);
  });

  it("reads a frame from Hermes as a question it asks, an event, or nothing", () => {
    const legacy = new LegacyProtocol(recordingPort().port);
    expect(legacy.inbound({ id: "srq-1", method: "approval", params: { session_id: "rt" } })).toEqual([{ kind: "ask", req: { id: "srq-1", method: "approval", params: { session_id: "rt" } } }]);
    expect(legacy.inbound({ method: "event", params: { type: "message.delta", session_id: "rt", payload: { text: "Hi" }, seq: 4 } })).toEqual([
      { kind: "event", type: "message.delta", sessionId: "rt", payload: { text: "Hi" } },
    ]);
    expect(legacy.inbound({ method: "event", params: { type: "gateway.ready", payload: "x" } })).toEqual([{ kind: "event", type: "gateway.ready", sessionId: undefined, payload: {} }]);
    expect(legacy.inbound({ method: "event", params: {} })).toEqual([]);
    expect(legacy.inbound({ id: 7, method: "approval", params: {} })).toEqual([]);
    expect(legacy.inbound({ id: "late", params: {}, result: {} })).toEqual([]);
  });

  it("hands a read answer to its caller in the turn the answer arrives, ahead of the answer after it", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    const asked: number[] = [];
    server.handlers["gateway.ping"] = (r) => void asked.push(r.id);
    const order: string[] = [];
    const read = hermes["port"].call("gateway.ping", {}, { read: () => "read" }).then((answer) => order.push(answer));
    const plain = hermes["request"]("gateway.ping", {}).then(() => order.push("plain"));
    server.respond(asked[0], {});
    server.respond(asked[1], {});
    await Promise.all([read, plain]);
    expect(order).toEqual(["read", "plain"]);
    await hermes.close();
  });

  it("keeps what Hermes says beside an error's code and message", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    server.handlers["gateway.ping"] = (r) => server.fail(r.id, 4001, "revision_conflict", { reason: "revision_conflict", revision: 4 });
    const failure = await hermes["request"]("gateway.ping", {}).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RpcError);
    expect(failure).toMatchObject({ code: 4001, message: "revision_conflict", data: { reason: "revision_conflict", revision: 4 } });
    await hermes.close();
  });
});
