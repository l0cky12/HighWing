import type { Item } from "./model";
import { isObj } from "./values";
// Bot messaging (ADR 0207): what Hermes's own `message_agent` tool leaves in a Bot Chat, read at the boundary. Hermes
// gives a display kind or a tool name for every row this module reads, and that decides what the row is
// (`returned.ts` `returnedItem`, `agentSend`). The parsers here only pull fields out of a row already classified, so
// words the owner typed are never taken for a bot's.

/** Hermes's name for the tool (`MESSAGE_AGENT_TOOL_NAME`, `tools/bot_mode_dm.py` at 0.23.2). */
const MESSAGE_AGENT_TOOL = "message_agent";

/**
 * A teammate as Hermes signs a message from one (`message_agent_tool`): `Message from 🤖 <name> (@<handle>): <text>`.
 * `name`: the bot's Bot Mode title, else its profile's display name, else its handle. `handle`: the profile's name,
 * or `hermes` for the default profile.
 */
export type Teammate = { name: string; handle: string };

const TARGET_STATES = ["idle", "working", "waiting_approval", "waiting_clarify", "paused"] as const;
/**
 * Where the teammate's Bot Chat stood when Hermes took the message: the ack's `target_state` (`gateway/session_bot_state.py`
 * at 0.23.2). It is never sent again, so it says nothing about later.
 */
export type TargetState = (typeof TARGET_STATES)[number];

/**
 * One teammate a message went to, as Hermes's ack names it. `claimed`: the ack's `status` was `claimed`, so that Bot
 * Chat's owner already held the request when Hermes answered. `notifyOnly`: no answer comes back from this one.
 * `unconfirmed`: Hermes couldn't confirm this one's admission (`status: "ambiguous"`), with its reason: it may have
 * gone, and no answer waits for it.
 */
export type Recipient = { to: string; deliveryId: string; claimed: boolean; targetState?: TargetState; notifyOnly?: boolean; unconfirmed?: string };

/**
 * What Hermes answered a `message_agent` call with (`tools/bot_mode_dm.py` at 0.23.2), when the tool item holds it:
 * live, or read back from the stored row (ADR 0228).
 * - `queued`: Hermes took it for each of `recipients`. `failed`: for a message to several teammates, each one Hermes
 *   couldn't send to, with its reason. `reply`: how the answer comes back: as a turn Hermes starts here
 *   (`notification`), only when this bot asks for it (`poll`), or not at all (`none`, sent as a notice).
 *   `replyError`: Hermes took the message but couldn't arrange for the answer to come back.
 * - `unconfirmed`: Hermes couldn't confirm the other bot's chat took it, and says not to send it again.
 * - `refused`: nothing was sent.
 */
export type SendAck =
  | { kind: "queued"; to: string; recipients: Recipient[]; failed?: string; reply: "notification" | "poll" | "none"; replyError?: string }
  | { kind: "unconfirmed"; deliveryId: string; why: string }
  | { kind: "refused"; why: string };

/**
 * One `message_agent` call in the sender's chat. `to`: Hermes's own label once it has answered, else `@` and each
 * target. `handles`: each target as the call named it, without the `@`, which the card's Open chips look up.
 */
export type AgentSend = { to: string; handles: readonly string[]; text: string; ack?: SendAck };

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const targetState = (v: unknown): TargetState | undefined => TARGET_STATES.find((s) => s === v);

/** A teammate in an ack, or in one entry of a fan-out's. */
function recipient(e: Record<string, unknown>, to: string): Recipient {
  const state = targetState(e.target_state);
  return {
    to,
    deliveryId: text(e.delivery_id),
    claimed: e.status === "claimed",
    ...(state && { targetState: state }),
    ...(e.expects_reply === false && { notifyOnly: true }),
    ...(e.status === "ambiguous" && { unconfirmed: text(e.error) }),
  };
}

