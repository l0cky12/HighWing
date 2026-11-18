// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BOT_CHAT_TITLE } from "../hermes/bots";
import { GROUPS_BUILDS, type FakeTurn, type GroupsBuild, type TurnContext } from "../hermes/fakeGroups";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { FakeTray } from "../hermes/fakeTray";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { ARM_MS } from "./ApprovalCard";

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
});

const BOTS = ["ada", "bram", "cleo", "dov", "eve", "finn"];
const TRIO = BOTS.slice(0, 3).map((profile) => ({ profile, name: profile[0].toUpperCase() + profile.slice(1) }));
const pingpong = (t: TurnContext): FakeTurn => ({ say: `${t.name} here, pingpong. @${t.handles[t.index === 0 ? 1 : 0]} your turn.` });
const POLL = { timeout: 5_000 };

let launches = 0;
async function launch({ build = GROUPS_BUILDS.ae2a81cc, script, room = false }: { build?: GroupsBuild; script?: (t: TurnContext) => FakeTurn; room?: boolean } = {}) {
  const server = new FakeHermes();
  server.sessions = [row("disk", 0.5, { pinned: true, title: "Disk usage" })];
  server.otherProfiles = Object.fromEntries(BOTS.map((p, i) => [p, [row(`${p}-bot`, i + 1, { title: BOT_CHAT_TITLE, hidden: true })]]));
  server.profileMeta = Object.fromEntries(BOTS.map((p) => [p, { ui_meta: { "hermes-bots": { title: p[0].toUpperCase() + p.slice(1) } } }]));
  server.groups.build = { ...build };
  if (script) server.groups.script = script;
  if (room) server.groups.seed({ id: "crew", name: "Crew", members: TRIO });
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  const tray = new FakeTray();
  render(<Main hermes={hermes} tray={tray} connection={{ mode: "ssh", sshTarget: `lena@hermes-rooms-${++launches}`, url: "", username: "lena" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  await act(async () => void (await hermes.capabilities.refresh()));
  const user = userEvent.setup();
  await user.click(document.querySelector<HTMLElement>('.sidebar [role=tab][data-mode="bots"]')!);
  await screen.findByRole("button", { name: "New room" });
  if (room) await user.click(await screen.findByRole("button", { name: /^Crew\. Group room/ }));
  return { server, hermes, user, tray };
}

const pane = () => document.querySelector<HTMLElement>("[data-room-pane]")!;
const floor = () => pane().querySelector<HTMLElement>("[data-floor]")!;
const composer = () => within(pane()).getByRole("combobox", { name: "Message the room" }) as HTMLTextAreaElement;
const replies = () => [...pane().querySelectorAll<HTMLElement>(".room-reply")].map((r) => `${r.dataset.seat}: ${r.querySelector(".msg")!.textContent}`);
const notes = () => [...pane().querySelectorAll<HTMLElement>(".room-note")].map((n) => n.textContent);
const sent = (server: FakeHermes, method: string) => server.requests.filter((r) => r.method === method).map((r) => r.params);
async function say(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(composer(), text);
  await user.keyboard("{Enter}");
}
const step = (server: FakeHermes, times = 1) => act(async () => void Array.from({ length: times }, () => server.groups.step("crew")));

describe("Making a Group room", () => {
  it("seats the picked bots in pick order, names the room after them, refuses a seventh, and opens the room without switching profile", async () => {
    const { server, hermes, user } = await launch();
    expect(within(document.querySelector<HTMLElement>("[data-rooms]")!).getByText("No group rooms yet. A room is 2 to 6 bots that take turns.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "New room" }));
    const dialog = screen.getByRole("dialog", { name: "New group room" });
    const create = within(dialog).getByRole("button", { name: "Create room" }) as HTMLButtonElement;
    const name = within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect([create.disabled, dialog.querySelector("[data-room-count]")!.textContent]).toEqual([true, "0 of 6"]);

    for (const bot of ["Cleo", "Ada", "Bram"]) await user.click(within(dialog).getByRole("checkbox", { name: bot }));
    expect(name.value).toBe("Cleo, Ada and Bram");
    expect([...dialog.querySelectorAll(".room-pick-row.is-on")].map((r) => r.textContent)).toEqual(["A" + "Ada2", "B" + "Bram3", "C" + "Cleo1"]);
    expect(within(dialog).getByRole("checkbox", { name: "Cleo, answers number 1" })).toBeTruthy();

    for (const bot of ["Dov", "Eve", "Finn"]) await user.click(within(dialog).getByRole("checkbox", { name: bot }));
    expect(dialog.querySelector("[data-room-count]")!.textContent).toBe("6 of 6");
    const unpicked = (within(dialog).getAllByRole("checkbox") as HTMLInputElement[]).filter((c) => !c.checked);
    expect(unpicked.map((c) => c.disabled), "a room seats six: the seventh bot can't be picked").toEqual([true]);
    expect(within(dialog).getByText("A room seats at most 6 bots.")).toBeTruthy();
    for (const bot of ["Dov", "Eve", "Finn"]) await user.click(within(dialog).getByRole("checkbox", { name: new RegExp(`^${bot},`) }));

    await user.clear(name);
    expect(create.disabled).toBe(true);
    expect(within(dialog).getByRole("alert").textContent).toBe("Give the room a name.");
    await user.type(name, "Launch crew");
    await user.click(create);

    await waitFor(() => expect(pane()).toBeTruthy());
    expect(within(pane()).getByText("Launch crew")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "New group room" })).toBeNull();
    const [made] = sent(server, "groups.create");
    expect(made).toMatchObject({ name: "Launch crew", members: ["cleo", "ada", "bram"].map((p) => ({ member_id: p, profile: p, handle: p })) });
    expect(String(made.room_id)).toMatch(/^room-[0-9a-f-]{36}$/);
    expect(hermes.profile, "a room is in no profile").toBe("default");
    expect([...pane().querySelectorAll(".room-seats li")].map((li) => li.getAttribute("aria-label"))).toEqual(["Cleo", "Ada", "Bram"]);
    expect(await screen.findByRole("button", { name: /^Launch crew\. Group room\. Cleo, Ada and Bram\. Nothing said yet/ })).toBeTruthy();
    expect(server.groups.calls.some((c) => c.method === "groups.capabilities"), "never the call that writes a file on the server").toBe(false);
  });

  it("makes one room when Create is pressed again after Hermes turned the first try down", async () => {
    const { server, user } = await launch();
    server.groups.build.worker = false;
    await user.click(screen.getByRole("button", { name: "New room" }));
    const dialog = screen.getByRole("dialog", { name: "New group room" });
    for (const bot of ["Ada", "Bram"]) await user.click(within(dialog).getByRole("checkbox", { name: bot }));
    await user.click(within(dialog).getByRole("button", { name: "Create room" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/^Couldn't create the room\. Hermes's room worker isn't running/);
    server.groups.build.worker = true;
    await user.click(within(dialog).getByRole("button", { name: "Create room" }));
    await waitFor(() => expect(pane()).toBeTruthy());
    const ids = sent(server, "groups.create").map((p) => p.room_id);
    expect([ids.length, new Set(ids).size]).toEqual([2, 1]);
  });

  it("makes the room under a new id when the picks change after Hermes turned the first try down", async () => {
    const { server, user } = await launch();
    server.groups.build.worker = false;
    await user.click(screen.getByRole("button", { name: "New room" }));
    const dialog = screen.getByRole("dialog", { name: "New group room" });
    for (const bot of ["Ada", "Bram"]) await user.click(within(dialog).getByRole("checkbox", { name: bot }));
    await user.click(within(dialog).getByRole("button", { name: "Create room" }));
    await within(dialog).findByRole("alert");
    server.groups.build.worker = true;
    await user.click(within(dialog).getByRole("checkbox", { name: "Cleo" }));
    await user.click(within(dialog).getByRole("button", { name: "Create room" }));
    await waitFor(() => expect(pane()).toBeTruthy());
    const ids = sent(server, "groups.create").map((p) => p.room_id);
    expect([ids.length, new Set(ids).size]).toEqual([2, 2]);
  });
});

describe("Watching a Group room", () => {
  it("shows each whole reply under its bot's name, who is writing and who is next, a Round rule, and a pass", async () => {
    const script = (t: TurnContext): FakeTurn => (t.round === 1 && t.member === "bram" ? { pass: true } : t.round === 0 ? pingpong(t) : { say: `${t.name} is done.`, tool: "terminal" });
    const { server, user } = await launch({ room: true, script });
    expect(composer().placeholder).toBe("Message the room. Type @ to pick who answers");
    await say(user, "pingpong please");
    await waitFor(() => expect(within(pane()).getByText("pingpong please")).toBeTruthy());
    await waitFor(() => expect(floor().dataset.floor).toBe("starting"));
    expect(composer().placeholder).toBe("Step in: the bots stop and answer you first");

    await act(async () => void server.groups.begin("crew"));
    await waitFor(() => expect(floor().textContent).toBe("Ada is writing · round 1 · next: Bram, CleoStop"));
    expect(pane().querySelector(".room-seats li.is-speaking")?.getAttribute("aria-label")).toBe("Ada");
    expect(replies(), "nothing streams: no reply until it is whole").toEqual([]);

    await step(server, 3);
    await waitFor(() => expect(replies()).toHaveLength(3));
    expect(replies()).toEqual(["ada: Ada here, pingpong. @bram your turn.", "bram: Bram here, pingpong. @ada your turn.", "cleo: Cleo here, pingpong. @ada your turn."]);
    expect(within(pane().querySelector('.room-reply[data-seat="bram"]')!).getByText("Bram")).toBeTruthy();

    await act(async () => void server.groups.begin("crew"));
    await waitFor(() => expect(floor().textContent).toBe("Ada is writing · round 2 · in terminal · next: BramStop"));
    await step(server, 2);
    await waitFor(() => expect(floor().dataset.floor).toBe("yours"));
    expect(pane().querySelector(".room-round")?.textContent).toBe("Round 2");
    expect(replies().at(-1)).toBe("ada: Ada is done.");
    expect(notes()).toEqual(["Bram had nothing to add."]);
    expect(await screen.findByRole("button", { name: /^Crew\. Group room\. Ada, Bram and Cleo\. The bots are done/ })).toBeTruthy();
  });

  it("completes a handle after @, so the owner picks who answers", async () => {
    const { server, user } = await launch({ room: true });
    await user.type(composer(), "@c");
    const handles = within(pane()).getByRole("listbox", { name: "Bots to mention" });
    expect(within(handles).getAllByRole("option").map((o) => o.textContent)).toEqual(["@cleo"]);
    await user.keyboard("{Enter}");
    expect(composer().value).toBe("@cleo ");
    await user.type(composer(), "just you{Enter}");
    await step(server, 5);
    await waitFor(() => expect(floor().dataset.floor).toBe("yours"));
    expect(sent(server, "groups.send")[0]).toMatchObject({ payload: { thread_id: "main", text: "@cleo just you" } });
    expect(replies()).toEqual(["cleo: Cleo here."]);
  });

  it("steps in: the owner's message cancels the queued turn, and the bots answer the owner first", async () => {
    const { server, user } = await launch({ room: true, script: pingpong });
    await say(user, "pingpong");
    await step(server, 5);
    await waitFor(() => expect(replies()).toHaveLength(5));
    await say(user, "Owner here, stepping in");
    await waitFor(() => expect(notes()).toEqual(["Ada's turn was cancelled: you stepped in."]));
    await step(server);
    await waitFor(() => expect(replies()).toHaveLength(6));
    const rows = [...pane().querySelectorAll<HTMLElement>("[data-entry]")].map((r) => r.dataset.entry);
    expect(rows.slice(-3)).toEqual(["owner", "cancelled", "reply"]);
    expect(sent(server, "groups.send").map((p) => (p.payload as { thread_id: string }).thread_id)).toEqual(["main", "main"]);
  });

  it("keeps a message Hermes didn't take, and sends it again under the same id", async () => {
    const { server, user } = await launch({ room: true });
    server.groups.build.worker = false;
    await say(user, "Hello team");
    const unsent = await within(pane()).findByRole("alert");
    expect(unsent.textContent).toMatch(/^Not sent\. Hermes's room worker isn't running/);
    server.groups.build.worker = true;
    await user.click(within(unsent).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(pane().querySelector('[data-entry="owner"]')?.textContent).toBe("Hello team"));
    expect(pane().querySelector('[data-entry="outgoing"]')).toBeNull();
    const ids = sent(server, "groups.send").map((p) => p.event_id);
    expect([ids.length, new Set(ids).size]).toEqual([2, 1]);
  });
});

describe("A Group room at its cap", () => {
  it("offers Continue with what is left on a Hermes that reports max_continues, and goes on when pressed", async () => {
    const { server, user } = await launch({ room: true, script: pingpong });
    await say(user, "pingpong");
    await act(async () => void server.groups.settle("crew"));
    await waitFor(() => expect(floor().dataset.floor).toBe("paused"));
    expect(floor().textContent).toBe("Paused after 3 rounds.Continue (5 left)Stop");
    expect(within(floor()).queryByRole("button", { name: "Carry on" })).toBeNull();
    expect(notes()).toEqual(["Paused after 3 rounds."]);
    await user.click(within(floor()).getByRole("button", { name: "Continue (5 left)" }));
    await waitFor(() => expect(sent(server, "groups.continue")).toHaveLength(1));
    await act(async () => void server.groups.settle("crew"));
    await waitFor(() => expect(floor().textContent).toBe("Paused after 6 rounds.Continue (4 left)Stop"));
    expect(notes()).toEqual(["Paused after 3 rounds.", "The bots were told to continue.", "Paused after 6 rounds."]);
    expect([...pane().querySelectorAll(".room-round")].map((r) => r.textContent)).toEqual(["Round 2", "Round 3", "Round 4", "Round 5", "Round 6"]);
  });

  it("offers Carry on instead on bf0203a, which fills the composer with the last round's bots and sends nothing", { timeout: 20_000 }, async () => {
    const { server, user } = await launch({ room: true, script: pingpong, build: GROUPS_BUILDS.bf0203a });
    await say(user, "pingpong");
    await act(async () => void server.groups.settle("crew"));
    await waitFor(() => expect(floor().dataset.floor).toBe("paused"), POLL);
    expect(floor().textContent).toBe("Paused after 3 rounds. Say something to carry on.Carry onStop");
    expect(within(floor()).queryByRole("button", { name: /^Continue/ })).toBeNull();
    const sends = sent(server, "groups.send").length;
    await user.click(within(floor()).getByRole("button", { name: "Carry on" }));
    expect(composer().value).toBe("@bram @ada ");
    expect(document.activeElement).toBe(composer());
    expect([sent(server, "groups.send").length, sent(server, "groups.continue").length]).toEqual([sends, 0]);
    await user.type(composer(), "go on{Enter}");
    await waitFor(() => expect(sent(server, "groups.send").at(-1)).toMatchObject({ payload: { thread_id: "main", text: "@bram @ada go on" } }));
    await act(async () => void server.groups.settle("crew"));
    await waitFor(() => expect(replies().length).toBeGreaterThan(7), POLL);
    expect(server.groups.calls.some((c) => c.method === "groups.continue" || c.method === "groups.capabilities")).toBe(false);
  });

  it("stops the bots from the strip", async () => {
    const { server, user } = await launch({ room: true, script: pingpong });
    await say(user, "pingpong");
    await step(server, 2);
    await waitFor(() => expect(replies()).toHaveLength(2));
    await user.click(within(floor()).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(floor().dataset.floor).toBe("yours"));
    expect(sent(server, "groups.stop")).toHaveLength(1);
    expect(notes()).toEqual(["The bots were stopped.", "Cleo's turn was cancelled."]);
  });
});

describe("An approval in a Group room", () => {
  const asks = (t: TurnContext): FakeTurn => (t.member === "bram" ? { approval: { command: "rm -rf /srv/tmp/build", description: "delete in root path" }, then: "Bram ran it." } : { say: `${t.name} here.` });

  it("shows the command with only once and deny, says who waits behind it, raises the Bots tab and the inbox, and answers Hermes's exact request", async () => {
    const { server, hermes, user, tray } = await launch({ room: true, script: asks });
    await say(user, "Bram approve-me please");
    await step(server, 2);
    await waitFor(() => expect(floor().dataset.floor).toBe("approval"));
    const card = within(floor()).getByRole("group", { name: "Bram wants to run a command" });
    expect(card.querySelector(".approval-cmd")!.textContent).toBe("rm -rf /srv/tmp/build");
    expect(within(card).getAllByRole("button").map((b) => b.textContent)).toEqual(["Approve once", "Deny"]);
    expect(floor().textContent).toContain("Bram wants to run a command");
    expect(floor().textContent).toContain("Cleo waits behind this.");
    expect(document.querySelector('[data-room="crew"]')?.getAttribute("data-floor")).toBe("approval");
    expect(screen.getByRole("button", { name: /^Crew\. Group room\. Ada, Bram and Cleo\. Bram needs your approval/ })).toBeTruthy();

    await user.click(document.querySelector<HTMLElement>('.sidebar [role=tab][data-mode="chats"]')!);
    expect(document.querySelector<HTMLElement>('.sidebar [role=tab][data-mode="bots"]')!.getAttribute("aria-label")).toBe("Bots, 1 needs you");
    expect(screen.getByRole("button", { name: /Crew needs you.*Bram needs your approval/ })).toBeTruthy();
    expect(tray.counts.at(-1), "the tray's count of what needs the owner").toBe(1);

    await new Promise((r) => setTimeout(r, ARM_MS + 50));
    await user.click(within(card).getByRole("button", { name: "Approve once" }));
    await waitFor(() => expect(sent(server, "groups.approve")).toHaveLength(1));
    const [action] = server.groups.calls.filter((c) => c.method === "groups.approve").map((c) => c.params);
    expect(action).toMatchObject({ room_id: "crew", member_id: "bram", execution_generation: 1, choice: "once" });
    expect(String(action.request_id)).toMatch(/^rq-/);
    await waitFor(() => expect(replies().at(-1)).toBe("bram: Bram ran it."));
    await waitFor(() => expect(document.querySelector<HTMLElement>('.sidebar [role=tab][data-mode="bots"]')!.getAttribute("aria-label")).toBe("Bots"));
    expect(tray.counts.at(-1)).toBe(0);
    expect(hermes.profile).toBe("default");
  });

  it("opens the room from its inbox entry", async () => {
    const { server, user, tray } = await launch({ room: true, script: asks });
    await say(user, "Bram approve-me please");
    await step(server, 2);
    await waitFor(() => expect(floor().dataset.floor).toBe("approval"));
    await user.click(document.querySelector<HTMLElement>('.sidebar [role=tab][data-mode="chats"]')!);
    await user.click(screen.getByText("Disk usage"));
    await waitFor(() => expect(document.querySelector("[data-room-pane]")).toBeNull());
    tray.pick("inbox");
    await user.click(await screen.findByRole("button", { name: /^Needs approval: Crew, a Group room on .*Bram is waiting for your approval\./ }));
    await waitFor(() => expect(pane()?.dataset.roomPane).toBe("crew"));
    expect(floor().dataset.floor).toBe("approval");
  });
});

describe("A Group room and the shown profile", () => {
  it("stays open and goes on working when the profile is switched, because a room is the connection's", { timeout: 20_000 }, async () => {
    const { server, hermes, user } = await launch({ room: true });
    await say(user, "Hello team");
    await step(server);
    await waitFor(() => expect(replies()).toEqual(["ada: Ada here."]));
    await act(async () => void (await hermes.switchProfile("bram")));
    await waitFor(() => expect(hermes.getSnapshot()).toMatchObject({ profile: "bram", status: "connected" }));
    await waitFor(() => expect(pane().querySelector(".room-banner")).toBeNull(), POLL);
    expect(pane().dataset.roomPane).toBe("crew");
    expect(replies()).toEqual(["ada: Ada here."]);
    await step(server, 2);
    await waitFor(() => expect(replies()).toHaveLength(3), POLL);
    await say(user, "@cleo one more");
    await waitFor(() => expect(sent(server, "groups.send")).toHaveLength(2));
    expect(hermes.getSnapshot().chats.some((c) => c.title.startsWith("Group:") || c.id === "crew"), "a room never enters the chats").toBe(false);
  });
});

describe("A room's seats and the chats", () => {
  it("never shows a seat's hidden session as live work, nor looks its owner up", async () => {
    const { server, hermes, user } = await launch({ room: true });
    await say(user, "Hello team");
    await act(async () => void server.groups.begin("crew"));
    await waitFor(() => expect(floor().dataset.floor).toBe("speaking"));
    server.liveSessions = [{ id: "rt-ops", session_key: "elsewhere", status: "working", last_active: Date.now() / 1000, title: "Deploy log" }];
    const before = { rest: server.restRequests.length, rpc: server.requests.length };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 20_000);
    await act(async () => void (await hermes.checkLive()));
    vi.useRealTimers();
    expect(server.requests.slice(before.rpc).some((r) => r.method === "session.active_list"), "Hermes was asked what is live").toBe(true);
    expect(hermes.getSnapshot().live?.sessions.map((s) => s.chatId), "Ada's hidden session is not among it").toEqual(["elsewhere"]);
    expect(server.restRequests.slice(before.rest).filter((r) => r.path.includes("group-crew-ada")), "and no profile was searched for it").toEqual([]);
    expect(hermes.getSnapshot().chats.some((c) => c.title.startsWith("Group:"))).toBe(false);
  });
});
