# A Bot Chat says when its bot's desktop control is off and turns it on when the owner clicks

> **Accepted.** Issue #92, step 1. Adds the later phase [ADR 0215](0215-computer-use-readiness-is-read-from-doctor-and-screen-status-with-p-in-argv.md) promised: readiness read through `computerUseReadiness.ts` and not the wire. Amends GLOSSARY "Toolset": a Bot Chat picks up a toolset turned on mid-chat. Code: `computerUseToolset`, `noticeOf`, `afterTurnOn` and `afterRead` in `src/hermes/computerUseReadiness.ts`, `DesktopOffNotice` and `ScreenDesk.toolsets` in `src/ui/ComputerUseCard.tsx`, rendered by `src/ui/ChatPane.tsx` and provided by `src/App.tsx`. Tested in `src/hermes/computerUseReadiness.test.ts` and `src/ui/desktopOff.test.tsx`.

The owner said desktop control, `computer_use`, is meant to be on. When a bot has it off, its Bot Chat says so, with a one-click Turn on. The change is the owner's, never silent, and it still shows the caution Settings → Toolsets shows: turning `computer_use` on makes Hermes install `cua_driver` on the server in the background.

## Decisions

- **The notice shows in a Bot Chat** when the shown profile's `computer_use` is listed, on the `cli` platform, a name this app can switch, not a config-only setting, and off. `noticeOf` is pure. It reads the same row readiness's toolset row does (`computerUseToolset`), so "off" means one thing. An ordinary chat shows nothing.
- **It reads the toolsets only**, through `ToolsetsApi.list`: when the chat opens, when the window comes back to the front, and when a toolset change anywhere in the app ends. It does not run `computer-use doctor` or `display.status` on every Bot Chat. Diagnostics does those on request. The question the notice answers is "is the tool off?", which is what #92 hit.
- **Turn on checks the cautions first** with `ToolsetsApi.cautions`. With none it writes at once. With any, the notice shows them in `cautionText`'s words (already in the catalogue) with **Turn on anyway** and **Keep it off**. The write is `ToolsetsApi.set` with the cautions accepted, which checks against a fresh read, checks the cautions again, and reads back (ADR 0021, ADR 0197). Keep it off sends nothing.
- **Each outcome of the write is a state** (`afterTurnOn`, one case for every kind of `ToolsetChange`). Saved says it is on, and that Hermes is installing the driver when it said so. A change that needs a new confirmation asks again. A change already made elsewhere hides the note. A refusal, a read-back that still says off, a lost answer, and a failed first read keep the note with Hermes's reason and Turn on. `DesktopNotice` makes "asking while saving" unrepresentable. `afterRead` keeps a change under way, and the line saying it is on, from being undone by an older answer.
- **The line says when it takes effect.** Hermes syncs a Bot Chat's capabilities at every turn start: `_sync_bot_capabilities` (`tui_gateway/prompt_turn.py`) compares the capability fingerprint, which holds `platform_toolsets` and `agent.disabled_toolsets` (`tools/bot_mode_probe.py`), and rebuilds the agent for the same session with its history (`tui_gateway/model_switch.py`). So the next message in the chat can use the Bot Desktop, and a reply running now can't.
- **Not now lasts while the chat is open.** Nothing is stored, so a bot with the tool off on purpose shows one line per visit.
- **The data goes through `ScreenDesk`**, the context ADR 0216's note above the composer already uses, so ChatPane's props don't change. It is absent while the app isn't connected, and then there is no note.

## Considered options

- **Turn it on without asking.** Rejected by the owner: the change must be approved, and the cautions matter.
- **Link to Settings → Toolsets.** Rejected: the owner asked for one click, and Settings opens on the shown profile without naming it.
- **Run full readiness in the Bot Chat.** Rejected: it runs a `cli.exec` doctor on every open, which can be blocked, and shows six rows where one question is asked.
- **Make New bot start with `computer_use` ticked.** Rejected here: it changes ADR 0197's "Defaults sends nothing", and every new bot would stop at Apply anyway for the install caution.

## Consequences

- One `GET /api/tools/toolsets` per Bot Chat open and per window focus. `npm run frames-diff` reports it.
- The notice may show on a server with no Bot Desktop at all, since it doesn't check support.
- Only a Bot Chat is covered: Hermes syncs a session's capabilities only when its title is "Bot Chat".
- GLOSSARY "Toolset" gains the Bot Chat exception.
