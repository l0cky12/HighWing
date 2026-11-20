import { expect, it } from "vitest";
import { row, type FakeHermes } from "../../src/hermes/fakeHermes";
import { boot, shot } from "../harness";

const ARGS = { title: "Audit the nightly backups", assignee: "researcher" };
let taskId = "";

const seed = (s: FakeHermes) => {
  const task = s.kanban.add("default", { ...ARGS, session_id: "backup" });
  taskId = task.id;
  s.sessions = [row("backup", 0.5, { pinned: true, title: "Backup research" })];
  s.storeMessage("backup", { role: "user", text: "Have the researcher audit the nightly backups." });
  s.storeMessage("backup", { role: "assistant", text: "", tool_calls: [{ id: "call_k1", type: "function", function: { name: "kanban_create", arguments: JSON.stringify(ARGS) } }] });
  const result = { ok: true, task_id: task.id, status: "ready", workspace_kind: "scratch", workspace_path: null, project_id: null, gated: false, subscribed: true };
  s.storeMessage("backup", { role: "tool", tool_call_id: "call_k1", name: "kanban_create", args: ARGS, result: JSON.stringify(result) });
  s.storeMessage("backup", { role: "assistant", text: `Dispatched ${task.id} to the researcher.` });
};

const card = (app: Awaited<ReturnType<typeof boot>>["app"]) => app.getByRole("button", { name: "Task for @researcher: Audit the nightly backups" });

it("shows a dispatched task on the card of the call that created it, from Hermes's records, and opens it in Work", async () => {
  const { app, server } = await boot({ seed });
  await app.getByRole("button", { name: /Backup research/ }).click();
  await expect.element(card(app)).toBeVisible();
  await expect.element(app.getByText("Created for @researcher, in Ready.")).toBeVisible();
  await expect.element(app.getByText("Ready. No worker has claimed it yet.")).toBeVisible();
  await shot("unclaimed");

  server.kanban.claim(taskId);
  server.kanban.work(taskId);
  server.kanban.comment(taskId, "researcher", "The NAS share is mounted read-only, so two of three jobs fail.");
  server.kanban.move(taskId, "blocked", "Needs the NAS admin password to remount the share.");
  await expect.element(app.getByText("Blocked: Needs the NAS admin password to remount the share.")).toBeVisible();
  await expect.element(app.getByText(/^researcher commented at /)).toBeVisible();
  await expect.element(app.getByText(/^@researcher's run ended at .*: blocked\.$/)).toBeVisible();
  await shot("blocked");

  await app.getByRole("button", { name: "Open in Work" }).click();
  await expect.element(app.getByRole("dialog", { name: "Audit the nightly backups" })).toBeVisible();
  await shot("open-in-work");
});
