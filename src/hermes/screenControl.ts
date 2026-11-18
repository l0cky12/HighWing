// Who drives the profile's Bot Desktop, as this connection knows it (ADR 0039, ADR 0217). Hermes keeps the lease; a
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

type DisplayMethod = "display.status" | "display.start" | "display.stop" | "display.observe" | "display.lease.acquire" | "display.lease.release";

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
/** The connection and the profile a request was asked on. */
type Scope = { connection: object | undefined; profile: string };

export class ScreenControl {
  private viewer?: Viewer;
  private known?: { profile: string; profileKey: string; lease: DisplayLease };
  /** Hashes of every viewer this app has held the screen as. */
  private held = new Set<string>();
  private minting?: Promise<DisplayObserve>;
  private releasing?: Promise<void>;
  /** The hold on its way, and the connection and profile it was asked on. */
  private holding?: { scope: Scope; outcome: Promise<HoldOutcome> };
  /** Broadcasts heard before the profile's screen was named, by its key. */
  private heard = new Map<string, DisplayLease>();
  /** The connection and profile `know` last asked on. */
  private asked?: { connection: object; profile: string };

  constructor(private readonly deps: ScreenControlDeps) {}

  /**
   * Folds in a `display.lease` broadcast. One for another profile's screen, or older than the lease known, is dropped.
   * One heard before a status names the profile's screen waits for it.
   */
  note(profileKey: string, lease: DisplayLease): void {
    const k = this.known;
    if (k && k.profile === this.deps.profile()) {
      if (k.profileKey === profileKey) this.fold(profileKey, lease);
    } else if (!isOlder(this.heard.get(profileKey), lease)) this.heard.set(profileKey, lease);
  }

  /**
   * Asks for the screen's status, or starts or stops it, and folds in the lease Hermes answers with. An answer that comes
   * after the connection or the profile changed is for a screen no longer shown, so it is returned and not folded in.
   */
  async report(method: "display.status" | "display.start" | "display.stop"): Promise<DisplayStatus> {
    const scope = this.scope();
    return this.noteStatus((await this.ask(method)) as DisplayStatus, scope);
  }

  status(): Promise<DisplayStatus> {
    return this.report("display.status");
  }

  /**
   * Asks who holds the screen, once per connection and profile. A lease kept from an earlier connection may be stale:
   * the broadcasts that would have changed it went to no one while this app was away.
   */
  know(): Promise<void> | undefined {
    const connection = this.deps.connection();
    const profile = this.deps.profile();
    if (!connection || (this.asked?.connection === connection && this.asked.profile === profile)) return undefined;
    this.asked = { connection, profile };
    return this.status().then(
      () => {},
      () => {},
    );
  }

  /** A stream ticket, as this connection's viewer: minted on first use and reused after, so a hold survives a re-attach. */
  async observe(): Promise<DisplayObserve> {
    if (!this.current() && this.minting) await this.minting.catch(() => {});
    const viewer = this.current();
    const asking = this.observeAs(viewer);
    if (!viewer) this.minting = asking;
    return asking;
  }

  /**
   * Takes the screen for the owner. Idempotent: `already` when this viewer holds it, with no request, and a hold asked
   * for while one is on its way on the same connection and profile shares it, so a Hand back after it stays.
   */
  hold(reason?: string): Promise<HoldOutcome> {
    if (this.state()?.holder.kind === "you") return Promise.resolve({ kind: "already" });
    const h = this.holding;
    if (h && this.inScope(h.scope)) return h.outcome;
    const scope = this.scope();
    const outcome = this.acquire(scope, reason).finally(() => {
      if (this.holding?.outcome === outcome) this.holding = undefined;
    });
    this.holding = { scope, outcome };
    return outcome;
  }

  /** Acquires the lease. Its answer, like any other, is dropped when the connection or the profile changed since `scope`. */
  private async acquire(scope: Scope, reason?: string): Promise<HoldOutcome> {
    try {
      const viewer = this.current() ?? (await this.observe(), this.current());
      if (!viewer) return { kind: "failed", why: "The connection to Hermes changed while taking the screen." };
      const { lease } = (await this.ask("display.lease.acquire", { viewer_id: viewer.id, ...(reason && { reason }) })) as { lease: DisplayLease };
      if (this.known && this.inScope(scope)) this.fold(this.known.profileKey, lease);
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
    this.heard.clear();
    this.publish();
  }

  private ask(method: DisplayMethod, params: Record<string, unknown> = {}) {
    return this.deps.request(method, { profile: this.deps.profile(), ...params });
  }

  private async observeAs(viewer: Viewer | undefined): Promise<DisplayObserve> {
    const scope = this.scope();
    const { connection, profile } = scope;
    const seen = (await this.ask("display.observe", viewer ? { viewer_id: viewer.id } : {})) as DisplayObserve;
    if (connection && viewer?.id !== seen.viewer_id) {
      const hash = await viewerHash(seen.viewer_id);
      if (this.inScope(scope)) this.viewer = { id: seen.viewer_id, hash, connection, profile };
    }
    return this.noteStatus(seen, scope);
  }

  private scope(): Scope {
    return { connection: this.deps.connection(), profile: this.deps.profile() };
  }

  private inScope(scope: Scope): boolean {
    return scope.connection === this.deps.connection() && scope.profile === this.deps.profile();
  }

  /** Folds in the lease an answer asked in `scope` came with, unless the connection or the profile changed since. */
  private noteStatus<S extends DisplayStatus>(s: S, scope: Scope): S {
    if (this.inScope(scope) && s.lease && typeof s.profile_key === "string") {
      this.fold(s.profile_key, s.lease);
      const heard = this.heard.get(s.profile_key);
      this.heard.clear();
      if (heard) this.fold(s.profile_key, heard);
    }
    return s;
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
    return { profileKey: k.profileKey, holder, epoch: lease.epoch };
  }

  private publish() {
    const state = this.state();
    const viewer = this.current();
    if (state?.holder.kind === "you" && viewer) this.held.add(viewer.hash);
    this.deps.publish(state);
  }
}
