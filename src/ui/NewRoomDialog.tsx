// New room (ADR 0205): pick 2 to 6 bots for a Group room. The order they are picked in is the order they answer in, so
// each picked bot shows its number. The room's id is made once, when the dialog opens: Create pressed twice, or again
// after a failure, makes one room (`groups.create` is a no-op on a repeated id).
import { useId, useMemo, useRef, useState, type RefObject } from "react";
import type { Bot } from "../hermes/bots";
import { ROOM_NAME_MAX, SEATS_MAX, isDraft, roomDraft, type RoomDraft } from "../hermes/groupRooms";
import { errorText } from "../hermes/values";
import { useLocale } from "../i18n/locale";
import { BotFace, lookShown } from "./BotFace";
import { composing } from "./bits";
import { useModal } from "./modal";

export function NewRoomDialog({
  bots,
  pictures,
  returnTo,
  onCreate,
  onClose,
}: {
  bots: readonly Bot[];
  pictures: Readonly<Record<string, string>>;
  returnTo?: RefObject<HTMLElement | null>;
  /** Resolves once Hermes has the room; the dialog closes then. */
  onCreate: (draft: RoomDraft) => Promise<unknown>;
  onClose: () => void;
}) {
  const l = useLocale();
  const w = l.groupRooms.dialog;
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  const titleId = useId();
  const introId = useId();
  const [roomId] = useState(() => `room-${crypto.randomUUID()}`);
  /** The picked profiles, in the order picked. */
  const [picked, setPicked] = useState<string[]>([]);
  /** The name the owner typed; until they type one, the name is the picked bots'. */
  const [typed, setTyped] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [failed, setFailed] = useState<string>();

  const seated = useMemo(() => picked.flatMap((p) => bots.find((b) => b.profile === p) ?? []), [picked, bots]);
  const name = typed ?? l.groupRooms.names(seated.map((b) => b.name));
  const draft = roomDraft(roomId, name, seated);
  const full = picked.length >= SEATS_MAX;
  // Nothing is wrong with a room nobody has picked for yet.
  const problem = !isDraft(draft) && (picked.length > 0 || typed !== undefined) ? w.problem[draft.problem] : undefined;

  const toggle = (profile: string) => setPicked((now) => (now.includes(profile) ? now.filter((p) => p !== profile) : now.length < SEATS_MAX ? [...now, profile] : now));
  const create = () => {
    if (!isDraft(draft) || creating) return;
    setCreating(true);
    setFailed(undefined);
    onCreate(draft).then(onClose, (e: unknown) => {
      setFailed(w.failed(errorText(e)));
      setCreating(false);
    });
  };

  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && !creating && onClose()}>
      <div
        ref={box}
        className="leave-dialog room-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={introId}
        data-room-dialog
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && !composing(e) && !creating) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          {w.title}
        </h2>
        <p id={introId} className="muted">
          {w.intro}
        </p>
        <fieldset className="room-pick" disabled={creating}>
          <legend>
            {w.bots}
            <span className="room-count" data-room-count>
              {w.count(picked.length, SEATS_MAX)}
            </span>
          </legend>
          <ul>
            {bots.map((b) => {
              const at = picked.indexOf(b.profile);
              const on = at >= 0;
              return (
                <li key={b.profile}>
                  <label className={`room-pick-row${on ? " is-on" : ""}`}>
                    <input type="checkbox" checked={on} disabled={!on && full} aria-label={on ? w.seat(b.name, at + 1) : b.name} onChange={() => toggle(b.profile)} />
                    <BotFace bot={lookShown(b, pictures)} size="sm" />
                    <span className="room-pick-name" translate="no">
                      {b.name}
                    </span>
                    {on && (
                      <span className="room-pick-order" aria-hidden data-seat-order>
                        {at + 1}
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
          {full && <p className="field-hint">{w.full(SEATS_MAX)}</p>}
        </fieldset>
        <label className="room-name">
          <span>{w.name}</span>
          <input value={name} maxLength={ROOM_NAME_MAX} disabled={creating} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !composing(e) && create()} />
        </label>
        <p className="field-hint err" role="alert">
          {failed ?? problem ?? ""}
        </p>
        <div className="confirm-actions">
          <button className="btn" disabled={creating} onClick={onClose}>
            {w.cancel}
          </button>
          <button className="btn primary" disabled={!isDraft(draft) || creating} onClick={create}>
            {creating ? w.creating : w.create}
          </button>
        </div>
      </div>
    </div>
  );
}
