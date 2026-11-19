// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "../hermes/model";
import { InlineMarks } from "./inlineMarks";

const file: Attachment = { path: "/s/1.png", name: "shot.png", size: 2048, kind: "image" };
const text = "see [image 2: shot.png] now";
const mark = { kind: "image", start: 4, end: 23, n: 2, name: "shot.png", file } as const;

const rect = (left: number, top: number, width: number): DOMRect => ({ left, top, width, height: 20, right: left + width, bottom: top + 20, x: left, y: top, toJSON: () => ({}) });

/** jsdom has no layout, so a mark's lines are given: `lines` are what its span reports. */
const draw = (lines: DOMRect[], selection: readonly [number, number] = [0, 0]) => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
    return (this.hasAttribute("data-mark") ? lines : [rect(0, 0, 400)]) as unknown as DOMRectList;
  });
  const ta = createRef<HTMLTextAreaElement>();
  const view = render(
    <>
      <textarea ref={ta} defaultValue={text} />
      <InlineMarks ta={ta} text={text} marks={[mark]} selection={selection} previews={() => undefined} />
    </>,
  );
  return view.container;
};

afterEach(() => vi.restoreAllMocks());

describe("InlineMarks", () => {
  it("draws a chip over a mark on one line and nothing to cover", () => {
    const out = draw([rect(40, 0, 120)]);
    expect(out.querySelectorAll(".inline-mark")).toHaveLength(1);
    expect(out.querySelectorAll(".inline-mark-cover")).toHaveLength(0);
    expect(out.querySelector(".inline-mark")?.textContent).toContain("shot.png");
  });

  it("puts the chip on the widest line of a mark that wraps and covers its other lines, so the raw words never show", () => {
    const out = draw([rect(300, 0, 60), rect(0, 20, 150)]);
    const chip = out.querySelector<HTMLElement>(".inline-mark")!;
    expect(out.querySelectorAll(".inline-mark")).toHaveLength(1);
    expect(chip.style.top).toBe("20px");
    const covers = out.querySelectorAll<HTMLElement>(".inline-mark-cover");
    expect(covers).toHaveLength(1);
    expect(covers[0].style.top).toBe("0px");
  });

  it("shows neither chip nor cover while the cursor is in the mark, so its words can be edited", () => {
    const out = draw([rect(300, 0, 60), rect(0, 20, 150)], [8, 8]);
    expect(out.querySelectorAll(".inline-mark, .inline-mark-cover")).toHaveLength(0);
  });
});
