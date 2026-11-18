export type GroupsAnswer = { result: unknown } | { error: { code: number; message: string; data?: unknown } };

export type FakeTurn =
  | { say: string; tool?: string }
  | { pass: true }
  | { fail: string }
  | { approval: { command: string; description: string }; then: string }
  | { clarify: true; then: string };

export type TurnContext = { roomId: string; member: string; name: string; index: number; handles: readonly string[]; round: number; ownerText: string; said: readonly string[] };

type Member = { member_id: string; profile: string; handle: string; display_name?: string; target?: Record<string, unknown> };
type RoomEvent = { room_id: string; seq: number; event_id: string; kind: string; actor: Record<string, unknown>; authority_epoch: number; payload: Record<string, unknown>; created_at: number; idempotent: boolean };
type Discussion = { id: string; thread: string; text: string; round: number; continues: number; messages: number; said: string[]; next: Member[]; status: "running" | "bounded" | "over" };
type Waiting = { kind: "approval"; requestId: string; command: string; description: string; then: string } | { kind: "clarify"; then: string };
type Task = { id: string; discussion: Discussion; member: Member; round: number; status: "queued" | "running"; startedAt?: number; tool?: string; waiting?: Waiting; turn?: FakeTurn };
type Room = { room_id: string; name: string; members: Member[]; created_at: number; updated_at: number; disbanded_at?: number; revision: number; events: RoomEvent[]; tasks: Task[]; discussions: Discussion[] };

const MAX_ROUNDS = 3;
const MAX_MESSAGES = 10;
const MAX_CONTINUES = 5;
const MAX_LOG_LIMIT = 500;
const GATEWAY = "install:stand-in";
// Hermes's _MENTION_RE under re.IGNORECASE, which on a str pattern widens [A-Za-z] to İ ı ſ and the Kelvin sign; JS /i would not.
const MENTION = /@([A-Za-z0-9\u0130\u0131\u017f\u212a][A-Za-z0-9._:\-\u0130\u0131\u017f\u212a]*)/g;
// str.casefold() on that alphabet: toLowerCase, but the long s folds to s.
const casefold = (s: string): string => s.toLowerCase().replaceAll("\u017f", "s");
const NO_METHOD = -32601;
const WORKER_DOWN = "Group Chat worker is unavailable. Restart the Hermes gateway and try again.";
const DRIVER_DOWN = "hosted room driver is unavailable";
const CODES = {
  "groups.create": { room: 4110, service: 4123 },
  "groups.send": { room: 4111, service: 4123 },
  "groups.log": { room: 4112 },
  "groups.disband": { room: 4113, service: 4123 },
  "groups.state": { room: 4114 },
  "groups.stop": { room: 5116, service: 4115 },
  "groups.rename": { room: 4117 },
  "groups.approve": { room: 5119, service: 4115 },
  "groups.continue": { room: 4128, service: 4115 },
  "groups.list": { room: 5110 },
} as const satisfies Record<string, { room: number; service?: number }>;
type Method = keyof typeof CODES;

class RoomRefusal extends Error {}
type Outcome = { say: string } | { pass: true } | { fail: string };

export type GroupsBuild = {
  absent: boolean;
  continues: boolean;
  activityDetail: boolean;
  saysPush: boolean;
  pushes: boolean;
  worker: boolean;
};

export const GROUPS_BUILDS = {
  ae2a81cc: { absent: false, continues: true, activityDetail: true, saysPush: true, pushes: true, worker: true },
  f0d9488: { absent: false, continues: false, activityDetail: true, saysPush: false, pushes: false, worker: true },
  bf0203a: { absent: false, continues: false, activityDetail: false, saysPush: false, pushes: false, worker: true },
} as const satisfies Record<string, GroupsBuild>;

export class FakeGroups {
  build: GroupsBuild = { ...GROUPS_BUILDS.ae2a81cc };
  script: (turn: TurnContext) => FakeTurn = (t) => ({ say: `${t.name} here.` });
  onChange?: (roomIds: string[]) => void;
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  auto?: { delayMs: number; clarifyMs: number };
  now: () => number = () => Date.now() / 1000;
  private readonly rooms = new Map<string, Room>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private ids = 0;

