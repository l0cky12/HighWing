# Handed-off work shows on the card of the call that sent it, from Hermes's records only

> **Accepted.** Issue #93, part one of three: a bot's message to a teammate. Kanban tasks and Subagents follow under the same rule. Amends [ADR 0207](0207-bots-message-each-other-through-hermess-message-agent-which-the-owner-turns-on-in-bots-mode.md): the answer is joined to the message that asked for it, by delivery id, and the "Messaged" card keeps Hermes's ack after a reload. The parsers are `ackOf`, `withdrawal` and `deliveryLines` in `src/hermes/agentMessages.ts`. `fillStoredResults` in `src/hermes/transport.ts` reads acks back, `SentCard` and `DeliveryLineRow` in `src/ui/ChatPane.tsx` draw the lines, and `toItem` in `src/hermes/chatCache.ts` keeps the call's id in the Saved copy. Tested in `src/hermes/agentMessages.test.ts`, `src/hermes/agentMessages.transport.test.ts` and `src/ui/botMessaging.test.tsx`.

The owner wants to follow work from the chat where it began, after it has been handed off. Today that work is spread across several places:

- the "Messaged @x" card and, much later, a Returned result for its answer;
- the Subagents panel, which forgets a subagent once it ends (ADR 0196);
- the Work page.

The owner's rule for this feature: every line comes from something Hermes sent or stores. No step, percentage, estimate or activity is made up, and anything Hermes doesn't say stays unsaid.

What Hermes 0.23.2 sends about a `message_agent` call was read in its source (`tools/bot_mode_dm.py`, `gateway/session_bot.py`):

- **At the call, the ack.** It has `status` (`queued`, or `claimed` when the teammate's chat already held it), `delivery_id`, `process_id`, `reply_delivery` (`notification` or `poll`), `target_state`, and for a notice `expects_reply: false`. When the admission couldn't be confirmed, it has `status: "ambiguous"` with an error that says not to send again.
- **Between the ack and the answer, nothing.** The delivery runner polls the teammate's receipt without sending anything to the sender (`_wait_live_dm`). The receipt's link to the teammate's session is dropped before the sender sees it.
- **At the end, the `process_complete` row.** The runner's JSON in it carries the same `delivery_id`. After 30 minutes the runner stops waiting and reports `pending`.
- **After a reload, the ack is still stored.** `session.resume` leaves tool results out (`tui_gateway/session_history.py`), but the call's stored tool row keeps it, and `GET /api/sessions/{id}/messages` returns that row.

The gaps only Hermes can fill are filed as NousResearch/hermes-agent#157823.

## Decisions

- **The card of the call that sent the work carries what Hermes said about it.** Lines go under the message on the "Messaged" card. The card updates in place, and no new message is added to the chat.
- **The lines are a pure function of the call's ack and the items after it.** HighWing saves nothing extra:
  - no progress log;
  - no new kind of item;
  - no second store beside the transcript.

  The same items always give the same lines, so a resume, a replay or a repeat changes nothing.
- **The ack is the only source for the lines it gives.**
  - "Queued for @x", or "@x's Bot Chat had already taken it", from `status`.
  - "@x was … when it was sent", from `target_state`. Hermes sends it once and never updates it, so it is worded for the moment of sending.
  - "Sent as a notice: no answer comes back", from `expects_reply: false`. A notice is never shown as a failure.
  - "The answer comes back only when this bot asks", from `reply_delivery: "poll"`.
  - "Hermes couldn't arrange for the answer to come back", from `notification_error`.
  - "Hermes couldn't confirm it was delivered", from `status: "ambiguous"`. Before, that ack showed as "Not sent", which it may not be.
- **Between the ack and the answer, the card says Hermes reports nothing.** The line is "Hermes doesn't report @x's progress to this chat", with how long ago the message went on the app's minute clock. There is no spinner and no "working", because nothing says the teammate is working.
- **The answer is joined by delivery id and by nothing else.** The Returned result whose `delivery_id` is one of the ack's ends the card with Hermes's status:
  - Answered;
  - The delivery failed;
  - Withdrawn;
  - Hermes stopped waiting, and a later answer won't come back here;
  - Hermes can't tell whether it was delivered.

  "Go to the answer" moves to that card. Two messages to one bot have different ids, so their answers never cross. "Answered" is never "done": whether the teammate did the work is in its reply.
- **A withdrawal asked is not a withdrawal done.** A later `message_agent` call with `cancel` set to this delivery id shows "This bot asked Hermes to withdraw it", or Hermes's refusal. Only the answer's `cancelled` status shows "Withdrawn".
- **After a resume, the ack is read back from the call's stored row.** `fillStoredResults` reads `GET /api/sessions/{id}/messages` newest page first, up to the Run view's five pages, and fills the `result` of each `message_agent` call that has none. The match is the row's `tool_call_id`. A result read once is kept for the connection, so a later resume puts it back without a read. A call whose row isn't found keeps the message alone, as before.
- **The Saved copy keeps the call's id**, which Hermes stores, so a card drawn offline keeps its joins.

## Considered options

- **A ledger of observed updates, saved on this computer.** Rejected by the owner. It would be a second record of the chat to keep in step with Hermes, holding updates no one can check later. Almost every fact the cards need is stored by Hermes and can be read again. The ones that can't are said to be missing.
- **A new kind of transcript item for progress.** Rejected for ADR 0207's reason: every rule about turns, saving and resume would need it added by hand. A resume would also drop it.
- **Showing the teammate's work by reading its Bot Chat over REST.** Rejected. No stored row carries the delivery id, so the match would be a guess. It would also show another profile's chat here.
- **Keeping ADR 0207's "no join".** Rejected. Its reason, that history drops the call's result, holds only for `session.resume`. The stored row keeps it.

## Consequences

- A sent message's card now says what Hermes said about it, and nothing between the ack and the answer. That silence is the true state on 0.23.2 until Hermes sends more (NousResearch/hermes-agent#157823).
- Reopening a Bot Chat reads up to five pages of its stored rows once a connection, and only while a `message_agent` call has no result.
- A `message_agent` call that went out more than 500 stored rows back shows the message alone after a reload, as before.
- An answer with a delivery id that no ack in the chat names still shows as its own Returned result, unjoined.
