// Reads run.sh's and chromium.mjs's JSON lines (one or more files) and prints, per page and build, the median and
// range of each measure. With --svg <file> it also writes a chart: the scroll-spy's script time per change of the
// current jump link (Chromium), and the app's CPU per scroll to the foot and back (WebKitGTK).
//   node bench/settings-scroll/summary.mjs <in.jsonl>... [--svg chart.svg]
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const svgAt = args.indexOf("--svg");
const svgOut = svgAt >= 0 ? args[svgAt + 1] : undefined;
const files = args.filter((a, i) => a !== "--svg" && i !== svgAt + 1);
const rows = files.flatMap((f) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)));
const pages = [...new Set(rows.map((r) => r.page))];
const labels = ["before", "after"];
const med = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const show = (xs) => (xs.length ? `${Math.round(med(xs) * 100) / 100} (${Math.min(...xs)}–${Math.max(...xs)})` : "–");

const table = {};
const measures = {};
for (const page of pages) {
  for (const label of labels) {
    const of = (kind) => rows.filter((r) => r.page === page && r.label === label && r.kind === kind);
    const wheel = of("wheel");
    const chromium = of("chromium");
    const m = {
      scriptMs: chromium.map((r) => r.change.scriptMs),
      sameScriptMs: chromium.map((r) => r.same.scriptMs),
      cpuMs: wheel.map((r) => r.cpuMs),
      longFrames: wheel.map((r) => r.probe.intervalMs.over20),
      maxFrameMs: wheel.map((r) => r.probe.intervalMs.max),
      linkChanges: wheel.map((r) => r.probe.linkChanges),
    };
    measures[`${page} | ${label}`] = m;
    table[`${page} | ${label}`] = {
      runs: `${chromium.length} chromium, ${wheel.length} wheel`,
      "script ms per link change": show(m.scriptMs),
      "script ms per scroll, no change": show(m.sameScriptMs),
      "app CPU ms per pass": show(m.cpuMs),
      "frames > 20 ms": show(m.longFrames),
      "longest frame ms": show(m.maxFrameMs),
      "link changes per pass": show(m.linkChanges),
      "bad samples":
        wheel.filter((r) => r.probe.bareFrames - r.probe.frames > 1 || r.probe.endTop !== 0).length + chromium.filter((r) => r.change.changed < 99 || r.same.changed > 1).length,
    };
  }
}
console.table(table);

if (svgOut) {
  const color = { before: "#eb6834", after: "#2a78d6" };
  const ink = { primary: "#1f1f1e", secondary: "#5f5e5a", grid: "#e4e3df", surface: "#fcfcfb" };
  const runs = (key) => Math.min(...Object.values(measures).map((m) => m[key].length));
  const overlap = (key) =>
    pages.filter((page) => {
      const [b, a] = labels.map((l) => measures[`${page} | ${l}`][key]);
      return Math.min(...b) <= Math.max(...a) && Math.min(...a) <= Math.max(...b);
    }).length;
  const note = (key, what) => [`${what}, ${runs(key)} per build`, `Ranges overlap on ${overlap(key)} of ${pages.length} pages`];
  const panels = [
    { key: "scriptMs", title: "Script time per section change", note: note("scriptMs", "Chromium runs of 100 changes") },
    { key: "cpuMs", title: "App CPU per scroll down and back", note: note("cpuMs", "WebKitGTK wheel passes") },
  ];
  const W = 900, left = 150, plotW = 250, panelW = 360, rowH = 36, barH = 12, gap = 2, top = 128;
  const H = top + pages.length * rowH + 44;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const fmt = (v) => (v < 10 ? v.toFixed(2) : String(Math.round(v)));
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif">`;
  svg += `<rect width="${W}" height="${H}" fill="${ink.surface}"/>`;
  svg += `<text x="24" y="32" font-size="16" font-weight="600" fill="${ink.primary}">Settings scrolling before and after (median, milliseconds, lower is better)</text>`;
  labels.forEach((l, i) => {
    const x = 24 + i * 100;
    svg += `<rect x="${x}" y="48" width="12" height="12" rx="2" fill="${color[l]}"/><text x="${x + 18}" y="58" font-size="12" fill="${ink.secondary}">${l === "before" ? "Before" : "After"}</text>`;
  });
  panels.forEach((p, pi) => {
    const x0 = left + pi * panelW;
    const max = Math.max(...pages.flatMap((page) => labels.map((l) => med(measures[`${page} | ${l}`][p.key]))));
    svg += `<text x="${x0}" y="${top - 42}" font-size="13" font-weight="600" fill="${ink.primary}">${esc(p.title)}</text>`;
    p.note.forEach((line, i) => (svg += `<text x="${x0}" y="${top - 26 + i * 14}" font-size="11" fill="${ink.secondary}">${esc(line)}</text>`));
    svg += `<line x1="${x0}" y1="${top - 2}" x2="${x0}" y2="${top + pages.length * rowH - 6}" stroke="${ink.grid}"/>`;
    pages.forEach((page, i) => {
      const y = top + i * rowH;
      if (pi === 0) svg += `<text x="${left - 12}" y="${y + barH + 2}" font-size="12" text-anchor="end" fill="${ink.secondary}">${esc(page)}</text>`;
      labels.forEach((l, li) => {
        const v = med(measures[`${page} | ${l}`][p.key]);
        const w = Math.max(5, (v / max) * plotW);
        const by = y + li * (barH + gap);
        svg += `<path d="M${x0} ${by}h${w - 4}a4 4 0 0 1 4 4v${barH - 8}a4 4 0 0 1 -4 4h${-(w - 4)}z" fill="${color[l]}"><title>${esc(page)}, ${l}: ${fmt(v)} ms</title></path>`;
        svg += `<text x="${x0 + w + 6}" y="${by + barH - 2}" font-size="11" fill="${ink.secondary}">${fmt(v)}</text>`;
      });
    });
  });
  svg += `<text x="24" y="${H - 16}" font-size="11" fill="${ink.secondary}">Stand-in server, 1400 × 900 window. WebKitGTK passes ran under Xvfb with real X wheel input, alternating builds.</text>`;
  svg += "</svg>\n";
  writeFileSync(svgOut, svg);
  console.log(`wrote ${svgOut}`);
}
