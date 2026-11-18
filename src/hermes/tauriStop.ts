// `hermes-chat --stop` reaches the webview from Rust (src-tauri/src/remote.rs, ADR 0221). Rust keeps the request until a
// window connected to Hermes has started the Stop, so one made at the sign-in screen, while connecting, or one that
// started the app, isn't lost.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Calls `fn` whenever `hermes-chat --stop` asks to stop computer use; one made recently before this call is taken now. */
export function onDesktopStop(fn: () => void): () => void {
  let live = true;
  let running = false;
  let again = false;
  const take = async () => {
    again = true;
    if (running || !live) return;
    running = true;
    try {
      while (live && again) {
        again = false;
        const id = await invoke<number | null>("stop_pending_request");
        // Cleanup may have run while Rust answered. No acknowledgement: the next live window will take it.
        if (!live) return;
        if (id !== null) {
          fn();
          await invoke<void>("stop_ack_request", { id });
        }
      }
    } catch {
      // Outside the desktop app there is no Rust to ask.
    } finally {
      running = false;
    }
  };
  // Listen before peeking, so a request made during registration is also observed.
  const unlisten = listen("stop-requested", () => void take())
    .then((unlisten) => {
      if (live) void take();
      return unlisten;
    })
    .catch(() => undefined);
  return () => {
    live = false;
    void unlisten.then((u) => u?.());
  };
}
