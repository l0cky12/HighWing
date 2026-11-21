// The canonical session protocol's core: sessions, turns, Approvals, Clarify and Stop (ADR 0174, ADR 0248). Shapes are
// Hermes v0.23.2's, as `canonicalFlows.ts` holds a real gateway and `fakeCanonical.ts` to them. `negotiate` picks it
// only while `canonicalGate` is open, which no app code does.
import type { QuestionItem, SentImage } from "./model";
import { withContext } from "./projectContext";
import { sentImage } from "./sentImages";
import {
  FILE_MARK,
  IMAGE_ONLY_PROMPT,
  LIMITS,
  LegacyProtocol,
  RpcError,
  settleRequest,
  unconfirmed,
  type Admitted,
  type AnswerOutcome,
  type Attached,
  type CardAnswer,
  type EditAnswer,
  type GoingOut,
  type Inbound,
  type Message,
  type OpenRequest,
  type Port,
  type RpcFrame,
  type ServerRequest,
  type SessionEdit,
  type SessionProtocol,
  type SessionSetting,
} from "./sessionProtocol";
import { isObj, optionalText } from "./values";

type Json = Record<string, unknown>;
type PromptKind = "approval" | "clarify";

/**
 * What this connection knows of a session it attached, from the create or resume snapshot, kept current by each event's
 * envelope and by `session.info`. `seeded`: project instructions and Referenced chats not sent yet, which go as attached
 * context with the next message (ADR 0174 open question 1). `prompts`: the Approvals and Clarify questions it waits on,
 * by prompt id, with the generation of the turn that asked.
 */
type Live = {
  subscription: string;
  generation: number;
  revision: number;
  replayEpoch: string;
  seq: number;
  running: boolean;
  seeded: readonly string[];
  prompts: Map<string, { kind: PromptKind; generation: number }>;
};

const obj = (v: unknown): Json | undefined => (isObj(v) ? v : undefined);
const int = (v: unknown) => (Number.isInteger(v) ? (v as number) : undefined);
const promptKind = (v: unknown): PromptKind | undefined => (v === "approval" || v === "clarify" ? v : undefined);

/** `4001 stale_generation`: the turn the answer or Stop named is over. */
const isStale = (e: unknown) => e instanceof RpcError && e.code === 4001 && (obj(e.data)?.reason === "stale_generation" || e.message === "stale_generation");

const notYet = (what: string) => Promise.reject(new Error(`${what} isn't supported on Hermes's canonical session protocol yet.`));

/**
 * A waiting prompt as the server→client request the transport makes its card from. A Clarify asks one question per
 * prompt, so each is a card of one question whose id is the prompt's. An Approval's offered choices are the grants it
 * allows.
 */
function promptAsk(sessionId: string, kind: PromptKind, p: Json): ServerRequest | undefined {
  const id = optionalText(p.prompt_id);
  if (!id) return undefined;
  if (kind === "clarify") return { id, method: kind, params: { session_id: sessionId, questions: [{ qid: id, question: p.question, choices: p.choices, multi_select: p.multi_select }] } };
  const choices = Array.isArray(p.choices) ? p.choices : [];
  return { id, method: kind, params: { ...p, session_id: sessionId, request_id: id, allow_session: choices.includes("session"), allow_permanent: choices.includes("always") } };
}

export class CanonicalProtocol implements SessionProtocol {
  readonly kind = "canonical";
  private readonly live = new Map<string, Live>();
  /** The methods a canonical gateway answers as a legacy one, which it sends as the legacy protocol does. */
  private readonly asLegacy: LegacyProtocol;

  constructor(private readonly port: Port) {
    this.asLegacy = new LegacyProtocol(port);
  }

