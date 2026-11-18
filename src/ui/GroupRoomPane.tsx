import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ArrowUp, Ellipsis, PenLine, Square, Trash2, UsersRound } from "lucide-react";
import type { Bot } from "../hermes/bots";
import type { Floor, Outgoing, RoomApproval, RoomChoice, RoomEntry, Seat } from "../hermes/groupRooms";
import { ROOM_NAME_MAX } from "../hermes/groupRooms";
import type { GroupRoomsStore } from "../hermes/groupRoomsStore";
import type { ApprovalItem } from "../hermes/model";
import { completeMention, goesTo, keyAction, pickerAt, pickerRows, rowHandle, type GoesTo, type Mention, type MentionNote, type PickerRow, type Recipients, type Target } from "../hermes/roomMentions";
import { errorText } from "../hermes/values";
import { useLocale, type Locale } from "../i18n/locale";
import { ApprovalCard } from "./ApprovalCard";
import { BotFace } from "./BotFace";
import { Menu } from "./ChatMenu";
import { seatLook, seatName, seatsShown, useGroupRoom, type SeatShown } from "./GroupRooms";
import { Markdown } from "./Markdown";
import { MenuEntry } from "./ProfileSettings";
import { Spinner, composing } from "./bits";
import { useModal } from "./modal";

type Faces = { bots: readonly Bot[]; pictures: Readonly<Record<string, string>> };

const approvalItem = (a: RoomApproval): ApprovalItem => ({ kind: "approval", id: a.key, requestId: a.key, command: a.command, description: a.description, choices: ["once", "deny"], allowSession: false, allowPermanent: false });

export function GroupRoomPane({ store, roomId, bots, pictures, offline }: { store: GroupRoomsStore; roomId: string; offline: boolean } & Faces) {
  const l = useLocale();
  const w = l.groupRooms.pane;
  const view = useGroupRoom(store, roomId);
  const faces = useMemo(() => ({ bots, pictures }), [bots, pictures]);
  const people = useMemo(() => seatsShown(view?.seats ?? [], bots, pictures), [view?.seats, bots, pictures]);
  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState<string>();
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const [dialog, setDialog] = useState<"rename" | "disband">();
  const more = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);

  const shown = (view?.entries.length ?? 0) + (view?.outgoing.length ?? 0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [shown, view?.floor.kind]);

  const act = (intent: () => Promise<unknown>) => {
    setFailed(undefined);
    intent().catch((e: unknown) => setFailed(errorText(e)));
  };
  const jump = (seq: number) => {
    const row = scroller.current?.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
    row?.scrollIntoView({ block: "center" });
    row?.focus();
  };

  if (!view) {
    return (
      <div className="chat room" data-room-pane={roomId}>
        <p className="room-loading" role="status">
          <Spinner /> {w.loading}
        </p>
      </div>
    );
  }
  const gone = view.floor.kind === "gone";
  const speaking = view.floor.kind === "speaking" ? view.floor.seat.id : undefined;
  return (
    <div className="chat room" data-room-pane={roomId} role="region" aria-label={w.label(view.name)}>
      <header className="chat-head">
        <div className="chat-title">
          <UsersRound size={15} aria-hidden />
          <span translate="no">{view.name}</span>
          <span className="badge">{w.kind}</span>
        </div>
        <ul className="room-seats" aria-label={w.seats}>
          {view.seats.map((s) => (
            <li key={s.id} className={s.id === speaking ? "is-speaking" : undefined} aria-label={seatName(s, bots, s.name)} title={seatName(s, bots, s.name)} data-seat={s.id}>
              <BotFace bot={seatLook(s, bots, pictures)} size="sm" />
            </li>
          ))}
        </ul>
        <div className="chat-head-actions">
          <button
            ref={more}
            className="icon-btn"
            title={w.more}
            aria-label={w.more}
            aria-haspopup="menu"
            disabled={gone}
            onClick={() => {
              const r = more.current!.getBoundingClientRect();
              setMenu({ x: r.right - 160, y: r.bottom + 4 });
            }}
          >
            <Ellipsis size={16} />
          </button>
        </div>
      </header>
      {(view.stale || view.workerDown) && (
        <p className="room-banner" role="status">
          {view.stale ? w.stale : w.workerDown}
        </p>
      )}
      <div
        ref={scroller}
        className="transcript"
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        <div className="transcript-inner room-log" role="log" aria-label={w.transcript}>
          {view.earlier && (
            <button className="btn room-earlier" onClick={() => act(() => store.earlier(roomId))}>
              {w.earlier}
            </button>
          )}
          <Entries entries={view.entries} seats={view.seats} faces={faces} />
          {view.outgoing.map((o) => (
            <OutgoingRow key={o.eventId} message={o} onRetry={() => store.retry(roomId, o.eventId)} onDiscard={() => store.discard(roomId, o.eventId)} />
          ))}
        </div>
      </div>
      <div className="composer-wrap room-foot">
        <FloorStrip
          floor={view.floor}
          faces={faces}
          offline={offline}
          onStop={() => act(() => store.stop(roomId))}
          onContinue={() => act(() => store.continue(roomId))}
          onCarryOn={() => {
            setDraft(store.carryOn(roomId));
            box.current?.focus();
          }}
          onAnswer={(key, choice) => act(() => store.answer(roomId, key, choice))}
          onJump={jump}
        />
        {failed && (
          <p className="field-hint err" role="alert">
            {failed}
          </p>
        )}
        {!gone && (
          <RoomComposer
            box={box}
            seats={people}
            draft={draft}
            onDraft={setDraft}
            steppingIn={view.floor.kind === "speaking" || view.floor.kind === "starting" || view.floor.kind === "approval" || view.floor.kind === "stuck"}
            onSay={(text) => {
              atEnd.current = true;
              store.say(roomId, text);
              setDraft("");
            }}
          />
        )}
      </div>
      {menu && (
        <Menu label={w.more} x={menu.x} y={menu.y} onClose={() => setMenu(undefined)}>
          <MenuEntry
            icon={<PenLine size={15} />}
            label={w.rename}
            why={offline ? l.groupRooms.notConnected : undefined}
            onPick={() => {
              setMenu(undefined);
              setDialog("rename");
            }}
          />
          <MenuEntry
            icon={<Trash2 size={15} />}
            label={w.disband}
            danger
            why={offline ? l.groupRooms.notConnected : undefined}
            onPick={() => {
              setMenu(undefined);
              setDialog("disband");
            }}
          />
        </Menu>
      )}
      {dialog && (
        <RoomDialog
          kind={dialog}
          name={view.name}
          returnTo={more}
          onClose={() => setDialog(undefined)}
          onDone={(name) => (dialog === "rename" ? store.rename(roomId, name) : store.disband(roomId))}
        />
      )}
    </div>
  );
}

