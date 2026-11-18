import { expect } from "vitest";
import { APP_VERBS, CANONICAL_READY, type CanonicalAnswer } from "./canonicalVerbs";
import { protocolOf } from "./capabilities";

export type Json = Record<string, unknown>;
export type Answer = { result?: Json; error?: { code: number; message: string; data?: Json | null } };
export type Event = { type: string; session_id?: string; payload: Json; seq?: number; replay_epoch?: string; authority_epoch?: number; execution_generation?: number; admission_id?: string };

export type Wire = { send(text: string): void; close(): void };

export type FlowSocket = {
  ready: Json;
  rpc(method: string, params: Json): Promise<Answer>;
  event(type: string, sid: string, within?: number): Promise<Event>;
  sent: string[];
  close(): void;
};

export type FlowGateway = {
  socket(): Promise<FlowSocket>;
  loseNextAnswer(method: string): void;
  /** Makes a profile as the app does (`POST /api/profiles`); one that already exists is left as it is. */
  createProfile(name: string): Promise<void>;
  /** One dashboard REST call, e.g. `rest("GET", "api/sessions/x/mutation-snapshot?profile=default")`. */
  rest(method: "GET" | "PATCH", path: string, body?: Json): Promise<{ status: number; body: Json }>;
};

export type Flow = { name: string; run(g: FlowGateway): Promise<void> };

export async function flowSocket(open: (onText: (text: string) => void) => Promise<Wire>, drop?: (method: string) => boolean): Promise<FlowSocket> {
  const pending = new Map<number, (a: Answer) => void>();
  const lost = new Set<number>();
  const events: Event[] = [];
  const waiting = new Set<() => void>();
  const sent: string[] = [];
  let id = 0;
  let resolveReady!: (payload: Json) => void;
  const ready = new Promise<Json>((resolve) => (resolveReady = resolve));
  const wire = await open((text) => {
    for (const line of text.split("\n").filter((l) => l.trim())) {
      const f = JSON.parse(line);
      if (f.method === "event" && f.params?.type === "gateway.ready") resolveReady(f.params.payload ?? {});
      else if (f.method === "event") events.push({ ...f.params, payload: f.params.payload ?? {} });
      else if (typeof f.id === "number" && !lost.delete(f.id)) pending.get(f.id)?.(f);
      for (const wake of waiting) wake();
    }
  });
  const payload = await ready;
  const rpc = (method: string, params: Json) =>
    new Promise<Answer>((resolve) => {
      pending.set(++id, resolve);
      if (drop?.(method)) lost.add(id);
      const text = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      sent.push(text);
      wire.send(text);
    });
  const event = async (type: string, sid: string, within = 60_000): Promise<Event> => {
    const until = Date.now() + within;
    for (;;) {
      const i = events.findIndex((e) => e.type === type && e.session_id === sid);
      if (i >= 0) return events.splice(0, i + 1)[i];
      if (Date.now() > until) throw new Error(`no ${type} within ${within} ms; saw ${events.map((e) => e.type).join(", ")}`);
      await new Promise<void>((wake) => {
        const done = () => (waiting.delete(done), clearTimeout(timer), wake());
        const timer = setTimeout(done, 500);
        waiting.add(done);
      });
    }
  };
  return { ready: payload, rpc, event, sent, close: () => wire.close() };
}

const PROFILE = "default";
const SIBLING = "hwflow";
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** A canonical session, started as an adapter would start it. */
async function chat(s: FlowSocket) {
  const made = (await s.rpc("session.create", { source: "gui" })).result!;
  return { sid: made.session_id as string, subscription: made.subscription_id as string, made };
}

const submit = (s: FlowSocket, sid: string, text: string, more: Json = {}) => s.rpc("prompt.submit", { session_id: sid, text, submission_id: crypto.randomUUID(), ...more });

const mutate = (s: FlowSocket, sid: string, fences: { expected_revision: number; expected_generation?: number }, operation: string, payload: Json, request_id: string = crypto.randomUUID()) =>
  s.rpc("session.mutate", { session_id: sid, request_id, ...fences, operation, payload });

