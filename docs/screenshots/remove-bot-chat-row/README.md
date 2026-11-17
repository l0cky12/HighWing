# Removing the Bot Chat row from Chats mode

Chats mode at launch, before and after the Bot Chat row under Search chats was removed.

| File | Shows |
| --- | --- |
| `before-chats.png` | `main`: New chat, Search chats, then the Bot Chat row ("Bot Chat 24m"), then All chats and the Inbox. |
| `after-chats.png` | This branch: All chats sits directly under Search chats, with no gap. |
| `before-chats-light.png`, `after-chats-light.png` | The same, in the light theme. |

To make them, run `npm run e2e -- --feature chat-list-modes`, and copy `…--chats.png` and `…--light-chats.png` from `e2e/out/screenshots/chat-list-modes/`. The suite runs the app's frontend in headless Chromium against `FakeHermes` with made-up data. It is not the native Tauri app.
