# Computer-use readiness is read from doctor and screen status with `-p` in argv

> **Accepted.** Phase 1 of computer use (issue #43). Settings → Diagnostics has a Computer use section that says, for the profile shown, whether each prerequisite of Hermes's `computer_use` is met, and when it isn't, why and what to do. The recordings it was written against are in `src/hermes/fixtures/computer-use/` (ADR 0213).

Hermes's `computer_use` needs a switched-on toolset, a working cua-driver, the Bot Desktop's packages, enough memory, a screen placement Hermes allows, and a screen no person is holding. A missing one shows up as a failed step in a reply, with no hint of which. Hermes already answers each part: `computer-use doctor --json` for the driver, and `display.status` for the rest. The toolset is in the toolsets list the app reads for Settings → Toolsets (ADR 0021).

## Decisions

- **`-p <profile>` goes in argv.** `cli.exec` ignores its `profile` parameter. The recording `00-readiness.jsonl` ran doctor without `-p` and got the `default` profile's answer: degraded, exit code 1, no X display. With `-p hermes-chat` (`01-readiness-p.jsonl`) it exited 0 with every check passing. `ScreenApi.doctor()` sends `["-p", profile, "computer-use", "doctor", "--json"]`. FakeHermes answers a doctor with no `-p` from the `default` profile's degraded result, so a test goes red if the `-p` is dropped.
- **One row for each prerequisite, from one table.** `computerUseReadiness.ts` lists `toolset`, `driver`, `packages`, `memory`, `placement` and `control`. A check is a function from the settled answers to a verdict: `ok`, `bad` with why and a fix, or `unknown` with why. `readinessOf` is pure, so the table tests run on the recorded output. `checkReadiness` is the shell that asks the three reads at once.
- **Hermes's words where it has them.** For the driver, each failing doctor check's message is the reason and the first hint is the fix. Exit code 2 (no driver) prints a sentence, not JSON, so its first line is the reason and its `Run: hermes ...` line is the command to copy. For memory and placement the reason is `display.status`'s `blocker`. Where Hermes has no words, the verdict carries a coded sentence of the app's own, written in English and Spanish.
- **A failed read is `unknown`, never green.** A blocked `cli.exec`, a Hermes with no `computer-use` command, a Hermes before the Bot Desktop and a read that errors each leave their rows unknown, with the reason. The summary says some rows couldn't be read.
- **`blocker` belongs to the memory row on a screen Hermes runs itself, and to the placement row in a sandbox.** In `runtime.py`, a host screen's blocker is only ever the memory floor, and a sandbox screen's blocker is the image or container it needs. Hermes has no field that names the refused placement; `placement` is `gateway` or `terminal:<backend>` and a refused one raises at the spawn. A `placement` of `refused` is handled as red if a later Hermes sends it.
- **The Bot Desktop being stopped is not red.** Hermes starts it when the agent needs it, so the packages row says so as detail.
- **A person holding the screen is red.** Hermes refuses `computer_use` with `human_has_control` then. Hermes's lease names the holder by a hash only the Screen tab can match to itself, so the row says "a person" and tells the owner where to hand it back.
- **Check again reads everything.** The section has its own button, so Bot Desktop's keeps its meaning (ADR 0078). The section reads when the connection opens or the profile changes, and drops an answer about a profile no longer shown.

## Considered options

- **Run `computer-use screen status --json` as well.** Rejected. It prints the fields `display.status` already returns, and the app already reads that for the Screen tab.
- **Show doctor's whole check matrix.** Rejected. On Linux most of its lines are `skip`. Only a failing check says something the owner can act on.
- **Send the `profile` parameter to `cli.exec`.** Rejected. Hermes ignores it, so the answer is for the wrong profile and looks right.

## Consequences

- A later phase reads the same readiness to say why a run refused. It calls `readinessOf`, not the wire.
- A newer Hermes that adds a doctor check shows up in the reason with no change here, because the app prints doctor's messages.
- The `-p` rule applies to every `cli.exec` that is about a profile. `installBrowser` is not, because `pm` is shared by every profile.
