import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { BOT_CHAT_TITLE } from "../../src/hermes/bots";
import type { FakeTurn, TurnContext } from "../../src/hermes/fakeGroups";
import { row, type FakeHermes } from "../../src/hermes/fakeHermes";
import { ARM_MS } from "../../src/ui/ApprovalCard";
import { boot, shot } from "../harness";

const BOTS = { ada: "#f59e0b", bram: "#3b82f6", cleo: "#a855f7", dov: "#10b981" };
const title = (profile: string) => profile[0].toUpperCase() + profile.slice(1);
const pingpong = (t: TurnContext): FakeTurn => ({ say: `${t.name} here, pingpong. @${t.handles[t.index === 0 ? 1 : 0]} your turn.` });

const seed = (script?: (t: TurnContext) => FakeTurn, room = true) => (s: FakeHermes) => {
  s.sessions = [row("backup", 0.4, { pinned: true, title: "Nightly backup failing" })];
  s.otherProfiles = Object.fromEntries(Object.keys(BOTS).map((p, i) => [p, [row(`${p}-bot`, i + 1, { title: BOT_CHAT_TITLE, hidden: true })]]));
  s.profileMeta = Object.fromEntries(Object.entries(BOTS).map(([p, color]) => [p, { ui_meta: { "hermes-bots": { title: title(p), color } } }]));
  if (script) s.groups.script = script;
  if (room) s.groups.seed({ id: "crew", name: "Launch crew", members: ["ada", "bram", "cleo"].map((profile) => ({ profile, name: title(profile) })) });
};

async function start(script?: (t: TurnContext) => FakeTurn, room = true) {
  const { app, server } = await boot({ seed: seed(script, room) });
  const panel = app.getByRole("complementary");
  await panel.getByRole("tab", { name: /^Bots/ }).click();
  await expect.element(panel.getByRole("button", { name: "New room" }), { timeout: 15_000 }).toBeVisible();
  const pane = app.getByRole("region", { name: /^Group room / });
  const strip = pane.getByRole("status", { name: "Whose move it is" });
  const box = pane.getByRole("combobox", { name: "Message the room" });
  const say = async (text: string) => {
    await box.fill(text);
    await userEvent.keyboard("{Enter}");
  };
  const open = async () => {
    await panel.getByRole("button", { name: /^Launch crew\. Group room/ }).click();
    await expect.element(pane).toBeVisible();
  };
  const replies = () => server.groups.log("crew").filter((e) => e.kind === "message.member").length;
  return { app, server, panel, pane, strip, box, say, open, replies };
}

