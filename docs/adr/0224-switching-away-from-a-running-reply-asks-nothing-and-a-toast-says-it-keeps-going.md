# Switching away from a running reply asks nothing, and a toast says it keeps going

> **Accepted.** Issue #74. Amends [ADR 0066](0066-a-bot-is-a-profile-and-its-bot-chat-is-found-by-title-every-time.md): a bot in another profile no longer asks first because a reply is running, only for an Approval or Question waiting. Amends [ADR 0112](0112-saved-connections-have-stable-ids-and-one-is-in-use.md): the question before switching connections no longer lists running replies.

Every switch that leaves a profile used to ask first when a chat in it had a reply running: "A reply is still running in coder. Hermes keeps it going, and it shows here when you switch back." The owner switches between bots often, and answered it every time. The question was only worth asking if the switch could hurt the reply. It can't, so the question is gone.

## Premise, measured

Seven runs on real Hermes `f0d94882` switched profile 3.6 s into a 28 s turn. They finished as fast as the controls (median 28.178 s against 28.188 s, from Hermes's `state.db` timestamps) and stored every reply complete (1439 B each). Nothing interrupted a turn. The app arm drove the real desktop app through the verify harness; a WebSocket client that closed its socket 3 s in gave the same result. A stub model paced each turn (8 s, a tool call, then 20 lines at 1 s), so a slowdown in Hermes under that pacing would not show.

Two facts about Hermes explain it:

- When the client goes away, Hermes keeps the turn going and reaps the orphaned live session about 20 s after the turn ends. The app resumes the chat by its stored id when the owner comes back. This was observed in the runs.
- Hermes interrupts a turn with no client only after 600 s of no activity. This was read from Hermes's source and not tested.

An Approval or a Question is different. Hermes stops waiting for it after its timeout, so leaving can lose the chance to answer.

## Decisions

- **`leavingNote` returns only the Approval or Question note.** Its running-reply branch is deleted and its signature stays. Every place that asked on it stops asking with no change of its own: a bot's row in Bots mode, the profile switcher, Settings → Profiles, a chat link or search result in another profile, and the Inbox.
- **A profile switch shows a toast.** `switchProfileNow` shows `profiles.leaving.reply` for the profile left when a chat in it is running, and clears the toast otherwise. The string is the one the question used.
- **Switching connection asks about Approvals only.** `leavingConnection` no longer lists running replies. When the switch closes this connection, the new screen's first toast says "A reply is running: “t” in p." or "N replies are running: …", carried the way `notSaved` is. A connection kept live in the background asked nothing before and says nothing now.
- **Approvals and Questions still ask.** Stay and Switch anyway are unchanged for them.

## Considered options

- **Keep asking.** Rejected: the measured runs show the switch costs the reply nothing, so the question only slows the owner.
- **Ask only for a chat that can raise an Approval.** Rejected: a running reply can raise one at any moment, so the rule would ask at random. An Approval that is already waiting is the case that loses something.
- **Switch with no message.** Rejected: the owner would have no sign the reply went on. A toast costs one line and needs no answer.

## Consequences

- One click on another bot opens it. The bot left keeps replying, and its reply is there on return.
- Two connection switches carry no toast: one where Setup's "Save and connect" replaces the connection (`connectionGuard`), and one that stops at the sign-in screen because the connection has no saved password. Both still ask about Approvals. The sign-in screen is a pause of its own, and a note shown after the owner types a password names replies that may have ended by then.
- A reply is no longer a reason to stop at a switch. The 600 s idle interrupt is untested, so a reply that is silent that long in a profile the owner left may be cut off by Hermes.
