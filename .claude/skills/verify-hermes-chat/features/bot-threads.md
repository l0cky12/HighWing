# Bot threads

In Bots mode every bot row has a disclosure, "N threads" or "No threads". Open, it lists the bot's threads and a **New thread** row. A thread is a hidden conversation with the same bot on one topic: New thread starts an empty one from a typed topic, and **Thread from here** under a Bot Chat message starts one with the Bot Chat's history up to that message. A thread's pane is headed "<Bot> / <topic>" with a Thread badge. Threads never show in Chats mode, the Archived drawer or Search, and they stay under their bot after the Bot Chat is compacted into a new session. A thread of a bot in another profile is a visit (ADR 0203), which the Chats tab ends. ADR 0211 holds the rules.

## Sub-features

- `threads-disclosure`: every bot row has a "No threads" / "N threads" disclosure. It opens itself while the bot's Bot Chat or one of its threads is on screen.
- `threads-new`: **New thread**, a topic, then Enter opens the empty thread.
- `threads-from-here`: **Thread from here** under a Bot Chat message shows the preview dialog with a Topic field, and **Start thread** opens the copy.
- `threads-switch`: the bot row opens the Bot Chat, and a thread row opens that thread, each with its own header and history.
- `threads-hidden`: no thread in Chats, the Archived drawer, or Search (This profile and Everywhere).
- `threads-after-compact`: `/new` in a Bot Chat moves it to a new session, and Reload or reopening Bots still lists and opens every thread.
- `threads-other-profile`: New thread under another profile's bot is a visit, and the Chats tab returns to the shown profile.

## How to get to it (user POV)

- The chat list's **Bots** tab → a bot's disclosure ("No threads" / "N threads") → **New thread**.
- In a Bot Chat, the actions under a message → **Thread from here**.
- Bots tab → a thread row under its bot. Right-click, Shift+F10 or the Menu key on a thread row offers Rename and Delete (not covered below).
- Compacting a Bot Chat: `/new` in its composer, or its Compact action.

## Driving it with wd.mjs

Preconditions:

- `HV_COMPRESS=rotate $S/hv up` (a compaction then moves the chat to a new session), `wd.mjs open`, and signed in per [sign-in.md](sign-in.md).
- Quote every selector that holds `[` or `*`. zsh treats an unquoted `textarea[data-composer]` as a glob and drops the command.

