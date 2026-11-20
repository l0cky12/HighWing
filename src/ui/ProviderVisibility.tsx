// Settings → Providers → Model lists (ADR 0235): a switch per model provider that hides its models from every model
// list in Highwing, or shows them again. It is this computer's display preference for the connection: Hermes keeps the
// provider, its keys and sign-ins, and whatever is already set to one of its models.
import { useContext, useEffect, useId, useState, useSyncExternalStore } from "react";
import type { CatalogProvider } from "../hermes/modelSettings";
import { getUIPrefs, hiddenProvidersOf, setProviderHidden, subscribe } from "../hermes/uiPrefs";
import { errorText } from "../hermes/values";
import { ModelListScope } from "./modelLists";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";

type Listed = { kind: "reading" } | { kind: "read"; providers: CatalogProvider[] } | { kind: "failed"; why: string };

export function ProviderVisibility({ catalog, connected }: { catalog: () => Promise<CatalogProvider[]>; connected: boolean }) {
  const scope = useContext(ModelListScope);
  const hidden = hiddenProvidersOf(useSyncExternalStore(subscribe, getUIPrefs), scope);
  const [listed, setListed] = useState<Listed>({ kind: "reading" });
  const [unsaved, setUnsaved] = useState(false);
  const id = useId();

  useEffect(() => {
    if (!connected) return;
    let live = true;
    setListed({ kind: "reading" });
    catalog().then(
      (providers) => live && setListed({ kind: "read", providers }),
      (e: unknown) => live && setListed({ kind: "failed", why: errorText(e) }),
    );
    return () => {
      live = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per connection; `catalog` is a new function each render
  }, [connected]);

  if (scope === undefined) return null;
  const providers = listed.kind === "read" ? listed.providers : [];
  // A hidden provider Hermes no longer lists stays here, so it can be shown again.
  const rows = [
    ...providers.map((p) => ({ slug: p.slug, name: p.name, models: p.models.length })),
    ...[...hidden].filter((slug) => !providers.some((p) => p.slug === slug)).map((slug) => ({ slug, name: slug, models: undefined })),
  ];
  const everyHidden = providers.length > 0 && providers.every((p) => hidden.has(p.slug));

  return (
    <SettingsSection
      title="Model lists"
      titleId={`${id}-title`}
      intro="Hide the providers you don't use from Highwing's model lists. Only what Highwing offers changes: Hermes keeps each provider, its keys and sign-ins, and what's already set to its models."
      more={
        <p>
          Kept on this computer for this connection. A hidden provider's models leave the composer's model list and Compare, /model, Settings → Model, the Writing
          model, project defaults, bot and profile forms, and Bot setup, Favorites included. A chat, project or setting already on one of its models keeps it and
          says so. A provider Hermes lists for the first time shows until you hide it.
        </p>
      }
    >
      {listed.kind === "reading" && connected && <SettingNote role="status">Reading the providers Hermes lists…</SettingNote>}
      {!connected && <SettingNote>Connect to Hermes to see the providers it lists.</SettingNote>}
      {listed.kind === "failed" && <SettingNote tone="bad" role="alert">{`Couldn't read the providers Hermes lists: ${listed.why}`}</SettingNote>}
      {listed.kind === "read" && !rows.length && <SettingNote>Hermes lists no model providers for this profile.</SettingNote>}
      {rows.map((r) => {
        const shown = !hidden.has(r.slug);
        const nameId = `${id}-${r.slug}`;
        return (
          <SettingRow
            key={r.slug}
            name={r.name}
            nameId={nameId}
            hint={
              <>
                <span className="mono">{r.slug}</span>
                {r.models === undefined ? " · Hermes doesn't list it now" : ` · ${r.models} ${r.models === 1 ? "model" : "models"}`}
                {shown ? "" : " · hidden"}
              </>
            }
            control={
              <button
                className="switch"
                role="switch"
                aria-checked={shown}
                aria-labelledby={nameId}
                aria-description={`Shows ${r.name}'s models in Highwing's model lists`}
                onClick={() => setUnsaved(!setProviderHidden(scope, r.slug, shown))}
              >
                <span className="switch-knob" />
              </button>
            }
          />
        );
      })}
      {everyHidden && (
        <SettingNote tone="warn" role="status">
          Every provider is hidden, so the model lists offer no models. What's already set keeps its model. Turn a provider back on to pick again.
        </SettingNote>
      )}
      {unsaved && (
        <SettingNote tone="bad" role="alert">
          Couldn't keep this on this computer. It holds until Highwing closes.
        </SettingNote>
      )}
    </SettingsSection>
  );
}
