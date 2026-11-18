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

/**
 * What Hermes answered a `message_agent` call with, when the tool item holds it. History leaves most tool results out.
 * `failed`: for a message to several teammates, each one Hermes couldn't send to, with its reason.
 */
export type SendAck = { kind: "queued"; deliveryId: string; to: string; failed?: string } | { kind: "refused"; why: string };

/** One `message_agent` call in the sender's chat. `to`: Hermes's own label once it has answered, else `@` and each target. */
export type AgentSend = { to: string; text: string; ack?: SendAck };

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

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
  if (text(answer.error)) return { kind: "refused", why: text(answer.error) };
  if (Array.isArray(answer.fan_out)) {
    const each = answer.fan_out.filter(isObj);
    const failed = each.filter((e) => text(e.error)).map((e) => `${text(e.to)}: ${text(e.error)}`).join("\n");
    const sent = each.filter((e) => !text(e.error) && text(e.delivery_id));
    if (!sent.length) return { kind: "refused", why: failed || text(answer.detail) };
    return { kind: "queued", deliveryId: sent.map((e) => text(e.delivery_id)).join(","), to: sent.map((e) => text(e.to)).join(", "), ...(failed && { failed }) };
  }
  return text(answer.delivery_id) && text(answer.to) ? { kind: "queued", deliveryId: text(answer.delivery_id), to: text(answer.to) } : undefined;
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
  return { to: ack?.kind === "queued" ? ack.to : targets.map((t) => `@${t}`).join(", "), text: message, ...(ack && { ack }) };
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
