# Computer use

When Hermes drives its Bot Desktop with `computer_use`, each run of steps in a reply is one card in the chat: "Computer use · N steps" with the run's state, who holds the screen, a Watch live chip, and a line per action in Hermes's own words (`capture`, `click at (620, 780)`, `type 'df -h /srv'`, `key 'return'`, `wait 1s`) with the window it aimed at, a "foreground" tag when it raised the window, and how it came out. An Approval Hermes asks for an action shows under that step and is answered there; it names the action and whether it is background or foreground input, and each grant button says which it grants. Watch live opens the side panel's Screen. With Settings → General → Chats → "Follow computer use" on, the Screen opens by itself once for each run. When the last step was refused because a person holds the screen, a note above the composer says who, until the screen is back with Hermes.

Settings → Diagnostics also has a Computer use section under Bot Desktop. For the profile shown it lists six prerequisites of Hermes's `computer_use`: the Computer use tool (toolset), cua-driver, Desktop packages, Memory, Where the screen runs and Screen control. Each is a green Ready, a red Not ready with Hermes's own reason and a fix (a command to copy, or **Open Toolsets**), or a grey Unknown when Hermes couldn't be read. **Check again** reads all of them.

## Sub-features

- `card`: a 20-step turn reads as one card with 20 numbered lines and no generic tool rows.
- `ask`: a cua Approval under the step it gates, answered in place; the step reads "waiting for your approval" until then.
- `ask-scope`: the card heads the action, says Background input or Foreground input, and words its buttons by it ("Allow background clicks for this chat…"); a grant's second step says the other delivery mode still asks.
- `ask-always`: Always allow foreground typing, after its second step, stops the asking for it in every chat.
- `ask-deny`: Deny ends the step "denied" and Hermes carries on without the action.
- `line-open`: a line opens to Hermes's advice and the call's arguments and result, with no screenshot.
- `watch`: Watch live opens the Screen tab.
- `follow`: the setting opens the Screen once per run; off, nothing opens.
- `refused`: the note above the composer when someone else holds the screen, and its going once Hermes has it back.
- `saved`: the Saved copy holds no screenshot.
- `reopened`: a chat read back from Hermes shows the same steps, each "not recorded".
- `cu-ready`: every row reads Ready, and the line above says "Ready: the agent can use the Bot Desktop."
- `cu-toolset-off`: the Computer use tool row is red, and **Open Toolsets** opens Settings → Toolsets.
- `cu-driver-red`: the cua-driver row shows doctor's failing checks and its first hint.
- `cu-human-holds`: the Screen control row is red while a person holds the screen.
- `cu-check-again`: **Check computer use again** re-reads everything.

## How to get to it (user POV)

- Send a message in any chat that makes Hermes use its Bot Desktop; the card shows in the reply.
- The card's "Watch live" chip, or the note's "Open the Screen" button, opens the side panel's Screen.
- Settings → General → Chats → "Bot Desktop" → "Follow computer use" switch.
- The note shows above the composer by itself after a refused step.
- Diagnostics: the rail's the gear button, then **Diagnostics** under the sidebar's Server group (below the fold; scroll the sidebar). The **Computer use** section follows **Bot Desktop**.
- Diagnostics: Settings → General → Connection → **Connection diagnostics** opens the same page.

## Driving it with wd.mjs

Preconditions:

- Signed in to the stand-in (see [sign-in.md](sign-in.md)).
- The stand-in runs a scripted computer-use turn for a prompt that starts with `computer use`: 20 calls, about half a second each. A background click (steps 2, 4 and 15) and a foreground type (steps 6 and 11) each ask an Approval until allowed for the chat; foreground key presses are already allowed. `computer use takeover` hands the screen to someone else first, so its one call is refused. `curl -s -X POST "$DASHBOARD_URL/__lease?holder=agent"` gives the screen back to Hermes.
- `. $HV_RUN/state.env` puts the stand-in's URL in `$DASHBOARD_URL` and the evidence folder in `$EVIDENCE`.
- For the Diagnostics steps, start the stand-in with `HV_COMPUTER_USE=ready hv up`. Other values change what the rows show: `toolset-off` leaves the toolset off, `degraded` makes doctor fail its X11 checks, `human` has a person hold the screen.