  handle(method: string, params: Record<string, unknown>): GroupsAnswer {
    this.calls.push({ method, params: structuredClone(params) });
    // Its first call writes a secret file on a real server (`gateway/hosted_room_peer.py`).
    if (method === "groups.capabilities") throw new Error("The app sent groups.capabilities, which writes a file on the server.");
    const known = method in CODES && (method !== "groups.continue" || this.build.continues);
    if (this.build.absent || !known) return { error: { code: NO_METHOD, message: `unknown method: ${method}` } };
    const codes: { room: number; service?: number } = CODES[method as Method];
    if (codes.service !== undefined && !this.build.worker) return { error: { code: codes.service, message: codes.service === 4123 ? WORKER_DOWN : DRIVER_DOWN } };
    try {
      return { result: this[method as Method](params) };
    } catch (e) {
      if (!(e instanceof RoomRefusal)) throw e;
      return { error: { code: codes.room, message: e.message } };
    }
  }

  seed(room: { id: string; name: string; members: { profile: string; name?: string }[] }) {
    this["groups.create"]({ room_id: room.id, name: room.name, members: room.members.map((m) => ({ member_id: m.profile, profile: m.profile, handle: m.profile, ...(m.name && { display_name: m.name }) })) });
  }

  dump(): Record<string, { name: string; members: string[]; disbanded: boolean; events: readonly RoomEvent[] }> {
    return Object.fromEntries([...this.rooms].map(([id, r]) => [id, { name: r.name, members: r.members.map((m) => m.profile), disbanded: r.disbanded_at !== undefined, events: r.events }]));
  }

  log(roomId: string): readonly RoomEvent[] {
    return this.room(roomId, true).events;
  }

  step(roomId: string): boolean {
    const room = this.room(roomId, true);
    const running = room.tasks.find((t) => t.status === "running");
    if (running?.waiting?.kind === "approval") return false;
    const task = running ?? this.start(room);
    if (!task) return false;
    if (!running && task.waiting) this.changed(room);
    else this.finish(room, task, task.waiting ? { say: task.waiting.then } : (task.turn as Outcome));
    return true;
  }

  begin(roomId: string): boolean {
    const room = this.room(roomId, true);
    if (!this.start(room)) return false;
    this.changed(room);
    return true;
  }

  settle(roomId: string) {
    while (this.step(roomId)) continue;
  }

  liveRows(): { id: string; session_key: string; status: string; last_active: number; title: string }[] {
    return [...this.rooms.values()].flatMap((room) =>
      room.tasks
        .filter((t) => t.status === "running")
        .map((t) => ({ id: `rt-${room.room_id}-${t.member.member_id}`, session_key: `group-${room.room_id}-${t.member.member_id}`, status: "working", last_active: t.startedAt ?? this.now(), title: `Group: ${room.room_id}` })),
    );
  }

  private room(id: unknown, includeDisbanded = false): Room {
    const room = typeof id === "string" ? this.rooms.get(id) : undefined;
    if (!room || (room.disbanded_at !== undefined && !includeDisbanded)) throw new RoomRefusal("hosted room not found");
    return room;
  }

  private rowOf(room: Room, idempotent = false) {
    const { room_id, name, members, created_at, updated_at, revision, disbanded_at } = room;
    return { room_id, name, members: structuredClone(members), authority_gateway_id: GATEWAY, authority_epoch: 1, revision, created_at, updated_at, idempotent, ...(disbanded_at !== undefined && { disbanded_at }), latest_seq: room.events.length };
  }

  private append(room: Room, kind: string, actor: Record<string, unknown>, payload: Record<string, unknown>, eventId?: string): RoomEvent {
    const event: RoomEvent = { room_id: room.room_id, seq: room.events.length + 1, event_id: eventId ?? `${kind}:${++this.ids}`, kind, actor, authority_epoch: 1, payload, created_at: this.now(), idempotent: false };
    room.events.push(event);
    room.updated_at = event.created_at;
    return event;
  }

