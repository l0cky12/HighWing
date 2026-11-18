# What Hermes sends for computer_use

The computer-use build spec marked three payloads as unverified: the context in `tool.start`, the result in `tool.complete`, and the approval request. This note records what the owner's Hermes server sent for them on 2026-11-18, and where that differs from the spec. The recordings became the fixtures in `src/hermes/fixtures/computer-use/` (ADR 0211). The scripts are in `tools/computer-use-capture/`.

## Setup

- Hermes Agent v0.23.2 (2026.9.24), commit `ae2a81ccc00e`, on the owner's server. The dashboard was reached over the tailnet with a password sign-in, as the app does.
- Profile `hermes-chat` with model `gpt-6.1-sol`. The `computer_use` toolset was on, and `hermes -p hermes-chat computer-use doctor` passed every check.
- The Bot Desktop was set to `bot_desktop.geometry: 1280x800`, and `approvals.mode` to `manual` so that every input action asks first. Both changes were made for this work, and the previous `config.yaml` is kept beside it.
- Each turn was a real model turn on the Bot Desktop. The recorder answered the approvals and took the lease. It did not change what Hermes sent.

## Recordings

| Fixture | What it holds |
| --- | --- |
| `00-readiness.jsonl` | `cli.exec` of `computer-use doctor --json`, `screen status --json` and `status` without `-p`, and `display.status`. |
| `01-readiness-p.jsonl` | `computer-use doctor --json` and `screen status --json` with `-p hermes-chat` in argv. |
| `10-turn-approve.jsonl` | 10 `computer_use` calls with background delivery: captures and clicks. One approval is answered `once` and one `session`. |
| `11-turn-foreground.jsonl` | Foreground click, type and key. The approvals are answered `session`, `once` and `always`. A second key press then runs with no prompt. |
| `12-turn-deny.jsonl` | A foreground double click, answered `deny`. |
| `13-turn-takeover.jsonl` | The lease is taken after the first capture. The next call, a scroll, is refused with `human_has_control`. |
| `14-turn-interrupt.jsonl` | `session.interrupt` after a capture and a wait. |
| `15-resume-history.jsonl` | `session.resume` of the turn in `10-turn-approve.jsonl`, showing how stored history keeps computer-use calls. |
| `16-hold-no-stream.jsonl` | `display.observe` and `display.lease.acquire` with no stream opened, then `display.status` every 15 s. |

## Findings

### tool.start

The payload is `{tool_id, name: "computer_use", context, args}`. `context` is empty for every action except `type`, where it is the typed text. All the detail is in `args`: `action`, then `mode`, `app`, `coordinate`, `element`, `text`, `keys`, `direction`, `amount`, `seconds`, `delivery_mode` and `capture_after`. A card has to read `args`, not `context`.

### tool.complete

The payload is `{tool_id, name, args, duration_s, result}`. `result` is an object, never a string, in one of these shapes:

- **A capture** is multimodal: `{_multimodal: true, content: [text, image_url], text_summary, meta}`. The text starts with `capture mode=som 1280x800 app=Xfdesktop`, then the element count and lines such as `#0 window 'Desktop' @ bounds-unknown`. The image is an inline `data:image/png;base64,…` URL. The largest seen was 78,030 characters, for a full 1280x800 desktop.
- **An input action with `capture_after`** is multimodal too. Its text is the action's own JSON, for example `{"ok": true, "action": "click", "message": "✅ Clicked at (22.0, 21.0) × 1 (delivery_mode=background).", …}`. The `action` there can be Hermes's internal name (`type_text`, `press_key`, `hotkey`), not the name the model called.
- **An input action without `capture_after`** is `{ok, action, message, effect, delivery_mode, meta, verdict}`. `verdict.decision` is `done`, `verify_fresh_state` or `escalate`. A failure is `{ok: false, action, message, escalation?}`. For example, a background click with no active window returned `No active window — call capture() first.`
- **A wait** is `{ok: true, action: "wait", message: "waited 2.00s", verdict}`.
- **A denied action** is `{error: "BLOCKED: Action denied by user. …", action}`.
- **A refusal while a person holds the screen** is `{ok: false, action, code: "human_has_control", error: "A human has taken over this desktop …"}`. It comes before any approval prompt.

