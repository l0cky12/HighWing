# The Subagents panel lists only running subagents: evidence

Evidence for ADR 0195: a subagent leaves the Subagents panel when it ends, and the panel hides when none are running.

## Where the screenshots come from

Every PNG here was taken by `tools/shots/shoot.mjs`, which builds the signed-in app (`tools/shots/main.tsx`) and screenshots it in headless Chromium at 1920×1080. The app runs against an in-page `FakeHermes`. No real Hermes server or user data is involved. The chat "NAS disk usage" and its five subagents are the script's own made-up data: two running, one finished, one failed and one stopped.

| File | State |
| --- | --- |
| `before-ended-still-listed.png` | Before the change (`main`, scene `subagents-list`): the panel lists all five, with "2 running · 1 failed · 5 in all". |
| `after-only-running-listed.png` | After (scene `subagents-list-ended`): the same five, with only the two still running listed, and "2 running". |
| `after-none-left-no-panel.png` | After (scene `subagents-none`): all five ended, and the panel is gone. |
| `after-open-failed-stays.png` | After (scene `subagent-details-failed`): the owner had the Docker subagent open when it failed. Its view stays, with why it failed and no Steer or Stop. |

## Reproduce

```sh
node tools/shots/shoot.mjs subagents-list-ended subagents-none subagent-details-failed   # writes tools/shots/out/*.png
npx vitest run src/ui/subagents.test.tsx src/hermes/subagents.test.ts --maxWorkers=1
```

For the before shot, run `node tools/shots/shoot.mjs subagents-list` on `main`.
