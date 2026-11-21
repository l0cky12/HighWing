import { describe, expect, it } from "vitest";
import type { RunId, TaskDetail, TaskRun } from "./kanban";
import { taskCall, taskLines, workLists, type TaskRead } from "./taskCard";

const ARGS = { title: "Audit the backups", assignee: "researcher" };
const MADE = JSON.stringify({ ok: true, task_id: "t_1", status: "ready", workspace_kind: "scratch", workspace_path: null, project_id: null, gated: false, subscribed: true });
const call = (result?: string, args: Record<string, unknown> = ARGS) => taskCall({ name: "kanban_create", status: result === undefined ? "running" : "done", args, ...(result !== undefined && { result }) })!;

const run = (id: number, fields: Partial<TaskRun> = {}): TaskRun => ({ id: id as RunId, profile: "researcher", startedAt: 1_000 * id, ...fields });
function detail(fields: Partial<TaskDetail["task"]> = {}, more: Partial<TaskDetail> = {}): TaskDetail {
  return {
    task: { id: "t_1", title: "Audit the backups", body: "", assignee: "researcher", status: "ready", priority: 0, comments: 0, links: { parents: 0, children: 0 }, ...fields },
    comments: [],
    links: { parents: [], children: [] },
    linked: [],
    runs: [],
    ...more,
  };
}
const read = (d: TaskDetail, at = 99_000): TaskRead => ({ kind: "read", at, detail: d });
const kinds = (r?: TaskRead, c = call(MADE)) => taskLines(c, r).map((l) => l.kind);

describe("a kanban_create call", () => {
  it("is read from Hermes's answer: the task, where it landed, what it waits on, and whether this chat is subscribed", () => {
    expect(call(MADE)).toEqual({ title: "Audit the backups", assignee: "researcher", ack: { kind: "made", taskId: "t_1", landed: "ready", subscribed: true } });
    const gated = JSON.stringify({ ok: true, task_id: "t_2", status: "todo", gated: true, gated_by: "t_1", subscribed: false });
    expect(call(gated, { ...ARGS, board: "ops" }).ack).toEqual({ kind: "made", taskId: "t_2", landed: "todo", gatedBy: "t_1", subscribed: false });
    expect(call(gated, { ...ARGS, board: "ops" }).board).toBe("ops");
  });

  it("keeps Hermes's refusal, and makes no card for another tool or for a call stopped before Hermes answered", () => {
    expect(call(JSON.stringify({ error: "assignee is required" })).ack).toEqual({ kind: "refused", why: "assignee is required" });
    expect(call().ack).toBeUndefined();
    expect(taskCall({ name: "kanban_show", status: "done", args: { task_id: "t_1" }, result: "{}" })).toBeUndefined();
    expect(taskCall({ name: "kanban_create", status: "stopped", args: ARGS })).toBeUndefined();
  });
});

