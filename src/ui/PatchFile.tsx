// One file's diff, as a reply's file changes show it (FileChanges.tsx, ADR 0180).
import { useMemo } from "react";
import { parseDiff } from "../hermes/diff";

const conflictMarker = (t: string) => /^(<{7}|={7}|>{7}|\|{7})( |$)/.test(t);

export function PatchFile({ diff }: { diff: string }) {
  const parsed = useMemo(() => parseDiff(diff), [diff]);
  const title = /^diff --git a\/(.*) b\/(.*)$/m.exec(diff);
  return (
    <div className="repo-review-file">
      <div className="repo-review-file-head mono">{parsed.rename ? `${parsed.rename.from} → ${parsed.rename.to}` : (title?.[2] ?? "")}</div>
      {parsed.binary && <p className="repo-notice">Binary file.</p>}
      {parsed.hunks.map((h, i) => (
        <div key={i} className="files-diff-hunk">
          <div className="files-diff-at mono repo-hunk-head">
            <span>{h.header}</span>
          </div>
          {h.lines.map((l, j) => (
            <div key={j} className={`files-diff-line mono ${l.kind === "add" ? "add" : l.kind === "del" ? "del" : l.kind === "note" ? "note" : ""} ${conflictMarker(l.text) ? "marker" : ""}`}>
              {!parsed.combined && (
                <>
                  <span className="files-diff-no">{l.oldNo ?? ""}</span>
                  <span className="files-diff-no">{l.newNo ?? ""}</span>
                </>
              )}
              <span className="files-diff-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : l.kind === "note" ? "\\" : " "}</span>
              <span className="files-diff-text">{l.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
