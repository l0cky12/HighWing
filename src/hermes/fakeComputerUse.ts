// Hermes's computer_use as FakeHermes plays it (FakeHermes.computerUseTurn): each call's arguments, and the result
// Hermes answered a recorded call like it with (src/hermes/fixtures/computer-use, ADR 0213). A scroll's success and a
// double click's were never recorded; theirs follow the click's shape. The screenshot is a stand-in data URL long
// enough for the app's trim to have to drop it.

/** One scripted call: its arguments, and what Hermes answers when it runs. */
export type FakeCuStep = { args: Record<string, unknown>; result: unknown; seconds?: number };
export type FakeCuTurn = { steps: FakeCuStep[]; reply: string };
export type CuDelivery = "background" | "foreground";

const SHOT = `data:image/png;base64,iVBORw0KGgo${"AAAAAElFTkSuQmCC".repeat(160)}`;
const VERIFY = "Input was delivered but not confirmed. Re-capture and check the result BEFORE any retry — do not repeat the input on an escalation recommendation alone.";

const input = (action: string, message: string, delivery: CuDelivery) => ({
  ok: true,
  action,
  message,
  effect: "unverifiable",
  delivery_mode: delivery,
  meta: { delivery: { mode: delivery }, effect: "unverifiable", route: "global_input" },
  verdict: { decision: "verify_fresh_state", hint: VERIFY },
});

const capture = (app: string, title: string, size = "1280x800") => {
  const [width, height] = size.split("x").map(Number);
  const text = `capture mode=som ${size} app=${app}\n1 interactable element(s):\n  #0 window '${title}' @ bounds-unknown (click by element index)`;
  return {
    _multimodal: true,
    content: [
      { type: "text", text },
      { type: "image_url", image_url: { url: SHOT } },
    ],
    text_summary: text,
    meta: { mode: "som", width, height, elements: 1, png_bytes: 58506, screenshot_path: "/home/lena/.hermes/cache/images/computer_use_0.png" },
  };
};

export const CU = {
  capture: (app = "desktop", seen = "Xfdesktop", title = "Desktop"): FakeCuStep => ({ args: { action: "capture", app, mode: "som" }, result: capture(seen, title), seconds: 0.7 }),
  click: ([x, y]: [number, number], delivery: CuDelivery = "background", app = "desktop"): FakeCuStep => ({
    args: { action: "click", app, coordinate: [x, y], delivery_mode: delivery },
    result: input("click", `✅ Clicked at (${x}.0, ${y}.0) × 1 (delivery_mode=${delivery}).`, delivery),
    seconds: 0.1,
  }),
  doubleClick: ([x, y]: [number, number], delivery: CuDelivery = "background", app = "desktop"): FakeCuStep => ({
    args: { action: "double_click", app, coordinate: [x, y], delivery_mode: delivery },
    result: input("double_click", `✅ Double-clicked at (${x}.0, ${y}.0) (delivery_mode=${delivery}).`, delivery),
    seconds: 0.1,
  }),
  type: (text: string, delivery: CuDelivery = "foreground", app = "xfce4-terminal"): FakeCuStep => ({
    args: { action: "type", app, text, delivery_mode: delivery },
    result: input("type_text", `Typed ${text.length} character(s) (terminal emulator: pty/XTest key events).`, delivery),
    seconds: 0.7,
  }),
  key: (keys: string, delivery: CuDelivery = "foreground", app = "xfce4-terminal"): FakeCuStep => ({
    args: { action: "key", app, keys, delivery_mode: delivery },
    result: input(keys.includes("+") ? "hotkey" : "press_key", `Pressed key '${keys}' (delivery_mode=${delivery}).`, delivery),
    seconds: 0.1,
  }),
  scroll: (direction: "up" | "down", amount: number, delivery: CuDelivery = "background", app = "desktop"): FakeCuStep => ({
    args: { action: "scroll", app, direction, amount, delivery_mode: delivery },
    result: input("scroll", `Scrolled ${direction} ${amount} (delivery_mode=${delivery}).`, delivery),
    seconds: 0.1,
  }),
  wait: (seconds: number): FakeCuStep => ({
    args: { action: "wait", seconds },
    result: { ok: true, action: "wait", message: `waited ${seconds.toFixed(2)}s`, verdict: { decision: "verify_fresh_state", hint: "Transport succeeded but the effect is unproven. Re-capture and confirm before continuing." } },
    seconds,
  }),
};

/** The actions Hermes asks before (`cua:<action>:<delivery>`); a capture, a wait and a listing go ahead. */
const ASKS = new Set(["click", "double_click", "right_click", "middle_click", "triple_click", "drag", "type", "key", "scroll", "set_value", "focus_app", "bring_to_front"]);

/** The Approval Hermes sends before `args` runs, with its pattern key, or undefined when it doesn't ask. */
export function cuApproval(args: Record<string, unknown>): { patternKey: string; params: Record<string, unknown> } | undefined {
  const action = String(args.action ?? "");
  if (!ASKS.has(action)) return undefined;
  const delivery: CuDelivery = args.delivery_mode === "foreground" ? "foreground" : "background";
  const at = Array.isArray(args.coordinate) ? ` at (${args.coordinate.join(", ")})` : "";
  const what =
    action === "type"
      ? `type '${String(args.text ?? "")}'`
      : action === "key"
        ? `key '${String(args.keys ?? "")}'`
        : action === "scroll"
          ? `scroll ${String(args.direction ?? "down")} x${String(args.amount ?? 3)}`
          : `${action}${at}`;
  const patternKey = `cua:${action}:${delivery}`;
  return {
    patternKey,
    params: {
      command: `computer_use: ${what}${delivery === "foreground" ? " [FOREGROUND — briefly raises the window / changes focus]" : ""}`,
      pattern_key: patternKey,
      pattern_keys: [patternKey],
      description: `Allow computer_use to perform \`${action}\`?`,
      allow_permanent: true,
      allow_session: true,
      timeout_s: 180,
      choices: ["once", "session", "always", "deny"],
    },
  };
}

export const DENIED = "BLOCKED: Action denied by user. The user has NOT consented to this action. Do NOT retry it, do NOT rephrase it, and do NOT attempt the same outcome via a different path.";
export const HUMAN_HAS_CONTROL =
  "A human has taken over this desktop (they may be entering a credential). Screen actions and captures are refused until they hand control back. Tell the user what you need in your reply.";
