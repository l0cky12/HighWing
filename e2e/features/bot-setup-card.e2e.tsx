import { userEvent } from "vitest/browser";
import { expect, it } from "vitest";
import { BOT_PICTURE_DATA } from "../../src/hermes/botPictures";
import { BOT_SETUP_FENCE, botSetupBrief, type BotSetupNewBlock } from "../../src/hermes/botSetupBrief";
import { botSetupBegin } from "../../src/hermes/botSetupStart";
import { BOT_CHAT_TITLE } from "../../src/hermes/bots";
import { row, type FakeHermes, type TranscriptMessage } from "../../src/hermes/fakeHermes";
import { APPEARANCE_KEY } from "../../src/ui/appearance";
import { boot, settled, shot } from "../harness";

const ID = "c0ffee00-0000-4000-8000-000000000007";
const BLOCK: BotSetupNewBlock = {
  v: 1,
  persona:
    "You are Hermes, a practical travel planner. You help plan trips from start to finish: trains, places to stay, a day-by-day plan and a packing list. Compare options side by side with price and travel time.\n\nNever book, buy or pay for anything, and never ask for passport or card numbers. Check with the owner before you email anyone.",
  description: "Plans trips: trains, places to stay and day plans.",
  model: null,
  color: "teal",
  picture: "plane",
  callOwner: "Lena",
  skills: [
    { name: "recipes", on: true },
    { name: "flight-tracker", on: true },
  ],
  toolsets: [
    { name: "computer_use", on: true },
    { name: "terminal", on: false },
  ],
  mcp: [],
  copy: [],
};
const card = `Thanks, Lena. Here's how I'd set myself up. Untick anything you don't want, or tell me what to change.\n\n\`\`\`${BOT_SETUP_FENCE}\n${JSON.stringify(BLOCK)}\n\`\`\``;

const seed = (s: FakeHermes) => {
  s.health = { ...s.health, version: "0.23.2", displayVersion: "0.23.2" };
  s.status = { ...s.status, version: "0.23.2" };
  s.sessions = [row("hermes-bot", 0.01, { title: BOT_CHAT_TITLE, hidden: true })];
  s.transcripts = {
    "hermes-bot": (
      [
      { role: "user", text: botSetupBrief({ id: ID, name: "Hermes", inventory: { models: [], skills: [], toolsets: [], bots: [] } }), display_kind: "hidden" },
      { role: "user", text: botSetupBegin(ID), display_kind: "hidden" },
      { role: "assistant", text: "Hi, I'm Hermes. Before I set myself up, I have five quick questions.\n\n**What should I call you?**" },
      { role: "user", text: "Lena" },
      { role: "assistant", text: "Nice to meet you, Lena.\n\n**What do you want me to help with?**" },
      { role: "user", text: "Planning trips by train, and places to stay." },
      { role: "assistant", text: card },
      ] satisfies TranscriptMessage[]
    ).map((m, i) => ({ ...m, row_id: i + 1 })),
  };
  s.souls.default = "You are Hermes.";
  s.profileModel.default = { model: "claude-sonnet-4-5", provider: "anthropic", reasoning_effort: "medium", fast: false };
  s.profileMeta = { default: { description: "Helps with anything.", ui_meta: { "hermes-bots": { title: "Hermes" } } } };
  s.uiMetaRevisions.default = { "hermes-bots": 1 };
  for (const name of ["notes", "recipes"])
    s.skills.add("default", { dir: `/home/owner/.hermes/skills/${name}`, source: "bundled" }, `---\nname: ${name}\ndescription: The ${name} skill\n---\nDo ${name}.\n`);
  s.skills.disabled.default = new Set(["recipes"]);
  // Skill changes are refused until the test lifts it, so Set it up shows one failed item.
  s.skills.toggleRefusal = { status: 400, detail: "Skill changes are locked on this server." };
};

