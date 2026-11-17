import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { row, type FakeHermes } from "../../src/hermes/fakeHermes";
import { boot, shot, sessionOfPrompt } from "../harness";

const seed = (s: FakeHermes) => {
  s.sessions = [row("router", 0.1, { pinned: true, title: "Router admin page" }), row("nas", 2, { pinned: true, title: "NAS disk usage" })];
  s.transcripts = {
    router: [
      { role: "user", text: "The router admin page won't load." },
      { role: "assistant", text: "Paste a screenshot of what the browser shows." },
    ],
    nas: [
      { role: "user", text: "How full is the NAS?" },
      { role: "assistant", text: "It is 71% full." },
    ],
  };
};

const appDocument = () => document.querySelector<HTMLIFrameElement>("iframe[title=Highwing]")!.contentDocument!;
const lastSentBubble = () => [...appDocument().querySelectorAll<HTMLElement>(".msg.user")].at(-1);

/** The images the last sent message shows, as a person sees them: drawn, with their size and alt text. */
const imagesInLastSent = () =>
  [...(lastSentBubble()?.querySelectorAll("img") ?? [])].map((img) => ({
    alt: img.alt,
    width: img.naturalWidth,
    height: img.naturalHeight,
    shown: img.complete && img.getBoundingClientRect().width > 0,
  }));

/** A 40 × 30 PNG, as a screenshot on the clipboard is. */
async function screenshotPng(): Promise<Blob> {
  const canvas = Object.assign(document.createElement("canvas"), { width: 40, height: 30 });
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#c0392b";
  g.fillRect(0, 0, 40, 30);
  g.fillStyle = "#ecf0f1";
  g.fillRect(8, 8, 24, 14);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
}

/** Pastes files into the composer, as Ctrl+V does with a screenshot or a copied file on the clipboard. */
function paste(...files: File[]) {
  const composer = appDocument().querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;
  const data = new DataTransfer();
  for (const f of files) data.items.add(f);
  composer.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}

/** The screenshot name from the report this test comes from. */
const REPORTED = "clipboard-2026-11-17T092255.png";

const base64 = async (b: Blob) => btoa(Array.from(new Uint8Array(await b.arrayBuffer()), (c) => String.fromCharCode(c)).join(""));

it("shows a pasted image in the sent message, after switching chats and after a relaunch", async () => {
  const { app, server, relaunch } = await boot({ seed });
  const png = await screenshotPng();
  const caption = "This is what the router page shows";

  await app.getByRole("button", { name: /Router admin page/ }).click();
  await expect.element(app.getByText("Paste a screenshot of what the browser shows.")).toBeVisible();
  const composer = app.getByPlaceholder("Message Hermes");
  await composer.click();
  paste(new File([png], REPORTED, { type: "image/png" }));
  await expect.element(app.getByText(REPORTED), { message: "the pasted screenshot is staged" }).toBeVisible();
  await composer.fill(caption);
  await userEvent.keyboard("{Enter}");

  const session = await sessionOfPrompt(server, caption);
  const sent = server.requests.filter((r) => r.method === "image.attach_bytes" || r.method === "prompt.submit");
  expect(sent.map((r) => r.method), "what Hermes got, in order").toEqual(["image.attach_bytes", "prompt.submit"]);
  expect(sent[0].params.filename, "the image's name").toBe(REPORTED);
  expect(sent[0].params.content_base64, "the image's bytes").toBe(await base64(png));

  server.event(session, "message.start");
  server.event(session, "message.complete", { text: "The page shows a certificate error.", status: "complete" });
  await expect.element(app.getByText("The page shows a certificate error.")).toBeVisible();

  const theScreenshot = [{ alt: expect.stringMatching(/\S/), width: 40, height: 30, shown: true }];
  await expect.poll(imagesInLastSent, { message: "the sent message shows the pasted image" }).toEqual(theScreenshot);
  expect(imagesInLastSent()[0].alt, "the image is named for the file that was pasted").toContain(REPORTED);
  await shot("sent");

  await app.getByRole("button", { name: /NAS disk usage/ }).click();
  await expect.element(app.getByText("It is 71% full.")).toBeVisible();
  await app.getByRole("button", { name: /Router admin page/ }).click();
  await expect.element(app.getByText("The page shows a certificate error.")).toBeVisible();
  await expect.poll(imagesInLastSent, { message: "the image is still there after switching chats" }).toEqual(theScreenshot);

  await relaunch();
  await app.getByRole("button", { name: /Router admin page/ }).click();
  await expect.element(app.getByText(caption, { exact: false })).toBeVisible();
  await expect.poll(imagesInLastSent, { message: "the image is still there after a relaunch" }).toEqual(theScreenshot);
  expect(lastSentBubble()!.textContent, "the message shows no raw image reference").not.toContain("@image:");
  await shot("after relaunch");
});

it("shows a pasted file that isn't an image as its name in the sent message", async () => {
  const { app, server } = await boot({ seed });
  const caption = "Here are my notes on the outage";

  await app.getByRole("button", { name: /Router admin page/ }).click();
  await expect.element(app.getByText("Paste a screenshot of what the browser shows.")).toBeVisible();
  const composer = app.getByPlaceholder("Message Hermes");
  await composer.click();
  paste(new File(["The router rebooted at 03:12.\n"], "notes.txt", { type: "text/plain" }));
  await expect.element(app.getByText("notes.txt"), { message: "the pasted file is staged" }).toBeVisible();
  await composer.fill(caption);
  await userEvent.keyboard("{Enter}");

  await sessionOfPrompt(server, `@file:attachments/notes.txt\n\n${caption}`);
  expect(server.last("file.attach")?.params.name, "the file Hermes got").toBe("notes.txt");
  await expect.poll(() => lastSentBubble()?.querySelector(".chip-name")?.textContent, { message: "the sent message names the file" }).toBe("notes.txt");
  expect(imagesInLastSent(), "a file that isn't an image shows no picture").toEqual([]);
  await shot("sent");
});

it("names an image Hermes no longer has instead of showing a broken picture", async () => {
  const gone = "/hermes/images/upload_gone.png";
  const { app } = await boot({
    seed: (s) => {
      seed(s);
      // Stored with its image as Hermes stores one; the server no longer has the file.
      s.transcripts.router.push({ role: "user", text: `Here is the error page\n@image:${gone}` });
    },
  });

  await app.getByRole("button", { name: /Router admin page/ }).click();
  await expect.element(app.getByText(/^Here is the error page/)).toBeVisible();
  await expect.element(app.getByText("upload_gone.png", { exact: false }), { message: "the missing image is named" }).toBeVisible();
  await expect.poll(() => imagesInLastSent().filter((i) => i.width === 0), { message: "no broken picture" }).toEqual([]);
  expect(lastSentBubble()!.textContent, "the message shows no raw image reference").not.toContain("@image:");
  await shot("missing image");
});
