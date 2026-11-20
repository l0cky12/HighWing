// Draws the pictures Bot setup's card offers (#86, ADR 0235) and writes each as a 256 px PNG to
// src/assets/bot-pictures/. Rerun after changing a shape or a colour:  node scripts/bot-pictures.mjs
// The style is the app icon's: a dark silhouette on a warm vertical gradient with a soft top highlight, light details
// like the eagle's eye. Every client crops a bot's picture to a circle, so the tile is full-bleed and each figure stays
// inside the middle circle.
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const OUT = fileURLToPath(new URL("../src/assets/bot-pictures/", import.meta.url));
const SIZE = 256;
const INK = "#19110d";
const LIGHT = "#f4dccb";

const rotated = (deg, body) => `<g transform="rotate(${deg} 256 256)">${body}</g>`;

/** Each picture: its gradient, top to bottom, and its figure on a 512 box. Names match BOT_PICTURES in botSetupBrief.ts. */
const PICTURES = {
  plane: {
    tile: ["#df9d80", "#c27859"],
    figure: rotated(
      45,
      `<path transform="translate(256 256) scale(.92) translate(-256 -256)" fill="${INK}" d="M256 96C272 96 280 112 280 132L280 214L408 290L408 322L280 284L280 362L318 392L318 416L256 398L194 416L194 392L232 362L232 284L104 322L104 290L232 214L232 132C232 112 240 96 256 96Z"/>`,
    ),
  },
  moon: {
    tile: ["#9ea7e8", "#6571c2"],
    figure: `<path fill="${INK}" d="M228 136.7A120 120 0 1 0 355.2 289.3A100 100 0 0 1 228 136.7Z"/>
      <path fill="${LIGHT}" d="M356 140L366 166L392 176L366 186L356 212L346 186L320 176L346 166Z"/>`,
  },
  sun: {
    tile: ["#f5c76a", "#df963a"],
    figure: `<circle cx="256" cy="256" r="74" fill="${INK}"/>
      ${[0, 45, 90, 135, 180, 225, 270, 315].map((d) => rotated(d, `<rect x="241" y="98" width="30" height="58" rx="15" fill="${INK}"/>`)).join("")}
      <path d="M222 238a14 14 0 0 1 28 0M262 238a14 14 0 0 1 28 0" fill="none" stroke="${LIGHT}" stroke-width="10" stroke-linecap="round"/>
      <path d="M224 274q32 26 64 0" fill="none" stroke="${LIGHT}" stroke-width="10" stroke-linecap="round"/>`,
  },
  book: {
    tile: ["#cf9fc6", "#9a6492"],
    figure: `<path fill="${INK}" d="M256 186C222 160 164 152 112 160L112 344C164 336 222 344 256 370ZM256 186C290 160 348 152 400 160L400 344C348 336 290 344 256 370Z"/>
      <path d="M142 204C178 198 212 204 234 216M142 244C178 238 212 244 234 256M142 284C178 278 212 284 234 296M370 204C334 198 300 204 278 216M370 244C334 238 300 244 278 256" fill="none" stroke="${LIGHT}" stroke-width="10" stroke-linecap="round" opacity=".9"/>`,
  },
  pen: {
    tile: ["#b5d0a2", "#7ea26b"],
    figure: rotated(
      45,
      `<rect x="226" y="96" width="60" height="44" rx="12" fill="${INK}"/>
      <rect x="226" y="140" width="60" height="22" fill="${LIGHT}"/>
      <rect x="226" y="162" width="60" height="186" fill="${INK}"/>
      <path d="M226 348L286 348L256 420Z" fill="${INK}"/>
      <path d="M240 348L272 348L256 386Z" fill="${LIGHT}" opacity=".9"/>`,
    ),
  },
  wrench: {
    tile: ["#adbccb", "#71859a"],
    figure: rotated(
      45,
      `<path fill="${INK}" d="M236 91.3L236 150L276 150L276 91.3A62 62 0 1 1 236 91.3Z"/>
      <rect x="230" y="190" width="52" height="210" rx="26" fill="${INK}"/>
      <circle cx="256" cy="370" r="13" fill="${LIGHT}"/>`,
    ),
  },
  chart: {
    tile: ["#93d1c6", "#4f9e93"],
    figure: `<rect x="146" y="284" width="56" height="92" rx="10" fill="${INK}"/>
      <rect x="228" y="226" width="56" height="150" rx="10" fill="${INK}"/>
      <rect x="310" y="166" width="56" height="210" rx="10" fill="${INK}"/>
      <rect x="124" y="388" width="264" height="18" rx="9" fill="${INK}"/>
      <path d="M150 238L220 180L268 204L352 126" fill="none" stroke="${LIGHT}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M322 122L356 122L356 156" fill="none" stroke="${LIGHT}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  leaf: {
    tile: ["#acd68f", "#5f9e4a"],
    figure: `<path fill="${INK}" d="M152 360C146 224 238 140 384 128C384 272 300 366 152 360Z"/>
      <path d="M152 360L116 396" stroke="${INK}" stroke-width="22" stroke-linecap="round"/>
      <path d="M172 340C232 282 290 222 350 162M226 286L224 228M268 244L326 246" fill="none" stroke="${LIGHT}" stroke-width="10" stroke-linecap="round" opacity=".9"/>`,
  },
  pot: {
    tile: ["#f1a99f", "#cc6c60"],
    figure: `<path fill="${INK}" d="M138 228L374 228L374 330C374 356 352 378 326 378L186 378C160 378 138 356 138 330Z"/>
      <rect x="100" y="244" width="52" height="26" rx="13" fill="${INK}"/>
      <rect x="360" y="244" width="52" height="26" rx="13" fill="${INK}"/>
      <path fill="${INK}" d="M128 216C146 172 366 172 384 216Z"/>
      <circle cx="256" cy="172" r="18" fill="${INK}"/>
      <rect x="160" y="256" width="192" height="12" rx="6" fill="${LIGHT}" opacity=".9"/>
      <path d="M210 146q-14-18 0-36M256 136q-14-18 0-36M302 146q-14-18 0-36" fill="none" stroke="${LIGHT}" stroke-width="10" stroke-linecap="round"/>`,
  },
  compass: {
    tile: ["#e6c493", "#b88b52"],
    figure: `<circle cx="256" cy="256" r="146" fill="${INK}"/>
      ${rotated(
        45,
        `<path fill="${LIGHT}" d="M256 132L288 256L224 256Z"/>
        <path fill="#b88b52" d="M256 380L288 256L224 256Z"/>`,
      )}
      <circle cx="256" cy="256" r="14" fill="${INK}"/>
      ${[0, 90, 180, 270].map((d) => rotated(d, `<rect x="250" y="120" width="12" height="20" rx="6" fill="${LIGHT}" opacity=".8"/>`)).join("")}`,
  },
};

const svg = ({ tile: [top, bottom], figure }) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${SIZE}" height="${SIZE}">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".3"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#tile)"/>
  <rect width="512" height="512" fill="url(#rim)"/>
  ${figure}
</svg>`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
  for (const [name, picture] of Object.entries(PICTURES)) {
    await page.setContent(`<!doctype html><style>html,body{margin:0}svg{display:block}</style>${svg(picture)}`);
    await page.locator("svg").screenshot({ path: `${OUT}${name}.png` });
    console.log(`${name}.png`);
  }
} finally {
  await browser.close();
}
