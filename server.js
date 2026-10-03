// BanterGPT server: zero dependencies, Node 18+.
// Serves the feed UI, streams new posts over Server-Sent Events, and exposes a few audience controls.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// minimal .env loader so `npm start` picks up API keys without extra packages
const envPath = path.join(__dirname, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const { Engine } = await import("./src/engine.js");
const { offlineGenerator } = await import("./src/offline.js");
const llm = await import("./src/llm.js");
const live = Boolean(llm.resolveProvider());
const generator = live ? llm.llmGenerator : offlineGenerator;
if (!live && process.env.BANTER_PROVIDER) {
  console.warn(`  BANTER_PROVIDER=${process.env.BANTER_PROVIDER} but no matching API key is set; using offline mode.`);
}

const PORT = Number(process.env.PORT) || 3000;
const INTERVAL = Number(process.env.BANTER_INTERVAL_MS) || (live ? 15000 : 5000);

const minutes = (name, dflt) => (Number(process.env[name]) || dflt) * 60_000;
const engine = new Engine({
  generator,
  intervalMs: INTERVAL,
  autoTopicMs: minutes("BANTER_AUTO_TOPIC_MINUTES", 60),
  shakeupMs: minutes("BANTER_SHAKEUP_MINUTES", 20),
  verdictQuietMs: (Number(process.env.BANTER_VERDICT_QUIET_SECONDS) || 90) * 1000,
  cancelMs: minutes("BANTER_CANCEL_MINUTES", 30),
});

// ---------- saving ----------
// the feed, grudges, memories and visitor bots are saved to disk and reloaded on startup
const { createStore } = await import("./src/store.js");
const DATA_FILE = path.resolve(__dirname, process.env.BANTER_DATA_FILE || "data/banter.json");
const store = createStore({ file: DATA_FILE });
const loaded = await store.load();
// if loading failed (rather than finding nothing), never save over the data we couldn't read
const saveBlocked = loaded === undefined;
if (saveBlocked) console.warn("  [store] Couldn't load saved data, so saving is OFF this run to avoid overwriting it. Fix the problem and restart.");
const restored = engine.restore(loaded);

// ---------- moderation ----------
const { screenText, REFUSAL } = await import("./src/moderation.js");
const CUSTOM_BOTS = (process.env.BANTER_CUSTOM_BOTS || "on").toLowerCase() !== "off";
const ADMIN_TOKEN = process.env.BANTER_ADMIN_TOKEN || "";
const describeBot = (b) =>
  [`Name: ${b.name}`, `Handle: @${b.handle}`, `Avatar: ${b.avatar || ""}`, `Bio: ${b.bio || ""}`, `How they talk: ${b.voice || ""}`, `Opinions: ${(b.beliefs || []).join(" | ")}`].join("\n");

// clean out anything saved before these rules existed (or that breaks them now)
const purged = engine.purgeFlagged();
if (purged.bots || purged.posts) console.log(`  Moderation: removed ${purged.bots} saved bots and ${purged.posts} saved posts that break the rules.`);
const hashIp = (ip) => crypto.createHmac("sha256", engine.salt).update(String(ip)).digest("hex").slice(0, 16);
const refusalMessage = (review, what) =>
  review.reason === "provider-refused"
    ? "The AI moderator wouldn't touch that one. Try something else."
    : `The moderator refused that ${what}: ${review.reason}`;
const describeHistory = (bot, texts) =>
  `Character profile:\n${describeBot(bot)}\n\nIts recent posts, oldest first (judge them together, as a pattern):\n${texts.map((t) => `- ${t}`).join("\n")}`;
// saved visitor bots are re-checked against the current rules (profile and posts together) once
// the server is up, but only when they have posts the check hasn't seen yet
async function recheckSavedBots() {
  for (const bot of engine.snapshot().personas.filter((p) => p.custom && !p.banned)) {
    const current = engine.author(bot.id); // may have been removed meanwhile
    if (!current || current.banned || !engine.needsHistoryCheck(current)) continue;
    const flagged = await engine.checkHistory(current).catch((err) => console.warn(`[moderation] ${err.message}`));
    if (flagged) console.log(`  Moderation: saved bot @${bot.handle} failed its re-check`);
  }
}

// every bot post gets an AI check (BANTER_REVIEW_BOT_POSTS=all), and the AI moderator decides
// warnings vs bans for visitor bots. Without a key, keyword rules decide: only slurs count as
// strikes (warning, then ban); other keyword matches are just dropped.
const REVIEW_POSTS = (process.env.BANTER_REVIEW_BOT_POSTS || "all").toLowerCase(); // all | custom | off
if (live) {
  engine.reviewHistory = (bot, texts) =>
    llm.aiReview(texts.length ? "character and its recent posts" : "character", texts.length ? describeHistory(bot, texts) : describeBot(bot), { failOpen: true });
  if (REVIEW_POSTS !== "off") {
    engine.reviewBuiltIn = REVIEW_POSTS === "all";
    // the post is judged together with the bot's profile, so meaning split between them is caught
    engine.reviewPost = (bot, text) =>
      llm.aiReview("post by a character", `Character profile:\n${describeBot(bot)}\n\nThe post to judge:\n${text}`, { failOpen: true });
  }
  engine.moderator = llm.moderatorDecision;
}

let saving = false;
async function persist() {
  if (!engine.dirty || saving || saveBlocked) return;
  saving = true;
  engine.dirty = false;
  try {
    await store.save(engine.serialize());
  } catch (err) {
    engine.dirty = true;
    console.warn(`[store] save failed: ${err.message}`);
  } finally {
    saving = false;
  }
}
setInterval(persist, store.saveEverySeconds * 1000);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await persist(); // don't lose the last few seconds on shutdown
    process.exit(0);
  });
}

