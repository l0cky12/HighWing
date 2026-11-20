// @vitest-environment jsdom
// A finished job run's notification in the app (#28): its click opens the run read-only, in its own profile, and no
// notification shows for a bot whose Scheduled jobs are on screen.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, readRow, row, type TranscriptMessage } from "../hermes/fakeHermes";
import { FakeTray } from "../hermes/fakeTray";
import { CHECK_EVERY_MS } from "../hermes/otherProfiles";
import { connect, type Hermes, type NoticeActions, type Notify } from "../hermes/transport";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
  document.title = "Highwing";
  vi.useRealTimers();
});

const RUN = "local-run-2";
const REPLY = "Disk check done. Nothing needs cleaning tonight.";
const READ_ONLY = /This chat is a run of a scheduled job, so it's read-only here\./;

const runRows = (started: number): TranscriptMessage[] => [
  { role: "user", text: "[IMPORTANT: You are running as a scheduled cron job.]\n\nCheck the disk usage on the server.", row_id: 101, timestamp: started },
  { role: "assistant", text: REPLY, row_id: 102, timestamp: started + 5 },
];

/** A server whose `profile` has a Disk check job that ran before launch, and the run's session it will finish next. */
function server(profile: string) {
  const s = new FakeHermes();
  s.sessions = [readRow("backup", 1, { pinned: true, title: "Nightly backup" })];
  s.otherProfiles = { scout: [] };
  s.profileMeta = { scout: { display_name: "Scout" } };
  s.cron.jobs = { default: [], scout: [] };
  const job = s.cron.add(profile, { name: "[fixture] Disk check", prompt: "Check the disk usage on the server.", schedule: "0 3 * * *" });
  s.cron.ran(profile, job.id);
  /** The scheduler finishes the run: its session is stored, the job records it, and the runs list it first. */
  const finish = () => {
    vi.setSystemTime(Date.now() + 30_000);
    const started = Math.floor(Date.now() / 1000) - 60;
    const session = row(RUN, 0, { source: "cron", title: null, started_at: started, last_active: started + 5, last_read_at: 0 });
    if (profile === "default") s.sessions.push(session);
    else s.otherProfiles[profile].push(session);
    s.transcripts[RUN] = runRows(started);
    s.cron.ran(profile, job.id);
    s.cron.runs[job.id][0] = { ...s.cron.runs[job.id][0], id: RUN, started_at: started, ended_at: started + 5 };
  };
  return { s, finish };
}

async function launch(s: FakeHermes) {
  vi.useFakeTimers({ toFake: ["Date"] });
  const offered: { n: { title: string; body: string }; actions?: NoticeActions }[] = [];
  const notify: Notify = async (n, actions) => void offered.push({ n, actions });
  const hermes = await connect(s.openPipe, undefined, undefined, notify);
  running.push(hermes);
  render(<Main hermes={hermes} tray={new FakeTray()} connection={{ mode: "ssh", sshTarget: "lena@hermes", url: "", username: "lena" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  act(() => void window.dispatchEvent(new Event("blur")));
  /** The app's 2-minute timer fires. */
  const tick = () =>
    act(async () => {
      vi.setSystemTime(Date.now() + CHECK_EVERY_MS);
      await hermes.checkOtherProfiles();
      await hermes.idle();
    });
  return { hermes, offered, tick, user: userEvent.setup() };
}

const pane = () => document.querySelector<HTMLElement>(".chat")!;

describe("A finished job run's notification", () => {
  it("opens the run read-only on a click, starting no session", async () => {
    const { s, finish } = server("default");
    const { hermes, offered, tick } = await launch(s);
    finish();
    await tick();
    expect(offered.map((o) => o.n.title)).toEqual(["Hermes: “[fixture] Disk check” ran"]);

    await act(async () => offered[0].actions!.open());
    await screen.findByText(REPLY);
    await act(async () => void (await hermes.idle()));
    expect(pane().querySelector(".chat-title")!.textContent).toMatch(/^\[fixture\] Disk check · /);
    expect(within(pane()).getByRole("note").textContent).toMatch(READ_ONLY);
    expect(pane().querySelector("textarea")).toBeNull();
    expect(s.requests.filter((r) => r.method === "session.resume")).toEqual([]);
    expect(s.restRequests.filter((r) => r.method !== "GET" && r.path.includes(RUN))).toEqual([]);
  });

  it("switches to the run's profile first when it is another bot's", async () => {
    const { s, finish } = server("scout");
    const { hermes, offered, tick } = await launch(s);
    finish();
    await tick();
    expect(offered.map((o) => o.n.title)).toEqual(["Scout: “[fixture] Disk check” ran"]);

    await act(async () => offered[0].actions!.open());
    await screen.findByText(REPLY, undefined, { timeout: 5_000 });
    await act(async () => void (await hermes.idle()));
    expect(hermes.getSnapshot().profile).toBe("scout");
    expect(within(pane()).getByRole("note").textContent).toMatch(READ_ONLY);
  });

  it("isn't shown while that bot's Scheduled jobs are on screen", async () => {
    const { s, finish } = server("default");
    const { offered, tick, user } = await launch(s);
    await user.click(screen.getByRole("button", { name: "Scheduled jobs" }));
    await screen.findByText("[fixture] Disk check");
    finish();
    await tick();
    expect(offered).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Back to chat" }));
    await waitFor(() => expect(document.querySelector(".jobs-screen")).toBeNull());
    finish();
    await tick();
    expect(offered.map((o) => o.n.title)).toEqual(["Hermes: “[fixture] Disk check” ran"]);
  });
});
