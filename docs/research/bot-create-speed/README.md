# Where creating a bot spends its time

Measured on 2026-11-17 and 2026-11-18, to find out why New bot feels slow and what this app can do about it. Every number below comes from the real app, driven through the verify skill against the owner's real Hermes: 0.23.2, hermes-agent `ae2a81ccc0`, reached over Tailscale. The app was built from `main` at `3c15c76`, and the last three runs from `main` at `a4ffa20`. Both patches here apply to `a4ffa20`.

**Short answer.** From the click on **Create bot** to the new bot open, connected and with its models loaded, the median was 3.9 s while the Hermes host was lightly loaded and 5.3 to 5.7 s while it was busy. The app's code was the same in both. About 2.2 s of the median is Hermes's `POST /api/profiles`. Most of the rest is Hermes answering the calls that open the new bot. Every slow run, from 12 s to 19 s, was Hermes: either the create itself took 8 to 10 s, or one of Hermes's answers on the new bot's socket took about 10 s and held up every call behind it. The one change this app could make cut 0.17 s and would have overturned ADR 0066, so it is not shipped.

## How it was measured

`bench/bot-create/run.sh` does what the owner does. It opens **New bot** on the **Bots** tab, types only a name, and clicks **Create bot**. When the new row appears, it clicks the row, which switches to the bot's profile and opens its Bot Chat. A probe in the page (`probe.js`) times each step from the click. A bot counts as ready once no switch is in progress, the status bar says Connected, and the composer no longer says "Loading models…". The script then goes back to `default` and deletes the bot through the dashboard API. It waits 15 s between runs, because every profile switch signs in again and Hermes refuses sign-ins that come too often (run 8 of `main-instrumented` failed that way).

The Hermes host has 10 cores and a load average between 6 and 11 during these runs. It is the owner's working server, with its gateway, cron jobs and other sessions running, so it was not quiet. The A/B ran two app instances side by side and alternated runs between them, so both saw the same load.

## The runs

`runs.tsv` holds every run. `node bench/bot-create/summary.mjs docs/research/bot-create-speed/runs.tsv` prints this table.

| Label | Build | When | Runs | Ready: median (min–max) | Form closed: median (min–max) |
| --- | --- | --- | --- | --- | --- |
| `main-night` | `main` | 22:32, busy host | 7 | 5.34 s (4.7–19.1) | 2.62 s (2.4–3.2) |
| `main-instrumented` | `main` + `instrument.patch` | 22:38 | 10 (1 refused) | 4.25 s (3.8–18.4) | 2.19 s (2.1–10.2) |
| `main-ab` | `main` | 22:50, A/B | 7 | 5.67 s (5.2–17.2) | 2.73 s (2.4–8.3) |
| `lookup-skipped-ab` | `main` + `lookup-skipped.patch` | 22:50, A/B | 6 | 5.57 s (5.2–6.2) | 2.70 s (2.5–2.8) |
| `main-morning` | `main` | 07:26, lighter host | 7 | 3.88 s (3.7–15.8) | 2.23 s (2.0–9.4) |
| `main-bench-check` | `main` | 07:31 | 2 | 3.87 s (3.7–4.0) | 2.23 s (2.2–2.3) |
| `main-a4ffa20` | `main` at `a4ffa20` | 07:45 | 2 | 3.6 s and 15.8 s | 2.1 s and 8.5 s |
| `main-a4ffa20-instrumented` | `main` at `a4ffa20` + `instrument.patch` | 07:47 | 1 | 3.45 s | 1.95 s |

"Form closed" is the click to the dialog closing. That is Hermes's `POST /api/profiles` plus a few milliseconds of the app.

## Where one create goes

`instrument.patch` (not shipped) records a timestamp for each REST call, each JSON-RPC call, and each step of the profile switch. `bench/bot-create/phases.py` splits each run into steps. `phases.tsv` has the seven `main-instrumented` runs that finished. These are their medians, in milliseconds:

| Step | Median | What happens |
| --- | --- | --- |
| `post` | 2149 | Hermes's `POST /api/profiles` |
| `roster` | 143 | `profiles.list`, so the new row can show |
| `click` | 309 | The script finding and clicking the row. A person takes longer. |
| `reconnect` | 300 | Status check, sign-in, ticket and a new `/api/ws` for the bot's profile |
| `chatlist` | 87 | `GET /api/sessions` for the new profile |
| `session_list` | 430 | Looking up the Bot Chat by title (ADR 0066) |
| `create` | 126 | `session.create` for the Bot Chat |
| `title` | 366 | `session.title`, which stores it |
| `resume` | 92 | Opening the chat |
| `ready` | 4146 | Total |

### Hermes's create is the floor

A create from curl, with no app involved, took 2.4 s, 3.2 s, and 5.3 s including a sign-in. The new profile's file times on the server, and the gateway's log, show where the 3.2 s went:

| Time on the server | What Hermes did |
| --- | --- |
| 0.00 s | Made the profile's folders |
| 0.12 to 1.16 s | Created `state.db`. Its full-text index lock appears only at 1.12 s, so nearly all of this second is the database and its schema. |
| 1.16 to 1.41 s | Wrote the WAL, `runtime/` and `cache/` |
| 1.41 to 2.13 s | Nothing that leaves a file or a log line: publishing the folder and notifying the gateway fall in this gap |
| 2.13 to 2.39 s | The gateway loaded its 62 plugins again and started serving the profile |
| 2.39 to 2.73 s | Copied the built-in skills into the profile, in a new Python process |
| 2.73 to 3.16 s | Wrote `.env` and `config.yaml` with the shared credentials and model, then answered |

