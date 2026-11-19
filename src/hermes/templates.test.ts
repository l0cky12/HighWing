import { describe, expect, it } from "vitest";
import { toTemplates, unscope, type Template } from "./templates";

const t = (name: string, extra: Partial<Template> = {}): Template => ({ id: `id-${name}`, name, description: "", body: "Hi", ...extra });

describe("Stored templates", () => {
  it("keeps only valid ones, one per id and name", () => {
    const got = toTemplates([
      t("A"),
      { ...t("B"), id: "id-A" },
      t("a"),
      { id: "x", name: "No body", body: "" },
      "junk",
      { ...t("C"), description: 5, project: { scope: "s" } },
    ]);
    expect(got).toEqual([t("A"), { ...t("C"), description: "" }]);
    expect(toTemplates("nope")).toBeUndefined();
  });

  it("keeps a deleted project's templates, with the project dropped", () => {
    const list = [t("A", { project: { scope: "s1", id: "p1", name: "Infra" } }), t("B", { project: { scope: "s2", id: "p1", name: "Other" } })];
    expect(unscope(list, "s1", "p1")).toEqual([t("A"), list[1]]);
  });
});
