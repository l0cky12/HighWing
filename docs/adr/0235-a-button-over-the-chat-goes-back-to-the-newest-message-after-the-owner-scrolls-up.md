# A button over the chat goes back to the newest message after the owner scrolls up

> **Accepted.** The button and the jump are in `src/ui/ChatPane.tsx` (`below`, `checkBelow`, `blocksRef`, `toNewestRef`, `.to-newest`), the command is `jumpToNewest` in `src/ui/keybindings.ts`, and the words are `chat.newest` in `src/i18n/en.ts` and `es.ts`. Tested in `src/ui/paneFollow.test.tsx`, `src/ui/transcriptWindow.test.tsx` and `e2e/features/jump-to-newest.e2e.tsx`. Issue #31.

The transcript follows a reply while the view is at the bottom, and stops as soon as the owner scrolls up (#544). That part is right. But once the owner has scrolled up, nothing says the reply carried on, and the only way back down a long, still-growing reply is to scroll. Issue #31 chose a floating button over the transcript (its approach 1) over a line in the status bar, which can be hidden, and a key alone, which can't be found.

## Decisions

- **The button shows while the view doesn't follow the chat and is away from its end.** "Away" is more than 40 px from the bottom, the distance that already decides whether the view follows. Within that, the button never shows. Further up, it shows when the chat's last item changed since the view was last at the bottom, or when more than a view's height of the chat is below. It is checked after every render of the pane, on every scroll event, and when the pane or its content changes size.
- **"Something arrived" means the transcript changed.** Its blocks are rebuilt from the chat's items, side questions and asks whenever one of them changes. Each streamed delta, new message, finished tool call and side answer does that (`transport.ts`), so this catches a growing reply without measuring heights. A measured height would be wrong in a long chat, where the spacer below the view changes as estimates turn into measurements (ADR 0138). Blocks rebuilt with each one the same as before, as when another chat's ask moves, are no change: they are compared as `TranscriptChunk` compares them (`sameChunkBlock`). A change further up the chat counts, which is rare while the owner reads there.
- **The words say what is below.** **New reply below** while a reply runs, **New messages below** when the chat moved on with none running, and **Go to the newest message** when only the distance shows it. The tooltip names the shortcut.
- **The jump renders the last chunk first, then pins to the bottom and follows again.** In a long chat the bottom of the scroller is the spacer standing in for the chunks after the window. Pinning to it without the last chunk in the page would show empty space for a frame, then land on an estimate. `reveal` renders the last chunk in the same commit (ADR 0138), so the view lands on the real end. A pending jump to a message or tool call is dropped, since the owner has asked to go somewhere else.
- **The button sits in a line of no height at the bottom of the scroller**, `position: sticky`. Showing it changes neither the transcript's height nor the window's arithmetic, and it stays over the bottom of the view however tall the composer is.
- **The shortcut is Alt+End, as the command `jumpToNewest`** (ADR 0147). An app-wide command needs Ctrl or Alt. Ctrl+End moves the caret to the end of the composer's text, and the composer usually has focus, so taking it would break typing. Alt+End does nothing in a text field, and it sits beside Alt+↑ and Alt+↓, which already move between chats. It works only in the active pane, as Find does.
- **Clicking the button puts focus in the composer** when the button had it, since the button goes away.

## Considered options

- **A line in the status bar** (issue #31's approach 2). Rejected: the status bar can be hidden, which hides the cue.
- **A key alone** (approach 3). Rejected: it can't be found, which is the problem.
- **Counting the new messages below.** A streaming reply is one message that grows, so the count would read 1 for most of a reply. The words say a reply is coming instead.
- **Ctrl+End as the default.** Rejected for the reason above. The owner can bind it on the Keyboard Shortcuts page, where it saves.

## Consequences

- A new way to leave the bottom of the chat needs no change here: the button reads the scroller and the transcript's blocks, not the reason the view stopped following.
- With a find query typed, the whole chat renders and the view doesn't follow a reply (ADR 0138). The jump still lands at the end, and following starts again once the query is cleared.
