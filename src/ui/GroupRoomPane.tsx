import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ArrowUp, Ellipsis, PenLine, Square, Trash2, UsersRound } from "lucide-react";
import type { Bot } from "../hermes/bots";
import type { Floor, Outgoing, RoomApproval, RoomChoice, RoomEntry, Seat } from "../hermes/groupRooms";
import { ROOM_NAME_MAX } from "../hermes/groupRooms";
import type { GroupRoomsStore } from "../hermes/groupRoomsStore";
import type { ApprovalItem } from "../hermes/model";
import { errorText } from "../hermes/values";
import { useLocale } from "../i18n/locale";
import { ApprovalCard } from "./ApprovalCard";
import { BotFace } from "./BotFace";
import { Menu } from "./ChatMenu";
import { seatLook, seatName, useGroupRoom } from "./GroupRooms";
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
            seats={view.seats}
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

function mentionAt(text: string, caret: number): { from: number; typed: string } | undefined {
  const m = /(^|\s)@([A-Za-z0-9._:-]*)$/.exec(text.slice(0, caret));
  return m ? { from: caret - m[2].length - 1, typed: m[2].toLowerCase() } : undefined;
}

function RoomComposer({
  box,
  seats,
  draft,
  onDraft,
  steppingIn,
  onSay,
}: {
  box: RefObject<HTMLTextAreaElement | null>;
  seats: readonly Seat[];
  draft: string;
  onDraft: (text: string) => void;
  steppingIn: boolean;
  onSay: (text: string) => void;
}) {
  const w = useLocale().groupRooms.composer;
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [at, setAt] = useState(0);
  const [closed, setClosed] = useState(false);
  const mention = closed ? undefined : mentionAt(draft, caret);
  const options = useMemo(() => {
    if (!mention) return [];
    const all = [...seats.map((s) => ({ handle: s.handle, name: s.name })), { handle: "all", name: w.everyone }];
    return all.filter((o) => o.handle.toLowerCase().startsWith(mention.typed) || o.name.toLowerCase().startsWith(mention.typed));
  }, [mention, seats, w.everyone]);
  const picked = Math.min(at, Math.max(0, options.length - 1));

  const caretAfter = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    if (caretAfter.current !== undefined) el.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = undefined;
  }, [draft, box]);
  const complete = (handle: string) => {
    if (!mention) return;
    const next = `${draft.slice(0, mention.from)}@${handle} ${draft.slice(caret)}`;
    const to = mention.from + handle.length + 2;
    caretAfter.current = to;
    onDraft(next);
    setCaret(to);
  };
  const send = () => {
    const text = draft.trim();
    if (text) onSay(text);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing(e)) return;
    if (options.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        return setAt((picked + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        return complete(options[picked].handle);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        return setClosed(true);
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="composer room-composer">
      {options.length > 0 && (
        <ul id={listId} className="menu room-handles" role="listbox" aria-label={w.handles}>
          {options.map((o, i) => (
            <li
              key={o.handle}
              role="option"
              aria-selected={i === picked}
              className={`menu-item${i === picked ? " is-on" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                complete(o.handle);
              }}
            >
              <span translate="no">@{o.handle}</span>
              {o.name.toLowerCase() !== o.handle.toLowerCase() && <span className="muted">{o.name}</span>}
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={box}
        rows={1}
        value={draft}
        aria-label={w.label}
        aria-controls={options.length ? listId : undefined}
        aria-expanded={options.length > 0}
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
