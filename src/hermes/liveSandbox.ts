// What keeps a live test (`*.live.test.ts`) that makes profiles on a real Hermes off the owner's own Hermes: the
// server's profiles must all resolve, symlinks followed, into a throwaway root the run names, and every profile the
// run tried to make is deleted again, or the run fails. Spelling alone proves nothing: `/tmp/x/home` may be a symlink
// to `~/.hermes`.

/** `path` strictly inside `folder`; both already resolved. */
const inside = (path: string, folder: string) => path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);

/**
 * Why a live run must not touch a server whose profiles live at `paths`, or undefined when it may: `root` (the run's
 * throwaway root) resolves to a folder inside `/tmp` that neither holds nor sits in `~/.hermes`, and every path
 * resolves inside it. `realpath` follows symlinks and throws for a path that doesn't exist; anything it can't resolve
 * refuses the run.
 */
export function sandboxRefusal(root: string | undefined, home: string | undefined, paths: string[], realpath: (path: string) => string): string | undefined {
  if (!root) return "HERMES_LIVE_SANDBOX doesn't name the throwaway root the server's HERMES_HOME is in.";
  if (!home) return "HOME isn't set, so ~/.hermes can't be ruled out.";
  if (!paths.length) return "the server lists no profiles.";
  const resolve = (path: string) => {
    try {
      return realpath(path);
    } catch {
      return undefined;
    }
  };
  const real = resolve(root);
  const tmp = resolve("/tmp");
  if (!real || !tmp || !inside(real, tmp)) return `${root} doesn't resolve to a folder inside /tmp.`;
  // ~/.hermes needn't exist; then its spelling is all there is to keep apart.
  const owner = resolve(`${home}/.hermes`) ?? `${home}/.hermes`;
  if (real === owner || inside(real, owner) || inside(owner, real)) return `${root} resolves into or around ${owner}.`;
  const outside = paths.filter((p) => {
    const resolved = resolve(p);
    return !resolved || !inside(resolved, real);
  });
  return outside.length ? `${outside.join(", ")} doesn't resolve inside ${real}.` : undefined;
}

/** What `removeAttempted` needs of `ProfilesApi`. */
export type ProfileRemover = { list(): Promise<{ name: string }[]>; remove(name: string): Promise<unknown> };

/**
 * Deletes each of `names` the server lists, then fails unless none of them is listed any more. A name is tracked
 * before its create is sent, so a profile made by a create whose answer was lost goes too.
 */
export async function removeAttempted(names: string[], profiles: ProfileRemover): Promise<void> {
  const listed = async () => new Set((await profiles.list()).map((p) => p.name));
  const there = await listed();
  const errors: string[] = [];
  for (const name of names.filter((n) => there.has(n))) await profiles.remove(name).catch((e: unknown) => errors.push(`${name}: ${String(e)}`));
  const after = await listed();
  const left = names.filter((n) => after.has(n));
  if (left.length || errors.length) throw new Error(`Couldn't delete this run's profiles ${left.join(", ") || "(none left)"}; ${errors.join("; ") || "no errors"}`);
}
