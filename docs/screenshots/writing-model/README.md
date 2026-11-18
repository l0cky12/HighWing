# Writing model: evidence

Evidence for ADR 0205: the Writing model, which writes personas and project instructions for every bot with no model pinned on the server.

## Where the screenshots come from

Every PNG here is from the native desktop app (Tauri, WebKitGTK), built from `98beb0f` and driven through WebDriver by the `verify-hermes-chat` skill against its stand-in dashboard (`scripts/bridge.ts`, the repo's `FakeHermes` behind HTTP and WebSocket on loopback). The profiles are seeded test data: `default` (in use) and `work`. The stand-in keeps one model setup for both profiles, so unpinning Text generation on `default` also unpins it on `work`. Real Hermes keeps one per profile. Every suggestion is a fixed answer the stand-in was told to give. No real model wrote any of this text.

The keyring toast in some shots is expected here. The run's private D-Bus has no Secret Service.

| File | State |
| --- | --- |
| `01-settings-bots-pinned.png` | Settings → Model → Writing model with nothing picked. Both bots have Text generation pinned on the server, so the list says the Writing model doesn't apply to them. |
| `02-settings-unpinned-reread.png` | Use the main model for text generation, clicked on the same screen. The bot list reads again at once: each bot now writes with its own model. |
| `03-settings-writing-model-picked.png` | OpenRouter · deepseek-v4-pro picked. Both unpinned bots now use the Writing model. Picking wrote nothing to Hermes (no `PUT` in `bridge.log`). |
| `04-new-bot-hint.png` | New bot: the hint under Persona names the Writing model before Generate with AI. |
| `05-new-bot-suggestion.png` | Generate with AI. The stand-in got one `PUT /api/config?profile=default`, then `llm.oneshot` with `task: highwing_writing`. A second Generate sent another one-shot and no second `PUT`. |
| `06-new-bot-failure-words-only.png` | OpenRouter signed out on the server. The failure names the Writing model and where to change it, in words only: the form covers the window, so a link would open Settings behind it. |
| `07-persona-failure-link.png` | Settings → Persona, Improve with AI, same failure. Here **Open Writing model** is offered. |
| `08-persona-link-opens-setting.png` | **Open Writing model** opens Settings → Model with the Writing model heading focused. |

## Reproduce

```sh
S=.claude/skills/verify-hermes-chat/scripts
$S/hv build && HV_PERSONA_REPLY=<file> $S/hv up   # then export the HV_RUN it prints
# sign in as features/sign-in.md says, then drive the steps above;
# POST /__oneshot {"signedOut":["openrouter"]} signs the provider out, and
# GET /__state lists every llm.oneshot call (with its task) under `oneshots`.
```
