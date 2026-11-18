// Who drives the profile's Bot Desktop, as this connection knows it (ADR 0039, ADR 0214). Hermes keeps the lease; a
// viewer id minted by `display.observe` on this connection is what takes it or gives it back. This is the one place that
// keeps that id, the latest lease and the holds this app had on connections since gone, so the Screen tab, the run
// card, the banner and Stop agree, and the screen can be taken while the Screen tab was never opened.
import { isOlder, isUnavailable, viewerHash, type DisplayLease, type DisplayObserve, type DisplayStatus } from "./screen";
import { errorText } from "./values";

/**
 * Who holds the screen, from this app's side. `you`: this connection's viewer. `you-before`: a viewer this app held it
 * as on a connection since gone; Hermes keeps such a hold. `someone`: another Hermes client.
 */
export type ScreenHolder =
  | { kind: "agent" }
  | { kind: "you"; since: number }
  | { kind: "you-before"; since: number }
  | { kind: "someone"; since: number; reason?: string };

/** The shown profile's screen in the snapshot. Undefined until a status or an observe names it. */
export type ScreenState = { profileKey: string; holder: ScreenHolder; epoch: number };

/** What taking the screen came to. `no-screen`: it isn't running, or this Hermes has none, so nothing can drive it. */
export type HoldOutcome = { kind: "held" } | { kind: "already" } | { kind: "no-screen"; why: string } | { kind: "failed"; why: string };

type DisplayMethod = "display.status" | "display.observe" | "display.lease.acquire" | "display.lease.release";

export type ScreenControlDeps = {
  request: (method: DisplayMethod, params: Record<string, unknown>) => Promise<unknown>;
  profile: () => string;
  /** The live connection; a viewer id is good only on the one that minted it. */
  connection: () => object | undefined;
  publish: (state: ScreenState | undefined) => void;
};

/** How long leaving waits for Hermes to take the screen back before it goes anyway. */
const RELEASE_MS = 1_500;

type Viewer = { id: string; hash: string; connection: object; profile: string };

export class ScreenControl {
  private viewer?: Viewer;
  private known?: { profile: string; profileKey: string; lease: DisplayLease };
  /** Hashes of every viewer this app has held the screen as. */
  private held = new Set<string>();
  private minting?: Promise<DisplayObserve>;
  private releasing?: Promise<void>;

  constructor(private readonly deps: ScreenControlDeps) {}

  /** Folds in a `display.lease` broadcast. One for another profile's screen, or older than the lease known, is dropped. */
  note(profileKey: string, lease: DisplayLease): void {
    const k = this.known;
    if (k && k.profile === this.deps.profile() && k.profileKey === profileKey) this.fold(profileKey, lease);
  }

  /** Folds in the lease a status, a start or a stop answered with, and returns that answer. */
  noteStatus<S extends DisplayStatus>(s: S): S {
    if (s.lease && typeof s.profile_key === "string") this.fold(s.profile_key, s.lease);
    return s;
  }

  status(): Promise<DisplayStatus> {
    return this.ask("display.status").then((s) => this.noteStatus(s as DisplayStatus));
  }

  /** A stream ticket, as this connection's viewer: minted on first use and reused after, so a hold survives a re-attach. */
  async observe(): Promise<DisplayObserve> {
    if (!this.current() && this.minting) await this.minting.catch(() => {});
    const viewer = this.current();
    const asking = this.observeAs(viewer);
    if (!viewer) this.minting = asking;
    return asking;
  }

