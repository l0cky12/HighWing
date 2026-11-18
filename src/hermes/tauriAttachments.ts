import { invoke } from "@tauri-apps/api/core";
import { outboxAttachmentPaths, subscribeOutbox } from "./chatCache";
import type { AttachmentDeskApi } from "./attachmentDesk";

export const tauriAttachments: AttachmentDeskApi = {
  discard: (path) => invoke<void>("capture_discard", { path }),
};

// Serialize reconciliation, reading the latest outboxes when the work runs. Retry removes the old row and adds the
// new one synchronously; looking after that completes never deletes a file in between those two rows.
let syncing = Promise.resolve();
export function syncStagedOutbox(): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return Promise.resolve();
  syncing = syncing.catch(() => {}).then(() => invoke<void>("capture_sync_outbox", { paths: outboxAttachmentPaths() }));
  return syncing;
}
subscribeOutbox(() => void syncStagedOutbox().catch(() => {}));
