# Leaving a profile asks only about a waiting Approval or question

> **Accepted** (issue #74). It amends [ADR 0066](0066-a-bot-is-a-profile-and-its-bot-chat-is-found-by-title-every-time.md)'s "and asks first if leaving that profile would leave a reply or Approval behind", and the same question in [ADR 0203](0203-the-bots-view-folds-into-bots-mode-and-a-bot-opened-there-is-a-visit.md)'s visit, [ADR 0037](0037-chat-links-name-ids-only-and-open-after-checks.md)'s chat links, [ADR 0074](0074-a-clone-is-a-fresh-profile-with-picked-parts-and-keys-only-by-opt-in.md)'s Open after a clone, and [ADR 0112](0112-saved-connections-have-stable-ids-and-one-is-in-use.md)'s connection switch. The switch and the visit themselves are unchanged. The rule is `leavingNote` in `src/ui/Sidebar.tsx`, `leavingConnection` and `switchProfileNow` in `src/App.tsx`. Tested in `src/ui/bots.test.tsx`, `src/ui/profileSwitch.test.tsx` and `src/ui/chatLinks.test.tsx`.

The owner switches between bots all the time. While a bot was replying, clicking another bot asked first: "A reply is still running in coder. Hermes keeps it going, and it shows here when you switch back. Stay · Switch to default". The question said nothing would be lost, and still cost a second click on every switch. The owner asked for one click.

The question was safe to remove only if its own words were true: that Hermes keeps a reply going at full speed after the app stops listening to its profile. A switch closes the app's one socket for that profile (ADR 0203, `Hermes.switchProfile`). So this was measured against a real Hermes first.

## Decisions

- **Leaving a profile no longer asks when a reply is running.** This holds for every way out: a bot's row in Bots mode, the profile switcher, Settings → Profiles, a chat link, a search result, Open after a clone, and a switch to another saved connection. `leavingNote(profile, chats, words)` keeps its signature and names only a waiting Approval or question. `profiles.leaving.reply` is gone from every locale.
- **A waiting Approval or Hermes question still asks first, everywhere it asked before.** Hermes waits for an answer only for a while: 120 s for a sudo password, 300 s for a secret, and `agent.clarify_timeout` for a clarify, 3600 s by default (docs/compatibility.md, "Clarify, Sudo password and Secret questions"). An owner who switches away may not come back in time, so one click must not leave it behind unseen.
- **A connection switch names only waiting Approvals.** `leavingConnection` no longer lists the inbox's running replies when the owner switches connection. Removing the connection in use still names them, since that dialog confirms a removal, not a switch.
- **The bot's row says it is replying.** A bot in another profile shows **Replying** in its row, in the accent colour, as before (ADR 0066, ADR 0195). Its activity comes from Hermes's live-session list (`botActivity`), so it still shows after the switch.
- **A toast after the switch names what is still running.** `switchProfileNow` counts the chats of the profile left that have a reply running. If there are any, the toast says "Ada is still replying. The whole reply will be here when you come back.", with the bot's name, or "Ada is still replying in 2 chats. Every reply will be here when you come back." On a Hermes without Bot Mode it names the profile as the switcher does: "A reply is still running in work." A connection switch shows no such toast. The screen changes to another server there, and ADR 0112 already says Hermes keeps the reply going.

## Evidence

Measured on one machine, over loopback, against a real Hermes: hermes-agent `ae2a81ccc0`, run as `hermes dashboard` with the legacy protocol and the default config. The real app was driven through the verify-hermes-chat skill. The model was a stub OpenAI-compatible server that streams at a fixed pace, not a real provider. All times are Hermes's own: its `state.db` rows and an strace of its socket reads. The evidence folder is on the owner's machine at `~/.cache/hermes-verify/evidence/1118-145853-989870/`.

- **100 tokens/s, 3,000-token turns, five runs each way, alternating.** Staying on the profile took a median 31.026 s (range 31.003 to 31.038 s). Switching away 5 s into the turn took a median 30.820 s (range 30.796 to 30.854 s). Hermes read every chunk within 0.6 ms of the model writing it, before and after the switch. Every stored reply was complete, with `finish=stop`. Hermes logged no interrupt and never reaped the session.
- **2 tokens/s.** Staying took 61.3 s. Switching away took 60.1 s and 60.2 s. Switching back showed all 120 tokens.

Why it holds, from Hermes's source at `ae2a81ccc0` (`tui_gateway/session_lifecycle.py`, around line 1103): a dropped socket parks its sessions. Every `dashboard.ws_orphan_reap_grace_s` (20 s) Hermes checks them again. It leaves a running turn running while the turn's activity clock is fresh. API waits, stream tokens and tool heartbeats all reset that clock. Hermes interrupts the turn only after `dashboard.ws_orphan_activity_stale_s` (600 s) without activity. Once the turn finishes, Hermes closes the session, and it resumes from the stored rows when the app comes back.

Not tested: `dashboard.turn_isolation` on (it is off by default), lowered reaper settings, a real model provider, an Approval asked while the app is away, and the release of the computer-use lease on the switch.

## Considered options

- **Stop asking only on bot rows.** Rejected by the owner. The same question on the switcher, a chat link or a connection switch would still cost the second click, and its words are as true there.
- **Stop asking about Approvals and questions too.** Rejected by the owner. They time out on the server, and a reply waiting on one makes no progress while the owner is away.
- **Show nothing in place of the question.** Rejected by the owner. The toast confirms what the question used to promise, and costs no click.

## Consequences

- One click opens another bot, or another profile, while a reply runs. A reply that waits on an Approval or question still asks first.
- A setting on the server can make the old question's promise untrue. If `dashboard.ws_orphan_activity_stale_s` is set low, a slow turn can be interrupted while the app is away. The app doesn't read that setting.
- Issue #77 is a known gap: a reply event that arrives before Hermes answers the resume is dropped. So coming back while a reply still runs can miss text until the chat is opened again. It is fixed separately, in `src/hermes/transport.ts`.
- `leavingNote` is the one rule for every profile switch. A new way to leave a profile calls it and asks only when it returns a note. A new kind of request that times out on the server belongs in it.
- The toast is set in `switchProfileNow`, so every profile switch gets it, a bot visit's way home and ones added later included.
