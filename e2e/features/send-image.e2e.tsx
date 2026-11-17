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
/** A blob's bytes, one char per byte, as FakeHermes keeps a file. */
const bytesOf = async (b: Blob) => String.fromCharCode(...new Uint8Array(await b.arrayBuffer()));

/** The dashboard routes the app asked about `path` or its folder, in order. */
const routesAbout = (server: FakeHermes, path: string) =>
  server.restRequests.filter((r) => [...r.query.values()].some((v) => v === path || v === path.slice(0, path.lastIndexOf("/")))).map((r) => r.path);

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
  const stored = Object.keys(server.managedFiles.nodes).find((p) => p.startsWith("/hermes/images/"));
  expect(stored, "Hermes stored the image on the dashboard's machine").toBeDefined();
  expect(routesAbout(server, stored!), "read through the managed files routes, on the dashboard's own machine, not where the profile's tools run").toEqual([
    "/api/files",
    "/api/files/read",
  ]);
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

  const picture = lastSentBubble()!.querySelector<HTMLButtonElement>("button.sent-image")!;
  picture.focus();
  expect(appDocument().activeElement, "the image takes keyboard focus").toBe(picture);
  await userEvent.keyboard("{Enter}");
  await expect.element(app.getByRole("textbox", { name: "Address" }), { message: "Enter opens the image in the Preview" }).toHaveValue(stored!);
  await expect
    .poll(() => [...appDocument().querySelectorAll<HTMLImageElement>(".preview-image img")].map((img) => [img.naturalWidth, img.naturalHeight]), {
      message: "the Preview draws the image",
    })
    .toEqual([[40, 30]]);
  await shot("opened in preview");
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

it("asks before reading an image this app didn't send, and names one the dashboard's machine doesn't have", async () => {
  const gone = "/hermes/images/upload_gone.png";
  const { app, server } = await boot({
    seed: (s) => {
      seed(s);
      // Stored with its image as Hermes stores one, by another client; the server doesn't have the file.
      s.transcripts.router.push({ role: "user", text: `Here is the error page\n@image:${gone}` });
    },
  });

  await app.getByRole("button", { name: /Router admin page/ }).click();
  await expect.element(app.getByText(/^Here is the error page/)).toBeVisible();
  await expect.element(app.getByText("upload_gone.png", { exact: false }), { message: "the image is named" }).toBeVisible();
  await expect.element(app.getByText("Not sent from this app, so it loads when you ask."), { message: "why it waits" }).toBeVisible();
  expect(lastSentBubble()!.textContent, "the message shows no raw image reference").not.toContain("@image:");
  await shot("asks first");
  expect(routesAbout(server, gone), "nothing reads the image before the owner asks").toEqual([]);

  await app.getByRole("button", { name: /^Show image/ }).click();
  await expect.element(app.getByText(/^Couldn't read it from the dashboard's machine\./), { message: "the reason names the dashboard's machine" }).toBeVisible();
  await expect.poll(() => imagesInLastSent().filter((i) => i.width === 0), { message: "no broken picture" }).toEqual([]);
  await shot("missing image");

  server.managedFiles.nodes[gone] = { bytes: await bytesOf(await screenshotPng()) };
  await app.getByRole("button", { name: "Try again" }).click();
  await expect
    .poll(imagesInLastSent, { message: "Try again shows the image once the dashboard's machine has it" })
    .toEqual([{ alt: "upload_gone.png", width: 40, height: 30, shown: true }]);
  await shot("missing image found");
});

it("doesn't read an image a stored message names that this app didn't send until the owner asks, and asks again after a relaunch", async () => {
  // An image Hermes has, named by a message someone else could have sent to the profile.
  const planted = "/hermes/images/upload_7.png";
  const bytes = await bytesOf(await screenshotPng());
  const { app, server, relaunch } = await boot({
    seed: (s) => {
      seed(s);
      s.transcripts.router.push({ role: "user", text: `Is this your router page?\n@image:${planted}` });
      s.managedFiles.nodes[planted] = { bytes };
      s.serverFiles[planted] = bytes;
    },
  });

  await app.getByRole("button", { name: /Router admin page/ }).click();
  await expect.element(app.getByText(/^Is this your router page\?/)).toBeVisible();
  await expect.element(app.getByRole("button", { name: /^Show image/ }), { message: "the image waits for the owner" }).toBeVisible();
  await shot("asks first");
  expect(imagesInLastSent(), "nothing drawn").toEqual([]);
  expect(routesAbout(server, planted), "nothing reads the image before the owner asks").toEqual([]);

  const show = lastSentBubble()!.querySelector<HTMLButtonElement>(".sent-image-tile button")!;
  show.focus();
  expect(appDocument().activeElement, "Show image takes keyboard focus").toBe(show);
  await userEvent.keyboard("{Enter}");
  await expect.poll(imagesInLastSent, { message: "the owner's click shows it" }).toEqual([{ alt: "upload_7.png", width: 40, height: 30, shown: true }]);
  expect(routesAbout(server, planted), "read from the dashboard's own machine").toEqual(["/api/files", "/api/files/read"]);
  await shot("shown when asked");

  await relaunch();
  await app.getByRole("button", { name: /Router admin page/ }).click();
  await expect.element(app.getByText(/^Is this your router page\?/)).toBeVisible();
  await expect.element(app.getByRole("button", { name: /^Show image/ }), { message: "showing it once doesn't make it this app's" }).toBeVisible();
  expect(routesAbout(server, planted), "nothing more read after the relaunch").toEqual(["/api/files", "/api/files/read"]);
});
