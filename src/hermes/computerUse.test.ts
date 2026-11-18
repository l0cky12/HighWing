// Hermes's computer_use as the transcript reads it (computerUse.ts, ADR 0213), against frames recorded from a real
// Hermes (src/hermes/fixtures/computer-use, ADR 0211).
import { describe, expect, it } from "vitest";
import { KEPT_CAPTURE_CHARS, keptResult } from "./computerUse";
import { cuEvents } from "./cuFixtures";
import { toolResultText } from "./toolResult";

const results = (name: Parameters<typeof cuEvents>[0]) => cuEvents(name, "tool.complete").map((p) => p.result as Record<string, unknown>);

describe("What the chat keeps of a computer_use result", () => {
  it("keeps a capture's words and size, and none of its screenshot", () => {
    const capture = results("10-turn-approve")[0];
    const kept = keptResult(capture) as Record<string, unknown>;
    expect(kept.content).toEqual([{ type: "text", text: expect.stringMatching(/^capture mode=som 1280x800 app=Xfdesktop\n1 interactable element/) }]);
    expect(kept).not.toHaveProperty("text_summary");
    expect(kept.meta).toEqual({ mode: "som", width: 1280, height: 800, elements: 1 });
    expect(JSON.stringify(kept)).not.toMatch(/base64|image_url|png_bytes/);
  });

  it("keeps an input action's own answer, and what Hermes advised next", () => {
    const click = results("11-turn-foreground")[1];
    expect(keptResult(click)).toEqual(click);
    const typed = keptResult(results("11-turn-foreground")[4]) as { content: { text: string }[]; action_result: unknown };
    expect(JSON.parse(typed.content[0].text.split("\n\ncapture ")[0])).toMatchObject({ ok: true, action: "type_text" });
    expect(typed.action_result).toMatchObject({ ok: true, action: "type_text", verdict: { decision: "verify_fresh_state" } });
  });

  it("cuts a long element list, so a long run's Saved copy stays small", () => {
    const capture = results("10-turn-approve")[0] as { content: { type: string; text?: string }[] };
    const long = { ...capture, content: [{ type: "text", text: `capture mode=som 1280x800 app=Firefox\n${"  #1 button 'Reload' @ (10, 10)\n".repeat(400)}` }, capture.content[1]] };
    const text = (keptResult(long) as { content: { text: string }[] }).content[0].text;
    expect(text.length).toBeLessThanOrEqual(KEPT_CAPTURE_CHARS + 1);
    expect(text.startsWith("capture mode=som 1280x800 app=Firefox\n")).toBe(true);
  });

  it("leaves every other tool's result as it came", () => {
    expect(toolResultText({ content: [{ type: "image_url" }], text_summary: "kept" }, "vision_analyze")).toContain("text_summary");
    expect(toolResultText(results("12-turn-deny")[1], "computer_use")).toContain("BLOCKED: Action denied by user.");
    expect(toolResultText(results("10-turn-approve")[0], "computer_use")).not.toContain("text_summary");
  });
});