/** A gateway serves a new profile once its watcher rescans `profiles/`, every 30 s (`gateway/run_profile_reconcile.py`). */
async function served(s: FlowSocket, profile: string) {
  const until = Date.now() + 60_000;
  while ((await s.rpc("session.list", { profile })).error?.message === "profile_mismatch") {
    if (Date.now() > until) throw new Error(`the gateway never served ${profile}`);
    await new Promise((wake) => setTimeout(wake, 1000));
  }
}

const answerOf = (a: Answer): CanonicalAnswer => {
  if (!a.error) return "ok";
  const fields = a.error.data?.fields;
  return { code: a.error.code, message: a.error.message, ...(Array.isArray(fields) && { fields: fields as string[] }) };
};

export const CANONICAL_FLOWS: Flow[] = [
  {
    name: "names the canonical protocol in gateway.ready",
    async run(g) {
      const s = await g.socket();
      expect(s.ready.session_authority).toBe(true);
      expect(protocolOf(s.ready)).toBe("canonical");
      expect(Object.keys(s.ready).sort()).toEqual(Object.keys(CANONICAL_READY).sort());
      s.close();
    },
  },
  {
    name: "answers each JSON-RPC method the app sends as canonicalVerbs.ts records",
    async run(g) {
      const s = await g.socket();
      const { sid } = await chat(s);
      const differs: { method: string; shape?: string; recorded: CanonicalAnswer; live: CanonicalAnswer }[] = [];
      for (const v of APP_VERBS.filter((v) => !v.unprobed)) {
        const got = answerOf(await s.rpc(v.method, v.params({ sid, profile: PROFILE })));
        if (JSON.stringify(got) !== JSON.stringify(v.answer)) differs.push({ method: v.method, shape: v.shape, recorded: v.answer, live: got });
      }
      expect(differs).toEqual([]);
      s.close();
    },
  },
  {
    name: "runs a turn submitted with a submission id, each event stamped with its admission and generation",
    async run(g) {
      const s = await g.socket();
      const { sid, made } = await chat(s);
      expect(made).toMatchObject({ stored_session_id: sid, running: false, execution_generation: 0, revision: 0, last_sequence: 0, pending: [], prompts: [] });
      expect(sid).toMatch(/^local-[0-9a-f]{64}$/);
      const receipt = (await submit(s, sid, "hello")).result!;
      expect(receipt).toMatchObject({ status: "queued", outcome: null, execution_generation: null, authority_epoch: made.authority_epoch, ref: { session_id: sid } });
      const start = await s.event("message.start", sid);
      expect(start).toMatchObject({ admission_id: receipt.admission_id, execution_generation: 1, authority_epoch: made.authority_epoch, replay_epoch: made.replay_epoch });
      expect(start.seq).toBeGreaterThan(0);
      const done = await s.event("message.complete", sid);
      expect(done.payload).toMatchObject({ text: "Stub model reply.", status: "complete", outcome: "completed", admission_id: receipt.admission_id });
      expect(done.seq).toBeGreaterThan(start.seq!);
      expect((await s.event("session.info", sid)).payload).toMatchObject({ pending: [], running: false, execution_generation: 1, revision: 1 });
      expect((await s.rpc("prompt.receipt", { session_id: sid, admission_id: receipt.admission_id })).result).toMatchObject({ status: "terminal", outcome: "completed", execution_generation: 1 });

      const again = (await s.rpc("session.resume", { session_id: sid })).result!;
      expect(again).toMatchObject({ session_id: sid, running: false, execution_generation: 1, message_count: 2, subscription_id: made.subscription_id });
      expect((again.messages as Json[]).map((m) => [m.role, m.content])).toEqual([
        ["user", "hello"],
        ["assistant", "Stub model reply."],
      ]);
      const replay = (await s.rpc("session.events.since", { session_id: sid, last_sequence: start.seq, replay_epoch: start.replay_epoch })).result!;
      expect(replay).toMatchObject({ snapshot_required: false, truncated: false });
      expect((replay.events as Event[]).map((e) => e.type)).toContain("message.complete");
      expect((replay.events as Event[]).every((e) => e.seq! > start.seq!)).toBe(true);
      // The app's own read names no epoch, and gets no events back.
      expect((await s.rpc("session.events.since", { session_id: sid, last_seen: start.seq })).result).toMatchObject({ snapshot_required: true, events: [] });
      s.close();
    },
  },
  {
    name: "asks for an Approval with an event, which a second window answers by prompt id with an offered choice once it has resumed",
    async run(g) {
      const first = await g.socket();
      const { sid } = await chat(first);
      await submit(first, sid, "approve-me");
      const asked = await first.event("approval.request", sid);
      expect(asked.payload).toMatchObject({ kind: "approval", execution_generation: 1, choices: expect.arrayContaining(["once", "deny"]) });

      const second = await g.socket();
      const respond = (execution_generation: number, prompt_id = asked.payload.prompt_id, choice: unknown = "deny") => second.rpc("approval.respond", { session_id: sid, execution_generation, prompt_id, choice });
      expect((await respond(1)).error).toMatchObject({ code: 4001, message: "permission_denied" });
      const snapshot = (await second.rpc("session.resume", { session_id: sid })).result!;
      expect(snapshot).toMatchObject({ running: true, execution_generation: 1, prompts: [{ kind: "approval", prompt_id: asked.payload.prompt_id }] });
      expect((await respond(0)).error).toMatchObject({ code: 4001, message: "stale_generation" });
      expect((await respond(1, asked.payload.prompt_id, "maybe")).error).toMatchObject({ code: 4001, message: "invalid_params" });
      expect((await respond(1, asked.payload.prompt_id, 3)).error).toMatchObject({ code: 4001, message: "invalid_params", data: { fields: ["choice"] } });
      expect((await second.rpc("clarify.respond", { session_id: sid, execution_generation: 1, prompt_id: asked.payload.prompt_id, answer: "once" })).error).toMatchObject({
        code: 4001,
        message: "invalid_params",
      });
      expect((await respond(1)).result).toEqual({ status: "resolved", prompt_id: asked.payload.prompt_id });
      expect((await respond(1)).result).toEqual({ status: "already_resolved", prompt_id: asked.payload.prompt_id });
      expect((await respond(1, "no-such-prompt")).result).toEqual({ status: "already_resolved", prompt_id: "no-such-prompt" });
      expect((await first.event("approval.settled", sid)).payload).toEqual({ prompt_id: asked.payload.prompt_id, execution_generation: 1 });
      expect((await first.event("message.complete", sid)).payload.text).toMatch(/denied/i);
      first.close();
      second.close();
    },
  },
  {
    name: "asks a Clarify with an event, answered by prompt id with a string",
    async run(g) {
      const s = await g.socket();
      const { sid } = await chat(s);
      await submit(s, sid, "clarify-me");
      const asked = await s.event("clarify.request", sid);
      expect(asked.payload).toMatchObject({ kind: "clarify", question: "Tea or coffee?", execution_generation: 1, multi_select: false });
      const respond = (answer: unknown) => s.rpc("clarify.respond", { session_id: sid, execution_generation: 1, prompt_id: asked.payload.prompt_id, answer });
      expect((await respond(5)).error).toMatchObject({ code: 4001, message: "invalid_params" });
      expect((await s.rpc("approval.respond", { session_id: sid, execution_generation: 1, prompt_id: asked.payload.prompt_id, choice: "once" })).error).toMatchObject({
        code: 4001,
        message: "invalid_params",
      });
      const answered = await respond("Tea");
      expect(answered.result).toEqual({ status: "resolved", prompt_id: asked.payload.prompt_id });
      expect((await s.event("clarify.settled", sid)).payload).toEqual({ prompt_id: asked.payload.prompt_id, execution_generation: 1 });
      expect((await s.event("message.complete", sid)).payload.text).toMatch(/Tea/);
      s.close();
    },
  },
  {
    name: "stops a turn only when Stop names the turn's generation",
    async run(g) {
      const s = await g.socket();
      const { sid } = await chat(s);
      await submit(s, sid, "slow");
      const delta = await s.event("message.delta", sid);
      expect((await s.rpc("session.interrupt", { session_id: sid })).error).toMatchObject({ code: 4001, message: "stale_generation" });
      expect((await s.rpc("session.interrupt", { session_id: sid, execution_generation: 0 })).error).toMatchObject({ code: 4001, message: "stale_generation" });
      expect((await s.rpc("session.interrupt", { session_id: sid, execution_generation: delta.execution_generation })).result).toMatchObject({ execution_generation: 1, execution_state: "running" });
      expect((await s.event("message.complete", sid)).payload).toMatchObject({ status: "interrupted", outcome: "cancelled" });
      expect((await s.rpc("session.interrupt", { session_id: sid, execution_generation: 1 })).result).toMatchObject({ execution_generation: 1, execution_state: "idle" });
      s.close();
    },
  },
  {
    name: "holds a message sent mid-turn in the session's queue, and runs it as the next generation",
    async run(g) {
      const s = await g.socket();
      const { sid } = await chat(s);
      const running = (await submit(s, sid, "slow")).result!;
      await s.event("message.delta", sid);
      const queued = (await submit(s, sid, "hello", { queued: true })).result!;
      expect(queued).toMatchObject({ status: "queued", execution_generation: null });
      const snapshot = (await s.rpc("session.resume", { session_id: sid })).result!;
      expect(snapshot).toMatchObject({
        running: true,
        execution_generation: 1,
        pending: [
          { admission_id: running.admission_id, status: "started", execution_generation: 1 },
          { admission_id: queued.admission_id, status: "queued", execution_generation: null, text: "hello" },
        ],
      });
      await s.rpc("session.interrupt", { session_id: sid, execution_generation: 1 });
      expect(await s.event("message.complete", sid)).toMatchObject({ admission_id: running.admission_id, payload: { status: "interrupted" } });
      expect(await s.event("message.start", sid)).toMatchObject({ admission_id: queued.admission_id, execution_generation: 2 });
      expect((await s.event("message.complete", sid)).payload).toMatchObject({ text: "Stub model reply.", admission_id: queued.admission_id });
      expect((await s.rpc("prompt.receipt", { session_id: sid, admission_id: queued.admission_id })).result).toMatchObject({ status: "terminal", outcome: "completed", execution_generation: 2 });
      s.close();
    },
  },
  {
    name: "answers a message sent again after its answer was lost with the admission it already made",
    async run(g) {
      const first = await g.socket();
      const { sid } = await chat(first);
      const message = { session_id: sid, text: "slow", submission_id: crypto.randomUUID() };
      g.loseNextAnswer("prompt.submit");
      void first.rpc("prompt.submit", message);
      const start = await first.event("message.start", sid);
      first.close();

      const second = await g.socket();
      expect((await second.rpc("prompt.submit", message)).error).toMatchObject({ code: 4001, message: "permission_denied" });
      const snapshot = (await second.rpc("session.resume", { session_id: sid })).result!;
      expect(snapshot.pending).toMatchObject([{ admission_id: start.admission_id, input_id: message.submission_id, status: "started" }]);
      expect((await second.rpc("prompt.submit", message)).result).toMatchObject({ admission_id: start.admission_id, status: "started", execution_generation: 1 });
      expect((await second.rpc("prompt.submit", { ...message, text: "other" })).error).toMatchObject({
        code: 4001,
        message: "admission_conflict",
        data: { reason: "admission_conflict", field: "request_id" },
      });
      // Stopped before its first word, a turn is cancelled with no stored row (gateway/session_api_turn.py
      // `_settled_api_result`), which would hide a second admission.
      await second.event("message.delta", sid);
      await second.rpc("session.interrupt", { session_id: sid, execution_generation: 1 });
      expect(await second.event("message.complete", sid)).toMatchObject({ admission_id: start.admission_id });
      expect((await second.rpc("prompt.submit", message)).result).toMatchObject({ admission_id: start.admission_id, status: "terminal" });
      const after = (await second.rpc("session.resume", { session_id: sid })).result!;
      expect((after.messages as Json[]).filter((m) => m.role === "user")).toHaveLength(1);
      second.close();
    },
  },
  {
    name: "renames with session.mutate fenced on the revision, and answers a retried request as the first",
    async run(g) {
      const s = await g.socket();
      const { sid, made } = await chat(s);
      // A title another chat has is answered "internal error" (-32603), so each run names its own.
      const title = `Renamed ${crypto.randomUUID()}`;
      const rename = (request_id: string, expected_revision: number, to = title) =>
        s.rpc("session.mutate", { session_id: sid, request_id, expected_revision, operation: "rename", payload: { title: to } });
      const stale = await rename(crypto.randomUUID(), (made.revision as number) + 7);
      expect(stale.error).toMatchObject({ code: 4001, message: "revision_conflict", data: { reason: "revision_conflict", revision: made.revision, execution_generation: 0 } });
      expect((await s.rpc("session.mutate", { session_id: sid, request_id: "r", operation: "rename", payload: { title } })).error).toMatchObject({
        code: 4001,
        message: "invalid_params",
        data: { fields: ["expected_revision"] },
      });
      const key = crypto.randomUUID();
      const renamed = (await rename(key, stale.error!.data!.revision as number)).result!;
      expect(renamed).toEqual({ session_id: sid, revision: (made.revision as number) + 1, execution_generation: 0, operation: "rename", title });
      expect((await rename(key, made.revision as number)).result).toEqual(renamed);
      expect((await rename(key, made.revision as number, `${title} again`)).error).toMatchObject({ code: 4001, message: "admission_conflict" });
      expect((await s.event("session.updated", sid)).payload).toEqual(renamed);
      expect((await s.rpc("session.info", { session_id: sid })).result).toMatchObject({ title });
      s.close();
    },
  },
  {
    name: "detaches only the subscription this socket holds, and takes no message until it resumes",
    async run(g) {
      const s = await g.socket();
      const { sid, subscription } = await chat(s);
      const detach = (subscription_id: string) => s.rpc("session.detach", { session_id: sid, subscription_id });
      expect((await detach("no-such-subscription")).result).toEqual({ session_id: sid, subscription_id: "no-such-subscription", detached: false });
      expect((await detach(subscription)).result).toEqual({ session_id: sid, subscription_id: subscription, detached: true });
      expect((await detach(subscription)).result).toEqual({ session_id: sid, subscription_id: subscription, detached: false });
      expect((await submit(s, sid, "hello")).error).toMatchObject({ code: 4001, message: "permission_denied" });
      expect((await s.rpc("session.info", { session_id: sid })).result).toMatchObject({ desktop_protocol: "hermes-gateway-v1", source: "gui" });
      expect((await s.rpc("session.resume", { session_id: `local-${"0".repeat(64)}` })).error).toMatchObject({ code: 4001, message: "not_found" });
      const back = (await s.rpc("session.resume", { session_id: sid })).result!;
      expect(back.subscription_id).not.toBe(subscription);
      expect((await submit(s, sid, "hello")).result).toMatchObject({ status: "queued" });
      await s.event("message.complete", sid);
      s.close();
    },
  },
  {
    name: "lets a second socket resume a running turn, see the rest of it, and stop it",
    async run(g) {
      const first = await g.socket();
      const { sid } = await chat(first);
      const { admission_id } = (await submit(first, sid, "slow")).result!;
      await first.event("message.delta", sid);
      first.close();

      const second = await g.socket();
      expect((await submit(second, sid, "hello")).error).toMatchObject({ code: 4001, message: "permission_denied" });
      const snapshot = (await second.rpc("session.resume", { session_id: sid })).result!;
      expect(snapshot).toMatchObject({ session_id: sid, running: true, execution_generation: 1, pending: [{ admission_id, status: "started" }] });
      expect(snapshot.last_sequence).toBeGreaterThan(0);
      await second.rpc("session.interrupt", { session_id: sid, execution_generation: 1 });
      const done = await second.event("message.complete", sid);
      expect(done).toMatchObject({ admission_id, execution_generation: 1, payload: { status: "interrupted" } });
      expect(done.seq).toBeGreaterThan(snapshot.last_sequence as number);
      second.close();
    },
  },
  {
    name: "stores an attached image, and puts it in a turn only when prompt.submit lists it",
    async run(g) {
      const s = await g.socket();
      const { sid } = await chat(s);
      const attach = async () => (await s.rpc("image.attach_bytes", { session_id: sid, filename: "dot.png", content_base64: PNG_1X1 })).result!;
      const left = await attach();
      expect(left).toMatchObject({ attached: true, mime: "image/png", path: expect.stringContaining(left.name as string) });
      await submit(s, sid, "hello");
      await s.event("message.complete", sid);
      const kept = await attach();
      await submit(s, sid, "hello", { attachments: [{ path: kept.path, mime: kept.mime }] });
      await s.event("message.complete", sid);
      const said = ((await s.rpc("session.resume", { session_id: sid })).result!.messages as Json[]).filter((m) => m.role === "user").map((m) => String(m.content));
      expect(said).toHaveLength(2);
      expect(said[0]).not.toContain(left.name);
      expect(said[1]).toContain(kept.name);
      s.close();
    },
  },
  {
    name: "opens the next generation on a model or workspace change, and shows it to every viewer",
    async run(g) {
      const s = await g.socket();
      const { sid, made } = await chat(s);
      const cwd = (made.info as Json).cwd as string;
      const model = (await mutate(s, sid, { expected_revision: 0, expected_generation: 0 }, "model", { model: "fake", provider: "custom" })).result!;
      expect(model).toEqual({ session_id: sid, revision: 1, execution_generation: 1, operation: "model", model: "fake", provider: "custom" });
      expect((await s.event("session.info", sid)).payload).toMatchObject({ model: "fake", desktop_protocol: "hermes-gateway-v1", cwd });
      expect((await s.event("session.updated", sid)).payload).toEqual(model);
      expect((await mutate(s, sid, { expected_revision: 1, expected_generation: 0 }, "workspace", { cwd })).error).toMatchObject({
        message: "stale_generation",
        data: { revision: 1, execution_generation: 1 },
      });
      const moved = (await mutate(s, sid, { expected_revision: 1, expected_generation: 1 }, "workspace", { cwd })).result!;
      expect(moved).toEqual({ session_id: sid, revision: 2, execution_generation: 2, operation: "workspace", cwd, branch: null, git_repo_root: null });
      expect((await s.event("session.info", sid)).payload).toMatchObject({ cwd });
      expect((await s.event("session.updated", sid)).payload).toEqual(moved);
      await submit(s, sid, "hello");
      expect(await s.event("message.start", sid)).toMatchObject({ execution_generation: 3 });
      await s.event("message.complete", sid);
      s.close();
    },
  },
  {
    name: "holds a model pick made mid-turn, fences unchanged, and commits it when the turn ends",
    async run(g) {
      const s = await g.socket();
      const { sid } = await chat(s);
      await submit(s, sid, "slow");
      await s.event("message.delta", sid);
      const key = crypto.randomUUID();
      const pick = () => mutate(s, sid, { expected_revision: 0, expected_generation: 1 }, "model", { model: "fake", provider: "custom" }, key);
      const deferred = { session_id: sid, operation: "model", status: "deferred", model: "fake", revision: 0, execution_generation: 1 };
      expect((await mutate(s, sid, { expected_revision: 0, expected_generation: 1 }, "model", { provider: "custom" })).error).toMatchObject({ code: 4001, message: "invalid_params" });
      expect((await pick()).result).toEqual(deferred);
      expect((await pick()).result).toEqual(deferred);
      expect((await s.rpc("session.resume", { session_id: sid })).result).toMatchObject({ running: true, revision: 0, execution_generation: 1 });
      expect((await mutate(s, sid, { expected_revision: 0, expected_generation: 1 }, "workspace", { cwd: "/tmp" })).error).toMatchObject({ code: 4001, message: "session_busy" });
      await s.rpc("session.interrupt", { session_id: sid, execution_generation: 1 });
      await s.event("message.complete", sid);
      expect((await s.event("session.updated", sid)).payload).toEqual({ session_id: sid, revision: 2, execution_generation: 2, operation: "model", model: "fake", provider: "custom" });
      expect((await s.rpc("session.resume", { session_id: sid })).result).toMatchObject({ running: false, revision: 2, execution_generation: 2 });
      expect((await pick()).result).toEqual(deferred);
      s.close();
    },
  },
  {
    name: "withdraws the Approval or Clarify a turn waits on when Stop lands, then runs the next queued message",
    async run(g) {
      const s = await g.socket();
      const { sid } = await chat(s);
      const first = (await submit(s, sid, "approve-me")).result!;
      const approval = (await s.event("approval.request", sid)).payload;
      const next = (await submit(s, sid, "clarify-me", { queued: true })).result!;
      const stopped = [
        { generation: 1, admission: first.admission_id, kind: "approval", prompt: approval },
        { generation: 2, admission: next.admission_id, kind: "clarify" },
      ];
      for (const turn of stopped) {
        const prompt = turn.prompt ?? (await s.event(`${turn.kind}.request`, sid)).payload;
        expect(prompt).toMatchObject({ kind: turn.kind, execution_generation: turn.generation });
        expect((await s.rpc("session.interrupt", { session_id: sid, execution_generation: turn.generation })).result).toMatchObject({ execution_state: "running" });
        expect((await s.event(`${turn.kind}.settled`, sid)).payload).toEqual({ prompt_id: prompt.prompt_id, execution_generation: turn.generation });
        expect(await s.event("message.complete", sid)).toMatchObject({ admission_id: turn.admission, payload: { status: "interrupted", outcome: "cancelled" } });
        const answer = turn.kind === "approval" ? { choice: "once" } : { answer: "Tea" };
        expect((await s.rpc(`${turn.kind}.respond`, { session_id: sid, execution_generation: turn.generation, prompt_id: prompt.prompt_id, ...answer })).error).toMatchObject({
          code: 4001,
          message: "stale_generation",
        });
      }
      expect((await s.rpc("session.resume", { session_id: sid })).result).toMatchObject({ running: false, prompts: [], pending: [] });
      s.close();
    },
  },
  {
    name: "keeps each profile's sessions to its own authority, and refuses a profile it doesn't serve",
    async run(g) {
      const s = await g.socket();
      for (const method of ["session.list", "session.create"]) expect((await s.rpc(method, { profile: "no-such-profile" })).error).toMatchObject({ code: 4001, message: "profile_mismatch" });
      await g.createProfile(SIBLING);
      await served(s, SIBLING);
      const theirs = (await s.rpc("session.create", { profile: SIBLING, source: "gui" })).result!;
      expect(theirs.info).toMatchObject({ profile_name: SIBLING });
      const other = theirs.session_id as string;
      const { sid: mine } = await chat(s);
      const listed = async (params: Json) => ((await s.rpc("session.list", params)).result!.sessions as Json[]).map((r) => r.session_id);
      for (const ids of [await listed({}), await listed({ profile: PROFILE })]) expect(ids.includes(mine) && !ids.includes(other)).toBe(true);
      expect(await listed({ profile: SIBLING })).toContain(other);
      expect(await listed({ profile: SIBLING })).not.toContain(mine);
      for (const method of ["session.resume", "session.info", "session.events.since"]) expect((await s.rpc(method, { session_id: other })).error).toMatchObject({ code: 4001, message: "not_found" });
      expect((await submit(s, other, "hello")).error).toMatchObject({ code: 4001, message: "permission_denied" });
      expect((await s.rpc("session.resume", { session_id: mine, profile: SIBLING })).error).toMatchObject({ code: 4001, message: "not_found" });
      expect((await submit(s, other, "hello", { profile: SIBLING })).result).toMatchObject({ status: "queued", ref: { session_id: other } });
      expect((await s.event("message.complete", other)).payload).toMatchObject({ text: "Stub model reply." });
      s.close();
    },
  },
  {
    name: "refuses a session.mutate whose payload doesn't fit its operation, and leaves the revision where it was",
    async run(g) {
      const s = await g.socket();
      const { sid, made } = await chat(s);
      const cwd = (made.info as Json).cwd as string;
      const misfits: [string, unknown][] = [
        ["rename", {}],
        ["constructor", {}],
        ["rename", { title: 5 }],
        ["rename", { title: "Two keys", pinned: true }],
        ["archive", { archived: "yes" }],
        ["sidebar", {}],
        ["sidebar", { colour: "red" }],
        ["workspace", { cwd: " " }],
        ["workspace", { cwd, branch: "main" }],
        ["model", { provider: "custom" }],
        ["model", { model: "" }],
        ["model", { model: "fake", reasoning: "loud" }],
        ["rename", ["title"]],
        ["teleport", {}],
      ];
      const refused = [];
      for (const [operation, payload] of misfits) refused.push([operation, payload, (await mutate(s, sid, { expected_revision: 0, expected_generation: 0 }, operation, payload as Json)).error?.message]);
      expect(refused).toEqual(misfits.map(([operation, payload]) => [operation, payload, "invalid_params"]));
      expect((await s.rpc("session.resume", { session_id: sid })).result).toMatchObject({ revision: 0, execution_generation: 0 });
      const title = `Fits ${crypto.randomUUID()}`;
      expect((await mutate(s, sid, { expected_revision: 0 }, "rename", { title })).result).toMatchObject({ revision: 1, title });
      s.close();
    },
  },
  {
    name: "keeps one revision for a session whether it is edited with session.mutate or PATCH /api/sessions/{id}",
    async run(g) {
      const s = await g.socket();
      const { sid, made } = await chat(s);
      const cwd = (made.info as Json).cwd as string;
      const snapshot = async () => (await g.rest("GET", `api/sessions/${sid}/mutation-snapshot?profile=${PROFILE}`)).body;
      const patch = (expected_revision: number, edit: Json) => g.rest("PATCH", `api/sessions/${sid}`, { request_id: crypto.randomUUID(), expected_revision, ...edit });

      const moved = (await mutate(s, sid, { expected_revision: 0, expected_generation: 0 }, "workspace", { cwd })).result!;
      expect(moved).toMatchObject({ revision: 1, execution_generation: 1 });
      await s.event("session.updated", sid);
      expect(await snapshot()).toEqual({ session_id: sid, exists: true, runtime_revision: 1, runtime_generation: 1 });

      const title = `Patched ${crypto.randomUUID()}`;
      expect(await patch(0, { title })).toEqual({ status: 409, body: { detail: "revision_conflict" } });
      expect(await patch(1, {})).toEqual({ status: 400, body: { detail: "invalid_params" } });
      const patched = await patch(1, { title, pinned: true });
      expect(patched).toEqual({ status: 200, body: { ok: true, session_id: sid, revision: 2, execution_generation: 1, operation: "sidebar", title, pinned: true } });
      expect((await s.event("session.updated", sid)).payload).toMatchObject({ revision: 2, operation: "sidebar", title });
      expect((await s.rpc("session.info", { session_id: sid })).result).toMatchObject({ title, cwd });

      expect((await mutate(s, sid, { expected_revision: 1 }, "rename", { title: `${title} late` })).error).toMatchObject({
        code: 4001,
        message: "revision_conflict",
        data: { revision: 2, execution_generation: 1 },
      });
      expect((await mutate(s, sid, { expected_revision: 2 }, "archive", { archived: true })).result).toMatchObject({ revision: 3, archived: true });
      expect(await snapshot()).toMatchObject({ runtime_revision: 3, runtime_generation: 1 });
      expect((await g.rest("GET", `api/sessions/${sid}?profile=${PROFILE}`)).body).toMatchObject({ title, archived: 1, pinned: 1, runtime_revision: 3 });
      expect(await patch(2, { archived: false })).toEqual({ status: 409, body: { detail: "revision_conflict" } });
      s.close();
    },
  },
];
