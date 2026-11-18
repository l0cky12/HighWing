// Whether the side panel's Screen opens by itself when Hermes starts using its Bot Desktop (ADR 0213). Kept in the
// display preferences (uiPrefs.ts), on this computer only.
import { useSyncExternalStore } from "react";
import { getUIPrefs, setUIPrefs, subscribe } from "../hermes/uiPrefs";
import { useLocale } from "../i18n/locale";
import { SettingRow, SettingsSection } from "./SettingRows";

export function FollowScreenSettings() {
  const { followScreen } = useSyncExternalStore(subscribe, getUIPrefs);
  const l = useLocale().chat.computerUse.follow;
  return (
    <SettingsSection title={l.section}>
      <SettingRow
        name={l.name}
        nameId="follow-screen-label"
        hint={l.hint}
        more={<p>{l.more}</p>}
        control={
          <button className="switch" role="switch" aria-checked={followScreen} aria-labelledby="follow-screen-label" onClick={() => setUIPrefs({ followScreen: !followScreen })}>
            <span className="switch-knob" />
          </button>
        }
      />
    </SettingsSection>
  );
}
