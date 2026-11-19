// Ask first (ADR 0229): a message the owner sends in a Bot Chat carries a rule, hidden from both Hermes clients after
// the Attached Context marker, about messaging other bots. Hermes can't enforce it: message_agent has no approval
// gate. So it is an instruction, and the Messaged card shows any message a bot sends anyway.
import { chatKind } from "./chatKind";
import type { Chat } from "./model";

// Model-facing, so English and never in the catalogue, like chatReferences.ts's PREAMBLE.
export const ASK_FIRST_RULE: string = [
  "[The owner's rule for messaging other bots]",
  "Highwing adds this note to the owner's message. The owner doesn't see it.",
  "If you have the message_agent tool, ask the owner before you use it to message another bot.",
  "You don't need to ask when this message names that bot (such as @quill), or asks you to message, ask or hand the work to another bot.",
  "When you can't do something yourself, for example because a tool you need is off, say what is missing and ask whether to send it to another bot. Don't send it on your own.",
  "Messaging another bot never gives it your tools, your Bot Desktop or your screen.",
].join("\n");

// Sent in the other setting too, so flipping it overrides the rule an earlier message left in the chat's history.
export const SEND_FREELY_RULE: string = [
  "[The owner's rule for messaging other bots]",
  "Highwing adds this note to the owner's message. The owner doesn't see it.",
  "The owner lets you message another bot without asking first, when another bot is better placed to do the work.",
  "When you can't do something yourself because a tool you need is off, say what is missing.",
  "Messaging another bot never gives it your tools, your Bot Desktop or your screen.",
].join("\n");

/**
 * Pure. The hidden block Ask first adds to a message to `chat`: one of the two rules in a Bot Chat, and nothing
 * anywhere else: Hermes offers message_agent only in a session titled "Bot Chat".
 */
export const askFirstBlocks = (chat: Pick<Chat, "source" | "bot" | "title">, ask: boolean): readonly string[] =>
  chatKind(chat) === "bot" ? [ask ? ASK_FIRST_RULE : SEND_FREELY_RULE] : [];
