// Finished scheduled-job runs (#28). Hermes's scheduler runs a profile's jobs with this app closed or looking
// elsewhere, and records each run on the job (`last_run_at`, `last_status`). On the other-profiles check, every
// profile's job list is read over dashboard REST and each job's `last_run_at` compared with the one read before. The
// first read of a profile on a connection sets that baseline: it announces only the runs that finished after the
// connection came up, so the ones from before launch, or from while the connection was down, aren't announced in a
// burst, and one that finishes before the first timed check still is. Turning the watch off forgets what it read, and
// turning it on again starts from then.
import type { CronJob } from "./cronJobs";
import { eachAtMost } from "./otherProfiles";

/** A check asked for sooner than this after the last one started, on the same connection, is skipped. */
const MIN_GAP_MS = 60_000;
/** The most job lists one check reads at once. */
const AT_ONCE = 2;

/** A profile as the watch names it: its id, and its bot's name (bots.ts `botName`). */
export type WatchedProfile = { name: string; bot: string };

/** A job whose `last_run_at` moved forward since the last read, in its profile. */
export type FinishedJob = { profile: WatchedProfile; job: CronJob };

/**
 * What a check needs. `connection` is undefined while there is none; another value is a new connection, which came up
 * at `connectedAt` (Unix ms).
 */
export type JobRunWatchPort = {
  connection(): number | undefined;
  connectedAt(): number;
  enabled(): boolean;
  profiles(): Promise<WatchedProfile[]>;
  jobs(profile: string): Promise<CronJob[]>;
  finished(found: FinishedJob): void;
};

/** Each job's `last_run_at` as last read, by job id; undefined for a job that hasn't run. */
type LastRuns = Map<string, string | undefined>;

/** `now` is later than `before`. An unreadable time counts as later when it differs. */
function later(now: string, before: string | undefined): boolean {
  if (before === undefined) return true;
  if (now === before) return false;
  const [a, b] = [Date.parse(now), Date.parse(before)];
  return Number.isNaN(a) || Number.isNaN(b) || a > b;
}

/**
 * The jobs in `jobs` whose last run is later than `before` has it. A job new to the profile counts if it has run. With
 * no `before`, a first read, the runs later than `since` count, read on Hermes's clock against this computer's.
 */
export function movedOn(before: LastRuns | undefined, jobs: readonly CronJob[], since: number): CronJob[] {
  return jobs.filter((j) => j.lastRunAt !== undefined && (before ? later(j.lastRunAt, before.get(j.id)) : Date.parse(j.lastRunAt) > since));
}

export class JobRunWatch {
  /** What the latest read of each profile found, on one connection, and since when a profile's first read announces runs. */
  private seen?: { connection: number; since: number; byProfile: Map<string, LastRuns> };
  /** The watch was off at the last check, so the runs from before it was turned on are old news. */
  private off = false;
  private running?: { connection: number; done: Promise<void> };
  private last?: { connection: number; at: number };

  constructor(private port: JobRunWatchPort) {}

  /** Reads every profile's jobs and reports each run that finished since the last read. */
  check(): Promise<void> {
    const connection = this.port.connection();
    if (connection === undefined) return Promise.resolve();
    if (!this.port.enabled()) {
      this.seen = undefined;
      this.off = true;
      return Promise.resolve();
    }
    if (this.running?.connection === connection) return this.running.done;
    if (this.last?.connection === connection && Date.now() - this.last.at < MIN_GAP_MS) return Promise.resolve();
    this.last = { connection, at: Date.now() };
    if (this.seen?.connection !== connection) this.seen = { connection, since: this.off ? Date.now() : this.port.connectedAt(), byProfile: new Map() };
    this.off = false;
    const done = this.run(connection, this.seen.since, this.seen.byProfile).finally(() => this.running?.done === done && (this.running = undefined));
    this.running = { connection, done };
    return done;
  }

  private async run(connection: number, since: number, byProfile: Map<string, LastRuns>) {
    const current = () => this.port.connection() === connection && this.port.enabled() && this.seen?.byProfile === byProfile;
    let profiles: WatchedProfile[];
    try {
      profiles = await this.port.profiles();
    } catch {
      return;
    }
    if (!current()) return;
    for (const name of byProfile.keys()) if (!profiles.some((p) => p.name === name)) byProfile.delete(name);
    await eachAtMost(profiles, AT_ONCE, async (profile) => {
      if (!current()) return;
      let jobs: CronJob[];
      try {
        jobs = await this.port.jobs(profile.name);
      } catch {
        // What the last good read found stays, so the next one still compares with it.
        return;
      }
      if (!current()) return;
      const before = byProfile.get(profile.name);
      byProfile.set(profile.name, new Map(jobs.map((j) => [j.id, j.lastRunAt])));
      for (const job of movedOn(before, jobs, since)) this.port.finished({ profile, job });
    });
  }
}
