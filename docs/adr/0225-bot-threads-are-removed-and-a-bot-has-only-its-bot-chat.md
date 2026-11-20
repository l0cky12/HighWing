# Bot Threads are removed, and a bot has only its Bot Chat

> **Accepted.** Issue #89. It supersedes [ADR 0211](0211-a-bot-has-threads-found-by-title.md). ADR 0066 (the Bot Chat), ADR 0195 (the two modes), ADR 0203 (the visit) and ADR 0027 (Branch from here) stand. Tested in `src/ui/bots.test.tsx` ("Bots mode without threads"), `src/hermes/chatKind.test.ts` and `src/hermes/branch.test.ts` ("what this computer kept").

A Bot Thread was not a thing of its own. It was an ordinary hidden Hermes session titled `Bot Thread: <topic>`, and the title was its whole identity. There was no thread id, nothing kept on this computer and nothing in the Rust layer. Each thread action cost a `session.list {title, include_hidden: true}` lookup, Bots mode read every bot's hidden sessions on a timer, and a Hermes that keeps only canonical sessions would have broken the feature.

The owner wants one model: a bot has its Bot Chat. A side conversation is another Bot Chat, an ordinary chat in the bot's profile, or a new bot.

## Decisions

- **Everything that read or wrote the title prefix is gone.** That covers the title grammar and shelf (`threads.ts`), the `thread` chat kind and its policy row, the `threadFrom` policy column, the transport's thread methods, the thread shelf in the snapshot, the stray-thread repair that hid listed threads again, the disclosure under each bot row, the thread arrival, the pane's topic and Thread badge, Thread from here, and their catalogue strings and styles.
- **Bots mode reads the roster only.** It reads the roster every 15 seconds while it shows and when Reload is pressed, as ADR 0203 says. It no longer reads hidden sessions. Reload stays: it came before threads and reads the roster and what is live.
- **Branch from here is as it was before ADR 0211.** `session.branch` goes without `name`, a branch is never hidden, and the Branch dialog has one set of words again. Edit and Regenerate still branch a Bot Chat.
- **A session titled like a thread is an ordinary session.** A hidden one isn't listed, as no hidden session is. A visible one is an ordinary chat in Chats mode and search. Nothing is migrated, hidden again or deleted on the server.
- **The archived view leaves hidden sessions out.** Hermes's `archived=only` view is its one list that returns hidden rows, when they are archived too. The thread title kept old threads out of it before. The `hidden` flag on the row does it now, for any hidden session but a Bot Chat. Such a session listed there could be restored but would stay hidden, and leave the list again at the next launch.
- **An attempt kept for a thread is dropped.** An older version kept a Thread from here attempt beside the branch attempts on this computer. Such an attempt is not loaded, so it is never looked for as a branch.

## Considered options

- **Keep threads and fix their cost.** Rejected by the owner. The feature looked like a chat in another drawer, and it needed its own registry, polling and policy.
- **List the old thread sessions as ordinary chats.** Rejected. They are hidden on the server. Showing them would mean reading hidden sessions again, which is what this removes.
- **Delete or unhide the old thread sessions on the server.** Rejected. That deletes or changes the owner's data, and the issue keeps that out of scope.

## Consequences

- Threads made by an older version stay on the server, hidden. Hermes's own clients and its search still find them.
- Hermes search returns hidden sessions, and its rows don't say which are hidden. An old thread can come up there, and it opens as an ordinary chat. Leaving it out would mean reading the title prefix again.
- The fake Hermes keeps the behaviours it learned for threads (`hidden` on `PATCH`, `session.branch` with `name`, `session.list` with `include_hidden`), since they are Hermes's. `src/hermes/fakeHermesSessions.test.ts` still tests them.
