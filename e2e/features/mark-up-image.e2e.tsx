// Mark up a staged image (issue #32, ADR 0225): draw a box on a pasted, dropped or picked image, add a note, and send
// the marked copy to Hermes with the note in the message words.
import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { row, type FakeHermes } from "../../src/hermes/fakeHermes";
import { boot, shot, sessionOfPrompt } from "../harness";

const seed = (s: FakeHermes) => {
  s.sessions = [row("settings", 0.1, { pinned: true, title: "Settings page layout" })];
  s.transcripts = {
    settings: [
      { role: "user", text: "The settings page looks off." },
      { role: "assistant", text: "Paste a screenshot and show me where." },
    ],
  };
};

const appDocument = () => document.querySelector<HTMLIFrameElement>("iframe[title=Highwing]")!.contentDocument!;
const composerText = () => appDocument().querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;
const stagedNames = () => [...appDocument().querySelectorAll(".composer .chips .chip-name")].map((c) => c.textContent);

const FILL = [192, 57, 43];
const BLUE = [37, 99, 235];

/** A `width` × `height` image of one colour, as a screenshot of a plain page is. */
async function plainImage(width: number, height: number, type = "image/png"): Promise<Blob> {
  const canvas = Object.assign(document.createElement("canvas"), { width, height });
  const g = canvas.getContext("2d")!;
  g.fillStyle = `rgb(${FILL.join(",")})`;
  g.fillRect(0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b!), type, 0.95));
}

/** Pastes files into the composer, as Ctrl+V does with a screenshot on the clipboard. */
function paste(...files: File[]) {
  const data = new DataTransfer();
  for (const f of files) data.items.add(f);
  composerText().dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}

/** Drops files on the chat pane, as Windows hands a drop from another app to the page. */
function drop(...files: File[]) {
  const data = new DataTransfer();
  for (const f of files) data.items.add(f);
  appDocument().querySelector(".chat")!.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
}

/** Drags across the Mark up image from one point to another, each a fraction of its width and height. */
async function dragBox(from: [number, number], to: [number, number]) {
  const stage = appDocument().querySelector<HTMLElement>(".markup-stage")!;
  await expect.poll(() => stage.getAttribute("aria-busy"), { message: "the image to mark is drawn" }).toBe("false");
  const r = stage.getBoundingClientRect();
  const at = ([fx, fy]: [number, number]) => ({ clientX: r.left + r.width * fx, clientY: r.top + r.height * fy });
  const fire = (type: string, p: { clientX: number; clientY: number }) =>
    stage.dispatchEvent(new PointerEvent(type, { ...p, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, pointerType: "mouse", bubbles: true }));
  fire("pointerdown", at(from));
  for (let i = 1; i <= 4; i++) fire("pointermove", at([from[0] + ((to[0] - from[0]) * i) / 4, from[1] + ((to[1] - from[1]) * i) / 4]));
  fire("pointerup", at(to));
}

/** The colour at (x, y) of the image in `base64`, as Hermes would decode it. */
async function pixel(base64: string, x: number, y: number): Promise<number[]> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const canvas = Object.assign(document.createElement("canvas"), { width: bitmap.width, height: bitmap.height });
  const g = canvas.getContext("2d")!;
  g.drawImage(bitmap, 0, 0);
  return [...g.getImageData(x, y, 1, 1).data.slice(0, 3)];
}
/** Expects the colour at (x, y) of the image in `base64` to be `want`, give or take `slack` in each channel. */
async function expectColour(base64: string, x: number, y: number, want: number[], why: string, slack = 2) {
  const got = await pixel(base64, x, y);
  expect(got.every((v, i) => Math.abs(v - want[i]) <= slack), `${why}: rgb(${got}) at ${x}, ${y}`).toBe(true);
}

