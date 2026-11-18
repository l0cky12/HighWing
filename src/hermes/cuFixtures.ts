// The computer_use frames recorded from a real Hermes (ADR 0213, docs/research/computer-use-payloads.md), for tests and
// FakeHermes `replay`. Each line of a fixture is one WebSocket frame, with when it came and which way it went.
import approve from "./fixtures/computer-use/10-turn-approve.jsonl?raw";
import foreground from "./fixtures/computer-use/11-turn-foreground.jsonl?raw";
import deny from "./fixtures/computer-use/12-turn-deny.jsonl?raw";
import takeover from "./fixtures/computer-use/13-turn-takeover.jsonl?raw";
import interrupt from "./fixtures/computer-use/14-turn-interrupt.jsonl?raw";
import history from "./fixtures/computer-use/15-resume-history.jsonl?raw";

export type CuFrame = { t: number; dir: "in" | "out"; frame: Record<string, unknown> };

const FIXTURES = {
  "10-turn-approve": approve,
  "11-turn-foreground": foreground,
  "12-turn-deny": deny,
  "13-turn-takeover": takeover,
  "14-turn-interrupt": interrupt,
  "15-resume-history": history,
};
export type CuFixture = keyof typeof FIXTURES;
export const CU_TURNS = ["10-turn-approve", "11-turn-foreground", "12-turn-deny", "13-turn-takeover", "14-turn-interrupt"] as const satisfies readonly CuFixture[];

export const cuFixture = (name: CuFixture): CuFrame[] =>
  FIXTURES[name]
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CuFrame);

/** The events of a recorded turn that Hermes sent, by type, in order. */
export function cuEvents(name: CuFixture, type: string): Record<string, unknown>[] {
  return cuFixture(name).flatMap(({ dir, frame }) => {
    const p = frame.params as { type?: string; payload?: Record<string, unknown> } | undefined;
    return dir === "in" && frame.method === "event" && p?.type === type && p.payload ? [p.payload] : [];
  });
}
