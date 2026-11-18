// The real calls behind the staging desk: Rust deletes a staged file, and keeps the ones a queued or failed message
// still holds.
import { invoke } from "@tauri-apps/api/core";
import { outboxAttachmentPaths, subscribeOutbox } from "./chatCache";
import type { ScreenshotApi } from "./screenshots";

export const tauriScreenshots: ScreenshotApi = {
  discard: (path) => invoke<void>("screenshot_discard", { path }),
};

// Serialize reconciliation, reading the latest outboxes when the work runs. Retry removes the old row and adds the
// new one synchronously; looking after that completes never deletes a file in between those two rows.
let syncing = Promise.resolve();
export function syncScreenshotOutbox(): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return Promise.resolve();
  syncing = syncing.catch(() => {}).then(() => invoke<void>("screenshot_sync_outbox", { paths: outboxAttachmentPaths() }));
  return syncing;
}
subscribeOutbox(() => void syncScreenshotOutbox().catch(() => {}));