function Entries({ entries, seats, faces }: { entries: readonly RoomEntry[]; seats: readonly Seat[]; faces: Faces }) {
  const w = useLocale().groupRooms.pane;
  const rows: ReactNode[] = [];
  let round = 0;
  for (const e of entries) {
    if (e.kind === "owner") round = 0;
    if (e.kind === "reply" && e.round > round) {
      round = e.round;
      rows.push(
        <div key={`round-${e.seq}`} className="room-round" role="separator" data-round={round + 1}>
          {w.round(round + 1)}
        </div>,
      );
    }
    rows.push(<EntryRow key={e.seq} entry={e} seats={seats} faces={faces} />);
  }
  return <>{rows}</>;
}

function EntryRow({ entry: e, seats, faces }: { entry: RoomEntry; seats: readonly Seat[]; faces: Faces }) {
  const w = useLocale().groupRooms.pane;
  const seat = "seat" in e ? seats.find((s) => s.id === e.seat) : undefined;
  const name = seat ? seatName(seat, faces.bots, seat.name) : undefined;
  const note = (text: string, tone?: "bad") => (
    <p className={`room-note${tone ? ` is-${tone}` : ""}`} data-seq={e.seq} data-entry={e.kind}>
      {text}
    </p>
  );
  switch (e.kind) {
    case "owner":
      return (
        <div className="msg user" data-seq={e.seq} data-entry="owner">
          <div className="bubble-text">{e.text}</div>
        </div>
      );
    case "reply":
      return (
        <article className="room-reply" data-seq={e.seq} data-seat={e.seat} data-entry="reply" tabIndex={-1} aria-label={name}>
          {seat ? <BotFace bot={seatLook(seat, faces.bots, faces.pictures)} size="sm" /> : <span className="bots-face is-sm" aria-hidden />}
          <div className="room-reply-body">
            <div className="room-reply-name" translate="no">
              {name ?? e.seat}
            </div>
            <div className="msg assistant">
              <Markdown text={e.text} />
            </div>
          </div>
        </article>
      );
    case "passed":
      return note(w.passed(name ?? e.seat));
    case "failed":
      return note(w.failed(name ?? e.seat, e.error), "bad");
    case "cancelled":
      if (e.why === "stopped") return note(w.stopped);
      if (e.why === "steppedIn") return note(name ? w.steppedIn(name) : w.steppedInAny);
      return note(name ? w.cancelled(name) : w.cancelledAny);
    case "unavailable":
      return note(w.unavailable(e.error), "bad");
    case "pause":
      return note(e.reason === "messages" ? w.pausedMessages : w.paused(e.rounds));
    case "continued":
      return note(w.continued);
    case "renamed":
      return note(w.renamed(e.name));
  }
}

