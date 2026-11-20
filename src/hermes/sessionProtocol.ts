import type { AppMethod } from "./canonicalVerbs";
import { CapabilityUnsupportedError, type Protocol } from "./capabilities";
import type { ApprovalChoice, Attachment, QuestionItem, SentImage } from "./model";
import type { ModelPick } from "./models";
import { withContext } from "./projectContext";
import { sentImage } from "./sentImages";
import { SignInFailure } from "./signInFailure";
import { isObj, optionalText } from "./values";

export const SESSION_METHODS = [
  "approval.respond",
  "clarify.lock",
  "command.dispatch",
  "config.set",
  "image.attach_bytes",
  "image.detach",
  "prompt.submit",
  "session.branch",
  "session.close",
  "session.compress",
  "session.create",
  "session.cwd.set",
  "session.events.since",
  "session.interrupt",
  "session.resume",
  "session.status",
  "session.title",
  "session.undo",
] as const satisfies readonly AppMethod[];
export type SessionMethod = (typeof SESSION_METHODS)[number];
export type PlainMethod = Exclude<AppMethod, SessionMethod>;

const NO_SUCH_METHOD = -32601;
const MiB = 1024 * 1024;
/** The most legacy `image.attach_bytes` and `file.attach` take (research doc §7). PDFs go as files: `pdf.attach`
 * needs `pdftoppm`, which the live server doesn't have. */
export const LIMITS = { image: { bytes: 25 * MiB, what: "images" }, file: { bytes: 256 * MiB, what: "files" } };
/** What the official desktop app asks when an image is sent with no text. */
const IMAGE_ONLY_PROMPT = "What do you see in this image?";
/** Stands in for a file's base64 in a frame; the pipe swaps the bytes in. JSON can't hold a raw NUL. */
export const FILE_MARK = "\u0000file\u0000";

/**
 * The connection dropped after a request went out and before Hermes answered it, so whether Hermes got it can't be
 * known. A JSON-RPC id means nothing on the next connection, so asking again there isn't safe.
 */
export class ConnectionLostError extends Error {}

/** `prompt.submit` went out and the connection dropped before Hermes answered it. */
export class PromptUnconfirmedError extends Error {}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export class ProtocolMismatchError extends SignInFailure {
  constructor() {
    super({ stage: "chat", message: "This Hermes server speaks the canonical session protocol, which Highwing doesn't support yet." });
  }
}

/** A frame from Hermes: a JSON object, its `params` an object (`{}` when it sent none, or something else). */
export type RpcFrame = { id?: unknown; method?: unknown; params: Record<string, unknown>; result?: unknown; error?: unknown };

/**
 * A server→client request (`tui_gateway/server_requests.py`), as it arrives or as `session.resume` lists it in
 * `open_requests`. An `approval` one carries `{request_id, command, description, choices, ...}` (research doc §6).
 */
export type ServerRequest = { id: string; method: string; params: Record<string, unknown> };

export type Inbound = { kind: "ask"; req: ServerRequest } | { kind: "event"; type: string; sessionId?: string; payload: Record<string, unknown> };

export type Port = {
  call<T = unknown>(method: AppMethod, params: Record<string, unknown>, options?: { file?: { path: string; maxBytes: number }; observe?: boolean; read?: (result: unknown) => T }): Promise<T>;
  /** A response frame to a server→client request. Throws when nothing is connected. */
  reply(id: string, result: Record<string, unknown>): Promise<void>;
  /** Whether Hermes said this Approval is in its own queue (`approval.received` acknowledged). */
  inHermesQueue(requestId: string): boolean;
  /** Work nobody awaits, which the transport still waits for before it closes. */
  track(work: Promise<unknown>): void;
};

/**
 * What starting a session asks for. `seeded`: hidden messages stored before the owner's first (ADR 0017), or, in a Bot
 * Chat, Bot setup's brief (ADR 0231).
 */
