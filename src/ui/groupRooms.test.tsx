// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const LOOKS: Record<string, { color: string; about: string }> = {
  ada: { color: "#d08b6e", about: "Plans the work" },
  bram: { color: "#7cc49a", about: "Reviews code" },
  cleo: { color: "#8db8e0", about: "Writes the docs" },
};

let launches = 0;
async function launch({ build = GROUPS_BUILDS.ae2a81cc, script, room = false, titles = {} }: { build?: GroupsBuild; script?: (t: TurnContext) => FakeTurn; room?: boolean; titles?: Record<string, string> } = {}) {
  const server = new FakeHermes();
  server.sessions = [row("disk", 0.5, { pinned: true, title: "Disk usage" })];
  server.otherProfiles = Object.fromEntries(BOTS.map((p, i) => [p, [row(`${p}-bot`, i + 1, { title: BOT_CHAT_TITLE, hidden: true })]]));
  server.profileMeta = Object.fromEntries(
    BOTS.map((p) => [p, { description: LOOKS[p]?.about, ui_meta: { "hermes-bots": { title: titles[p] ?? p[0].toUpperCase() + p.slice(1), color: LOOKS[p]?.color } } }]),
  );
  server.groups.build = { ...build };
  if (script) server.groups.script = script;
  if (room) server.groups.seed({ id: "crew", name: "Crew", members: TRIO.map((m) => ({ ...m, name: titles[m.profile] ?? m.name })) });
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
    expect(within(handles).getAllByRole("option").map((o) => o.querySelector(".room-handle-at")!.textContent)).toEqual(["@cleo"]);
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

  it("leaves the room for a chat picked in search", async () => {
    const { user } = await launch({ room: true });
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByPlaceholderText("Search all chats, including Archived"), "Disk");
    const hit = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>(".hit-row")].find((r) => r.querySelector(".hit-name")?.textContent === "Disk usage");
      expect(found, "the search lists the chat").toBeTruthy();
      return found!;
    });
    await user.click(hit);
    await waitFor(() => expect(document.querySelector("[data-room-pane]")).toBeNull());
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

