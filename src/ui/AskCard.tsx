import { createContext, useContext } from "react";
import { AtSign, CircleAlert, Link2, RotateCcw } from "lucide-react";
import type { Ask, AskId, AskRefusal, AskTarget } from "../hermes/asks";
import type { AskRule } from "../hermes/mentionPicker";
import type { SentReference } from "../hermes/model";
import { useLocale } from "../i18n/locale";
import { BotFace } from "./BotFace";
import { Markdown } from "./Markdown";
import type { NamedBot } from "./SlashCommands";
import { Spinner } from "./bits";
import { TurnCard } from "./TurnCard";

export type AskHost = {
  asks: readonly Ask[];
  /** The other bots, as the "@" menu lists them, for each card's faces. */
  bots: readonly NamedBot[];
  /** This chat as the chip a message that names a bot carries; none while it has nothing to summarize. */
  self?: { chatId: string; title: string };
  rule: AskRule;
  connected: boolean;
  send(to: readonly NamedBot[], text: string, references: SentReference[]): AskRefusal | undefined;
  retry(id: AskId, profile: string): void;
  dismiss(id: AskId, profile: string): void;
  /** None while nothing the composer sends asks a bot, as in Compare. */
  edit?(id: AskId): void;
  open(profile: string): void;
};

export const AskContext = createContext<AskHost | undefined>(undefined);

const sentence = (text = "") => (text ? `${text[0].toUpperCase()}${text.slice(1)}${/[.!?)]$/.test(text) ? "" : "."}` : "");

function TargetLine({ ask, t, host }: { ask: Ask; t: AskTarget; host: AskHost }) {
  const l = useLocale().chat.ask;
  const bot = host.bots.find((b) => b.profile === t.profile);
  const h = t.handle;
  const failed = t.state === "failed" || t.state === "unknown";
  const note =
    t.state === "sending"
      ? l.sending(h)
      : t.state === "waiting"
        ? t.why === "busy"
          ? l.busy(h)
          : host.connected
            ? l.reading(h)
            : `${l.reading(h)} ${l.checkedLater}`
        : t.state === "answering"
          ? t.doing === "needs-you"
            ? l.needsYou(h)
            : t.doing === "tool"
              ? l.tool
              : t.doing === "thinking" || !t.reply
                ? l.thinking
                : undefined
          : t.state === "answered"
            ? !t.reply
              ? l.noReply(h)
              : t.ended === "interrupted"
                ? l.stopped
                : t.ended === "error"
                  ? l.errored
                  : undefined
            : undefined;
  const why =
    t.state === "failed"
      ? `${l.notSent(h)} ${t.cause === "closed" ? l.closed : t.cause === "never" ? l.never(h) : sentence(t.reason)}`.trim()
      : t.state === "unknown"
        ? l.unknown(h)
        : undefined;
  const live = t.state === "sending" || t.state === "answering" || (t.state === "waiting" && t.why === "reading" && host.connected);
  const reply = t.state === "answering" || t.state === "answered" ? t.reply : "";
  return (
    <div className="ask-target" data-profile={t.profile} data-state={t.state}>
      <div className="ask-who">
        {bot ? <BotFace bot={bot} size="xs" /> : <AtSign size={13} aria-hidden />}
        <span className="ask-name" translate="no">
          {bot?.name ?? t.name}
        </span>
        <span className="ask-handle" translate="no">
          @{h}
        </span>
        {live && <Spinner />}
      </div>
      {reply && (
        <div className="returned-body msg assistant" translate="no">
          <Markdown text={reply} query="" />
        </div>
      )}
      {note && <p className="ask-note">{note}</p>}
      {!bot && <p className="ask-note">{l.gone(h)}</p>}
      {failed ? (
        <div className={`send-failed ${t.state}`} role="alert">
          <div className="send-failed-why">
            <CircleAlert size={13} />
            <span>{why}</span>
          </div>
          <div className="send-failed-actions">
            <button className="btn" onClick={() => host.dismiss(ask.id, t.profile)}>
              {l.dismiss}
            </button>
            {t.state === "failed" && host.edit && (
              <button className="btn" onClick={() => host.edit?.(ask.id)}>
                {l.edit}
              </button>
            )}
            {bot && (
              <button className="btn primary" onClick={() => host.retry(ask.id, t.profile)} disabled={!host.connected} title={l.retryTip}>
                <RotateCcw size={13} /> {l.retry}
              </button>
            )}
          </div>
        </div>
      ) : (
        bot &&
        t.state !== "sending" && (
          <div className="ask-actions">
            <button className="btn small-btn" onClick={() => host.open(t.profile)}>
              {l.open(h)}
            </button>
            {t.state === "answered" && (
              <button className="btn small-btn" onClick={() => host.dismiss(ask.id, t.profile)}>
                {l.dismiss}
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
}

export function AskCard({ ask }: { ask: Ask }) {
  const l = useLocale().chat.ask;
  const host = useContext(AskContext);
  if (!host) return null;
  return (
    <TurnCard kind="ask" icon={<AtSign size={14} aria-hidden />} heading={l.asked(ask.targets.map((t) => t.handle))} tips={l} data-ask={ask.id}>
      <div className="ask-words" translate="no">
        {ask.text}
      </div>
      {ask.titles.length > 0 && (
        <div className="msg-files">
          {ask.titles.map((title) => (
            <span key={title} className="chip ref-chip">
              <Link2 size={12} aria-hidden />
              <span className="chip-name" translate="no">
                {l.referenced(title)}
              </span>
            </span>
          ))}
        </div>
      )}
      {ask.targets.map((t) => (
        <TargetLine key={t.profile} ask={ask} t={t} host={host} />
      ))}
    </TurnCard>
  );
}