export type OpenRequest =
  | { kind: "chat"; profile: string; source: string; folder?: string; model?: ModelPick; seeded: readonly string[] }
  | { kind: "bot"; profile: string; source: string; title: string; seeded: readonly string[] };

/**
 * A session attached on this connection, by `open` or `resume`. `runtimeId`: what this connection's frames call it.
 * `storedId`: the chat's id. `inflight`: a running turn's reply as streamed so far, and `inflightUser` the message it
 * answers, as sent. `asking`: what it still waits on, oldest first.
 */
export type Attached = {
  runtimeId: string;
  storedId: string;
  messages: unknown;
  running: boolean;
  inflight?: string;
  inflightUser?: string;
  asking: ServerRequest[];
  info: unknown;
  usage: unknown;
};

export type Message = { profile: string; text: string; attachments: readonly Attachment[]; hold: boolean; context: readonly string[] };

/** Hears the prompt just before it goes, and the images Hermes stored for it. */
export type GoingOut = (prompt: string, images: SentImage[]) => void;

/** Hermes took the message. `held`: it waits behind a running turn. `userRowId`: its stored row, when Hermes said. */
export type Admitted = { held: boolean; userRowId?: number };

export type CardAnswer = { kind: "approval"; choice: ApprovalChoice } | { kind: "lock"; qid: string; answer: string | null } | { kind: "settle"; result: Record<string, unknown> };

/** `taken`: Hermes has it. `done`: and nothing on the card waits any more. `stale`: Hermes had stopped waiting. */
export type AnswerOutcome = "taken" | "done" | "stale";

export type SessionSetting = "reasoning" | "fast" | "yolo" | "approvals.mode";

export type SessionEdit =
  | { op: "rename"; title: string }
  | { op: "folder"; profile: string; cwd: string }
  | { op: "branch"; count: number; key: string; name?: string }
  | { op: "undo" }
  | { op: "compact" }
  | { op: "model"; profile: string; pick: ModelPick; confirmed: boolean };

export type BranchAnswer = { session_id: string; stored_session_id: string; title: string; parent?: string; message_count: number; messages?: unknown; info?: unknown };

export type EditAnswers = {
  rename: unknown;
  folder: { cwd?: unknown } | undefined;
  branch: BranchAnswer;
  undo: unknown;
  compact: unknown;
  model: { confirmRequired: boolean; confirmMessage?: string };
};
export type EditAnswer<E extends SessionEdit> = EditAnswers[E["op"]];

export interface SessionProtocol {
  readonly kind: Protocol;
  /** What one frame from Hermes, other than an answer to a request, is to the transport. */
  inbound(frame: RpcFrame): readonly Inbound[];
  open(req: OpenRequest): Promise<Attached>;
  resume(chatId: string, profile: string): Promise<Attached>;
  leave(runtimeId: string): Promise<unknown>;
  /** Stages the attachments and submits. Rejects `PromptUnconfirmedError` when the connection drops before the answer. */
  submit(runtimeId: string, m: Message, goingOut: GoingOut): Promise<Admitted>;
  /**
   * Starts a turn with a message Hermes stores hidden, which no client shows as the owner's (ADR 0231). Rejects
   * `PromptUnconfirmedError` when the connection drops before the answer.
   */
  submitHidden(runtimeId: string, profile: string, text: string): Promise<Admitted>;
  /** Resolves whether Hermes stopped the turn. */
  stop(runtimeId: string): Promise<boolean>;
  command(runtimeId: string, name: string, arg: string): Promise<unknown>;
  configure(runtimeId: string, profile: string, key: SessionSetting, value: string, extra?: Record<string, unknown>): Promise<unknown>;
  answer(runtimeId: string, card: QuestionItem, a: CardAnswer): Promise<AnswerOutcome>;
  /** The requests Hermes still waits on in the session, or undefined when it doesn't say. */
  openRequests(runtimeId: string): Promise<readonly unknown[] | undefined>;
  edit<E extends SessionEdit>(runtimeId: string, e: E): Promise<EditAnswer<E>>;
  /** Rejects with Hermes's error when it no longer holds the session, which Settings → Toolsets reads. */
  info(runtimeId: string): Promise<unknown>;
  /** Diagnostics' check that Hermes takes an Approval's answer: one for `name`, a session and request no chat has. */
  approvalProbe(name: string): Promise<unknown>;
}

