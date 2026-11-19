// An Ask's card in the Bot Chat it was sent from (ADR 0225): the owner's message to another bot, then that bot's reply
// under its face and name, and what became of the message while there is no reply to show.
import { createContext, useContext } from "react";
import { AtSign, CircleAlert, Link2, RotateCcw } from "lucide-react";
import type { Ask } from "../hermes/model";
import { sentence } from "../hermes/values";
import { useLocale } from "../i18n/locale";
import { BotFace, type BotLookShown } from "./BotFace";
import { Markdown } from "./Markdown";
import { Spinner } from "./bits";
import { TurnCard } from "./TurnCard";

/** What a card does and needs from its chat. `look`: the bot's face now, when the roster still has it. */
export type AskActions = { look(profile: string): BotLookShown | undefined; retry(id: string): void; dismiss(id: string): void; open(profile: string): void };
export const AskContext = createContext<AskActions | undefined>(undefined);

export function AskCard({ ask }: { ask: Ask }) {
  const l = useLocale().chat.ask;
  const act = useContext(AskContext);
  const { name, handle, profile } = ask.to;
  const look = act?.look(profile) ?? { name };
  const unsent = ask.state === "failed" || ask.state === "unknown";
  const needsYou = ask.state === "replying" && !!ask.needsYou;
  const working = ask.state === "sending" || (ask.state === "replying" && !needsYou);
  const note = {
    waiting: l.waiting(name),
    sending: l.sending(name),
    held: l.held(name),
    replying: needsYou ? l.needsYou(name) : ask.reply ? "" : l.replying(name),
    answered: "",
    stopped: l.stopped(name),
    unheard: l.unheard(name),
    failed: l.failed(name),
    unknown: l.unknown(name),
  }[ask.state];
  const why = ask.state === "failed" || ask.state === "unknown" || ask.state === "stopped" ? sentence(ask.reason) : "";
  const canOpen = needsYou || ask.state === "unheard" || ask.state === "unknown";
  return (
    <TurnCard
      kind={`asked ${ask.state}`}
      icon={working ? <Spinner /> : unsent ? <CircleAlert size={14} aria-hidden /> : <AtSign size={14} aria-hidden />}
      heading={l.asked(handle)}
      tips={l}
      data-ask={ask.id}
      data-to={handle}
      data-state={ask.state}
    >
      {ask.references && (
        <div className="msg-files">
          {ask.references.map((title, i) => (
            <span key={i} className="chip ref-chip">
              <Link2 size={12} aria-hidden />
              <span className="chip-name">{l.referenced(title)}</span>
            </span>
          ))}
        </div>
      )}
      <div className="asked-text" translate="no">
        {ask.text}
      </div>
      <div className="asked-reply">
        <div className="asked-from" translate="no">
          <BotFace bot={look} size="xs" />
          <span>{look.name}</span>
        </div>
        {ask.reply && (
          <div className="returned-body msg assistant" translate="no">
            <Markdown text={ask.reply} />
          </div>
        )}
        {note && (
          <p className={`asked-note${unsent ? " unsent" : ""}`} role={unsent ? "alert" : "status"}>
            {note}
            {why && <span translate="no"> {why}</span>}
            {ask.state === "unknown" && ` ${l.unknownCheck(name)}`}
          </p>
        )}
        {act && (canOpen || unsent || ask.state === "waiting") && (
          <div className="asked-actions">
            {(unsent || ask.state === "waiting") && (
              <button className="btn" onClick={() => act.dismiss(ask.id)}>
                {l.dismiss}
              </button>
            )}
            {canOpen && (
              <button className="btn" onClick={() => act.open(profile)}>
                {l.open(name)}
              </button>
            )}
            {unsent && (
              <button className="btn primary" title={ask.state === "unknown" ? l.retryTwiceTip : l.retryTip} onClick={() => act.retry(ask.id)}>
                <RotateCcw size={13} aria-hidden /> {l.retry}
              </button>
            )}
          </div>
        )}
      </div>
    </TurnCard>
  );
}
