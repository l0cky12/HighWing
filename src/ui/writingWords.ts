// The words for which model writes a persona or project instructions, and why it failed, from the route it took
// (writingModel.ts, ADR 0209).
import { shortName } from "../hermes/models";
import { hermesCommand, missingSignIn } from "../hermes/transport";
import type { WritingFailed, WritingRoute } from "../hermes/writingModel";
import type { Catalogue } from "../i18n/locale";

type Words = Catalogue["writing"];

export const modelName = (w: Words, r: { provider: string; model: string }) => `${r.provider ? `${r.provider} · ` : ""}${shortName(r.model) || w.defaultModel}`;

/** Before a call: which model would write, and why that one. */
export function willWrite(w: Words, profile: string, route: WritingRoute): string {
  const model = modelName(w, route);
  switch (route.via) {
    case "pin":
      return route.pin === "text" ? w.willPinText(model, profile) : w.willPinInstructions(model, profile);
    case "app":
      return w.willApp(model);
    case "main":
      return route.provider ? w.willMain(model, profile) : w.noModel(profile);
  }
}

/** Why a writing call failed, and what fixes it. A rate limit or timeout on a chosen model is nobody's setting: Hermes's words. */
export function writingFailedText(w: Words, e: WritingFailed): string {
  const { profile, route, cause, detail } = e;
  const provider = missingSignIn(detail)?.provider || route.provider;
  const fix = provider === "nous" ? w.signInNous(`${hermesCommand(profile)}auth add nous`) : w.signInKey;
  switch (route.via) {
    case "pin":
      if (cause !== "sign-in") return detail;
      return route.pin === "text" ? w.pinTextSignIn(profile, provider, fix) : w.pinInstructionsSignIn(profile, provider, fix);
    case "app":
      return cause === "sign-in" ? w.appSignIn(profile, provider, fix) : detail;
    case "main":
      if (!route.provider) return w.mainNoProvider(profile);
      return cause === "other" ? w.mainOther(profile, modelName(w, route), detail) : w.mainSignIn(profile, modelName(w, route));
  }
}
