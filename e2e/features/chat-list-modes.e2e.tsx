import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { BOT_CHAT_TITLE } from "../../src/hermes/bots";
import { row, type FakeHermes } from "../../src/hermes/fakeHermes";
import { APPEARANCE_KEY } from "../../src/ui/appearance";
import { boot, shot } from "../harness";

const nowS = () => Date.now() / 1000;
const ago = (hours: number) => nowS() - hours * 3600;
const bot = (id: string, hours: number) => row(id, hours / 24, { title: BOT_CHAT_TITLE, hidden: true });
const active = (id: string, hours: number, title: string) => row(id, hours / 24, { pinned: true, title, last_read_at: ago(hours + 1) });
const settled = (id: string, hours: number, title: string) => row(id, hours / 24, { title, last_read_at: nowS() });

const seed = (s: FakeHermes) => {
  s.sessions = [
    bot("hermes-bot", 0.5),
    active("backup", 0.4, "Nightly backup failing"),
    active("nas", 7, "NAS disk usage"),
    settled("router", 30, "Router firmware notes"),
    settled("cron", 50, "Old cron cleanup"),
    settled("vpn", 70, "VPN key rotation"),
    settled("certs", 90, "Certificate renewals"),
  ];
  s.otherProfiles = {
    writer: [bot("quill-bot", 14), active("notes", 16, "Release notes for 0.1.5"), settled("readme", 120, "README install section")],
    ops: [bot("ops-bot", 0.1), active("caddy", 2, "Caddy config rollout")],
    scout: [bot("scout-bot", 0.2), settled("bench", 40, "Benchmark baseline")],
    "hermes-chat": [bot("hc-bot", 48), active("theme", 30, "Theme tweaks")],
  };
  s.transcripts = {
    "hermes-bot": [{ role: "assistant", text: "Nothing urgent. The nightly backup ran clean and the UPS test passed." }],
    "quill-bot": [{ role: "assistant", text: "Draft two of the release notes is in the doc. I cut the intro to one line." }],
    "ops-bot": [{ role: "assistant", text: "Rolling the Caddy config out to the second node now." }],
    "scout-bot": [
      { role: "user", text: "Benchmark the new build against the baseline." },
      { role: "assistant", text: "I'd like to run the benchmark script. It needs your OK first." },
    ],
    "hc-bot": [{ role: "assistant", text: "The theme tokens are in place." }],
    backup: [{ role: "user", text: "Why did last night's backup fail?" }],
  };
  s.profileMeta = {
    writer: { ui_meta: { "hermes-bots": { title: "Quill", color: "#f59e0b" } } },
    ops: { ui_meta: { "hermes-bots": { title: "Ops", color: "#3b82f6" } } },
    scout: { ui_meta: { "hermes-bots": { title: "Scout", color: "#a855f7" } } },
    "hermes-chat": { ui_meta: { "hermes-bots": { color: "#10b981" } } },
  };
  s.liveSessions = [
    { id: "rt-ops", session_key: "ops-bot", status: "working", last_active: nowS() },
    { id: "rt-scout", session_key: "scout-bot", status: "waiting", last_active: nowS() },
  ];
};

async function start() {
  const { app, server } = await boot({ seed });
  const panel = app.getByRole("complementary");
  const tab = (name: "Chats" | "Bots") => panel.getByRole("tab", { name: new RegExp(`^${name}`) });
  await expect.element(tab("Chats")).toHaveAttribute("aria-selected", "true");
  await expect.element(panel.getByRole("button", { name: /Nightly backup failing/ })).toBeVisible();
  return { app, server, panel, tab };
}

const titleOf = (app: Awaited<ReturnType<typeof boot>>["app"]) => () => app.getByTitle("Its bot's one continuous chat").query()?.closest(".chat-title")?.textContent;

it("switches between Chats and Bots by the tabs and Ctrl+Shift+B, which also shows a hidden panel", async () => {
  const { app, panel, tab } = await start();
  await expect.element(tab("Bots")).toHaveAccessibleName("Bots, 1 bot needs you");
  await expect.element(panel.getByRole("button", { name: /Scout needs you/ })).toBeVisible();
  await expect.element(panel.getByRole("button", { name: "New chat" })).toBeVisible();
  await expect.element(panel.getByRole("button", { name: "Search chats" })).toBeVisible();
  await expect.element(panel.getByRole("button", { name: /Inbox/ })).toBeVisible();
  expect(panel.getByRole("button", { name: /Bot Chat/ }).elements()).toEqual([]);
  await shot("chats");

  await tab("Bots").click();
  await expect.element(tab("Bots")).toHaveAttribute("aria-selected", "true");
  await expect.element(panel.getByRole("group", { name: "Hermes's chats" })).toBeVisible();
  await expect.element(tab("Chats")).toHaveAccessibleName("Chats, 2 in the Inbox");
  await shot("bots");

  await app.getByPlaceholder("Message Hermes").click();
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  await expect.element(tab("Chats")).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Control>}b{/Control}");
  await expect.element(tab("Chats")).not.toBeInTheDocument();
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  await expect.element(tab("Bots")).toHaveAttribute("aria-selected", "true");
  await shot("shown-by-chord-in-bots");
});

