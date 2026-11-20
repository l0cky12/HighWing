// @vitest-environment jsdom
// A dispatched Kanban task's card (TaskCard.tsx, ADR 0248): the `kanban_create` call's answer and Hermes's latest read
// of the task, through the real transport, against the stand-in's kanban plugin.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AttachmentDesk } from "../hermes/attachmentDesk";
import { FakeHermes, row } from "../hermes/fakeHermes";
import type { Chat } from "../hermes/model";
import { POLL_EVERY_MS as READ_EVERY_MS } from "../hermes/kanban";
import { TaskReads } from "../hermes/taskReads";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { ChatPane } from "./ChatPane";
import { TaskCard, TaskCardsContext, type TaskCards } from "./TaskCard";
import { taskCall } from "../hermes/taskCard";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const card = () => document.querySelector<HTMLElement>(".msg.returned.task")!;
const lines = () => Array.from(card().querySelectorAll<HTMLElement>(".delivery li")).map((l) => l.textContent);
/** Words a card must never say: Hermes reports none of these about a task. */
const MADE_UP = /\d+ ?%|succeeded|success|progress|estimat|almost|nearly|working on/i;

describe("a dispatched task's card, in the app", () => {
  it("reads the call's answer back after a resume, follows the task, and opens it in Work", async () => {
    const server = new FakeHermes();
    const task = server.kanban.add("default", { title: "Audit the backups", assignee: "researcher", session_id: "backup" });
    const args = { title: "Audit the backups", assignee: "researcher" };
    const result = { ok: true, task_id: task.id, status: "ready", workspace_kind: "scratch", workspace_path: null, project_id: null, gated: false, subscribed: true };
    server.sessions = [row("backup", 0, { title: "Backup research" })];
    server.storeMessage("backup", { role: "user", text: "Have the researcher audit the backups." });
    server.storeMessage("backup", { role: "assistant", text: "", tool_calls: [{ id: "call_k1", type: "function", function: { name: "kanban_create", arguments: JSON.stringify(args) } }] });
    server.storeMessage("backup", { role: "tool", tool_call_id: "call_k1", name: "kanban_create", args, result: JSON.stringify(result) });
    server.storeMessage("backup", { role: "assistant", text: `Dispatched ${task.id}.` });
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "lena@tasks", url: "", username: "lena" }} onSignOut={async () => {}} />);
    await waitFor(() => expect(hermes.hasListed()).toBe(true));
    const user = userEvent.setup();
    const chatRow = () => document.querySelector<HTMLElement>('.row-open[data-chat="backup"]');
    await user.click(await screen.findByRole("button", { name: /^Archived\d/ }));
    await waitFor(() => expect(chatRow()).toBeTruthy());
    await user.click(chatRow()!);

    await waitFor(() => expect(card()?.dataset.task).toBe(task.id));
    expect(within(card()).getByText("Task for @researcher: Audit the backups")).toBeTruthy();
    await waitFor(() => expect(lines()).toContain("Ready. No worker has claimed it yet."));
    expect(lines().slice(0, 2)).toEqual(["Created for @researcher, in Ready.", "Hermes tells this chat when it's done or blocked."]);

    server.kanban.claim(task.id);
    server.kanban.comment(task.id, "researcher", "The NAS share is mounted read-only.");
    await act(async () => void server.kanban.move(task.id, "blocked", "Needs the NAS admin password."));
    await waitFor(() => expect(lines()).toContain("Blocked: Needs the NAS admin password."));
    expect(lines().find((l) => l?.startsWith("@researcher's run ended at"))).toMatch(/: blocked\.$/);
    expect(lines().find((l) => l?.startsWith("researcher commented at"))).toMatch(/: The NAS share is mounted read-only\.$/);
    expect(lines().at(-1)).toBe("Read from Hermes just now.");
    expect(card().textContent).not.toMatch(MADE_UP);

    await user.click(within(card()).getByRole("button", { name: "Open in Work" }));
    expect(await screen.findByRole("dialog", { name: "Audit the backups" })).toBeTruthy();
  });
});