export function negotiate(ready: Record<string, unknown>, port: Port): SessionProtocol {
  if (ready.session_authority) throw new ProtocolMismatchError();
  return new LegacyProtocol(port);
}

const obj = (v: unknown) => (isObj(v) ? v : undefined);

const hiddenRows = (seeded: readonly string[]) => seeded.length > 0 && { messages: seeded.map((content) => ({ role: "user", content, display_kind: "hidden" })) };

const unconfirmed = (e: unknown) => {
  throw e instanceof ConnectionLostError ? new PromptUnconfirmedError(e.message) : e;
};

/**
 * `status` `queued`: Hermes holds the message until a turn it is running ends. `user_row_id`: the message's stored row,
 * when its turn started at once (`tui_gateway/methods_prompt.py` at `bf0203a`).
 */
const admitted = (res: unknown): Admitted => {
  const { status, user_row_id } = (obj(res) ?? {}) as { status?: unknown; user_row_id?: unknown };
  return { held: status === "queued", ...(typeof user_row_id === "number" && { userRowId: user_row_id }) };
};

type LegacySession = { session_id: string; stored_session_id: string; messages?: unknown; running?: boolean; inflight?: { assistant?: unknown; user?: unknown }; open_requests?: ServerRequest[]; info?: unknown; usage?: unknown };

const attached = (res: LegacySession): Attached => ({
  runtimeId: res.session_id,
  storedId: res.stored_session_id,
  messages: res.messages,
  running: !!res.running,
  ...(typeof res.inflight?.assistant === "string" && { inflight: res.inflight.assistant }),
  ...(typeof res.inflight?.user === "string" && { inflightUser: res.inflight.user }),
  asking: res.open_requests ?? [],
  info: res.info,
  usage: res.usage,
});

export class LegacyProtocol implements SessionProtocol {
  readonly kind = "legacy";
  constructor(private readonly port: Port) {}

  inbound({ id, method, params }: RpcFrame): readonly Inbound[] {
    if (typeof id === "string" && typeof method === "string" && method) return [{ kind: "ask", req: { id, method, params } }];
    const type = optionalText(params.type);
    if (method !== "event" || !type) return [];
    return [{ kind: "event", type, sessionId: optionalText(params.session_id), payload: obj(params.payload) ?? {} }];
  }

  open(req: OpenRequest): Promise<Attached> {
    if (req.kind === "bot") {
      const params = { profile: req.profile, title: req.title, hidden: true, follow_profile_config: true, source: req.source, ...hiddenRows(req.seeded) };
      return this.port.call("session.create", params, { read: (made) => attached((obj(made) ?? {}) as LegacySession) });
    }
    const { profile, source, folder, model, seeded } = req;
    const params = {
      profile,
      source,
      // `cwd_explicit`: a deliberate pick, which beats a profile's configured `terminal.cwd` (`_completion_cwd`).
      ...(folder && { cwd: folder, cwd_explicit: true }),
      ...hiddenRows(seeded),
      // `SessionCreateParams`: each is this session's own override. `fast` left out keeps the profile's.
      ...(model && {
        model: model.model,
        provider: model.provider,
        ...(model.effort && { reasoning_effort: model.effort }),
        ...(model.fast !== undefined && { fast: model.fast }),
      }),
    };
    return this.port.call("session.create", params, { read: (res) => attached(res as LegacySession) });
  }

  resume(chatId: string, profile: string): Promise<Attached> {
    return this.port.call("session.resume", { session_id: chatId, profile, inline_images: false }, { read: (res) => attached(res as LegacySession) });
  }

  leave(runtimeId: string): Promise<unknown> {
    return this.port.call("session.close", { session_id: runtimeId });
  }

