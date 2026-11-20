// The pictures Bot setup's card offers (ADR 0235), each as a data URL built into the app, so the bytes Set it up
// sends are the app's own and the card draws them with no request. The names are the brief's (`BOT_PICTURES`).
import type { BotPictureName } from "./botSetupBrief";
import book from "../assets/bot-pictures/book.png?inline";
import chart from "../assets/bot-pictures/chart.png?inline";
import compass from "../assets/bot-pictures/compass.png?inline";
import leaf from "../assets/bot-pictures/leaf.png?inline";
import moon from "../assets/bot-pictures/moon.png?inline";
import pen from "../assets/bot-pictures/pen.png?inline";
import plane from "../assets/bot-pictures/plane.png?inline";
import pot from "../assets/bot-pictures/pot.png?inline";
import sun from "../assets/bot-pictures/sun.png?inline";
import wrench from "../assets/bot-pictures/wrench.png?inline";

export const BOT_PICTURE_URLS: Readonly<Record<BotPictureName, string>> = { plane, moon, sun, book, pen, wrench, chart, leaf, pot, compass };
