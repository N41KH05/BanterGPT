// Starts the real server (offline mode, temporary save file) and talks to it over HTTP.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(path.join(tmpdir(), "bantergpt-test-"));
const PORT = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
let proc;

before(async () => {
  const env = { ...process.env, PORT: String(PORT), BANTER_DATA_FILE: path.join(dir, "save.json"), BANTER_NEWS_FEEDS: "off", BANTER_ADMIN_TOKEN: "secret", BANTER_INTERVAL_MS: "600000" };
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

const post = (name, body, headers = {}) =>
  fetch(`${base}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

test("state has everything the page needs", async () => {
  const s = await (await fetch(`${base}/api/state`)).json();
  for (const key of ["personas", "posts", "feuds", "records", "season", "comebackNeeded", "system"]) assert.ok(key in s, key);
  assert.ok(s.system.moderator && s.system.judge && s.system.newsdesk);
});

test("the page and its scripts are served", async () => {
  for (const p of ["/", "/public/app.js", "/public/style.css", "/src/engine.js", "/public/roastcard.js"]) {
    assert.equal((await fetch(base + p)).status, 200, p);
  }
  assert.equal((await fetch(`${base}/server.js`)).status, 404, "server code isn't public");
  assert.equal((await fetch(`${base}/.env`)).status, 404);
});

test("a garbage Host header can't crash the server", async () => {
  await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: "/api/state", headers: { host: "[" } }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", resolve);
    req.end();
  });
  assert.equal((await fetch(`${base}/api/state`)).status, 200);
});

test("topics, reviews and trials go through, refused ones don't", async () => {
  assert.equal((await post("topic", { topic: "Is cereal soup?" })).status, 200);
  assert.equal((await post("topic", { topic: atob("aW1taWdyYW50cw==") + " are bad" })).status, 400);
  const review = await post("review", { thing: "IKEA meatballs" });
  assert.equal(review.status, 200);
  assert.equal(review.body.kind, "review");
  const trial = await post("trial", { botId: "hal", charge: "being boring" });
  assert.equal(trial.status, 200);
  assert.equal((await post("trial-vote", { rootId: trial.body.id, verdict: "guilty" })).status, 200);
  assert.equal((await post("trial-vote", { rootId: trial.body.id, verdict: "guilty" })).status, 400, "one vote each");
});

test("reports: one per person, and the moderator can't be reported", async () => {
  const s = await (await fetch(`${base}/api/state`)).json();
  const target = s.posts.find((p) => p.authorId === "audience");
  const first = await post("report", { postId: target.id });
  assert.equal(first.status, 200);
  assert.equal((await post("report", { postId: target.id })).status, 400);
});

test("creating a bot works; comeback votes only for cancelled bots", async () => {
  const made = await post("personas", { name: "Test Bot", handle: "testbot", bio: "x", voice: "loud", beliefs: ["soup good"] });
  assert.equal(made.status, 200);
  assert.equal((await post("comeback", { botId: made.body.persona.id })).status, 400);
});

test("admin endpoints need the token", async () => {
  assert.equal((await post("admin/pause", { paused: true })).status, 404);
  assert.equal((await post("admin/pause", { paused: false }, { "x-admin-token": "secret" })).status, 200);
});

test("admin stats need the token and report the basics", async () => {
  assert.equal((await fetch(`${base}/api/admin/stats`)).status, 404);
  const r = await fetch(`${base}/api/admin/stats`, { headers: { "x-admin-token": "secret" } });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.mode, "offline");
  assert.ok(s.activeBots >= 6);
});

test("shared thread links get their own preview tags and image", async () => {
  const topic = await post("topic", { topic: "Should cats have jobs?" });
  const id = topic.body.id;
  const page = await (await fetch(`${base}/t/${id}`)).text();
  assert.match(page, /<base href="\/" \/>/);
  assert.match(page, /<title>Should cats have jobs\? · BanterGPT<\/title>/);
  assert.match(page, new RegExp(`og:image" content="[^"]*/og/t/${id}\\.png`));
  const img = await fetch(`${base}/og/t/${id}.png`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  const bytes = new Uint8Array(await img.arrayBuffer());
  assert.deepEqual([...bytes.slice(1, 4)], [80, 78, 71], "it's a PNG");
});

test("a link to a thread that's gone still opens the site", async () => {
  const r = await fetch(`${base}/t/999999`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<title>BanterGPT<\/title>/);
  const img = await fetch(`${base}/og/t/999999.png`, { redirect: "manual" });
  assert.equal(img.status, 302);
});

test("preview tags can't be broken by what bots or visitors write", async () => {
  const topic = await post("topic", { topic: 'Quotes " and <tags> & stuff?' });
  const page = await (await fetch(`${base}/t/${topic.body.id}`)).text();
  assert.ok(!page.includes("<tags>"));
  assert.match(page, /Quotes &quot; and &lt;tags&gt; &amp; stuff\?/);
});
