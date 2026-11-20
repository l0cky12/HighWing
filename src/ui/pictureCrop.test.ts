// The crop step's arithmetic (ADR 0235): the square of an upload that becomes the bot's picture.
import { describe, expect, it } from "vitest";
import { CENTERED, MAX_ZOOM, clampCrop, placed, sourceRect, zoomTo, type Crop, type Size } from "./pictureCrop";

const FRAME = 200;
const IMAGES: Size[] = [
  { width: 4000, height: 3000 },
  { width: 3000, height: 4000 },
  { width: 512, height: 512 },
  { width: 1200, height: 100 },
  { width: 40, height: 90 },
];
const ZOOMS = [1, 1.01, 1.5, 2.37, MAX_ZOOM];
const PULLS = [-1e6, -37, 0, 12.5, 1e6];
const crops: Crop[] = ZOOMS.flatMap((zoom) => PULLS.flatMap((x) => PULLS.map((y) => ({ zoom, x, y }))));

describe("the crop of an uploaded picture", () => {
  it("starts with the middle square of the image, whichever way it is longer", () => {
    expect(sourceRect({ width: 4000, height: 3000 }, FRAME, CENTERED)).toEqual({ x: 500, y: 0, size: 3000 });
    expect(sourceRect({ width: 3000, height: 4000 }, FRAME, CENTERED)).toEqual({ x: 0, y: 500, size: 3000 });
    expect(sourceRect({ width: 512, height: 512 }, FRAME, CENTERED)).toEqual({ x: 0, y: 0, size: 512 });
  });

  it("keeps the frame covered at every zoom, however far the image is dragged", () => {
    for (const image of IMAGES)
      for (const crop of crops) {
        const at = placed(image, FRAME, crop);
        const why = JSON.stringify({ image, crop });
        expect(at.left, why).toBeLessThanOrEqual(1e-9);
        expect(at.top, why).toBeLessThanOrEqual(1e-9);
        expect(at.left + at.width, why).toBeGreaterThanOrEqual(FRAME - 1e-9);
        expect(at.top + at.height, why).toBeGreaterThanOrEqual(FRAME - 1e-9);
      }
  });

  it("draws only pixels the image has", () => {
    for (const image of IMAGES)
      for (const crop of crops) {
        const { x, y, size } = sourceRect(image, FRAME, crop);
        const why = JSON.stringify({ image, crop });
        expect(x, why).toBeGreaterThanOrEqual(0);
        expect(y, why).toBeGreaterThanOrEqual(0);
        expect(x + size, why).toBeLessThanOrEqual(image.width + 1e-9);
        expect(y + size, why).toBeLessThanOrEqual(image.height + 1e-9);
        expect(size, why).toBeCloseTo(Math.min(image.width, image.height) / clampCrop(image, FRAME, crop).zoom);
      }
  });

  it("draws what the frame shows: the square moves against the drag, by the drag over the scale", () => {
    // 4000 × 3000 at zoom 2 shows 1500 image pixels across the 200 px frame.
    const image = { width: 4000, height: 3000 };
    expect(sourceRect(image, FRAME, { zoom: 2, x: 0, y: 0 })).toEqual({ x: 1250, y: 750, size: 1500 });
    expect(sourceRect(image, FRAME, { zoom: 2, x: 40, y: -20 })).toEqual({ x: 950, y: 900, size: 1500 });
    const at = placed(image, FRAME, { zoom: 2, x: 40, y: -20 });
    const scale = at.width / image.width;
    [-at.left / scale, -at.top / scale, FRAME / scale].forEach((v, i) => expect(v).toBeCloseTo([950, 900, 1500][i]));
  });

  it("holds zoom between 1 and the most, and reads a zoom that isn't a number as 1", () => {
    const image = { width: 800, height: 600 };
    expect(clampCrop(image, FRAME, { zoom: 0.2, x: 0, y: 0 }).zoom).toBe(1);
    expect(clampCrop(image, FRAME, { zoom: 99, x: 0, y: 0 }).zoom).toBe(MAX_ZOOM);
    expect(clampCrop(image, FRAME, { zoom: Number.NaN, x: 0, y: 0 }).zoom).toBe(1);
  });

  it("zooms about the frame's middle, and pulls the image back over the frame when zooming out", () => {
    const image = { width: 800, height: 800 };
    const moved = clampCrop(image, FRAME, { zoom: 2, x: 60, y: -30 });
    const middle = (c: Crop) => {
      const r = sourceRect(image, FRAME, c);
      return [r.x + r.size / 2, r.y + r.size / 2];
    };
    expect(middle(zoomTo(image, FRAME, moved, 4))).toEqual(middle(moved));
    expect(zoomTo(image, FRAME, clampCrop(image, FRAME, { zoom: 2, x: 100, y: 100 }), 1)).toEqual(CENTERED);
  });
});
