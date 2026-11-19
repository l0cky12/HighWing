// Hermes's own commands, read from its `commands.catalog` at the deployed `bf0203a` (commandsCatalogGolden.json, made by
// tools/commands-catalog-golden.py), and which of them run from this app.
import { describe, expect, it } from "vitest";
import { hermesCommands, hermesRefusal } from "./hermesCommands";
import golden from "./commandsCatalogGolden.json";

const all = hermesCommands(golden);
const def = (name: string) => all.find((c) => c.name === name)!;

describe("Hermes's commands from its catalog", () => {
  it("are every command it lists, with aliases, the argument hint from its description, and subcommands", () => {
    expect(all).toHaveLength(golden.pairs.length);
    expect(def("kanban")).toMatchObject({ scope: "hermes", args: "[subcommand]", description: "Multi-profile collaboration board (tasks, links, comments)" });
    expect(def("kanban").subcommands).toEqual(expect.arrayContaining(["list", "create", "show"]));
    expect(def("queue").aliases).toEqual(["q"]);
    // Flags aren't suggested as subcommands.
    expect(def("reasoning").subcommands).not.toContain("--global");
  });

  it("leave out skills, which the composer offers as skills", () => {
    const withSkill = { ...golden, pairs: [...golden.pairs, ["/debugging", "Find the cause"]], skills: { "/debugging": { usage: 0, origin: "local" } } };
    expect(hermesCommands(withSkill).some((c) => c.name === "debugging")).toBe(false);
    expect(hermesCommands({})).toEqual([]);
  });

  it("say why those Hermes's desktop does itself, or keeps to its terminal, don't run from here", () => {
    expect(def("undo").unavailable).toMatch(/Use Edit under your message/);
    expect(def("paste").unavailable).toBe("Hermes runs it only in its terminal command line.");
    expect(def("voice").unavailable).toMatch(/microphone/);
    expect(def("kanban").unavailable).toBeUndefined();
    expect(def("usage").unavailable).toBeUndefined();
  });

  it("refuse /skills but for what answers in text, and /personality while a reply runs", () => {
    expect(hermesRefusal(def("skills"), "install foo", false)).toMatch(/^Only \/skills pending, approve, reject, diff, approval run here/);
    expect(hermesRefusal(def("skills"), "pending", false)).toBeUndefined();
    // Listed in the menu, before any argument is typed, it isn't refused.
    expect(hermesRefusal(def("skills"), undefined, false)).toBeUndefined();
    expect(hermesRefusal(def("personality"), "pirate", true)).toMatch(/only between replies/);
    expect(hermesRefusal(def("personality"), "pirate", false)).toBeUndefined();
  });
});
