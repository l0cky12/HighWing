// @vitest-environment jsdom
// The whole app's zoom (ADR 0200): Ctrl+= in, Ctrl+- out, Ctrl+0 back to 100%, kept across a restart.
import { afterEach, describe, expect, it, vi } from "vitest";
import { UI_PREFS_KEY, getUIPrefs, setUIPrefs } from "../hermes/uiPrefs";
import { followZoomKeys } from "./zoom";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: async () => {} }) }));

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  localStorage.clear();
});

function follow() {
  const zoomTo = vi.fn(async (_factor: number) => {});
  stop = followZoomKeys(zoomTo);
  return zoomTo;
}

/** A key press as the window hears it: `key` what it types, `code` the key's place. */
function press(key: string, code: string, mods: { shift?: boolean; isComposing?: boolean } = {}, on: EventTarget = document.body) {
  const e = new KeyboardEvent("keydown", { key, code, ctrlKey: true, shiftKey: mods.shift, isComposing: mods.isComposing, bubbles: true, cancelable: true });
  on.dispatchEvent(e);
  return e;
}
const plus = () => press("=", "Equal");

describe("Zooming the app", () => {
  it("steps in with Ctrl+=, Ctrl+Shift+= and the keypad's Ctrl++, out with Ctrl+-, and back to 100% with Ctrl+0", () => {
    const zoomTo = follow();
    expect(zoomTo).not.toHaveBeenCalled();
    expect(plus().defaultPrevented).toBe(true);
    expect(getUIPrefs().zoom).toBe(1.1);
    press("+", "Equal", { shift: true });
    expect(getUIPrefs().zoom).toBe(1.25);
    press("+", "NumpadAdd");
    expect(getUIPrefs().zoom).toBe(1.5);
    press("-", "Minus");
    expect(getUIPrefs().zoom).toBe(1.25);
    press("0", "Digit0");
    expect(getUIPrefs().zoom).toBe(1);
    expect(zoomTo.mock.calls.map(([f]) => f)).toEqual([1.1, 1.25, 1.5, 1.25, 1]);
  });

  it("stops at 200% and 50%", () => {
    follow();
    for (let i = 0; i < 12; i++) plus();
    expect(getUIPrefs().zoom).toBe(2);
    for (let i = 0; i < 20; i++) press("-", "Minus");
    expect(getUIPrefs().zoom).toBe(0.5);
  });

  it("works from a text field, and leaves a key a control took, or one pressed while composing, alone", () => {
    const zoomTo = follow();
    const field = document.body.appendChild(document.createElement("textarea"));
    plus();
    press("=", "Equal", {}, field);
    expect(getUIPrefs().zoom).toBe(1.25);
    field.addEventListener("keydown", (e) => e.preventDefault(), { once: true });
    press("=", "Equal", {}, field);
    press("=", "Equal", { isComposing: true }, field);
    expect(getUIPrefs().zoom).toBe(1.25);
    expect(zoomTo).toHaveBeenCalledTimes(2);
    field.remove();
  });

  it("opens at the zoom it was left at, and follows a change made elsewhere, as a restored backup makes", () => {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 5, zoom: 1.5 }));
    const zoomTo = follow();
    expect(zoomTo).toHaveBeenCalledWith(1.5);
    setUIPrefs({ zoom: 0.8 });
    expect(zoomTo).toHaveBeenLastCalledWith(0.8);
  });
});
