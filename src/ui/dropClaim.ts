// Who takes a file dropped on the window. Tauri's native drop event reaches every listener, and each composer takes a
// drop over its pane, so something drawn above a pane that takes files itself (the picture picker, ADR 0235) claims
// the points it covers, and the listeners under it leave those drops alone.
type Covers = (x: number, y: number) => boolean;

const claims = new Set<Covers>();

/** Claims the drops at the points `covers` says yes to, in CSS pixels. Returns the release. */
export function claimDrops(covers: Covers): () => void {
  claims.add(covers);
  return () => void claims.delete(covers);
}

export const dropClaimed = (x: number, y: number) => [...claims].some((covers) => covers(x, y));
