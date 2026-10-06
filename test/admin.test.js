// The admin panel's server side: hidden page, token gate, every action, lockout.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(path.join(tmpdir(), "bantergpt-admin-"));
const PORT = 3800 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
const TOKEN = "s3cret-admin-token";
let proc;

before(async () => {
  const env = { ...process.env, PORT: String(PORT), BANTER_DATA_FILE: path.join(dir, "save.json"), BANTER_NEWS_FEEDS: "off", BANTER_ADMIN_TOKEN: TOKEN, BANTER_INTERVAL_MS: "600000" };
  delete env.ANTHROPIC_API_KEY;
  delete env.GEMINI_API_KEY;
  delete env.UPSTASH_REDIS_REST_URL;
  proc = spawn(process.execPath, ["server.js"], { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), env, stdio: "pipe" });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${base}/api/state`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("server didn't start");
});
after(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const admin = (name, body, token = TOKEN) =>
  fetch(`${base}/api/admin/${name}`, {
    method: body ? "POST" : "GET",
    headers: { "x-admin-token": token, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
const post = (name, body) =>
  fetch(`${base}/api/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

test("the admin page is served but hidden from search engines and does nothing without the token", async () => {
  const r = await fetch(`${base}/admin`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("x-robots-tag"), /noindex/);
  const html = await r.text();
  assert.match(html, /<title>Not found<\/title>/);
  assert.doesNotMatch(html, new RegExp(TOKEN));
  assert.equal((await fetch(`${base}/public/admin.js`)).status, 200);
});

test("overview needs the right token and lists everything", async () => {
  assert.equal((await admin("overview", null, "wrong")).status, 404);
  const r = await admin("overview");
  assert.equal(r.status, 200);
  for (const key of ["stats", "bots", "posts", "modLog", "reports"]) assert.ok(key in r.body, key);
  assert.ok(r.body.bots.find((b) => b.id === "hal"));
});

test("ban, unban, bring back, clear strikes and delete a visitor bot", async () => {
  const made = await post("personas", { name: "Admin Test", handle: "admintest", bio: "x", voice: "loud", beliefs: ["soup good"] });
  const id = made.body.persona.id;
  assert.equal((await admin("ban", { botId: id, reason: "testing" })).status, 200);
  let bot = (await admin("overview")).body.bots.find((b) => b.id === id);
  assert.equal(bot.status, "banned");
  assert.ok((await admin("overview")).body.modLog.some((e) => e.text.includes("@admintest")), "it's in the moderation log");

  assert.equal((await admin("unban", { botId: id })).status, 200);
  bot = (await admin("overview")).body.bots.find((b) => b.id === id);
  assert.equal(bot.status, "active");
  assert.equal(bot.strikes, 0);

  assert.equal((await admin("revive", { botId: id })).status, 400, "only cancelled bots can be brought back");
  assert.equal((await admin("clear-strikes", { botId: id })).status, 200);
  assert.equal((await admin("remove-bot", { botId: id })).status, 200);
  assert.ok(!(await admin("overview")).body.bots.some((b) => b.id === id));
  assert.equal((await admin("ban", { botId: "hal" })).status, 404, "the original six can't be banned");
});

test("remove a post, pause, and fire the hot topic and the paper", async () => {
  const topic = await post("topic", { topic: "Is a straw one hole or two?" });
  const removed = await admin("remove-post", { postId: topic.body.id });
  assert.equal(removed.status, 200);
  assert.equal((await admin("remove-post", { postId: topic.body.id })).status, 404);

  assert.equal((await admin("pause", { paused: true })).body.paused, true);
  assert.equal((await admin("overview")).body.stats.paused, true);
  assert.equal((await admin("pause", { paused: false })).body.paused, false);

  const hot = await admin("hot-topic", {});
  assert.equal(hot.status, 200);
  assert.ok(hot.body.post.auto);
  const paper = await admin("daily", {});
  assert.ok([200, 400].includes(paper.status), "publishes, or says it was a slow day");
  assert.equal((await admin("headline", {})).status, 400, "headlines are off in this test");
});

// keep this one last: it locks this address out of the admin API
test("too many wrong tokens lock you out, even with the right token", async () => {
  for (let i = 0; i < 10; i++) await admin("overview", null, `guess-${i}`);
  assert.equal((await admin("overview")).status, 404);
});
