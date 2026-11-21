import { CircleAlert, SquareKanban } from "lucide-react";
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { Item } from "../hermes/model";
import { taskLines, workLists, type TaskCall, type TaskLine, type TaskRead } from "../hermes/taskCard";
import type { TaskReads } from "../hermes/taskReads";
import { useLocale, type Locale } from "../i18n/locale";
import { Spinner, Ticking } from "./bits";
import { TurnCard } from "./TurnCard";

/** What a task card reads its task from, and how it opens the task in Work. App provides it; Replay and export don't. */
export type TaskCards = { reads: TaskReads; openInWork?: (taskId: string) => void };
export const TaskCardsContext = createContext<TaskCards | undefined>(undefined);

const noWatch = () => () => {};

/** The latest read of the task, kept current while the card shows. */
function useTaskRead(reads: TaskReads | undefined, id: string | undefined, board: string | undefined): TaskRead | undefined {
  const subscribe = useCallback((listener: () => void) => (reads && id ? reads.watch(id, board, listener) : noWatch()), [reads, id, board]);
  return useSyncExternalStore(subscribe, () => (reads && id ? reads.get(id, board) : undefined));
}

const when = (l: Locale, at: number) => (new Date(at).toDateString() === new Date().toDateString() ? l.fmt.time(at) : l.fmt.dateTime(at));

/** A `kanban_create` call's card (ADR 0248): the task it made, from the call's answer and the latest read of the task. */
export function TaskCard({ tool, call }: { tool: Extract<Item, { kind: "tool" }>; call: TaskCall }) {
  const l = useLocale().chat.task;
  const cards = useContext(TaskCardsContext);
  const made = call.ack?.kind === "made" ? call.ack : undefined;
  const read = useTaskRead(cards?.reads, made?.taskId, call.board);
  const lines = taskLines(call, read);
  const refused = call.ack?.kind === "refused" ? call.ack.why : undefined;
  const running = tool.status === "running";
  const currentBoard = useSyncExternalStore(cards?.reads.watchBoard ?? noWatch, () => cards?.reads.currentBoard());
  const open = made && workLists(call, read, currentBoard) && cards?.openInWork;
  return (
    <TurnCard
      kind="task"
      icon={running ? <Spinner /> : refused ? <CircleAlert size={14} aria-hidden /> : <SquareKanban size={14} aria-hidden />}
      heading={running ? l.creating(call.title, call.assignee) : refused ? l.notMade(call.title) : l.made(call.title, call.assignee)}
      tips={l}
      data-item={tool.id}
      data-call={tool.callId}
      data-task={made?.taskId}
      foot={
        open && (
          <div className="sent-open">
            <button className="preview-chip" title={l.openInWorkTip} onClick={() => open(made.taskId)}>
              <SquareKanban size={12} aria-hidden /> {l.openInWork}
            </button>
          </div>
        )
      }
    >
      {refused && (
        <p className="returned-why" translate="no">
          {refused}
        </p>
      )}
      {lines.length > 0 && (
        <ul className="delivery">
          {lines.map((line, i) => (
            <TaskLineRow key={i} line={line} />
          ))}
        </ul>
      )}
    </TurnCard>
  );
}

function TaskLineRow({ line }: { line: TaskLine }) {
  const locale = useLocale();
  const l = locale.chat.task;
  const statusName = (s: string) => (l.statusName as Record<string, string>)[s] ?? s;
  switch (line.kind) {
    case "created":
      return <li data-line={line.kind}>{l.created(line.assignee, line.board, line.landed && statusName(line.landed))}</li>;
    case "gated":
      return <li data-line={line.kind}>{l.gated(line.by)}</li>;
    case "subscribed":
      return <li data-line={line.kind}>{line.yes ? l.subscribed : l.notSubscribed}</li>;
    case "unread":
      return <li data-line={line.kind}>{l.unread}</li>;
    case "status":
      return (
        <li data-line={line.kind} data-status={line.status}>
          {line.status === "blocked" && line.reason ? (
            <>
              {l.status.blockedFor} <span translate="no">{line.reason}</span>
            </>
          ) : (
            statusLine(l.status, line)
          )}
        </li>
      );
    case "summary":
      return (
        <li data-line={line.kind} translate="no">
          {l.summary(line.text)}
        </li>
      );
    case "run":
      return (
        <li data-line={line.kind} data-outcome={line.ended?.outcome}>
          {line.ended ? (
            l.ended(line.profile, when(locale, line.ended.at), l.outcome[line.ended.outcome] ?? line.ended.outcome)
          ) : (
            <>
              {line.startedAt !== undefined && l.started(line.profile, when(locale, line.startedAt))}
              {line.heartbeatAt !== undefined && (
                <>
                  {" "}
                  <Ticking>{() => (locale.fmt.age(line.heartbeatAt!) === locale.time.now ? l.heartbeatNow : l.heartbeatAgo(locale.fmt.age(line.heartbeatAt!)))}</Ticking>
                </>
              )}
            </>
          )}
        </li>
      );
    case "comment":
      return (
        <li data-line={line.kind}>
          {l.comment(line.author, when(locale, line.at))} <span translate="no">{line.text}</span>
        </li>
      );
    case "earlier":
      return <li data-line={line.kind}>{line.of === "runs" ? l.earlierRuns(line.count) : l.earlierComments(line.count)}</li>;
    case "gone":
      return <li data-line={line.kind}>{l.gone(line.board)}</li>;
    case "readFailed":
      return <li data-line={line.kind}>{l.readFailed(line.why)}</li>;
    case "readAt":
      return (
        <li data-line={line.kind}>
          <Ticking>{() => (locale.fmt.age(line.at) === locale.time.now ? l.readNow : l.readAgo(locale.fmt.age(line.at)))}</Ticking>
        </li>
      );
  }
}

function statusLine(s: Locale["chat"]["task"]["status"], line: Extract<TaskLine, { kind: "status" }>): string {
  switch (line.status) {
    case "triage":
    case "todo":
    case "scheduled":
    case "blocked":
    case "review":
    case "done":
    case "archived":
      return s[line.status];
    case "ready":
      return s.ready;
    case "running":
      return line.claimed ? s.running : s.runningUnclaimed;
    default:
      return s.other(line.status);
  }
}
