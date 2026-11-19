# A Group room is the connection's, not a Chat, and its floor says whose move it is

> **Superseded by [ADR 0232](0232-group-rooms-are-removed-and-an-at-in-a-bot-chat-asks-the-named-bot.md).** Group rooms are gone (#82): no code calls `groups.*`, and the files this ADR names were deleted. Rooms already on the server stay there; the app never lists, opens, disbands or deletes them, and their `Group: <room_id>` sessions stay out of every list. Bots message each other from their Bot Chats (ADR 0207), and the owner brings one in with an @ in a Bot Chat.

The owner wanted to put 2 to 6 bots in a room, watch them take turns, and join the conversation. Hermes already hosts such rooms. It calls them Group Chat and serves them as `groups.*` on the dashboard's `/api/ws`, with no setting to turn on. Highwing called none of those methods.

Three facts about Hermes shaped the design. Each was observed on 2026-11-17 against a standalone `hermes dashboard` at `ae2a81cc`, or read from the source of the owner's builds, `bf0203a` and `f0d9488`.

- A room is stored once for the whole install and spans profiles. A `Snapshot` holds the chats of one profile, over one socket.
- A room has several named speakers and whole replies. Nothing streams. Who is working, and in which tool, shows only in `groups.state`.
- The owner's builds have rooms but no `groups.continue` and no `groups.changed` push.

## Decisions

- **A Group room belongs to the connection, and it is not a Chat.** `GroupRoomsStore` hangs off `Hermes` beside `projects`, with its own `subscribe`, outside the `Snapshot`. Rooms never enter `snapshot.chats`. `Chat`, `Item`, `chatKind.ts`, `snooze.ts` and `ChatPane.tsx` are unchanged. No profile switch, list sync or per-profile cache can drop a room, because none of them holds one. Opening a room switches no profile.
- **Three sources, merged in one place.** `RoomLog` is a pure, idempotent fold of `groups.log` into transcript entries and the current discussion. `RoomLive` is one parsed `groups.state`. `Outgoing[]` is this app's unsent messages. Hermes writes the first two and the app writes the third. Only `roomView()` merges them.
- **One read is state, then log, folded only up to that state.** A tick reads `groups.state`, then `groups.log` from the cursor, and folds no event past the state's `latest_seq`. A view never shows a bot writing beside the reply it already posted. A log shorter than the cursor means Hermes's store was replaced, so the room is read again from its tail. An answer from before a reconnect is dropped.
- **`Floor` is the one answer to "whose move is it".** It is a union of seven kinds: `gone`, `approval`, `speaking`, `starting`, `stuck`, `paused`, `yours`. `floorOf` picks the first that applies, in that order. `FLOOR_SURFACE` is a table with a row for each kind. It says whether the room is read at the fast rate, which Rail inbox kind it is, and when it counts as needing the owner. The pane's strip, the composer's hint, the list row, the Bots tab's badge and the inbox entry all read it. A new kind does not compile until it has a row.
- **Four things raise a room to the owner, and each is Hermes's own state.** An approval waits. The discussion paused at its cap. The discussion finished and the owner hasn't read it. A bot is inside `clarify`. No Hermes build lets a bot summon the owner, so nothing else does.
- **A question in a reply only rewords attention.** `asksOwner` reads a reply's text. It can turn "The bots are done" into "Ada asked you something", with Jump to it. It never raises attention by itself.
- **A bot in `clarify` is `stuck`, never `speaking`.** On a dashboard a room's bot still has the `clarify` tool. Its question shows nowhere, and after about 90 seconds Hermes goes on without an answer. The strip names the bot and offers Stop.
- **The store exposes intents, not wire verbs.** They are `create`, `say`, `retry`, `continue`, `carryOn`, `stop`, `answer`, `rename` and `disband`. The store mints the `room_id` and each `event_id` and reuses them for a retry, so nothing posts twice. It maps an opaque approval key to Hermes's tuple. Every `groups.*` shape is read and written in `groupRooms.ts`, and no wire type is exported.
- **Every owner message steps in.** `say` sends on the latest discussion's thread. While bots talk, Hermes cancels the queued turn and answers the owner first. The composer's placeholder says so.
- **Continue shows only when Hermes reports it.** `groups.state` says `max_continues` on a Hermes with `groups.continue`. Without it, the pause offers Carry on. Carry on puts the handles the last round named into the composer and sends nothing. The owner's next message carries the discussion on.
- **Polling works alone, and a push only brings a read forward.** A room on screen is read every 2 s while its floor is busy and every 10 s while idle. A busy room off screen is read every 5 s, because an approval shows only in state. A `groups.list` every 30 s finds rooms another client woke. `groups.changed` reads the rooms it names at once. The intervals become five times longer only after a `groups.changed` frame has arrived on the connection. The app trusts a push it has received, not `change_events`, so a server that never pushes keeps the fast rate.
- **A room opens with its last 500 events.** A room first seen is read from its last 50. Earlier messages reads 500 more.
- **Rooms are read only while a screen listens, and only by the composer target.** A background connection (ADR 0125) asks Hermes nothing about rooms.
- **The capability is checked with a read.** `groupRooms` checks `groups.list {limit: 1}`. `groups.capabilities` is not in `APP_METHODS`, so the app can't send it: its first call writes a secret file on the server (ADR 0044).
- **A seat's hidden session never shows as a chat.** Each bot answers in a session titled `Group: <room_id>`, which `session.active_list` lists. `checkLive` drops those rows for known rooms, so none shows as live work or starts a search for its profile.
- **Rooms sit in Bots mode.** A Group rooms section is above the bots, with New room beside New bot. The picker seats bots in the order picked, which is the order they answer in. The room's pane takes the chat pane's place.
- **The Rail inbox gets a `paused` kind, and its entries an optional `roomId`.** A room's entry opens the room.

## Considered options

- **A room as a kind of Chat.** It would reuse the list sections and `ChatPane`. Rejected: `Chat` and `Item` would each gain optional room fields that 25 modules import, and every reader of `snapshot.chats` would have to learn a merged list.
- **One method for each verb, composed by the screens.** Rejected: each screen would own cursors, the race between state and log, the thread to send on and the approval tuple.
- **Hermes Desktop's client-run group chat.** Rejected: the client would copy Hermes's driver and lose its turn order, supersede and approvals.
- **A second socket for rooms.** Rejected for the reason ADR 0203 gives. The one socket reaches every `groups.*` method, whatever profile it is on.
- **Offering Continue everywhere and handling the refusal.** Rejected: on the owner's builds the button would always fail.

## Consequences

- A room has a small transcript and composer of its own. Room replies are whole Markdown, so the copy is small.
- Rooms have no pin, snooze, archive or search. Attention still reaches the Rail inbox, the Bots tab's badge and the Needs-you line.
- On the owner's builds, who is speaking can lag by up to 2 s.
- There is no way to add a remark without interrupting. Every message cancels the queued turn.
- The Group rooms section appears once the capability check has run, about 2 s after the first connection.
- Left out: files in rooms, routing modes and a room's purpose (older builds lack them), bots from other servers, `groups.retry`, and changing a room's roster.