it("draws a box on a pasted screenshot, puts the note in the words, and sends the marked image to Hermes", async () => {
  const { app, server } = await boot({ seed });

  await app.getByRole("button", { name: /Settings page layout/ }).click();
  await expect.element(app.getByText("Paste a screenshot and show me where.")).toBeVisible();
  const composer = app.getByPlaceholder("Message Hermes");
  await composer.click();
  await composer.fill("Here is the page.");
  paste(new File([await plainImage(400, 240)], "image.png", { type: "image/png" }));
  await expect.element(app.getByRole("button", { name: /^Mark up clipboard-/ }), { message: "a pasted screenshot offers Mark up" }).toBeVisible();
  const pasted = Object.keys(server.files).find((p) => p.includes("/captures/"))!;
  const pastedName = pasted.split("/").pop()!;

  await app.getByRole("button", { name: `Mark up ${pastedName}` }).click();
  await expect.element(app.getByRole("dialog", { name: `Mark up ${pastedName}` })).toBeVisible();
  await expect.element(app.getByRole("button", { name: "Add to message" }), { message: "nothing to add before a box is drawn" }).toBeDisabled();
  await shot("dialog");
  await dragBox([0.25, 0.25], [0.75, 0.75]);
  const note = app.getByRole("textbox", { name: "Note for box 1" });
  await expect.element(note, { message: "the note takes the keyboard once the box is drawn" }).toHaveFocus();
  await note.fill("This header sits too low");
  await shot("box and note");
  await userEvent.keyboard("{Enter}");

  await expect.element(app.getByRole("dialog"), { message: "Enter in the note adds it" }).not.toBeInTheDocument();
  await expect.poll(() => composerText().value, { message: "the note goes in the words, naming the box and the image" }).toBe(
    `Here is the page.\nBox 1 on ${pastedName}: This header sits too low\n`,
  );
  expect(appDocument().activeElement, "the words take the keyboard again").toBe(composerText());
  expect(stagedNames(), "the marked copy takes the original's place").toEqual([pastedName]);
  expect(server.files[pasted], "the pasted original is deleted, as the app made it").toBeUndefined();
  await shot("added");

  await userEvent.keyboard("{Enter}");
  await sessionOfPrompt(server, `Here is the page.\nBox 1 on ${pastedName}: This header sits too low`);
  const upload = server.last("image.attach_bytes")!;
  expect(upload.params.filename, "Hermes gets the image under its name").toBe(pastedName);
  const sent = String(upload.params.content_base64);
  await expectColour(sent, 101, 120, BLUE, "blue along the box's left edge");
  await expectColour(sent, 200, 120, FILL, "the image unchanged inside the box");
  await expectColour(sent, 20, 20, FILL, "and outside it");
  await shot("sent");
});

it("leaves the image as it was on Cancel, and never changes the owner's own file", async () => {
  const own = "/home/owner/Pictures/rack.jpg";
  const jpeg = await plainImage(320, 200, "image/jpeg");
  const original = String.fromCharCode(...new Uint8Array(await jpeg.arrayBuffer()));
  const { app, server } = await boot({
    seed: (s) => {
      seed(s);
      s.files[own] = original;
    },
    commands: { attach_picked_files: () => [own] },
  });

  await app.getByRole("button", { name: /Settings page layout/ }).click();
  await expect.element(app.getByText("Paste a screenshot and show me where.")).toBeVisible();
  await app.getByRole("button", { name: "Attach files" }).click();
  const markUp = app.getByRole("button", { name: "Mark up rack.jpg" });
  await expect.element(markUp, { message: "a picked photo offers Mark up once its thumbnail shows" }).toBeVisible();

  await markUp.click();
  await dragBox([0.1, 0.1], [0.5, 0.5]);
  await app.getByRole("textbox", { name: "Note for box 1" }).fill("Not this one");
  await app.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.element(app.getByRole("dialog")).not.toBeInTheDocument();
  expect(composerText().value, "Cancel adds no words").toBe("");
  expect(stagedNames(), "Cancel keeps the original staged").toEqual(["rack.jpg"]);
  expect(Object.keys(server.files).filter((p) => p.includes("/captures/")), "Cancel stages nothing").toEqual([]);

  await markUp.click();
  await dragBox([0.5, 0.5], [0.9, 0.9]);
  await app.getByRole("textbox", { name: "Note for box 1" }).fill("The cable is unplugged");
  await app.getByRole("button", { name: "Add to message" }).click();
  await expect.poll(() => composerText().value).toBe("Box 1 on rack.jpg: The cable is unplugged\n");
  expect(server.files[own], "the owner's file is never changed or deleted").toBe(original);

  await app.getByRole("button", { name: "Mark up rack.jpg" }).click();
  await expect.element(app.getByText("Draw a box, then say what it is about."), { message: "a new Mark up starts with no box" }).toBeVisible();
  await dragBox([0.05, 0.05], [0.3, 0.3]);
  await app.getByRole("textbox", { name: "Note for box 2" }).fill("And the label");
  await app.getByRole("button", { name: "Add to message" }).click();
  await expect.poll(() => composerText().value, { message: "marking it again numbers the next box" }).toBe(
    "Box 1 on rack.jpg: The cable is unplugged\nBox 2 on rack.jpg: And the label\n",
  );
  await shot("marked twice");

  await userEvent.keyboard("{Enter}");
  await sessionOfPrompt(server, "Box 1 on rack.jpg: The cable is unplugged\nBox 2 on rack.jpg: And the label");
  const upload = server.last("image.attach_bytes")!;
  expect(upload.params.filename, "a photo stays a JPEG").toBe("rack.jpg");
  const sent = String(upload.params.content_base64);
  expect(atob(sent).slice(0, 3), "JPEG bytes").toBe("\xff\xd8\xff");
  // JPEG blurs a 3-pixel line's colour into its neighbours, so a box's edge is clearly blue rather than exactly.
  const blue = async (x: number, y: number) => {
    const [r, , b] = await pixel(sent, x, y);
    return b - r;
  };
  expect(await blue(161, 140), "both boxes are drawn: the first's left edge").toBeGreaterThan(80);
  expect(await blue(17, 40), "and the second's").toBeGreaterThan(80);
  await expectColour(sent, 220, 60, FILL, "the photo itself unchanged", 12);
  expect(server.files[own], "still the owner's file, unchanged, after sending").toBe(original);
});