  inbound({ id, method, params }: RpcFrame): readonly Inbound[] {
    if (typeof id === "string" && typeof method === "string" && method) return [{ kind: "ask", req: { id, method, params } }];
    const type = optionalText(params.type);
    if (method !== "event" || !type) return [];
    const sessionId = optionalText(params.session_id);
    const payload = obj(params.payload) ?? {};
    const live = sessionId ? this.live.get(sessionId) : undefined;
    if (!sessionId || !live) return [{ kind: "event", type, sessionId, payload }];
    live.generation = int(params.execution_generation) ?? live.generation;
    live.seq = int(params.seq) ?? live.seq;
    live.replayEpoch = optionalText(params.replay_epoch) ?? live.replayEpoch;
    if (type === "session.info") {
      if (typeof payload.running === "boolean") live.running = payload.running;
      live.generation = int(payload.execution_generation) ?? live.generation;
      live.revision = int(payload.revision) ?? live.revision;
    }
    const [asked, settled] = type.split(".") as [string, string?];
    const kind = promptKind(asked);
    if (kind && settled === "request") {
      const req = promptAsk(sessionId, kind, payload);
      if (!req) return [];
      live.prompts.set(req.id, { kind, generation: int(payload.execution_generation) ?? live.generation });
      return [{ kind: "ask", req }];
    }
    if (kind && settled === "settled") {
      const promptId = optionalText(payload.prompt_id);
      if (!promptId) return [];
      live.prompts.delete(promptId);
      return [{ kind: "event", type: "request.cancel", sessionId, payload: { id: promptId, reason: "withdrawn" } }];
    }
    return [{ kind: "event", type, sessionId, payload }];
  }

  /** Keeps what a create or resume snapshot says of the session, and reads it as the transport's `Attached`. */
  private attach(res: unknown, seeded: readonly string[]): Attached {
    const s = obj(res) ?? {};
    const id = optionalText(s.session_id) ?? "";
    const prompts = (Array.isArray(s.prompts) ? s.prompts : []).flatMap((p) => {
      const payload = obj(p);
      const kind = promptKind(payload?.kind);
      const req = payload && kind && promptAsk(id, kind, payload);
      return req ? [{ req, kind, generation: int(payload.execution_generation) }] : [];
    });
    const running = s.running === true;
    const live: Live = {
      subscription: optionalText(s.subscription_id) ?? "",
      generation: int(s.execution_generation) ?? 0,
      revision: int(s.revision) ?? 0,
      replayEpoch: optionalText(s.replay_epoch) ?? "",
      seq: int(s.last_sequence) ?? 0,
      running,
      seeded,
      prompts: new Map(prompts.map((p) => [p.req.id, { kind: p.kind, generation: p.generation ?? int(s.execution_generation) ?? 0 }])),
    };
    this.live.set(id, live);
    const started = (Array.isArray(s.pending) ? s.pending : []).map(obj).find((a) => a?.status === "started");
    const open = Array.isArray(s.open_requests) ? (s.open_requests as ServerRequest[]) : [];
    return {
      runtimeId: id,
      storedId: optionalText(s.stored_session_id) ?? id,
      messages: s.messages,
      running,
      ...(typeof started?.text === "string" && { inflightUser: started.text }),
      asking: [...prompts.map((p) => p.req), ...open],
      info: s.info,
      usage: s.usage,
    };
  }

  open(req: OpenRequest): Promise<Attached> {
    const params =
      req.kind === "bot"
        ? { profile: req.profile, title: req.title, hidden: true, follow_profile_config: true, source: req.source }
        : {
            profile: req.profile,
            source: req.source,
            ...(req.folder && { cwd: req.folder, cwd_explicit: true }),
            ...(req.model && { model: req.model.model, provider: req.model.provider }),
          };
    return this.port.call("session.create", params, { read: (res) => this.attach(res, req.seeded) });
  }

  resume(chatId: string, profile: string): Promise<Attached> {
    const seeded = this.live.get(chatId)?.seeded ?? [];
    return this.port.call("session.resume", { session_id: chatId, profile }, { read: (res) => this.attach(res, seeded) });
  }

  leave(runtimeId: string): Promise<unknown> {
    const live = this.live.get(runtimeId);
    if (!live) return Promise.resolve(undefined);
    this.live.delete(runtimeId);
    return this.port.call("session.detach", { session_id: runtimeId, subscription_id: live.subscription });
  }

  /**
   * Images are only stored by `image.attach_bytes`, and the turn has each one whose path `prompt.submit` lists. Other
   * files are staged as on a legacy server. If anything fails the message isn't sent; a stored image is in no turn.
   */
  async submit(runtimeId: string, { profile, text, attachments, hold, context }: Message, goingOut: GoingOut): Promise<Admitted> {
    const stored: Json[] = [];
    const images: SentImage[] = [];
    const refs: string[] = [];
    for (const a of attachments) {
      const file = { path: a.path, maxBytes: LIMITS[a.kind].bytes };
      try {
        if (a.kind === "image") {
          const params = { session_id: runtimeId, filename: a.name, content_base64: FILE_MARK };
          const { path, mime } = (await this.port.call("image.attach_bytes", params, { file })) as { path: string; mime?: string };
          stored.push({ path, ...(mime && { mime }) });
          const image = sentImage(path, a.name);
          if (image) images.push(image);
        } else {
          const params = { session_id: runtimeId, name: a.name, data_url: `data:application/octet-stream;base64,${FILE_MARK}` };
          refs.push(((await this.port.call("file.attach", params, { file })) as { ref_text: string }).ref_text);
        }
      } catch (e) {
        throw new Error(`Couldn't attach ${a.name}: ${(e as Error).message}`);
      }
    }
    const prompt = [refs.join("\n"), text].filter(Boolean).join("\n\n") || (stored.length ? IMAGE_ONLY_PROMPT : "");
    goingOut(prompt, images);
    return this.admit(runtimeId, { session_id: runtimeId, profile, ...(stored.length && { attachments: stored }), ...(hold && { queued: true }) }, prompt, context);
  }

