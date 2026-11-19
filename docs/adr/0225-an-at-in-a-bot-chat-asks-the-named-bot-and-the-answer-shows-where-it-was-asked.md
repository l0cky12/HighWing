# An @ in a Bot Chat asks the named bot, and the answer shows where it was asked

> **Accepted.** Issue #75. Supersedes [ADR 0210](0210-a-group-room-is-the-connections-not-a-chat-and-its-floor-says-whose-move-it-is.md) and [ADR 0219](0219-a-rooms-addressees-are-read-with-hermess-own-rule-and-shown-before-send.md) in full: Group rooms are removed. Changes [ADR 0165](0165-a-referenced-chat-goes-as-a-summary-with-its-message.md): in a Bot Chat the picker lists bots, a message that names one references the chat it is written in, and such a message isn't queued. Leaves [ADR 0207](0207-bots-message-each-other-through-hermess-message-agent-which-the-owner-turns-on-in-bots-mode.md) as it is. The line machine is `src/hermes/askLine.ts`, the desk `src/hermes/asks.ts`, the card `src/ui/AskCard.tsx`. Tested in `src/hermes/askLine.test.ts`, `src/hermes/asks.transport.test.ts` and `src/ui/askABot.test.tsx`.

The owner had two ways for bots to talk. Bot messaging (ADR 0207) lets a bot message another from its own Bot Chat. Group rooms (ADR 0210) put several bots in a room with a floor, rounds, pauses and room approvals. The owner wants one model. Bots talk in their own Bot Chats, and the owner brings a bot in by typing `@` and picking it, the way a person tags @grok in a thread on X to get its answer.

## Decisions

### Group rooms are removed

- **The app calls no `groups.*` method.** The room screens, the room store, the `groupRooms` capability, the room entries in the Inbox, the goes-to line and the stand-in server's rooms are gone. The `hermes-chat.group-rooms-read.*` keys are deleted from this computer once at startup.
- **Rooms already on a server stay there.** The app never lists, opens, disbands or deletes one.
- **A room seat's session is hidden by the source Hermes stores, never by its title.** Hermes creates each seat's session with `source: "bot_room"` (`ROOM_SESSION_SOURCE`, `tui_gateway/hosted_room_driver.py` at v0.22.6 and v0.23.2). `session.list` rows and `GET /api/sessions/{id}` carry that source. `session.active_list` rows carry no source, so a live row titled like a seat is looked up once and hidden only if its stored source says so. Hermes titles a seat `Group: room-<uuid>`, and its preview can read `[Discussion: …] You are @x`. A chat the owner names `Group: x` still shows, because its source is not `bot_room`.

### The `@` picker in a Bot Chat

- **The picker lists a Bots group above Chats.** It holds every bot on the connection but the bot whose chat it is, each with its colour, name, `@handle` and description. It matches the start of the handle or of any word of the name, and doesn't fold accents. Enter or Tab puts `@handle` in the words, shown as a pill. Outside a Bot Chat the picker lists chats only (ADR 0165).

### An Ask

An **Ask** is a message sent from a Bot Chat that names one or more other bots.

- **The message goes to each named bot, and the bot whose chat it is takes no turn.** It goes into the named bot's own Bot Chat, in that bot's profile, as the owner's message. That chat shows it and the reply as an ordinary turn. Nothing is submitted to the chat it was typed in.
- **It is the owner's own message, not a relay.** Hermes stores it as a user message the owner sent. It needs nothing from Bot messaging, so it works with **Bots message each other** on or off, and it never turns that switch on.
- **It goes over the connection the asking chat is shown on.** `session.resume {session_id, profile}` resumes the named bot's Bot Chat on the socket opened for the shown profile, and `prompt.submit` goes to that session. Hermes routes a session's events to the transport that resumed it, not to a profile (`tui_gateway/server.py:582` at v0.23.2), so the reply streams back on the same socket. This was run against Hermes v0.22.6: the reply arrived on the socket opened for the other profile, and the asking chat's session took no turn.
- **The chat it is sent from goes with it as a Referenced chat.** While the words name a bot, the composer shows a chip for the chat being written in, titled "Bot Chat with <bot>". The owner can remove it, and then the message goes without it. It is added once while a bot is named and taken away when none is. A chat with no messages yet has nothing to reference, so it gets no chip.
- **Every Ask also carries where it was asked from.** One block of attached context of its own, `[Asked from: <asking chat's id>]` and one line saying the owner sent it from their Bot Chat with the other bot, goes before any Referenced chat. Both Hermes clients hide attached context, so the bot's Bot Chat shows only the owner's words.
- **A bot with no Bot Chat gets one.** It is found by title or created as opening it from Bots mode does (ADR 0066), and a lookup that fails sends nothing.

### The Asked card

- **The asking chat shows an "Asked @handle" card.** It holds the owner's message, its chips, and under them the named bot's face and name over its reply, which streams in as Markdown. A message that names two bots shows two cards.
- **A card is never one of the chat's items.** Asks are kept apart, in `Snapshot.asks` by the chat they were sent from, and only the transcript's rendering puts them among the items. So the Saved copy, exports, branches, Edit, Regenerate and the queue can't see one, as for a side question (ADR 0086). A card shows after the item that was the chat's last when it was sent. When that item's id has gone, it shows after as many items as the chat had then.
- **Whose turn is whose is told by order.** Hermes's `message.start` names no message. Hermes answers `prompt.submit` with `streaming` when the turn started, or `queued` when it holds the message, and it runs held messages first in, first out. `askLine.ts` is a pure machine over those facts. A turn that starts with none of ours waiting is someone else's. A turn that starts before Hermes has answered is kept until the answer says whose it is.

### Busy, offline and failed

