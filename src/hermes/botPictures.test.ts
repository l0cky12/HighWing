// The pictures Bot setup's card offers (botPictures.ts, ADR 0235): one per name the brief lists, each a PNG Hermes
// would store, and no two the same, since a picture is told from another by its bytes.
import { describe, expect, it } from "vitest";
import { BOT_PICTURE_URLS } from "./botPictures";
import { BOT_PICTURES } from "./botSetupBrief";
import { pictureKey } from "./botSetupCard";
import { BOT_PICTURE_MAX_BYTES } from "./bots";

describe("the pictures the app ships", () => {
  it("are one PNG for each name the brief lists, each within what Hermes stores", () => {
    expect(Object.keys(BOT_PICTURE_URLS)).toEqual([...BOT_PICTURES]);
    for (const name of BOT_PICTURES) {
      const [label, payload] = BOT_PICTURE_URLS[name].split(",");
      expect(label, name).toBe("data:image/png;base64");
      const bytes = atob(payload);
      expect(bytes.startsWith("\x89PNG\r\n\x1a\n"), name).toBe(true);
      expect(bytes.length, name).toBeLessThanOrEqual(BOT_PICTURE_MAX_BYTES);
    }
  });

  it("each have a key of their own", () => {
    expect(new Set(BOT_PICTURES.map((name) => pictureKey(BOT_PICTURE_URLS[name]))).size).toBe(BOT_PICTURES.length);
  });
});
