# One ScreenControl per connection owns the viewer id and the lease

> **Accepted.** Phase 2 of computer use (issue #43). Amends [ADR 0039](0039-the-side-panel-holds-preview-terminals-files-and-hermess-screen.md): the Screen tab no longer keeps the viewer id or the lease itself.

ADR 0039 put the Bot Desktop's lease in the Screen tab. The tab minted a viewer with `display.observe`, kept the lease Hermes answered and broadcast, and kept the viewers it had held the screen as. The transport kept a second copy of the held viewer, for handing the screen back before leaving a connection, and App kept a third, for the side panel's "you're in control". Only a mounted Screen tab could take the screen. The computer-use card, the refusal note and a Stop that takes the screen all need to know who holds it, and to take it, with the Screen tab never opened.

## Decisions

- **`ScreenControl` is the one writer.** Each connection's `Hermes` has one (`src/hermes/screenControl.ts`). It keeps the viewer id with the connection and profile that minted it, the latest lease, and the hashes of every viewer this app held the screen as. It publishes `ScreenState` into the snapshot: the screen's profile key, the lease's epoch, and the holder as this app sees it (`agent`, `you`, `you-before` for a hold from a connection since dropped, or `someone`).
- **Every lease answer goes through it.** `display.status`, `display.start`, `display.stop` and `display.observe` answers, `display.lease.acquire` and `release` answers, and `display.lease` broadcasts are folded in. An older epoch loses, and a broadcast for another profile's screen is dropped. A broadcast heard before any status has named the screen waits for it.
- **`hold(reason)` takes the screen without the Screen tab.** It mints a viewer with `display.observe` when the connection has none, then acquires. It is idempotent: when this viewer already holds the screen it answers `already` and sends nothing. A stopped screen or a Hermes without one answers `no-screen`, with the reason.
- **`ScreenApi` loses the viewer id.** `observe()`, `takeOver(reason?)` and `handBack()` take none, and `noteHeld` and `onLease` are gone. The Screen tab reads the holder from the snapshot. App reads the side panel's "you're in control" from it too.
- **Leaving still hands back, and a drop still doesn't.** Before a sign-out or a profile switch, `release()` hands back what this connection's viewer holds, waiting at most 1.5 seconds, as ADR 0039 says. A dropped connection keeps the hold, and the snapshot then says `you-before`.

## Considered options

- **Keep the lease in the Screen tab, and mount it hidden when something else needs it.** Rejected: it ties the card, the note and Stop to a React component's lifecycle, and fails while the panel is closed.
- **Publish only the raw lease, and let each reader work out the holder.** Rejected: each reader would need the viewer's hash and the past holds, the three copies this replaces.

## Consequences

- The Screen tab, the computer-use card, the refusal note and the side panel agree on who holds the screen, because they read one value.
- A Stop that takes the screen (phase 4) is a call to `hold()`, whether the Screen tab was ever opened or not. The recordings show a viewer that never opens a stream keeps the lease (`16-hold-no-stream.jsonl`).
- A viewer id is still good only on the connection that minted it. `ScreenControl` checks the connection and the profile before it uses one.
