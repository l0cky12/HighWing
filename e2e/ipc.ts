import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

type Invoke = (cmd: string, args: unknown, options?: { headers?: Record<string, string> }) => Promise<unknown>;
const host = window.parent as Window & { e2eInvoke: (cmd: string, args: unknown, headers?: Record<string, string>) => Promise<unknown> };
// Vitest rewrites each `import()` to go through its runner, which only the test's own frame defines.
(globalThis as { __vitest_browser_runner__?: unknown }).__vitest_browser_runner__ ??= { wrapDynamicImport: (load: () => unknown) => load() };
mockWindows("main");
mockIPC((cmd, args) => host.e2eInvoke(cmd, args), { shouldMockEvents: true });
// mockIPC drops a command's headers, which carry the arguments of a raw-body command such as `stage_clipboard_file`.
const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
const mocked = internals.invoke;
internals.invoke = (cmd, args, options) => (cmd.startsWith("plugin:event|") ? mocked(cmd, args, options) : host.e2eInvoke(cmd, args, options?.headers));
