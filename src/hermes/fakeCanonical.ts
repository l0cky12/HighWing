// Shapes and answers are Hermes v0.23.2's (`ae2a81cc`), read from its source and recorded from a real gateway by the
// flows in `canonicalFlows.ts`.
import { RestError, type PipeEvent } from "./pipe";
import { row, type FakeHermes, type SessionRow } from "./fakeHermes";

type Json = Record<string, unknown>;
type Request = { jsonrpc: "2.0"; id: number; method: string; params: Json };
type Refusal = { code: number; message: string; data?: Json };

type Admission = {
  id: string;
  requestId: string;
  payload: string;
  sequence: number;
  status: "queued" | "started" | "terminal";
  outcome: string | null;
  generation: number | null;
  text: string;
};

/** `wake` hands the waiting tool its answer, or `undefined` when Stop withdrew the prompt. */
type Prompt = { kind: "approval" | "clarify"; payload: Json; answer?: string; wake?: (answer: string | undefined) => void };

type Turn = { admission?: Admission; interrupted: boolean };

/**
 * A live session's runtime state. What both `session.mutate` and the dashboard's REST routes read and write (revision,
 * generation, title, flags, cwd) is its stored `row`, as Hermes keeps it in the `sessions` table.
 */
type Session = {
  id: string;
  profile: string;
  source: string;
  row: SessionRow;
  startedAt: number;
  replayEpoch: string;
  seq: number;
  admissions: Admission[];
  turn?: Turn;
  /** A model pick made while a turn ran, committed at the next turn boundary (`gateway/session_deferred_pick.py`). */
  deferredPick?: Json;
  prompts: Map<string, Prompt>;
  replayLog: Json[];
  messages: Json[];
};

type Connection = { onEvent: (e: PipeEvent) => void; profile: string; subscriptionIdBySession: Map<string, string>; open: boolean };

/**
 * The closed key set of each authority method the app reaches (`tui_gateway/contracts/canonical.py`,
 * `canonical_sessions.py`). An unknown key is `4001 invalid_params` with `data.fields`. `shared`: a legacy method too,
 * whose missing keys the handler refuses itself, so `fields` names only unknown ones and any of its `strings` that
 * isn't one (`canonical_param_problems`).
 */
const CONTRACTS: Record<string, { keys: string[]; required?: string[]; shared?: true; strings?: string[] }> = {
  "session.create": {
    shared: true,
    keys: [
      "profile", "request_id", "source", "cwd", "row_cwd", "model", "provider", "base_url", "api_key", "toolsets", "reasoning", "max_turns", "ignore_rules", "yolo",
      "safe_mode", "ignore_user_config", "skills", "checkpoints", "accept_hooks", "pass_session_id", "editor", "title", "hidden", "follow_profile_config", "service_tier",
      "cwd_explicit", "run_budget", "verbose", "client_env", "client",
    ],
  },
  "session.resume": {
    shared: true,
    keys: ["profile", "session_id", "title", "latest", "workspace", "source", "editor", "api_key", "defer_history", "omit_messages", "cols", "display_projection"],
  },
  "session.list": { shared: true, keys: ["profile", "scope", "limit", "title", "include_hidden", "workspace", "picker", "query", "cursor"] },
  "session.interrupt": { shared: true, keys: ["profile", "session_id", "execution_generation"] },
  "session.events.since": { shared: true, keys: ["profile", "session_id", "last_sequence", "last_seen", "replay_epoch"] },
  "prompt.submit": {
    shared: true,
    keys: [
      "profile", "session_id", "text", "submission_id", "input_id", "queued", "attachments", "finite", "unattended", "surface", "voice_context", "interrupted", "voice_turn",
      "display_kind", "title_preview", "turn_author", "api_text", "model_override", "clarify_batch",
    ],
  },
  "approval.respond": { shared: true, keys: ["profile", "session_id", "execution_generation", "prompt_id", "choice"], strings: ["prompt_id", "choice"] },
  "config.set": { shared: true, keys: ["profile", "session_id", "key", "value", "confirm_expensive_model", "scope"] },
  "image.attach_bytes": { shared: true, keys: ["session_id", "profile", "content_base64", "data", "filename", "ext"] },
  "clarify.lock": { shared: true, keys: ["request_id", "question_id", "answer", "profile"] },
  "prompt.receipt": { keys: ["session_id", "admission_id", "include_result"], required: ["session_id", "admission_id"] },
  "session.mutate": {
    keys: ["session_id", "request_id", "expected_revision", "operation", "payload", "expected_generation"],
    required: ["session_id", "request_id", "expected_revision", "operation", "payload"],
  },
  "session.info": { keys: ["session_id"], required: ["session_id"] },
  "session.detach": { keys: ["session_id", "subscription_id", "end_reason"], required: ["session_id", "subscription_id"] },
  "clarify.respond": { keys: ["session_id", "execution_generation", "prompt_id", "answer"], required: ["session_id", "execution_generation", "prompt_id", "answer"] },
};

