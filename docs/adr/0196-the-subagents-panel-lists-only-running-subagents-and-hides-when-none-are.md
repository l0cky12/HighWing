# The Subagents panel lists only running subagents, and hides when none are

> **Accepted.** It changes one consequence of ADR 0072: "Completed subagents are kept for the chat's whole time on this connection, up to the limit." The tree itself stays as ADR 0072 says. Only what the panel lists changes. The rule is `stillRunning` in `src/hermes/subagents.ts`, used by `SubagentsPanel` in `src/ui/Subagents.tsx`. Tested in `src/hermes/subagents.test.ts` and `src/ui/subagents.test.tsx`.

The panel above the composer kept every subagent a chat's reply had started, finished or not. After the work was done it still sat there with "1 in all", over the composer, for the rest of the chat. The owner asked for a finished subagent to leave the panel, and for the panel to go once none are left, until the chat starts another one.

## Decisions

- **The panel lists a subagent while it is queued or running.** Once it ends, in any way (finished, failed, timed out, stopped, or Ended), it leaves the list.
- **A subagent that ended stays while one it started still runs.** The running one hangs under it, so the tree still says who started whom.
- **The one the owner has open stays until they leave it.** A subagent that ends while its view is open keeps its view, with how it ended and no Steer or Stop. It leaves the list when the owner goes back to the list or closes the panel. A subagent the agent office opens shows in the same way, even one that has already ended.
- **No running subagents, no panel.** The panel shows again, as the owner last left it (open or closed), when the chat's reply starts another subagent.
- **The count says only how many are running**, such as "2 running". "Failed" and "in all" went, since the list no longer holds the ones they counted. While only an open one that ended is left, it says "None running".
- **The tree keeps every subagent**, as ADR 0072 says. The agent office still shows the ones that ended, and a reconnect's roster still applies to all of them. The filter is only on what the panel lists.

## Considered options

- **Keep failed subagents in the list.** A failure is news the owner may not have seen. Rejected: the panel would stay up after the work ended, which is what the owner asked to stop. The chat's reply gets the failure in its `delegate_task` result, and the agent office shows it in the Trouble room.
- **Drop ended subagents from the tree itself.** Rejected: the agent office reads the same tree, and a reconnect's roster needs the known subagents to match failed delegations to.
- **Close an open subagent's view the moment it ends.** Rejected: the owner would lose how it ended while reading it.

## Consequences

- A finished subagent's result and activity can be read in the panel only while its view is open. Once the owner leaves it, the agent office still opens it.
- Going back from the last subagent, once it has ended, hides the panel.
