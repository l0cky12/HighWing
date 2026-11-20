// The Picture row of Bot setup's card (ADR 0235): a picture shown by its key, and the picker under the row, which is
// the set Highwing ships as a strip and Upload your own… with Edit bot's rules. A picture is only ever drawn from
// bytes the app holds: the set's, the owner's upload, or the bot's picture as Hermes sent it. What the bot wrote is
// never an image source.
import { useRef, useState, type KeyboardEvent } from "react";
import { Upload } from "lucide-react";
import type { BotPictureName } from "../hermes/botSetupBrief";
import { useLocale, type Locale } from "../i18n/locale";
import { PICTURE_TYPES, pictureProblemText, readPictureFile } from "./pictureFile";

/** One of the set's pictures, with its bytes as a data URL and their key. */
export type SetPicture = { name: BotPictureName; key: string; url: string };

/** What a picture key stands for on the card. `yours`: the owner's upload. `now`: the bot's picture, not the set's. */
export type ShownPicture = { kind: "none"; url?: undefined } | { kind: "set"; name: BotPictureName; url: string } | { kind: "yours" | "now"; url?: string };

export const pictureWords = (l: Locale["chat"]["botSetup"], p: ShownPicture) =>
  p.kind === "none" ? l.none : p.kind === "set" ? l.pictureNamed(l.pictures[p.name], l.pictureFor[p.name]) : p.kind === "yours" ? l.pictureYours : l.pictureNow;

export function Picture({ picture }: { picture: ShownPicture }) {
  const l = useLocale().chat.botSetup;
  return (
    <span className="bot-setup-picture">
      {picture.url && <img src={picture.url} alt="" />}
      {pictureWords(l, picture)}
    </span>
  );
}

const STEP: Record<string, (at: number, n: number) => number> = {
  ArrowRight: (at, n) => (at + 1) % n,
  ArrowDown: (at, n) => (at + 1) % n,
  ArrowLeft: (at, n) => (at - 1 + n) % n,
  ArrowUp: (at, n) => (at - 1 + n) % n,
  Home: () => 0,
  End: (_, n) => n - 1,
};

/**
 * The set as a strip, the pick marked, and Upload your own…. The strip is one tab stop: arrow keys, Home and End move
 * along it, and Enter or Space chooses the picture in focus. `picked`: the key of the picture the row has now.
 */
export function PicturePicker({ set, picked, onPick, onUpload }: { set: readonly SetPicture[]; picked: string | null; onPick: (key: string) => void; onUpload: (dataUrl: string) => void }) {
  const loc = useLocale();
  const l = loc.chat.botSetup;
  const f = loc.profiles.form;
  const strip = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string>();
  const stop = Math.max(0, set.findIndex((p) => p.key === picked));
  const move = (e: KeyboardEvent, at: number) => {
    const step = STEP[e.key];
    if (!step) return;
    e.preventDefault();
    strip.current?.querySelectorAll<HTMLElement>("[role=radio]")[step(at, set.length)]?.focus();
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    const read = await readPictureFile(file);
    if (read.ok) onUpload(read.dataUrl);
    setNote(read.ok ? undefined : pictureProblemText(f, read.why));
  };
  return (
    <div className="bot-setup-picker">
      <div ref={strip} className="bot-setup-pictures" role="radiogroup" aria-label={l.pictureSet}>
        {set.map((p, i) => {
          const words = l.pictureNamed(l.pictures[p.name], l.pictureFor[p.name]);
          return (
            <button key={p.name} type="button" role="radio" aria-checked={p.key === picked} aria-label={words} title={words} tabIndex={i === stop ? 0 : -1} onClick={() => onPick(p.key)} onKeyDown={(e) => move(e, i)}>
              <img src={p.url} alt="" />
            </button>
          );
        })}
      </div>
      <div className="bot-setup-run">
        <input
          ref={input}
          type="file"
          hidden
          accept={PICTURE_TYPES.join(",")}
          aria-label={l.pictureUpload}
          onChange={(e) => {
            void upload(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <button className="btn" onClick={() => input.current?.click()}>
          <Upload size={13} aria-hidden /> {l.pictureUpload}
        </button>
        <span className="bot-setup-sub">{f.pictureHint}</span>
      </div>
      {note && (
        <div className="bot-setup-sub bot-setup-bad" role="alert">
          {note}
        </div>
      )}
    </div>
  );
}
