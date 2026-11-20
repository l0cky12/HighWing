# A finished job run is announced from the job list's last run, against a baseline

> **Accepted.** Follows ADR 0013 and ADR 0184. The watch is `src/hermes/jobRunWatch.ts`, the notification `announceRun` and `NOTICES.jobRan` in `src/hermes/transport.ts`, the click `noticeEntry` in `src/App.tsx`, and the switch `src/ui/JobRunSettings.tsx`.

A scheduled job runs while the owner is elsewhere, and its result is why the owner made it. Until now a run arrived silently: the owner found it only by opening Scheduled jobs. A run that failed at 3 a.m. went unseen until then (#28).

## Decisions

- **The app watches each job's `last_run_at`.** Hermes records each finished run on the job, with `last_status` (`cron/jobs.py`). On the other-profiles check, which runs about every 2 minutes on every live connection, the app reads `GET /api/cron/jobs` for each profile. A job whose `last_run_at` is later than the one read before has finished a run. A job new to a profile counts once it has run.
- **The first read sets a baseline as of when the connection came up.** The first read of a profile records where its jobs stand. It announces only a run whose `last_run_at` is later than the moment the connection came up, so runs from before launch aren't announced in a burst, and a run that finishes before the first timed check still is. A dropped connection starts a new baseline from when it came back, since runs that finished while it was down are old news. A profile switch or a reroute opens a new pipe on purpose and keeps the baseline. A profile whose jobs can't be read keeps its last good read, so the next read still compares with it.
- **The notification names the job, its bot and the result.** The title is the bot's name, as the profile switcher shows it (the `profiles.list` roster, ADR 0195), and the job's name, with "failed" when `last_status` reads as a failure (`statusLabel`) and "ran" otherwise. The body is the result in words. It never quotes the run's prompt or reply. With more than one connection live, the server's name leads, as for every notification.
- **A click opens that run read-only.** For an agent job the app reads the newest finished run (`GET /api/cron/jobs/{id}/runs?limit=5`) and the click opens its session as a Job-run chat (ADR 0184): through the inbox's route on the target connection, switching profile when needed, and through a chat link on a background connection. A script run has no session, so its notification has no click action.
- **It stays quiet when the owner would see the run anyway.** As for every notification, nothing shows while the window has focus on the target connection. Nothing shows for a profile whose Scheduled jobs are on screen.
- **The owner can turn it off.** Settings → General → Chats → **Notify when a job runs**, on by default and kept on this computer. Off, the app reads no jobs for it and forgets the baseline, so turning it on again starts from a fresh read. A server without the cron routes isn't read either.

## Considered options

- **Read every profile's jobs as the connection comes up.** That sets the baseline without comparing Hermes's clock with this computer's. But it adds a profile list and a job list per profile to the burst of reads at every connect, for an answer the first timed check gives anyway.

- **Watch cron sessions in the session list.** The profile on screen hears store changes over the socket. But other profiles are seen only on the 2-minute check anyway, and a session row says less about a failure than `last_status`.
- **Put job runs in the Inbox as Completed entries.** That gets notifications from the inbox's path, but it changes what a Job-run chat may do (`CHAT_POLICY`, ADR 0184) and what the Inbox means (ADR 0019).

## Consequences

- Each check reads one job list per profile, and one more read for each run announced. With 8 live connections that is up to 8 more reads per profile every 2 minutes.
- The first read compares Hermes's `last_run_at` with this computer's clock. Clocks a few seconds apart can announce a run that ended just before the connection came up, or miss one that ended just after.
- The notification can come up to about 2 minutes after the run. A run that finishes and is followed by another before the next check is announced once, for the later run.
- Per-bot switches, as Grok Bot has, are left out. The one switch covers every bot.
