import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { row, type TranscriptMessage } from "../../src/hermes/fakeHermes";
import { boot, sessionOfPrompt, shot } from "../harness";

const TURNS = 300;
const PROMPT = "Walk me through the deploy log again.";

const inApp = <T extends Element>(css: string) => document.querySelector("iframe")!.contentDocument!.querySelector<T>(css);
const transcript = () => inApp<HTMLElement>(".transcript")!;
/** Waits until the transcript shows `text`; a streaming reply's words are not one text node. */
const shows = (text: string, message: string) => expect.poll(() => transcript().textContent, { message }).toContain(text);
const fromBottom = () => transcript().scrollHeight - transcript().scrollTop - transcript().clientHeight;

function history(): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (let t = 0; t < TURNS; t++)
    out.push({ role: "user", text: `Check step ${t} of the deploy.` }, { role: "assistant", text: `Step ${t} passed: the service answered on port ${8000 + t}.` });
  return out;
}

/** Scrolls to the top of the chat as the wheel does. */
async function scrollToTop() {
  const el = transcript();
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, bubbles: true }));
  el.scrollTop = 0;
  await expect.poll(() => inApp(".msg[data-item]")?.textContent, { message: "the top of the chat is on screen" }).toContain("Check step 0");
}

it("shows a button to the newest message after the owner scrolls up during a reply, and the button and Alt+End go to the real end", async () => {
  const { app, server } = await boot({
    seed: (s) => {
      s.sessions = [row("deploy", 0.1, { pinned: true, title: "Deploy log", message_count: TURNS * 2 })];
      s.transcripts = { deploy: history() };
    },
  });
  await app.getByRole("button", { name: /Deploy log/ }).click();
  await expect.element(app.getByText(`Step ${TURNS - 1} passed`, { exact: false })).toBeVisible();
  await expect.element(app.getByRole("button", { name: "Go to the newest message" }), { message: "no button at the bottom of the chat" }).not.toBeInTheDocument();

  await app.getByPlaceholder("Message Hermes").fill(PROMPT);
  await userEvent.keyboard("{Enter}");
  const session = await sessionOfPrompt(server, PROMPT);
  server.event(session, "message.start");
  server.event(session, "message.delta", { text: "The deploy started at 09:12 and " });
  await shows("The deploy started at 09:12", "the reply streams");

  await scrollToTop();
  expect(transcript().textContent, "the end of a long chat isn't rendered at its top").not.toContain("The deploy started at 09:12");
  server.event(session, "message.delta", { text: "the health check passed at 09:14." });
  const button = app.getByRole("button", { name: "New reply below" });
  await expect.element(button).toBeVisible();
  expect(transcript().scrollTop, "the view stays where the owner scrolled to").toBe(0);
  await shot("new-reply-below");

  await button.click();
  await shows("the health check passed at 09:14", "the newest words are on screen");
  await expect.poll(fromBottom, { message: "the view is at the end of the chat" }).toBeLessThan(2);
  await expect.element(button).not.toBeInTheDocument();
  server.event(session, "message.delta", { text: " Traffic moved to the new build at 09:15." });
  await shows("Traffic moved to the new build", "the reply goes on streaming");
  await expect.poll(fromBottom, { message: "the view follows the reply again" }).toBeLessThan(2);
  await shot("followed");

  server.event(session, "message.complete", { text: "The deploy started at 09:12 and the health check passed at 09:14. Traffic moved to the new build at 09:15.", status: "complete" });
  await expect.element(app.getByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  await scrollToTop();
  await expect.element(app.getByRole("button", { name: "Go to the newest message" })).toBeVisible();
  await shot("go-to-newest");
  const composer = inApp<HTMLTextAreaElement>(".composer-wrap textarea")!;
  await app.getByPlaceholder("Message Hermes").fill("Thanks, and the rollback plan?");
  composer.setSelectionRange(0, 0);
  await userEvent.keyboard("{Alt>}{End}{/Alt}");
  await shows("Traffic moved to the new build", "Alt+End renders the end of the chat");
  await expect.poll(fromBottom, { message: "Alt+End reaches the end of the chat" }).toBeLessThan(2);
  await expect.element(app.getByRole("button", { name: "Go to the newest message" })).not.toBeInTheDocument();
  expect(composer.value, "the draft is as it was").toBe("Thanks, and the rollback plan?");
  expect([composer.selectionStart, composer.selectionEnd], "Alt+End leaves the caret where it was").toEqual([0, 0]);
  expect(composer.ownerDocument.activeElement, "the composer keeps focus").toBe(composer);
});
