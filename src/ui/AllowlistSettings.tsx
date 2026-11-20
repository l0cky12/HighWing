// Settings → Approvals: the commands Hermes always allows for the profile picked, each with Remove (ADR 0242). Reads and
// writes: allowlist.ts.
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";
import { AppliesBox, AppliesPart, EditingProfile, HeadPart, MetaChip, useInPage } from "./SettingsPage";
import type { AllowlistApi, CommandAllowlist, RemoveOutcome } from "../hermes/allowlist";
import { clockTime, errorText } from "../hermes/values";

type Read = { list: CommandAllowlist; at: number };
type Note = { tone: "muted" | "warn" | "bad"; text: string };

const names = (entries: string[]) => entries.map((e) => `“${e}”`).join(", ");
/** `_persist_choice` also allows the command for the rest of the chat that answered, which no route takes back. */
const ANSWERING_CHAT = "The chat that answered Always allow also allowed it for itself, until Hermes closes that chat.";

/** What a Remove did, in words, for the note under the list. */
export function outcomeNote(entry: string, out: RemoveOutcome): Note {
  switch (out.kind) {
    case "removed":
      return {
        tone: "muted",
        text: `Removed “${entry}”. Hermes asks again the next time a command like it runs. ${ANSWERING_CHAT}${out.writeError ? ` (The write answered “${out.writeError}”, but Hermes reads the list without it.)` : ""}`,
      };
    case "changed":
      return { tone: "warn", text: "Nothing was removed: the list changed on the server since it was shown. This is the list Hermes has now. Remove again if you still want to." };
    case "refused":
      return { tone: "bad", text: `Hermes refused to change the list: ${out.why}` };
    case "unknown":
      return { tone: "bad", text: `It isn't known whether “${entry}” was removed: ${out.why}. Read the list again to see what Hermes has.` };
    case "differs": {
      if (out.now.kind !== "list") return { tone: "warn", text: "The list was written, but Hermes now reads it in a form this app can't show." };
      const parts = [
        out.back
          ? `“${entry}” is still in the list: ${out.writeError ? `the write answered “${out.writeError}”.` : "another Hermes client wrote it back."}`
          : `Removed “${entry}”, but the list changed on the server meanwhile.${out.writeError ? ` The write answered “${out.writeError}”.` : ""}`,
        out.added.length ? `Added elsewhere: ${names(out.added)}.` : "",
        out.gone.length ? `Removed elsewhere: ${names(out.gone)}.` : "",
        "This is the list Hermes has now.",
      ];
      return { tone: "warn", text: parts.filter(Boolean).join(" ") };
    }
  }
}