describe("Choosing who a room message goes to", () => {
  const options = () => within(pane()).queryAllByRole("option");
  const line = () => pane().querySelector<HTMLElement>(".room-goes-to")!;
  const live = () => within(line()).getByRole("status");
  const describedBy = () => (composer().getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean).map((id) => document.getElementById(id));
  const spoken = (el: Element) => {
    const copy = el.cloneNode(true) as Element;
    copy.querySelectorAll("[aria-hidden]").forEach((n) => n.remove());
    return copy.textContent;
  };
  const textNodes = (el: Element) => {
    const found: Node[] = [];
    const walk = (n: Node) => (n.nodeType === Node.TEXT_NODE ? found.push(n) : n.childNodes.forEach(walk));
    walk(el);
    return found;
  };
  const paste = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
    await user.click(composer());
    await user.paste(text);
  };

  it("lists each bot with its colour, name, handle and what it does, then Everyone, and no @everyone or @user", async () => {
    const { user } = await launch({ room: true });
    await user.type(composer(), "@");
    const rows = options();
    expect(rows.map((o) => spoken(o))).toEqual(["Ada@adaPlans the work", "Bram@bramReviews code", "Cleo@cleoWrites the docs", "Everyone@allEvery bot answers"]);
    expect(rows.slice(0, 3).map((o) => o.querySelector<HTMLElement>(".bots-face")!.style.background)).toEqual(["rgb(208, 139, 110)", "rgb(124, 196, 154)", "rgb(141, 184, 224)"]);
    expect(rows[3].querySelector(".bots-face")).toBeNull();
    expect(rows.map((o) => o.textContent).join(" ")).not.toMatch(/@everyone|@user/);
  });

  it("matches the start of the handle or of a word of the name, in any case, and never folds accents", async () => {
    const { user } = await launch({ room: true, titles: { cleo: "Cleo \u00c5ngstr\u00f6m" } });
    await user.type(composer(), "@AN");
    expect(options()).toHaveLength(0);
    await user.clear(composer());
    await user.type(composer(), "@\u00e5n");
    expect(options().map((o) => o.querySelector(".room-handle-at")?.textContent)).toEqual(["@cleo"]);
    await user.clear(composer());
    await user.type(composer(), "@\u00c5");
    expect(options().map((o) => o.querySelector(".room-handle-at")?.textContent), "an accented capital finds the accented name, not Ada").toEqual(["@cleo"]);
  });

  it("points aria-activedescendant at the selected row, which moves and wraps with the arrows, and drops it when the list closes", async () => {
    const { user } = await launch({ room: true });
    const active = () => {
      const id = composer().getAttribute("aria-activedescendant");
      return id ? document.getElementById(id)?.querySelector(".room-handle-at")?.textContent : null;
    };
    expect([composer().getAttribute("aria-expanded"), composer().getAttribute("aria-controls"), active()]).toEqual(["false", null, null]);
    await user.type(composer(), "@");
    const list = within(pane()).getByRole("listbox", { name: "Bots to mention" });
    expect([composer().getAttribute("aria-expanded"), composer().getAttribute("aria-controls"), active()]).toEqual(["true", list.id, "@ada"]);
    expect(options().map((o) => o.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false"]);
    const seen: (string | null | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      await user.keyboard("{ArrowDown}");
      seen.push(active());
    }
    expect(seen, "Everyone, then round to the first").toEqual(["@bram", "@cleo", "@all", "@ada"]);
    await user.keyboard("{ArrowUp}");
    expect(active()).toBe("@all");
    expect(options().map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "false", "false", "true"]);
    await user.keyboard("{Escape}");
    expect([composer().getAttribute("aria-expanded"), composer().getAttribute("aria-controls"), active()]).toEqual(["false", null, null]);
  });

  it("completes with Enter or Tab without sending, and Escape closes the list so the next Enter sends", async () => {
    const { server, user } = await launch({ room: true });
    await user.type(composer(), "@b{Enter}");
    expect(composer().value).toBe("@bram ");
    expect(sent(server, "groups.send")).toHaveLength(0);
    await user.clear(composer());
    await user.type(composer(), "@c{Tab}");
    expect(composer().value).toBe("@cleo ");
    expect(document.activeElement, "Tab stays in the composer").toBe(composer());
    await user.clear(composer());
    await user.type(composer(), "@a{Escape}");
    expect(options()).toHaveLength(0);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(sent(server, "groups.send")).toHaveLength(1));
    expect(sent(server, "groups.send")[0]).toMatchObject({ payload: { text: "@a" } });
  });

  it("completes on a mouse press without taking focus from the composer", async () => {
    const { server, user } = await launch({ room: true });
    await user.type(composer(), "@");
    await user.click(options()[1]);
    expect(composer().value).toBe("@bram ");
    expect(document.activeElement).toBe(composer());
    expect(sent(server, "groups.send")).toHaveLength(0);
  });

  it("sends on Enter when nothing in the list matches, and says nobody is named that before it does", async () => {
    const { server, user } = await launch({ room: true });
    await user.type(composer(), "@quill");
    expect(options()).toHaveLength(0);
    expect(spoken(line())).toBe("Goes to everyone (no bot named)No one in this room is @quill");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(sent(server, "groups.send")).toHaveLength(1));
    expect(sent(server, "groups.send")[0]).toMatchObject({ payload: { thread_id: "main", text: "@quill" } });
  });

  it("leaves Enter to the input method while it composes, with the list open and closed", async () => {
    const { server, user } = await launch({ room: true });
    await user.type(composer(), "@c");
    for (const key of [{ isComposing: true }, { keyCode: 229 }]) {
      fireEvent.keyDown(composer(), { key: "Enter", ...key });
      fireEvent.keyDown(composer(), { key: "Tab", ...key });
      fireEvent.keyDown(composer(), { key: "ArrowDown", ...key });
      fireEvent.keyDown(composer(), { key: "Escape", ...key });
      expect(composer().value).toBe("@c");
      expect(options()).toHaveLength(1);
    }
    await user.clear(composer());
    await user.type(composer(), "hello");
    for (const key of [{ isComposing: true }, { keyCode: 229 }]) fireEvent.keyDown(composer(), { key: "Enter", ...key });
    expect(composer().value).toBe("hello");
    expect(sent(server, "groups.send")).toHaveLength(0);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(sent(server, "groups.send")).toHaveLength(1));
  });

  it("shows nothing for an empty draft, then who a message goes to, as soon as there is text", async () => {
    const { user } = await launch({ room: true });
    expect(spoken(line())).toBe("");
    expect(composer().getAttribute("aria-describedby")).toBeNull();
    await user.type(composer(), "hello team");
    expect(spoken(line())).toBe("Goes to everyone (no bot named)");
    await user.clear(composer());
    expect(spoken(line())).toBe("");
  });

  it("names the bots a message goes to in roster order, and everyone for @all even beside a bot", async () => {
    const { user } = await launch({ room: true });
    await user.type(composer(), "@cleo and @ada, compare");
    expect(spoken(line())).toBe("Goes to Ada, Cleo");
    expect(line().querySelectorAll(".bots-face")).toHaveLength(2);
    await user.clear(composer());
    await user.type(composer(), "@all and @ada please");
    expect(spoken(line())).toBe("Goes to everyone");
  });

  it("says who it goes to in a status, and the composer is described by that and the notes, once there is text", async () => {
    const { user } = await launch({ room: true });
    expect(live().getAttribute("aria-atomic")).toBe("true");
    await user.type(composer(), "@quill hi");
    expect(spoken(live())).toBe("Goes to everyone (no bot named)");
    const described = describedBy();
    expect(described[0]).toBe(live());
    expect(described.map((el) => spoken(el!)).join(" ")).toBe("Goes to everyone (no bot named) No one in this room is @quill");
  });

  it("keeps the status still while an unknown name is typed, and shows the note beside it", async () => {
    const { user } = await launch({ room: true });
    await user.type(composer(), "hi @");
    const changes: MutationRecord[] = [];
    const watcher = new MutationObserver((records) => changes.push(...records));
    watcher.observe(live(), { subtree: true, childList: true, characterData: true, attributes: true });
    await user.type(composer(), "quil");
    expect(options()).toHaveLength(0);
    expect(spoken(line())).toBe("Goes to everyone (no bot named)No one in this room is @quil");
    expect([...changes, ...watcher.takeRecords()], "typing the unknown name changed nothing a screen reader announces").toEqual([]);
    watcher.disconnect();
  });

  it("changes the line's text only when who it goes to changes, so a screen reader hears it once", async () => {
    const { user } = await launch({ room: true });
    await user.type(composer(), "hello");
    const before = textNodes(live());
    const changes: MutationRecord[] = [];
    const watcher = new MutationObserver((records) => changes.push(...records));
    watcher.observe(live(), { subtree: true, childList: true, characterData: true, attributes: true });
    const changed = () => [...changes.splice(0), ...watcher.takeRecords()];
    await user.type(composer(), " there, team");
    expect(changed(), "typing more words changed nothing in the line").toEqual([]);
    expect(textNodes(live()), "and it has the same number of text nodes").toHaveLength(before.length);
    for (const [i, node] of before.entries()) expect(textNodes(live())[i]).toBe(node);
    await user.type(composer(), " @bram ok");
    expect(changed().length, "naming a bot did").toBeGreaterThan(0);
    watcher.disconnect();
    expect(spoken(line())).toBe("Goes to Bram");
  });

  it("holds back a note about the word the list is offering rows for, while the line still says everyone", async () => {
    const { user } = await launch({ room: true });
    await user.type(composer(), "@b");
    expect(options()).toHaveLength(1);
    expect(spoken(line())).toBe("Goes to everyone (no bot named)");
    await user.type(composer(), "z");
    expect(options()).toHaveLength(0);
    expect(spoken(line())).toBe("Goes to everyone (no bot named)No one in this room is @bz");
  });

  const warned: [string, string, string][] = [
    ["a trailing mark, which Hermes reads as part of the name", "Thanks @bram. Can you look?", "Goes to everyone (no bot named)\u201c@bram.\u201d won't reach Bram: Hermes reads the trailing \u201c.\u201d as part of the name"],
    ["a trailing colon", "@bram: can you look?", "Goes to everyone (no bot named)\u201c@bram:\u201d won't reach Bram: Hermes reads the trailing \u201c:\u201d as part of the name"],
    ["a mention stuck to a word", "mail x@ada please", "Goes to Adax@ada looks like an e-mail, but Hermes reads @ada"],
    ["a mention in inline code", "what is `@ada` here", "Goes to Ada@ada is inside code but Hermes still sends it to Ada"],
    ["a handle nobody has", "@quill hello", "Goes to everyone (no bot named)No one in this room is @quill"],
    ["@all in code", "run `@all` now", "Goes to everyone@all is inside code but Hermes still sends it to everyone"],
    ["a trailing mark on @all", "ok @all. go", "Goes to everyone (no bot named)\u201c@all.\u201d won't reach everyone: Hermes reads the trailing \u201c.\u201d as part of the name"],
  ];
  it.each(warned)("warns about %s before Enter, and sends the text unchanged", async (_, text, said) => {
    const { server, user } = await launch({ room: true });
    await user.type(composer(), text);
    expect(spoken(line())).toBe(said);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(sent(server, "groups.send")).toHaveLength(1));
    expect((sent(server, "groups.send")[0] as { payload: { text: string } }).payload.text).toBe(text);
  });

  it("warns about a mention in a fenced block, and sends the whole block as typed", async () => {
    const { server, user } = await launch({ room: true });
    const text = "Look:\n```\n@ada\n```\nthanks";
    await paste(user, text);
    expect(spoken(line())).toBe("Goes to Ada@ada is inside code but Hermes still sends it to Ada");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(sent(server, "groups.send")).toHaveLength(1));
    expect((sent(server, "groups.send")[0] as { payload: { text: string } }).payload.text).toBe(text);
  });

  it("lists three notes and then how many more", async () => {
    const { user } = await launch({ room: true });
    await user.type(composer(), "@q1 @q2 @q3 @q4 @q5 end");
    expect(spoken(line())).toBe("Goes to everyone (no bot named)No one in this room is @q1No one in this room is @q2No one in this room is @q3and 2 more");
  });

  it("says one note for the same word typed twice", async () => {
    const { user } = await launch({ room: true });
    await user.type(composer(), "@quill and @quill again");
    expect(spoken(line())).toBe("Goes to everyone (no bot named)No one in this room is @quill");
  });

  it("sends a message that names a bot to that bot alone, and everyone else stays quiet", async () => {
    const { server, user } = await launch({ room: true });
    await user.type(composer(), "@bram only you{Enter}");
    await step(server, 5);
    await waitFor(() => expect(floor().dataset.floor).toBe("yours"));
    expect(replies()).toEqual(["bram: Bram here."]);
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
  it("never shows a seat's hidden session as live work", async () => {
    const { server, hermes, user } = await launch({ room: true });
    await say(user, "Hello team");
    await act(async () => void server.groups.begin("crew"));
    await waitFor(() => expect(floor().dataset.floor).toBe("speaking"));
    server.otherProfiles.ada.push(row("group-crew-ada", 0, { source: "bot_room", hidden: true, title: "Group: crew" }));
    server.liveSessions = [{ id: "rt-ops", session_key: "elsewhere", status: "working", last_active: Date.now() / 1000, title: "Deploy log" }];
    const before = { rpc: server.requests.length };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 20_000);
    await act(async () => void (await hermes.checkLive()));
    vi.useRealTimers();
    expect(server.requests.slice(before.rpc).some((r) => r.method === "session.active_list"), "Hermes was asked what is live").toBe(true);
    expect(hermes.getSnapshot().live?.sessions.map((s) => s.chatId), "Ada's hidden session is not among it").toEqual(["elsewhere"]);
    expect(hermes.getSnapshot().chats.some((c) => c.title.startsWith("Group:"))).toBe(false);
  });
});