/** The verbs whose `profile` names the authority's own home and is dropped before the key check (`_PROFILE_IMPLICIT`). */
const PROFILE_IMPLICIT = new Set([
  "session.create", "session.list", "session.info", "session.resume", "session.detach", "prompt.submit", "prompt.receipt", "session.interrupt", "session.events.since",
  "session.mutate", "approval.respond", "clarify.respond",
]);

/**
 * Methods the authority serves the way this fake's legacy handlers already answer them (`AuthorityConnection.handlers`
 * at v0.23.2), with the session's id as its own runtime id.
 */
const AUTHORITY_AS_LEGACY = new Set([
  "session.active_list", "session.context_breakdown", "session.control.read", "session.control", "approval.received", "clarify.lock", "file.attach", "model.options",
  "config.get", "config.set", "profiles.list", "llm.oneshot", "commands.catalog", "command.dispatch", "slash.exec", "prompt.btw", "rollback.list", "rollback.diff",
  "rollback.restore", "tools.show", "subagent.list", "subagent.tail", "subagent.steer", "subagent.interrupt", "shell.exec",
]);

/** What `tui_gateway/ws_legacy_fallback.py` keeps from the legacy handlers: no session verb but these. */
const SESSION_NAMESPACES = ["session.", "prompt.", "message."];
const SESSION_FALLBACK_ALLOWED = new Set(["session.most_recent", "session.active_list", "session.events.stats", "session.foreign.list", "session.foreign.preview", "session.foreign.import"]);
const NO_HERMES_HAS = new Set(["projects.membership.list", "projects.membership.apply"]);

const MUTATIONS = new Set(["rename", "archive", "sidebar", "branch", "delete", "rewind", "reset", "model", "reasoning", "workspace", "editor_mcp", "edit_policy", "compress", "import"]);
// hermes_state_runtime.py `apply_mutation` and gateway/session_mutations.py `_POLICY` at v0.23.2.
const GENERATION_REQUIRED = new Set(["delete", "rewind", "reset", "branch", "model", "compress", "reasoning", "workspace", "editor_mcp", "edit_policy"]);
// hermes_state_mutation_prepared.py `POLICY_HANDLERS`: each commits through `_commit_policy`, which opens the next generation.
const POLICY = new Set(["model", "reasoning", "workspace", "editor_mcp", "edit_policy"]);

const METADATA: Json = { title: "string", archived: "boolean", hidden: "boolean", pinned: "boolean", unread: "boolean" };
const REASONING = new Set(["none", "false", "disabled", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const exactly = (p: Json, ...keys: string[]) => Object.keys(p).length === keys.length && keys.every((k) => k in p);
const metadata = (p: Json) => Object.entries(p).every(([k, v]) => k in METADATA && typeof v === METADATA[k]);
const filled = (v: unknown) => typeof v === "string" && !!v.trim();
/** `validate_action` (`hermes_state_mutations.py`) for each operation this fake commits; an operation not here isn't modelled. */
const PAYLOAD_FITS: Record<string, (p: Json) => boolean> = {
  rename: (p) => exactly(p, "title") && metadata(p),
  archive: (p) => exactly(p, "archived") && metadata(p),
  sidebar: (p) => Object.keys(p).length > 0 && metadata(p),
  workspace: (p) => exactly(p, "cwd") && filled(p.cwd),
  model: (p) =>
    "model" in p &&
    Object.entries(p).every(([k, v]) => ["model", "provider", "confirm", "reasoning"].includes(k) && filled(v)) &&
    (!("reasoning" in p) || REASONING.has(String(p.reasoning).trim().toLowerCase())),
};
const fits = (op: string, payload: unknown) =>
  !!payload && typeof payload === "object" && !Array.isArray(payload) && MUTATIONS.has(op) && (Object.hasOwn(PAYLOAD_FITS, op) ? PAYLOAD_FITS[op](payload as Json) : true);
const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
/** `_MUTATION_REFUSAL_STATUS` (`hermes_cli/web_server_sessions.py`): any other refusal is a 409. */
const REST_STATUS: Record<string, number> = { permission_denied: 403, profile_mismatch: 403, not_found: 404, invalid_params: 400, runtime_draining: 503, storage_unavailable: 503 };
const revisionOf = (r: SessionRow) => r.runtime_revision ?? 0;
const generationOf = (r: SessionRow) => r.runtime_generation ?? 0;

const unknownMethod = (method: string): Refusal => ({ code: -32601, message: `unknown method: ${method} — not available on this Hermes backend`, data: { reason: "unknown_method" } });
const refusal = (reason: string, more: Json = {}): Refusal => ({ code: 4001, message: reason, data: { reason, ...more } });
const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
const sleep = (ms: number) => new Promise((wake) => setTimeout(wake, ms));
const sortedJson = (v: unknown): string =>
  JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Json).sort(([a], [b]) => a.localeCompare(b))) : x));

