import { PROFILE_ROUTES, type ProfileFailure } from "../hermes/profiles";
import type { Locale } from "../i18n/locale";

/** The words for a failed profile call. */
export function failureText(l: Locale, f: ProfileFailure, name: string): string {
  const w = l.profiles;
  switch (f.kind) {
    case "noRoute":
      return w.noRoute(PROFILE_ROUTES[f.action]);
    case "gone":
      return w.form.gone(name);
    case "refused":
      return f.detail ? w.form.refused(f.detail) : w.form.refusedNoReason;
    case "lost":
      return w.form.lost(f.message);
    case "unsent":
      return f.message;
    case "contended":
      return w.form.contended;
    case "noCheck":
      return w.form.noCheck;
    case "pictureUnconfirmed":
      return w.form.pictureUnconfirmed;
  }
}