  submitHidden(runtimeId: string, profile: string, text: string): Promise<Admitted> {
    return this.admit(runtimeId, { session_id: runtimeId, profile, display_kind: "hidden" }, text, []);
  }

  /**
   * `prompt.submit` with a `submission_id` of its own, which the canonical protocol requires. The session's seeded
   * context goes with the first message Hermes admits. `held`: Hermes queued it behind a running turn.
   */
  private admit(runtimeId: string, params: Json, text: string, context: readonly string[]): Promise<Admitted> {
    const live = this.live.get(runtimeId);
    const seeded = live?.seeded ?? [];
    const read = (receipt: unknown): Admitted => {
      if (live?.seeded === seeded) live.seeded = [];
      return { held: obj(receipt)?.status === "queued" && !!live?.running };
    };
    return this.port.call("prompt.submit", { ...params, text: withContext(text, [...seeded, ...context]), submission_id: crypto.randomUUID() }, { read }).catch(unconfirmed);
  }

  stop(runtimeId: string): Promise<boolean> {
    const live = this.live.get(runtimeId);
    if (!live) return Promise.resolve(false);
    return this.port.call("session.interrupt", { session_id: runtimeId, execution_generation: live.generation }, { read: (res) => obj(res)?.execution_state === "running" });
  }

  command(runtimeId: string, name: string, arg: string): Promise<unknown> {
    return this.asLegacy.command(runtimeId, name, arg);
  }

  configure(runtimeId: string, profile: string, key: SessionSetting, value: string, extra?: Record<string, unknown>): Promise<unknown> {
    return this.asLegacy.configure(runtimeId, profile, key, value, extra);
  }

  /**
   * An Approval or a Clarify question is answered by its prompt id, with the generation of the turn that asked. A Skip
   * answers a Clarify with no words. Sudo and Secret questions are still server→client requests.
   */
  answer(runtimeId: string, card: QuestionItem, a: CardAnswer): Promise<AnswerOutcome> {
    if (card.kind === "sudo" || card.kind === "secret") return a.kind === "settle" ? settleRequest(this.port, card.id, a.result) : Promise.resolve("stale");
    const promptId = card.kind === "approval" ? card.requestId : card.id;
    const prompt = this.live.get(runtimeId)?.prompts.get(promptId);
    if (!prompt || prompt.kind !== card.kind) return Promise.resolve("stale");
    const fenced = { session_id: runtimeId, execution_generation: prompt.generation, prompt_id: promptId };
    const done: AnswerOutcome = card.kind === "approval" ? "taken" : "done";
    const read = (res: unknown): AnswerOutcome => (obj(res)?.status === "resolved" ? done : "stale");
    const sent =
      a.kind === "approval"
        ? this.port.call("approval.respond", { ...fenced, choice: a.choice }, { read })
        : this.port.call("clarify.respond", { ...fenced, answer: a.kind === "lock" ? (a.answer ?? "") : "" }, { read });
    return sent.catch((e: unknown) => {
      if (isStale(e)) return "stale";
      throw e;
    });
  }

  /** Nothing to ask: a canonical gateway closes a Question with `*.settled`, and `settleQuestions` would close a prompt's card on a list without it. */
  openRequests(): Promise<readonly unknown[] | undefined> {
    return Promise.resolve(undefined);
  }

  edit<E extends SessionEdit>(_runtimeId: string, e: E): Promise<EditAnswer<E>> {
    return notYet(`A chat's ${e.op} edit`);
  }

  info(runtimeId: string): Promise<unknown> {
    return this.port.call("session.info", { session_id: runtimeId });
  }

  approvalProbe(): Promise<unknown> {
    return notYet("Diagnostics' Approval check");
  }
}
