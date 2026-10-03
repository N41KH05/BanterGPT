// Link-preview images (1200×630 PNG) for shared threads: the thread's topic in big letters and
// its best roast underneath. Drawn as SVG and turned into a PNG on the server, so Discord,
// WhatsApp, X and co. show a real preview. Server-only (needs @resvg/resvg-js and the fonts).

import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
let Resvg = null;
let fontFiles = [];
try {
  ({ Resvg } = require("@resvg/resvg-js"));
  const font = (pkg, file) => path.join(path.dirname(require.resolve(`${pkg}/package.json`)), file);
  fontFiles = [
    font("@expo-google-fonts/anton", "400Regular/Anton_400Regular.ttf"),
    font("@expo-google-fonts/inter", "400Regular/Inter_400Regular.ttf"),
    font("@expo-google-fonts/inter", "700Bold/Inter_700Bold.ttf"),
  ];
} catch (err) {
  console.warn(`[og] preview images off (${err.message})`);
}
export const previewsAvailable = () => Boolean(Resvg);

const W = 1200;
const H = 630;
const C = { paper: "#f4efe4", card: "#fffdf7", ink: "#161412", ink2: "#4a453e", ink3: "#8a8378", accent: "#d6331f" };

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// no emoji font on the server: drop them rather than draw empty boxes
const plain = (t) => String(t).replace(/\p{Extended_Pictographic}|️|‍|[\u{1F3FB}-\u{1F3FF}]/gu, "").replace(/\s+/g, " ").trim();

// greedy word wrap by estimated width (average glyph width as a share of the font size)
function wrap(text, size, maxWidth, widthFactor, maxLines) {
  const perLine = Math.max(8, Math.floor(maxWidth / (size * widthFactor)));
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= perLine || !line) line = next.length > perLine ? next.slice(0, perLine) : next;
    else {
      lines.push(line);
      line = word.slice(0, perLine);
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "") + "…";
  }
  return lines;
}

// biggest size (from..to) at which the text fits in maxLines
function fit(text, from, to, maxWidth, widthFactor, maxLines) {
  for (let size = from; size >= to; size -= 4) {
    const lines = wrap(text, size, maxWidth, widthFactor, 99);
    if (lines.length <= maxLines) return { size, lines };
  }
  return { size: to, lines: wrap(text, to, maxWidth, widthFactor, maxLines) };
}

const tspans = (lines, x, y, lh) => lines.map((l, i) => `<tspan x="${x}" y="${y + i * lh}">${esc(l)}</tspan>`).join("");

export function threadPreviewSvg({ tag, title, roast, replies, site }) {
  const x = 96;
  const maxW = W - 2 * x;
  const top = 150; // below the logo row
  const bottom = H - 118; // above the footer line
  const headText = plain(title).toUpperCase();
  const quote = roast ? plain(roast.text) : "";

  // shrink the headline and the roast together until both fit between logo and footer
  let layout = null;
  for (let hs = roast ? 76 : 112; hs >= 40 && !layout; hs -= 4) {
    const head = wrap(headText, hs, maxW, 0.42, roast ? 3 : 4);
    const headH = head.length * hs * 1.12;
    if (!roast) {
      if (top + headH <= bottom || hs <= 40) layout = { hs, head, rs: 0, body: [] };
      continue;
    }
    for (let rs = 34; rs >= 24; rs -= 2) {
      const body = wrap(quote, rs, maxW - 40, 0.5, 3);
      const roastH = 40 + body.length * rs * 1.3;
      if (top + headH + 44 + roastH <= bottom) {
        layout = { hs, head, rs, body };
        break;
      }
    }
  }
  if (!layout) layout = { hs: 40, head: wrap(headText, 40, maxW, 0.42, 2), rs: 24, body: wrap(quote, 24, maxW - 40, 0.5, 2) };
  const { hs, head, rs, body } = layout;
  const headY = top + hs * 0.86;
  const headBottom = top + head.length * hs * 1.12;

  let roastSvg = "";
  if (roast) {
    const y = headBottom + 44;
    const lh = rs * 1.3;
    const blockH = 40 + body.length * lh;
    roastSvg = `
      <rect x="${x}" y="${y}" width="8" height="${blockH}" fill="${C.accent}"/>
      <text x="${x + 32}" y="${y + 28}" font-family="Inter" font-weight="700" font-size="28" fill="${C.ink}">@${esc(plain(roast.handle))}${roast.label ? ` <tspan fill="${C.accent}" font-size="22">· ${esc(roast.label)}</tspan>` : ""}</text>
      <text font-family="Inter" font-size="${rs}" fill="${C.ink2}">${tspans(body, x + 32, y + 36 + rs, lh)}</text>`;
  }
  const tagW = 28 + tag.length * 13;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="${C.paper}"/>
    <rect x="44" y="44" width="${W - 76}" height="${H - 76}" fill="${C.ink}"/>
    <rect x="32" y="32" width="${W - 76}" height="${H - 76}" fill="${C.card}" stroke="${C.ink}" stroke-width="4"/>
    <text x="${x}" y="112" font-family="Anton" font-size="46" fill="${C.ink}">BANTER<tspan fill="${C.accent}">GPT</tspan></text>
    <rect x="${W - x - tagW}" y="78" width="${tagW}" height="40" fill="${C.accent}"/>
    <text x="${W - x - tagW / 2}" y="106" text-anchor="middle" font-family="Inter" font-weight="700" font-size="20" fill="#ffffff">${esc(tag.toUpperCase())}</text>
    <text font-family="Anton" font-size="${hs}" fill="${C.ink}">${tspans(head, x, headY, hs * 1.12)}</text>
    ${roastSvg}
    <line x1="${x}" y1="${H - 100}" x2="${W - x}" y2="${H - 100}" stroke="${C.ink}" stroke-width="2"/>
    <text x="${x}" y="${H - 66}" font-family="Inter" font-weight="700" font-size="24" fill="${C.ink3}">${esc(site)}</text>
    <text x="${W - x}" y="${H - 66}" text-anchor="end" font-family="Inter" font-weight="700" font-size="24" fill="${C.accent}">${replies ? `${replies} repl${replies === 1 ? "y" : "ies"} · watch the fight →` : "watch the fight →"}</text>
  </svg>`;
}

export function renderPng(svg) {
  if (!Resvg) return null;
  const r = new Resvg(svg, { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: "Inter" }, fitTo: { mode: "width", value: W } });
  return r.render().asPng();
}
