# Settings lists what Hermes always allows, and Remove writes that list alone, checked first and read back

Issue #27. When the owner answers an Approval with **Always allow**, Hermes stops asking before commands like that one, in every chat of the profile. Until now Highwing gave that answer but had no place to see what was always allowed, or to take a grant back without a shell on the server.

## What the server offers (checked in source at `ae2a81c` and the deployed `f0d94882`)

- An "always" answer saves the command's pattern name, such as `recursive delete`, in the profile's `command_allowlist` in config.yaml (`tools/approval.py` `_persist_choice` and `save_permanent_allowlist`). The save writes what is on disk now plus this process's new grants, so it respects a removal made on disk.
- The same answer also allows the pattern for the rest of the chat that gave it (`approve_session`, in memory). Hermes drops that grant only when it closes the chat's session (`clear_session`, from `tui_gateway/session_lifecycle.py`). No route takes it back.
- Before every guarded command, Hermes reads the list from disk again and applies what changed since its last read (`_sync_permanent_from_disk`). A name removed from the file stops being honoured from the next check, with no restart.
- `GET /api/config?profile=` returns the list with the rest of the config. Hermes's default is `[]`. A missing list or `null` reads as empty. A list with an item that isn't text is ignored whole. A string is read through an old YAML fallback.
- `config.set` over the socket refuses the key (`unknown config key`). `PUT /api/config?profile=` `{config}` deep-merges the body over the stored file under the config lock, and `_deep_merge` replaces a list whole, so `{config: {command_allowlist: [...]}}` sets the list and touches nothing else.
- No route takes an expected revision, so no write can be made conditional.

## Decisions

- **A page of its own: Settings → Approvals**, in the Agent group after Toolsets. The issue asked for a section beside the approval settings, but Settings has none: the approval mode is the composer pill (ADR 0091). Toolsets says it isn't Approvals, so the list doesn't belong inside it. The page has the profile picker MCP servers and Gateways have (ADR 0118), so any profile's list can be read and changed. Whether the approval mode should move here too is for the owner.
- **Each entry has Remove, and nothing adds one.** Grants come only from an Approval card, where Hermes asks about a real command. Adding a pattern name by hand would let the owner allow something they never saw.
- **Rust reads the list and passes on nothing else** (`Dashboard::command_allowlist`), as it does for the voice settings (ADR 0115) and the toolset guards. It returns the list as written, or why it can't be shown: an item that isn't text, a string, or anything that isn't a list. The page then names the reason, offers no Remove, and says to fix config.yaml on the server.
- **One narrow relay rule writes the list** (`command_allowlist_write`). It passes `PUT api/config` only when the body is exactly `{"config": {"command_allowlist": [text, …]}}`, with no profile in the body and no other key. The general `PUT api/config` rule, which Settings → Model and Voice use, now refuses any body that names `command_allowlist`. So no other screen can change the list, and this screen can change nothing else.
- **Remove checks, writes, and reads back.** Removes run one at a time for the whole app. Each one reads the list again first. If Hermes's list isn't the one shown (compared as a set, since Hermes keeps a set and saves it sorted), nothing is sent, the page shows the new list and says to try again. Otherwise it sends that fresh list with every copy of the entry dropped, then reads again. It says "Removed" only when the read matches what was sent. Otherwise it names what is different: the entry back in the list, entries added elsewhere, entries removed elsewhere. A 4xx stops with Hermes's reason. A lost answer or a 5xx is decided by the read after it, and when that read fails too, the page says it isn't known.
- **The screen says what Remove can't reach.** After a Remove, and in the page's applies line, it says that the chat which answered Always allow keeps the command allowed for itself until Hermes closes that chat.
- **The Always allow confirm says where to look.** It now ends "Settings → Approvals lists what is always allowed, and can take it back."

## Considered options

- **A read-only list, with the server command that removes an entry** (the issue's option 2). The owner would still need a shell to undo a grant, which is the gap the issue is about.
- **Asking the bot to edit its own config** (option 3). The agent would edit the list that limits the agent.
- **Doing the whole Remove in Rust**, in one command that reads, checks and writes. It would narrow the window by one IPC round trip, not close it, and it would move the outcome logic away from the screen that words it. The relay rule keeps the write as narrow either way.
- **Letting the relay check that a write only shrinks the list.** That would need a read inside the relay. The general `PUT api/config` rule already lets the webview set `approvals.mode` to `off`, which allows more than any list could, so the check would add little until that rule is narrowed too.

## Consequences

- The owner can see, for any profile, what Hermes runs without asking, and take a grant back. Hermes asks again from its next guarded command, in every client, except in the chat that gave the Always allow while Hermes keeps that chat open.
- **The lost updates that remain.** Remove writes the whole list, so any change another client makes between Remove's check and its write is undone, and the read back can't show it, because it matches what was sent. The window is one round trip. Two cases:
  - An Always allow saved elsewhere in that window is dropped. This fails safe: Hermes asks again before that command, and answering Always allow again restores it.
  - An entry removed elsewhere in that window comes back, so Hermes again runs that kind of command without asking. This fails open. It needs two people (or two windows) removing from the same profile's list within one round trip. The page's help says to read the list again after removing from two places at once.

  A change made after the write and before the read back is caught: the page names what was added or removed elsewhere, and says when the removed entry is back.
- An entry Rust can't pass on blocks Remove for the whole list, so a hand-edited config.yaml with a bad item needs fixing on the server first.
- Checked against a real Hermes dashboard (`f0d94882`, the verify skill's `real-hermes`): an Always allow wrote `recursive delete` to config.yaml, and a second command ran without asking; a hand edit made between the read and Remove was caught and nothing was written; Remove left only the hand-added entry; a new chat then asked again before the same command, while the answering chat still ran it unasked. The tests (`src/hermes/allowlist.test.ts`, `src/ui/allowlistSettings.test.tsx`) run against `FakeHermes`, which doesn't model that chat's own grant.
