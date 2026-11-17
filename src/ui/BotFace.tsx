// A bot's face wherever the app draws one outside the bots' own rows: the chat list's profile switcher, its Bot Chat
// row and the line for a bot that needs the owner, and a chat's header.
import type { Bot } from "../hermes/bots";

/** A profile as its bot shows: its name, its Bot Mode colour and its picture. */
export type BotLookShown = { name: string; color?: string; picture?: string };

/** `bot` as it shows, with its picture from `pictures` (keyed by profile, as the transport keeps them). */
export const lookShown = (bot: Bot, pictures: Readonly<Record<string, string>>): BotLookShown => ({ name: bot.name, color: bot.color, picture: pictures[bot.profile] });

/** A bot's picture, or its initial on its colour. */
export function BotFace({ bot, size }: { bot: BotLookShown; size: "sm" | "xs" }) {
  return (
    <span className={`bots-face is-${size}${bot.color ? " has-color" : ""}`} style={bot.color ? { background: bot.color } : undefined} aria-hidden translate="no">
      {bot.picture ? <img src={bot.picture} alt="" /> : (bot.name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}
