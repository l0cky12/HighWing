# Screenshot capture is removed, and its staging folder stays for pasted files and annotations

> **Accepted.** It changes ADR 0129 (a capture no longer adds to `Attachable`), ADR 0147 (the screenshot shortcut no longer blocks a chord) and ADR 0060 (a restart no longer drops `--screenshot`, since there is none).

The owner asked for the Screenshots feature to go. It had four ways in: the composer's camera button, the in-app shortcut (Ctrl+Shift+S by default), `hermes-chat --screenshot` bound to a key in the desktop, and Settings → General → Screenshots, which set the shortcut and said how this desktop takes one. Behind them, Rust picked a capture method per desktop: slurp and grim on wlroots compositors, the xdg-desktop-portal Screenshot portal on GNOME and KDE Plasma, and a picker of its own in PowerShell on Windows.

A capture was staged in a private folder (`Captures`) and kept per chat by the desk in `src/hermes/screenshots.ts`. Pasted files, files dropped on Windows, and Preview annotations (ADR 0094) were later staged the same way. So the staging is shared, and only the capture is the feature.

## Decisions

- **Capture goes, with every way in.** The camera button, the shortcut and its preference, the Settings page, `--screenshot`, the `Screenshot` request on the session bus and the Windows pipe, the "Screenshot attached" notification, and the commands `screenshot_capture`, `screenshot_support`, `screenshot_pending_request`, `screenshot_ack_request` and `screenshot_show_window` are gone. So are slurp, grim, the portal client, the Windows picker, and the AUR optional dependencies on `slurp`, `grim` and `xdg-desktop-portal`.
- **Staging stays, under names for what it does now.** `screenshot.rs` is `captures.rs`. The desk is `AttachmentDesk` in `src/hermes/attachmentDesk.ts`, and its Tauri glue is `src/hermes/tauriAttachments.ts`. The commands `screenshot_discard` and `screenshot_sync_outbox` are `capture_discard` and `capture_sync_outbox`. The folder on disk keeps its name, `captures/`, so files staged by an older version are still found and swept.
- **The `--toggle` help moves.** The Screenshots page was the only place that said how to bind a key to `hermes-chat --toggle`. That paragraph is now in Brought forward, under Settings → General → Launch, tray & updates.
- **An older install's setting is ignored.** A stored `screenshotShortcut` preference loads without error. It stays in the stored document, and nothing reads it. The preferences version doesn't change, as for `agentOffice` in ADR 0204. A backup no longer holds the field.

## Considered options

- **Keep capture behind a setting.** Rejected: the owner asked for the feature to go, and a hidden capture path still costs code on three desktops, tests and review.
- **Keep the old names for the shared staging.** Rejected: after the removal, a "screenshot" desk that never takes a screenshot misleads the next reader. ADR 0204 renamed what the removed screens left behind for the same reason.

## Consequences

- A desktop key still bound to `hermes-chat --screenshot` now brings Highwing forward, as a plain second launch does (ADR 0034). The flag is ignored.
- Ctrl+Shift+S is free for a command the owner binds under Settings → Keyboard Shortcuts.
- Pasting an image, dropping a file and annotating the Preview stage, send and clean up as before.
