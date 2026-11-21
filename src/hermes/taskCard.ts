import { KANBAN_STATUSES, type KanbanStatus } from "./dispatched";
import type { TaskDetail } from "./kanban";
import { isObj } from "./values";
// A dispatched Kanban task's card (ADR 0248): what the `kanban_create` call's stored row and the latest read of the
// task say about it, and nothing else. No line is saved; the same call and the same read always give the same lines.

/** Hermes's name for the tool (`tools/kanban_tools.py` at 0.23.2). */
const KANBAN_CREATE_TOOL = "kanban_create";

/**
 * What Hermes answered a `kanban_create` call with (`_handle_create`). `made`: the task it created. `landed`: the
 * status Hermes put it in, which routing may change from the one asked for. `gatedBy`: the parent it waits on.
 * `subscribed`: whether Hermes subscribed this chat to the task's completion and block (`_maybe_auto_subscribe`).
 * `refused`: Hermes's error; no task was made.
 */
export type CreateAck = { kind: "made"; taskId: string; landed?: KanbanStatus; gatedBy?: string; subscribed?: boolean } | { kind: "refused"; why: string };

/** One `kanban_create` call. `board`: as the call named it; none means the board Hermes had current then. */
export type TaskCall = { title: string; assignee?: string; board?: string; ack?: CreateAck };

/**
 * The latest read of the task from Hermes (`GET tasks/{id}`), kept in memory only. `at`: when it was read.
 * `gone`: Hermes answered that it has no such task. `failed`: the read failed, with the read before it, if any.
 */
export type TaskRead = { kind: "read"; at: number; detail: TaskDetail } | { kind: "gone"; at: number } | { kind: "failed"; at: number; why: string; last?: { at: number; detail: TaskDetail } };

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const isStatus = (v: unknown): v is KanbanStatus => (KANBAN_STATUSES as readonly unknown[]).includes(v);

function ackOf(result: string | undefined): CreateAck | undefined {
  let r: unknown;
  try {
    r = result ? JSON.parse(result) : undefined;
  } catch {
    return undefined;
  }
  if (!isObj(r)) return undefined;
  if (r.ok !== true) return text(r.error) ? { kind: "refused", why: text(r.error) } : undefined;
  const taskId = text(r.task_id);
  if (!taskId) return undefined;
  return {
    kind: "made",
    taskId,
    ...(isStatus(r.status) && { landed: r.status }),
    ...(r.gated === true && text(r.gated_by) && { gatedBy: text(r.gated_by) }),
    ...(typeof r.subscribed === "boolean" && { subscribed: r.subscribed }),
  };
}

/** The task a tool call creates, or undefined for any other call, or one stopped before Hermes answered. */
export function taskCall(tool: { name: string; status: string; args?: Record<string, unknown>; result?: string }): TaskCall | undefined {
  if (tool.name !== KANBAN_CREATE_TOOL || tool.status === "stopped") return undefined;
  const ack = ackOf(tool.result);
  const assignee = text(tool.args?.assignee).replace(/^@/, "");
  const board = text(tool.args?.board);
  return { title: text(tool.args?.title), ...(assignee && { assignee }), ...(board && { board }), ...(ack && { ack }) };
}

/** A done, archived or gone task is read once, not polled. */
export const readIsFinal = (r: TaskRead | undefined) => r?.kind === "gone" || (r?.kind === "read" && (r.detail.task.status === "done" || r.detail.task.status === "archived"));

/**
 * Whether the Work page lists the task, so Open in Work can show its sheet: Work shows Hermes's current board
 * (`currentBoard`), without archived tasks.
 */
export function workLists(call: TaskCall, read: TaskRead | undefined, currentBoard: string | undefined): boolean {
  const last = read?.kind === "read" ? read.detail : read?.kind === "failed" ? read.last?.detail : undefined;
  return read?.kind !== "gone" && last?.task.status !== "archived" && (!call.board || call.board === currentBoard);
}

/** How many of the latest runs and comments the card shows. The rest are counted, and shown in Work. */
export const SHOWN = 3;
/** A summary, block reason or comment is cut to this many characters on the card; Work shows all of it. */
const SUMMARY_MAX = 300;

