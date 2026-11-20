# Every chat is windowed, in chunks of about 16 blocks, and opens on its last chunk

> **Accepted.** Issue #124. Amends [ADR 0138](0138-a-long-chat-renders-in-chunks-and-only-the-ones-near-the-view.md): no chat renders whole for having few chunks, a chunk holds about 16 blocks, not 64, and the first render is the last chunk, not the last two.

Opening the owner's HighWing Bot Chat (186 messages) took 0.5 to 0.7 s from the click to the messages on screen, in the real app on Linux. Its 4 chunks were at ADR 0138's limit, so the whole chat was laid out in one frame. Short Bot Chats opened in 0.1 to 0.3 s.

## Where the time went

`bench.profileOpen` (`bench/main.tsx`) opens the bench's chat with one kind of item taken out, in WebKitGTK 2.54 (`bench/webkit.py`). For the 80-turn chat (404 items, 263 blocks in 4 chunks, drawn whole), the median of 3 runs from mount to the second frame:

| The chat | ms |
| --- | --- |
| As it is | 342 |
| Without tool calls | 311 |
| Without thinking | 329 |
| Without the replies | 66 |
| Replies with their Markdown syntax taken out | 142 |

The replies' Markdown is most of the cost: parsing it, and laying out and painting what it makes. Code highlighting was already cached. Tool calls cost about 20 ms and thinking almost nothing. Reading sizes forced 20 to 25 ms of layout. So the cost of a first frame is about the number of replies in the page, not the number of chunks. A chunk is a poor measure of that, because where chunks start depends on a hash: in this chat they held 80, 21, 84 and 78 blocks.

## The two questions in #124

- **Is a limit of four chunks right?** No. There is no number of chunks below which drawing the chat whole is cheap enough, and the window already draws a short chat whole by itself: it keeps every chunk in view and a view's height of them above. Weighing chunks by their blocks would only move the limit. The limit is gone.
- **Does drawing the tail first help?** Yes, and more when the tail is one chunk. The first render was the last two chunks; the window is placed in the same commit and then usually kept only the last one, so the other was rendered for nothing. The cost after that is the size of the last chunk, so smaller chunks help even chats that were already windowed.

Median ms from mount to the second frame in WebKitGTK, 10 runs each, the builds taken in turn:

| Turns (chunks of 64) | Whole up to 4 chunks (before) | Windowed, last 2 first | Windowed, last 1 first | Chunks of 16, last 2 first |
| --- | --- | --- | --- | --- |
| 40 (3) | 189 | 73 | 69 | 56 |
| 60 (4) | 294 | 95 | 42 | 34 |
| 80 (4) | 386 | 177 | 135 | 80 |
| 200 (windowed before too) | 301 | 277 | 307 | 57 |

## Decisions

- **Every chat is windowed.** A chat renders whole only while a find query is typed, and in a pane whose scroller has no height yet, as before.
- **A chunk holds about 16 blocks** (`CHUNK_SIZE` in `src/ui/transcriptChunks.ts`). A chunk starts at a block whose id hashes to a multiple of 16. Every start of a 64-block chunk is still a start.
- **The first render is the last chunk.** The window is placed in the same commit, before the page is drawn, and adds the chunks above it that are in view or a view's height above it.

## Measured

On 2026-11-20, against main `9a030ca`, in the real app on Linux (`hv build`, WebKitGTK 2.54) against the stand-in, with the builds run in turn. `bench/bot-switch/open.sh` opens ada's Bot Chat from a new chat with ada, so there is no profile switch and the chat's Saved copy is already on this computer, and times the click to the messages on screen with `probe.js`. Other sessions kept the load average at 22 to 56 on 24 cores.

- The bench's 93-turn chat (186 messages, 4 chunks of 64): 925 ms at the median of 20 opens (787 to 1,075), down to 245 ms (202 to 524). The page holds 32 messages, not 186.
- Its 200-turn chat: 239 ms at the median of 12 opens (145 to 1,332), down to 89 ms (74 to 124). The page holds 12 messages, not 31.
- Every open landed at the bottom of the chat and stayed there for the 60 frames after the messages showed.
- A reply streamed into the bench's 200-turn chat in WebKitGTK takes a frame of 17 ms at p50, as before.
- `bench/app-split/window.mjs` passes at 1000 turns and at 93: the chat opens at the bottom with few messages in the page, 40 wheel steps of 150 px and 25 of 400 px up each move what is in view exactly that far as chunks come and go, find counts every match in the chat, and the view holds still above a streaming reply and follows it at the bottom.

## Considered options

- **Keep chunks of 64 and only drop the limit.** It brought the 186-message chat to 236 ms, the same as chunks of 16, since its last chunk happened to be small. On the 200-turn chat it stayed at 144 ms, against 89 ms, because a last chunk of 64 blocks on average, and often many more, is still rendered whole.
- **Draw only part of the last chunk first and the rest a frame later.** Not done: the work is the same, only moved to the next frame, where it would hold up the owner's first scroll. A smaller chunk does less work.
- **A cache of parsed Markdown across opens.** Not done here: it would help a chat opened again, but not the first open, and the window now keeps the work small.

## Consequences

- In a chat taller than about two views, Select all (Ctrl+A) covers only the messages in the page, as it already did in long chats. ADR 0138's other consequences (an opened tool group closes when its chunk leaves the page) now apply to every such chat.
- The window moves more often while scrolling, each time by a smaller chunk. In WebKitGTK, scrolling the 800-turn bench chat 120 px a frame had 18 to 30 frames over 20 ms in 400, up from 7 to 9, and its longest frame fell from 131 to 150 ms to 92 to 121 ms. Scrolling the 200-turn chat 400 px a frame had 35 to 49 frames over 20 ms, up from 21 to 25, and its longest frame fell from 239 to 304 ms to 86 to 91 ms. The whole scroll took as long as before.