describe("a task card's lines", () => {
  it("say nothing before Hermes answers, nor for a refusal, whose heading says it", () => {
    expect(kinds(undefined, call())).toEqual([]);
    expect(kinds(undefined, call(JSON.stringify({ error: "no" })))).toEqual([]);
  });

  it("say what the answer said, and that the task hasn't been read yet", () => {
    expect(taskLines(call(MADE), undefined)).toEqual([{ kind: "created", assignee: "researcher", landed: "ready" }, { kind: "subscribed", yes: true }, { kind: "unread" }]);
  });

  it("keep a task no worker has claimed apart from one a run of is open", () => {
    const status = (d: TaskDetail) => taskLines(call(MADE), read(d)).find((l) => l.kind === "status");
    expect(status(detail({ status: "running" }))).toEqual({ kind: "status", status: "running", claimed: false });
    expect(status(detail({ status: "running" }, { runs: [run(1)] }))).toEqual({ kind: "status", status: "running", claimed: true });
    expect(status(detail({ status: "ready" }, { runs: [run(1, { ended: { at: 5_000, outcome: "reclaimed" } })] }))).toEqual({ kind: "status", status: "ready", claimed: false });
  });

  it("give an open run's heartbeat, which says only that it was alive, and an ended run's outcome", () => {
    const lines = taskLines(call(MADE), read(detail({ status: "running" }, { runs: [run(1, { heartbeatAt: 2_500, ended: { at: 3_000, outcome: "crashed" } }), run(2, { heartbeatAt: 4_000 })] })));
    expect(lines.filter((l) => l.kind === "run")).toEqual([
      { kind: "run", profile: "researcher", startedAt: 1_000, ended: { at: 3_000, outcome: "crashed" } },
      { kind: "run", profile: "researcher", startedAt: 2_000, heartbeatAt: 4_000 },
    ]);
  });

  it("give a blocked task's reason, and a finished task's recorded summary, never a success", () => {
    const blocked = taskLines(call(MADE), read(detail({ status: "blocked", summary: "Needs the NAS password." })));
    expect(blocked.find((l) => l.kind === "status")).toEqual({ kind: "status", status: "blocked", claimed: false, reason: "Needs the NAS password." });
    const done = taskLines(call(MADE), read(detail({ status: "done", summary: "short", result: "The share is read-only.\nRemounted it." })));
    expect(done.filter((l) => l.kind === "status" || l.kind === "summary")).toEqual([
      { kind: "status", status: "done", claimed: false },
      { kind: "summary", text: "The share is read-only. Remounted it." },
    ]);
  });

  it("show the latest three runs and comments, with each comment's author and time, and count the rest", () => {
    const comments = [1, 2, 3, 4, 5].map((n) => ({ id: n, author: n === 5 ? "researcher" : "owner", body: `note ${n}`, at: n * 100 }));
    const lines = taskLines(call(MADE), read(detail({ status: "running" }, { runs: [1, 2, 3, 4].map((n) => run(n, { ended: { at: n * 1_500, outcome: "reclaimed" } })), comments })));
    expect(lines.filter((l) => l.kind === "earlier")).toEqual([
      { kind: "earlier", of: "runs", count: 1 },
      { kind: "earlier", of: "comments", count: 2 },
    ]);
    expect(lines.filter((l) => l.kind === "run").map((l) => l.kind === "run" && l.startedAt)).toEqual([2_000, 3_000, 4_000]);
    expect(lines.filter((l) => l.kind === "comment").at(-1)).toEqual({ kind: "comment", author: "researcher", at: 500, text: "note 5" });
  });

  it("end with when they were read, so an old read reads as old", () => {
    expect(taskLines(call(MADE), read(detail(), 42_000)).at(-1)).toEqual({ kind: "readAt", at: 42_000 });
  });

  it("say a gone task is gone, on the board the call named, and nothing more about it", () => {
    const c = call(MADE, { ...ARGS, board: "ops" });
    expect(taskLines(c, { kind: "gone", at: 7_000 }).slice(-2)).toEqual([
      { kind: "gone", board: "ops" },
      { kind: "readAt", at: 7_000 },
    ]);
  });

  it("keep the last read when a read fails, and say it failed", () => {
    const failed: TaskRead = { kind: "failed", at: 9_000, why: "The dashboard answered 502", last: { at: 5_000, detail: detail({ status: "running" }, { runs: [run(1)] }) } };
    expect(kinds(failed)).toEqual(["created", "subscribed", "status", "run", "readAt", "readFailed"]);
    expect(taskLines(call(MADE), failed).find((l) => l.kind === "readAt")).toEqual({ kind: "readAt", at: 5_000 });
    expect(kinds({ kind: "failed", at: 9_000, why: "offline" })).toEqual(["created", "subscribed", "readFailed"]);
  });

  it("are the same for the same call and read", () => {
    const r = read(detail({ status: "review", summary: "Ready for a look." }, { runs: [run(1, { ended: { at: 3_000, outcome: "review_requested" } })] }));
    expect(taskLines(call(MADE), r)).toEqual(taskLines(call(MADE), r));
  });
});

describe("Open in Work", () => {
  it("shows only for a task the Work page lists: on Hermes's current board, and not archived or gone", () => {
    expect(workLists(call(MADE), read(detail()), "default")).toBe(true);
    expect(workLists(call(MADE), undefined, undefined)).toBe(true);
    expect(workLists(call(MADE, { ...ARGS, board: "default" }), read(detail()), "default")).toBe(true);
    expect(workLists(call(MADE, { ...ARGS, board: "ops" }), read(detail()), "default")).toBe(false);
    expect(workLists(call(MADE, { ...ARGS, board: "ops" }), read(detail()), undefined)).toBe(false);
    expect(workLists(call(MADE), read(detail({ status: "archived" })), "default")).toBe(false);
    expect(workLists(call(MADE), { kind: "failed", at: 1, why: "offline", last: { at: 0, detail: detail({ status: "archived" }) } }, "default")).toBe(false);
    expect(workLists(call(MADE), { kind: "gone", at: 1 }, "default")).toBe(false);
  });
});
