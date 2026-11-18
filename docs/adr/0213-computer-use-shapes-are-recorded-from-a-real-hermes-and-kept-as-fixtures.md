# Computer-use shapes are recorded from a real Hermes and kept as fixtures

> **Accepted.** Phase 0 of computer use (issue #43). The app reads `computer_use` frames as the owner's Hermes v0.23.2 sends them, not as the build spec or Hermes's docs describe them. The recordings are in `src/hermes/fixtures/computer-use/`, the scripts that make them are in `tools/computer-use-capture/`, and the findings are in `docs/research/computer-use-payloads.md`.

The computer-use build spec listed the frames HighWing would read: `tool.start` with a `context`, `tool.complete` with a screenshot in `result`, and an `approval.request` event. It marked all three as unverified. A parser written from that list would have been wrong in three places. The approval is a server request named `approval`. The detail is in `args`, and `context` is empty. Stored history renames each call to `tool_call`. Each of these would have failed silently: a generic row, a missing card, an empty timeline after a reload.

## Decisions

- **Shapes come from a recording of a real turn.** A recorder signs in to the dashboard as the app does, runs a real model turn on the Bot Desktop, answers the approvals, takes the lease or interrupts on cue, and writes every frame to JSONL. The parser's tests read the frames it recorded.
- **The fixtures are cut, not rewritten.** `fixtures.mjs` keeps only the frames the app reads for computer use and leaves each one as Hermes sent it, with two exceptions. A data URL longer than 4096 characters is cut to its first 4096, and `manifest.json` lists the original length. Each display ticket becomes `<ticket>`. A cut URL is still a `data:` URL long enough for `toolResult.ts` to swap, so a test of the swap still means something.
- **A shape that was not recorded is named as such.** `docs/research/computer-use-payloads.md` lists the actions and scopes that come only from Hermes's source. No fixture holds them, and the app shows them as plain lines.
- **The recorder and the fixture script are committed.** A later Hermes can change any of these shapes. Rerunning the two scripts against a newer server shows the change as a diff of the fixtures.

## Considered options

- **Write the fixtures from Hermes's source.** Rejected for the shapes a recording could reach. Reading the source predicted the shapes correctly, but it could not show the two things that depend on configuration: `cli.exec` ignoring its `profile` parameter, and history renaming calls to `tool_call`. It remains the source for the shapes listed as not recorded.
- **Record through the app.** The desktop app's Rust side makes the connection and keeps no log of frames. Adding one would put a frame log in the shipped app for the sake of one test.
- **Keep the full screenshots.** Each is 20 to 80 KB of base64. The tests need a long data URL, not a picture, so the cut versions do the same job at a tenth of the size.

## Consequences

- `src/hermes/computerUse.ts` and its tests (phase 2) are written against these fixtures.
- Each new computer-use shape the app relies on needs a recording first, or a line in the research note's "Not recorded" list.
- The recordings hold the owner's Bot Desktop, the profile's paths and one session's prompts. They hold no credentials, because the recorder never logs its sign-in.
