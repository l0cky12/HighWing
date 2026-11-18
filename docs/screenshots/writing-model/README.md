# Writing model: evidence

Evidence for ADR 0209: the Writing model, which writes personas and project instructions for every bot with no model pinned on the server.

## Where the screenshots come from

Every PNG here is from the native desktop app (Tauri, WebKitGTK), built from `98beb0f` (01–03) and from `73ce8b0` after the rebase onto main's profile-form Persona (04–08), driven through WebDriver by the `verify-hermes-chat` skill against its stand-in dashboard (`scripts/bridge.ts`, the repo's `FakeHermes` behind HTTP and WebSocket on loopback). The profiles are seeded test data: `default` (in use) and `work`. The stand-in keeps one model setup for both profiles, so unpinning Text generation on `default` also unpins it on `work`. Real Hermes keeps one per profile. Every rewrite is a fixed answer the stand-in was told to give. No real model wrote any of this text.

The keyring toast in some shots is expected here. The run's private D-Bus has no Secret Service.

| File | State |
| --- | --- |
| `01-settings-bots-pinned.png` | Settings → Model → Writing model with nothing picked. Both bots have Text generation pinned on the server, so the list says the Writing model doesn't apply to them. |
| `02-settings-unpinned-reread.png` | Use the main model for text generation, clicked on the same screen. The bot list reads again at once: each bot now writes with its own model. |
| `03-settings-writing-model-picked.png` | OpenRouter · deepseek-v4-pro picked. Both unpinned bots now use the Writing model. Picking wrote nothing to Hermes (no `PUT` in `bridge.log`). |
| `04-new-bot-hint.png` | New bot: the hint under Persona names the Writing model before Write with AI. |
| `05-new-bot-rewritten.png` | Write with AI rewrote the field in place, with Undo. The stand-in got one `PUT /api/config?profile=default`, then `llm.oneshot` with `task: highwing_writing`. Undo and a second Write with AI sent another one-shot and no second `PUT`. |
| `06-new-bot-failure-words-only.png` | OpenRouter signed out on the server. The failure names the Writing model and where to change it, in words only: the form covers the window, so a link would open Settings behind it. |
| `07-edit-bot-hint.png` | Edit persona… on the `work` bot: Edit bot's hint names the Writing model for `work`. |
| `08-edit-bot-rewritten.png` | Write with AI in Edit bot: `llm.oneshot` on `work` with `task: highwing_writing`. No `PUT` this time, because the stand-in's one shared config already held the copy. |

## Reproduce

```sh
S=.claude/skills/verify-hermes-chat/scripts
$S/hv build && HV_PERSONA_REPLY=<file> $S/hv up   # then export the HV_RUN it prints
# sign in as features/sign-in.md says, then drive the steps above;
# POST /__oneshot {"signedOut":["openrouter"]} signs the provider out, and
# GET /__state lists every llm.oneshot call (with its task) under `oneshots`.
```
