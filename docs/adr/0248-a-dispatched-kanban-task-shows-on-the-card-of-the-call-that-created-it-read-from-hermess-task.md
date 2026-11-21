# A dispatched Kanban task shows on the card of the call that created it, read from Hermes's task

> **Accepted.** Issue #93, part two of three: a Kanban task this chat created. Part one, a bot's message to a teammate, is [ADR 0228](0228-handed-off-work-shows-on-the-card-of-the-call-that-sent-it-from-hermess-records-only.md), and this follows its rule. Subagents come last. `taskCall` and `taskLines` in `src/hermes/taskCard.ts` read the call and build the lines. `TaskReads` in `src/hermes/taskReads.ts` keeps the latest read of each shown task. `TaskCard` in `src/ui/TaskCard.tsx` draws the card, and `fillStoredResults` in `src/hermes/transport.ts` reads the call's answer back after a resume. Tested in `src/hermes/taskCard.test.ts`, `src/hermes/taskReads.test.ts`, `src/ui/taskCard.test.tsx` and `e2e/features/task-card.e2e.tsx`.

When a reply calls `kanban_create`, the owner sees a tool row and, much later, Hermes's wake turn. What happened in between is on the Work page, or in the chat list's hourglass and Inbox reason (issue #287). The owner wants to follow the task from the chat that created it.

The rule is ADR 0228's. Every line comes from something Hermes sent or stores. No step, percentage, estimate or activity is made up.

What Hermes 0.23.2 sends and stores about a `kanban_create` call was read in its source (`tools/kanban_tools.py`, `plugins/kanban/dashboard/plugin_api.py`, `hermes_cli/kanban_db.py`):

- **At the call, the answer.** It has `ok`, `task_id`, the `status` the task landed in (routing may change the one asked for), `gated` and `gated_by` when it waits on a parent, and `subscribed`. `subscribed` says whether Hermes subscribed this chat to the task's completion and block. A refusal is `{"error": …}`, and no task is made.
- **After a reload, the answer is still stored.** `session.resume` leaves it out, but the call's stored tool row keeps it, as for `message_agent`.
- **The task, read on demand.** `GET /api/plugins/kanban/tasks/{id}?board=` returns the task with:
  - its status, and its latest summary (a block's reason) and result;
  - its comments, each with an author and a time;
  - its runs, each with a profile, a start, a last heartbeat and, once ended, an outcome;
  - its events.

  A task Hermes doesn't have answers 404 with `task <id> not found`.
- **No progress.** A heartbeat carries no note when it is automatic, so it says the worker was alive then. Hermes keeps no plan of steps. A status of `running` set at creation doesn't mean a worker took the task: only a run does. `done` is the board's status. Whether the work succeeded is in what the run recorded.

## Decisions

- **The card of the call that created the task carries what Hermes says about it.** A `kanban_create` call shows as a task card instead of a tool row. Its heading is "Task for @assignee: title". It has **Open in Work**, which opens the task's sheet on the Work page. The button shows only for a task Work lists: one on Hermes's current board that isn't archived or gone. Work shows only that board and leaves archived tasks out (ADR 0171), so for any other task the button would open Work without the sheet.
- **The lines are a pure function of the call's answer and the latest read of the task.** Nothing is saved: no progress log, no new kind of item, no second store. The same answer and the same read always give the same lines.
- **The answer is the only source for its lines**, worded for the moment of creation:
  - "Created for @x, in Ready.";
  - "It waits on t_… before a worker can take it.";
  - "Hermes tells this chat when it's done or blocked.", or that it won't when `subscribed` is false.
- **The read is the only source for the rest.**
  - **Status.** Ready and running say "no worker has claimed it" until a run is open. Blocked gives the reason Hermes kept. Done says "Marked done.", never "succeeded", with the summary recorded as Hermes stores it.
  - **Runs.** Each says who started it and when, or when it ended and Hermes's outcome. An open run's last heartbeat is shown as liveness: "A heartbeat says the worker is alive, not how far it got."
  - **Comments.** Each gives its author and time, and the comment cut to one line.
  - **How many.** The latest three runs and three comments show. The rest are counted, and Work shows them.
- **Every read says how old it is.** The last line is "Read from Hermes 5m ago". A failed read keeps the read before it and says that the read failed. A 404 that is Hermes's own answer for a missing task says the task is gone. Any other 404 is a failed read, such as a board or the plugin being missing.
- **Reads are kept in memory, for the shown profile only.** A task is read when its card first shows, then every 30 seconds while a card shows it and it isn't done, archived or gone. It is also read at once when a `status.update` names it. Nothing is read while disconnected. A profile switch forgets every read.
- **A task's board is the one the call named.** With no board named, the read goes to Hermes's current board. If that has no such task, the card says it may be on another board.

## Considered options

- **Reusing the Kanban watch's tracked tasks (`Chat.tasks`).** Rejected. The watch keeps only the status and whether a worker picked the task up, for the chat list. It drops a task five minutes after it ends. The card needs the runs and comments, and needs them for a task read once after it ended.
- **A progress line per heartbeat or event.** Rejected. A heartbeat says nothing of progress, and a line per event would add up to a log saved nowhere.
- **Showing the worker's chat on the card.** Rejected. Work's run view already reads it, and it would put another profile's chat here.

## Consequences

- A chat shows each task it created, with what Hermes last said about it, without opening Work.
- Each shown card that isn't done reads its task every 30 seconds. A long chat with many open tasks reads each of them.
- The stand-in now stores a dispatching reply's `kanban_create` call as Hermes does. The bridge's `/__kanban` can add a comment, a heartbeat or a summary.
