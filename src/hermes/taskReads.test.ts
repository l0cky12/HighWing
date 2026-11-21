import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "./kanban";
import { RestError } from "./pipe";
import { POLL_EVERY_MS as READ_EVERY_MS } from "./kanban";
import { TaskReads } from "./taskReads";

const detail = (status: string): TaskDetail => ({
  task: { id: "t_1", title: "Audit", body: "", assignee: "researcher", status, priority: 0, comments: 0, links: { parents: 0, children: 0 } },
  comments: [],
  links: { parents: [], children: [] },
  linked: [],
  runs: [],
});

function reads(answer: (id: string, board?: string) => Promise<TaskDetail>) {
  const asked: string[] = [];
  const store = new TaskReads({
    read: (id, board) => {
      asked.push(board ? `${board}/${id}` : id);
      return answer(id, board);
    },
  });
  return { store, asked };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("TaskReads", () => {
  it("reads a shown task once connected, again on the read clock, and tells the card each time", async () => {
    let status = "ready";
    const { store, asked } = reads(async () => detail(status));
    const heard = vi.fn();
    store.watch("t_1", undefined, heard);
    await settle();
    expect(asked).toEqual([]);
    store.start();
    await settle();
    expect(store.get("t_1")).toMatchObject({ kind: "read", detail: { task: { status: "ready" } } });
    status = "running";
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS);
    expect(asked).toEqual(["t_1", "t_1"]);
    expect(store.get("t_1")).toMatchObject({ kind: "read", detail: { task: { status: "running" } } });
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("reads a done task once, and a task no card shows any more not again", async () => {
    const { store, asked } = reads(async (id) => detail(id === "t_1" ? "done" : "running"));
    store.start();
    store.watch("t_1", "ops", () => {});
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS * 3);
    expect(asked).toEqual(["ops/t_1"]);
    store.watch("t_2", undefined, () => {})();
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS * 3);
    expect(asked).toEqual(["ops/t_1", "t_2"]);
  });

  it("calls a task gone only on Hermes's own answer for a task it doesn't have", async () => {
    const { store } = reads(async (id) => {
      throw id === "t_1" ? new RestError(404, JSON.stringify({ detail: "task t_1 not found" })) : new RestError(404, JSON.stringify({ detail: "Not Found" }));
    });
    store.start();
    store.watch("t_1", undefined, () => {});
    store.watch("t_2", undefined, () => {});
    await settle();
    expect(store.get("t_1")?.kind).toBe("gone");
    expect(store.get("t_2")).toMatchObject({ kind: "failed", why: expect.stringContaining("404") });
  });

  it("keeps the last read when a read fails", async () => {
    let fail = false;
    const { store } = reads(async () => {
      if (fail) throw new Error("The connection dropped.");
      return detail("running");
    });
    store.start();
    store.watch("t_1", undefined, () => {});
    await settle();
    fail = true;
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS);
    expect(store.get("t_1")).toMatchObject({ kind: "failed", why: "The connection dropped.", last: { detail: { task: { status: "running" } } } });
  });

  it("reads nothing while stopped, lands no read begun before, and forgets every read on a profile switch", async () => {
    let answer!: (d: TaskDetail) => void;
    const { store, asked } = reads(() => new Promise((r) => (answer = r)));
    store.start();
    store.watch("t_1", undefined, () => {});
    store.stop();
    answer(detail("running"));
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS);
    expect(store.get("t_1")).toBeUndefined();
    expect(asked).toEqual(["t_1"]);
    store.start();
    answer(detail("running"));
    await settle();
    expect(store.get("t_1")?.kind).toBe("read");
    store.reset();
    expect(store.get("t_1")).toBeUndefined();
  });

  it("reads a shown task at once when a status update names it", async () => {
    const { store, asked } = reads(async () => detail("blocked"));
    store.start();
    store.watch("t_1", undefined, () => {});
    await settle();
    store.nudge("⏸ [default] @researcher Kanban t_1 blocked");
    store.nudge("⏸ [default] @researcher Kanban t_9 blocked");
    await settle();
    expect(asked).toEqual(["t_1", "t_1"]);
  });
});
