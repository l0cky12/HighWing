import { useEffect, useSyncExternalStore } from "react";
import { Loader, ShieldAlert, UsersRound } from "lucide-react";
import type { Bot } from "../hermes/bots";
import { FLOOR_SURFACE, type Floor, type RoomSummary, type RoomView, type Seat } from "../hermes/groupRooms";
import type { GroupRoomsStore } from "../hermes/groupRoomsStore";
import type { Locale } from "../i18n/locale";
import { useLocale } from "../i18n/locale";
import { BotFace, type BotLookShown } from "./BotFace";

const NO_SUBSCRIBE = () => () => {};
const NO_ROOMS = () => undefined;

export function useGroupRooms(store: GroupRoomsStore, on: boolean): readonly RoomSummary[] | undefined {
  return useSyncExternalStore(on ? store.subscribe : NO_SUBSCRIBE, on ? store.list : NO_ROOMS);
}

export function useGroupRoom(store: GroupRoomsStore, id: string): RoomView | undefined {
  useEffect(() => store.watch(id), [store, id]);
  return useSyncExternalStore(store.subscribe, () => store.room(id));
}

export const seatLook = (seat: Seat, bots: readonly Bot[], pictures: Readonly<Record<string, string>>): BotLookShown => {
  const bot = bots.find((b) => b.profile === seat.profile);
  return { name: bot?.name ?? seat.name, color: bot?.color, picture: pictures[seat.profile] };
};

export const seatName = (seat: Seat | undefined, bots: readonly Bot[], fallback: string): string => (seat ? (bots.find((b) => b.profile === seat.profile)?.name ?? seat.name) : fallback);

export type SeatShown = Seat & { readonly look: BotLookShown; readonly description: string };

export const seatsShown = (seats: readonly Seat[], bots: readonly Bot[], pictures: Readonly<Record<string, string>>): readonly SeatShown[] =>
  seats.map((seat) => ({ ...seat, name: seatName(seat, bots, seat.name), look: seatLook(seat, bots, pictures), description: bots.find((b) => b.profile === seat.profile)?.description ?? "" }));

export function floorWords(l: Locale, floor: Floor | undefined, bots: readonly Bot[]): string {
  const w = l.groupRooms.floor;
  const name = (seat?: Seat) => seatName(seat, bots, w.aBot);
  if (!floor) return "";
  switch (floor.kind) {
    case "gone":
      return w.gone;
    case "approval":
      return w.approval(name(floor.seat));
    case "speaking":
      return w.speaking(name(floor.seat));
    case "starting":
      return w.starting;
    case "stuck":
      return floor.why === "clarify" ? w.stuckClarify(name(floor.seat)) : w.stuckHeld;
    case "paused":
      return floor.asked ? w.asked(name(floor.asked.seat)) : floor.reason === "messages" ? w.pausedMessages : w.paused(floor.rounds);
    case "yours":
      if (floor.asked) return w.asked(name(floor.asked.seat));
      return { nothing: w.quiet, settled: w.done, stopped: w.stopped, failed: w.failed }[floor.after];
  }
}

export const roomsWaiting = (rooms: readonly RoomSummary[] | undefined): RoomSummary[] => (rooms ?? []).filter((r) => r.attention?.needsOwner);

export function GroupRoomList({
  rooms,
  bots,
  pictures,
  openId,
  onOpen,
}: {
  rooms: readonly RoomSummary[] | undefined;
  bots: readonly Bot[];
  pictures: Readonly<Record<string, string>>;
  openId?: string;
  onOpen: (id: string) => void;
}) {
  const l = useLocale();
  const w = l.groupRooms;
  return (
    <section className="rooms-section" aria-label={w.section} data-rooms>
      <h3 className="rooms-title">
        <UsersRound size={13} aria-hidden />
        {w.section}
      </h3>
      {!rooms ? (
        <p className="empty-hint">{w.reading}</p>
      ) : !rooms.length ? (
        <p className="empty-hint">{w.empty}</p>
      ) : (
        <ul className="inbox-list rooms-list" aria-label={w.section}>
          {rooms.map((r) => {
            const words = floorWords(l, r.floor, bots);
            const surface = r.floor && FLOOR_SURFACE[r.floor.kind];
            const state = r.attention?.needsOwner ? "needs-you" : surface?.busy ? "busy" : "idle";
            const names = w.names(r.seats.map((s) => seatName(s, bots, s.name)));
            return (
              <li key={r.id} data-room={r.id} data-floor={r.floor?.kind} className={`inbox-row rooms-row is-${state}${r.id === openId ? " is-current" : ""}${r.stale ? " is-stale" : ""}`}>
                <button className="bots-open rooms-open" aria-label={w.rowLabel([r.name, w.rowKind, names, words].filter(Boolean))} aria-current={r.id === openId || undefined} onClick={() => onOpen(r.id)}>
                  <span className="rooms-faces" aria-hidden>
                    {r.seats.slice(0, 3).map((s) => (
                      <BotFace key={s.id} bot={seatLook(s, bots, pictures)} size="xs" />
                    ))}
                  </span>
                  <span className="bots-text">
                    <span className="inbox-line">
                      <span className="bots-name" translate="no">
                        {r.name}
                      </span>
                      {state !== "idle" && (
                        <span className={`bots-activity is-${state === "needs-you" ? "needs-you" : "replying"}`}>
                          {state === "needs-you" ? <ShieldAlert size={12} aria-hidden /> : <Loader size={12} aria-hidden />}
                        </span>
                      )}
                    </span>
                    <span className="bots-preview rooms-floor">{words}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function RoomsNeedYou({ rooms, bots, onOpen, onShowBots }: { rooms: readonly RoomSummary[]; bots: readonly Bot[]; onOpen: (id: string) => void; onShowBots: () => void }) {
  const l = useLocale();
  const w = l.groupRooms;
  const [first, ...rest] = rooms;
  if (!first) return null;
  const one = rest.length ? undefined : first;
  return (
    <div className="sb-needs-you-slot" aria-live="polite">
      <button className="sb-needs-you" title={one ? w.openRoom(one.name) : undefined} onClick={() => (one ? onOpen(one.id) : onShowBots())}>
        <UsersRound size={16} aria-hidden />
        <span className="sb-needs-you-text">
          <strong>{one ? w.needsYou(one.name) : w.manyNeedYou(rooms.length)}</strong>
          {one ? <span>{floorWords(l, one.floor, bots)}</span> : <span translate="no">{rooms.map((r) => r.name).join(", ")}</span>}
        </span>
        <ShieldAlert size={14} aria-hidden />
      </button>
    </div>
  );
}