  /** Takes the screen for the owner. Idempotent: `already` when this viewer holds it, with no request. */
  async hold(reason?: string): Promise<HoldOutcome> {
    if (this.state()?.holder.kind === "you") return { kind: "already" };
    try {
      const viewer = this.current() ?? (await this.observe(), this.current());
      if (!viewer) return { kind: "failed", why: "The connection to Hermes changed while taking the screen." };
      const { lease } = (await this.ask("display.lease.acquire", { viewer_id: viewer.id, ...(reason && { reason }) })) as { lease: DisplayLease };
      if (this.known) this.fold(this.known.profileKey, lease);
      return { kind: "held" };
    } catch (e) {
      if (isUnavailable(e)) return { kind: "no-screen", why: "This Hermes has no Bot Desktop." };
      if (/not running/i.test(errorText(e))) return { kind: "no-screen", why: errorText(e) };
      return { kind: "failed", why: errorText(e) };
    }
  }

  /** Gives the screen back to Hermes. Nothing to do when this connection's viewer doesn't hold it. */
  async handBack(): Promise<void> {
    const viewer = this.current();
    if (!viewer || this.state()?.holder.kind !== "you") return;
    const { lease } = (await this.ask("display.lease.release", { viewer_id: viewer.id })) as { lease: DisplayLease };
    if (this.known) this.fold(this.known.profileKey, lease);
  }

  /**
   * Before leaving the connection on purpose: hands back what this viewer holds, waiting at most `RELEASE_MS`. Its
   * stream may already be gone, and with it the normal close that would have done this. A dropped connection keeps the
   * owner in control, as Hermes intends. Undefined when there is nothing to wait for; a leave that comes while an
   * earlier one hands back waits for it too.
   */
  release(): Promise<void> | undefined {
    if (this.state()?.holder.kind === "you") {
      const releasing: Promise<void> = Promise.race([this.handBack().catch(() => {}), new Promise<void>((done) => setTimeout(done, RELEASE_MS))]).finally(() => {
        if (this.releasing === releasing) this.releasing = undefined;
      });
      this.releasing = releasing;
    }
    return this.releasing;
  }

  /** The connection or the profile shown changed: a viewer minted before is no good now. */
  rescope(): void {
    this.minting = undefined;
    this.publish();
  }

  private ask(method: DisplayMethod, params: Record<string, unknown> = {}) {
    return this.deps.request(method, { profile: this.deps.profile(), ...params });
  }

  private async observeAs(viewer: Viewer | undefined): Promise<DisplayObserve> {
    const connection = this.deps.connection();
    const profile = this.deps.profile();
    const seen = (await this.ask("display.observe", viewer ? { viewer_id: viewer.id } : {})) as DisplayObserve;
    if (connection && viewer?.id !== seen.viewer_id) {
      const hash = await viewerHash(seen.viewer_id);
      if (connection === this.deps.connection() && profile === this.deps.profile()) this.viewer = { id: seen.viewer_id, hash, connection, profile };
    }
    return this.noteStatus(seen);
  }

  private current(): Viewer | undefined {
    const v = this.viewer;
    return v && v.connection === this.deps.connection() && v.profile === this.deps.profile() ? v : undefined;
  }

  private fold(profileKey: string, lease: DisplayLease) {
    const profile = this.deps.profile();
    const k = this.known;
    if (k && k.profile === profile && k.profileKey === profileKey && isOlder(k.lease, lease)) return;
    this.known = { profile, profileKey, lease };
    this.publish();
  }

  private state(): ScreenState | undefined {
    const k = this.known;
    if (!k || k.profile !== this.deps.profile()) return undefined;
    const { lease } = k;
    const viewer = this.current();
    let holder: ScreenHolder;
    if (lease.holder === "agent") holder = { kind: "agent" };
    else if (viewer && lease.viewer_hash === viewer.hash) holder = { kind: "you", since: lease.since };
    else if (lease.viewer_hash && this.held.has(lease.viewer_hash)) holder = { kind: "you-before", since: lease.since };
    else holder = { kind: "someone", since: lease.since, ...(lease.reason && { reason: lease.reason }) };
    if (holder.kind === "you" && viewer) this.held.add(viewer.hash);
    return { profileKey: k.profileKey, holder, epoch: lease.epoch };
  }

  private publish() {
    this.deps.publish(this.state());
  }
}
