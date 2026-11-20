// @vitest-environment jsdom
// Settings → Approvals on screen (AllowlistSettings.tsx, ADR 0236), against the fake dashboard: the list for the profile
// picked, Remove with its check and read back, a change on the server meanwhile, and a list Hermes can't use.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { appearanceStore } from "./appearance";
import { SettingsScreen } from "./Settings";

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

function server() {
  const s = new FakeHermes();
  s.otherProfiles = { work: [] };
  s.commandAllowlist.default = ["git force push", "recursive delete"];
  s.commandAllowlist.work = ["kill a process"];
  return s;
}

async function shown(s = server()) {
  const hermes = await connect(s.openPipe, "default");
  running.push(hermes);
  function Shell() {
    const [appearance] = useState(() => appearanceStore({ getItem: () => null, setItem: () => {} }, document.createElement("html")));
    return (
      <SettingsScreen
        status="connected"
        unsecure={false}
        username="lena"
        passwordSaved
        profile="default"
        olderPulled={false}
        cacheBytes={() => 0}
        appearance={appearance}
        listFonts={async () => ({ all: [], mono: [] })}
        modelSettings={hermes.modelSettings}
        allowlist={hermes.allowlist}
        listProfiles={async () => ["default", "work"]}
        onClearCache={() => {}}
        onPullOlder={async () => []}
        onSignOut={async () => {}}
        onClose={() => {}}
      />
    );
  }
  const user = userEvent.setup();
  render(
    <StrictMode>
      <Shell />
    </StrictMode>,
  );
  await user.click(screen.getByRole("tab", { name: "Approvals" }));
  return { s, user };
}

const entries = async () =>
  within(await screen.findByRole("list", { name: /^Always allowed in / }))
    .getAllByRole("listitem")
    .map((i) => i.textContent?.replace(/Remov(e|ing…)$/, ""));

describe("Settings → Approvals", () => {
  it("lists what Hermes always allows for the profile, and Remove makes Hermes ask again", async () => {
    const { s, user } = await shown();
    expect(await entries()).toEqual(["git force push", "recursive delete"]);
    s.restRequests.length = 0;
    await user.click(screen.getByRole("button", { name: "Remove recursive delete" }));
    expect(
      await screen.findByText("Removed “recursive delete”. Hermes asks again the next time a command like it runs. The chat that answered Always allow also allowed it for itself, until Hermes closes that chat."),
    ).toBeTruthy();
    expect(await entries()).toEqual(["git force push"]);
    expect(s.commandAllowlist.default).toEqual(["git force push"]);
    expect(s.restRequests.filter((r) => r.method === "PUT").map((r) => r.body)).toEqual([{ config: { command_allowlist: ["git force push"] } }]);
  });

  it("shows another profile's list when it is picked", async () => {
    const { user } = await shown();
    await entries();
    await user.selectOptions(await screen.findByRole("combobox", { name: "Profile whose always-allowed commands are shown" }), "work");
    expect(await screen.findByRole("list", { name: "Always allowed in work" })).toBeTruthy();
    expect(await entries()).toEqual(["kill a process"]);
  });

  it("writes nothing when the list changed on the server, and shows the new one", async () => {
    const { s, user } = await shown();
    await entries();
    s.commandAllowlist.default = ["git force push", "kill a process", "recursive delete"];
    await user.click(screen.getByRole("button", { name: "Remove recursive delete" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Nothing was removed: the list changed on the server"));
    expect(await entries()).toEqual(["git force push", "kill a process", "recursive delete"]);
    expect(s.restRequests.filter((r) => r.method === "PUT")).toEqual([]);
  });

  it("says when the list is empty", async () => {
    const s = server();
    s.commandAllowlist.default = [];
    await shown(s);
    expect(await screen.findByText(/Nothing is in this profile.s list/)).toBeTruthy();
  });

  it("says why a list Hermes ignores isn't shown, and offers no Remove", async () => {
    const s = server();
    s.commandAllowlist.default = ["a", 7];
    await shown(s);
    expect(await screen.findByText(/it has an item that isn't text, so Hermes ignores the whole list/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
  });
});