- **Disclosures.** `$S/wd.mjs click '[role=tab][data-mode=bots]'`, `$S/wd.mjs wait button "Hermes: No threads" "" 15000`. Each bot row (the Hermes one is `button "Hermes (profile default)"`) has a disclosure button labelled `<Bot>: No threads`. No "<Bot>'s chats" group shows.
- **Bot Chat.** `$S/wd.mjs click button "Hermes (profile default)"`, `$S/wd.mjs wait .chat-title "Bot Chat"`, `$S/wd.mjs click 'textarea[data-composer]'`, `$S/wd.mjs keys 'Plan the VLAN layout for the lab\n'`, `$S/wd.mjs wait .msg.assistant "Stand-in reply to: Plan the VLAN"`. The disclosure opens with **New thread** under it.
- **New thread.** `$S/wd.mjs click button "New thread"`, `$S/wd.mjs fill input "Topic of the new thread with Hermes" -- "Firewall rules"`, `$S/wd.mjs press Enter`, `$S/wd.mjs wait .chat-title "Firewall rules"`. The header reads "Hermes / Firewall rules Thread", the tab "Hermes / Firewall rules", and the disclosure "1 thread". Send a message as in a chat.
- **Thread from here.** Back on the Bot Chat (its row), `$S/wd.mjs click '.msg.assistant button' "Thread from here"`. The dialog reads "A thread with this bot starts with the Bot Chat's history up to…", with `input "Topic"`, "History it starts with: 2 messages", Model and Folder. `$S/wd.mjs fill input "Topic" -- "VLAN plan"`, `$S/wd.mjs click button "Start thread"`, `$S/wd.mjs gone '[role=dialog]'`, `$S/wd.mjs wait .chat-title "VLAN plan"`. The thread shows the two copied messages and the disclosure "2 threads".
- **Switch.** `$S/wd.mjs click .bots-thread-open "Firewall rules"` and `$S/wd.mjs click .bots-thread-open "VLAN plan"` open the threads, and the bot row opens the Bot Chat. Read the header with `$S/wd.mjs eval 'return document.querySelector(".chat-head, header")?.innerText'`.
- **Hidden from lists.** `$S/wd.mjs click '[role=tab][data-mode=chats]'`. `.row-open[data-chat]` holds no thread. Open **Archived** and see only the four seeded chats.
- **Hidden from Search.** `$S/wd.mjs press Control+k`, `$S/wd.mjs wait '[role=dialog][aria-label="Search chats"]' "" 10000`, `$S/wd.mjs keys jumpbox` (a word only a thread holds), then `wait '[role=dialog][aria-label="Search chats"]' "No matches"`. Do it for the topics, for "Bot Thread", and with **Everywhere**. As a control, `MTU` finds "Why is the VPN slow".
- **Server returns them.** The stand-in's search doesn't drop hidden sessions, so prove the app does: `curl -s -b hermes_session=synthetic "$DASHBOARD_URL/api/sessions/search?q=jumpbox&profile=default"` lists `Bot Thread: Firewall rules`.
- **Compact.** In the Bot Chat, `$S/wd.mjs keys '/new'`, then `$S/wd.mjs press Enter` (fills the command) and `$S/wd.mjs press Enter` (sends it). The note reads "A Bot Chat is one continuous conversation, so /new compacts it…". `$S/hv state` shows the Bot Chat row with `end_reason: "compression"` and a new `<id>-c1` row whose `parent_session_id` is the Bot Chat.
- **After compaction.** `$S/wd.mjs click button "Reload bots"`, `$S/wd.mjs wait button "Hermes: 2 threads" "" 15000`, and open each thread row and the Bot Chat. `bridge.log` shows `session.resume <id>-c1` for the Bot Chat. Chats → Bots again still lists both.
- **Another profile.** `$S/wd.mjs click button "Work: No threads"`, `$S/wd.mjs click '[data-threads-of=work] .bots-thread-new'`, `$S/wd.mjs fill input "Topic of the new thread with Work" -- "Offsite backups"`, `$S/wd.mjs press Enter`. The header reads "Work / Offsite backups Thread" and the composer "Message Work". `$S/wd.mjs click '[role=tab][data-mode=chats]'` returns to Hermes (`default`) with a New chat tab, and Bots still lists "Work: 1 thread".
- **Proof.** `$S/hv state`: each thread is a `sessions` row titled `Bot Thread: <topic>` with `hidden: true`. New thread has no `parent_session_id`, and the fork's is the Bot Chat. The Bot Chat row keeps the title "Bot Chat". `transcripts` holds each thread's messages.

## Gotchas

- `wd.mjs wait <css> <ms>` reads a lone number as the text to match. Pass `""` as the text before a timeout.
- `/__state` lists only `default`'s session rows (transcripts cover every profile). Read a thread in `work` with `curl -s -b hermes_session=synthetic "$DASHBOARD_URL/api/sessions/<id>?profile=work"`.
- With `HV_COMPRESS=rotate` the stand-in still answers its canned no-op, so the note says "There was nothing to compact yet." even though the chat moved. Prove the move with `hv state`, not the note.
- After a rotation, the bot row's time stays at the first session's last activity, because the stand-in reports `canonical_session.last_active` from that row. The preview does follow the new session.
- The slash menu describes `/new` as "Start a new chat" in a Bot Chat too. The note shown after sending it says it compacts.
- Thread from here offers a topic cut from the message, which can end mid-phrase. Fill your own.
- Opening a thread or the Bot Chat from the list reuses the current tab.
- On the stand-in, the first Bot Chat is `20261031_120001_abc123`, the next session `…120002…`, a fork of the Bot Chat `<bot chat id>-b1`, and its rotated session `<bot chat id>-c1`.