it("keeps a later image's mark in the words when it is marked up", async () => {
  const { app } = await boot({ seed });

  await app.getByRole("button", { name: /Settings page layout/ }).click();
  await expect.element(app.getByText("Paste a screenshot and show me where.")).toBeVisible();
  const composer = app.getByPlaceholder("Message Hermes");
  await composer.click();
  paste(new File([await plainImage(200, 120)], "image.png", { type: "image/png" }));
  await expect.poll(stagedNames).toHaveLength(1);
  await composer.fill("Compare with ");
  drop(new File([await plainImage(160, 100)], "image.png", { type: "image/png" }));
  await expect.poll(() => composerText().value, { message: "the dropped image is marked at the cursor" }).toBe("Compare with [image 2: image.png]");

  await app.getByRole("button", { name: "Mark up image.png" }).click();
  await dragBox([0.2, 0.2], [0.8, 0.8]);
  await app.getByRole("textbox", { name: "Note for box 1" }).fill("the same header");
  await app.getByRole("button", { name: "Add to message" }).click();
  await expect.poll(() => composerText().value, { message: "the mark still names image 2, and the note follows it" }).toBe(
    "Compare with [image 2: image.png]\nBox 1 on image.png: the same header\n",
  );
  expect(stagedNames(), "the dropped image keeps its place, second").toEqual([expect.stringMatching(/^clipboard-/), "image.png"]);
  await shot("second image marked");
});

it("changes nothing when the owner switches chats while the marked image is being added", async () => {
  let hold: Promise<void> | undefined;
  let letGo = () => {};
  let staged = 0;
  const { app, server } = await boot({
    seed: (s) => {
      seed(s);
      s.sessions.push(row("dns", 1, { pinned: true, title: "DNS records" }));
      s.transcripts.dns = [{ role: "user", text: "Check the DNS records." }, { role: "assistant", text: "They resolve." }];
    },
    commands: {
      // As the harness stages a file, after `hold` lets it.
      stage_clipboard_file: async (bytes, headers) => {
        await hold;
        staged++;
        const path = `/home/owner/.cache/highwing/captures/${Object.keys(server.files).length}/${decodeURIComponent(headers?.["x-name"] ?? "")}`;
        server.files[path] = Array.from(new Uint8Array(bytes as unknown as ArrayBuffer), (b) => String.fromCharCode(b)).join("");
        return path;
      },
    },
  });

  await app.getByRole("button", { name: /Settings page layout/ }).click();
  await expect.element(app.getByText("Paste a screenshot and show me where.")).toBeVisible();
  const composer = app.getByPlaceholder("Message Hermes");
  await composer.click();
  paste(new File([await plainImage(200, 120)], "image.png", { type: "image/png" }));
  await expect.element(app.getByRole("button", { name: /^Mark up clipboard-/ })).toBeVisible();
  const pasted = Object.keys(server.files).find((p) => p.includes("/captures/"))!;

  await app.getByRole("button", { name: /^Mark up clipboard-/ }).click();
  await dragBox([0.2, 0.2], [0.8, 0.8]);
  await app.getByRole("textbox", { name: "Note for box 1" }).fill("too late");
  hold = new Promise((r) => (letGo = r));
  await app.getByRole("button", { name: "Add to message" }).click();
  await expect.element(app.getByRole("button", { name: "Adding…" })).toBeVisible();
  await app.getByRole("button", { name: /DNS records/ }).click();
  await expect.element(app.getByText("They resolve.")).toBeVisible();
  letGo();
  const captures = () => Object.keys(server.files).filter((p) => p.includes("/captures/"));
  await expect.poll(() => staged, { message: "the copy was staged" }).toBe(2);
  await expect.poll(() => captures().join("\n"), { message: "and, staged too late, deleted again" }).toBe(pasted);

  await app.getByRole("button", { name: /Settings page layout/ }).click();
  await expect.element(app.getByText("Paste a screenshot and show me where.")).toBeVisible();
  expect(stagedNames(), "the original is still staged").toEqual([pasted.split("/").pop()]);
  expect(composerText().value, "no note was added").toBe("");
});
