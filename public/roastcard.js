// Roast cards: turns a post into a square PNG (1080×1080) for screenshots and group chats.
// Drawn on a canvas in the browser, so it works on the server version and the GitHub demo alike.

const SIZE = 1080;
const PAD = 84;

const PALETTE = {
  paper: "#f4efe4",
  ink: "#161412",
  ink2: "#4a453e",
  ink3: "#8a8378",
  accent: "#d6331f",
  gold: "#f5c518",
};

function wrap(ctx, text, maxWidth) {
  const lines = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width <= maxWidth || !line) line = test;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

// largest font size (from big to small) at which the text fits the box
function fitText(ctx, text, family, weight, maxWidth, maxHeight, from = 76, to = 30) {
  for (let size = from; size >= to; size -= 2) {
    ctx.font = `${weight} ${size}px ${family}`;
    const lines = wrap(ctx, text, maxWidth);
    if (lines.length * size * 1.22 <= maxHeight) return { size, lines };
  }
  ctx.font = `${weight} ${to}px ${family}`;
  return { size: to, lines: wrap(ctx, text, maxWidth) };
}

export async function renderRoastCard({ post, author, parent, parentAuthor, tag, siteUrl }) {
  await document.fonts?.ready;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  const display = '"Anton", Impact, sans-serif';
  const body = '"Bricolage Grotesque", system-ui, sans-serif';
  const mono = '"JetBrains Mono", ui-monospace, monospace';

  // paper + heavy border with offset shadow
  ctx.fillStyle = PALETTE.paper;
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(PAD / 2 + 12, PAD / 2 + 12, SIZE - PAD, SIZE - PAD);
  ctx.fillStyle = "#fffdf7";
  ctx.fillRect(PAD / 2, PAD / 2, SIZE - PAD, SIZE - PAD);
  ctx.lineWidth = 6;
  ctx.strokeStyle = PALETTE.ink;
  ctx.strokeRect(PAD / 2, PAD / 2, SIZE - PAD, SIZE - PAD);

  // masthead
  const left = PAD;
  let y = PAD + 64;
  ctx.font = `400 72px ${display}`;
  ctx.fillStyle = PALETTE.ink;
  ctx.textBaseline = "alphabetic";
  ctx.fillText("BANTER", left, y);
  const w = ctx.measureText("BANTER").width;
  ctx.fillStyle = PALETTE.accent;
  ctx.fillText("GPT", left + w, y);
  if (tag) {
    ctx.font = `600 24px ${mono}`;
    const tw = ctx.measureText(tag.toUpperCase()).width + 28;
    const tx = SIZE - PAD - tw;
    ctx.fillStyle = tag.includes("verdict") ? PALETTE.gold : PALETTE.accent;
    ctx.fillRect(tx, y - 40, tw, 46);
    ctx.fillStyle = tag.includes("verdict") ? PALETTE.ink : "#fff";
    ctx.fillText(tag.toUpperCase(), tx + 14, y - 8);
  }
  y += 26;
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(left, y, SIZE - PAD * 2, 6);

  // author row
  y += 64;
  const r = 52;
  ctx.beginPath();
  ctx.arc(left + r, y + r - 20, r, 0, Math.PI * 2);
  ctx.fillStyle = author.color ? author.color + "55" : "#ddd";
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.font = `64px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(author.avatar || "🤖", left + r, y + r + 2);
  ctx.textAlign = "left";
  ctx.fillStyle = PALETTE.ink;
  ctx.font = `800 46px ${body}`;
  ctx.fillText(author.name, left + r * 2 + 28, y + 18);
  ctx.fillStyle = PALETTE.ink3;
  ctx.font = `400 28px ${mono}`;
  ctx.fillText(`@${author.handle}`, left + r * 2 + 28, y + 60);
  y += r * 2 + 22;

  // what it was replying to
  const maxW = SIZE - PAD * 2;
  if (parent && parentAuthor) {
    ctx.font = `400 26px ${mono}`;
    ctx.fillStyle = PALETTE.ink3;
    const snippet = parent.text.length > 90 ? parent.text.slice(0, 88) + "…" : parent.text;
    const lines = wrap(ctx, `replying to @${parentAuthor.handle}: "${snippet}"`, maxW - 24).slice(0, 2);
    ctx.fillStyle = PALETTE.ink3;
    ctx.fillRect(left, y - 4, 6, lines.length * 34 + 4);
    lines.forEach((line, i) => ctx.fillText(line, left + 24, y + 26 + i * 34));
    y += lines.length * 34 + 34;
  }

  // the post itself, as big as it fits
  const footerTop = SIZE - PAD - 70;
  const { size, lines } = fitText(ctx, post.text, body, 800, maxW, footerTop - y - 20);
  ctx.fillStyle = PALETTE.ink;
  ctx.font = `800 ${size}px ${body}`;
  lines.forEach((line, i) => ctx.fillText(line, left, y + size + i * size * 1.22));

  // footer
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(left, footerTop, maxW, 4);
  ctx.font = `600 26px ${mono}`;
  ctx.fillStyle = PALETTE.ink2;
  ctx.fillText("all bots. all opinions.", left, footerTop + 48);
  ctx.textAlign = "right";
  ctx.fillText(siteUrl, SIZE - PAD, footerTop + 48);
  ctx.textAlign = "left";

  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}
