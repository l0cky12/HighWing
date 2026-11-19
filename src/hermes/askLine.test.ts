import { describe, expect, test } from "vitest";
import { EMPTY_LINE, step, type Line, type LineInput, type LineOutput } from "./askLine";

const ev = (type: string, text?: string): LineInput => ({ kind: "event", event: { type, payload: text === undefined ? {} : { text } } });

/** What the cards were told, in order: `started a`, `heard a hello`, `ended a`, `held b`. */
function run(inputs: LineInput[], from: Line = EMPTY_LINE): string[] {
  const told: LineOutput[] = [];
  inputs.reduce((line, input) => {
    const next = step(line, input);
    told.push(...next.out);
    return next.line;
  }, from);
  return told.map((o) => (o.kind === "heard" ? `heard ${o.ask} ${String(o.event.payload.text ?? o.event.type)}` : `${o.kind} ${o.ask}`));
}

describe("whose turn is running in a bot's Bot Chat", () => {
  test("a message Hermes starts at once gets the turn that starts next", () => {
    expect(run([{ kind: "submitted", ask: "a" }, { kind: "answered", ask: "a", held: false }, ev("message.start"), ev("message.delta", "Hi"), ev("message.complete", "Hi")])).toEqual([
      "started a",
      "heard a Hi",
      "ended a",
    ]);
  });

  test("a turn that starts before Hermes answers is kept, then given to the message Hermes says it started", () => {
    expect(run([{ kind: "submitted", ask: "a" }, ev("message.start"), ev("message.delta", "Hi"), { kind: "answered", ask: "a", held: false }, ev("message.delta", " there"), ev("message.complete")])).toEqual([
      "started a",
      "heard a Hi",
      "heard a  there",
      "ended a",
    ]);
  });

  test("a turn running when Hermes holds the message is someone else's, and the next one is the message's", () => {
    expect(
      run([
        { kind: "submitted", ask: "a" },
        ev("message.start"),
        ev("message.delta", "to someone else"),
        { kind: "answered", ask: "a", held: true },
        ev("message.delta", "still someone else"),
        ev("message.complete"),
        ev("message.start"),
        ev("message.delta", "to a"),
        ev("message.complete"),
      ]),
    ).toEqual(["held a", "started a", "heard a to a", "ended a"]);
  });

  test("a turn already running, whose start went unheard, is never a held message's", () => {
    expect(run([{ kind: "submitted", ask: "a" }, { kind: "answered", ask: "a", held: true }, ev("message.delta", "someone else's"), ev("message.complete"), ev("message.start"), ev("message.delta", "to a"), ev("message.complete")])).toEqual([
      "held a",
      "started a",
      "heard a to a",
      "ended a",
    ]);
  });

  test("two messages to one bot get their turns in the order they went", () => {
    expect(
      run([
        { kind: "submitted", ask: "a" },
        { kind: "answered", ask: "a", held: false },
        ev("message.start"),
        { kind: "submitted", ask: "b" },
        { kind: "answered", ask: "b", held: true },
        ev("message.delta", "one"),
        ev("message.complete"),
        ev("message.start"),
        ev("message.delta", "two"),
        ev("message.complete"),
      ]),
    ).toEqual(["started a", "held b", "heard a one", "ended a", "started b", "heard b two", "ended b"]);
  });

  test("a turn that starts with none of ours waiting is someone else's from start to end", () => {
    expect(run([ev("message.start"), ev("message.delta", "x"), ev("message.complete"), { kind: "submitted", ask: "a" }, { kind: "answered", ask: "a", held: false }, ev("message.start"), ev("message.complete")])).toEqual([
      "started a",
      "ended a",
    ]);
  });

  test("a message Hermes turns down takes no turn, and the one behind it gets the turn kept for it", () => {
    expect(
      run([{ kind: "submitted", ask: "a" }, { kind: "submitted", ask: "b" }, ev("message.start"), ev("message.delta", "Hi"), { kind: "refused", ask: "a" }, { kind: "answered", ask: "b", held: false }, ev("message.complete")]),
    ).toEqual(["started b", "heard b Hi", "ended b"]);
  });

  test("a turn that starts and ends before Hermes answers is still the message's, whole", () => {
    expect(run([{ kind: "submitted", ask: "a" }, ev("message.start"), ev("message.delta", "Hi"), ev("message.complete", "Hi"), { kind: "answered", ask: "a", held: false }])).toEqual(["started a", "heard a Hi", "ended a"]);
  });

  test("a turn that ended before Hermes said it holds the message was someone else's, and the next is the message's", () => {
    expect(
      run([{ kind: "submitted", ask: "a" }, ev("message.start"), ev("message.complete", "theirs"), { kind: "answered", ask: "a", held: true }, ev("message.start"), ev("message.delta", "ours"), ev("message.complete")]),
    ).toEqual(["held a", "started a", "heard a ours", "ended a"]);
  });

  test("a turn that ends with an error ends its message's card", () => {
    expect(run([{ kind: "submitted", ask: "a" }, { kind: "answered", ask: "a", held: false }, ev("message.start"), ev("error")])).toEqual(["started a", "ended a"]);
  });

  test("a start heard while a message's turn still runs ends that turn first", () => {
    expect(run([{ kind: "submitted", ask: "a" }, { kind: "answered", ask: "a", held: false }, ev("message.start"), ev("message.delta", "Hi"), ev("message.start"), ev("message.delta", "x")])).toEqual([
      "started a",
      "heard a Hi",
      "ended a",
    ]);
  });

  test("an answer for a message no longer in line changes nothing", () => {
    expect(run([{ kind: "answered", ask: "gone", held: true }, ev("message.complete")])).toEqual([]);
  });
});
