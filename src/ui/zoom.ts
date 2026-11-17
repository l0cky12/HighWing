// The whole app's zoom (ADR 0197): Ctrl+= one step in, Ctrl+- one step out, Ctrl+0 back to 100%. The webview zooms
// natively, as a browser does, so layout stays in CSS pixels and the web page view's placement (ADR 0081) scales with
// it. Kept in the display preferences, so the app opens at the zoom it was left at.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ZOOM_LEVELS, getUIPrefs, setUIPrefs, subscribe } from "../hermes/uiPrefs";
import { pickApp, type CommandId } from "./keybindings";

const LEVELS: readonly number[] = ZOOM_LEVELS;
const STEP: Partial<Record<CommandId, number>> = { zoomIn: 1, zoomOut: -1, zoomReset: 0 };

/** The zoom one step from `now` (`by` 1 in, -1 out), within ZOOM_LEVELS; `by` 0 is 100%. */
function stepZoom(now: number, by: number): number {
  if (by === 0) return 1;
  const at = LEVELS.indexOf(now);
  return LEVELS[Math.min(LEVELS.length - 1, Math.max(0, (at < 0 ? LEVELS.indexOf(1) : at) + by))];
}

/**
 * Zooms the webview to the kept zoom now and whenever it changes, and runs the zoom keys: on the window, for the life
 * of the app, so Sign in and Settings zoom too. A control that takes the key first (the Terminal keeps every key, the
 * search palette all but its own) keeps it. Returns the function that stops it.
 */
export function followZoomKeys(zoomTo: (factor: number) => Promise<void> = (f) => getCurrentWebview().setZoom(f)): () => void {
  let shown = 1;
  const show = (zoom: number) => {
    if (zoom === shown) return;
    shown = zoom;
    void (async () => zoomTo(zoom))().catch((err: unknown) => console.warn("Couldn't zoom the app:", err));
  };
  show(getUIPrefs().zoom);
  const unsubscribe = subscribe((prefs) => show(prefs.zoom));
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const command = pickApp(e);
    const by = command && STEP[command];
    if (by === undefined) return;
    e.preventDefault();
    setUIPrefs({ zoom: stepZoom(getUIPrefs().zoom, by) });
  };
  window.addEventListener("keydown", onKey);
  return () => {
    unsubscribe();
    window.removeEventListener("keydown", onKey);
  };
}
