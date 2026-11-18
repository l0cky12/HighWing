// Writing for a bot (ADR 0203): Write with AI on the profile form's Persona (New and Edit), and project
// instructions. One stateless `llm.oneshot` per call, which takes no model: Hermes runs `auxiliary.<task>` of the
// profile's config. So which model writes is decided here, as which `task` to send and, for the app's Writing model,
// one config key this app keeps in step. Precedence: a model pinned on the server for the bot, then the app's Writing
// model, then the bot's own main model. Nothing else passes a `task` to `llm.oneshot` for writing.
import { INSTRUCTIONS_TASK, TEXT_TASK, WRITING_TASK } from "./modelSettings";
import { RpcError, missingSignIn } from "./transport";

/** What is being written. Only `instructions` has a pin of its own (`auxiliary.project_instructions`, ADR 0177). */
export type WritingKind = "persona" | "instructions";

/**
 * The app's Writing model for one connection, as kept on this computer. `apiUrl`: the catalog's URL for a user-defined
 * provider, captured when picked, so a call reads no catalog.
 */
export type WritingPick = { provider: string; model: string; apiUrl?: string };

/** Which server pin won. `text`: the bot's Text generation model. `instructions`: its Project instructions model. */
export type ServerPin = "text" | "instructions";

/** Where one writing call for one bot runs, and why. `provider` is "" only on `main`, for a bot with no main model. */
export type WritingRoute =
  | { via: "pin"; pin: ServerPin; provider: string; model: string }
  | { via: "app"; provider: string; model: string }
  | { via: "main"; provider: string; model: string };

type Model = { provider: string; model: string };

/** One bot's models as Hermes has them, read fresh for each call. */
export type WritingFacts = {
  main: Model;
  /** `auxiliary.title_generation` when its provider is neither empty nor `auto`. */
  text?: Model;
  /** `auxiliary.project_instructions`, by the same rule. */
  instructions?: Model;
  /** `auxiliary.highwing_writing` as stored, when its provider is set. Only the mirror check reads it. */
  mirror?: Model & { baseUrl: string };
};

/** The precedence. The mirror is deliberately not an input: a stale one never decides anything. */
export function writingRoute(facts: WritingFacts, kind: WritingKind, pick: WritingPick | undefined): WritingRoute {
  if (kind === "instructions" && facts.instructions) return { via: "pin", pin: "instructions", ...facts.instructions };
  if (facts.text) return { via: "pin", pin: "text", ...facts.text };
  if (pick) return { via: "app", provider: pick.provider, model: pick.model };
  return { via: "main", ...facts.main };
}

/** The `task` a call on `route` sends. `main` sends Text generation's, which is unset there, so Hermes runs the main model. */
function taskOf(route: WritingRoute): string {
  switch (route.via) {
    case "pin":
      return route.pin === "text" ? TEXT_TASK : INSTRUCTIONS_TASK;
    case "app":
      return WRITING_TASK;
    case "main":
      return TEXT_TASK;
  }
}

const mirrorIsCurrent = (mirror: WritingFacts["mirror"], pick: WritingPick) =>
  !!mirror && mirror.provider === pick.provider && mirror.model === pick.model && mirror.baseUrl === (pick.apiUrl ?? "");

/** One prompt, as personaRephrase.ts and instructionsAI.ts build it. */
export type WritingCall = { instructions: string; input: string; maxTokens: number };

/** Hermes's text, and the route it ran on. */
export type Written = { text: string; route: WritingRoute };

/**
 * Why Hermes couldn't write. `sign-in`: it has no credentials for the route's provider. `no-provider`: it found no
 * provider to run the task on at all. Either only refines the words; the route decides the fix.
 */
export type WritingCause = "sign-in" | "no-provider" | "other";

function causeOf(detail: string): WritingCause {
  if (missingSignIn(detail)) return "sign-in";
  if (/No LLM provider configured for task=/.test(detail)) return "no-provider";
  return "other";
}

/** Hermes ran a writing call and it failed. Carries the route, so the words and the fix come from why this model was chosen. */
export class WritingFailed extends Error {
  constructor(
    readonly profile: string,
    readonly route: WritingRoute,
    readonly cause: WritingCause,
    /** Hermes's own words, without the `one-shot generation failed:` prefix. */
    readonly detail: string,
  ) {
    super(detail);
  }

  /** The setting that changes the outcome: a pin where it lives, everything else at the Writing model. */
  get fix(): "text-model" | "writing-model" {
    switch (this.route.via) {
      case "pin":
        return "text-model";
      case "app":
      case "main":
        return "writing-model";
    }
  }
}

/** What the desk needs from the server. */
export type WritingPort = {
  /** `GET /api/model/auxiliary` and `GET /api/config` for `profile`. */
  facts(profile: string): Promise<WritingFacts>;
  /** `PUT /api/config?profile=` writing the whole `auxiliary.highwing_writing` block. */
  mirror(profile: string, pick: WritingPick): Promise<void>;
  /** `llm.oneshot` with a `task`; rejects with Hermes's `RpcError` untouched. */
  oneshot(o: { profile: string; task: string } & WritingCall): Promise<string>;
};

/** One bot's line in Settings → Model → Writing model. A bot whose models couldn't be read keeps its reason. */
export type BotWriting = { profile: string } & ({ route: WritingRoute } | { unread: string });

/** What the writing screens hold: who writes, where a call would run now, and the call. */
export type Writer = {
  profile: string;
  kind: WritingKind;
  /** Where a call would run now. Writes nothing. */
  route(): Promise<WritingRoute>;
  /** One stateless call. Rejects with `WritingFailed` when Hermes ran and failed; anything else is a transport error. */
  ask(call: WritingCall): Promise<Written>;
};

/** Writing for one connection. `pick`: the app's Writing model for it, read at each call; undefined when not set. */
export class WritingDesk {
  constructor(
    private readonly port: WritingPort,
    private readonly pick: () => WritingPick | undefined,
  ) {}

  writer(profile: string, kind: WritingKind): Writer {
    return {
      profile,
      kind,
      route: async () => writingRoute(await this.port.facts(profile), kind, this.pick()),
      ask: (call) => this.write(profile, kind, call),
    };
  }

  /** Every bot's route for persona writing. One failed read fails only its own bot. */
  async bots(profiles: string[]): Promise<BotWriting[]> {
    const pick = this.pick();
    const read = await Promise.allSettled(profiles.map((p) => this.port.facts(p)));
    return read.map((r, i) =>
      r.status === "fulfilled"
        ? { profile: profiles[i], route: writingRoute(r.value, "persona", pick) }
        : { profile: profiles[i], unread: r.reason instanceof Error ? r.reason.message : String(r.reason) },
    );
  }

  /**
   * Reads fresh, so no cached route can disagree with the server or the setting. The mirror is written only on the
   * `app` route and only when it differs, so a second call writes nothing. A failed write fails the call: Hermes would
   * otherwise run the unset key on the main model while the label named the Writing model.
   */
  private async write(profile: string, kind: WritingKind, call: WritingCall): Promise<Written> {
    const facts = await this.port.facts(profile);
    const pick = this.pick();
    const route = writingRoute(facts, kind, pick);
    if (route.via === "app" && pick && !mirrorIsCurrent(facts.mirror, pick)) await this.port.mirror(profile, pick);
    const text = await this.port.oneshot({ profile, task: taskOf(route), ...call }).catch((e: unknown) => {
      if (!(e instanceof RpcError)) throw e;
      const detail = e.message.replace(/^one-shot generation failed:\s*/, "");
      throw new WritingFailed(profile, route, causeOf(detail), detail);
    });
    return { text, route };
  }
}
