# Write with AI for SOUL.md: evidence

Evidence for ADR 0199: Write with AI on Settings → Persona.

A historical record: [ADR 0204](../../adr/0204-a-persona-is-edited-only-in-the-profile-form-and-write-with-ai-rewrites-it-in-place.md) removed Settings → Persona and this panel, and its `persona-ai` e2e feature with them.

## Where the screenshots come from

Every PNG here is from the native desktop app (Tauri, WebKitGTK), driven through WebDriver by the `verify-hermes-chat` skill (`.claude/skills/verify-hermes-chat/`), against its stand-in dashboard (`scripts/bridge.ts`, the repo's `FakeHermes` behind HTTP and WebSocket on loopback). Every profile is seeded test data: `default` (in use) and `work`. Every suggestion is a fixed answer the stand-in was told to give with `POST /__oneshot`. No real model wrote any of this text.

The BEFORE shots are from a build of `e87381b`, before this change. The AFTER shots are from a build of `a6bad64`. Its app source is the same as this branch's `cc06445`; the two differ only in two test lines that build a fake key at run time. They were taken before this branch merged ADR 0197's New bot changes, which don't touch Settings → Persona; the panel on Persona is the same code here.

| File | State |
| --- | --- |
| `before-persona-work-blank.png` | Before: Persona on `work` (not in use), a blank SOUL.md, no way to have Hermes write it. |
| `after-persona-work-suggested.png` | Notes typed into the panel, and the suggestion Hermes wrote for `work`. |
| `after-persona-work-applied-tweaked.png` | The edited suggestion applied, then a line typed by hand. Not saved yet. |
| `after-persona-work-saved.png` | Created SOUL.md on `work` and read it back. The stand-in then holds exactly this text for `work`, and `default`'s is unchanged. |
| `after-error-no-sign-in.png` | The model's provider has no sign-in on the server: the panel names the profile, the provider and the setting. |
| `after-stopped.png` | Stop while an answer was held: the answer, released later, never fills the editor. |

## Reproduce

```sh
S=.claude/skills/verify-hermes-chat/scripts
$S/hv build && $S/hv up            # then export the HV_RUN it prints
# sign in as features/sign-in.md says, then drive the steps above;
# POST /__oneshot sets the answer, a failure, signed-out providers, or holds answers until /__oneshot?release=1,
# and GET /__state shows each profile's SOUL.md under `souls` and every llm.oneshot call under `oneshots`.
npm run e2e -- --feature persona-ai   # the same flows in the browser harness
```