  private changed(room: Room) {
    if (this.build.pushes) this.onChange?.([room.room_id]);
    if (!this.auto || this.timers.has(room.room_id) || room.disbanded_at !== undefined) return;
    const running = room.tasks.find((t) => t.status === "running");
    if (running?.waiting?.kind === "approval" || (!running && !room.tasks.length)) return;
    const wait = running?.waiting?.kind === "clarify" ? this.auto.clarifyMs : this.auto.delayMs;
    this.timers.set(
      room.room_id,
      setTimeout(() => {
        this.timers.delete(room.room_id);
        if (room.tasks.some((t) => t.status === "running")) this.step(room.room_id);
        else if (this.start(room)) this.changed(room);
      }, wait),
    );
  }

  private "groups.list"(params: Record<string, unknown>) {
    const limit = typeof params.limit === "number" ? params.limit : MAX_LOG_LIMIT;
    const offset = typeof params.offset === "number" ? params.offset : 0;
    const rows = [...this.rooms.values()].filter((r) => r.disbanded_at === undefined || params.include_disbanded === true).sort((a, b) => b.updated_at - a.updated_at || a.room_id.localeCompare(b.room_id));
    const page = rows.slice(offset, offset + limit).map((r) => this.rowOf(r));
    return { rooms: page, next_offset: page.length === limit ? offset + limit : null };
  }

