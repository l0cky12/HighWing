# The Repository, Automations and Office screens are removed

> **Accepted.** It supersedes ADR 0043 and ADR 0110 (the Repository screen and its worktrees), ADR 0108 (Automations), and ADR 0077, ADR 0122 and ADR 0161 (the agent office).

The owner doesn't use three of the rail's screens and asked for them to go: the Repository screen ("Git changes on the server"), Automations ("Tasks started by GitHub events") and the agent Office. Each one carried its own code, helpers, tests and docs. The Repository screen also shipped a Python helper that Rust sent over ssh, and the Office pulled in three.js for its 3D building.

## Decisions

- **The three screens go, with everything only they used.** Their rail buttons, screens, settings and tests are gone. The Repository screen's ssh Git helper and its `repo_git` and `repo_git_stream` commands are gone, and so is the `flate2` dependency that packed the helper. The Worktrees view and starting a chat in a worktree go with it. Automations' API client, its filter preview (`patternRunner`, `pyRegex`) and the Rust allow-list for writes to `api/webhooks` are gone. The Office's views, its `office3d` scene, `three`, and opening a subagent from a desk are gone.
- **What other features shared moves out.** A reply's file changes (ADR 0180) draw their diff with `PatchFile`, now in `src/ui/PatchFile.tsx`, and read it with `parseDiff` and `splitPatch`, now in `src/hermes/diff.ts`. Screen apps keep their own ssh failure wording in `screen_apps.rs`. Projects still lists a repository's worktrees, read through the dashboard, and adds one as a folder.
- **The `automations` capability stays.** Capability ids are part of the extension contract (ADR 0126, section 7), as ADR 0170 found for `outputs`. Its check still reads `GET /api/webhooks`, and its row says it is used by extensions that list it. Nothing in the app writes webhook routes now.
- **What an older install kept.** The Repository screen's folder, recent folders and SSH target, and the record of chats started in a worktree, are deleted at launch (`dropRetiredData`), as the Outputs index was. A backup made beside them still restores. A saved `agentOffice` or `officeQuality` preference is ignored; the preference migrations that rewrote it are kept as steps that change nothing, so the version numbering holds.

## Considered options

- **Hide the screens behind a setting.** Rejected: the owner asked for the code to go, and a hidden screen still costs build time, tests and review.
- **Remove the `automations` capability too.** Rejected for this change, for the reason ADR 0170 gives: it would refuse the install of an extension that names it, which needs a raise of `api`.

## Consequences

- What these screens left on servers stays there. Webhook routes keep running on the Hermes server, and their sessions still show as chats from another platform. Worktrees Highwing made, `<git common dir>/hermes-chat/managed-worktrees.json` and the refs under `refs/hermes-chat/kept/` stay in their repositories until the owner removes them with Git.
- A `DELETE api/webhooks/{name}` is still passed through the transport, as every DELETE outside the file and env routes always was. Nothing in the app sends one.
- The Subagents panel opens only from the chat, since the Office was the only other way in.
