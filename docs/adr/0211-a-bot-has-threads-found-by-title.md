# A bot has threads, hidden sessions found by their title

> **Superseded by [ADR 0225](0225-bot-threads-are-removed-and-a-bot-has-only-its-bot-chat.md)** (#89). Bot Threads are gone. The files and methods named below no longer exist. Sessions titled `Bot Thread: <topic>` stay on the server as they are.
>
> **Accepted.** It supersedes ADR 0195's decision "Bots mode has the shown profile's chats under its bot": a bot's threads are under its row instead, for every bot. The rest of ADR 0195, ADR 0066 (the Bot Chat) and ADR 0203 (the visit) stand. The title grammar, the shelf parser and the JSON-RPC calls are `src/hermes/threads.ts`. What a thread can do is the `thread` row of `CHAT_POLICY` in `src/hermes/chatKind.ts`. Reading, opening, renaming, deleting and the list filter are in `src/hermes/transport.ts` (`readThreads`, `newThread`, `openThread`, `threadFromHere`, `renameThread`, `deleteThread`, `apart`, `hideStray`). The disclosure is `ThreadDisclosure` in `src/ui/Threads.tsx`. Tested in `src/hermes/threads.test.ts`, `src/hermes/chatKind.test.ts`, `src/hermes/threadsTransport.test.ts`, `src/hermes/fakeHermesThreads.test.ts`, `src/ui/bots.test.tsx`, `src/ui/chatListModesTranslated.test.tsx` and `e2e/features/bot-threads.e2e.tsx` (#24).

A bot had one conversation, its Bot Chat (ADR 0066). The owner wanted to take one topic aside with the same bot without filling the Bot Chat with it, and to come back to that topic later. Hermes has no thread concept. It has titles that are unique in a profile, a hidden flag, an exact title lookup that has no window and follows a compacted session to its newest one, and a listing that can include hidden sessions. Hermes's own desktop keeps its side threads as ordinary visible sessions and has no list of them per bot.

## Decisions

- **A thread is a hidden session in the bot's profile titled `Bot Thread: <topic>`.** The profile and the title are its whole identity. Nothing about a thread is kept on this computer, no parent link is read, and no session id outlives one read. `threadTopic` in `threads.ts` is the one recogniser. The chat kind, the list and search filters and the shelf parser all read it. The prefix is never translated, since Hermes stores it.
- **A title that ends in ` #<digits>` isn't a thread.** Hermes names a copy it makes that way ("Bot Thread: VLAN plan #2"), as it names a copy of the Bot Chat "Bot Chat #2". Such a copy is an ordinary visible chat. `threadTitle` rewrites a topic that ends that way, so every title the app makes is a thread's.
- **A topic is one line of at most 80 characters.** Hermes takes a title of 100. A second thread on a topic that already has messages is named `<topic> (2)`, then `(3)`.
- **A bot's threads are read from one listing.** `session.list {profile, include_hidden: true, limit: 500}` answers the profile's latest sessions, last active first, with a compacted session as one row. The rows with a thread's title are the bot's shelf, in that order, kept in `snapshot.threads` by profile.
- **A full window can't say a thread is gone.** When the listing fills its 500 rows, each thread the shelf held that the listing lacks is looked up by its title before it is dropped. The disclosure then says older threads may not be listed.
- **The threads are read after the roster, while Bots mode shows.** Every bot's are read as Bots mode opens, unless read in the last 60 seconds, and every 5 minutes. The shown bot's and the open disclosures' are read with each 15-second roster read. A bot's are read at once after a thread of it is made, renamed or deleted here.
- **A listing that began before a thread changed here is asked for again.** Each profile counts the threads this app made, renamed or deleted. A listing that started at an older count may not show the change, so it isn't shown.
- **A read that fails keeps the threads read before, with the reason.** A bot whose threads were never read says "Threads", never "No threads".
- **New thread converges on one session for a topic.** It looks the title up first. An empty thread with that title opens, so a second Enter or a start cut short makes no second one. A thread with messages sends it to the next free title. Otherwise it calls `session.create {profile, title, hidden: true, follow_profile_config: true, source}` with no parent, then `session.title`, which stores the session. When another client takes the title in between, it looks again. No message is sent.
- **Thread from here is a branch that Hermes names and the app hides.** It reuses the Branch preview, the fingerprint check and the attempt journal (ADR 0027). A free title is chosen by exact lookup before the call. `session.branch {session_id, count, name, idempotency_key}` makes the copy under that title. The app hides it with `PATCH /api/sessions/{id} {hidden: true}` before it reads it back. A copy that holds other rows than the preview showed is deleted. A thread gets no link back, no pin and no rename, and is switched to the Bot Chat's model as a branch is.
- **A lost answer is settled by the title.** No chat list shows a hidden session, so a thread attempt is found by an exact title lookup and the same check of its rows. Asking again from the same message goes out under the same title and key.
- **The app hides with the session edit it already sends.** `PATCH /api/sessions/{id}` takes `hidden`. `session.set_hidden` isn't used, since it would be one more method to record and check on every Hermes.
- **A thread the visible list reports is hidden again.** Only the archived view lists hidden sessions, so a thread any other view lists isn't hidden. Its hiding was cut short, or another client showed it. The row is kept out of the list by its title and hidden once per session on a connection. The repair keeps no state, so it also heals a thread left visible by another computer.
- **The chat list and search leave a thread out by its title, read before the Bot Chat rules.** A thread branched from the Bot Chat can be reported with the Bot Chat as its lineage root. It is a thread all the same, and is never marked as the Bot Chat.
- **A thread's rules are a row of the policy table.** `CHAT_POLICY.thread` is out of the list, in the Inbox, with Edit and Regenerate, without Branch, Thread from here, Pin, Archive or a chat link, deletable, and renamed by topic. `ofBot` is shared with the Bot Chat. It keeps a bot visit going, takes no title from the first message, and makes `/new` compact the chat. The table's `manage` column became `organize` (Pin and Archive) and `remove` (Delete), and `rename` says how a kind is renamed.
- **An ordinary chat can't be renamed into the pattern.** It would leave the list and sit under the bot as a thread no one started. A chat renamed into it by another client is a thread here from the next list read.
- **Every bot's row has a disclosure.** It says "N threads" or "No threads" and, open, lists the threads with New thread below. It is open while the bot's Bot Chat or one of its threads is on screen, and the owner's own choice is kept until the app closes. New thread opens a Topic field. Enter starts the thread and Escape leaves. A right-click, Shift+F10 or the Menu key on a thread offers Rename and Delete. Up and Down walk the bots, the disclosures and the threads as one list.
- **A thread's pane is headed by its bot, its topic and a Thread badge.** Its tab says "<Bot> / <topic>". Thread from here sits beside Branch from here under each message of a Bot Chat.
- **A thread opens through the bot arrival.** A thread of a bot in another profile is a visit, as its Bot Chat is (ADR 0203). The title is looked up at each open, and the session it names now is the one that opens.
- **A rename or a delete finds the thread by its title first.** A rename goes to the session that holds the title. A delete goes to the newest session, and Hermes deletes a compacted thread's earlier sessions with it.
- **The shown profile's chats are no longer under its bot.** The "<Bot>'s chats" group and "All N chats" are gone. Chats mode has the profile's chats.

## What a compaction changes

Nothing a thread is found by. Hermes compacts a chat in place, or moves it to a new session that is a child of the old one.

- When the Bot Chat moves, its `canonical_session` reports a new newest session. No thread reads it.
- When a thread moves, the listing shows it as one row under its newest session, with its first session as `_lineage_root_id`. That first session is the row's key in the disclosure, so the row stays the same row. The title lookup answers the newest session, which is what opens.
- New thread sends no parent. A session whose parent ended by compaction, and that carries no branch mark, is read by Hermes as the parent's continuation. A new thread with the Bot Chat as its parent could be taken for the Bot Chat once the Bot Chat moves.
- Thread from here makes a branch, which Hermes marks `_branched_from`. Hermes never takes it for the Bot Chat's continuation.

## Considered options

- **The parent link as the marker**, a thread being any session whose parent is the Bot Chat. Rejected. Hermes can read such a child as the Bot Chat's continuation, and the grouping would move when the Bot Chat does.
- **A registry of thread ids on this computer.** Rejected. It is a second source of truth that a second computer, a compaction or a reinstall puts out of step.
- **Visible threads, as Hermes's desktop keeps its side threads.** Rejected by the owner. The threads would fill Chats mode and every other client's list.
- **A tag in the title, such as a `[thread]` suffix.** Rejected. A prefix reads as a name in any Hermes client, pairs with "Bot Chat", and sorts the threads together.
- **A `thread` flag on the chat, beside `bot`.** Rejected. It is one more flag to keep in step with a title that already says it.
- **A second pipeline for Thread from here.** Rejected. It would copy the preview, the fingerprint check and the lost-answer rules of Branch.
- **Keeping the profile's chats under the bot, beside its threads.** Rejected by the owner. Two lists under one row, of two kinds, read as one.

## Consequences

- Other Hermes clients don't list a thread.
- An ordinary chat someone titles "Bot Thread: x" becomes a thread, hidden and under its bot. One recogniser was chosen over an exception for it.
- Edit, Regenerate and a numbered copy made in another client produce an ordinary visible chat, as they do from a Bot Chat.
- A thread isn't archived from this app, since the title lookup doesn't find an archived session. One archived in another client leaves its bot's shelf and isn't listed in Archived here.
- A thread started on another computer shows in the count within 5 minutes, or at once with Reload.
- Hermes's listing reports when a session started and not when it was last active. A thread's row is placed by its last activity and shows its start time, until Hermes reports the other.
- A profile with more than 500 sessions newer than a thread lists that thread only if this app has listed it before in the same run.
- The reasons the transport gives when a thread can't be started, opened, renamed or deleted are in English, as its other reasons are. The words around them come from the catalogue (ADR 0100).
- The Branch dialog's history, tool output and attachment sections are shared with Thread from here and are still English in every language.
