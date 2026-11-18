# Computer use

Settings → Diagnostics has a Computer use section under Bot Desktop. For the profile shown it lists six prerequisites of Hermes's `computer_use`: the Computer use tool (toolset), cua-driver, Desktop packages, Memory, Where the screen runs and Screen control. Each is a green Ready, a red Not ready with Hermes's own reason and a fix (a command to copy, or **Open Toolsets**), or a grey Unknown when Hermes couldn't be read. **Check again** reads all of them.

## Sub-features

- `cu-ready`: every row reads Ready, and the line above says "Ready: the agent can use the Bot Desktop."
- `cu-toolset-off`: the Computer use tool row is red, and **Open Toolsets** opens Settings → Toolsets.
- `cu-driver-red`: the cua-driver row shows doctor's failing checks and its first hint.
- `cu-human-holds`: the Screen control row is red while a person holds the screen.
- `cu-check-again`: **Check computer use again** re-reads everything.

## How to get to it (user POV)

- Rail: the gear button, then **Diagnostics** under the sidebar's Server group (below the fold; scroll the sidebar). The **Computer use** section follows **Bot Desktop**.
- Settings → General → Connection → **Connection diagnostics** opens the same page.

## Driving it with wd.mjs

Preconditions:

- Signed in to the stand-in (see [sign-in.md](sign-in.md)), started with `HV_COMPUTER_USE=ready hv up`. Other values change what the rows show: `toolset-off` leaves the toolset off, `degraded` makes doctor fail its X11 checks, `human` has a person hold the screen.

- **Open the section.** Run `$S/wd.mjs click button Settings`, then `$S/wd.mjs click button "Connection diagnostics"`, then `$S/wd.mjs wait '#diag-computer-use'`, then `$S/wd.mjs eval 'document.getElementById("diag-computer-use").scrollIntoView();1'`.
- **Ready.** With `ready`, run `$S/wd.mjs wait 'section [role=status]' "Ready: the agent can use the Bot Desktop."`, then `$S/wd.mjs shot 01-computer-use-ready`. All six rows show a green Ready badge.
- **Red with a reason.** Relaunch with `HV_COMPUTER_USE=degraded`. The cua-driver row reads "X11 is not reachable; UI inspection and event injection will fail." and "Set DISPLAY (X11). Under Wayland, run via XWayland or expose XDG_SESSION_TYPE=x11." Take `$S/wd.mjs shot 02-computer-use-driver-red`.
- **Toolset off.** With `toolset-off`, run `$S/wd.mjs click button "Open Toolsets"`, then `$S/wd.mjs wait 'input[aria-label="Search settings"]'`. The Toolsets tab shows.
- **Check again.** Run `$S/wd.mjs click button "Check computer use again"`. The line above shows Checking… and then the verdicts again. Every read is read-only, so `$S/hv state` shows no change.
- **Proof.** The shots of the green and the red section. The `-p` rule is proved in `src/hermes/screen.test.ts`, because the stand-in keeps no log of `cli.exec` argv.

## Gotchas

- The sidebar's Diagnostics item is below the fold, and clicking it by text returned "element click intercepted" in the first run. Use **Connection diagnostics**.
- The rows show only after the first read. Wait for the status line to leave "Checking…" before you assert a row.
- Without `HV_COMPUTER_USE` the stand-in has no Bot Desktop and no server machine, so every row from `display.status` reads Unknown, "This Hermes doesn't report it." That is the older-Hermes case, not a failure.
- The stand-in's doctor answers from FakeHermes, not a real cua-driver. For a real Hermes, start it as the real-dashboard section of [../SKILL.md](../SKILL.md) describes.
- A person holding the screen is shown as "a person", not as you. Hermes names the holder by a hash only the Screen tab matches to itself.
- "Memory" is also a Diagnostics feature row further down. Look inside the Computer use section.
