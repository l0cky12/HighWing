// Git's unified diffs, read for showing a reply's file changes (FileChanges.tsx, ADR 0180).

export type DiffLine = {
  kind: "context" | "add" | "del" | "note";
  text: string;
  /** Line numbers in the old and new file, where the line has one. */
  oldNo?: number;
  newNo?: number;
};

export type DiffHunk = {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type ParsedDiff = {
  /** A conflict's combined diff (`diff --cc`): two columns of signs, no single old file. */
  combined: boolean;
  binary: boolean;
  newFile: boolean;
  deletedFile: boolean;
  rename?: { from: string; to: string; similarity?: string };
  copy?: { from: string; to: string };
  mode?: { from: string; to: string };
  /** A file whose mode alone is shown, such as a new empty file. */
  newMode?: string;
  submodule: boolean;
  hunks: DiffHunk[];
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Reads one file's unified diff. An empty string is no change. */
export function parseDiff(text: string): ParsedDiff {
  const out: ParsedDiff = { combined: false, binary: false, newFile: false, deletedFile: false, submodule: false, hunks: [] };
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let hunk: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  let renameFrom: string | undefined;
  let copyFrom: string | undefined;
  let oldMode: string | undefined;
  let similarity: string | undefined;
  for (const line of lines) {
    if (hunk) {
      if (out.combined) {
        if (line.startsWith("@@@")) hunk = undefined;
        else {
          const signs = line.slice(0, 2);
          hunk.lines.push({ kind: signs.includes("+") ? "add" : signs.includes("-") ? "del" : line.startsWith("\\") ? "note" : "context", text: line.slice(2) });
          continue;
        }
      } else if (line.startsWith(" ")) {
        hunk.lines.push({ kind: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
        continue;
      } else if (line.startsWith("+")) {
        hunk.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
        continue;
      } else if (line.startsWith("-")) {
        hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
        continue;
      } else if (line.startsWith("\\")) {
        hunk.lines.push({ kind: "note", text: line.slice(2) });
        continue;
      } else if (line === "") {
        // A blank context line whose leading space was lost.
        hunk.lines.push({ kind: "context", text: "", oldNo: oldNo++, newNo: newNo++ });
        continue;
      } else hunk = undefined;
    }
    if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) out.combined = true;
    else if (line.startsWith("new file mode ")) {
      out.newFile = true;
      out.newMode = line.slice("new file mode ".length);
    } else if (line.startsWith("deleted file mode ")) out.deletedFile = true;
    else if (line.startsWith("old mode ")) oldMode = line.slice("old mode ".length);
    else if (line.startsWith("new mode ") && oldMode) out.mode = { from: oldMode, to: line.slice("new mode ".length) };
    else if (line.startsWith("similarity index ")) similarity = line.slice("similarity index ".length);
    else if (line.startsWith("rename from ")) renameFrom = line.slice("rename from ".length);
    else if (line.startsWith("rename to ") && renameFrom !== undefined) out.rename = { from: renameFrom, to: line.slice("rename to ".length), ...(similarity && { similarity }) };
    else if (line.startsWith("copy from ")) copyFrom = line.slice("copy from ".length);
    else if (line.startsWith("copy to ") && copyFrom !== undefined) out.copy = { from: copyFrom, to: line.slice("copy to ".length) };
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") out.binary = true;
    else if (line.startsWith("Subproject commit ") || line.startsWith("-Subproject commit ") || line.startsWith("+Subproject commit ")) out.submodule = true;
    else if (out.combined && line.startsWith("@@@")) {
      hunk = { header: line, oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines: [] };
      out.hunks.push(hunk);
    } else {
      const m = HUNK.exec(line);
      if (m) {
        hunk = {
          header: line,
          oldStart: Number(m[1]),
          oldLines: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newLines: m[4] === undefined ? 1 : Number(m[4]),
          lines: [],
        };
        oldNo = hunk.oldStart;
        newNo = hunk.newStart;
        out.hunks.push(hunk);
      }
    }
  }
  return out;
}

/** A combined patch, such as `rollback.diff`'s, split into each file's own diff, without the stat above them. */
export function splitPatch(text: string): { header: string; diff: string }[] {
  const out: { header: string; diff: string }[] = [];
  for (const part of text.split(/^(?=diff --git )/m)) {
    if (!part.startsWith("diff --git ")) continue;
    out.push({ header: part.slice(0, part.indexOf("\n") >>> 0), diff: part });
  }
  return out;
}
