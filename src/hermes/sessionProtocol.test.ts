// The canonical session protocol is refused, and the map of what it changes stays whole (ADR 0174): the app turns a
// real canonical gateway's `gateway.ready` away before it sends anything, and every JSON-RPC method the app sends has a
// row in canonicalVerbs.ts saying what that protocol does with it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { APP_METHODS, APP_VERBS, CANONICAL_METHODS, CANONICAL_READY, type AppMethod, type WireMethod } from "./canonicalVerbs";
import { protocolOf } from "./capabilities";
import { FakeHermes } from "./fakeHermes";
import type { QuestionItem } from "./model";
import { withContext } from "./projectContext";
import { LegacyProtocol, SESSION_METHODS, canonicalGate, negotiate, type Port, type SessionMethod } from "./sessionProtocol";
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
    expectTypeOf<Parameters<Port["call"]>[0]>().toEqualTypeOf<WireMethod>();
    expect(CANONICAL_METHODS.filter((m) => (APP_METHODS as readonly string[]).includes(m))).toEqual([]);
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

describe("the canonical protocol's core, behind the gate", () => {
  afterEach(() => void vi.restoreAllMocks());
  const SID = "local-1";
  const snapshot = {
    session_id: SID,
    stored_session_id: SID,
    messages: [],
    running: true,
    subscription_id: "sub-1",
    revision: 3,
    execution_generation: 2,
    replay_epoch: "e1",
    last_sequence: 9,
    pending: [{ status: "started", text: "Clean up the logs" }],
    prompts: [{ kind: "approval", prompt_id: "p-1", execution_generation: 2, command: "rm -rf /tmp/x", description: "delete", choices: ["once", "deny"] }],
    open_requests: [{ id: "srq-1", method: "sudo", params: { session_id: SID, command: "sudo ls" } }],
  };
  const canonical = (answers: Record<string, unknown> = {}) => {
    const recorded = recordingPort(answers);
    canonicalGate.open = true;
    try {
      return { ...recorded, protocol: negotiate(CANONICAL_READY, recorded.port) };
    } finally {
      canonicalGate.open = false;
    }
  };
  const card = (kind: string, id: string, requestId = id) => ({ kind, id, requestId }) as unknown as QuestionItem;
  const event = (type: string, payload: Record<string, unknown>, envelope: Record<string, unknown> = {}) => ({ method: "event", params: { type, session_id: SID, payload, ...envelope } });

  it("is closed unless a test opens it, and no app code opens it", () => {
    expect(canonicalGate.open).toBe(false);
    expect(canonical().protocol.kind).toBe("canonical");
    expect(APP_SOURCE_TEXT.filter((text) => /canonicalGate\.open\s*=/.test(text))).toEqual([]);
  });

  it("words each core operation in the canonical protocol's frames", async () => {
    const { protocol, sent } = canonical({
      "session.create": snapshot,
      "session.resume": snapshot,
      "prompt.submit": { admission_id: "a-1", status: "queued" },
      "session.interrupt": { execution_state: "running" },
      "approval.respond": { status: "resolved", prompt_id: "p-1" },
      "clarify.respond": { status: "resolved", prompt_id: "p-2" },
    });
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000000");
    await protocol.open({ kind: "bot", profile: "p", source: "gui", title: "Bot Chat", seeded: [] });
    const opened = await protocol.open({ kind: "chat", profile: "p", source: "gui", folder: "/srv", model: { provider: "custom", model: "fake", effort: "low", fast: false }, seeded: ["Be brief"] });
    expect(opened).toMatchObject({ runtimeId: SID, storedId: SID, running: true, inflightUser: "Clean up the logs", asking: [{ id: "p-1", method: "approval" }, { id: "srq-1", method: "sudo" }] });
    expect(opened.asking[0].params).toMatchObject({ request_id: "p-1", allow_session: false, allow_permanent: false });
    await protocol.resume(SID, "p");
    expect(await protocol.submit(SID, { profile: "p", text: "hi", attachments: [], hold: true, context: [] }, () => {})).toEqual({ held: true });
    expect(await protocol.submit(SID, { profile: "p", text: "again", attachments: [], hold: false, context: [] }, () => {})).toEqual({ held: true });
    await protocol.submitHidden(SID, "p", "begin");
    expect(await protocol.stop(SID)).toBe(true);
    expect(await protocol.answer(SID, card("approval", "p-1"), { kind: "approval", choice: "once" })).toBe("taken");
    protocol.inbound(event("clarify.request", { kind: "clarify", prompt_id: "p-2", execution_generation: 2, question: "Which?", choices: ["a"] }));
    expect(await protocol.answer(SID, card("clarify", "p-2"), { kind: "lock", qid: "p-2", answer: "a" })).toBe("done");
    expect(await protocol.answer(SID, card("approval", "p-9"), { kind: "approval", choice: "once" })).toBe("stale");
    expect(await protocol.openRequests(SID)).toBeUndefined();
    await protocol.info(SID);
    await protocol.leave(SID);
    expect(await protocol.stop(SID)).toBe(false);
    await expect(protocol.edit(SID, { op: "rename", title: "x" })).rejects.toThrow("isn't supported on Hermes's canonical session protocol yet");
    await expect(protocol.approvalProbe("probe")).rejects.toThrow("isn't supported on Hermes's canonical session protocol yet");
    const uuid = "00000000-0000-4000-8000-000000000000";
    expect(sent).toEqual([
      'session.create {"profile":"p","title":"Bot Chat","hidden":true,"follow_profile_config":true,"source":"gui"}',
      'session.create {"profile":"p","source":"gui","cwd":"/srv","cwd_explicit":true,"model":"fake","provider":"custom"}',
      `session.resume {"session_id":"${SID}","profile":"p"}`,
      `prompt.submit {"session_id":"${SID}","profile":"p","queued":true,"text":${JSON.stringify(withContext("hi", ["Be brief"]))},"submission_id":"${uuid}"}`,
      `prompt.submit {"session_id":"${SID}","profile":"p","text":"again","submission_id":"${uuid}"}`,
      `prompt.submit {"session_id":"${SID}","profile":"p","display_kind":"hidden","text":"begin","submission_id":"${uuid}"}`,
      `session.interrupt {"session_id":"${SID}","execution_generation":2}`,
      `approval.respond {"session_id":"${SID}","execution_generation":2,"prompt_id":"p-1","choice":"once"}`,
      `clarify.respond {"session_id":"${SID}","execution_generation":2,"prompt_id":"p-2","answer":"a"}`,
      `session.info {"session_id":"${SID}"}`,
      `session.detach {"session_id":"${SID}","subscription_id":"sub-1"}`,
    ]);
  });

  it("reads Approvals and Clarify questions from events, closes them when settled, and stops the generation it last heard", async () => {
    const { protocol, sent } = canonical({ "session.create": { ...snapshot, prompts: [], running: false }, "session.interrupt": { execution_state: "idle" } });
    await protocol.open({ kind: "chat", profile: "p", source: "gui", seeded: [] });
    expect(protocol.inbound(event("message.start", {}, { execution_generation: 3, seq: 10, admission_id: "a-1" }))).toEqual([{ kind: "event", type: "message.start", sessionId: SID, payload: {} }]);
    expect(protocol.inbound(event("approval.request", { kind: "approval", prompt_id: "p-3", execution_generation: 3, command: "ls", choices: ["once", "session", "deny"] }))).toEqual([
      {
        kind: "ask",
        req: {
          id: "p-3",
          method: "approval",
          params: { kind: "approval", prompt_id: "p-3", execution_generation: 3, command: "ls", choices: ["once", "session", "deny"], session_id: SID, request_id: "p-3", allow_session: true, allow_permanent: false },
        },
      },
    ]);
    expect(protocol.inbound(event("clarify.request", { kind: "clarify", prompt_id: "p-4", execution_generation: 3, question: "Which?", choices: ["a", "b"], multi_select: false }))).toEqual([
      { kind: "ask", req: { id: "p-4", method: "clarify", params: { session_id: SID, questions: [{ qid: "p-4", question: "Which?", choices: ["a", "b"], multi_select: false }] } } },
    ]);
    expect(protocol.inbound(event("approval.settled", { prompt_id: "p-3", execution_generation: 3 }))).toEqual([{ kind: "event", type: "request.cancel", sessionId: SID, payload: { id: "p-3", reason: "withdrawn" } }]);
    expect(await protocol.answer(SID, card("approval", "p-3"), { kind: "approval", choice: "once" })).toBe("stale");
    expect(await protocol.stop(SID)).toBe(false);
    expect(sent.at(-1)).toBe(`session.interrupt {"session_id":"${SID}","execution_generation":3}`);
    expect(protocol.inbound({ id: "srq-2", method: "secret", params: { session_id: SID } })).toEqual([{ kind: "ask", req: { id: "srq-2", method: "secret", params: { session_id: SID } } }]);
    expect(protocol.inbound(event("message.delta", { text: "x" }, { session_id: "local-other" }))).toEqual([{ kind: "event", type: "message.delta", sessionId: "local-other", payload: { text: "x" } }]);
  });

  it("reads an answer to a turn that is over as stale", async () => {
    const { port, sent } = recordingPort({ "session.create": snapshot });
    const stale = new RpcError(4001, "stale_generation", { reason: "stale_generation" });
    canonicalGate.open = true;
    const protocol = negotiate(CANONICAL_READY, { ...port, call: ((method: string, params: Record<string, unknown>, options?: object) => (method === "approval.respond" ? Promise.reject(stale) : port.call(method as never, params, options))) as Port["call"] });
    canonicalGate.open = false;
    await protocol.open({ kind: "chat", profile: "p", source: "gui", seeded: [] });
    expect(await protocol.answer(SID, card("approval", "p-1"), { kind: "approval", choice: "once" })).toBe("stale");
    expect(sent).toHaveLength(1);
  });
});

