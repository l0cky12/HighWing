// Settings → Model → Writing model (ADR 0203): the model that writes personas and project instructions for every bot
// with no model pinned on the server, kept on this computer for the connection, and which model each bot writes with.
// Picking one writes nothing to Hermes; a bot's config gets its copy at that bot's next writing call (writingModel.ts).
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { RotateCcw } from "lucide-react";
import { WRITING_TASK, type CatalogProvider } from "../hermes/modelSettings";
import { getUIPrefs, setUIPrefs, subscribe } from "../hermes/uiPrefs";
import { errorText } from "../hermes/values";
import type { BotWriting, WritingDesk, WritingPick } from "../hermes/writingModel";
import { useLocale } from "../i18n/locale";
import { ModelSelect, ProviderSelect } from "./ModelSettings";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";
import { modelName } from "./writingWords";

type Bots = { kind: "reading" } | { kind: "read"; bots: BotWriting[] } | { kind: "failed"; why: string };

export function WritingModelSettings({
  desk,
  scope,
  profiles,
  catalog,
  show,
  reread,
}: {
  /** Undefined while not connected: the saved pick still shows, and the bot list says it needs a connection. */
  desk?: WritingDesk;
  /** `connectionScope` of the connection: where the pick is kept. */
  scope: string;
  profiles: () => Promise<string[]>;
  catalog: () => Promise<CatalogProvider[]>;
  /** Set anew to scroll here and focus the heading. */
  show?: object;
  /** Changes after Settings → Model wrote to Hermes, so a pin set or cleared there shows in the bot list. */
  reread?: number;
}) {
  const l = useLocale();
  const w = l.writing.settings;
  const titleId = useId();
  const saved: WritingPick | undefined = useSyncExternalStore(subscribe, getUIPrefs).writingModels[scope];
  const [provider, setProvider] = useState(saved?.provider ?? "");
  const [providers, setProviders] = useState<CatalogProvider[]>([]);
  const [unsaved, setUnsaved] = useState(false);
  const [bots, setBots] = useState<Bots>({ kind: "reading" });

  useEffect(() => setProvider(saved?.provider ?? ""), [saved?.provider]);

  useEffect(() => {
    const heading = show && document.getElementById(titleId);
    if (!heading) return;
    heading.tabIndex = -1;
    heading.scrollIntoView({ block: "start" });
    heading.focus({ preventScroll: true });
  }, [show, titleId]);

  useEffect(() => {
    if (!desk) return;
    let live = true;
    catalog().then((c) => live && setProviders(c), () => {});
    return () => {
      live = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per connection; `catalog` is a new function each render
  }, [desk]);

  useEffect(() => {
    if (!desk) return;
    let live = true;
    setBots({ kind: "reading" });
    profiles()
      .then((names) => desk.bots(names))
      .then(
        (read) => live && setBots({ kind: "read", bots: read }),
        (e: unknown) => live && setBots({ kind: "failed", why: errorText(e) }),
      );
    return () => {
      live = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read again per connection, per pick and after a Model write; `profiles` may be a new function each render
  }, [desk, saved?.provider, saved?.model, reread]);

  const keep = (next: WritingPick | undefined) => {
    const all = { ...getUIPrefs().writingModels };
    if (next) all[scope] = next;
    else delete all[scope];
    setUnsaved(!setUIPrefs({ writingModels: all }));
  };
  const pickModel = (model: string) => {
    if (!provider || !model) return;
    const apiUrl = providers.find((p) => p.slug === provider)?.apiUrl;
    keep({ provider, model, ...(apiUrl && { apiUrl }) });
  };

  return (
    <SettingsSection title={w.title} titleId={titleId} intro={w.intro}>
      <div className="text-gen" role="group" aria-label={w.name}>
        <SettingRow
          name={w.name}
          hint={saved ? modelName(l.writing, saved) : w.hint}
          more={<p>{w.more(`auxiliary.${WRITING_TASK}`)}</p>}
          control={
            <>
              {saved && (
                <button className="icon-btn small-icon" title={w.clear} aria-label={w.clear} onClick={() => keep(undefined)}>
                  <RotateCcw size={13} />
                </button>
              )}
              <fieldset className="text-gen-controls writing-model-controls" disabled={!desk}>
                <ProviderSelect label={`${w.name}: provider`} value={provider} providers={providers} onChange={setProvider} />
                <ModelSelect
                  label={`${w.name}: model`}
                  value={provider === saved?.provider ? saved.model : ""}
                  provider={provider}
                  providers={providers}
                  onChange={pickModel}
                />
              </fieldset>
            </>
          }
        >
          {unsaved && (
            <div className="sign-in-error" role="alert">
              {w.saveFailed}
            </div>
          )}
        </SettingRow>
      </div>
      <SettingRow name={w.bots} hint={!desk ? w.botsDisconnected : bots.kind === "reading" ? w.botsLoading : bots.kind === "failed" ? w.botsFailed(bots.why) : undefined}>
        {desk && bots.kind === "read" && (
          <ul className="writing-bots" aria-label={w.bots}>
            {bots.bots.map((b) => (
              <li key={b.profile}>
                <span className="mono" translate="no">
                  {b.profile}
                </span>{" "}
                <span className="muted">{botLine(l.writing, b)}</span>
              </li>
            ))}
          </ul>
        )}
      </SettingRow>
      <SettingNote>{w.descriptions}</SettingNote>
    </SettingsSection>
  );
}

function botLine(words: ReturnType<typeof useLocale>["writing"], b: BotWriting): string {
  const w = words.settings;
  if ("unread" in b) return w.botUnread(b.unread);
  const { route } = b;
  switch (route.via) {
    case "pin":
      return w.pinned(modelName(words, route));
    case "app":
      return w.usesApp;
    case "main":
      return route.provider ? w.ownModel(modelName(words, route)) : w.noModel;
  }
}