- **Card and Approvals.** Run `$S/wd.mjs press Control+n`, `$S/wd.mjs fill 'textarea[data-composer]' -- "computer use: check /srv"` and `$S/wd.mjs press Enter`. Then `$S/wd.mjs wait '.approval' "Hermes wants to click at (620, 780)" 20000` and `$S/wd.mjs shot 01-asking`: `$S/wd.mjs text '.cu-run .returned-head'` reads "Computer use · 2 steps" and "waiting for your approval", and `$S/wd.mjs text '.cu-step.latest .tool-line'` ends in "waiting for your approval". `$S/wd.mjs text '.approval:not(.answered) .approval-cu'` reads "in desktop", "Background input" and "Background input: the window keeps its place and its focus on the Bot Desktop.", and its buttons read "Approve once", "Allow background clicks for this chat…", "Always allow background clicks…" and "Deny". Run `$S/wd.mjs click button "Allow background clicks for this chat"`; the second step reads "Allow background clicks for the rest of this chat? … The foreground version still asks." (`$S/wd.mjs shot 01b-grant-confirm`). Half a second later, run `$S/wd.mjs click button "Yes, allow for this chat"`.
- **A foreground Approval.** Run `$S/wd.mjs wait '.approval:not(.answered)' "Hermes wants to type" 20000` and `$S/wd.mjs shot 02-foreground-ask`. `$S/wd.mjs text '.approval:not(.answered) .approval-head'` reads "Hermes wants to type 'df -h /srv'", the card's chip reads "Foreground input", its buttons read "Allow foreground typing for this chat…" and "Always allow foreground typing…", and the step carries a "foreground" tag. Run `$S/wd.mjs click button "Approve once"`. Step 11 types again and asks again, since once covers one call: wait for it the same way, then `$S/wd.mjs click button "Always allow foreground typing"`, and half a second later `$S/wd.mjs click button "Yes, always allow"`. The step 11 card reads "Always allowed" afterwards, and the stand-in doesn't ask for foreground typing again in any chat.
- **Twenty lines.** Run `$S/wd.mjs wait .msg.assistant "/srv is 92% full" 40000`, then `$S/wd.mjs shot 03-card`. `$S/wd.mjs text '.cu-run .returned-head'` reads "Computer use · 20 steps" and "done". `$S/wd.mjs count '.cu-run .cu-step'` prints `20`, `$S/wd.mjs count '.cu-run'` prints `1`, `$S/wd.mjs count '.tools'` prints `0`, and `$S/wd.mjs count '.cu-run .approval'` prints `3`: the clicks at steps 4 and 15 asked nothing, because the chat's grant covered them.
- **Open a line.** Run `$S/wd.mjs click '.cu-step .tool-line' "du -sh"`, then `$S/wd.mjs wait '.cu-step .tool-body' Arguments` and `$S/wd.mjs shot 04-line-open`. It shows "Hermes's advice", "Arguments" and "Result". `$S/wd.mjs eval 'return document.querySelector(".cu-run").textContent.includes("base64")'` prints `false`.
- **Saved copy.** `$S/wd.mjs eval 'return Object.keys(localStorage).filter(k => /;base64,[A-Za-z0-9+/]{1024}/.test(localStorage.getItem(k) ?? ""))'` prints `[]`. The chat's Saved copy is about 14 KB for 20 steps.
- **Watch live.** Run `$S/wd.mjs click button "Watch live"`, then `$S/wd.mjs wait '#panel-tab-screen[aria-selected=true]' Screen` and `$S/wd.mjs shot 05-watch`. The Screen tab shows the stand-in's stopped Bot Desktop with "Start the screen". `$S/wd.mjs text '.cu-run .cu-holder'` reads "Hermes drives the screen".
- **Follow mode.** Run `$S/wd.mjs press Control+,`, `$S/wd.mjs click button Chats` and `$S/wd.mjs click '[role=switch][aria-labelledby=follow-screen-label]'`, under "Bot Desktop". `$S/wd.mjs eval 'return document.querySelector("[aria-labelledby=follow-screen-label]").getAttribute("aria-checked")'` prints `"true"`. Run `$S/wd.mjs click button "Back to chat"` and `$S/wd.mjs click button.panel-close`, then send `computer use a second time` in the same chat. `$S/wd.mjs wait '#panel-tab-screen[aria-selected=true]' Screen 20000` passes at the run's first step (`shot 06-followed`). Run `$S/wd.mjs click '#panel-tab-files'` while it runs; after `$S/wd.mjs wait .msg.assistant "/srv is 92% full, and" 40000`, `$S/wd.mjs count '#panel-tab-files[aria-selected=true]'` still prints `1`.
- **Refused.** Run `$S/wd.mjs click button.panel-close` and `$S/wd.mjs press Control+n`, and send `computer use takeover`. Then `$S/wd.mjs wait .cu-banner "someone else holds the Bot Desktop" 20000` and `$S/wd.mjs shot 07-refused`. The card reads "Computer use · 1 step" and "refused", `$S/wd.mjs text '.cu-run .cu-holder'` reads "Someone else holds the screen", line 1 reads "refused: a person holds the screen", and the note offers "Open the Screen". Run `curl -s -X POST "$DASHBOARD_URL/__lease?holder=agent"`, then `$S/wd.mjs gone .cu-banner` and `$S/wd.mjs shot 08-handed-back`. The holder reads "Hermes drives the screen".
- **Deny.** Run `$S/wd.mjs press Control+n` and send `computer use deny`. Then `$S/wd.mjs wait '.approval:not(.answered)' "Hermes wants to double_click at (640, 400)" 20000`, `$S/wd.mjs shot 09-deny-ask` (Foreground input, "Allow foreground double clicks for this chat…"), and `$S/wd.mjs click button Deny`. Then `$S/wd.mjs wait .msg.assistant "You said no" 20000`: `$S/wd.mjs text '.cu-step.denied .cu-outcome'` reads "denied", the card reads "Computer use · 2 steps" and "done", and `$S/wd.mjs shot 10-denied` shows the card headed "Denied". `grep -c approval.respond $EVIDENCE/bridge.log` counts one more.
- **Reopened from Hermes.** Run `$S/wd.mjs close`, `$S/wd.mjs open`, sign in again ([sign-in.md](sign-in.md), "Sign in again"), and `$S/wd.mjs click button "computer use: check /srv"`. Once Hermes's history is read, each run's card has 20 lines and every line reads "not recorded": `$S/wd.mjs eval 'return [...document.querySelectorAll(".cu-run")].map(c => c.querySelectorAll(".cu-step.unrecorded").length)'`.
- **Proof on the server.** `$S/hv state | python3 -c 'import json,sys; t=json.load(sys.stdin)["transcripts"]; print({m["name"] for v in t.values() for m in v if m["role"]=="tool"})'` prints `{'tool_call'}`: each call is stored as Hermes stores computer use, with its call in `args.calls` and no result. `grep approval.respond $EVIDENCE/bridge.log` lists each Approval answered with its choice and request id, such as `{"choice":"session","request_id":"cua-rt-1-2"}`: after the steps above, `session`, `once` and `always`, and `deny` after Deny.
- **Diagnostics: open the section.** Run `$S/wd.mjs click button Settings`, then `$S/wd.mjs click button "Connection diagnostics"`, then `$S/wd.mjs wait '#diag-computer-use'`, then `$S/wd.mjs eval 'document.getElementById("diag-computer-use").scrollIntoView();1'`.
- **Diagnostics: ready.** With `ready`, run `$S/wd.mjs wait 'section [role=status]' "Ready: the agent can use the Bot Desktop."`, then `$S/wd.mjs shot 11-computer-use-ready`. All six rows show a green Ready badge.
- **Diagnostics: red with a reason.** Relaunch with `HV_COMPUTER_USE=degraded`. The cua-driver row reads "X11 is not reachable; UI inspection and event injection will fail." and "Set DISPLAY (X11). Under Wayland, run via XWayland or expose XDG_SESSION_TYPE=x11." Take `$S/wd.mjs shot 12-computer-use-driver-red`.
- **Diagnostics: toolset off.** With `toolset-off`, run `$S/wd.mjs click button "Open Toolsets"`, then `$S/wd.mjs wait 'input[aria-label="Search settings"]'`. The Toolsets tab shows.
- **Diagnostics: check again.** Run `$S/wd.mjs click button "Check computer use again"`. The line above shows Checking… and then the verdicts again. Every read is read-only, so `$S/hv state` shows no change.
- **Diagnostics: proof.** The shots of the green and the red section. The `-p` rule is proved in `src/hermes/screen.test.ts`, because the stand-in keeps no log of `cli.exec` argv.

