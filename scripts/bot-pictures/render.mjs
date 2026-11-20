// Renders Bot setup's picture set (ADR 0235): each SVG here becomes a 256×256 PNG in src/assets/bot-pictures/, with
// no metadata, so the same source always gives the same bytes. Needs rsvg-convert and ImageMagick.
//
//     node scripts/bot-pictures/render.mjs
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../../src/assets/bot-pictures");

for (const file of readdirSync(here).filter((f) => f.endsWith(".svg")).sort()) {
  const svg = execFileSync("rsvg-convert", ["-w", "256", "-h", "256", join(here, file)]);
  const png = execFileSync("magick", ["png:-", "-strip", "-define", "png:exclude-chunks=date,time", "-define", "png:compression-level=9", "png:-"], { input: svg });
  writeFileSync(join(out, file.replace(/\.svg$/, ".png")), png);
  console.log(`${file.replace(/\.svg$/, ".png")} ${png.length} bytes`);
}
