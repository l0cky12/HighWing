# Archived under Settled, a resizable chat list, and app zoom

Shots of the native app (`.claude/skills/verify-hermes-chat`), driven with real pointer and key input against the stand-in dashboard, with made-up chats. ADR 0197.

| File | Shows |
| --- | --- |
| `before-archived-in-scroll.png` | `main`: Archived is a section in the list's scroll, above the Settled drawer. |
| `after-archived-under-settled.png` | This branch: Archived is a drawer under Settled; both open share the list's lower half. |
| `after-settings-archived-switch.png` | Settings → Chats → Chat list sections, with Archived switched off. |
| `after-list-narrowest.png`, `after-list-wide.png` | The list dragged to its narrowest (200 px) and to 480 px. |
| `after-zoom-150.png`, `after-zoom-200.png` | The whole app at 150% and 200% (Ctrl+=); at 200% the Inbox keeps two rows and both drawer headers. |
| `after-min-window.png` | The 760×500 minimum window with both drawers open. |

To make them, follow `.claude/skills/verify-hermes-chat/features/chat-list.md` (Archived, Resize, Zoom) after `HV_LIST=24 hv up`. Captured on `9feaeb4`.