it("opens Scout's Bot Chat from the needs-you line, with its Approval showing", async () => {
  const { app, server, panel, tab } = await start();
  await panel.getByRole("button", { name: /Scout needs you/ }).click();
  await expect.element(app.getByText("I'd like to run the benchmark script. It needs your OK first.")).toBeVisible();
  await expect.poll(() => server.runtimeIdOf("scout-bot"), { message: "Scout's Bot Chat resumed" }).toBeTruthy();
  server.askApproval(server.runtimeIdOf("scout-bot")!, { command: "./bench.sh --against baseline", description: "run the benchmark" });
  await expect.element(app.getByText("./bench.sh --against baseline")).toBeVisible();
  await expect.poll(titleOf(app)).toBe("SScoutBot Chat");
  await expect.element(app.getByPlaceholder("Message Scout")).toBeVisible();
  await expect.element(tab("Chats")).toHaveAttribute("aria-selected", "true");
  await shot("needs-you-opened");
});

it("opens the profile's Bot Chat with Alt+B, and Alt+B goes back to the chat before", async () => {
  const { app, server, panel } = await start();
  await panel.getByRole("button", { name: /Nightly backup failing/ }).click();
  await expect.element(app.getByText("Why did last night's backup fail?")).toBeVisible();
  await userEvent.keyboard("{Alt>}b{/Alt}");
  await expect.element(app.getByText("Nothing urgent. The nightly backup ran clean and the UPS test passed.")).toBeVisible();
  await expect.poll(titleOf(app)).toBe("HHermesBot Chat");
  await shot("bot-chat-by-alt-b");
  await userEvent.keyboard("{Alt>}b{/Alt}");
  await expect.element(app.getByText("Why did last night's backup fail?")).toBeVisible();
  await shot("back-by-alt-b");
  await userEvent.keyboard("{Alt>}b{/Alt}");
  await expect.poll(titleOf(app)).toBe("HHermesBot Chat");
  expect(server.sessions.filter((s) => s.title === BOT_CHAT_TITLE)).toHaveLength(1);
});

it("lists the shown profile's chats under its bot in Bots mode, and All N chats goes to Chats", async () => {
  const { app, panel, tab } = await start();
  await tab("Bots").click();
  const under = panel.getByRole("group", { name: "Hermes's chats" });
  await expect
    .poll(() => under.getByRole("button").elements().map((e) => e.querySelector(".row-title")?.textContent ?? e.textContent))
    .toEqual(["Nightly backup failing", "NAS disk usage", "Router firmware notes", "All 6 chats"]);
  await panel.getByRole("button", { name: /^Ops\./ }).hover();
  await expect.element(panel.getByRole("button", { name: "New chat with Ops" })).toBeVisible();
  await shot("row-hovered");

  await under.getByRole("button", { name: /NAS disk usage/ }).click();
  await expect.element(under.getByRole("button", { name: /NAS disk usage/ })).toHaveAttribute("aria-current", "true");
  await under.getByRole("button", { name: "All 6 chats" }).click();
  await expect.element(tab("Chats")).toHaveAttribute("aria-selected", "true");
  await expect.element(app.getByPlaceholder("Message Hermes")).toBeVisible();
});

it("switches profile from a bot's row in Bots mode, its chats moving under it", async () => {
  const { app, panel, tab } = await start();
  await tab("Bots").click();
  await panel.getByRole("button", { name: /^Quill \(profile writer\)\./ }).click();
  await expect.poll(titleOf(app)).toBe("QQuillBot Chat");
  await expect.element(panel.getByRole("group", { name: "Quill's chats" })).toBeVisible();
  await expect.element(tab("Bots")).toHaveAttribute("aria-selected", "true");
  await shot("other-profile");
  await tab("Chats").click();
  await expect.element(panel.getByRole("button", { name: "Quill (writer)" })).toBeVisible();
  await shot("other-profile-chats");
});

it("names a bot without a name by its profile id, once", async () => {
  const { app, panel, tab } = await start();
  await tab("Bots").click();
  await panel.getByRole("button", { name: /^Hermes Chat \(profile hermes-chat\)\./ }).hover();
  await panel.getByRole("button", { name: "New chat with Hermes Chat" }).click();
  await tab("Chats").click();
  await expect.element(panel.getByRole("button", { name: "Hermes Chat", exact: true })).toBeVisible();
  await expect.element(app.getByText("What should Hermes Chat work on?")).toBeVisible();
  await shot("named-by-id");
});

it("draws both modes in the light theme", async () => {
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ scheme: "light" }));
  const { panel, tab } = await start();
  await shot("light-chats");
  await tab("Bots").click();
  await expect.element(panel.getByRole("group", { name: "Hermes's chats" })).toBeVisible();
  await shot("light-bots");
});
