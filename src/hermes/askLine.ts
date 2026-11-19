// Whose turn is running in a bot's Bot Chat that this connection resumed for an Ask (ADR 0225). Hermes's
// `message.start` names no message, so a turn is told apart by order: Hermes runs the messages it holds for a session
// first in, first out, and answers `prompt.submit` with whether the message started at once or is held. Pure: the desk
// (`asks.ts`) feeds it what the wire said and applies what it answers.

/** A session event of a turn: `message.start`, `message.delta`, `message.complete`, `error` and the rest. */
export type TurnEvent = { type: string; payload: Record<string, unknown> };

/**
 * An Ask Hermes has, or may have, whose turn hasn't started. `unanswered`: `prompt.submit` went and Hermes hasn't
 * answered. `atOnce`: Hermes started its turn. `held`: Hermes holds it behind the turn that was running.
 */
type Waiting = { ask: string; by: "unanswered" | "atOnce" | "held" };

/**
 * The turn running in the session. `other`: not one of ours, as when another bot's message or another Hermes client
 * started it. `unclaimed`: it started while our oldest Ask was unanswered, so its events are kept until the answer says
 * whose it is; `over` once it has ended, which it can before the answer comes.
 */
type Running = { owner: "ask"; ask: string } | { owner: "other" } | { owner: "unclaimed"; heard: TurnEvent[]; over: boolean };

/** One bot's session. `waiting` is in the order the Asks were submitted. */
export type Line = { readonly waiting: readonly Waiting[]; readonly running: Running | null };

export const EMPTY_LINE: Line = { waiting: [], running: null };

export type LineInput =
  | { kind: "submitted"; ask: string }
  | { kind: "answered"; ask: string; held: boolean }
  /** Hermes turned the message down, so it has no turn to come. */
  | { kind: "refused"; ask: string }
  | { kind: "event"; event: TurnEvent };

export type LineOutput =
  | { kind: "held"; ask: string }
  | { kind: "started"; ask: string }
  | { kind: "heard"; ask: string; event: TurnEvent }
  | { kind: "ended"; ask: string; event: TurnEvent };

type Stepped = { line: Line; out: LineOutput[] };

const ENDS = new Set(["message.complete", "error"]);

/**
 * A turn given to whoever is at the head of the line: an Ask Hermes has, which hears what the turn has said so far; an
 * Ask Hermes hasn't answered for, which leaves it unclaimed; or no one, which makes it someone else's.
 */
function claim(waiting: readonly Waiting[], heard: TurnEvent[], over: boolean): Stepped {
  const [head, ...rest] = waiting;
  if (!head) return { line: { waiting, running: over ? null : { owner: "other" } }, out: [] };
  if (head.by === "unanswered") return { line: { waiting, running: { owner: "unclaimed", heard, over } }, out: [] };
  const started: Stepped = { line: { waiting: rest, running: { owner: "ask", ask: head.ask } }, out: [{ kind: "started", ask: head.ask }] };
  return heard.reduce((at, event) => {
    const next = step(at.line, { kind: "event", event });
    return { line: next.line, out: [...at.out, ...next.out] };
  }, started);
}

export function step(line: Line, input: LineInput): Stepped {
  const { waiting, running } = line;
  const isHead = (ask: string) => waiting[0]?.ask === ask;
  switch (input.kind) {
    case "submitted":
      return { line: { waiting: [...waiting, { ask: input.ask, by: "unanswered" }], running }, out: [] };
    case "answered": {
      if (!waiting.some((w) => w.ask === input.ask)) return { line, out: [] };
      const marked = waiting.map((w): Waiting => (w.ask === input.ask ? { ask: w.ask, by: input.held ? "held" : "atOnce" } : w));
      const held: LineOutput[] = input.held ? [{ kind: "held", ask: input.ask }] : [];
      if (running?.owner !== "unclaimed" || !isHead(input.ask)) return { line: { waiting: marked, running }, out: held };
      // Hermes held ours because a turn was running: the unclaimed one.
      if (input.held) return { line: { waiting: marked, running: running.over ? null : { owner: "other" } }, out: held };
      return claim(marked, running.heard, running.over);
    }
    case "refused": {
      const rest = waiting.filter((w) => w.ask !== input.ask);
      if (running?.owner !== "unclaimed" || !isHead(input.ask)) return { line: { waiting: rest, running }, out: [] };
      return claim(rest, running.heard, running.over);
    }
    case "event": {
      const { event } = input;
      if (event.type === "message.start") {
        // Hermes ends a turn before it starts the next; one whose end went unheard ends here with what it streamed.
        const cut: LineOutput[] = running?.owner === "ask" ? [{ kind: "ended", ask: running.ask, event: { type: "message.complete", payload: {} } }] : [];
        const next = claim(waiting, [], false);
        return { line: next.line, out: [...cut, ...next.out] };
      }
      if (!running) return { line, out: [] };
      if (running.owner === "unclaimed") return { line: { waiting, running: running.over ? running : { owner: "unclaimed", heard: [...running.heard, event], over: ENDS.has(event.type) } }, out: [] };
      if (ENDS.has(event.type)) return { line: { waiting, running: null }, out: running.owner === "ask" ? [{ kind: "ended", ask: running.ask, event }] : [] };
      return { line, out: running.owner === "ask" ? [{ kind: "heard", ask: running.ask, event }] : [] };
    }
  }
}
