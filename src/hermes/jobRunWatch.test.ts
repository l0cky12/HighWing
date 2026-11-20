// @vitest-environment jsdom
// Notifications about finished scheduled-job runs (#28), against FakeHermes's cron routes, with the clock faked so
// each check is one the app's 2-minute timer would start.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
import { CHECK_EVERY_MS } from "./otherProfiles";
import { connect, NOTICES, type NoticeActions, type NoticeCard, type NoticeRun, type Notify } from "./transport";
import { UI_PREFS_KEY, setUIPrefs } from "./uiPrefs";

const BRIEF = "a1b2c3d4e5f6";
const NIGHTLY = "0f9e8d7c6b5a";

beforeEach(() => localStorage.clear());
afterEach(() => void vi.useRealTimers());

/** Signed in to `default`, out of focus, on a server whose `default` and `scout` profiles each have a job that ran before launch. */
async function watching(seed?: (server: FakeHermes) => void) {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-20T08:00:00Z") });
  const server = new FakeHermes();
  server.otherProfiles = { scout: [] };
  server.profileMeta = { scout: { display_name: "Scout" } };
  server.cron.add("default", { id: BRIEF, name: "Morning brief", prompt: "Summarize my inbox", schedule: "every 1h" });
  server.cron.add("scout", { id: NIGHTLY, name: "Nightly check", prompt: "Check the backups", schedule: "every 1h" });
  server.cron.ran("default", BRIEF);
  server.cron.ran("scout", NIGHTLY, "error");
  seed?.(server);
  const shown: { title: string; body: string }[] = [];
  const offered: (NoticeActions | undefined)[] = [];
  const notify: Notify = async (n, actions) => {
    shown.push(n);
    offered.push(actions);
  };
  const hermes = await connect(server.openPipe, undefined, memoryCache(), notify);
  await hermes.sync();
  hermes.setFocused(false);
  const opened: (NoticeCard | NoticeRun)[] = [];
  hermes.onNoticeOpen((t) => opened.push(t));
  /** The app's 2-minute timer fires: time moves on and the other-profiles check runs. */
  const tick = async () => {
    vi.setSystemTime(Date.now() + CHECK_EVERY_MS);
    await hermes.checkOtherProfiles();
    await hermes.idle();
  };
  /** Time moves on a little, and the scheduler finishes a run. */
  const runs = (profile: string, id: string, status?: string) => {
    vi.setSystemTime(Date.now() + 30_000);
    return server.cron.ran(profile, id, status);
  };
  const jobReads = () => server.restRequests.filter((r) => r.path === "/api/cron/jobs").length;
  return { server, hermes, shown, offered, opened, tick, runs, jobReads };
}

