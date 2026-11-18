// The chat list's sections, in the order shown (ADR 0063): the list's scroll, then Archived, the drawer at its foot
// (ADR 0090, ADR 0201, ADR 0202). Their own module, so the display preferences (uiPrefs.ts)
// and the sorting that fills them (snooze.ts) can both name them.

export const SECTION_KEYS = ["pinned", "inbox", "snoozed", "working", "archived"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_LABEL: Readonly<Record<SectionKey, string>> = {
  pinned: "Pinned",
  inbox: "Inbox",
  working: "Working",
  snoozed: "Snoozed",
  archived: "Archived",
};
