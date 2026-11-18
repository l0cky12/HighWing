import type { Answered, ProbeFailure, Stage } from "./setup";

/** A real sign-in that failed (src-tauri `hermes_connect`), as an Error that keeps the stage and answer Rust gave. */
export class SignInFailure extends Error implements ProbeFailure {
  readonly stage: Stage;
  readonly status?: string | null;
  readonly answered?: Answered;
  constructor(f: ProbeFailure) {
    super(f.message);
    this.stage = f.stage;
    this.status = f.status;
    this.answered = f.answered;
  }
}