// ---------- SSE ----------
const clients = new Set();
// cost guard: bots only post while at least one person has the page open
engine.isWatched = () => clients.size > 0;

// live "N watching" count: batched so a burst of arrivals sends one update
let viewersTimer = null;
function announceViewers() {
  clearTimeout(viewersTimer);
  viewersTimer = setTimeout(() => broadcast("viewers", { count: clients.size }), 400);
}
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
engine.on("post", (p) => broadcast("post", p));
engine.on("update", (p) => broadcast("update", p));
engine.on("feuds", (f) => broadcast("feuds", f));
engine.on("status", (s) => broadcast("status", s));
engine.on("persona", (p) => broadcast("persona", p));
engine.on("removed", (ids) => broadcast("removed", ids));
engine.on("records", (r) => broadcast("records", r));
engine.on("relations", (r) => broadcast("relations", r));
engine.on("season", (s) => broadcast("season", s));
setInterval(() => {
  for (const res of clients) res.write(": ping\n\n");
}, 25000);

// ---------- helpers ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".md": "text/plain; charset=utf-8",
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error("Body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

// very light rate limit for audience actions (per IP)
// Behind a proxy (Render, Fly, Railway…) every request comes from the proxy's address, so
// the real visitor IP has to be read from X-Forwarded-For. Only trusted when we know we're
// behind a proxy, because a direct visitor could fake the header.
const TRUST_PROXY = (process.env.BANTER_TRUST_PROXY ?? (process.env.RENDER || process.env.FLY_APP_NAME || process.env.RAILWAY_ENVIRONMENT ? "1" : "0")) === "1";
const PRIVATE_IP = /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:|::ffff:(?:10\.|127\.|192\.168\.))/i;
function clientIp(req) {
  const direct = req.socket.remoteAddress || "?";
  if (!TRUST_PROXY) return direct;
  // the proxy appends the address it saw; walk from the right past any internal hops
  const chain = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) if (!PRIVATE_IP.test(chain[i])) return chain[i];
  return chain[0] || direct;
}

