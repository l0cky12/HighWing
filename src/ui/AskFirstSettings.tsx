// Whether Highwing tells a bot, in each message sent in a Bot Chat, to ask before it messages another bot (ADR 0229).
// Kept in the display preferences (uiPrefs.ts), on this computer only.
import { useSyncExternalStore } from "react";
import { getUIPrefs, setUIPrefs, subscribe } from "../hermes/uiPrefs";
import { useLocale } from "../i18n/locale";
import { SettingRow, SettingsSection } from "./SettingRows";

export function AskFirstSettings() {
  const { askFirst } = useSyncExternalStore(subscribe, getUIPrefs);
  const l = useLocale().bots.askFirst;
  return (
    <SettingsSection title={l.section}>
      <SettingRow
        name={l.name}
        nameId="ask-first-label"
        hint={l.hint}
        more={<p>{l.more}</p>}
        control={
          <button className="switch" role="switch" aria-checked={askFirst} aria-labelledby="ask-first-label" onClick={() => setUIPrefs({ askFirst: !askFirst })}>
            <span className="switch-knob" />
          </button>
        }
      />
    </SettingsSection>
  );
}