  private "groups.create"(params: Record<string, unknown>) {
    const id = typeof params.room_id === "string" ? params.room_id.trim() : "";
    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!id) throw new RoomRefusal("room_id is required");
    if (!name) throw new RoomRefusal("room name is required");
    const members = Array.isArray(params.members) ? (params.members as Record<string, unknown>[]) : [];
    if (members.length < 2 || members.length > 6) throw new RoomRefusal("members must contain between 2 and 6 entries");
    const seats = members.map((m): Member => {
      const extra = Object.keys(m).filter((k) => !["member_id", "profile", "handle", "display_name", "target"].includes(k));
      if (extra.length || typeof m.member_id !== "string" || typeof m.profile !== "string" || typeof m.handle !== "string") throw new RoomRefusal("each member needs exactly member_id, profile and handle");
      return { member_id: m.member_id, profile: m.profile, handle: m.handle, ...(typeof m.display_name === "string" && { display_name: m.display_name }), target: { kind: "local", profile: m.profile } };
    });
    if (new Set(seats.map((s) => s.profile)).size !== seats.length) throw new RoomRefusal("member profiles must be unique");
    const handles = seats.map((s) => s.handle.toLowerCase());
    if (new Set(handles).size !== handles.length || handles.some((h) => h === "all" || h === "everyone")) throw new RoomRefusal("member handles must be unique and cannot reserve @all or @everyone");
    const existing = this.rooms.get(id);
    if (existing?.disbanded_at !== undefined) throw new RoomRefusal("room_id is permanently retired");
    if (existing && (existing.name !== name || JSON.stringify(existing.members) !== JSON.stringify(seats))) throw new RoomRefusal("room_id already exists with different state");
    if (existing) return { room: this.rowOf(existing, true) };
    const at = this.now();
    const room: Room = { room_id: id, name, members: seats, created_at: at, updated_at: at, revision: 1, events: [], tasks: [], discussions: [] };
    this.rooms.set(id, room);
    this.append(room, "room.created", { kind: "system", id: "room-control" }, { name });
    this.changed(room);
    return { room: this.rowOf(room) };
  }

  private "groups.state"(params: Record<string, unknown>) {
    const room = this.room(params.room_id, params.include_disbanded === true);
    const detail = this.build.activityDetail;
    const running = room.tasks.find((t) => t.status === "running");
    const driver = {
      running: true,
      working: room.tasks.length > 0,
      blocked: false,
      counts: { queued: room.tasks.filter((t) => t.status === "queued").length, running: running ? 1 : 0 },
      pending_actions:
        running?.waiting?.kind === "approval"
          ? [{ kind: "approval", member_id: running.member.member_id, task_id: running.id, execution_generation: 1, request_id: running.waiting.requestId, approval: { command: running.waiting.command, description: running.waiting.description, choices: ["once", "deny"], timeout_s: 300 } }]
          : [],
      member_activity: room.tasks.map((t) => ({
        member_id: t.member.member_id,
        status: t.status,
        ...(detail && { thread_id: t.discussion.thread, round_index: t.round, ...(t.startedAt !== undefined && { started_at: t.startedAt }), ...(t.tool && { tool: t.tool, progress_at: t.startedAt }) }),
      })),
      ...(detail && { last_error: null }),
      ...(this.build.continues && { max_rounds: MAX_ROUNDS, max_continues: MAX_CONTINUES }),
      peer_routes: [],
    };
    return { room: this.rowOf(room), ...(this.build.worker && room.disbanded_at === undefined && { driver_status: driver }), ...(this.build.saysPush && { change_events: true }) };
  }

  private "groups.log"(params: Record<string, unknown>) {
    const room = this.room(params.room_id, params.include_disbanded === true);
    const since = typeof params.since_seq === "number" ? params.since_seq : 0;
    const limit = Math.min(MAX_LOG_LIMIT, typeof params.limit === "number" ? params.limit : 100);
    const latest = room.events.length;
    if (since > latest) throw new RoomRefusal("since_seq is ahead of the hosted room log");
    const events = structuredClone(room.events.slice(since, since + limit));
    const cursor = events.length ? events[events.length - 1].seq : since;
    return { events, cursor, latest_seq: latest, has_more: cursor < latest, authority: { gateway_id: GATEWAY, epoch: 1 } };
  }

  private "groups.send"(params: Record<string, unknown>) {
    const room = this.room(params.room_id);
    const clientId = typeof params.event_id === "string" ? params.event_id : "";
    const payload = (typeof params.payload === "object" && params.payload !== null ? params.payload : {}) as Record<string, unknown>;
    if (!clientId) throw new RoomRefusal("event_id is required");
    if (typeof payload.text !== "string" || !payload.text.trim()) throw new RoomRefusal("text is required");
    if (typeof payload.thread_id !== "string" || !payload.thread_id) throw new RoomRefusal("thread_id is required");
    const id = `user:${clientId}`;
    const answer = (event: RoomEvent, idempotent: boolean) => ({ event: { ...structuredClone(event), idempotent }, client_event_id: clientId, accepted: true, driver_started: true });
    const stored = room.events.find((e) => e.event_id === id);
    if (stored) return answer(stored, true);
    const event = this.append(room, "message.user", { kind: "user", id: "dashboard" }, { text: payload.text, thread_id: payload.thread_id }, id);
    for (const d of room.discussions.filter((d) => d.thread === payload.thread_id && d.status !== "over")) {
      this.cancel(room, (t) => t.discussion === d, "superseded_by_newer_user_event");
      d.status = "over";
    }
    const discussion: Discussion = { id, thread: payload.thread_id, text: payload.text, round: 0, continues: 0, messages: 0, said: [], next: [], status: "running" };
    room.discussions.push(discussion);
    this.queue(room, discussion, this.mentioned([payload.text], room.members, true));
    this.changed(room);
    return answer(event, false);
  }

  private "groups.continue"(params: Record<string, unknown>) {
    const room = this.room(params.room_id);
    const d = room.discussions.find((x) => x.id === params.discussion_event_id);
    if (!d || d.status !== "bounded") throw new RoomRefusal("discussion is not paused at its cap");
    if (d.continues >= MAX_CONTINUES) throw new RoomRefusal("discussion has no continues left");
    d.continues += 1;
    d.status = "running";
    const event = this.append(room, "room.continued", { kind: "gateway", id: GATEWAY }, { discussion_event_id: d.id, thread_id: d.thread, grant: d.continues });
    d.round += 1;
    this.queue(room, d, d.next);
    this.changed(room);
    return { continued: true, event: structuredClone(event) };
  }

  private "groups.stop"(params: Record<string, unknown>) {
    const room = this.room(params.room_id);
    const cancelId = typeof params.cancel_id === "string" && params.cancel_id ? params.cancel_id : "desktop-stop";
    if (room.events.some((e) => e.event_id === `room-stop:${cancelId}`)) return { cancelled: 0 };
    this.append(room, "room.stop_requested", { kind: "gateway", id: GATEWAY }, { cancel_id: cancelId }, `room-stop:${cancelId}`);
    const cancelled = this.cancel(room, () => true, "member turn cancelled");
    for (const d of room.discussions) d.status = "over";
    this.changed(room);
    return { cancelled };
  }

  private "groups.approve"(params: Record<string, unknown>) {
    const room = this.room(params.room_id);
    const task = room.tasks.find((t) => t.id === params.task_id && t.member.member_id === params.member_id);
    const waiting = task?.waiting;
    if (params.choice !== "once" && params.choice !== "deny") throw new RoomRefusal("choice must be once or deny");
    if (!task || waiting?.kind !== "approval" || waiting.requestId !== params.request_id || params.execution_generation !== 1) throw new RoomRefusal("approval is no longer pending");
    this.finish(room, task, { say: params.choice === "once" ? waiting.then : `${task.member.display_name ?? task.member.handle} was told no: the command didn't run.` });
    return { approved: true, result: { choice: params.choice } };
  }

  private "groups.rename"(params: Record<string, unknown>) {
    const room = this.room(params.room_id);
    const name = typeof params.name === "string" ? params.name.trim() : "";
    const eventId = typeof params.event_id === "string" ? params.event_id : "";
    if (!name) throw new RoomRefusal("room name is required");
    if (!eventId) throw new RoomRefusal("event_id is required");
    if (!room.events.some((e) => e.event_id === eventId)) {
      room.name = name;
      room.revision += 1;
      this.append(room, "room.renamed", { kind: "system", id: "room-control" }, { name }, eventId);
      this.changed(room);
    }
    return { room: this.rowOf(room) };
  }

  private "groups.disband"(params: Record<string, unknown>) {
    const room = this.room(params.room_id, true);
    if (room.disbanded_at === undefined) {
      this.cancel(room, () => true, "member turn cancelled");
      this.append(room, "room.disbanded", { kind: "system", id: "room-control" }, {}, "system:room-disbanded");
      room.disbanded_at = this.now();
      clearTimeout(this.timers.get(room.room_id));
      this.timers.delete(room.room_id);
      if (this.build.pushes) this.onChange?.([room.room_id]);
    }
    return { tombstone: { room_id: room.room_id, disbanded_at: room.disbanded_at } };
  }

  private mentioned(texts: readonly string[], members: readonly Member[], defaultAll: boolean): Member[] {
    const named = new Set(texts.flatMap((t) => [...t.matchAll(MENTION)].map((m) => casefold(m[1]))));
    const some = members.filter((m) => named.has(casefold(m.handle)));
    return named.has("all") || named.has("everyone") || (defaultAll && !some.length) ? [...members] : some;
  }

  private queue(room: Room, discussion: Discussion, members: readonly Member[]) {
    discussion.said = [];
    for (const member of members) room.tasks.push({ id: `task-${++this.ids}`, discussion, member, round: discussion.round, status: "queued" });
  }

  private cancel(room: Room, which: (t: Task) => boolean, reason: string): number {
    const gone = room.tasks.filter(which);
    room.tasks = room.tasks.filter((t) => !which(t));
    // Hermes holds one turn at a time as a task, so only the next turn is logged as cancelled (room-probe-1.log, seq 87).
    if (gone[0]) this.append(room, "turn.cancelled", { kind: "gateway", id: GATEWAY }, { ...this.coordinates(room, gone[0]), reason });
    return gone.length;
  }

  private coordinates(room: Room, t: Task) {
    return { discussion_event_id: t.discussion.id, member_id: t.member.member_id, member_index: room.members.indexOf(t.member), round_index: t.round, task_id: t.id, thread_id: t.discussion.thread, turn_id: `${t.discussion.id}.r${t.round}.${t.member.member_id}` };
  }

  private start(room: Room): Task | undefined {
    const task = room.tasks[0];
    if (task?.status !== "queued") return undefined;
    const name = task.member.display_name ?? task.member.handle;
    const handles = room.members.map((m) => m.handle);
    task.turn = this.script({ roomId: room.room_id, member: task.member.member_id, name, index: room.members.indexOf(task.member), handles, round: task.round, ownerText: task.discussion.text, said: task.discussion.said });
    task.status = "running";
    task.startedAt = this.now();
    const turn = task.turn;
    if ("approval" in turn) {
      task.tool = "terminal";
      task.waiting = { kind: "approval", requestId: `rq-${++this.ids}`, command: turn.approval.command, description: turn.approval.description, then: turn.then };
    } else if ("clarify" in turn) {
      task.tool = "clarify";
      task.waiting = { kind: "clarify", then: turn.then };
    } else if ("say" in turn) task.tool = turn.tool;
    return task;
  }

  private finish(room: Room, task: Task, outcome: Outcome) {
    room.tasks = room.tasks.filter((t) => t !== task);
    const d = task.discussion;
    const at = this.coordinates(room, task);
    const driver = { kind: "gateway", id: GATEWAY };
    if ("say" in outcome) {
      const message = this.append(room, "message.member", { kind: "member", id: task.member.member_id, profile: task.member.profile, ...(task.member.display_name && { display_name: task.member.display_name }) }, { ...at, text: outcome.say });
      this.append(room, "turn.settled", driver, { ...at, seen_through_seq: message.seq, message_event_id: message.event_id, passed: false });
      d.said.push(outcome.say);
      d.messages += 1;
    } else if ("pass" in outcome) this.append(room, "turn.settled", driver, { ...at, seen_through_seq: room.events.length, message_event_id: null, passed: true });
    else this.append(room, "turn.failed", driver, { ...at, seen_through_seq: room.events.length, error: outcome.fail, reason_code: "provider_error" });
    if (!room.tasks.some((t) => t.discussion === d)) this.decide(room, d);
    this.changed(room);
  }

  private decide(room: Room, d: Discussion) {
    const next = this.mentioned(d.said, room.members, false);
    const budget = d.continues + 1;
    const activity = (status: string, reason_code: string) =>
      this.append(room, "room.activity", { kind: "gateway", id: GATEWAY }, { status, reason_code, thread_id: d.thread, discussion_event_id: d.id }, `dactivity:${d.id}:${reason_code}${d.continues ? `:c${d.continues}` : ""}`);
    if (!next.length) {
      d.status = "over";
      activity("settled", "silent_round");
    } else if (d.round + 1 >= MAX_ROUNDS * budget || d.messages >= MAX_MESSAGES * budget) {
      d.status = "bounded";
      d.next = next;
      activity("bounded", d.round + 1 >= MAX_ROUNDS * budget ? "max_rounds" : "max_messages");
    } else {
      d.round += 1;
      this.queue(room, d, next);
    }
  }
}

export function standInScript(t: TurnContext): FakeTurn {
  if (/pingpong/i.test(t.ownerText)) return { say: `${t.name} here, pingpong. @${t.handles[t.index === 0 ? 1 : 0]} your turn.` };
  if (/approve/i.test(t.ownerText) && t.index === t.handles.length - 1) return { approval: { command: "rm -rf /srv/tmp/build-cache", description: "delete in root path" }, then: `${t.name} ran it: the build cache is gone.` };
  if (/clarify/i.test(t.ownerText) && t.index === 1) return { clarify: true, then: `${t.name} asked through clarify and got no answer, so here is a guess: tea.` };
  return { say: `${t.name} here. Noted: ${t.ownerText.slice(0, 60)}` };
}