it("makes a room of three bots in pick order and opens it", async () => {
  const { app, server, panel, pane } = await start(undefined, false);
  await panel.getByRole("button", { name: "New room" }).click();
  const dialog = app.getByRole("dialog", { name: "New group room" });
  for (const bot of ["Ada", "Bram", "Cleo"]) await dialog.getByRole("checkbox", { name: bot, exact: true }).click();
  await expect.element(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("Ada, Bram and Cleo");
  await expect.element(dialog.getByText("3 of 6")).toBeVisible();
  await expect.element(dialog.getByRole("checkbox", { name: "Bram, answers number 2" })).toBeChecked();
  await shot("picking");

  await dialog.getByRole("button", { name: "Create room" }).click();
  await expect.element(pane).toBeVisible();
  await expect.element(pane.getByText("Ada, Bram and Cleo")).toBeVisible();
  await expect.poll(() => server.groups.calls.filter((c) => c.method === "groups.create").map((c) => (c.params.members as { profile: string }[]).map((m) => m.profile)), { message: "the roster Hermes got" }).toEqual([["ada", "bram", "cleo"]]);
  await expect.element(panel.getByRole("button", { name: /^Ada, Bram and Cleo\. Group room/ })).toBeVisible();
  expect(server.groups.calls.some((c) => c.method === "groups.capabilities"), "the call that writes a file on the server was never sent").toBe(false);
  await shot("created");
});

it("shows the bots taking turns, one whole reply at a time", async () => {
  const { server, pane, strip, say, open } = await start(pingpong);
  await open();
  await say("pingpong please");
  await expect.element(pane.getByText("pingpong please")).toBeVisible();
  server.groups.begin("crew");
  await expect.element(strip.getByText("Ada is writing · round 1 · next: Bram, Cleo")).toBeVisible();
  await shot("ada-writing");
  server.groups.step("crew");
  server.groups.step("crew");
  server.groups.begin("crew");
  await expect.element(strip.getByText("Cleo is writing · round 1")).toBeVisible();
  await expect.element(pane.getByText("Bram here, pingpong. @ada your turn.")).toBeVisible();
  for (let i = 0; i < 3; i++) server.groups.step("crew");
  await expect.element(pane.getByText("Round 2")).toBeVisible();
  await shot("round-two");
});

it("steps in: the queued turn is cancelled and the bots answer the owner first", async () => {
  const { server, pane, box, say, open, replies } = await start(pingpong);
  await open();
  await say("pingpong");
  for (let i = 0; i < 5; i++) server.groups.step("crew");
  await expect.element(pane.getByText("Round 2")).toBeVisible();
  await expect.element(box).toHaveAttribute("placeholder", "Step in: the bots stop and answer you first");
  await say("Owner here, stepping in");
  await expect.element(pane.getByText("Ada's turn was cancelled: you stepped in.")).toBeVisible();
  const before = replies();
  server.groups.step("crew");
  await expect.poll(replies, { message: "Ada answers the owner's message" }).toBe(before + 1);
  expect(server.groups.log("crew").at(-2)?.payload.round_index, "in a new discussion's first round").toBe(0);
  await shot("stepped-in");
});

it("pauses after three rounds, and goes on when the owner presses Continue", async () => {
  const { server, pane, strip, say, open } = await start(pingpong);
  await open();
  await say("pingpong");
  server.groups.settle("crew");
  await expect.element(strip.getByText("Paused after 3 rounds.")).toBeVisible();
  await shot("paused");
  await strip.getByRole("button", { name: "Continue (5 left)" }).click();
  await expect.poll(() => server.groups.calls.filter((c) => c.method === "groups.continue").length, { message: "Continue reached Hermes" }).toBe(1);
  server.groups.settle("crew");
  await expect.element(strip.getByText("Paused after 6 rounds.")).toBeVisible();
  await expect.element(pane.getByText("Round 6")).toBeVisible();
});

it("asks the owner to approve a bot's command, and the bot goes on once approved", async () => {
  const asks = (t: TurnContext): FakeTurn => (t.member === "bram" ? { approval: { command: "rm -rf /srv/tmp/build-cache", description: "delete in root path" }, then: "Bram ran it: the build cache is gone." } : { say: `${t.name} here.` });
  const { server, panel, pane, strip, say, open } = await start(asks);
  await open();
  await say("Bram, clear the build cache");
  server.groups.step("crew");
  server.groups.step("crew");
  const card = strip.getByRole("group", { name: "Bram wants to run a command" });
  await expect.element(card.getByText("rm -rf /srv/tmp/build-cache")).toBeVisible();
  await expect.element(strip.getByText("Cleo waits behind this.")).toBeVisible();
  await expect.element(panel.getByRole("button", { name: /Bram needs your approval/ })).toBeVisible();
  await shot("approval");
  await new Promise((resolve) => setTimeout(resolve, ARM_MS + 50));
  await card.getByRole("button", { name: "Approve once" }).click();
  await expect.poll(() => server.groups.calls.filter((c) => c.method === "groups.approve").map((c) => c.params.choice), { message: "the answer Hermes got" }).toEqual(["once"]);
  await expect.element(pane.getByText("Bram ran it: the build cache is gone.")).toBeVisible();
});
