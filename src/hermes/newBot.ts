// Making a bot from the name the owner typed (ADR 0231, "Making a bot"). The id is derived from the name the way
// Hermes's own clients derive it, the create carries the profile in use's model and nothing else, and the typed name is
// then written as the bot's name in Bot Mode. The brief's inventory for a new bot is read here too: what Hermes lists
// for the bot and for the other bots it could copy from.
import type { Bot, BotLook } from "./bots";
import { BOT_SETUP_CAPS, type BotSetupInventory } from "./botSetupBrief";
import type { EditResult } from "./fieldMerge";
import type { McpApi } from "./mcp";
import type { ModelCatalog } from "./models";
import { ProfileError, profileIdFor, type Created, type ProfileFailure, type ProfileRow } from "./profiles";
import type { SkillRow } from "./skills";
import type { ToolsetList } from "./toolsets";

/** How the name dialog ended: Create interviews the new bot where Hermes runs Bot setup; Start blank never does. */
export type NewBotHow = "setup" | "blank";

export type NewBotIo = {
  list(): Promise<ProfileRow[]>;
  create(fields: { name: string; provider?: string; model?: string }): Promise<Created>;
  /** Writes `name` as the profile's name in Bot Mode. Absent on a Hermes without Bot Mode. */
  name?: (profile: string, name: string) => Promise<EditResult<BotLook>>;
};

/**
 * A bot just made. `modelError`: Hermes made it without the model it was sent, in Hermes's words. `unnamed`: why its
 * name in Bot Mode wasn't written, so it shows by its id.
 */
export type MadeBot = { profile: string; modelError?: string; unnamed?: ProfileFailure };

/**
 * Where a make stopped once its create had gone out, for the name dialog to carry on from without a second create.
 * `unsure`: the create's answer was lost and no list has shown `profile` since. `unopened`: `profile` is made, but the
 * bots couldn't be read to open it.
 */
export type MakeStop = { at: "unsure" | "unopened"; profile: string; failure: ProfileFailure };

export class MakeStopped extends ProfileError {
  constructor(readonly stop: MakeStop) {
    super(stop.failure);
  }
}

/**
 * Makes a bot named `name`: lists the profiles now, so the id is free, creates the profile, then writes the name in
 * Bot Mode. The model sent is `inUse`'s own, and only when it has one; otherwise Hermes gives the new profile the
 * launch profile's. `made`: a profile a list has shown since its create's answer was lost, which is named without
 * another create. Rejects with `MakeStopped` when the create's answer was lost, else with the create's `ProfileError`.
 */
export async function makeBot(io: NewBotIo, name: string, inUse: string, made?: string): Promise<MadeBot> {
  const typed = name.trim();
  const { profile, modelError } = made === undefined ? await create(io, typed, inUse) : { profile: made };
  const named = await io.name?.(profile, typed);
  const outcome = named?.fields.title;
  return { profile, ...(modelError !== undefined && { modelError }), ...(outcome?.kind === "failed" && { unnamed: outcome.failure }) };
}

async function create(io: NewBotIo, typed: string, inUse: string): Promise<Omit<MadeBot, "unnamed">> {
  const rows = await io.list();
  const profile = profileIdFor(typed, new Set(rows.map((r) => r.name)));
  const own = rows.find((r) => r.name === inUse);
  const made = await io.create({ name: profile, ...(own?.provider && own.model && { provider: own.provider, model: own.model }) }).catch((e: unknown) => {
    throw e instanceof ProfileError && e.failure.kind === "lost" ? new MakeStopped({ at: "unsure", profile, failure: e.failure }) : e;
  });
  // A 200 can still carry `model_error`: Hermes made the profile and refused only the model.
  return { profile, ...(made.answered && !made.modelSet && { modelError: made.modelError ?? "" }) };
}

export type InventoryIo = {
  /** The models the new bot's profile can switch to, when Hermes lists them. */
  models(): Promise<ModelCatalog | undefined>;
  skills(profile: string): Promise<SkillRow[]>;
  toolsets(profile: string): Promise<ToolsetList>;
  /** Absent, or a catalog Hermes doesn't answer: no MCP servers are offered. */
  mcp?: Pick<McpApi, "catalog" | "list">;
};

const settled = <T,>(p: Promise<T>, none: T) => p.catch(() => none);

/**
 * What a new bot's brief offers (ADR 0231): the models its profile lists, its own skills and toolsets, Hermes's MCP
 * catalog, and what the first `BOT_SETUP_CAPS.bots` of `others` have on, MCP servers included. A list Hermes doesn't
 * answer is left empty rather than holding the interview back; without the catalog no MCP server is offered.
 */
export async function newBotInventory(io: InventoryIo, profile: string, others: readonly Bot[]): Promise<BotSetupInventory> {
  const names = <T extends { name: string }>(rows: readonly T[], on?: (r: T) => boolean) => rows.filter((r) => !on || on(r)).map((r) => r.name);
  const mcp = io.mcp;
  const [catalog, skills, toolsets, mcpCatalog, bots] = await Promise.all([
    settled(io.models(), undefined),
    settled(io.skills(profile), []),
    settled(io.toolsets(profile).then((l) => l.toolsets), []),
    mcp ? settled(mcp.catalog(profile).then((c) => names(c.entries)), undefined) : undefined,
    Promise.all(
      others
        .filter((b) => b.profile !== profile)
        .slice(0, BOT_SETUP_CAPS.bots)
        .map(async (b) => {
          const [s, t, m] = await Promise.all([
            settled(io.skills(b.profile), []),
            settled(io.toolsets(b.profile).then((l) => l.toolsets), []),
            mcp && settled(mcp.list(b.profile).then((l) => names(l.servers)), []),
          ]);
          return { name: b.name, description: b.description, skills: names(s, (r) => r.enabled), toolsetsOn: names(t, (r) => r.enabled), ...(m && { mcp: m }) };
        }),
    ),
  ]);
  return {
    models: [...new Set(catalog?.providers.flatMap((p) => p.models.map((m) => m.model)) ?? [])],
    skills: names(skills),
    toolsets: names(toolsets),
    ...(mcpCatalog && { mcpCatalog }),
    bots,
  };
}
