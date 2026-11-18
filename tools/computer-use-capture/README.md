# Computer-use capture

These two scripts record what a real Hermes sends for `computer_use`, then turn the recordings into the fixtures in `src/hermes/fixtures/computer-use/`. The app's parser and its tests read those fixtures, so they test the shapes Hermes sends, not the shapes its docs describe (ADR 0211).

## Record a turn

`record.mjs` signs in to a dashboard with a username and a password, opens `/api/ws`, and writes every frame it sends and receives to a JSONL file. Each line is `{t, dir, frame}`. `t` is milliseconds since the start, and `dir` is `in`, `out` or `note`.

```sh
node tools/computer-use-capture/record.mjs \
  --base http://<host>:<port> --user <name> --password-file <file> --profile <profile> \
  --out <recordings>/10-turn-approve.jsonl \
  --answers once,session,deny \
  --prompt "Use your computer_use tool ..."
```

| Option | Does |
| --- | --- |
| `--answers a,b,c` | Answers the first approval with `a`, the second with `b`, and so on. The last answer repeats. Each one is sent as `approval.respond`. |
| `--take-over-after N` | After the Nth `computer_use` result, sends `display.observe` and `display.lease.acquire`, as Take over does. The lease is released when the turn ends. |
| `--interrupt-after N` | After the Nth `computer_use` result, sends `session.interrupt`. |
| `--cli "argv; argv"` | Runs each argv through `cli.exec` before the turn. Put `-p <profile>` in the argv, because `cli.exec` ignores its `profile` parameter. |
| `--resume <stored id>` | Resumes a stored session and records its history. |
| `--hold-s N` | Takes the lease with no stream open, as Stop does, and reads `display.status` every 15 s for N seconds. |
| `--timeout-s N` | Interrupts the turn after N seconds. The default is 600. |

The password file is read only by the script. Keep recordings outside the repository, because they hold full screenshots.

## Make the fixtures

```sh
node tools/computer-use-capture/fixtures.mjs <recordings> src/hermes/fixtures/computer-use
```

The script keeps the frames the app reads for computer use: tool starts and results, approvals and their answers, lease changes, interrupts, display calls, `cli.exec` and history. It drops chatter such as deltas, usage and the skin, and replaces each display ticket with `<ticket>`. It cuts each data URL longer than 4096 characters to its first 4096. `manifest.json` lists the original length of every cut URL, and the Hermes version the recordings came from.
