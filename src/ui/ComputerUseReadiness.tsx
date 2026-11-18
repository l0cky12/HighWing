import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { isReady, type Fix, type Readiness, type Say, type Verdict } from "../hermes/computerUseReadiness";
import { errorText } from "../hermes/values";
import { useLocale, type Locale } from "../i18n/locale";
import { CopyCommand, Spinner } from "./bits";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";

type Check = { kind: "checking" } | { kind: "read"; readiness: Readiness } | { kind: "failed"; why: string };

const BADGE = { ok: "cap-ok", bad: "cap-no", unknown: "cap-unknown" } as const;

function sayText(l: Locale, say: Say): string {
  const s = l.computerUse.say;
  switch (say.kind) {
    case "hermes":
      return say.text;
    case "readFailed":
      return s.readFailed(say.error);
    case "packagesMissing":
      return s.packagesMissing(say.missing);
    case "memory":
      return s.memory(l.fmt.number(say.availableMb), l.fmt.number(say.limitMb));
    case "inSandbox":
      return s.inSandbox(say.backend);
    default:
      return s[say.kind];
  }
}

function FixView({ fix, openToolsets }: { fix: Fix; openToolsets: () => void }) {
  const l = useLocale();
  if (fix.kind === "command") return <CopyCommand command={fix.command} />;
  if (fix.kind === "hint") return <div className="muted small">{sayText(l, fix.say)}</div>;
  return (
    <button className="btn" onClick={openToolsets}>
      {l.computerUse.openToolsets}
    </button>
  );
}

function VerdictRow({ id, verdict, openToolsets }: { id: keyof Locale["computerUse"]["rows"]; verdict: Verdict; openToolsets: () => void }) {
  const l = useLocale();
  const detail = verdict.kind === "ok" && verdict.detail ? <span className="muted"> {sayText(l, verdict.detail)}</span> : undefined;
  return (
    <SettingRow
      className="diag-fact"
      name={l.computerUse.rows[id]}
      control={
        <span className="set-value">
          <span className={`badge cap-badge ${BADGE[verdict.kind]}`}>{l.computerUse.verdict[verdict.kind]}</span>
          {detail}
        </span>
      }
    >
      {verdict.kind === "bad" && (
        <SettingNote tone="warn">
          <div>
            {sayText(l, verdict.why)}
            {verdict.fix && <FixView fix={verdict.fix} openToolsets={openToolsets} />}
          </div>
        </SettingNote>
      )}
      {verdict.kind === "unknown" && <SettingNote>{sayText(l, verdict.why)}</SettingNote>}
    </SettingRow>
  );
}

/**
 * Settings → Diagnostics' Computer use section (ADR 0212): each prerequisite of Hermes's computer_use for the shown
 * profile, green or red with Hermes's own reason. Read when the connection opens or the profile changes, and on Check
 * again, which reads all of it. An answer for an earlier profile is dropped.
 */
export function ComputerUseReadiness({ check, connected, profile, openToolsets }: { check: () => Promise<Readiness>; connected: boolean; profile: string; openToolsets: () => void }) {
  const l = useLocale();
  const [state, setState] = useState<Check>();
  const asked = useRef(0);
  const read = useCallback(async () => {
    const ask = ++asked.current;
    setState({ kind: "checking" });
    let next: Check;
    try {
      next = { kind: "read", readiness: await check() };
    } catch (e) {
      next = { kind: "failed", why: errorText(e) };
    }
    if (ask === asked.current) setState(next);
  }, [check]);
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    if (connected) void readRef.current();
    else {
      asked.current++;
      setState((c) => (c?.kind === "checking" ? undefined : c));
    }
  }, [connected, profile]);

  const readiness = state?.kind === "read" ? state.readiness : undefined;
  const flagged = readiness?.filter((c) => c.verdict.kind === "bad").length ?? 0;
  const unsure = readiness?.some((c) => c.verdict.kind === "unknown");
  let summary: ReactNode;
  if (!state) summary = <span className="muted">{connected ? l.computerUse.notChecked : l.computerUse.connect}</span>;
  else if (state.kind === "checking")
    summary = (
      <>
        <Spinner /> {l.computerUse.checking}
      </>
    );
  else if (state.kind === "failed") summary = <span className="muted">{l.computerUse.say.readFailed(state.why)}</span>;
  else if (readiness && isReady(readiness)) summary = <span className="badge cap-badge cap-ok">{l.computerUse.ready}</span>;
  else summary = <span>{[flagged && l.computerUse.notReady(flagged), unsure && l.computerUse.unsure].filter(Boolean).join(" ")}</span>;

  return (
    <SettingsSection
      title={l.computerUse.title}
      titleId="diag-computer-use"
      intro={
        <>
          <span role="status">{summary}</span> {l.computerUse.intro(profile)}
        </>
      }
      action={
        <button className="btn" aria-label={l.computerUse.checkAgainLabel} disabled={!connected || state?.kind === "checking"} onClick={() => void read()}>
          <RefreshCw size={14} aria-hidden /> {l.computerUse.checkAgain}
        </button>
      }
    >
      {readiness?.map((c) => <VerdictRow key={c.id} id={c.id} verdict={c.verdict} openToolsets={openToolsets} />)}
    </SettingsSection>
  );
}
