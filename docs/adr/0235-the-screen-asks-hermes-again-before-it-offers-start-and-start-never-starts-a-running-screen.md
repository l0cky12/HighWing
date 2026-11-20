# The Screen asks Hermes again before it offers Start, and Start never starts a running screen

> **Accepted.** Issue #143. Amends [ADR 0039](0039-the-side-panel-holds-preview-terminals-files-and-hermess-screen.md): the Screen tab no longer trusts the status it read when it was made.

The side panel makes each tab once and keeps it (ADR 0159). The Screen tab read `display.status` when it was made, after each reconnect and when its stream closed, and at no other time. Hermes's computer use starts a stopped screen inside its own call (`ensure_started_for_tool`, tools/bot_desktop/runtime.py at `be787439`). So a Screen that first read a stopped screen kept offering **Start the screen** while the bot's captures went through. Watch live only switched to the tab. A click on Start then sent `display.start`. For a screen placed in the terminal's sandbox, Hermes answered that with "the terminal backend's sandbox could not be started, so there is nowhere to put the screen", which the tab showed as if the screen could not run.

## Decisions

- **The Screen asks again when it is shown again.** Watch live, follow mode and the tab itself all show it, and each reads `display.status` before the tab says anything about the screen.
- **The Screen asks again after each computer_use call ends, while its last read said stopped.** App passes the shown chat's computer-use run and how many of its calls have ended (`ScreenUse.ended`). The Screen asks only on a change, so it doesn't poll. A sandbox status can make Hermes re-attach to a container, so a status read is not free.
- **Start reads the status first.** It sends `display.start` only when Hermes still says the screen is stopped. A running screen is watched, never started again.
- **A Start Hermes refuses shows Hermes's words for that bot.** The note is headed "Hermes couldn't start <bot>'s screen", with Hermes's error under it and a **Try again** that is the same Start. The tab is keyed by profile, so a late answer for one bot never shows on another bot's Screen.
- **A stream that can't attach reads the status again.** A screen that stopped since the last read shows Start, not a stream to reconnect.

## Considered options

- **Poll `display.status` while the Screen is shown and the screen is stopped.** Rejected: a sandbox status can start a docker inspect and re-attach to a container on the server, and the run's own calls already say when to ask.
- **Hide Start while a computer-use run is live.** Rejected: the screen can be stopped during a run, and Hermes, not the run, says whether it is.

## Consequences

- Watch live shows the bot's running screen as soon as Hermes reports it running. When Hermes can't stream a sandbox screen, the owner sees Hermes's own reason, and Try again never restarts a running screen.
- If Hermes's `display.status` itself reports a sandbox screen as stopped while the session's sandbox runs one, the Screen still offers Start. That is Hermes's to fix: its `display.*` handlers look the sandbox up without the session's key.