- **An Ask is always submitted for Hermes to hold (`queued: true`).** A plain `prompt.submit` to a session with a reply running redirects or interrupts that reply (`_handle_busy_submit`, `tui_gateway/session_auto_continue.py`). Held, the message is stored at once and runs when the bot is free, with no client attached.
- **The card says which state applies.**

  | State | What the card says | Buttons |
  | --- | --- | --- |
  | Offline | "You're offline. This goes to Bram when the connection is back." It goes when the app reconnects. | Dismiss |
  | Sending | "Sending to Bram…" | |
  | Busy | "Bram is busy with another reply. Hermes gives it your message when that reply ends." | |
  | Replying | The reply so far, or "Bram is replying…" | |
  | Waiting on the owner | "Bram is waiting for your answer, which only its own Bot Chat can take." | Open Bram's Bot Chat |
  | Stopped | "Bram's reply stopped before it finished.", with Hermes's reason | |
  | No longer heard | "Highwing stopped hearing Bram's reply here. The reply continues in Bram's Bot Chat." | Open Bram's Bot Chat |
  | Failed | "Not sent to Bram." and why | Dismiss, Retry |
  | May have arrived | "Bram may already have this message." and why | Dismiss, Open Bram's Bot Chat, Retry |

- **An Ask Hermes hasn't confirmed is in the named bot's outbox.** It is kept there on this computer from before it goes, with its files and summaries, as any message is (ADR 0006). So an Ask that failed, or was on its way when the app closed, is a Failed message with Retry in that bot's Bot Chat, and the Inbox lists it. Reading that chat's history settles one that may have arrived. Retry on the card sends the same words, files and summaries as a new message, and nothing sends one again by itself.
- **Waiting on references is the composer's rule, unchanged.** The message waits until every summary is ready, and a failed one offers Retry or removal.
- **An Ask isn't queued or steered in the chat it is typed in.** That chat's reply and queue don't hold a message that goes elsewhere, so Enter sends it while the chat's own bot is replying, and the composer says so.
- **An Approval or a Question the named bot asks stays with its own Bot Chat.** The request reaches this connection, and the card says the bot is waiting. Hermes lists the request again when that chat is resumed.

### After a restart

- **The card is rebuilt from the named bot's Bot Chat.** Hermes keeps no record of an Ask in the asking chat. The asking chat's id is in the `[Asked from: …]` block of the message Hermes stored in the named bot's chat. On opening a Bot Chat, the app reads the other bots' Bot Chats for messages stamped with one of this chat's ids, and rebuilds a card from each with the reply that follows it. This PR writes the block. The read is a later PR of the same issue.
- **The block is its own, not part of the reference.** The owner can remove the reference, and the card must still come back. A reference's summary is read back up to the next reference or the end of the message (`storedReferences`), so a stamp after one would be read as summary and sent again by Edit.
- **It holds an id, never a title.** A Bot Chat's title is the same for every bot. When Hermes compresses the asking chat its id changes, so the read matches every id of the chat's lineage (`Chat.lineage`).
- **It survives the named bot's chat being compressed.** `GET /api/sessions/{id}/messages` always loads the compression lineage, and `include_compacted=true` adds the rows compaction archived (`hermes_cli/web_routers/sessions.py:770`, `hermes_state_messages.py:58` at v0.23.2). This was read in the source. The stub model's summaries are longer than the chat, so Hermes refused to compress and it could not be run.
- **Until that read lands, a card lasts as long as its chat stays on screen.** A profile switch or a restart drops it. The message and the reply are in the named bot's Bot Chat.

## Considered options

- **The app relays the message between the two bots.** Rejected by the owner in ADR 0207, and still rejected: a relay stops when the app closes.
- **Send the message to the bot whose chat it is, and let it call `message_agent`.** Rejected. It spends a turn of the wrong bot, needs the switch on, and the bot may rephrase or not send.
- **Hold the named bot's Bot Chat as a second chat in the transport and drive it with the ordinary send path.** The card would be a view of that chat's turn. Rejected: the transport holds one profile's chats in about sixty places, and this changes fourteen of its functions and the send path's signature. The desk beside the transport adds four hooks and leaves that code alone.
- **A second socket for the named bot's profile, or polling its history over REST.** Rejected once the prototype showed the reply streams on the socket already open.
- **Submit without `queued`.** Rejected: it interrupts whatever the named bot is doing.
- **Refuse an Ask while offline, as a message with references is refused the queue.** Rejected: the summary describes the asking chat when the owner asked, which is still what the bot should read when the message goes.
- **Asks as a kind of item.** Rejected for ADR 0086's reason: every reader of `items` would need to leave them out.
- **The stamp inside the Referenced chat block.** Rejected, as above.
- **Check each held Ask's turn against its stored row.** A read after every turn would catch the case below. Left out until the read from the named bot's chat exists, which gives it for free.

## Consequences

- An Ask to a bot costs a `session.resume` of that bot's Bot Chat on this connection, once per bot per connection, which returns its history.
- The summary of the asking chat is made when the first bot is named, with the Text generation model, so naming a bot in a draft costs one `llm.oneshot`.
- When another Hermes client has a message held for the same bot ahead of an Ask, the card shows that other turn's reply until it is rebuilt from the bot's history.
- The reply in the card is the bot's words. Its tool calls and thinking show only in its own Bot Chat.
- The named bot's Bot Chat becomes Unread like any chat that got a reply, though the owner read the reply in the card.
- A bot's Bot Chat opened fresh now shows the messages this computer keeps for it that Hermes hasn't confirmed. Before, they showed only once the chat was in the synced list.
- The stand-in server holds a `queued` prompt behind a running turn and runs it after, and its scripted turns go by the typed words, not by what is attached.