/** A photo wider than it is tall: its left half red, its right half blue. */
async function photo(): Promise<File> {
  const canvas = Object.assign(document.createElement("canvas"), { width: 800, height: 600 });
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#d02020";
  ctx.fillRect(0, 0, 400, 600);
  ctx.fillStyle = "#2040d0";
  ctx.fillRect(400, 0, 400, 600);
  const blob = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), "image/jpeg"));
  return new File([blob], "holiday.jpg", { type: "image/jpeg" });
}

/** A picture's size, and whether each of its left and right edges is more red than blue. */
async function seen(dataUrl: string) {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const canvas = Object.assign(document.createElement("canvas"), { width: image.naturalWidth, height: image.naturalHeight });
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(image, 0, 0);
  const red = (x: number) => {
    const [r, , b] = ctx.getImageData(x, image.naturalHeight / 2, 1, 1).data;
    return r > b;
  };
  return { type: dataUrl.slice(0, dataUrl.indexOf(",")), width: image.naturalWidth, height: image.naturalHeight, leftRed: red(8), rightRed: red(image.naturalWidth - 8) };
}

async function setUp(scheme: "dark" | "light") {
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ scheme }));
  const { app, server } = await boot({ seed });
  const panel = app.getByRole("complementary");
  await panel.getByRole("tab", { name: /^Bots/ }).click();
  await panel.getByRole("button", { name: /^Hermes\b/ }).first().click();
  const shown = app.getByRole("region", { name: "About Hermes" });
  await expect.element(shown).toBeVisible();
  await expect.element(app.getByText("Setup started")).toBeVisible();
  await expect.element(app.getByText("8 changes. Nothing changes until you press Set it up.")).toBeVisible();
  shown.element().closest(".msg.returned")!.scrollIntoView({ block: "start" });
  await shot(`${scheme}-before`);

  // The bot's pick is ticked with why, over the set as a strip. A pick by keyboard replaces it, and the bot's goes back.
  const strip = app.getByRole("radiogroup", { name: "Pictures" });
  await expect.element(app.getByText("For travel and trips.")).toBeVisible();
  await expect.element(strip.getByRole("radio", { name: "Plane, Hermes's pick" })).toBeChecked();
  strip.element().scrollIntoView({ block: "center" });
  await shot(`${scheme}-picture`);
  // The radio itself is hidden under its picture, which takes the click.
  await strip.getByRole("radio", { name: "Plane, Hermes's pick" }).click({ force: true });
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(strip.getByRole("radio", { name: "Moon" })).toBeChecked();
  await expect.element(app.getByText("For evenings, sleep and quiet thinking.")).toBeVisible();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(strip.getByRole("radio", { name: "Plane, Hermes's pick" })).toBeChecked();

  // Then their own photo: Upload your own… opens the picture picker on its Upload tab.
  await app.getByRole("button", { name: "Upload your own…" }).click();
  const picker = app.getByRole("dialog", { name: "Choose a picture" });
  await expect.element(picker.getByRole("tab", { name: "Upload" })).toHaveAttribute("aria-selected", "true");
  await expect.element(picker.getByText("Drag, drop, or paste an image")).toBeVisible();
  await settled(picker);
  await shot(`${scheme}-picker-upload`);
  await picker.getByRole("tab", { name: "Pictures" }).click();
  await expect.element(picker.getByRole("radio", { name: "Plane" })).toHaveAttribute("aria-checked", "true");
  expect(picker.getByRole("radio").elements()).toHaveLength(12);
  await settled(picker);
  await shot(`${scheme}-picker-pictures`);
  await picker.getByRole("tab", { name: "Upload" }).click();
  await userEvent.upload(picker.getByLabelText("Browse files"), await photo());

  // The crop step: zoomed all the way in and dragged to the right, the frame holds only the photo's red half.
  const crop = app.getByRole("dialog", { name: "Fit the picture to the circle" });
  const frame = crop.getByRole("group", { name: /^Drag to move the picture/ });
  await expect.element(frame).toBeVisible();
  await settled(crop);
  await shot(`${scheme}-picker-crop`);
  crop.getByLabelText("Zoom").element().focus();
  await userEvent.keyboard("{End}");
  await expect.element(crop.getByLabelText("Zoom")).toHaveValue("4");
  await userEvent.dragAndDrop(frame, frame, { sourcePosition: { x: 10, y: 100 }, targetPosition: { x: 190, y: 100 } });
  await settled(crop);
  await shot(`${scheme}-picker-crop-moved`);
  await crop.getByRole("button", { name: "Use picture" }).click();
  await expect.element(crop).not.toBeInTheDocument();
  await expect.element(strip.getByRole("radio", { name: "Your picture" })).toBeChecked();
  await expect.element(strip.getByRole("radio", { name: "Plane, Hermes's pick" })).not.toBeChecked();
  await shot(`${scheme}-picture-own`);

  await app.getByRole("button", { name: "Set it up", exact: true }).click();
  await expect.element(app.getByRole("button", { name: "Apply anyway" })).toBeVisible();
  await expect.element(app.getByText(/Skill changes are locked on this server\./)).toBeVisible();
  app.getByRole("region", { name: "Skills" }).element().scrollIntoView({ block: "center" });
  await shot(`${scheme}-during`);
  expect(server.souls.default).toBe(BLOCK.persona);
  expect(server.profileMeta.default.description).toBe(BLOCK.description);
  const saved = server.requests.filter((r) => r.method === "profiles.set_asset").map((r) => r.params);
  expect(saved.map(({ name, asset }) => ({ name, asset }))).toEqual([{ name: "default", asset: "avatar" }]);
  expect(server.botAvatars.default).toBe(saved[0].data);
  expect(Object.values(BOT_PICTURE_DATA)).not.toContain(saved[0].data);
  expect(await seen(String(saved[0].data))).toEqual({ type: "data:image/png;base64", width: 256, height: 256, leftRed: true, rightRed: true });
  expect(server.profileMeta.default.ui_meta?.["hermes-bots"]).toMatchObject({ custom: true, imageKind: "photo" });

  server.skills.toggleRefusal = undefined;
  await app.getByRole("button", { name: "Try again" }).click();
  await app.getByRole("button", { name: "Apply anyway" }).click();
  await expect.poll(() => server.enabledToolsets("default").has("computer_use")).toBe(true);

  // The bot answers the hidden ready turn, saving the owner's name with its memory tool.
  const ready = server.requests.find((r) => r.method === "prompt.submit" && String(r.params.text).startsWith("[highwing:bot-setup ready"));
  expect(ready?.params.display_kind).toBe("hidden");
  const sid = String(ready!.params.session_id);
  server.memory.default = { memory: [], profile: ["The owner wants to be called Lena."] };
  server.event(sid, "message.start");
  server.event(sid, "message.delta", { text: "I'm set up, Lena. Ask me to plan a trip whenever you like." });
  server.storeMessage("hermes-bot", { role: "assistant", text: "I'm set up, Lena. Ask me to plan a trip whenever you like." });
  server.event(sid, "message.complete", { status: "complete" });
  await expect.element(app.getByText("Hermes already remembers it.")).toBeVisible();
  await expect.element(app.getByText("7 of 7 applied and read back.")).toBeVisible();
  // The chat was resumed before the ready turn, and Hermes rebuilds a Bot Chat's agent only from its second turn on.
  await expect.element(app.getByText("Restart not confirmed yet: Hermes's chat doesn't list its new tools.")).toBeVisible();
  shown.element().closest(".msg.returned")!.scrollIntoView({ block: "start" });
  await shot(`${scheme}-after`);
  app.getByRole("button", { name: "Set it up", exact: true }).element().scrollIntoView({ block: "end" });
  await shot(`${scheme}-after-restart`);
}

it("draws the card, sets up what's ticked with Try again and Apply anyway, then reads it back, in the dark theme", () => setUp("dark"));
it("does the same in the light theme", () => setUp("light"));
