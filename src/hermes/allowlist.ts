// Settings → Approvals: the commands Hermes always allows for a profile, and Remove (ADR 0236, issue #27).
//
// What the server offers (Hermes `ae2a81c`):
// - An "always" answer to an Approval saves the command's pattern name in the profile's `command_allowlist` in
//   config.yaml (`tools/approval.py` `save_permanent_allowlist`). Every guarded command re-reads that list from disk
//   first (`_sync_permanent_from_disk`), so a name removed there makes Hermes ask again, with no restart.
// - Rust reads the list from `GET /api/config?profile=` and passes on nothing else (`Pipe.commandAllowlist`).
// - `PUT /api/config?profile=` `{config: {command_allowlist: [...]}}` deep-merges over the stored file under the config
//   lock, and a list replaces the stored one whole (`_deep_merge`). Rust relays that body only with the list alone.
// - There is no revision to write against, so a Remove reads again first, refuses if the list changed, and reads back.
import { RestError, type CommandAllowlist, type RestMethod } from "./pipe";
import { errorText } from "./values";

export type { CommandAllowlist };

/**
 * What a Remove did. `now` is the list as Hermes last answered it, undefined when that read failed.
 * - `removed`: the read back is the list sent. `writeError`: the write's own answer was lost or an error, yet the read
 *   shows it took.
 * - `changed`: the read just before writing found another list than the one shown. Nothing was sent.
 * - `refused`: Hermes answered the write with a 4xx, so it wrote nothing.
 * - `differs`: the write went, but the read back isn't the list sent: `back` names the entry when it is still there,
 *   `added` what another client added after the write, `gone` what it removed.
 * - `unknown`: the write's answer was lost or an error, and the read after it failed too.
 */
export type RemoveOutcome =
  | { kind: "removed"; now: CommandAllowlist; writeError?: string }
  | { kind: "changed"; now: CommandAllowlist }
  | { kind: "refused"; why: string; now?: CommandAllowlist }
  | { kind: "differs"; now: CommandAllowlist; back: boolean; added: string[]; gone: string[]; writeError?: string }
  | { kind: "unknown"; why: string };

/** Whether two lists hold the same entries, as Hermes reads them: a set, in any order. */
export function sameEntries(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((e) => y.has(e));
}

/** The list Remove sends: every copy of `entry` dropped, everything else as Hermes holds it. */
export function without(entries: readonly string[], entry: string): string[] {
  return entries.filter((e) => e !== entry);
}

export class AllowlistApi {
  /** Removes run one at a time for the whole app, so two can't each write a list missing the other's change. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly read: (profile: string) => Promise<CommandAllowlist>,
    private readonly rest: (method: RestMethod, pathAndQuery: string, body?: unknown) => Promise<unknown>,
  ) {}

  list(profile: string): Promise<CommandAllowlist> {
    return this.read(profile);
  }

  /** Removes `entry` from `profile`'s list, if the list Hermes holds is still `shown`. */
  remove(profile: string, shown: readonly string[], entry: string): Promise<RemoveOutcome> {
    const run = this.queue.then(() => this.removeNow(profile, shown, entry));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async removeNow(profile: string, shown: readonly string[], entry: string): Promise<RemoveOutcome> {
    const before = await this.read(profile);
    if (before.kind !== "list" || !sameEntries(before.entries, shown)) return { kind: "changed", now: before };
    const sent = without(before.entries, entry);
    let writeError: string | undefined;
    try {
      await this.rest("PUT", `api/config?profile=${encodeURIComponent(profile)}`, { config: { command_allowlist: sent } });
    } catch (e) {
      if (e instanceof RestError && e.status >= 400 && e.status < 500) {
        return { kind: "refused", why: e.detail, now: await this.read(profile).catch(() => undefined) };
      }
      writeError = errorText(e);
    }
    let now: CommandAllowlist;
    try {
      now = await this.read(profile);
    } catch (e) {
      return { kind: "unknown", why: writeError ?? errorText(e) };
    }
    if (now.kind !== "list") return { kind: "differs", now, back: false, added: [], gone: [], writeError };
    if (sameEntries(now.entries, sent)) return { kind: "removed", now, writeError };
    return {
      kind: "differs",
      now,
      back: now.entries.includes(entry),
      added: now.entries.filter((e) => e !== entry && !sent.includes(e)),
      gone: sent.filter((e) => !now.entries.includes(e)),
      writeError,
    };
  }
}
