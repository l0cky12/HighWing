// Bot setup's picture set (ADR 0235) as bytes, and the keys the card compares pictures by. A key names a picture
// without carrying it, so a plan, the accepted record and the ready turn never hold image data: `set:<name>` for one
// of the set, `photo:<hash>` for any other bytes, such as an upload or a picture another client gave the bot. Hermes
// labels a picture by the format it sniffs (ADR 0189), so a key is made from the bytes alone.
import book from "../assets/bot-pictures/book.png?inline";
import chart from "../assets/bot-pictures/chart.png?inline";
import code from "../assets/bot-pictures/code.png?inline";
import compass from "../assets/bot-pictures/compass.png?inline";
import leaf from "../assets/bot-pictures/leaf.png?inline";
import moon from "../assets/bot-pictures/moon.png?inline";
import music from "../assets/bot-pictures/music.png?inline";
import paw from "../assets/bot-pictures/paw.png?inline";
import plane from "../assets/bot-pictures/plane.png?inline";
import pot from "../assets/bot-pictures/pot.png?inline";
import rocket from "../assets/bot-pictures/rocket.png?inline";
import sun from "../assets/bot-pictures/sun.png?inline";
import { BOT_SETUP_PICTURES, type BotSetupPicture } from "./botSetupBrief";
import { payloadOf } from "./bots";
import { fingerprint } from "./values";

/** Each picture of the set as a data URL. */
export const BOT_PICTURE_DATA: Readonly<Record<BotSetupPicture, string>> = { plane, moon, book, leaf, rocket, compass, music, chart, code, paw, pot, sun };

export type PictureKey = `set:${BotSetupPicture}` | `photo:${string}`;

/** What a key may look like in a record read back from Hermes. */
export const PICTURE_KEY = /^(set:[a-z]+|photo:[0-9a-f]{16})$/;

const setByPayload = new Map(BOT_SETUP_PICTURES.map((name) => [payloadOf(BOT_PICTURE_DATA[name]), name]));

/** The key of a picture's bytes, given as a data URL, or null for none. */
export function pictureKey(dataUrl: string): PictureKey;
export function pictureKey(dataUrl: string | null): PictureKey | null;
export function pictureKey(dataUrl: string | null): PictureKey | null {
  if (dataUrl === null) return null;
  const payload = payloadOf(dataUrl);
  const name = setByPayload.get(payload);
  return name ? `set:${name}` : `photo:${fingerprint(payload)}`;
}

/** The set's name a key gives, if it is one of the set. */
export const setPicture = (key: string | null): BotSetupPicture | undefined => BOT_SETUP_PICTURES.find((name) => key === `set:${name}`);

/**
 * The bytes for a key, as a data URL: the set's own, or an upload the card holds by its key. Null for none, and
 * undefined when the card no longer holds the upload.
 */
export function pictureData(key: string | null, uploads: Readonly<Record<string, string>>): string | null | undefined {
  if (key === null) return null;
  const name = setPicture(key);
  return name ? BOT_PICTURE_DATA[name] : uploads[key];
}
