// @vitest-environment jsdom
// Settings → Diagnostics' Computer use section (ADR 0212), as the owner sees it, against FakeHermes's `display.status`,
// `-p`-sensitive `computer-use doctor` and toolsets.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { checkReadiness } from "../hermes/computerUseReadiness";
import { DOCTOR_NO_DISPLAY, FakeHermes } from "../hermes/fakeHermes";
import { LocaleContext, localeFor } from "../i18n/locale";
import { connect, type Hermes } from "../hermes/transport";
import { DiagnosticsSettings } from "./Diagnostics";

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

function server(status: Record<string, unknown> = {}, lease: "agent" | "human" = "agent", toolsetOn = true) {
  const s = new FakeHermes();
  s.display = {
    status: { supported: true, installed: true, missing: [], running: true, geometry: "1280x800", placement: "gateway", memory_available_mb: 19039, memory_limit_mb: 32000, ...status },
    lease: { holder: lease, viewer_hash: null, since: 1, epoch: 0 },
    minted: new Set(),
  };
  s.machine = { programs: new Set(), files: new Set(), pmInstall: { code: 0, output: "" }, browser: "" };
  if (toolsetOn) s.toolsetsOn.default = new Set([...s.enabledToolsets("default"), "computer_use"]);
  return s;
}

async function open(s: FakeHermes, language: "en" | "es" = "en") {
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  const openToolsets = vi.fn();
  const computerUse = { check: () => checkReadiness({ screen: hermes.screen, toolsets: () => hermes.toolsets.list("default") }), openToolsets };
  render(
    <LocaleContext.Provider value={localeFor(language, [])}>
      <DiagnosticsSettings store={hermes.capabilities} connected signIn="Dashboard username and password" headers={0} unsecure={false} profile="default" openGuide={() => {}} computerUse={computerUse} />
    </LocaleContext.Provider>,
  );
  return { openToolsets };
}

const section = (name: string) => screen.getByRole("region", { name });
const row = (name: string) => within(document.getElementById("diag-computer-use")!.closest("section")!).getByText(name).closest(".set-row") as HTMLElement;

describe("Computer use in Diagnostics", () => {
  it("shows every prerequisite ready when Hermes can run computer use for the profile", async () => {
    const s = server();
    await open(s);
    await waitFor(() => expect(within(section("Computer use")).getByRole("status").textContent).toMatch(/^Ready: the agent can use the Bot Desktop\./));
    for (const name of ["Computer use tool", "cua-driver", "Desktop packages", "Memory", "Where the screen runs", "Screen control"]) expect(within(row(name)).getByText("Ready")).toBeTruthy();
    expect(row("cua-driver").textContent).toMatch(/cua-driver 0\.21\.0/);
    expect(row("Memory").textContent).toMatch(/19,039 MB free of 32,000 MB/);
    expect(s.requests.filter((r) => r.method === "cli.exec").map((r) => r.params.argv)).toEqual([["-p", "default", "computer-use", "doctor", "--json"]]);
  });

  it("says the toolset is off and opens Settings → Toolsets", async () => {
    const { openToolsets } = await open(server({}, "agent", false));
    const toolset = await waitFor(() => {
      const r = row("Computer use tool");
      expect(within(r).getByText("Not ready")).toBeTruthy();
      return r;
    });
    expect(toolset.textContent).toMatch(/The computer_use toolset is off for this profile/);
    await userEvent.setup().click(within(toolset).getByRole("button", { name: "Open Toolsets" }));
    expect(openToolsets).toHaveBeenCalledTimes(1);
    expect(within(section("Computer use")).getByRole("status").textContent).toMatch(/^1 prerequisite needs attention\./);
  });

  it("gives doctor's own message and hint, and Check again reads everything once Hermes is fixed", async () => {
    const s = server();
    s.machine!.computerUse = { doctor: DOCTOR_NO_DISPLAY };
    await open(s);
    const driver = await waitFor(() => {
      const r = row("cua-driver");
      expect(within(r).getByText("Not ready")).toBeTruthy();
      return r;
    });
    expect(driver.textContent).toMatch(/X11 is not reachable; UI inspection and event injection will fail\./);
    expect(driver.textContent).toMatch(/Set DISPLAY \(X11\)\. Under Wayland, run via XWayland/);

    s.machine!.computerUse = undefined;
    s.display!.status.running = false;
    const before = s.requests.length;
    await userEvent.setup().click(screen.getByRole("button", { name: "Check computer use again" }));
    await waitFor(() => expect(within(row("cua-driver")).getByText("Ready")).toBeTruthy());
    expect(row("Desktop packages").textContent).toMatch(/The Bot Desktop is stopped\. Hermes starts it when the agent needs it\./);
    const again = s.requests.slice(before).map((r) => r.method);
    expect(again).toContain("cli.exec");
    expect(again).toContain("display.status");
  });

  it("says the screen's memory blocker, the packages it lacks with a command to copy, and who holds the screen", async () => {
    const blocker = "Not enough free memory for a desktop: 900 MB available of 32000 MB, 1536 MB needed (bot_desktop.min_free_memory_mb)";
    await open(server({ running: false, blocker, memory_available_mb: 900 }, "human"));
    await waitFor(() => expect(within(row("Memory")).getByText("Not ready")).toBeTruthy());
    expect(row("Memory").textContent).toContain(blocker);
    expect(row("Screen control").textContent).toMatch(/A person holds the screen, so computer_use is refused until they hand it back\./);
    expect(row("Screen control").textContent).toMatch(/open the Screen tab and choose Hand back/);
  });

  it("names the missing packages and copies Hermes's install command", async () => {
    await open(server({ installed: false, running: false, missing: ["Xvnc", "xfce4-session"], install_command: "sudo apt install tigervnc-standalone-server xfce4" }));
    const packages = await waitFor(() => {
      const r = row("Desktop packages");
      expect(within(r).getByText("Not ready")).toBeTruthy();
      return r;
    });
    expect(packages.textContent).toMatch(/The Bot Desktop is missing Xvnc, xfce4-session\./);
    await userEvent.setup().click(within(packages).getByRole("button", { name: "Copy the command" }));
    expect(await navigator.clipboard.readText()).toBe("sudo apt install tigervnc-standalone-server xfce4");
  });

  it("is unknown, not green, on a Hermes with no screen", async () => {
    const s = new FakeHermes();
    s.machine = { programs: new Set(), files: new Set(), pmInstall: { code: 0, output: "" }, browser: "" };
    await open(s);
    await waitFor(() => expect(within(row("Desktop packages")).getByText("Unknown")).toBeTruthy());
    expect(row("Desktop packages").textContent).toMatch(/This Hermes doesn't report it\./);
    expect(within(section("Computer use")).getByRole("status").textContent).toMatch(/couldn't be read/);
  });

  it("is written in Spanish for a Spanish owner", async () => {
    await open(server({}, "human"), "es");
    await waitFor(() => expect(within(section("Uso del ordenador")).getByText("No está listo")).toBeTruthy());
    expect(row("Control de la pantalla").textContent).toMatch(/Una persona tiene la pantalla/);
    expect(within(row("cua-driver")).getByText("Listo")).toBeTruthy();
  });
});