function json(s: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(s);
    return isObj(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function ackOf(result: string | undefined): SendAck | undefined {
  const answer = result ? json(result) : undefined;
  if (!answer) return undefined;
  // Admission that couldn't be confirmed comes with an error, but the message may have gone (`_admit_live_dm`).
  if (answer.status === "ambiguous" && text(answer.delivery_id)) return { kind: "unconfirmed", deliveryId: text(answer.delivery_id), why: text(answer.error) };
  if (text(answer.error)) return { kind: "refused", why: text(answer.error) };
  const reply = answer.expects_reply === false ? "none" : answer.reply_delivery === "poll" ? "poll" : "notification";
  const replyError = text(answer.notification_error);
  const how = { reply, ...(replyError && { replyError }) } as const;
  if (Array.isArray(answer.fan_out)) {
    const each = answer.fan_out.filter(isObj);
    // An entry Hermes couldn't confirm carries an error too, but may have gone: it is a recipient, not a refusal.
    const went = (e: Record<string, unknown>) => !!text(e.delivery_id) && (!text(e.error) || e.status === "ambiguous");
    const failed = each.filter((e) => !went(e) && text(e.error)).map((e) => `${text(e.to)}: ${text(e.error)}`).join("\n");
    const sent = each.filter(went);
    if (!sent.length) return { kind: "refused", why: failed || text(answer.detail) };
    const recipients = sent.map((e) => recipient(e, text(e.to)));
    return { kind: "queued", to: recipients.map((r) => r.to).join(", "), recipients, ...(failed && { failed }), ...how };
  }
  const to = text(answer.to);
  return text(answer.delivery_id) && to ? { kind: "queued", to, recipients: [recipient(answer, to)], ...how } : undefined;
}

/**
 * The delivery a call withdraws, for a `message_agent` call with `cancel`, and why Hermes refused the withdrawal when
 * it did. Only the withdrawal's answer, not the request's, says whether the request was withdrawn.
 */
export function withdrawal(tool: { name: string; args?: Record<string, unknown>; result?: string }): { deliveryId: string; refused?: string } | undefined {
  const deliveryId = tool.name === MESSAGE_AGENT_TOOL ? text(tool.args?.cancel) : "";
  if (!deliveryId) return undefined;
  const why = text((tool.result ? json(tool.result) : undefined)?.error);
  return { deliveryId, ...(why && { refused: why }) };
}

/**
 * The message to a teammate a tool call is, or undefined for any other call. The tool's name decides. A call with
 * `cancel` withdraws an earlier request and stays a tool row, as does one with no target or no message, which Hermes
 * refuses, and one stopped before Hermes answered, which may have sent nothing.
 */
export function agentSend(tool: { name: string; status: string; args?: Record<string, unknown>; result?: string }): AgentSend | undefined {
  if (tool.name !== MESSAGE_AGENT_TOOL || tool.status === "stopped" || text(tool.args?.cancel)) return undefined;
  const targets = text(tool.args?.target).split(",").map((t) => t.trim().replace(/^@/, "")).filter(Boolean);
  const message = text(tool.args?.message);
  if (!targets.length || !message) return undefined;
  const ack = ackOf(tool.result);
  return { to: ack?.kind === "queued" ? ack.to : targets.map((t) => `@${t}`).join(", "), handles: targets, text: message, ...(ack && { ack }) };
}

/**
 * One line of a sent message's card (ADR 0228). Each comes from one thing Hermes sent, and none says more than it:
 * - `queued`: the ack, per teammate. `claimed` and `targetState` were true when Hermes answered, and are never updated.
 * - `notifyOnly` / `poll` / `noWayBack`: how the answer comes back, from the ack.
 * - `unconfirmed`: Hermes couldn't confirm the teammate's chat took it.
 * - `silent`: nothing between the ack and the answer reaches this chat (`_wait_live_dm` polls in silence), so the
 *   card says so, with how long ago the message went (`since`), instead of a spinner.
 * - `withdrawAsked`: a later call asked Hermes to withdraw it. Only `ended` with `cancelled` says it was withdrawn.
 * - `ended`: the Returned result that answers it, joined by delivery id only. `several`: one answer for a message to
 *   several teammates, whose `status` is only the first that didn't settle, so it isn't said of them all.
 */
export type DeliveryLine =
  | { kind: "queued"; to: string; claimed: boolean; targetState?: TargetState }
  | { kind: "notifyOnly"; to?: string }
  | { kind: "poll" }
  | { kind: "noWayBack"; why: string }
  | { kind: "unconfirmed"; why: string; to?: string }
  | { kind: "silent"; to: string; since?: number }
  | { kind: "withdrawAsked"; at?: number; refused?: string }
  | { kind: "ended"; status: DeliveryStatus; itemId: string; at?: number; several?: boolean };

/**
 * The card's lines for a sent message, from its ack and the items after its call (`later`). `at`: when the call was
 * made. Pure: the same items give the same lines, so a resume or a repeat changes nothing. Nothing is shown before the
 * ack, nor for a refused message, whose heading already says it.
 */
export function deliveryLines(send: AgentSend, later: readonly Item[], at?: number): DeliveryLine[] {
  const { ack } = send;
  if (!ack || ack.kind === "refused") return [];
  const ids = new Set(ack.kind === "queued" ? ack.recipients.map((r) => r.deliveryId) : [ack.deliveryId]);
  let answer: { status: DeliveryStatus; itemId: string; at?: number; several: boolean } | undefined;
  let asked: { at?: number; refused?: string } | undefined;
  for (const i of later) {
    if (!answer && i.kind === "returned" && i.agent?.kind === "answer" && i.agent.deliveryId.split(",").some((d) => ids.has(d))) answer = { status: i.agent.status, itemId: i.id, at: i.at, several: i.agent.deliveryId.includes(",") };
    const w = !asked && i.kind === "tool" ? withdrawal(i) : undefined;
    if (w && ids.has(w.deliveryId)) asked = { at: i.kind === "tool" ? i.at : undefined, refused: w.refused };
  }
  const lines: DeliveryLine[] = [];
  if (ack.kind === "unconfirmed") lines.push({ kind: "unconfirmed", why: ack.why });
  else {
    for (const r of ack.recipients)
      lines.push(r.unconfirmed !== undefined ? { kind: "unconfirmed", why: r.unconfirmed, to: r.to } : { kind: "queued", to: r.to, claimed: r.claimed, ...(r.targetState && { targetState: r.targetState }) });
    for (const r of ack.recipients) if (r.notifyOnly && ack.reply !== "none") lines.push({ kind: "notifyOnly", to: r.to });
    if (ack.reply === "none") lines.push({ kind: "notifyOnly" });
    else if (ack.replyError) lines.push({ kind: "noWayBack", why: ack.replyError });
    else if (ack.reply === "poll") lines.push({ kind: "poll" });
  }
  if (asked) lines.push({ kind: "withdrawAsked", ...(asked.at !== undefined && { at: asked.at }), ...(asked.refused && { refused: asked.refused }) });
  // An answer comes back only for a teammate Hermes took and that owes one.
  const owing = ack.kind === "queued" && ack.reply !== "none" && !ack.replyError ? ack.recipients.filter((r) => r.unconfirmed === undefined && !r.notifyOnly) : [];
  if (answer) lines.push({ kind: "ended", status: answer.status, itemId: answer.itemId, ...(answer.at !== undefined && { at: answer.at }), ...(answer.several && { several: true }) });
  else if (owing.length) lines.push({ kind: "silent", to: owing.map((r) => r.to).join(", "), ...(at !== undefined && { since: at }) });
  return lines;
}

const DELIVERY_STATUSES = ["settled", "cancelled", "pending", "ambiguous", "failed"] as const;
/** How a delivery ended, as its runner reports it. `pending` is Hermes's `queued`, `claimed` and `pending`. */
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export const isDeliveryStatus = (v: unknown): v is DeliveryStatus => DELIVERY_STATUSES.includes(v as DeliveryStatus);

const statusOf = (v: unknown): DeliveryStatus => (v === "queued" || v === "claimed" ? "pending" : isDeliveryStatus(v) ? v : "failed");

/**
 * The answer a delivery brought back. `outcome`: Hermes's own sentence for it (`bot_mode_dm_outcome.outcome_line`:
 * "@beta answered.", "@beta never answered: …"). `reply`: what the teammate said, when it said anything. A message
 * to several teammates comes back as one answer: `deliveryId` is then each request's id, comma-separated as the
 * targets were, `status` is the first that didn't settle, and `reply` is each teammate's under its handle.
 */
export type DeliveryAnswer = { deliveryId: string; status: DeliveryStatus; outcome: string; reply?: string };

/**
 * The delivery answer in a `process_complete` notice, or undefined for any other process. Only the JSON object the
 * delivery runners print counts: `outcome` with `delivery_id` and `status` (`_wait_live_dm`), or with `replies`,
 * `settled` and `of` (`run_fan_out`). A notice of several processes is read as the log it is.
 */
export function deliveryAnswer(notice: string): DeliveryAnswer | undefined {
  if (notice.split(/\n\n(?=\[IMPORTANT: )/).length > 1) return undefined;
  const from = notice.indexOf("\nOutput:\n");
  const open = from < 0 ? -1 : notice.indexOf("{", from);
  const out = open < 0 ? undefined : json(notice.slice(open, notice.lastIndexOf("}") + 1));
  const outcome = text(out?.outcome);
  if (!out || !outcome) return undefined;
  if (text(out.delivery_id) && typeof out.status === "string") {
    const reply = text(out.reply);
    return { deliveryId: text(out.delivery_id), status: statusOf(out.status), outcome, ...(reply && { reply }) };
  }
  if (!Array.isArray(out.replies) || typeof out.settled !== "number" || typeof out.of !== "number") return undefined;
  const each = out.replies.filter(isObj);
  const reply = each.flatMap((r) => (text(r.reply) ? [`**${text(r.to) || "?"}**\n\n${text(r.reply)}`] : [])).join("\n\n");
  const unsettled = each.find((r) => r.status !== "settled");
  return {
    deliveryId: each.map((r) => text(r.delivery_id)).filter(Boolean).join(","),
    status: unsettled ? statusOf(unsettled.status) : "settled",
    outcome,
    ...(reply && { reply }),
  };
}

/** A delivery's answer as a notice `deliveryAnswer` reads back, so an exported chat imports as the same row. */
export const answerNotice = (a: DeliveryAnswer) =>
  `[IMPORTANT: Background process completed.\nOutput:\n${JSON.stringify({ outcome: a.outcome, ...(a.reply && { reply: a.reply }), status: a.status, delivery_id: a.deliveryId })}\n]`;

const SIGNED = /^Message from 🤖 (.+?) \(@([^\s():]+)\): ([\s\S]*)$/;

/**
 * The teammate's message a row holds, or undefined when the row isn't signed as one, as a heartbeat or an
 * automation's wake isn't. Only for a row Hermes marked `internal_notification`.
 */
export function teammateMessage(row: string): { from: Teammate; text: string } | undefined {
  const m = SIGNED.exec(row.trim());
  return m ? { from: { name: m[1], handle: m[2] }, text: m[3].trim() } : undefined;
}

/** Hermes's signature on a teammate's message, rebuilt, so an exported chat imports as the same row. */
export const signed = (from: Teammate, message: string) => `Message from 🤖 ${from.name} (@${from.handle}): ${message}`;
