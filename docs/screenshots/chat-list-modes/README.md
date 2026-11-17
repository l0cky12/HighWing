# The chat list's two modes: evidence

Evidence for the chat list panel's two lasting modes, Chats and Bots, the switch at its top, and the pane named by its bot.

## Where the screenshots come from

Every PNG here was taken by `shot()` in `e2e/features/chat-list-modes.e2e.tsx`. The e2e harness (`docs/e2e.md`) starts the whole app from `src/main.tsx` in headless Chromium at 1440×900, against a `FakeHermes` at the made-up address `https://hermes.example.net`, with an in-memory keyring. No real Hermes server, real bot or user data is involved. Every bot and chat is seeded test data: five bots, one per profile: Hermes (the built-in profile), Quill (profile `writer`), Ops (replying in its Bot Chat), Scout (its Bot Chat waits on the owner) and a bot with no name in profile `hermes-chat`, so it shows as "Hermes Chat". Each profile has a few chats.

The panel before this change, in bot mode with Scribe's Bot Chat open, is `docs/screenshots/bot-context-menu/before-bot-mode.png`.

| File | State |
| --- | --- |
| `chats.png` | Chats mode at launch: the switch, with "1" on the Bots tab for Scout; Scout's needs-you line; Hermes's face, name and `default`; New chat and Search; the Bot Chat row; the sections. |
| `bots.png` | Bots mode: New chat and Search, then the bots. Hermes's chats sit under its row: the two Inbox chats with the mark, the newest Settled one, and "All 6 chats". The Chats tab carries the Inbox's 2. Ops is replying, Scout needs the owner. |
| `shown-by-chord-in-bots.png` | After Ctrl+B hid the panel, Ctrl+Shift+B brought it back in the other mode, Bots. |
| `needs-you-opened.png` | The needs-you line clicked: Scout's Bot Chat in `scout`, its Approval showing, its header "Scout · Bot Chat", the message box "Message Scout", the Bot Chat row selected with "Needs you". The panel stayed in Chats. |
| `bot-chat-by-alt-b.png` | Alt+B from "Nightly backup failing": Hermes's Bot Chat, its row selected. |
| `back-by-alt-b.png` | Alt+B again: back to "Nightly backup failing". |
| `bots-row-hovered.png` | A bot's row hovered: the pen takes the time's place. |
| `other-profile-bots.png` | Quill's row clicked in Bots mode: the profile switched, Quill's chats moved under its row, the mode stayed. |
| `other-profile-chats.png` | The same in Chats mode: "Quill writer" in the switcher, its Bot Chat row selected, the tab titled "Quill". |
| `named-by-id.png` | Profile `hermes-chat`, whose bot has no name: "Hermes Chat" without the id said again, "What should Hermes Chat work on?". |
| `light-chats.png` | Chats mode in the light theme. |
| `light-bots.png` | Bots mode in the light theme. |

## Reproduce

```sh
npm run e2e -- --feature chat-list-modes   # writes e2e/out/screenshots/chat-list-modes/*.png and e2e/out/summary.json
npm run e2e -- --feature bot-menu          # the right-click menu in Bots mode (ADR 0194)
npx vitest run src/ui/bots.test.tsx --maxWorkers=1 -t "two modes|Chats mode|Bots mode|pane names|Alt\+B|without Bot Mode"
npx vitest run src/ui/chatListModesTranslated.test.tsx src/hermes/bots.test.ts src/hermes/snooze.test.ts src/hermes/uiPrefs.test.ts
```

## Results

- `npm run e2e -- --feature chat-list-modes`: 7 passed. `npm run e2e`: every feature passes.
- The unit tests above pass, among them the pure functions `botsWaiting`, `namedByProfile` (bots.ts) and `chatsUnderBot` (snooze.ts).