export function AllowlistSettings({
  api,
  profile,
  connected,
  picker,
  inUse,
}: {
  api: AllowlistApi;
  profile: string;
  connected: boolean;
  /** Settings' profile picker (ADR 0118). */
  picker?: ReactNode;
  /** The profile the app is using, when it isn't the one shown. */
  inUse?: string;
}) {
  const inPage = useInPage();
  const [read, setRead] = useState<Read>();
  const [loadError, setLoadError] = useState<string>();
  const [reading, setReading] = useState(false);
  const [removing, setRemoving] = useState<string>();
  const [note, setNote] = useState<Note>();
  const live = useRef(true);
  /** Bumped by each read and each Remove's result: only the latest one's answer is shown. */
  const seq = useRef(0);
  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setReading(true);
    try {
      const list = await api.list(profile);
      if (!live.current || mine !== seq.current) return;
      setRead({ list, at: Date.now() });
      setLoadError(undefined);
    } catch (e) {
      if (live.current && mine === seq.current) setLoadError(errorText(e));
    } finally {
      if (live.current && mine === seq.current) setReading(false);
    }
  }, [api, profile]);
  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  const remove = async (entry: string) => {
    if (read?.list.kind !== "list" || removing) return;
    setRemoving(entry);
    setNote(undefined);
    const out = await api.remove(profile, read.list.entries, entry).catch((e): RemoveOutcome => ({ kind: "unknown", why: errorText(e) }));
    if (!live.current) return;
    // A read still on its way started before this result, so it is older.
    seq.current++;
    setRemoving(undefined);
    setReading(false);
    setNote(outcomeNote(entry, out));
    if ("now" in out && out.now) setRead({ list: out.now, at: Date.now() });
  };

  const reload = (
    <button className="btn" disabled={!connected || reading || !!removing} onClick={() => void load()}>
      <RefreshCw size={14} aria-hidden /> Read again
    </button>
  );
  const how = (
    <>
      <p>
        Hermes keeps this list in the profile's config.yaml on the server, as <span className="mono">command_allowlist</span>. An entry names a kind of command Hermes flags, such
        as “recursive delete”, not one command line. Every chat of the profile uses it, and so does the command line, the TUI and every other Hermes client.
      </p>
      <p>
        An Always allow answer also allows the command for the rest of the chat that gave it. Hermes keeps that grant in memory until it closes the chat, and nothing
        here can take it back. Every other chat asks again from its next command like it.
      </p>
      <p>
        Remove reads the list again just before writing, and writes nothing if it changed since it was shown. Then it reads the list back and says if it isn't what was
        written. Hermes can't make the write conditional, so a change made elsewhere in the moment between that check and the write is undone: an Always allow given
        in another chat is dropped, and Hermes asks again before that command; an entry removed in another client comes back. Read the list again after removing from
        two places at once.
      </p>
    </>
  );
  const applies = "Hermes reads the list before every command it flags, so a removed entry is asked about again from the next one. The chat that gave the Always allow keeps it until Hermes closes that chat.";

  let body: ReactNode;
  if (!read) {
    body = (
      <SettingNote tone={loadError ? "bad" : "muted"} role={loadError ? "alert" : "status"}>
        {loadError ? `Couldn't read the list: ${loadError}` : connected ? "Reading the list from Hermes…" : "Connect to Hermes to see what it always allows."}
      </SettingNote>
    );
  } else if (read.list.kind === "unreadable") {
    body = (
      <SettingNote tone="warn" role="status">
        This profile's <span className="mono">command_allowlist</span> can't be shown here: {read.list.why}. Fix it in the profile's config.yaml on the server.
      </SettingNote>
    );
  } else if (!read.list.entries.length) {
    body = (
      <SettingNote role="status">
        <ShieldCheck size={14} aria-hidden /> Nothing is in this profile's list. Hermes asks before the commands it flags, except in a chat in YOLO and in a chat that
        allowed one for itself with Allow for this chat or Always allow, until Hermes closes that chat.
      </SettingNote>
    );
  } else {
    const list = read.list;
    body = (
      <div role="list" aria-label={`Always allowed in ${profile}`}>
        {[...new Set(list.entries)].map((entry) => (
          <div role="listitem" key={entry}>
            <SettingRow
              name={<span className="mono">{entry}</span>}
              about={entry}
              control={
                <button className="btn" aria-label={`Remove ${entry}`} disabled={!connected || !!removing || reading} onClick={() => void remove(entry)}>
                  {removing === entry ? "Removing…" : "Remove"}
                </button>
              }
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      {inPage && (
        <>
          <HeadPart at="profile">
            <EditingProfile picker={picker ?? <span className="mono">{profile}</span>} inUse={!inUse || inUse === profile} />
          </HeadPart>
          {read && (
            <HeadPart at="meta">
              <MetaChip label="Read" value={clockTime(read.at)} />
            </HeadPart>
          )}
          <HeadPart at="actions">{reload}</HeadPart>
          <HeadPart at="applies">
            <AppliesBox line={applies} more="How Remove works">
              <AppliesPart>{how}</AppliesPart>
            </AppliesBox>
          </HeadPart>
        </>
      )}
      <SettingsSection
        bare={inPage}
        title="Always allowed"
        titleId="allowlist-heading"
        intro="Commands Hermes runs without asking, because an Approval was answered Always allow. Remove one and Hermes asks again."
        more={inPage ? undefined : how}
        action={!inPage && reload}
      >
        {!inPage && <SettingRow name="Profile" control={picker ?? <span className="set-value mono">{profile}</span>} />}
        {body}
        {removing && (
          <SettingNote role="status">
            Removing “{removing}”: checking the list, writing it, then reading it back…
          </SettingNote>
        )}
        {note && (
          <SettingNote tone={note.tone} role={note.tone === "muted" ? "status" : "alert"}>
            {note.text}
          </SettingNote>
        )}
        {read && loadError && (
          <SettingNote tone="bad" role="alert">
            Couldn't read the list again: {loadError}
          </SettingNote>
        )}
      </SettingsSection>
    </>
  );
}