The screenshot is inline in the frame. ADR 0061's swap in `toolResult.ts` already keeps it out of the chat text.

### The approval

On the legacy `/api/ws` an approval is a server request named `approval`, not an `approval.request` event as the spec has it:

```json
{"id": "srq-f3f2554546f2", "method": "approval", "params": {
  "session_id": "cddd5e9c",
  "command": "computer_use: click at (619, 777)",
  "pattern_key": "cua:click:background", "pattern_keys": ["cua:click:background"],
  "description": "Allow computer_use to perform `click`?",
  "allow_permanent": true, "allow_session": true,
  "request_id": "b72cb0da85a840a8bc1c959130624a68", "timeout_s": 180,
  "choices": ["once", "session", "always", "deny"]}}
```

- A foreground action adds ` [FOREGROUND — briefly raises the window / changes focus]` to `command`, and its key ends in `:foreground`.
- The commands seen were `click at (x, y)`, `double_click at (x, y)`, `type 'echo highwing-capture'`, `key 'return'` and `scroll down x3`.
- `approval.respond {session_id, choice, request_id}` answered `{resolved: 1}`, then Hermes sent `request.cancel {id, method: "approval", reason: "resolved"}`.
- `always` wrote the key to the profile's `command_allowlist`. `session` covered the same key for the rest of the session. Neither covers the other delivery mode, because the mode is part of the key.

### The lease

- `display.observe` and `display.lease.acquire` need `profile`. Without it, `display.observe` answered `this profile's Bot Desktop is not running` for a running `hermes-chat` screen, because it looked at `default`. The app already sends `profile`.
- Taking the lease broadcast `display.lease {profile_key, lease: {holder: "human", epoch: 1, viewer_hash, reason, since, viewer_id: null}}` with `session_id: ""`. Handing it back broadcast `holder: "agent"` with the next epoch.
- A viewer that never opens the stream keeps the lease. In `16-hold-no-stream.jsonl` the lease stayed `human` for 105 s, across seven status reads, until the recorder released it. So the app can take the screen for Stop without opening the Screen tab.

### Interrupt

`session.interrupt` answered `{status: "interrupted"}`. `message.complete` with `status: "interrupted"` followed within 100 ms, between two steps.

### Stored history

A stored turn keeps no `computer_use` rows under that name. Each call is a row named `tool_call`, with `context: "Computer Use"` and `args: {calls: [{name: "computer_use", arguments: {…}}]}`, and it has no result. So a chat reopened from Hermes can show what each step did, but not its outcome, and no screenshot is stored.

### Readiness

- `cli.exec` ignores its `profile` parameter. Run without `-p`, doctor checked profile `default`, found no X display and reported `degraded` with exit code 1. With `-p hermes-chat` in argv it exited 0 and every check passed.
- `computer-use doctor --json` prints `{checks: [{name, status: pass|fail|skip, message, hint?}], overall, driver_version, …}`. It exits 0 for ok, 1 for degraded and 2 for no driver.
- `computer-use screen status --json` prints the `display.status` fields: `supported`, `installed`, `missing`, `running`, `geometry`, `memory_available_mb`, `memory_limit_mb`, `placement`, `blocker` and `lease`.

## Not recorded

These shapes come from Hermes's source (`tools/computer_use/`), not from a recording, and no fixture holds them: `list_apps`, `list_windows`, `focus_app`, `set_value`, `drag`, `right_click`, `middle_click`, a click by `element`, and the `bring_to_front` approval scope (`cua:bring_to_front:<mode>`). The app treats them by their `action` name and shows their `message` or `error` as text, so an unrecorded shape degrades to a plain line.

## Timing

The model, not the screen, set the pace, as `docs/research/computer-use-speed` found. Hermes's own usage frames reported an average model latency of 2.4 to 4.5 s per call. Captures took 0.4 to 1.4 s, and input actions took 0.05 to 0.7 s.
