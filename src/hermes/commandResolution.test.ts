// How a typed "/" name finds its command (issue #94, ADR 0226): exact names and aliases first, then a prefix, the way
// Hermes's own command line expands one at the deployed `bf0203a` (`cli.py _expand_slash_prefix`), across the app's
// commands, Hermes's catalog (commandsCatalogGolden.json, made by tools/commands-catalog-golden.py) and the skill and
// extension names "/" also reaches.
import { describe, expect, it } from "vitest";
import { commandSet, type Typed } from "./commands";
import { hermesCommands } from "./hermesCommands";
import golden from "./commandsCatalogGolden.json";

const app = commandSet();
const full = commandSet(hermesCommands(golden));
const name = (t: Typed | undefined) => (t?.kind === "command" ? t.def.name : t?.kind === "unclear" ? `? ${t.candidates.join(" ")}` : undefined);

describe("A typed command name", () => {
  it("resolves a prefix to the one command it starts", () => {
    expect(name(full.typed("/mod gpt-5", []))).toBe("model");
    expect(full.typed("/mod gpt-5", [])).toMatchObject({ arg: "gpt-5", via: "prefix" });
    expect(name(app.typed("/bt why is it slow", []))).toBe("btw");
    expect(name(app.typed("/MOD", []))).toBe("model");
  });

  it("takes an exact name or alias over any prefix", () => {
    expect(full.typed("/btw why", [])).toMatchObject({ kind: "command", via: "name" });
    expect(full.typed("/s go on", [])).toMatchObject({ kind: "command", via: "alias", arg: "go on" });
    expect(name(full.typed("/s go on", []))).toBe("steer");
    expect(name(full.typed("/ctx", []))).toBe("context");
    expect(name(full.typed("/reset", []))).toBe("new");
    expect(name(full.typed("/compact", []))).toBe("compress");
  });

  it("picks the unique shortest of several, and names them all when there is none", () => {
    // Hermes counts aliases too: /hb (heartbeat) is shorter than /help, /hatch and /history.
    expect(name(full.typed("/h", []))).toBe("heartbeat");
    // /bg and /bp (blueprint) tie.
    expect(name(full.typed("/b", []))).toBe("? battery bg blueprint bp branch browser btw bundles busy");
    expect(name(full.typed("/re", []))).toMatch(/^\? /);
  });

  it("gives way to a skill or extension of that exact name, and counts them among the prefixes", () => {
    expect(full.typed("/debugging fix it", ["debugging"])).toBeUndefined();
    expect(name(app.typed("/mo", ["modes"]))).toBe("? model modes");
    expect(name(app.typed("/mo", ["monitor"]))).toBe("model");
    // A prefix that only a skill starts is the skill's: no command, so the caller runs the skill or sends the message.
    expect(app.typed("/debu fix it", ["debugging"])).toBeUndefined();
  });

  it("runs a destructive command only by its full name", () => {
    expect(name(app.typed("/delete", []))).toBe("delete");
    expect(name(app.typed("/del", []))).toBe("? delete");
  });

  it("is still a message when nothing fits, or when words follow a command that takes none", () => {
    expect(full.typed("/usr/local/bin is full", [])).toBeUndefined();
    expect(full.typed(" /new", [])).toBeUndefined();
    expect(app.typed("/help me read this log", [])).toBeUndefined();
    expect(app.typed("/hel me read this log", [])).toBeUndefined();
  });

  it("is the top row of the menu whenever it resolves", () => {
    for (const set of [app, full])
      for (const def of set.all)
        for (const key of [def.name, ...(def.aliases ?? [])])
          for (let n = 1; n <= key.length; n++) {
            const typed = set.typed(`/${key.slice(0, n)}`, []);
            if (typed?.kind === "command") expect(set.match(key.slice(0, n))[0]?.name, `/${key.slice(0, n)}`).toBe(typed.def.name);
          }
  });
});

describe("The menu while typing", () => {
  it("names commands, then suggests a command's arguments after a space", () => {
    expect(full.menu("/kan", [])).toEqual({ stage: "name", query: "kan" });
    expect(full.menu("/kanban ", [])).toMatchObject({ stage: "arg", def: { name: "kanban" }, query: "" });
    expect(full.menu("/kanban li", [])).toMatchObject({ stage: "arg", query: "li" });
    expect(full.menu("/mod op", [])).toMatchObject({ stage: "arg", def: { name: "model" }, query: "op" });
    // Arguments are suggested one word deep, on one line.
    expect(full.menu("/kanban list --mine", [])).toBeUndefined();
    expect(full.menu("/kanban list\n", [])).toBeUndefined();
    // A command with nothing to suggest, or no command at all.
    expect(full.menu("/btw ", [])).toBeUndefined();
    expect(app.menu("/kanban ", [])).toBeUndefined();
  });
});
