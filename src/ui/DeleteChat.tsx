// The question before deleting a chat, whichever way it was asked for: the row's trash button, its menu, the Delete
// key on the row, or the open chat's header menu. Cancel has focus, so a stray Enter keeps the chat.
import { useRef, type RefObject } from "react";
import { TriangleAlert } from "lucide-react";
import { composing } from "./bits";
import { useModal } from "./modal";

/** Escape, Cancel or a click outside keeps the chat. Focus goes back to `returnTo`, or to what had it. */
export function DeleteChatDialog({
  title,
  words,
  returnTo,
  onDelete,
  onClose,
}: {
  title: string;
  words?: { title: string; note: string; cancel: string; confirm: string };
  returnTo?: RefObject<HTMLElement | null>;
  onDelete: () => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        className="leave-dialog delete-chat-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-chat-title"
        aria-describedby="delete-chat-note"
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && !composing(e)) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h2 id="delete-chat-title" className="leave-title">
          <TriangleAlert size={14} aria-hidden /> {words?.title ?? `Delete “${title}”?`}
        </h2>
        <p id="delete-chat-note" className="muted">
          {words?.note ?? "This deletes the chat in every Hermes client, on every computer. It can't be undone."}
        </p>
        <div className="confirm-actions">
          <button className="btn" autoFocus onClick={onClose}>
            {words?.cancel ?? "Cancel"}
          </button>
          <button className="btn danger" onClick={onDelete}>
            {words?.confirm ?? "Delete chat"}
          </button>
        </div>
      </div>
    </div>
  );
}