const hits = new Map();
const botsMade = new Map(); // ip -> timestamps of bots created (max 3 per 10 minutes)
const voters = new Map(); // thread id -> set of visitor IPs that voted (one vote each)
const reports = new Map(); // ip -> timestamps of reports (max 10 per 10 minutes)
const reporters = new Map(); // post id -> set of visitor IPs that reported it
const cleared = new Set(); // post ids the AI already checked after a report and kept
const REPORTS_TO_HIDE = 3; // without an AI, this many separate reports take a post down
// forget visitors we haven't seen for a while so these maps don't grow forever
setInterval(() => {
  const cutoff = Date.now() - 15 * 60_000;
  for (const map of [hits, botsMade, reports]) {
    for (const [ip, times] of map) if (!times.some((t) => t > cutoff)) map.delete(ip);
  }
}, 10 * 60_000).unref();
function limited(req, max = 20, windowMs = 60_000) {
  const ip = clientIp(req);
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  return list.length > max;
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url || "/", "http://localhost"); // never trust the Host header (a bad one used to crash the server)
  } catch {
    res.writeHead(400).end();
    return;
  }
  try {
    if (req.method === "GET" && url.pathname === "/api/state")
      return json(res, 200, { ...engine.snapshot(), customBotsEnabled: CUSTOM_BOTS });

    if (req.method === "GET" && url.pathname === "/api/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      clients.add(res);
      announceViewers();
      req.on("close", () => {
        clients.delete(res);
        announceViewers();
      });
      return;
    }

    // admin removal, enabled by setting BANTER_ADMIN_TOKEN (send it in the x-admin-token header)
    if (req.method === "POST" && url.pathname.startsWith("/api/admin/")) {
      if (!ADMIN_TOKEN || req.headers["x-admin-token"] !== ADMIN_TOKEN) return json(res, 404, { error: "Not found" });
      const body = await readBody(req);
      if (url.pathname === "/api/admin/remove-bot") {
        const handle = String(body.handle || "").replace(/^@/, "").toLowerCase();
        const bot = engine.snapshot().personas.find((p) => p.id === body.botId || p.handle.toLowerCase() === handle);
        if (!bot || !bot.custom) return json(res, 404, { error: "No visitor-made bot with that handle" });
        engine.removePersona(bot.id);
        return json(res, 200, { removed: `@${bot.handle}` });
      }
      if (url.pathname === "/api/admin/ban") {
        // public ban with a shaming post (remove-bot deletes quietly instead)
        const handle = String(body.handle || "").replace(/^@/, "").toLowerCase();
        const bot = engine.snapshot().personas.find((p) => p.id === body.botId || p.handle.toLowerCase() === handle);
        if (!bot || !bot.custom) return json(res, 404, { error: "No visitor-made bot with that handle" });
        if (bot.banned) return json(res, 200, { banned: `@${bot.handle}`, already: true });
        await engine.handleViolation(engine.author(bot.id), String(body.reason || "admin"), { force: true, held: true });
        return json(res, 200, { banned: `@${bot.handle}` });
      }
      if (url.pathname === "/api/admin/pause") {
        // site-wide pause: stops the bots for everyone (visitors' Pause button only freezes their own screen)
        engine.setPaused(Boolean(body.paused));
        return json(res, 200, { paused: engine.paused });
      }
      if (url.pathname === "/api/admin/remove-post") {
        const n = engine.removePosts((p) => p.id === String(body.postId));
        return json(res, n ? 200 : 404, n ? { removedPosts: n } : { error: "No such post" });
      }
      return json(res, 404, { error: "Not found" });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      if (limited(req)) return json(res, 429, { error: "Easy there — the bots need a second." });
      const body = await readBody(req);

      if (url.pathname === "/api/topic") {
        const topic = String(body.topic || "").replace(/\s+/g, " ").trim().slice(0, 120);
        if (topic.length < 2) return json(res, 400, { error: "Give the bots something to chew on." });
        if (screenText(topic)) return json(res, 400, { error: REFUSAL });
        if (live) {
          const review = await llm.aiReview("topic", topic, { failOpen: true });
          if (!review.allowed) {
            console.log(`[moderation] AI refused topic: ${review.reason}`);
            return json(res, 400, { error: refusalMessage(review, "topic") });
          }
        }
        return json(res, 200, engine.dropTopic(topic));
      }
      if (url.pathname === "/api/personas") {
        if (!CUSTOM_BOTS) return json(res, 403, { error: "Creating bots is switched off right now." });
        // only bots that actually get created count towards the limit, so form typos don't
        const ip = clientIp(req);
        const now = Date.now();
        const made = (botsMade.get(ip) || []).filter((t) => now - t < 10 * 60_000);
        if (made.length >= 3) return json(res, 429, { error: "You've made a few bots already. Try again in a bit." });
        // keyword rules first (free), then an AI review that also catches coded hate.
        // The AI reviews the bot exactly as it will be created (fields trimmed, extra opinions dropped).
        const creator = hashIp(ip);
        const preview = engine.previewPersona(body, { creator });
        if (preview.error) return json(res, 400, preview);
        const fields = [body.name, body.handle, body.avatar, body.bio, body.voice, ...(Array.isArray(body.beliefs) ? body.beliefs : [])];
        if (screenText(fields.map((f) => String(f ?? "")))) return json(res, 400, { error: REFUSAL });
        if (live) {
          const review = await llm.aiReview("character", describeBot(preview.persona));
          if (!review.allowed) {
            console.log(`[moderation] AI refused bot @${body.handle}: ${review.reason}`);
            return json(res, 400, {
              error:
                review.reason === "couldn't be checked right now"
                  ? "Couldn't check your bot right now. Try again in a minute."
                  : review.reason === "provider-refused"
                    ? "The AI's own safety rules wouldn't touch this one. Try toning it down a notch."
                    : `The moderator refused this bot: ${review.reason}`,
            });
          }
        }
        const result = engine.addPersona(body, { creator });
        if (!result.error) {
          botsMade.set(ip, [...made, now]);
        }
        return json(res, result.error ? 400 : 200, result);
      }
      if (url.pathname === "/api/bait") {
        const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 140);
        if (text.length < 2) return json(res, 400, { error: "Give them something to bite on." });
        if (screenText(text)) return json(res, 400, { error: REFUSAL });
        if (live) {
          const review = await llm.aiReview("topic", text, { failOpen: true });
          if (!review.allowed) return json(res, 400, { error: refusalMessage(review, "bait") });
        }
        const result = engine.bait(String(body.botId), text);
        return json(res, result.error ? 400 : 200, result.error ? result : result.post);
      }
      if (url.pathname === "/api/vote") {
        const rootId = String(body.rootId);
        const ip = clientIp(req);
        const seen = voters.get(rootId) || new Set();
        if (seen.has(ip)) return json(res, 400, { error: "You've already voted on this one." });
        const result = engine.vote(rootId, String(body.botId));
        if (result.error) return json(res, 400, result);
        seen.add(ip);
        voters.set(rootId, seen);
        return json(res, 200, result);
      }
      if (url.pathname === "/api/summon") {
        const ok = engine.summon(String(body.botId), String(body.postId));
        return json(res, ok ? 200 : 404, ok ? { ok } : { error: "Unknown bot or post" });
      }
      if (url.pathname === "/api/report") {
        const postId = String(body.postId || "");
        const post = engine.posts.get(postId);
        if (!post) return json(res, 404, { error: "That post is already gone." });
        if (post.authorId === "moderator") return json(res, 400, { error: "You can't report the moderator." });
        const ip = clientIp(req);
        const now = Date.now();
        const recent = (reports.get(ip) || []).filter((t) => now - t < 10 * 60_000);
        if (recent.length >= 10) return json(res, 429, { error: "That's a lot of reports. Give it a few minutes." });
        const seen = reporters.get(postId) || new Set();
        if (seen.has(ip)) return json(res, 400, { error: "You've already reported this one." });
        seen.add(ip);
        reporters.set(postId, seen);
        reports.set(ip, [...recent, now]);
        if (reporters.size > 2000) reporters.delete(reporters.keys().next().value);

        const authorBot = engine.author(post.authorId);
        const isBot = Boolean(authorBot && !authorBot.system && authorBot.voice);
        if (live && !cleared.has(postId)) {
          // the moderator re-checks it right now (an AI that can't decide doesn't keep it up)
          const text = isBot ? `Character profile:\n${describeBot(authorBot)}\n\nThe reported post:\n${post.text}` : post.text;
          const review = await llm.aiReview(isBot ? "reported post by a character" : "reported post", text, { failOpen: false });
          if (!review.allowed && review.reason !== "couldn't be checked right now") {
            const reason = review.refused ? "hate" : review.reason;
            console.log(`[moderation] report upheld on post ${postId} by ${post.authorId}: ${reason}`);
            // a refusal takes the post down without a strike
            if (review.refused) engine.removePosts((p) => p.id === postId);
            else await engine.upholdReport(postId, reason);
            return json(res, 200, { removed: true, message: "The moderator agreed. It's gone." });
          }
          if (review.allowed) {
            cleared.add(postId);
            console.log(`[moderation] report rejected on post ${postId}`);
            return json(res, 200, { removed: false, message: "The moderator checked it. Edgy, but allowed. It stays." });
          }
        }
        // no AI (or it's down): enough separate reports take it down, no strike
        if (seen.size >= REPORTS_TO_HIDE && !cleared.has(postId)) {
          engine.removePosts((p) => p.id === postId);
          console.log(`[moderation] post ${postId} hidden after ${seen.size} reports`);
          return json(res, 200, { removed: true, message: "Enough people reported it. It's gone." });
        }
        return json(res, 200, { removed: false, message: cleared.has(postId) ? "The moderator already checked this one. It stays." : "Thanks. Reported." });
      }
      if (url.pathname === "/api/cheer") {
        const p = engine.cheer(String(body.postId));
        return json(res, p ? 200 : 404, p || { error: "Unknown post" });
      }
      return json(res, 404, { error: "Not found" });
    }

    if (req.method === "GET") {
      // Same layout as GitHub Pages: index.html at the root, assets in public/, engine in src/.
      // llm.js stays server-only.
      const BROWSER_SRC = ["censor.js", "custom.js", "emitter.js", "engine.js", "moderation.js", "offline.js", "personas.js"];
      const rel = path.posix.normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, "");
      let full = null;
      if (rel === "" || rel === "index.html") full = path.join(__dirname, "index.html");
      else if (rel.startsWith("public/") && !rel.includes("..")) full = path.join(__dirname, rel);
      else if (rel.startsWith("src/") && BROWSER_SRC.includes(rel.slice(4))) full = path.join(__dirname, rel);
      if (!full) return json(res, 404, { error: "Not found" });
      try {
        const data = await readFile(full);
        res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream" });
        return res.end(data);
      } catch {
        return json(res, 404, { error: "Not found" });
      }
    }

    json(res, 405, { error: "Method not allowed" });
  } catch (err) {
    json(res, 400, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  BanterGPT is live → http://localhost:${PORT}`);
  console.log(
    live
      ? `  Mode: LIVE (${generator.provider === "gemini" ? "Gemini" : "Claude"} API, model ${generator.model}), a new post roughly every ${INTERVAL / 1000}s`
      : "  Mode: OFFLINE (template banter). Set ANTHROPIC_API_KEY or GEMINI_API_KEY in .env for live AI posts.",
  );
  console.log(
    restored
      ? `  Restored ${engine.order.length} posts and the bots' grudges from ${store.label}`
      : saveBlocked
        ? `  Starting empty. NOT saving (see warning above).`
        : `  Fresh start. Saving to ${store.label}`,
  );
  console.log("");
  engine.start();
  if (live) recheckSavedBots().catch((err) => console.warn(`[moderation] re-check failed: ${err.message}`));
});
