import { isObj } from "./values";

export type Template = {
  id: string;
  name: string;
  description: string;
  body: string;
  /** Shown only with this project: a project of one connection and profile (projectLinks.ts `projectScope`). */
  project?: { scope: string; id: string; name: string };
};

const NAME_MAX = 80;
const DESCRIPTION_MAX = 300;
const BODY_MAX = 20_000;
/** The most templates kept: they live in localStorage with the other prefs, which a browser caps at a few MB. */
const TEMPLATES_MAX = 300;

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** One kept template, checked; undefined if it isn't one. */
function toTemplate(v: unknown): Template | undefined {
  if (!isObj(v)) return undefined;
  const { id, name, description, body, project } = v;
  if (typeof id !== "string" || !id || id.length > 100) return undefined;
  if (typeof name !== "string" || !name.trim() || name.length > NAME_MAX) return undefined;
  if (typeof body !== "string" || !body.trim() || body.length > BODY_MAX) return undefined;
  const desc = typeof description === "string" && description.length <= DESCRIPTION_MAX ? description : "";
  const p =
    isObj(project) && typeof project.scope === "string" && typeof project.id === "string" && typeof project.name === "string" && project.id
      ? { scope: project.scope, id: project.id, name: project.name }
      : undefined;
  return { id, name: name.trim(), description: desc, body, ...(p && { project: p }) };
}

/** The templates kept in the prefs, checked: one per id and name, at most TEMPLATES_MAX. Not a list: undefined. */
export function toTemplates(v: unknown): Template[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Template[] = [];
  for (const raw of v) {
    const t = toTemplate(raw);
    if (t && out.length < TEMPLATES_MAX && !out.some((o) => o.id === t.id || sameName(o.name, t.name))) out.push(t);
  }
  return out;
}

export const unscope = (list: readonly Template[], scope: string, projectId: string): Template[] =>
  list.map((t) => (t.project?.scope === scope && t.project.id === projectId ? (({ project: _, ...rest }) => rest)(t) : t));