describe("a dispatched task's card, as Hermes moves the task", () => {
  async function dispatched() {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    const id = await hermes.newChat();
    await hermes.send(id, "dispatch Audit the backups");
    const chat = () => hermes.getSnapshot().chats.find((c) => c.id === id)!;
    await waitFor(() => expect(chat().running).toBeFalsy());
    const task = server.kanban.boards.default.tasks[0];
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const reads = new TaskReads({ read: (taskId, board) => hermes.kanban.loadTask(taskId, board) });
    reads.start();
    const el = (c: Chat, cards: TaskCards) => (
      <TaskCardsContext value={cards}>
        <ChatPane
          chat={c}
          status="connected"
          draft=""
          draftKey="draft"
          desk={new AttachmentDesk({ discard: async () => {} })}
          onDraft={() => {}}
          onDraftStep={() => undefined}
          onRetry={() => {}}
          onEdit={() => {}}
          onDismiss={() => {}}
          onAttach={async () => ({ attachments: [], refused: [] })}
          onSend={() => {}}
          onStop={() => {}}
          onAnswer={() => {}}
          onQuestion={() => {}}
        />
      </TaskCardsContext>
    );
    render(el(chat(), { reads }));
    const tick = () => act(async () => void (await vi.advanceTimersByTimeAsync(READ_EVERY_MS)));
    return { server, task, tick, reads };
  }

  it("says no worker has claimed it until a run starts, then gives the run and its heartbeat as liveness only", async () => {
    const { server, task, tick } = await dispatched();
    await waitFor(() => expect(lines()).toContain("Ready. No worker has claimed it yet."));
    expect(within(card()).queryByRole("button", { name: "Open in Work" })).toBeNull();

    server.kanban.claim(task.id);
    await tick();
    await waitFor(() => expect(lines()).toContain("Running."));
    expect(lines().find((l) => l?.startsWith("@researcher started a run at"))).toBeTruthy();
    expect(lines().join("\n")).not.toContain("heartbeat");

    server.kanban.work(task.id);
    await tick();
    await waitFor(() => expect(lines().find((l) => l?.includes("Last heartbeat just now."))).toContain("A heartbeat says the worker is alive, not how far it got."));
    expect(card().textContent).not.toMatch(MADE_UP);
  });

  it("says done as the board says it, with the summary recorded, and reads a done task no more", async () => {
    const { server, task, tick } = await dispatched();
    server.kanban.claim(task.id);
    server.kanban.move(task.id, "done", "Two of three backups fail: the share is read-only.");
    await tick();
    await waitFor(() => expect(lines()).toContain("Marked done."));
    expect(lines()).toContain("Summary recorded: Two of three backups fail: the share is read-only.");
    expect(lines().find((l) => l?.startsWith("@researcher's run ended at"))).toMatch(/: completed\.$/);
    expect(card().textContent).not.toMatch(MADE_UP);

    const reads = () => server.restRequests.filter((r) => r.method === "GET" && r.path === `/api/plugins/kanban/tasks/${task.id}`).length;
    const before = reads();
    await tick();
    await tick();
    expect(reads()).toBe(before);
  });

  it("says Hermes no longer has a deleted task, and nothing else about it", async () => {
    const { server, task, tick } = await dispatched();
    await waitFor(() => expect(lines()).toContain("Ready. No worker has claimed it yet."));
    server.kanban.remove(task.id);
    await tick();
    await waitFor(() => expect(lines()).toContain("Hermes's current board has no task with this id now. It may have been deleted, or be on another board."));
    expect(lines()).not.toContain("Ready. No worker has claimed it yet.");
  });
});

describe("Open in Work on a task card", () => {
  it("shows for a done task on a named board once Hermes's current board is read as that board", async () => {
    const reads = new TaskReads({
      read: async () => ({
        task: { id: "t_9", title: "Rotate keys", body: "", assignee: "ops", status: "done", priority: 0, comments: 0, links: { parents: 0, children: 0 } },
        comments: [],
        links: { parents: [], children: [] },
        linked: [],
        runs: [],
      }),
    });
    reads.start();
    const args = { title: "Rotate keys", assignee: "ops", board: "infra" };
    const tool = { kind: "tool" as const, id: "i1", callId: "c1", name: "kanban_create", status: "done" as const, args, result: JSON.stringify({ ok: true, task_id: "t_9", status: "ready" }), at: 0 };
    render(
      <TaskCardsContext value={{ reads, openInWork: () => {} }}>
        <TaskCard tool={tool} call={taskCall(tool)!} />
      </TaskCardsContext>,
    );
    await waitFor(() => expect(lines()).toContain("Marked done."));
    const button = () => within(card()).queryByRole("button", { name: "Open in Work" });
    expect(button()).toBeNull();
    act(() => reads.setCurrentBoard("default"));
    expect(button()).toBeNull();
    act(() => reads.setCurrentBoard("infra"));
    expect(button()).toBeTruthy();
    reads.stop();
  });
});
