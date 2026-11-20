// Whether a scheduled job's finished run posts a desktop notification (#28). Kept in the display preferences
// (uiPrefs.ts), on this computer only.
import { useSyncExternalStore } from "react";
import { getUIPrefs, setUIPrefs, subscribe } from "../hermes/uiPrefs";
import { useLocale } from "../i18n/locale";
import { SettingRow, SettingsSection } from "./SettingRows";

export function JobRunSettings() {
  const { jobRunNotices } = useSyncExternalStore(subscribe, getUIPrefs);
  const l = useLocale().settings.jobRuns;
  return (
    <SettingsSection title={l.section}>
      <SettingRow
        name={l.name}
        nameId="job-run-notices-label"
        hint={l.hint}
        more={<p>{l.more}</p>}
        control={
          <button className="switch" role="switch" aria-checked={jobRunNotices} aria-labelledby="job-run-notices-label" onClick={() => setUIPrefs({ jobRunNotices: !jobRunNotices })}>
            <span className="switch-knob" />
          </button>
        }
      />
    </SettingsSection>
  );
}
