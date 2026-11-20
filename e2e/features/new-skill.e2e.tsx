import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import type { FakeHermes } from "../../src/hermes/fakeHermes";
import { APPEARANCE_KEY } from "../../src/ui/appearance";
import { boot, shot } from "../harness";

const SKILLS = "/home/lena/.hermes/skills";
const skill = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\nversion: 0.1.0\n---\n\n${body}`;
const TRIAGE = skill(
  "triage",
  "Sort a new support ticket by area and urgency.",
  "## When to Use\n\n- A new ticket arrives in the support queue.\n\n## Procedure\n\n1. Read the ticket and any linked logs.\n2. Tag the area: billing, sign-in or sync.\n3. Mark it urgent when a paying customer is blocked.\n",
);

const seed = (s: FakeHermes) => {
  s.skills.add(
    "default",
    { dir: `${SKILLS}/writing/release-notes`, source: "agent", category: "writing" },
    skill("release-notes", "Write release notes from merged PRs.", "Follow the house style.\n"),
  );
  s.skills.add("default", { dir: `${SKILLS}/github`, source: "bundled" }, skill("github", "Work with GitHub through gh.", "Use gh.\n"));
};

async function openNewSkill(scheme: "dark" | "light") {
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ scheme }));
  const { app, server } = await boot({ seed });
  await app.getByPlaceholder("Message Hermes").click();
  await userEvent.keyboard("{Control>},{/Control}");
  await app.getByRole("tab", { name: /Skills/ }).click();
  await app.getByRole("button", { name: "New skill" }).click();
  const form = app.getByRole("group", { name: "New skill" });
  return { app, server, form, name: form.getByRole("textbox", { name: "Name" }), text: form.getByRole("textbox", { name: "SKILL.md" }) };
}

describe.each(["dark", "light"] as const)("in the %s theme", (scheme) => {
  it("writes a skill by hand: Hermes creates it, the list shows it on, and the composer runs it as /triage", async () => {
    const { app, server, form, name, text } = await openNewSkill(scheme);
    await name.fill("triage");
    await expect
      .poll(() => (text.element() as HTMLTextAreaElement).value, { message: "the front matter name follows the name typed" })
      .toMatch(/^---\nname: triage\ndescription: \n/);
    await expect.element(form.getByText(/Write the description after description:/)).toBeVisible();
    await shot(`${scheme}-draft-seeded`);

    await form.getByRole("combobox", { name: /Category/ }).fill("support");
    await text.fill(TRIAGE);
    await shot(`${scheme}-draft-ready`);
    await form.getByRole("button", { name: "Create skill" }).click();
    await expect.element(app.getByText(/^Created triage at .*support\/triage\/SKILL\.md, and read back from Hermes\./)).toBeVisible();
    await expect.element(app.getByRole("switch", { name: "triage" })).toHaveAttribute("aria-checked", "true");
    await shot(`${scheme}-created`);

    const posts = server.restRequests.filter((r) => r.method === "POST" && r.path === "/api/skills").map((r) => [r.query.get("profile"), r.body]);
    expect(posts, "what New skill sent Hermes").toEqual([["default", { name: "triage", content: TRIAGE, category: "support" }]]);

    await app.getByRole("button", { name: "Back to chat" }).click();
    await app.getByPlaceholder("Message Hermes").click();
    await userEvent.keyboard("/tri");
    await expect.element(app.getByRole("listbox", { name: "Commands" }).getByRole("option", { name: /\/triage/ })).toBeVisible();
    await shot(`${scheme}-composer`);
  });

  it("shows Hermes's refusal of a name the profile has, and keeps the draft", async () => {
    const { server, form, name, text } = await openNewSkill(scheme);
    await name.fill("github");
    await text.fill(skill("github", "My own GitHub steps.", "Open a PR with gh pr create.\n"));
    await form.getByRole("button", { name: "Create skill" }).click();
    await expect
      .element(form.getByRole("alert"))
      .toHaveTextContent(`Hermes didn't create it: Hermes said: A skill named 'github' already exists at ${SKILLS}/github. Your draft is still here.`);
    await expect.element(text).toHaveValue(skill("github", "My own GitHub steps.", "Open a PR with gh pr create.\n"));
    await shot(`${scheme}-refused`);
    expect(server.skills.file(`${SKILLS}/github`), "the existing skill is untouched").toContain("Work with GitHub through gh.");
  });
});