None of this depends on what the app sends. The app sends only the name, as curl did. A profile without the built-in skills would save about 0.35 s, but that changes what a new bot can do, so it is not a speed fix.

### Hermes answers one socket's calls in order

Hermes's `/api/ws` runs most calls one at a time, in the order they arrive ("Dispatch controls in arrival order" in `tui_gateway/ws.py`). When the app connects to the new profile, it sends the calls every connection makes: `commands.catalog`, `model.options`, `profiles.list`, `subagent.roster`, `session.active_list`, `projects.list` and `config.get`. The Bot Chat's calls arrive after them and wait. So the 430 ms of `session_list` is mostly waiting in line, not the lookup itself.

### The slow runs wait on Hermes

Two kinds of run took 12 to 19 s:

- **The create took 8 to 10 s** (`bpt-inst-1`, `bpt-a1-3`, `bpt-am-7`, `bpt-newmain-1`). In `bpt-inst-1` the roster listed the new bot at 6.8 s while `POST /api/profiles` was still running, until 10.1 s. Hermes makes the profile visible before it finishes setting it up.
- **One call on the new bot's socket took about 10 s** (`bpt-inst-4` and `bpt-inst-10`; `bpt-base-3`, which had no timing marks, stalled at the same point for 16 s). In `bpt-inst-4`, `session.title` took 9,983 ms. In `bpt-inst-10`, `session.list` took 10,469 ms and `session.title` another 4,646 ms. Every JSON-RPC call sent after the slow one waited, then they all answered together, while REST calls stayed fast. That fits Hermes's in-order lane, described above. These calls took 0.2 to 0.5 s in the other runs. What makes one of them take 10 s inside Hermes is not found. A wait of almost exactly 10 s looks like a lock or a timeout, but that is a guess. The gateway's "Re-scanned profile … after config/.env change" line is not the cause: twelve test bots got it, nine of those runs were not slow, and in `bpt-inst-10` it came after the stall had ended.

## What was tried in the app

### Skip the Bot Chat lookup for a bot without one

`lookup-skipped.patch` skips `session.list` when the roster just reported no Bot Chat, and lets `session.title` find a clash instead: Hermes refuses a second chat with that title (code 4022), and the existing path then opens the other one. In the A/B, the click on the row to ready went from a median of 2.61 s (2.3 to 8.0) to 2.44 s (2.2 to 2.7), 0.17 s faster. That is less than the 0.43 s the lookup took, because `session.create` then waits in the same line. The whole create went from 5.67 s to 5.57 s, inside the spread of either build.

It is not shipped. ADR 0066 chooses the lookup on every open, and `bots.test.ts` holds its fail-closed rules: a failed or unreadable lookup creates nothing, and a Hermes without the lookup is reported as having no Bot Mode. Skipping the lookup drops those checks for every bot without a Bot Chat, for 0.17 s.

### Keep the old connection's sign-in on a switch (measured, not tried)

Each switch reads `/api/status`, signs in again, and asks for a ticket before it opens the new socket (ADR 0120). On four switches between existing profiles, the status read took 200 to 309 ms. A curl probe every 50 ms took 116 ms at the median, but 300 to 387 ms at the moment of each switch. So most of the status read is Hermes being busy with the old socket closing and the new one opening, not the app. Skipping the status read and sign-in would save at most about 0.25 s, and the status read is the check ADR 0120 makes before any credential goes out.

## What Hermes would need

These are changes to Hermes, not to this app:

- Find why `session.title` or `session.list` on a profile made seconds earlier sometimes takes 10 s.
- Make creating a new profile's empty `state.db` cheaper (about 1 s of each create), and find what fills the 0.7 s gap that leaves no trace.
- Answer `POST /api/profiles` once the profile is visible, or finish setting it up before it is visible, so a client doesn't see a bot it can't use yet.
- Close a deleted profile's `state.db`. After each delete, the gateway and the dashboard kept the deleted file open, and `errors.log` gained a "state.db was replaced underneath the gateway" line about every second. A gateway restart closes them.

## Reproduce

1. Start the app under the verify skill against a real dashboard: `hv build`, then `hv up --dashboard <url>`.
2. Sign in: `HERMES_USER=<name> HERMES_PASSWORD_FILE=<file> bench/bot-create/signin.sh`.
3. Time some creates: `bench/bot-create/run.sh <label> <runs> <out.tsv>`. Each run makes a bot named `bpt-<label>-<n>-<time>` and deletes it.
4. Summarize: `node bench/bot-create/summary.mjs <out.tsv>`.

For the step split, apply `instrument.patch` before `hv build`, set `TRACE_DIR` for `run.sh`, and run `python3 bench/bot-create/phases.py <TRACE_DIR>/*.json`.

Hermes keeps a marker under `profiles/.deleted/` for each deleted profile. Remove the `bpt-` ones once the runs are done, unless a Hermes process still holds that profile's files open.
