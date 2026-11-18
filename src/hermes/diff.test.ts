// Reading git's unified diffs (diff.ts). The diffs below are what git wrote for real repositories.
import { describe, expect, it } from "vitest";
import { parseDiff, splitPatch } from "./diff";

describe("parseDiff", () => {
  it("numbers the lines of each hunk on both sides", () => {
    const d = parseDiff(
      "diff --git a/f.txt b/f.txt\nindex 1..2 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n\\ No newline at end of file\n",
    );
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0].lines).toEqual([
      { kind: "context", text: "a", oldNo: 1, newNo: 1 },
      { kind: "del", text: "b", oldNo: 2 },
      { kind: "add", text: "B", newNo: 2 },
      { kind: "context", text: "c", oldNo: 3, newNo: 3 },
      { kind: "note", text: "No newline at end of file" },
    ]);
  });

  it("reads renames, binary files, new files and mode changes", () => {
    expect(parseDiff("diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n").rename).toEqual({ from: "old.txt", to: "new.txt", similarity: "100%" });
    expect(parseDiff("diff --git a/b b/b\nindex bdc955b..8835708 100644\nBinary files a/b and b/b differ\n").binary).toBe(true);
    const n = parseDiff("diff --git a/x b/x\nnew file mode 100755\nindex 0..1\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+u\n");
    expect(n).toMatchObject({ newFile: true, newMode: "100755" });
    expect(n.hunks[0].lines).toEqual([{ kind: "add", text: "u", newNo: 1 }]);
    expect(parseDiff("diff --git a/s b/s\nold mode 100644\nnew mode 100755\n").mode).toEqual({ from: "100644", to: "100755" });
  });

  it("reads a conflict's combined diff, with its markers as lines", () => {
    const d = parseDiff(
      "diff --cc notes.txt\nindex 1,2..0\n--- a/notes.txt\n+++ b/notes.txt\n@@@ -1,2 -1,2 +1,6 @@@\n  one\n++<<<<<<< HEAD\n +MAIN\n++=======\n+ OTHER\n++>>>>>>> other\n",
    );
    expect(d.combined).toBe(true);
    expect(d.hunks[0].lines.map((l) => [l.kind, l.text])).toEqual([
      ["context", "one"],
      ["add", "<<<<<<< HEAD"],
      ["add", "MAIN"],
      ["add", "======="],
      ["add", "OTHER"],
      ["add", ">>>>>>> other"],
    ]);
  });

  it("finds nothing in an empty diff", () => {
    expect(parseDiff("").hunks).toEqual([]);
  });
});

it("splits a combined patch by file, without the stat above it", () => {
  const parts = splitPatch(" a | 1 +\n 1 file changed\n\ndiff --git a/a b/a\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/b b/c\nsimilarity index 100%\nrename from b\nrename to c\n");
  expect(parts.map((p) => p.header)).toEqual(["diff --git a/a b/a", "diff --git a/b b/c"]);
});