function OutgoingRow({ message: o, onRetry, onDiscard }: { message: Outgoing; onRetry: () => void; onDiscard: () => void }) {
  const w = useLocale().groupRooms.pane;
  return (
    <div className={`msg user ${o.state}`} data-entry="outgoing" data-state={o.state}>
      <div className="bubble-text">{o.text}</div>
      {o.state === "sending" ? (
        <span className="room-sending">{w.sending}</span>
      ) : (
        <span className="room-unsent" role="alert">
          {w.notSent(o.error ?? "")}
          <button className="btn" onClick={onRetry}>
            {w.retry}
          </button>
          <button className="btn" onClick={onDiscard}>
            {w.discard}
          </button>
        </span>
      )}
    </div>
  );
}

function FloorStrip({
  floor,
  faces,
  offline,
  onStop,
  onContinue,
  onCarryOn,
  onAnswer,
  onJump,
}: {
  floor: Floor;
  faces: Faces;
  offline: boolean;
  onStop: () => void;
  onContinue: () => void;
  onCarryOn: () => void;
  onAnswer: (key: string, choice: RoomChoice) => void;
  onJump: (seq: number) => void;
}) {
  const l = useLocale();
  const w = l.groupRooms.strip;
  const name = (seat?: Seat) => seatName(seat, faces.bots, l.groupRooms.floor.aBot);
  const stop = (
    <button className="btn room-stop" disabled={offline} onClick={onStop}>
      <Square size={11} aria-hidden />
      {w.stop}
    </button>
  );
  const asked = (a?: { seat: Seat; seq: number }) =>
    a && (
      <span className="room-asked">
        {w.asked(name(a.seat))}
        <button className="btn" onClick={() => onJump(a.seq)}>
          {w.jump}
        </button>
      </span>
    );
  const body = (): ReactNode => {
    switch (floor.kind) {
      case "gone":
        return <span>{w.gone}</span>;
      case "approval":
        return (
          <div className="room-approval">
            <ApprovalCard item={approvalItem(floor.approval)} offline={offline} heading={w.approvalFor(name(floor.seat))} onAnswer={(c) => (c === "once" || c === "deny") && onAnswer(floor.approval.key, c)} />
            {floor.next.length > 0 && <span className="room-behind">{w.behind(floor.next.map((s) => name(s)))}</span>}
          </div>
        );
      case "speaking":
        return (
          <>
            <span className="room-turn">
              <Spinner />
              {[floor.stopping ? w.stopping(name(floor.seat)) : w.writing(name(floor.seat)), floor.round !== undefined && w.round(floor.round + 1), floor.tool && w.tool(floor.tool), floor.next.length > 0 && w.next(floor.next.map((s) => name(s)).join(", "))]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {stop}
          </>
        );
      case "starting":
        return (
          <>
            <span className="room-turn">
              <Spinner />
              {w.starting}
            </span>
            {stop}
          </>
        );
      case "stuck":
        return (
          <>
            <span className="room-turn is-warn">{floor.why === "clarify" ? w.clarify(name(floor.seat)) : w.held}</span>
            {stop}
          </>
        );
      case "paused":
        return (
          <>
            <span className="room-turn">
              {floor.reason === "messages" ? w.pausedMessages : w.paused(floor.rounds)}
              {!floor.canContinue && ` ${w.sayToCarryOn}`}
            </span>
            {asked(floor.asked)}
            {floor.canContinue ? (
              <button className="btn primary" disabled={offline} onClick={onContinue}>
                {w.continue(floor.continuesLeft ?? 0)}
              </button>
            ) : (
              <button className="btn primary" onClick={onCarryOn}>
                {w.carryOn}
              </button>
            )}
            {stop}
          </>
        );
      case "yours":
        return asked(floor.asked) || (floor.after === "failed" ? <span className="room-turn is-warn">{w.failed}</span> : null);
    }
  };
  const content = body();
  return (
    <div className={`room-strip is-${floor.kind}${content ? "" : " is-empty"}`} role="status" aria-label={w.label} data-floor={floor.kind}>
      {content}
    </div>
  );
}

/** What to say under the composer: not a plain mention, not the word the picker is offering rows for, once for each kind and word. */
function notesShown<S>(mentions: readonly Mention<S>[], pickingAt: number | undefined): readonly MentionNote<S>[] {
  const seen = new Set<string>();
  const notes: MentionNote<S>[] = [];
  for (const m of mentions) {
    const key = `${m.kind}:${m.raw}`;
    if (m.kind === "plain" || m.at === pickingAt || seen.has(key)) continue;
    seen.add(key);
    notes.push(m);
  }
  return notes;
}

const NOTES_SHOWN = 3;

function noteWords(w: Locale["groupRooms"]["goesTo"], n: MentionNote<SeatShown>): string {
  const mention = `@${n.raw}`;
  const who = (t: Target<SeatShown>) => (t.kind === "seat" ? t.seat.name : w.everyone);
  switch (n.kind) {
    case "inCode":
      return w.inCode(mention, who(n.target));
    case "glued":
      return w.glued(n.before, mention);
    case "trailing":
      return w.trailing(mention, who(n.meant), n.tail);
    case "unknown":
      return w.unknown(mention);
  }
}

/**
 * Who the message will go to, worked out the way Hermes will, and what to know about each @ in it. Only who it goes to is
 * a live region: a live region has to be on the page before its text changes to be announced, so it is always mounted,
 * and its text changes only when the answer does. The notes sit outside it, because a note about a name still being
 * typed changes with every key; the composer is described by both.
 */
function GoesToLine({ id, shown, goes, pickingAt }: { id: string; shown: boolean; goes: GoesTo<SeatShown>; pickingAt: number | undefined }) {
  const w = useLocale().groupRooms.goesTo;
  const notes = notesShown(goes.mentions, pickingAt);
  const named = (to: Recipients<SeatShown>) =>
    to.kind === "seats" ? (
      to.seats.map((s, i) => (
        <Fragment key={s.id}>
          {i > 0 && ", "}
          <b translate="no">
            <BotFace bot={s.look} size="xs" />
            {s.name}
          </b>
        </Fragment>
      ))
    ) : (
      <>
        <b>{w.everyone}</b>
        {to.because === "nobodyNamed" && ` ${w.nobodyNamed}`}
      </>
    );
  return (
    <div className="room-goes-to">
      <p id={`${id}-to`} role="status" aria-atomic="true">
        {shown && (
          <>
            {w.label} {named(goes.to)}
          </>
        )}
      </p>
      <div id={`${id}-notes`}>
        {shown && notes.slice(0, NOTES_SHOWN).map((n) => (
          <p key={`${n.kind}:${n.raw}`} className={"target" in n ? "is-routed" : "is-dropped"}>
            {noteWords(w, n)}
          </p>
        ))}
        {shown && notes.length > NOTES_SHOWN && <p className="is-routed">{w.more(notes.length - NOTES_SHOWN)}</p>}
      </div>
    </div>
  );
}

const rowId = (listId: string, row: PickerRow<SeatShown>) => `${listId}-${rowHandle(row)}`;

function RoomComposer({
  box,
  seats,
  draft,
  onDraft,
  steppingIn,
  onSay,
}: {
  box: RefObject<HTMLTextAreaElement | null>;
  seats: readonly SeatShown[];
  draft: string;
  onDraft: (text: string) => void;
  steppingIn: boolean;
  onSay: (text: string) => void;
}) {
  const w = useLocale().groupRooms.composer;
  const listId = useId();
  const goesToId = useId();
  const [caret, setCaret] = useState(0);
  const [at, setAt] = useState(0);
  const [closed, setClosed] = useState(false);
  const typing = closed ? undefined : pickerAt(draft, caret);
  const rows = typing ? pickerRows(typing.query, seats, w.everyone) : [];
  const picked = Math.min(at, Math.max(0, rows.length - 1));
  const goes = useMemo(() => goesTo(draft, seats), [draft, seats]);

  const caretAfter = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    if (caretAfter.current !== undefined) el.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = undefined;
  }, [draft, box]);
  const complete = (row: PickerRow<SeatShown>) => {
    if (!typing) return;
    const next = completeMention(draft, caret, typing, row);
    caretAfter.current = next.caret;
    onDraft(next.text);
    setCaret(next.caret);
  };
  const send = () => {
    const text = draft.trim();
    if (text) onSay(text);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = keyAction({ key: e.key, shift: e.shiftKey, composing: composing(e), pickerOpen: rows.length > 0 });
    if (action === "none") return;
    e.preventDefault();
    switch (action) {
      case "next":
        return setAt((picked + 1) % rows.length);
      case "prev":
        return setAt((picked + rows.length - 1) % rows.length);
      case "pick":
        return complete(rows[picked]);
      case "close":
        return setClosed(true);
      case "send":
        return send();
    }
  };

  return (
    <>
      <div className="composer room-composer">
        {rows.length > 0 && (
          <ul id={listId} className="menu room-handles" role="listbox" aria-label={w.handles}>
            {rows.map((row, i) => (
              <li
                key={rowHandle(row)}
                id={rowId(listId, row)}
                role="option"
                aria-selected={i === picked}
                className={`menu-item${i === picked ? " is-on" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  complete(row);
                }}
              >
                {row.kind === "seat" ? (
                  <BotFace bot={row.seat.look} size="xs" />
                ) : (
                  <span className="room-handle-all" aria-hidden>
                    <UsersRound size={14} />
                  </span>
                )}
                <span className="room-handle-name" translate={row.kind === "seat" ? "no" : undefined}>
                  {row.kind === "seat" ? row.seat.name : w.everyone}
                </span>
                <span className="room-handle-at muted" translate="no">
                  @{rowHandle(row)}
                </span>
                <span className="room-handle-about" translate={row.kind === "seat" ? "no" : undefined}>
                  {row.kind === "seat" ? row.seat.description : w.everyoneAbout}
                </span>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={box}
          rows={1}
          value={draft}
          aria-label={w.label}
          aria-controls={rows.length ? listId : undefined}
          aria-expanded={rows.length > 0}
          aria-activedescendant={rows.length ? rowId(listId, rows[picked]) : undefined}
          aria-describedby={draft.trim() ? `${goesToId}-to ${goesToId}-notes` : undefined}
          role="combobox"
          aria-autocomplete="list"
          placeholder={steppingIn ? w.stepIn : w.placeholder}
          onChange={(e) => {
            onDraft(e.target.value);
            setCaret(e.target.selectionStart);
            setClosed(false);
            setAt(0);
          }}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-bar">
          <span className="composer-keys" />
          <button className="send" title={w.send} aria-label={w.send} disabled={!draft.trim()} onClick={send}>
            <ArrowUp size={16} />
          </button>
        </div>
      </div>
      <GoesToLine id={goesToId} shown={draft.trim() !== ""} goes={goes} pickingAt={rows.length ? typing?.from : undefined} />
    </>
  );
}

function RoomDialog({ kind, name, returnTo, onClose, onDone }: { kind: "rename" | "disband"; name: string; returnTo: RefObject<HTMLElement | null>; onClose: () => void; onDone: (name: string) => Promise<unknown> }) {
  const w = useLocale().groupRooms.pane;
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  const titleId = useId();
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const ready = kind === "disband" || (value.trim() !== "" && value.trim() !== name);
  const go = () => {
    if (!ready || busy) return;
    setBusy(true);
    onDone(value.trim()).then(onClose, (e: unknown) => {
      setFailed(errorText(e));
      setBusy(false);
    });
  };
  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div
        ref={box}
        className="leave-dialog room-dialog"
        role={kind === "disband" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && !composing(e) && !busy) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          {kind === "rename" ? w.renameTitle : w.disbandTitle(name)}
        </h2>
        {kind === "rename" ? (
          <label className="room-name">
            <input autoFocus value={value} maxLength={ROOM_NAME_MAX} aria-labelledby={titleId} disabled={busy} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !composing(e) && go()} />
          </label>
        ) : (
          <p>{w.disbandBody}</p>
        )}
        {failed && (
          <p className="field-hint err" role="alert">
            {failed}
          </p>
        )}
        <div className="confirm-actions">
          <button className="btn" autoFocus={kind === "disband"} disabled={busy} onClick={onClose}>
            {w.cancel}
          </button>
          <button className={`btn ${kind === "disband" ? "danger" : "primary"}`} disabled={!ready || busy} onClick={go}>
            {kind === "rename" ? w.save : w.disbandGo}
          </button>
        </div>
      </div>
    </div>
  );
}
