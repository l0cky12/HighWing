import { describe, expect, it } from "vitest";
import { markedName, markedType, markupWords, NOTE_MAX } from "./markup";

describe("Mark up words and names (ADR 0225)", () => {
  it("names the box and the image as Hermes gets it, with the note on one line", () => {
    expect(markupWords("shot.png", 1, "  the Save button\n is cut off ")).toBe("Box 1 on shot.png: the Save button is cut off");
    expect(markupWords("shot.png", 2, "")).toBe("Box 2 on shot.png.");
  });

  it("cuts a long note and defuses direction overrides, so the words read as typed", () => {
    const words = markupWords("a.png", 1, `x${"y".repeat(NOTE_MAX + 50)}`);
    expect(words.length).toBe("Box 1 on a.png: ".length + NOTE_MAX);
    expect(words.endsWith("…")).toBe(true);
    expect(markupWords("a.png", 1, "gnp.\u202Eexe"), "a direction override shows as a replacement mark").toBe("Box 1 on a.png: gnp.\uFFFDexe");
  });

  it("keeps a photo a JPEG and makes everything else a PNG, keeping the name's stem", () => {
    expect([markedType("rack.JPG"), markedName("rack.JPG", "image/jpeg")]).toEqual(["image/jpeg", "rack.jpg"]);
    expect(markedName("scan.jpeg", markedType("scan.jpeg"))).toBe("scan.jpeg");
    expect([markedType("anim.gif"), markedName("anim.gif", "image/png")]).toEqual(["image/png", "anim.png"]);
    expect(markedName("clipboard-2026-11-19T080244.png", "image/png")).toBe("clipboard-2026-11-19T080244.png");
    expect(markedName("no-extension", "image/png")).toBe("no-extension.png");
  });
});
