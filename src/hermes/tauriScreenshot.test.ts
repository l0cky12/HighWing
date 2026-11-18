import { expect, it, vi } from "vitest";
import { syncScreenshotOutbox } from "./tauriScreenshot";

const { invoke, paths } = vi.hoisted(() => ({ invoke: vi.fn(), paths: vi.fn(() => [] as string[]) }));
vi.mock("./chatCache", () => ({ outboxAttachmentPaths: paths, subscribeOutbox: () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("reads the latest outbox after Retry replaces its row, never the transient empty outbox", async () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  paths.mockReturnValue([]);
  invoke.mockResolvedValue(undefined);
  const sync = syncScreenshotOutbox();
  // Retry removes one row and inserts its replacement before the microtask runs.
  paths.mockReturnValue(["/private/captures/1/0/retry.png"]);
  await sync;
  expect(invoke).toHaveBeenLastCalledWith("screenshot_sync_outbox", { paths: ["/private/captures/1/0/retry.png"] });
  vi.unstubAllGlobals();
});