describe("Notifications when a scheduled job runs", () => {
  it("announces nothing on the first check after launch, then each run that finishes, naming the job and its bot", async () => {
    const { hermes, shown, tick, runs } = await watching();
    await tick();
    expect(shown).toEqual([]);

    runs("default", BRIEF);
    await tick();
    expect(shown).toEqual([NOTICES.jobRan("Morning brief", "Hermes", "ok", true)]);
    expect(shown[0]).toEqual({ title: "Hermes: “Morning brief” ran", body: "Succeeded. Click to read the run." });

    await tick();
    expect(shown).toHaveLength(1);
    await hermes.close();
  });

  it("says a failed run failed, in another profile, under its bot's name", async () => {
    const { hermes, shown, tick, runs } = await watching();
    await tick();
    runs("scout", NIGHTLY, "error");
    await tick();
    expect(shown).toEqual([{ title: "Scout: “Nightly check” failed", body: "Failed. Click to read the run." }]);
    await hermes.close();
  });

  it("names the bot by its Bot Mode title, which only the roster carries", async () => {
    const { hermes, shown, tick, runs } = await watching((s) => (s.profileMeta.scout = { display_name: "Scout", ui_meta: { "hermes-bots": { title: "Quill" } } }));
    await tick();
    runs("scout", NIGHTLY);
    await tick();
    expect(shown.map((n) => n.title)).toEqual(["Quill: “Nightly check” ran"]);
    await hermes.close();
  });

  it("opens the run's chat on a click", async () => {
    const { hermes, offered, opened, tick, runs } = await watching();
    await tick();
    const session = runs("scout", NIGHTLY)!;
    await tick();
    offered[0]!.open();
    expect(opened).toEqual([{ profile: "scout", chatId: session, title: expect.stringMatching(/^Nightly check · /), source: "cron" }]);
    await hermes.close();
  });

  it("names a script job's run without offering to open a chat it doesn't have", async () => {
    const { server, hermes, shown, offered, tick, runs } = await watching();
    server.cron.add("default", { id: "5c41p7000000", name: "Disk report", script: "df.sh", no_agent: true, schedule: "every 1h" });
    await tick();
    runs("default", "5c41p7000000");
    await tick();
    expect(shown).toEqual([{ title: "Hermes: “Disk report” ran", body: "Succeeded. Its runs are in Scheduled jobs in Highwing." }]);
    expect(offered).toEqual([undefined]);
    expect(server.restRequests.some((r) => r.path.endsWith("/runs"))).toBe(false);
    await hermes.close();
  });

  it("announces a job made since the last check once it has run", async () => {
    const { server, hermes, shown, tick, runs } = await watching();
    await tick();
    server.cron.add("scout", { id: "ne3w00000000", name: "Weekly report", prompt: "Write it", schedule: "every 1h" });
    runs("scout", "ne3w00000000");
    await tick();
    expect(shown.map((n) => n.title)).toEqual(["Scout: “Weekly report” ran"]);
    await hermes.close();
  });

  it("sets a new baseline after a reconnect, so runs that finished while it was down aren't announced", async () => {
    const { server, hermes, shown, tick, runs } = await watching();
    await tick();
    server.drop();
    runs("default", BRIEF);
    vi.setSystemTime(Date.now() + 5_000);
    await hermes.reconnect();
    await hermes.idle();
    await tick();
    expect(shown).toEqual([]);

    runs("scout", NIGHTLY);
    await tick();
    expect(shown.map((n) => n.title)).toEqual(["Scout: “Nightly check” ran"]);
    await hermes.close();
  });

  it("keeps what it read across a profile switch, so a run just before it is still announced", async () => {
    const { hermes, shown, tick, runs } = await watching();
    runs("scout", NIGHTLY);
    await hermes.switchProfile("scout");
    await hermes.idle();
    await tick();
    expect(shown.map((n) => n.title)).toEqual(["Scout: “Nightly check” ran"]);
    await hermes.close();
  });

  it("announces a run that finished after the connection came up, before the first check", async () => {
    const { server, hermes, shown, tick, runs } = await watching();
    expect(server.restRequests.filter((r) => r.path === "/api/cron/jobs")).toEqual([]);
    runs("default", BRIEF);
    await tick();
    expect(shown.map((n) => n.title)).toEqual(["Hermes: “Morning brief” ran"]);
    await hermes.close();
  });

  it("compares with the last good read when a profile's jobs can't be read", async () => {
    const { server, hermes, shown, tick, runs } = await watching();
    await tick();
    runs("default", BRIEF);
    server.cron.failLists = 2;
    await tick();
    expect(shown).toEqual([]);
    await tick();
    expect(shown.map((n) => n.title)).toEqual(["Hermes: “Morning brief” ran"]);
    await hermes.close();
  });

  it("stays quiet while the window has focus", async () => {
    const { hermes, shown, tick, runs } = await watching();
    await tick();
    hermes.setFocused(true);
    runs("default", BRIEF);
    await tick();
    expect(shown).toEqual([]);
    await hermes.close();
  });

  it("skips a run whose bot's Scheduled jobs are on screen, and still announces the other bots'", async () => {
    const { hermes, shown, tick, runs } = await watching();
    hermes.showingJobs(true);
    await tick();
    runs("default", BRIEF);
    runs("scout", NIGHTLY);
    await tick();
    expect(shown.map((n) => n.title)).toEqual(["Scout: “Nightly check” ran"]);

    hermes.showingJobs(false);
    runs("default", BRIEF);
    await tick();
    expect(shown.map((n) => n.title)).toEqual(["Scout: “Nightly check” ran", "Hermes: “Morning brief” ran"]);
    await hermes.close();
  });

  it("reads no jobs while turned off, and turned on again starts from a fresh baseline", async () => {
    const { hermes, shown, tick, runs, jobReads } = await watching();
    await tick();
    setUIPrefs({ jobRunNotices: false });
    expect(JSON.parse(localStorage.getItem(UI_PREFS_KEY)!).jobRunNotices).toBe(false);
    const before = jobReads();
    runs("default", BRIEF);
    await tick();
    expect(shown).toEqual([]);
    expect(jobReads()).toBe(before);

    setUIPrefs({ jobRunNotices: true });
    await tick();
    expect(shown).toEqual([]);
    runs("scout", NIGHTLY);
    await tick();
    expect(shown.map((n) => n.title)).toEqual(["Scout: “Nightly check” ran"]);
    await hermes.close();
  });

  it("checks at most once a minute however often the app asks", async () => {
    const { hermes, tick, jobReads } = await watching();
    await tick();
    const after = jobReads();
    vi.setSystemTime(Date.now() + 30_000);
    await hermes.checkOtherProfiles();
    expect(jobReads()).toBe(after);
    await hermes.close();
  });
});
