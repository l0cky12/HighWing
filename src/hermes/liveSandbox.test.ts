// The live tests' guard and cleanup (liveSandbox.ts): the guard on a real file system, symlinks included, and the
// cleanup against a stand-in profiles API.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { removeAttempted, sandboxRefusal } from "./liveSandbox";

const dir = mkdtempSync("/tmp/live-sandbox-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ROOT = `${dir}/root`;
const OWNER = `${dir}/owner`;
mkdirSync(`${ROOT}/home/profiles/bot`, { recursive: true });
mkdirSync(`${OWNER}/.hermes/profiles/mine`, { recursive: true });
// What the review found the old guard let through: a home under /tmp by name that is the owner's Hermes.
symlinkSync(`${OWNER}/.hermes`, `${ROOT}/linked`);
symlinkSync(`${OWNER}/.hermes`, `${dir}/linked-root`);

describe("sandboxRefusal", () => {
  const refusal = (root: string | undefined, paths: string[]) => sandboxRefusal(root, OWNER, paths, realpathSync);

  it("lets a run touch a server whose every profile resolves inside the throwaway root", () => {
    expect(refusal(ROOT, [`${ROOT}/home`, `${ROOT}/home/profiles/bot`])).toBeUndefined();
  });

  it("refuses a profile under the root by name that a symlink puts in the owner's Hermes", () => {
    // The spelling the old guard checked: under /tmp, so it passed.
    expect(`${ROOT}/linked/profiles/mine`.startsWith("/tmp/")).toBe(true);
    expect(refusal(ROOT, [`${ROOT}/home`, `${ROOT}/linked`, `${ROOT}/linked/profiles/mine`])).toContain(`${ROOT}/linked, ${ROOT}/linked/profiles/mine doesn't resolve inside`);
  });

  it("refuses a root that is a symlink to or into the owner's Hermes, or holds it", () => {
    expect(refusal(`${dir}/linked-root`, [`${dir}/linked-root/profiles/mine`])).toContain("resolves into or around");
    expect(refusal(OWNER, [`${OWNER}/.hermes`])).toContain("resolves into or around");
  });

  it("fails closed: no root, no HOME, no profiles, a path that doesn't exist, a root outside /tmp", () => {
    expect(refusal(undefined, [`${ROOT}/home`])).toContain("HERMES_LIVE_SANDBOX");
    expect(sandboxRefusal(ROOT, undefined, [`${ROOT}/home`], realpathSync)).toContain("HOME");
    expect(refusal(ROOT, [])).toContain("no profiles");
    expect(refusal(ROOT, [`${ROOT}/gone`])).toContain("doesn't resolve inside");
    expect(refusal(`${dir}/missing`, [`${ROOT}/home`])).toContain("inside /tmp");
    expect(sandboxRefusal("/srv/x", OWNER, ["/srv/x/home"], (p) => p)).toContain("inside /tmp");
  });
});

describe("removeAttempted", () => {
  /** A server's profiles; `failing` names one whose delete throws and leaves it. */
  const server = (names: string[], failing?: string) => {
    const there = new Set(names);
    const removed: string[] = [];
    return {
      removed,
      list: async () => [...there].map((name) => ({ name })),
      remove: async (name: string) => {
        if (name === failing) throw new Error("500 busy");
        there.delete(name);
        removed.push(name);
      },
    };
  };

  it("deletes a profile whose create answer was lost, and nothing the run didn't try to make", async () => {
    const api = server(["default", "owner-bot", "bs-1-lost"]);
    await removeAttempted(["bs-1-lost", "bs-1-never-made"], api);
    expect(api.removed).toEqual(["bs-1-lost"]);
  });

  it("fails the run when a delete fails and the profile is still there", async () => {
    const api = server(["bs-1-a", "bs-1-b"], "bs-1-a");
    await expect(removeAttempted(["bs-1-a", "bs-1-b"], api)).rejects.toThrow(/bs-1-a.*500 busy/);
    expect(api.removed).toEqual(["bs-1-b"]);
  });
});
