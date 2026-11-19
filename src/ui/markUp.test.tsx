// @vitest-environment jsdom
// The Mark up dialog on its own (ADR 0225): one box, a note, and keys that never lose the owner's work by surprise.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "../hermes/model";
import { MarkUpDialog } from "./MarkUp";

const shot: Attachment = { path: "/c/1/0/shot.png", name: "shot.png", size: 9, kind: "image" };

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 } as DOMRect);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function open() {
  const onConfirm = vi.fn(async () => undefined);
  const onCancel = vi.fn();
  render(<MarkUpDialog file={shot} src="blob:shot" n={1} onConfirm={onConfirm} onCancel={onCancel} />);
  const stage = screen.getByLabelText("shot.png: drag to draw a box");
  const img = stage.querySelector("img")!;
  Object.defineProperties(img, { naturalWidth: { value: 400 }, naturalHeight: { value: 300 } });
  fireEvent.load(img);
  await waitFor(() => expect(stage.getAttribute("aria-busy")).toBe("false"));
  const drag = (x0: number, y0: number, x1: number, y1: number, release = true) => {
    fireEvent.pointerDown(stage, { clientX: x0, clientY: y0, button: 0, pointerId: 1 });
    fireEvent.pointerMove(stage, { clientX: x1, clientY: y1, pointerId: 1 });
    if (release) fireEvent.pointerUp(stage, { clientX: x1, clientY: y1, pointerId: 1 });
  };
  return { stage, drag, onConfirm, onCancel };
}

describe("Mark up dialog", () => {
  it("adds nothing before a box is drawn, and keeps one box: a new drag moves it", async () => {
    const { stage, drag } = await open();
    expect(screen.getByRole("button", { name: "Add to message" })).toHaveProperty("disabled", true);
    drag(10, 10, 110, 60);
    expect(screen.getByRole("textbox", { name: "Note for box 1" })).toBeTruthy();
    drag(200, 150, 300, 250);
    const boxes = stage.querySelectorAll<HTMLElement>(".markup-box");
    expect(boxes).toHaveLength(1);
    expect([boxes[0].style.left, boxes[0].style.top]).toEqual(["50%", "50%"]);
    expect(screen.getByRole("button", { name: "Add to message" })).toHaveProperty("disabled", false);
  });

  it("ends a drag on the first Esc, and cancels on the next", async () => {
    const { drag, onCancel } = await open();
    drag(10, 10, 110, 60, false);
    const dialog = screen.getByRole("dialog", { name: "Mark up shot.png" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    expect(dialog.querySelector(".markup-box")).toBeNull();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("stays open with the box and note, saying why, when the marked image can't be made", async () => {
    // jsdom has no canvas, as a webview that can't draw would.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { drag, onConfirm } = await open();
    drag(10, 10, 110, 60);
    const note = screen.getByRole("textbox", { name: "Note for box 1" });
    fireEvent.change(note, { target: { value: "this one" } });
    fireEvent.keyDown(note, { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't mark up the image: the webview can't draw images");
    expect(onConfirm).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox", { name: "Note for box 1" }) as HTMLInputElement).value).toBe("this one");
  });

  it("leaves Enter to an input method choosing a word, and keeps the app's shortcuts and Tab inside the dialog", async () => {
    const { drag, onConfirm } = await open();
    drag(10, 10, 110, 60);
    const note = screen.getByRole("textbox", { name: "Note for box 1" });
    fireEvent.keyDown(note, { key: "Enter", isComposing: true });
    fireEvent.keyDown(note, { key: "Enter", ctrlKey: true, keyCode: 229 });
    await new Promise((r) => setTimeout(r, 0));
    // jsdom can't draw, so a confirm would show why it failed.
    expect(screen.queryByRole("alert"), "nothing was confirmed").toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();

    const reached = vi.fn();
    window.addEventListener("keydown", reached);
    fireEvent.keyDown(note, { key: "k", ctrlKey: true });
    window.removeEventListener("keydown", reached);
    expect(reached, "an app shortcut stops at the dialog").not.toHaveBeenCalled();

    screen.getByRole("button", { name: "Cancel" }).focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(screen.getByRole("dialog").contains(document.activeElement), "Tab from the last control wraps inside").toBe(true);
  });
});