export type CanonicalOptions = {
  stubModel?: boolean;
  wordMs?: number;
};

export class FakeAuthority {
  readonly sessions = new Map<string, Session>();
  private readonly connections = new Set<Connection>();
  private readonly owed = new Map<number, { connection: Connection; id: number; lost: boolean }>();
  private readonly losing = new Set<string>();
  /** Each mutation's exact-retry receipt, by session and request id, whichever path made it (`mutation_receipt_key`). */
  private readonly receipts = new Map<string, { request: string; result: Json }>();
  private nextOwed = 1_000_000_000;
  private minted = 0;
  private admitted = 0;

  constructor(
    private readonly server: FakeHermes,
    private readonly options: CanonicalOptions = {},
  ) {}

  loseNextAnswer(method: string) {
    this.losing.add(method);
  }

  connect(onEvent: (e: PipeEvent) => void, profile: string) {
    const connection: Connection = { onEvent, profile: profile || "default", subscriptionIdBySession: new Map(), open: true };
    this.connections.add(connection);
    onEvent({ kind: "frame", text: JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: this.server.readyPayload } }) });
    return {
      request: (req: Request) => this.request(connection, req),
      close: () => this.close(connection),
    };
  }

  readonly route = (e: PipeEvent) => {
    if (e.kind === "closed") {
      for (const c of [...this.connections]) {
        this.close(c);
        c.onEvent(e);
      }
      return;
    }
    let f: Json;
    try {
      f = JSON.parse(e.text);
    } catch {
      for (const c of this.connections) c.onEvent(e);
      return;
    }
    const owed = typeof f.id === "number" ? this.owed.get(f.id) : undefined;
    if (owed) {
      this.owed.delete(f.id as number);
      if (!owed.lost) this.deliver(owed.connection, { ...f, id: owed.id });
      return;
    }
    const sid = String((f.params as Json | undefined)?.session_id ?? "");
    for (const c of this.connections) if (!sid || c.subscriptionIdBySession.has(sid)) c.onEvent(e);
  };

  private close(connection: Connection) {
    connection.open = false;
    connection.subscriptionIdBySession.clear();
    this.connections.delete(connection);
  }

  private deliver(connection: Connection, frame: Json, method?: string) {
    if (method && this.losing.delete(method)) return;
    if (connection.open) connection.onEvent({ kind: "frame", text: JSON.stringify(frame) });
  }

  /** `tui_gateway/ws.py` `_dispatch_request`: the authority first; a method it lacks goes to the legacy handlers, except a session verb. */
  private request(connection: Connection, req: Request) {
    const answer = (result: unknown) => this.deliver(connection, { jsonrpc: "2.0", id: req.id, result }, req.method);
    const refuse = (r: Refusal) => this.deliver(connection, { jsonrpc: "2.0", id: req.id, error: r }, req.method);
    let params = req.params ?? {};
    // `AuthorityConnection._sibling_for`: a named profile is this home, a served sibling's authority, or refused.
    const named = params.profile;
    if (typeof named === "string" && named && !this.server.store(named)) return refuse(refusal("profile_mismatch"));
    const profile = typeof named === "string" && named ? named : connection.profile;
    if (PROFILE_IMPLICIT.has(req.method)) {
      const { profile: _, ...rest } = params;
      params = rest;
    }
    const contract = CONTRACTS[req.method];
    if (contract) {
      const missing = contract.shared ? [] : (contract.required ?? []).filter((k) => !(k in params));
      const unknown = Object.keys(params).filter((k) => !contract.keys.includes(k));
      const mistyped = (contract.strings ?? []).filter((k) => k in params && typeof params[k] !== "string");
      if (missing.length || unknown.length || mistyped.length) return refuse(refusal("invalid_params", { fields: [...missing, ...unknown, ...mistyped] }));
    }
    const own = this.handlers[req.method];
    if (own) {
      const out = own(connection, params, req, profile);
      if (out === undefined) return;
      return "refusal" in out ? refuse(out.refusal) : answer(out.result);
    }
    if (AUTHORITY_AS_LEGACY.has(req.method)) return this.asLegacy(connection, req);
    if (NO_HERMES_HAS.has(req.method)) return refuse(unknownMethod(req.method));
    if (SESSION_NAMESPACES.some((n) => req.method.startsWith(n)) && !SESSION_FALLBACK_ALLOWED.has(req.method)) return refuse(unknownMethod(req.method));
    // The legacy sidecar knows none of the authority's sessions.
    if (typeof params.session_id === "string" && params.session_id) return refuse({ code: 4001, message: "session not found" });
    if (!this.server.handlers[req.method]) return refuse(unknownMethod(req.method));
    this.asLegacy(connection, req);
  }

  /** Each profile's authority knows only its own sessions, and none whose row was deleted. */
  private session(id: unknown, profile: string): Session | undefined {
    const s = typeof id === "string" ? this.sessions.get(id) : undefined;
    return s?.profile === profile && this.server.store(profile)?.includes(s.row) ? s : undefined;
  }

  private profileId(profile: string) {
    return profile === "default" ? "/home/hermes/.hermes" : `/home/hermes/.hermes/profiles/${profile}`;
  }

  private receipt(s: Session, a: Admission) {
    return {
      admission_id: a.id,
      ref: { profile_id: this.profileId(s.profile), session_id: s.id },
      sequence: a.sequence,
      status: a.status,
      outcome: a.outcome,
      authority_epoch: 1,
      execution_generation: a.generation,
    };
  }

  private pending(s: Session) {
    return s.admissions
      .filter((a) => a.status !== "terminal")
      .map((a) => ({ ...this.receipt(s, a), input_id: a.requestId, text: a.text, controls: a.status === "queued" ? ["steer", "replace"] : [], steering: false }));
  }

  private info(s: Session) {
    const model = this.server.sessionModel.get(s.id) ?? this.server.defaultModel(s.profile);
    return {
      provider: model.provider,
      desktop_protocol: "hermes-gateway-v1",
      source: s.source,
      model: model.model,
      lazy: true,
      profile_id: this.profileId(s.profile),
      profile_name: s.profile,
      cwd: s.row.cwd,
      reasoning_effort: model.reasoning_effort,
      service_tier: "",
      fast: model.fast,
      launch_request: { source: s.source },
      title: s.row.title,
      archived: s.row.archived,
      started_at: s.startedAt,
      last_active_at: s.startedAt,
      yolo: false,
    };
  }

  private snapshot(s: Session, subscription: string) {
    return {
      session_id: s.id,
      stored_session_id: s.id,
      messages: s.messages,
      message_count: s.messages.length,
      todo_state: null,
      running: !!s.turn,
      authority_epoch: 1,
      replay_epoch: s.replayEpoch,
      last_sequence: s.seq,
      subscription_id: subscription,
      revision: revisionOf(s.row),
      execution_generation: generationOf(s.row),
      pending: this.pending(s),
      prompts: [...s.prompts.values()].filter((p) => p.answer === undefined).map((p) => p.payload),
      info: this.info(s),
      pending_connection: null,
      open_requests: this.server.openRequestsOf(s.id),
    };
  }

  private subscribe(connection: Connection, s: Session) {
    let subscription = connection.subscriptionIdBySession.get(s.id);
    if (!subscription) connection.subscriptionIdBySession.set(s.id, (subscription = hex(++this.minted, 32)));
    return subscription;
  }

  private emit(s: Session, type: string, payload: Json, turn = s.turn) {
    const stamp = turn ? { authority_epoch: 1, execution_generation: generationOf(s.row), admission_id: turn.admission?.id ?? null } : {};
    const params = { ...stamp, type, session_id: s.id, payload, replay_epoch: s.replayEpoch, seq: ++s.seq };
    s.replayLog.push(params);
    for (const c of this.connections) if (c.subscriptionIdBySession.has(s.id)) this.deliver(c, { jsonrpc: "2.0", method: "event", params });
  }

  private publish(s: Session, turn = s.turn) {
    this.emit(
      s,
      "session.info",
      { stored_session_id: s.id, pending: this.pending(s), authority_epoch: 1, desktop_protocol: "hermes-gateway-v1", running: !!s.turn, execution_generation: generationOf(s.row), revision: revisionOf(s.row) },
      turn,
    );
  }

  event(sessionId: string, type: string, payload: Json) {
    const s = this.sessions.get(sessionId);
    if (!s) {
      const frame = { jsonrpc: "2.0", method: "event", params: { type, session_id: sessionId, payload } };
      for (const c of this.connections) this.deliver(c, frame);
      return;
    }
    if (type === "message.start" && !s.turn) {
      const admission = s.admissions.find((a) => a.status === "queued");
      s.turn = { admission, interrupted: false };
      s.row.runtime_generation = generationOf(s.row) + 1;
      if (admission) {
        admission.status = "started";
        admission.generation = s.row.runtime_generation;
        s.messages.push({ role: "user", content: admission.text, timestamp: Date.now() / 1000, message_id: admission.id });
      }
      // The stored row is filed under the source the chat was made with until its first turn reopens it as a local chat.
      s.row.source = "local";
      this.emit(s, type, payload);
      return this.publish(s);
    }
    const turn = s.turn;
    if (type !== "message.complete" || !turn) return this.emit(s, type, payload);
    const outcome = typeof payload.outcome === "string" ? payload.outcome : payload.status === "interrupted" ? "cancelled" : "completed";
    // `_publish_completion` settles every prompt still waiting before the completion goes out.
    for (const [id, p] of s.prompts) if (p.answer === undefined) this.emit(s, `${p.kind}.settled`, { prompt_id: id, execution_generation: p.payload.execution_generation });
    s.prompts.clear();
    this.emit(s, type, { ...payload, admission_id: turn.admission?.id ?? null, outcome, status: payload.status ?? "complete" });
    if (turn.admission) Object.assign(turn.admission, { status: "terminal", outcome });
    if (typeof payload.text === "string") s.messages.push({ role: "assistant", content: payload.text, timestamp: Date.now() / 1000 });
    s.turn = undefined;
    s.row.runtime_revision = revisionOf(s.row) + 1;
    s.row.message_count = s.messages.length;
    this.publish(s, turn);
    if (s.deferredPick) {
      this.commit(s.row, "model", s.deferredPick);
      s.deferredPick = undefined;
    }
    if (this.options.stubModel) this.drive(s);
  }

  ask(sessionId: string, method: "approval" | "clarify", params: Json): string | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    const ids: string[] = [];
    const questions = method === "clarify" ? (params.questions as Json[]) : [params];
    for (const q of questions) {
      const promptId = method === "approval" ? hex(++this.minted, 32) : hex(++this.minted, 10);
      const payload =
        method === "approval"
          ? { kind: "approval", prompt_id: promptId, execution_generation: generationOf(s.row), command: q.command, description: q.description, choices: q.choices, timeout_s: 300 }
          : { kind: "clarify", prompt_id: promptId, execution_generation: generationOf(s.row), question: q.question, choices: q.choices ?? [], multi_select: !!q.multi_select, timeout_s: 90 };
      s.prompts.set(promptId, { kind: method, payload });
      this.emit(s, `${method}.request`, payload);
      ids.push(promptId);
    }
    return ids[0];
  }

  /** The prompt's answer, or `undefined` once Stop withdrew it. */
  answered(sessionId: string, promptId: string): Promise<string | undefined> {
    const s = this.sessions.get(sessionId);
    const p = s?.prompts.get(promptId);
    if (!p) return Promise.reject(new Error(`no prompt ${promptId} in ${sessionId}`));
    if (p.answer !== undefined || s?.turn?.interrupted) return Promise.resolve(p.answer);
    return new Promise((resolve) => (p.wake = resolve));
  }

  private drive(s: Session) {
    if (s.turn || !s.admissions.some((a) => a.status === "queued")) return;
    setTimeout(() => {
      if (s.turn) return;
      this.event(s.id, "message.start", {});
      const turn = s.turn;
      if (turn) void this.play(s, turn);
    }, 0);
  }

  private async play(s: Session, turn: Turn) {
    const text = (turn.admission?.text ?? "").toLowerCase();
    const word = this.options.wordMs ?? 5;
    const say = async (reply: string) => {
      const words = reply.split(" ");
      let said = "";
      for (const [i, w] of words.entries()) {
        if (turn.interrupted) break;
        const piece = w + (i + 1 < words.length ? " " : "");
        said += piece;
        this.event(s.id, "message.delta", { text: piece });
        await sleep(word);
      }
      this.event(s.id, "message.complete", turn.interrupted ? { text: said.trim(), status: "interrupted" } : { text: reply, status: "complete" });
    };
    await sleep(word);
    if (text.includes("approve-me")) {
      const command = "rm -rf /tmp/hermes-chat-canonical-probe-no-such-dir";
      this.event(s.id, "tool.start", { tool_id: "call_1", name: "terminal", context: command });
      const id = this.server.askApproval(s.id, { command, description: "delete in root path", choices: ["once", "deny", "session", "always"] }).id!;
      const choice = await this.answered(s.id, id);
      const result =
        choice === undefined
          ? { output: "", exit_code: -1, error: "BLOCKED: Command approval was withdrawn before the user answered (explicit stop requested).", status: "blocked" }
          : choice === "deny"
            ? { output: "", exit_code: -1, error: "BLOCKED: Command denied by user." }
            : { output: "", exit_code: 0, error: null };
      this.event(s.id, "tool.complete", { tool_id: "call_1", name: "terminal", result: JSON.stringify(result) });
      return say(`Tool said: ${JSON.stringify(result)}`);
    }
    if (text.includes("clarify-me")) {
      this.event(s.id, "tool.start", { tool_id: "call_1", name: "clarify", context: "Tea or coffee?" });
      const id = this.server.askClarify(s.id, [{ question: "Tea or coffee?", choices: ["Tea (Recommended)", "Coffee"] }])!;
      const answer = await this.answered(s.id, id);
      const result =
        answer === undefined
          ? { responses: [{ question: "Tea or coffee?", choices_offered: ["Tea", "Coffee"], status: "unanswered", user_response: null }], outcome: "cancelled" }
          : { responses: [{ question: "Tea or coffee?", answer }] };
      this.event(s.id, "tool.complete", { tool_id: "call_1", name: "clarify", result: JSON.stringify(result) });
      return say(`You said: ${JSON.stringify(result)}`);
    }
    if (text.includes("slow")) {
      const reply = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
      return say(reply);
    }
    return say("Stub model reply.");
  }

  /** `SessionAuthority.respond` and `PendingControls.respond` (`gateway/session_pending_controls.py`). */
  private respondTo(c: Connection, s: Session | undefined, params: Json, kind: "approval" | "clarify") {
    const answerKey = kind === "approval" ? "choice" : "answer";
    const exact = ["session_id", "execution_generation", "prompt_id", answerKey];
    if (Object.keys(params).length !== exact.length || !exact.every((k) => k in params)) return { refusal: refusal("invalid_params") };
    if (!s) return { refusal: refusal("not_found") };
    if (!c.subscriptionIdBySession.has(s.id)) return { refusal: refusal("permission_denied") };
    if (params.execution_generation !== generationOf(s.row) || !s.turn) return { refusal: refusal("stale_generation") };
    const promptId = params.prompt_id;
    if (typeof promptId !== "string" || !promptId) return { refusal: refusal("invalid_params") };
    const p = s.prompts.get(promptId);
    if (!p || p.answer !== undefined) return { result: { status: "already_resolved", prompt_id: promptId } };
    const answer = params[answerKey];
    if (p.kind !== kind || typeof answer !== "string" || (kind === "approval" && !(p.payload.choices as string[]).includes(answer))) return { refusal: refusal("invalid_params") };
    p.answer = answer;
    if (kind === "approval") this.server.approvalAnswers.push({ id: promptId, choice: answer, via: "approval.respond" });
    this.emit(s, `${kind}.settled`, { prompt_id: promptId, execution_generation: generationOf(s.row) });
    p.wake?.(answer);
    return { result: { status: "resolved", prompt_id: promptId } };
  }

  /**
   * `mutate_session` (`gateway/session_mutations.py`), which `/api/ws` and `PATCH /api/sessions/{id}` share: checked as
   * `mutate_runtime_session` checks it, then fenced on the stored row.
   */
  private mutate(profile: string | undefined, id: unknown, params: Json): { result: Json } | { refusal: Refusal } {
    const r = typeof id === "string" ? this.server.store(profile)?.find((x) => x.id === id) : undefined;
    if (!r) return { refusal: refusal("not_found") };
    const fences = () => ({ revision: revisionOf(r), execution_generation: generationOf(r) });
    const { operation: op, payload, expected_revision: revision, expected_generation: generation } = params;
    if (typeof op !== "string" || !count(revision) || !fits(op, payload) || (generation !== undefined && !count(generation)) || (GENERATION_REQUIRED.has(op) && generation === undefined))
      return { refusal: refusal("invalid_params") };
    const key = `${r.id} ${String(params.request_id)}`;
    const request = sortedJson({ operation: op, payload, expected_revision: revision, expected_generation: generation });
    const known = this.receipts.get(key);
    if (known) return known.request === request ? { result: known.result } : { refusal: refusal("admission_conflict") };
    if (revision !== revisionOf(r)) return { refusal: refusal("revision_conflict", fences()) };
    if (generation !== undefined && generation !== generationOf(r)) return { refusal: refusal("stale_generation", fences()) };
    const live = this.sessions.get(r.id);
    if (!Object.hasOwn(PAYLOAD_FITS, op) || (POLICY.has(op) && !live)) throw new Error(`FakeAuthority: session.mutate operation '${op}' is not modelled${live ? "" : " on a stored session"} yet`);
    if (op === "workspace" && live?.turn) return { refusal: refusal("session_busy") };
    const deferred = op === "model" && !!live?.turn;
    if (deferred) live!.deferredPick = payload as Json;
    const result = deferred ? { session_id: r.id, operation: op, status: "deferred", model: (payload as Json).model, ...fences() } : this.commit(r, op, payload as Json);
    this.receipts.set(key, { request, result });
    return { result };
  }

  /** `PATCH /api/sessions/{id}` (`rename_session_endpoint`): a `sidebar` mutation, refused with `_MUTATION_REFUSAL_STATUS`. */
  patch(id: string, body: Json) {
    const payload = Object.fromEntries(Object.keys(METADATA).flatMap((k) => (body[k] === undefined || body[k] === null ? [] : [[k, body[k]]])));
    const { request_id, expected_revision, expected_generation } = body;
    const params = { request_id, expected_revision, operation: "sidebar", payload, ...(expected_generation != null && { expected_generation }) };
    const out = this.mutate(typeof body.profile === "string" ? body.profile : undefined, id, params);
    if ("refusal" in out) throw new RestError(REST_STATUS[out.refusal.message] ?? 409, JSON.stringify({ detail: out.refusal.message }));
    return { ok: true, ...out.result };
  }

  /** `mutate_runtime_session`'s commit, then `_project_committed`'s events to a live session's viewers. */
  private commit(r: SessionRow, op: string, payload: Json): Json {
    const projection: Json = {};
    if (op === "workspace") {
      r.cwd = String(payload.cwd);
      Object.assign(projection, { cwd: r.cwd, branch: null, git_repo_root: null });
    } else if (op === "model") {
      const base = this.server.sessionModel.get(r.id) ?? this.server.defaultModel(this.sessions.get(r.id)!.profile);
      this.server.sessionModel.set(r.id, { ...base, model: String(payload.model), provider: String(payload.provider ?? base.provider) });
      Object.assign(projection, { model: payload.model, provider: payload.provider ?? base.provider });
    } else {
      for (const [k, v] of Object.entries(payload)) {
        if (k === "title") r.title = String(v).trim() || null;
        else if (k === "unread") r.last_read_at = v ? 0 : Date.now() / 1000;
        else Object.assign(r, { [k]: v });
        projection[k] = k === "title" ? r.title : v;
      }
    }
    r.runtime_revision = revisionOf(r) + 1;
    if (POLICY.has(op)) r.runtime_generation = generationOf(r) + 1;
    const result = { session_id: r.id, revision: revisionOf(r), execution_generation: generationOf(r), operation: op, ...projection };
    const live = this.sessions.get(r.id);
    if (live && POLICY.has(op)) this.emit(live, "session.info", this.info(live));
    if (live) this.emit(live, "session.updated", result);
    return result;
  }

  private readonly handlers: Record<string, (c: Connection, params: Json, req: Request, profile: string) => { result: unknown } | { refusal: Refusal } | undefined> = {
    "session.create": (c, params, _, profile) => {
      const n = ++this.minted;
      const id = `local-${hex(n, 64)}`;
      const source = typeof params.source === "string" ? params.source : "cli";
      const stored = row(id, 0, {
        source,
        created_source: "desktop",
        title: typeof params.title === "string" ? params.title : null,
        cwd: typeof params.cwd === "string" ? params.cwd : this.server.hermesHome,
        preview: "",
        message_count: 0,
        ...(params.hidden === true && { hidden: true }),
      });
      const s: Session = { id, profile, source, row: stored, startedAt: Date.now() / 1000, replayEpoch: hex(n, 32), seq: 0, admissions: [], prompts: new Map(), replayLog: [], messages: [] };
      this.sessions.set(id, s);
      this.server.runtime.set(id, id);
      this.server.runtimeProfile.set(id, profile);
      this.server.agentTools.set(id, this.server.offeredTools(profile));
      const base = this.server.defaultModel(profile);
      this.server.sessionModel.set(id, { ...base, ...(typeof params.model === "string" && { model: params.model }), ...(typeof params.provider === "string" && { provider: params.provider }) });
      this.server.store(profile)?.push(stored);
      return { result: this.snapshot(s, this.subscribe(c, s)) };
    },
    "session.resume": (c, params, _, profile) => {
      const s = this.session(params.session_id, profile);
      if (!s) return { refusal: refusal("not_found") };
      return { result: this.snapshot(s, this.subscribe(c, s)) };
    },
    "session.info": (_c, params, _r, profile) => {
      const s = this.session(params.session_id, profile);
      return s ? { result: this.info(s) } : { refusal: refusal("not_found") };
    },
    "session.detach": (c, params) => {
      const sid = String(params.session_id);
      const subscription = String(params.subscription_id);
      const detached = c.subscriptionIdBySession.get(sid) === subscription;
      if (detached) c.subscriptionIdBySession.delete(sid);
      return { result: { session_id: sid, subscription_id: subscription, detached } };
    },
    "session.list": (_c, params, _r, profile) => {
      const all = [...this.sessions.values()].filter((s) => this.session(s.id, profile));
      if (typeof params.title === "string") {
        const s = all.find((x) => x.row.title === params.title && !x.row.archived);
        const rows = s
          ? [{ session_id: s.id, id: s.id, resolved_id: s.id, title: s.row.title ?? "", root_title: s.row.title ?? "", source: "local", started_at: s.startedAt, message_count: s.messages.length, running: !!s.turn }]
          : [];
        return { result: { sessions: rows, scope: "stored" } };
      }
      const rows = all
        .filter((s) => params.include_hidden === true || (!s.row.archived && !s.row.hidden))
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, typeof params.limit === "number" ? params.limit : 200)
        .map((s) => ({ session_id: s.id, id: s.id, title: s.row.title ?? "", source: "local", started_at: s.startedAt, message_count: s.messages.length, model: this.info(s).model, running: !!s.turn }));
      return { result: { sessions: rows, scope: "live" } };
    },
    "prompt.submit": (c, params, _, profile) => {
      const s = this.session(params.session_id, profile);
      if (!s || !c.subscriptionIdBySession.has(s.id)) return { refusal: refusal("permission_denied") };
      const requestId = params.submission_id || params.input_id;
      if (typeof requestId !== "string" || !requestId) return { refusal: refusal("invalid_params") };
      const { session_id: _s, submission_id: _i, input_id: _n, queued: _q, ...turn } = params;
      const payload = sortedJson(turn);
      const known = s.admissions.find((a) => a.requestId === requestId);
      if (known) {
        if (known.payload !== payload) return { refusal: refusal("admission_conflict", { field: "request_id", detail: "this request id was already admitted with another payload" }) };
        return { result: this.receipt(s, known) };
      }
      const admission: Admission = { id: hex(++this.minted, 32), requestId, payload, sequence: ++this.admitted, status: "queued", outcome: null, generation: null, text: String(params.text ?? "") };
      const images = Array.isArray(params.attachments) ? (params.attachments as Json[]).map((a) => String(a.path).split("/").at(-1)) : [];
      if (images.length) admission.text = `${images.map((name) => `[User attached image: ${name}]`).join("\n")}\n\n${admission.text}`;
      s.admissions.push(admission);
      if (s.row.title === null) s.row.title = String(params.text ?? "");
      queueMicrotask(() => {
        this.publish(s);
        if (this.options.stubModel) this.drive(s);
      });
      return { result: this.receipt(s, admission) };
    },
    "prompt.receipt": (_c, params, _r, profile) => {
      const s = this.session(params.session_id, profile);
      const a = s?.admissions.find((x) => x.id === params.admission_id);
      return s && a ? { result: this.receipt(s, a) } : { refusal: refusal("not_found") };
    },
    "session.interrupt": (_c, params, _r, profile) => {
      const s = this.session(params.session_id, profile);
      if (!s) return { refusal: refusal("not_found") };
      if (params.execution_generation !== generationOf(s.row)) return { refusal: refusal("stale_generation") };
      const running = !!s.turn;
      if (s.turn) {
        s.turn.interrupted = true;
        for (const p of s.prompts.values()) if (p.answer === undefined) p.wake?.(undefined);
      }
      return {
        result: { ref: { profile_id: this.profileId(s.profile), session_id: s.id }, instance_id: hex(1, 32), authority_epoch: 1, revision: revisionOf(s.row), execution_generation: generationOf(s.row), execution_state: running ? "running" : "idle" },
      };
    },
    "session.events.since": (_c, params, _r, profile) => {
      const s = this.session(params.session_id, profile);
      if (!s) return { refusal: refusal("not_found") };
      const from = Number(params.last_sequence ?? params.last_seen ?? 0);
      const replay = params.replay_epoch === s.replayEpoch;
      const events = replay ? s.replayLog.filter((e) => (e.seq as number) > from) : [];
      return {
        result: {
          events,
          latest_seq: s.seq,
          last_sequence: s.seq,
          epoch: s.replayEpoch,
          replay_epoch: s.replayEpoch,
          truncated: !replay,
          snapshot_required: !replay,
          count: events.length,
          open_requests: this.server.openRequestsOf(s.id),
        },
      };
    },
    "approval.respond": (c, params, _, profile) => this.respondTo(c, this.session(params.session_id, profile), params, "approval"),
    "clarify.respond": (c, params, _, profile) => this.respondTo(c, this.session(params.session_id, profile), params, "clarify"),
    "session.mutate": (_c, params, _r, profile) => this.mutate(profile, params.session_id, params),
    // `gateway/session_images.py`: the image is only stored. A turn has it when prompt.submit lists its path.
    "image.attach_bytes": (_c, params, _r, profile) => {
      if (!this.session(params.session_id, profile)) return { refusal: refusal("not_found") };
      const n = ++this.minted;
      const name = `upload_${hex(n, 8)}.png`;
      const path = `/home/hermes/.hermes/cache/images/${name}`;
      const data = atob(String(params.content_base64 ?? ""));
      this.server.serverFiles[path] = data;
      return { result: { attached: true, path, mime: "image/png", name, count: 1, remainder: "", text: `[User attached image: ${name}]`, bytes: data.length } };
    },
    "config.set": (c, params, req) => (params.key === "model" && params.session_id ? { refusal: refusal("use_session_mutation_model") } : this.asLegacy(c, req)),
    "command.dispatch": (c, params, req) => (params.name === "steer" ? { refusal: refusal("unsupported_command") } : this.asLegacy(c, req)),
    "shell.exec": (c, params, req) => (typeof params.session_id === "string" && params.session_id ? this.asLegacy(c, req) : { refusal: refusal("invalid_params") }),
  };

  /** A legacy handler answers for the authority, under an id of the authority's own so its answer finds the socket. */
  private asLegacy(connection: Connection, req: Request): undefined {
    const id = this.nextOwed++;
    this.owed.set(id, { connection, id: req.id, lost: this.losing.delete(req.method) });
    this.server.handlers[req.method]?.({ ...req, id });
    return undefined;
  }
}
