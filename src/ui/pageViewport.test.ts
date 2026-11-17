import { describe, expect, it } from "vitest";
import { DEVICES, fitScale, parseSide, SIDE, STAGE_INSET } from "./PageViewport";

/** The devices and sizes in the owner's screenshot of the menu, in its order. */
const ASKED: [string, number, number][] = [
  ["iPhone SE", 375, 667],
  ["iPhone XR", 414, 896],
  ["iPhone 12 Pro", 390, 844],
  ["iPhone 14 Pro Max", 430, 932],
  ["Pixel 7", 412, 915],
  ["Samsung Galaxy S8+", 360, 740],
  ["Samsung Galaxy S20 Ultra", 412, 915],
  ["iPad Mini", 768, 1024],
  ["iPad Air", 820, 1180],
  ["iPad Pro", 1024, 1366],
  ["Surface Pro 7", 912, 1368],
  ["Surface Duo", 540, 720],
  ["Galaxy Z Fold 5", 344, 882],
  ["Asus Zenbook Fold", 853, 1280],
  ["Samsung Galaxy A51/71", 412, 914],
  ["Nest Hub", 1024, 600],
  ["Nest Hub Max", 1280, 800],
];

describe("The device sizes", () => {
  it("are the seventeen asked for, in order, each named once", () => {
    expect(DEVICES.map((d) => [d.name, d.width, d.height])).toEqual(ASKED);
    expect(new Set(DEVICES.map((d) => d.name)).size).toBe(17);
  });

  it.each(ASKED)("%s is %i × %i, a size the fields accept", (name, width, height) => {
    expect(DEVICES.find((d) => d.name === name)).toEqual({ name, width, height });
    expect([parseSide(String(width)), parseSide(String(height))]).toEqual([width, height]);
  });
});

describe("A typed side", () => {
  it.each(["50", "747", "818", "9999"])("takes %s", (text) => expect(parseSide(text)).toBe(Number(text)));

  it.each(["", " ", "0", "-5", "+5", "49", "10000", "99999999999999999999", "12.5", "12.", "1e3", "0x20", "NaN", "Infinity", "400px", " 400", "400 ", "0400", "４００", "4,00"])(
    "turns down %j rather than reading part of it",
    (text) => expect(parseSide(text)).toBeUndefined(),
  );

  it("is bounded as the fields say", () => expect(SIDE).toEqual({ min: 50, max: 9999 }));
});

describe("Fitting a page to the Preview", () => {
  it("never scales a page up, and scales one too big for either side down to fit both, clear of the box's edge", () => {
    expect(STAGE_INSET).toBe(8);
    expect(fitScale({ width: 480, height: 700 }, { width: 375, height: 667 })).toBe(1);
    expect(fitScale({ width: 480, height: 683 }, { width: 375, height: 667 })).toBe(1);
    expect(fitScale({ width: 480, height: 683 }, { width: 1280, height: 800 })).toBe(464 / 1280);
    expect(fitScale({ width: 480, height: 683 }, { width: 344, height: 882 })).toBeCloseTo(667 / 882);
  });
});