  /**
   * Images are queued server-side; other files are staged in the session's workspace and their `@file:` refs go before
   * the text, as the official desktop app does. If anything fails the message isn't sent, and images already queued are
   * taken back so they don't ride along with the next one.
   */
  async submit(runtimeId: string, { profile, text, attachments, hold, context }: Message, goingOut: GoingOut): Promise<Admitted> {
    const queued: string[] = [];
    const images: SentImage[] = [];
    const refs: string[] = [];
    try {
      for (const a of attachments) {
        const file = { path: a.path, maxBytes: LIMITS[a.kind].bytes };
        try {
          if (a.kind === "image") {
            const params = { session_id: runtimeId, filename: a.name, content_base64: FILE_MARK };
            const { path } = (await this.port.call("image.attach_bytes", params, { file })) as { path: string };
            queued.push(path);
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
      const prompt = [refs.join("\n"), text].filter(Boolean).join("\n\n") || (queued.length ? IMAGE_ONLY_PROMPT : "");
      goingOut(prompt, images);
      return admitted(await this.port.call("prompt.submit", { session_id: runtimeId, profile, text: withContext(prompt, context), ...(hold && { queued: true }) }).catch(unconfirmed));
    } catch (e) {
      for (const path of queued) this.port.track(this.port.call("image.detach", { session_id: runtimeId, path }));
      throw e;
    }
  }

  async submitHidden(runtimeId: string, profile: string, text: string): Promise<Admitted> {
    return admitted(await this.port.call("prompt.submit", { session_id: runtimeId, profile, text, display_kind: "hidden" }).catch(unconfirmed));
  }

  stop(runtimeId: string): Promise<boolean> {
    // `not_interrupted` needs `expected_hosted_task_id` (research doc §8).
    return this.port.call("session.interrupt", { session_id: runtimeId }, { read: (res) => (res as { status: "interrupted" | "not_interrupted" }).status === "interrupted" });
  }

  command(runtimeId: string, name: string, arg: string): Promise<unknown> {
    return this.port.call("command.dispatch", { name, arg, session_id: runtimeId });
  }

  configure(runtimeId: string, profile: string, key: SessionSetting, value: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    return this.port.call("config.set", { session_id: runtimeId, profile, key, value, ...extra });
  }

  answer(runtimeId: string, card: QuestionItem, a: CardAnswer): Promise<AnswerOutcome> {
    if (a.kind === "settle") return this.settleRequest(card.id, a.result);
    if (a.kind === "approval") return this.settleApproval(runtimeId, card, a.choice);
    return this.port.call(
      "clarify.lock",
      { request_id: card.id, question_id: a.qid, answer: a.answer },
      {
        read: (answer) => {
          const res = obj(answer);
          // Hermes answers the Clarify on the last lock, which may be this one though another client locked the rest.
          if (Array.isArray(res?.remaining) && !res.remaining.length) return "done";
          return res?.status !== "expired" ? "taken" : "stale";
        },
      },
    );
  }

  /**
   * Answers an open request with `result` by `request.answer`, which says whether Hermes still waited: false when it had
   * stopped, as when another Hermes client answered first. A Hermes without it gets a response frame to the request, as
   * the official app sends, which Hermes drops without a word once it has stopped waiting.
   */
  private async settleRequest(id: string, result: Record<string, unknown>): Promise<AnswerOutcome> {
    try {
      return obj(await this.port.call("request.answer", { id, result }))?.status !== "expired" ? "taken" : "stale";
    } catch (e) {
      if (!(e instanceof CapabilityUnsupportedError) && !(e instanceof RpcError && e.code === NO_SUCH_METHOD)) throw e;
    }
    await this.port.reply(id, result);
    return "taken";
  }

  /**
   * Sends an Approval's answer: `approval.respond`, which settles it in Hermes's approval queue, so Hermes withdraws
   * the card from every other app with the chat open (`request.cancel`). A response frame to the request settles it
   * first, and no other app hears (#318). A Hermes without `approval.respond`, or a card without a request id, still
   * gets one (research doc §6), and so does a card Hermes never said was in its own queue (`inHermesQueue`) when
   * `approval.respond` settles nothing. `stale`: Hermes had nothing waiting under that request id.
   */
  private async settleApproval(runtimeId: string, card: QuestionItem, choice: ApprovalChoice): Promise<AnswerOutcome> {
    if (card.kind === "approval" && card.requestId)
      try {
        const res = obj(await this.port.call("approval.respond", { session_id: runtimeId, choice, request_id: card.requestId }));
        if (res?.resolved !== 0) return "taken";
        if (this.port.inHermesQueue(card.requestId)) return "stale";
      } catch (e) {
        if (!(e instanceof CapabilityUnsupportedError) && !(e instanceof RpcError && e.code === NO_SUCH_METHOD)) throw e;
      }
    await this.port.reply(card.id, { choice, all: false });
    return "taken";
  }

  openRequests(runtimeId: string): Promise<readonly unknown[] | undefined> {
    // Past any event Hermes numbered, so it replays none. The app's own check, not a screen's request (`observe`).
    return this.port.call(
      "session.events.since",
      { session_id: runtimeId, last_seen: Number.MAX_SAFE_INTEGER },
      {
        observe: false,
        read: (res) => {
          const open = obj(res)?.open_requests;
          return Array.isArray(open) ? open : undefined;
        },
      },
    );
  }

  edit<E extends SessionEdit>(runtimeId: string, e: E): Promise<EditAnswer<E>> {
    return LEGACY_EDITS[e.op](this.port, runtimeId, e as never) as Promise<EditAnswer<E>>;
  }

  info(runtimeId: string): Promise<unknown> {
    return this.port.call("session.status", { session_id: runtimeId });
  }

  approvalProbe(name: string): Promise<unknown> {
    return this.port.call("approval.respond", { session_id: name, request_id: name, choice: "deny" }, { observe: false });
  }
}

type EditTable = { [K in SessionEdit["op"]]: (port: Port, runtimeId: string, e: Extract<SessionEdit, { op: K }>) => Promise<EditAnswers[K]> };

const LEGACY_EDITS: EditTable = {
  rename: (port, session_id, { title }) => port.call("session.title", { session_id, title }),
  folder: (port, session_id, { profile, cwd }) => port.call("session.cwd.set", { session_id, profile, cwd }) as Promise<{ cwd?: unknown } | undefined>,
  branch: (port, session_id, { count, key, name }) => port.call("session.branch", { session_id, count, ...(name && { name }), idempotency_key: key }) as Promise<BranchAnswer>,
  undo: (port, session_id) => port.call("session.undo", { session_id }),
  compact: (port, session_id) => port.call("session.compress", { session_id }),
  // Every write names the chat's session: without one, Hermes writes the key to the profile's config. Given a session
  // it no longer holds, it refuses rather than falling back (`_SESSION_SCOPED_KEYS`).
  model: (port, session_id, { profile, pick, confirmed }) =>
    port.call(
      "config.set",
      { session_id, profile, key: "model", value: `${pick.model} --provider ${pick.provider} --session`, ...(confirmed ? { confirm_expensive_model: true } : {}) },
      {
        read: (answer) => {
          const res = answer as { confirm_required?: boolean; confirm_message?: string } | undefined;
          return { confirmRequired: !!res?.confirm_required, confirmMessage: res?.confirm_message };
        },
      },
    ),
};

/**
 * Whether a delta is the end of a resume's in-flight text, by its stamp: the turn's first segment, ending where the
 * text ends. The in-flight text joins every segment with no bounds, and a delta without stamps can't be told from a
 * repeated word, so either is kept.
 */
export function echoesInflight(inflight: string, p: Record<string, unknown>): boolean {
  const { text, segment, offset } = p;
  if (typeof text !== "string" || !text || segment !== 0 || typeof offset !== "number" || !Number.isInteger(offset)) return false;
  return offset + text.length === inflight.length && inflight.endsWith(text);
}