const excerpt = (s: string, max: number) => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * One line of a task's card. Each comes from one thing Hermes sent or stores, and says no more than it:
 * - `created` / `gated` / `subscribed`: the call's ack, true when Hermes answered and never updated.
 * - `unread`: nothing has been read of the task yet.
 * - `status`: the task's status, as last read. `claimed`: a run of it is open now. `reason`: a blocked task's
 *   latest summary, which is the reason the block gave.
 * - `run`: one task run, from its row. `heartbeatAt` says the worker was alive then, not how far it got.
 * - `summary`: what the task's completion recorded, for a task in review or done. It is the worker's own word.
 * - `comment`: a comment on the task, by its author, at its time.
 * - `earlier`: runs or comments not shown, which Work shows.
 * - `gone`: Hermes answered that it has no such task.
 * - `readFailed`: the latest read failed; the lines above are from the one before.
 * - `readAt`: when the lines above were read, so an old read reads as old.
 */
export type TaskLine =
  | { kind: "created"; assignee?: string; board?: string; landed?: KanbanStatus }
  | { kind: "gated"; by: string }
  | { kind: "subscribed"; yes: boolean }
  | { kind: "unread" }
  | { kind: "status"; status: string; claimed: boolean; reason?: string }
  | { kind: "run"; profile: string; startedAt?: number; heartbeatAt?: number; ended?: { at: number; outcome: string } }
  | { kind: "summary"; text: string }
  | { kind: "comment"; author: string; at: number; text: string }
  | { kind: "earlier"; of: "runs" | "comments"; count: number }
  | { kind: "gone"; board?: string }
  | { kind: "readFailed"; why: string }
  | { kind: "readAt"; at: number };

/** The card's lines for a `kanban_create` call, from its ack and the latest read of its task. None before the ack, nor for a refusal, whose heading says it. */
export function taskLines(call: TaskCall, read: TaskRead | undefined): TaskLine[] {
  const { ack } = call;
  if (ack?.kind !== "made") return [];
  const lines: TaskLine[] = [{ kind: "created", ...(call.assignee && { assignee: call.assignee }), ...(call.board && { board: call.board }), ...(ack.landed && { landed: ack.landed }) }];
  if (ack.gatedBy) lines.push({ kind: "gated", by: ack.gatedBy });
  if (ack.subscribed !== undefined) lines.push({ kind: "subscribed", yes: ack.subscribed });
  if (read?.kind === "gone") return [...lines, { kind: "gone", ...(call.board && { board: call.board }) }, { kind: "readAt", at: read.at }];
  const last = read?.kind === "read" ? read : read?.last;
  if (last) lines.push(...detailLines(last.detail), { kind: "readAt", at: last.at });
  else if (read?.kind !== "failed") lines.push({ kind: "unread" });
  if (read?.kind === "failed") lines.push({ kind: "readFailed", why: read.why });
  return lines;
}

function detailLines({ task, runs, comments }: TaskDetail): TaskLine[] {
  const lines: TaskLine[] = [];
  const claimed = runs.some((r) => !r.ended);
  lines.push({ kind: "status", status: task.status, claimed, ...(task.status === "blocked" && task.summary && { reason: excerpt(task.summary, SUMMARY_MAX) }) });
  const said = task.result ?? task.summary;
  if ((task.status === "done" || task.status === "review") && said) lines.push({ kind: "summary", text: excerpt(said, SUMMARY_MAX) });
  if (runs.length > SHOWN) lines.push({ kind: "earlier", of: "runs", count: runs.length - SHOWN });
  for (const r of runs.slice(-SHOWN))
    lines.push({ kind: "run", profile: r.profile, ...(r.startedAt && { startedAt: r.startedAt }), ...(r.heartbeatAt && !r.ended && { heartbeatAt: r.heartbeatAt }), ...(r.ended && { ended: r.ended }) });
  if (comments.length > SHOWN) lines.push({ kind: "earlier", of: "comments", count: comments.length - SHOWN });
  for (const c of comments.slice(-SHOWN)) lines.push({ kind: "comment", author: c.author, at: c.at, text: excerpt(c.body, SUMMARY_MAX) });
  return lines;
}
