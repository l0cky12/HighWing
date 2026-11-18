import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { ARM_MS } from "../../src/ui/ApprovalCard";
import { CU, type FakeCuStep } from "../../src/hermes/fakeComputerUse";
import type { FakeHermes } from "../../src/hermes/fakeHermes";
import { boot, shot, sessionOfPrompt, type Commands } from "../harness";

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

async function computerUseChat(opts: { running?: boolean; commands?: Commands } = {}) {
  const booted = await boot({
    seed: (s) => {
      s.display = {
        status: { supported: true, installed: true, missing: [], running: opts.running ?? false, geometry: "1280x800" },
        lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 },
        minted: new Set(),
      };
      s.cuGrants.always.add("cua:key:foreground");
    },
    commands: opts.commands,
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

const idle = (ms = ARM_MS + 50) => new Promise((resolve) => setTimeout(resolve, ms));

async function askedFor(app: Awaited<ReturnType<typeof computerUseChat>>["app"], action: string) {
  const ask = app.getByRole("group", { name: `Hermes wants to ${action}` });
  await expect.element(ask).toBeVisible();
  await idle();
  return ask;
}

it("allows background clicks for the chat, asks again for a foreground one, and says so on each card", async () => {
  const { app, server, session } = await computerUseChat();
  const turn = server.computerUseTurn(session, {
    steps: [CU.click([620, 780], "background"), CU.click([640, 400], "background"), CU.click([100, 100], "foreground")],
    reply: "Clicked three times.",
  });
  const background = await askedFor(app, "click at (620, 780)");
  await expect.element(background.getByText("Background input")).toBeVisible();
  await shot("cua background");
  await background.getByRole("button", { name: "Allow background clicks for this chat…" }).click();
  await expect.element(background.getByText("The foreground version still asks.", { exact: false })).toBeVisible();
  expect(server.approvalAnswers).toEqual([]);
  await shot("cua grant confirm");
  await idle();
  await background.getByRole("button", { name: "Yes, allow for this chat" }).click();

  const foreground = await askedFor(app, "click at (100, 100)");
  await expect.element(foreground.getByText("Foreground input")).toBeVisible();
  await expect.element(foreground.getByRole("button", { name: "Allow foreground clicks for this chat…" })).toBeVisible();
  await shot("cua foreground");
  await foreground.getByRole("button", { name: "Approve once" }).click();
  await turn;
  expect(server.approvalAnswers.map((a) => a.choice)).toEqual(["session", "once"]);
  expect(app.getByRole("group").elements().filter((g) => g.classList.contains("approval"))).toHaveLength(2);
});

it("always allows foreground typing after the second step, and never asks for it again", async () => {
  const { app, server, session } = await computerUseChat();
  const turn = server.computerUseTurn(session, { steps: [CU.type("df -h /srv"), CU.type("du -sh /srv")], reply: "Typed twice." });
  const ask = await askedFor(app, "type 'df -h /srv'");
  await ask.getByRole("button", { name: "Always allow foreground typing…" }).click();
  await expect.element(ask.getByText("Always allow foreground typing?", { exact: false })).toBeVisible();
  expect(server.approvalAnswers).toEqual([]);
  await idle();
  await ask.getByRole("button", { name: "Yes, always allow" }).click();
  await turn;
  expect(server.approvalAnswers.map((a) => a.choice)).toEqual(["always"]);
  expect(server.cuGrants.always.has("cua:type:foreground")).toBe(true);
  expect(app.getByRole("group").elements().filter((g) => g.classList.contains("approval"))).toHaveLength(1);
  await expect.element(app.getByText("Typed twice.")).toBeVisible();
});

it("marks the step denied when the owner denies it", async () => {
  const { app, server, session } = await computerUseChat();
  const turn = server.computerUseTurn(session, { steps: [CU.doubleClick([640, 400], "foreground")], reply: "I left it alone." });
  const ask = await askedFor(app, "double_click at (640, 400)");
  await ask.getByRole("button", { name: "Deny" }).click();
  await turn;
  expect(server.approvalAnswers.map((a) => a.choice)).toEqual(["deny"]);
  const line = app.getByRole("listitem").elements().find((li) => li.classList.contains("cu-step"))!;
  expect(line.classList.contains("denied")).toBe(true);
  expect(line.querySelector(".cu-outcome")?.textContent).toBe("denied");
  await expect.element(app.getByText("Denied")).toBeVisible();
  await shot("cua denied");
});

/** A run on a running Bot Desktop that pauses in its third step until the returned `go` lets it on. */
async function pausedRun(opts: { commands?: Commands } = {}) {
  const booted = await computerUseChat({ running: true, ...opts });
  let go!: () => void;
  const paused = new Promise<void>((r) => (go = r));
  let n = 0;
  const turn = booted.server.computerUseTurn(booted.session, { steps: [CU.capture(), CU.key("ctrl+l"), CU.capture(), CU.capture()], reply: "never" }, () => (++n === 3 ? paused : Promise.resolve()));
  await expect.element(booted.app.getByText(/Computer use · step 3 · \d+:\d\d/)).toBeVisible();
  return { ...booted, turn, go };
}

const screenAsks = (server: FakeHermes) => server.requests.filter((r) => r.method === "display.observe" || r.method === "display.lease.acquire").map((r) => r.method);
const interrupts = (server: FakeHermes) => server.requests.filter((r) => r.method === "session.interrupt").map((r) => r.params);

it("stops a run from its card, takes the screen, and the next turn is refused until Hand back", async () => {
  const { app, server, session, turn, go } = await pausedRun();
  await shot("live counter");
  await app.getByRole("button", { name: "Stop", exact: true }).first().click();
  await expect.poll(() => screenAsks(server)).toEqual(["display.observe", "display.lease.acquire"]);
  expect(interrupts(server)).toEqual([{ session_id: session }]);
  go();
  await turn;
  await expect.element(app.getByText(/^Computer use · 3 steps · \d+:\d\d$/)).toBeVisible();
  await expect.element(app.getByText("You hold the screen")).toBeVisible();
  await expect.element(app.getByRole("button", { name: "Hand back" })).toBeVisible();
  await shot("stopped");

  await app.getByPlaceholder("Message Hermes").fill("Carry on");
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => server.last("prompt.submit")?.params.text).toBe("Carry on");
  await server.computerUseTurn(session, { steps: [CU.click([620, 780], "background")], reply: "You have the screen, so I stopped." });
  const banner = app.getByText("Hermes's computer use was refused because you hold the Bot Desktop.", { exact: false });
  await expect.element(banner).toBeVisible();
  expect(server.approvalAnswers).toEqual([]);
  await shot("human has control");

  await app.getByRole("button", { name: "Hand back" }).first().click();
  await expect.element(banner).not.toBeInTheDocument();
  expect(server.display!.lease.holder).toBe("agent");
  await expect.element(app.getByText("Hermes drives the screen").first()).toBeVisible();
  await shot("handed back");
});

it("stops a run and takes the screen on Ctrl+. from the composer", async () => {
  const { app, server, session, turn, go } = await pausedRun();
  await app.getByPlaceholder("Message Hermes").click();
  await userEvent.keyboard("{Control>}.{/Control}");
  await expect.poll(() => screenAsks(server)).toEqual(["display.observe", "display.lease.acquire"]);
  expect(interrupts(server)).toEqual([{ session_id: session }]);
  await expect.element(app.getByText("Stopped the reply using the Bot Desktop. You hold the Bot Desktop now", { exact: false })).toBeVisible();
  go();
  await turn;
  await shot("shortcut");
});

it("stops a run and takes the screen when hermes-chat --stop asks", async () => {
  let pending: number | null = null;
  const { app, server, session, turn, go, emit } = await pausedRun({
    commands: { stop_pending_request: () => pending, stop_ack_request: (args) => void (pending = pending === args.id ? null : pending) },
  });
  pending = 1;
  await emit("stop-requested");
  await expect.poll(() => screenAsks(server)).toEqual(["display.observe", "display.lease.acquire"]);
  expect(interrupts(server)).toEqual([{ session_id: session }]);
  expect(pending).toBeNull();
  await expect.element(app.getByText("Stopped the reply using the Bot Desktop.", { exact: false })).toBeVisible();
  go();
  await turn;
  await shot("desktop stop");
});
