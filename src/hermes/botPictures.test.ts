// Bot setup's picture set (botPictures.ts, ADR 0235): the files the app ships, and the keys the card compares by.
import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BOT_PICTURE_DATA, pictureData, pictureKey, setPicture } from "./botPictures";
import { BOT_SETUP_PICTURES } from "./botSetupBrief";
import { BOT_PICTURE_MAX_BYTES } from "./bots";

const file = (name: string) => new URL(`../assets/bot-pictures/${name}.png`, import.meta.url);

describe("the picture set", () => {
  it("has 8 to 12 pictures, each a PNG file well under Hermes's 2 MB, with distinct bytes", () => {
    expect(BOT_SETUP_PICTURES.length).toBeGreaterThanOrEqual(8);
    expect(BOT_SETUP_PICTURES.length).toBeLessThanOrEqual(12);
    const payloads = new Set<string>();
    for (const name of BOT_SETUP_PICTURES) {
      expect(name).toMatch(/^[a-z]+$/);
      const bytes = readFileSync(file(name));
      expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(statSync(file(name)).size).toBeLessThan(BOT_PICTURE_MAX_BYTES / 20);
      expect(BOT_PICTURE_DATA[name]).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
      payloads.add(bytes.toString("base64"));
    }
    expect(payloads.size).toBe(BOT_SETUP_PICTURES.length);
  });
});

describe("picture keys", () => {
  it("names a picture of the set by its name, whatever label Hermes gives the bytes", () => {
    const payload = BOT_PICTURE_DATA.plane.split(",")[1];
    expect(pictureKey(BOT_PICTURE_DATA.plane)).toBe("set:plane");
    expect(pictureKey(`data:image/jpeg;base64,${payload}`)).toBe("set:plane");
    expect(setPicture("set:plane")).toBe("plane");
    expect(setPicture("set:dragon")).toBeUndefined();
  });

  it("names any other picture by a hash of its bytes, the same for the same bytes", () => {
    const upload = "data:image/webp;base64,UklGRhYAAABXRUJQVlA4";
    const key = pictureKey(upload);
    expect(key).toMatch(/^photo:[0-9a-f]{16}$/);
    expect(pictureKey("data:image/png;base64,UklGRhYAAABXRUJQVlA4")).toBe(key);
    expect(pictureKey("data:image/webp;base64,UklGRhYAAABXRUJQVlA5")).not.toBe(key);
    expect(pictureKey(null)).toBeNull();
  });

  it("gives back the set's bytes, an upload the card holds, or nothing for an upload it lost", () => {
    const upload = "data:image/webp;base64,UklGRhYAAABXRUJQVlA4";
    const key = pictureKey(upload)!;
    expect(pictureData("set:sun", {})).toBe(BOT_PICTURE_DATA.sun);
    expect(pictureData(key, { [key]: upload })).toBe(upload);
    expect(pictureData(key, {})).toBeUndefined();
    expect(pictureData(null, {})).toBeNull();
  });
});