## Gotchas

- The stand-in's Bot Desktop is stopped and has no stream, so the Screen tab shows "Start the screen" rather than a live picture. Its lease still changes with `/__lease`, which is what the card and the note read.
- A turn's Approvals arrive as the run gets to them; `wait` with a long timeout before clicking. A card, and the "Yes, allow for this chat" step it opens, ignore a click in their first 400 ms (`ARM_MS`), so leave half a second between showing and clicking. `wd.mjs` matches button text more reliably without the trailing "…" ("Allow for this chat").
- `.approval:not(.answered)` finds the Approval still waiting; answered ones stay under their steps.
- The stand-in keeps an Always allow for as long as it runs, across chats, so after the foreground-typing step above, later `computer use` prompts type without asking. Restart it (`hv down`, `hv up`) to ask again. A session grant is per chat, and the other delivery mode always asks: `computer use deny` asks for a foreground double click whatever was allowed.
- `wd.mjs wait <css> [text] [ms]` takes the timeout third, so a wait with no text needs one (`Screen` for the tab).
- The stand-in's first `computer use` prompt creates its Bot Desktop; before it, the Screen tab says "This Hermes has no screen".
- `computer use takeover` leaves the screen held until `/__lease?holder=agent`, so a later `computer use` prompt in the same run is refused too.
- Reopening a chat from Hermes shows the same steps marked "not recorded": Hermes keeps no result of a computer-use call.
- The note's "Hand back" shows only while the owner holds the screen from this connection, which takes the Screen tab's Take over on a live stream. The stand-in has no stream, so that branch can't be reached here; `src/ui/computerUseCard.test.tsx` covers it.
- The sidebar's Diagnostics item is below the fold, and clicking it by text returned "element click intercepted" in the first run. Use **Connection diagnostics**.
- The rows show only after the first read. Wait for the status line to leave "Checking…" before you assert a row.
- Without `HV_COMPUTER_USE` the stand-in has no Bot Desktop and no server machine, so every row from `display.status` reads Unknown, "This Hermes doesn't report it." That is the older-Hermes case, not a failure.
- The stand-in's doctor answers from FakeHermes, not a real cua-driver. For a real Hermes, start it as the real-dashboard section of [../SKILL.md](../SKILL.md) describes.
- A person holding the screen is shown as "a person", not as you. Hermes names the holder by a hash only the Screen tab matches to itself.
- "Memory" is also a Diagnostics feature row further down. Look inside the Computer use section.
