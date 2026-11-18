// The Restart gateway button (ADR 0203), shown beside a change the profile's running gateway picks up only once it
// restarts: a Telegram or Discord change Hermes didn't hot-serve (Settings → Gateways), and an MCP server edited in place
// (Settings → MCP servers). A restart cuts off running replies, so it asks first when Hermes says any are running.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle } from "lucide-react";
import { Spinner } from "./bits";
import type { GatewayRestartApi, RestartMark } from "../hermes/gatewayRestart";
import { plural } from "../hermes/values";

type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "asking"; replies: number | undefined; others: string[] }
  | { kind: "restarting"; others: string[] }
  | { kind: "done"; others: string[] }
  | { kind: "failed"; why: string }
  | { kind: "unconfirmed"; why: string };

const noMarks: ReadonlySet<RestartMark> = new Set();
const noSubscribe = () => () => {};

/** The profile's changes waiting for a gateway restart, as `api` keeps them across screens. */
export function useRestartMarks(api: GatewayRestartApi | undefined, profile: string): ReadonlySet<RestartMark> {
  return useSyncExternalStore(api?.subscribe ?? noSubscribe, () => api?.marksOf(profile) ?? noMarks);
}

const alsoServes = (others: string[]) => (others.length ? ` The same gateway serves ${others.join(", ")}, so those bots reconnect too.` : "");

export function RestartGateway({
  api,
  profile,
  needed,
  connected,
  why,
  onRestarted,
}: {
  api: GatewayRestartApi;
  profile: string;
  /** The running gateway hasn't picked the change up yet. */
  needed: boolean;
  connected: boolean;
  /** What waits for the restart, in one line, shown before the button. */
  why?: string;
  /** Hermes reads the gateway back as running after the restart. */
  onRestarted?: () => void;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  // A new change that needs a restart starts over, past the last restart's outcome.
  useEffect(() => {
    if (needed) setState((s) => (s.kind === "done" ? { kind: "idle" } : s));
  }, [needed]);

  const restart = async (others: string[]) => {
    setState({ kind: "restarting", others });
    const r = await api.restart(profile);
    if (!live.current) return;
    if (r.kind === "restarted") {
      setState({ kind: "done", others });
      onRestarted?.();
    } else setState(r);
  };

  const start = async () => {
    setState({ kind: "checking" });
    let replies: number | undefined;
    let others: string[] = [];
    try {
      const s = await api.status(profile);
      replies = s.activeAgents;
      others = s.sharedWith.filter((p) => p !== profile);
    } catch {
      // Not known, so asked as if some were running.
    }
    if (!live.current) return;
    if (replies === 0) void restart(others);
    else setState({ kind: "asking", replies, others });
  };

  if (state.kind === "done")
    return (
      <div className="gw-line ok" role="status">
        Gateway restarted.{alsoServes(state.others)}
      </div>
    );
  if (!needed) return null;
  const busy = state.kind === "checking" || state.kind === "restarting";
  return (
    <>
      <div className="gw-restart">
        {why && <span className="gw-restart-why">{why}</span>}
        <button className="btn" disabled={!connected || busy || state.kind === "asking"} onClick={() => void start()}>
          {busy && <Spinner />} {state.kind === "restarting" ? "Restarting…" : "Restart gateway"}
        </button>
      </div>
      {state.kind === "asking" && (
        <div className="confirm set-confirm gw-restart-ask" role="alertdialog" aria-label="Restart gateway">
          <span className="confirm-msg">
            <AlertTriangle size={12} /> Restart {profile}'s gateway now?
          </span>
          <span className="confirm-detail">
            {state.replies === undefined ? "Hermes didn't say whether replies are running. Any running on this profile will be cut off." : `${plural(state.replies, "reply", "replies")} running on this profile will be cut off.`}
            {alsoServes(state.others)}
          </span>
          <div className="confirm-actions">
            <button className="btn" onClick={() => setState({ kind: "idle" })}>
              Cancel
            </button>
            <button className="btn danger" onClick={() => void restart(state.others)}>
              Restart anyway
            </button>
          </div>
        </div>
      )}
      {(state.kind === "failed" || state.kind === "unconfirmed") && (
        <div className={`gw-line ${state.kind === "failed" ? "bad" : "warn"}`} role={state.kind === "failed" ? "alert" : "status"}>
          {state.kind === "failed" ? "Couldn't restart the gateway: " : "Hermes didn't confirm the restart: "}
          {state.why}
        </div>
      )}
    </>
  );
}
