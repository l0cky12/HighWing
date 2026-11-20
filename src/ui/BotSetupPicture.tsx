// The Picture row of Bot setup's card (ADR 0235): a picture shown by its key, and under the row the set Highwing
// ships as a strip and Upload your own…, which opens the picture picker Edit bot uses. A picture is only ever drawn
// from bytes the app holds: the set's, the owner's upload, or the bot's picture as Hermes sent it. What the bot wrote
// is never an image source.
import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import type { BotPictureName } from "../hermes/botSetupBrief";
import { useLocale, type Locale } from "../i18n/locale";
import { PicturePicker, PictureSet, type SetPicture } from "./PicturePicker";

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

/**
 * The set as a strip, the pick marked, and Upload your own…, which opens the picture picker on its Upload tab.
 * `picked`: the key of the picture the row has now. `onPick` gets the chosen picture as a data URL.
 */
export function PictureStrip({ set, picked, onPick }: { set: readonly SetPicture[]; picked: string | null; onPick: (dataUrl: string) => void }) {
  const l = useLocale().chat.botSetup;
  const anchor = useRef<HTMLSpanElement>(null);
  const [uploading, setUploading] = useState(false);
  return (
    <div className="bot-setup-picker">
      <PictureSet set={set} picked={picked} className="bot-setup-pictures" onPick={(p) => onPick(p.url)} />
      <div className="bot-setup-run">
        <span ref={anchor} className="picture-anchor">
          <button className="btn" aria-haspopup="dialog" aria-expanded={uploading} onClick={() => setUploading(true)}>
            <Upload size={13} aria-hidden /> {l.pictureUpload}
          </button>
          {uploading && <PicturePicker anchor={anchor} set={set} picked={picked} tab="upload" onUse={onPick} onClose={() => setUploading(false)} />}
        </span>
      </div>
    </div>
  );
}
