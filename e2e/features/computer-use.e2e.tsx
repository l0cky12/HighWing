import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { ARM_MS } from "../../src/ui/ApprovalCard";
import { CU, type FakeCuStep } from "../../src/hermes/fakeComputerUse";
import { boot, shot, sessionOfPrompt } from "../harness";

const STEPS: FakeCuStep[] = [
  CU.capture(),
  CU.click([620, 780], "background"),
  CU.capture("xfce4-terminal", "Xfce4-terminal", "Terminal - lena@hermes: ~"),
  ...Array.from({ length: 4 }, (_, i) => [CU.key(`ctrl+${i}`), CU.wait(1), CU.capture("xfce4-terminal", "Xfce4-terminal", "Terminal - lena@hermes: ~")]).flat(),
  CU.key("return"),
  CU.wait(1),
  CU.capture(),
  CU.key("alt+f4"),
  CU.capture(),
];

async function computerUseChat() {
  const booted = await boot({
    seed: (s) => {
      s.display = { status: { supported: true, installed: true, missing: [], running: false, geometry: "1280x800" }, lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 }, minted: new Set() };
      s.cuGrants.always.add("cua:key:foreground");
    },
  });
  await booted.app.getByPlaceholder("Message Hermes").fill("Use the Bot Desktop to check /srv");
  await userEvent.keyboard("{Enter}");
  return { ...booted, session: await sessionOfPrompt(booted.server, "Use the Bot Desktop to check /srv") };
}

it("reads a 20-step computer_use turn as one card with a line per action, and Watch live opens the Screen", async () => {
  const { app, server, session } = await computerUseChat();
  expect(STEPS).toHaveLength(20);
  const turn = server.computerUseTurn(session, { steps: STEPS, reply: "/srv is 92% full." });
  const ask = app.getByRole("group", { name: "Hermes wants to click at (620, 780)" });
  await expect.element(ask).toBeVisible();
  await new Promise((resolve) => setTimeout(resolve, ARM_MS + 50));
  await shot("asking");
  await ask.getByRole("button", { name: "Approve once" }).click();
  await turn;

  const card = app.getByRole("button", { name: /^Computer use · 20 steps/ });
  await expect.element(card).toBeVisible();
  await expect.element(app.getByText("/srv is 92% full.")).toBeVisible();
  const lines = app.getByRole("listitem").elements().filter((li) => li.classList.contains("cu-step"));
  expect(lines.map((li) => li.querySelector(".cu-action")?.textContent)).toEqual(STEPS.map((s) => (s.args.action === "click" ? "click at (620, 780)" : s.args.action === "key" ? `key '${String(s.args.keys)}'` : s.args.action === "wait" ? "wait 1s" : "capture")));
  expect(app.getByRole("button", { name: /^Computer use/ }).elements()).toHaveLength(1);
  expect(app.getByRole("button", { name: /^computer_use/ }).elements(), "no generic tool rows").toEqual([]);
  expect(server.approvalAnswers.map((a) => a.choice)).toEqual(["once"]);
  await shot("one card");

  await app.getByRole("button", { name: "Watch live" }).click();
  await expect.element(app.getByRole("tab", { name: /Screen/, selected: true })).toBeVisible();
  await shot("watching");
});

it("says above the composer when Hermes was refused because someone else holds the screen", async () => {
  const { app, server, session } = await computerUseChat();
  server.display!.lease = { holder: "human", viewer_hash: "0123456789ab", since: 2, epoch: 1 };
  await server.computerUseTurn(session, { steps: [CU.capture(), CU.scroll("down", 3, "foreground")], reply: "Someone has the screen, so I stopped." });
  await expect.element(app.getByText("Hermes's computer use was refused because someone else holds the Bot Desktop.", { exact: false })).toBeVisible();
  expect(server.approvalAnswers).toEqual([]);
  await expect.element(app.getByText("refused: a person holds the screen").first()).toBeVisible();
  await shot("refused");

  server.display!.lease = { holder: "agent", viewer_hash: null, since: 3, epoch: 2 };
  server.broadcast("display.lease", { profile_key: "/home/lena/.hermes", lease: server.display!.lease });
  await expect.element(app.getByText("Hermes's computer use was refused", { exact: false })).not.toBeInTheDocument();
});
