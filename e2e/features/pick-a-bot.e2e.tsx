import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { BOT_CHAT_TITLE } from "../../src/hermes/bots";
import { PICK_MARK } from "../../src/hermes/mentionPicker";
import { row, type FakeHermes } from "../../src/hermes/fakeHermes";
import { boot, shot } from "../harness";

const seed = (s: FakeHermes) => {
  s.sessions = [row("disk", 0.5, { pinned: true, title: "Disk usage" })];
  s.otherProfiles = { scribe: [row("scribe-bot", 0.01, { title: BOT_CHAT_TITLE, hidden: true })] };
  s.transcripts = {
    disk: [
      { role: "user", text: "Which disk is nearly full?", row_id: 1 },
      { role: "assistant", text: "The backup disk is at 91 percent.", row_id: 2 },
    ],
    "scribe-bot": [],
  };
  s.profileMeta = { scribe: { description: "Fake bot: writes release notes", ui_meta: { "hermes-bots": { title: "Scribe", color: "#44aa77" } } } };
};

async function inChat() {
  const { app, server } = await boot({ seed });
  await app.getByRole("button", { name: /Disk usage/ }).click();
  await expect.element(app.getByText("The backup disk is at 91 percent.")).toBeVisible();
  const composer = app.getByPlaceholder("Message Hermes");
  const box = () => composer.element() as HTMLTextAreaElement;
  return { app, server, composer, box };
}

async function pickScribe(s: Awaited<ReturnType<typeof inChat>>) {
  await s.composer.click();
  await userEvent.keyboard("@scr");
  await expect.element(s.app.getByRole("option", { name: /Scribe/ })).toBeVisible();
  await shot("menu");
  await userEvent.keyboard("{Tab}");
  await expect.element(s.composer).toHaveValue(`@${PICK_MARK}scribe `);
}

const everything = (server: FakeHermes) => JSON.stringify([server.requests, server.restRequests]);

it("steps the caret one visible character at a time across a picked @scribe, as across a typed one", async () => {
  const s = await inChat();
  await pickScribe(s);
  await expect.element(s.app.getByText("@scribe", { exact: true })).toBeVisible();
  await shot("picked");
  expect(s.box().selectionStart).toBe(`@${PICK_MARK}scribe `.length);

  await userEvent.keyboard("{ArrowLeft}");
  expect(s.box().selectionStart, "one step over the space").toBe(`@${PICK_MARK}scribe`.length);
  let steps = 0;
  while (s.box().selectionStart! > 0 && steps < 20) {
    await userEvent.keyboard("{ArrowLeft}");
    steps++;
  }
  expect(steps, "ArrowLeft presses to cross @scribe: its visible characters").toBe("@scribe".length);

  await s.composer.clear();
  await userEvent.keyboard("@scribe");
  let typed = 0;
  while (s.box().selectionStart! > 0 && typed < 20) {
    await userEvent.keyboard("{ArrowLeft}");
    typed++;
  }
  expect(typed, "the same for @scribe typed in full").toBe(steps);
});

it("takes the pill and its mark out with one Backspace, and Undo brings back a pill that still asks", async () => {
  const s = await inChat();
  await pickScribe(s);
  await userEvent.keyboard("{Backspace}");
  await expect.element(s.composer).toHaveValue("");
  await shot("removed");

  await userEvent.keyboard("{Control>}z{/Control}");
  await expect.element(s.composer).toHaveValue(`@${PICK_MARK}scribe `);
  await userEvent.keyboard("what do you think?");
  await expect.element(s.app.getByRole("button", { name: /^Referenced chat Disk usage, summary ready/ })).toBeVisible();
  await userEvent.keyboard("{Enter}");

  await expect.poll(() => s.server.requests.filter((r) => r.method === "prompt.submit").length, { message: "the one ask" }).toBe(1);
  const [submit] = s.server.requests.filter((r) => r.method === "prompt.submit");
  expect(submit.params.profile, "the ask goes to Scribe's Bot Chat, not this chat's bot").toBe("scribe");
  expect(String(submit.params.text)).toContain("@scribe what do you think?");
  expect(everything(s.server), "Hermes never gets the pick mark").not.toContain(PICK_MARK);
  await expect.element(s.app.getByText("Asked @scribe")).toBeVisible();
  await shot("asked");
});

it("sends a typed @scribe to this chat's own bot as plain words", async () => {
  const s = await inChat();
  await s.composer.click();
  await userEvent.keyboard("What did @scribe write about the disks?");
  await expect.element(s.app.getByRole("button", { name: /^Referenced chat/ })).not.toBeInTheDocument();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => s.server.requests.filter((r) => r.method === "prompt.submit").length).toBe(1);
  const [submit] = s.server.requests.filter((r) => r.method === "prompt.submit");
  expect(submit.params.profile).toBe("default");
  expect(submit.params.text).toBe("What did @scribe write about the disks?");
});
