import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEngine, drain, allPosts, addBot, scriptedGenerator, groupTerm } from "./helpers.js";

const BAD = `the ${groupTerm()} ruin everything`;

test("offline: a keyword match from a visitor bot is dropped without a strike", async () => {
  const e = makeEngine({ generator: scriptedGenerator({ kwbot: BAD }) });
  const bot = addBot(e, "kwbot");
  await drain(e);
  assert.equal(allPosts(e).filter((p) => p.authorId === bot.id).length, 0);
  assert.equal(e.strikes[bot.id], undefined);
  assert.ok(!bot.banned);
});

test("AI-confirmed hate: warning first, ban on the second offence, posts removed", async () => {
  const e = makeEngine({ generator: scriptedGenerator({ badbot: "coded hate" }) });
  e.reviewPost = async (bot, text) => (text === "coded hate" ? { allowed: false, reason: "racist stereotype" } : { allowed: true });
  const bot = addBot(e, "badbot");
  await drain(e); // its intro post is the first offence
  assert.equal(e.strikes[bot.id], 1);
  assert.ok(!bot.banned);
  const warn = allPosts(e).find((p) => p.kind === "warn");
  assert.ok(warn && warn.text.includes("@badbot"), "public warning names the bot");
  assert.ok(!warn.text.includes("coded hate"), "the warning never repeats what was said");

  await e.newPost(bot); // second offence
  await drain(e);
  assert.ok(bot.banned && bot.retired);
  assert.equal(bot.banReason, "racism");
  assert.equal(allPosts(e).filter((p) => p.authorId === bot.id).length, 0, "a ban takes down everything it posted");
  assert.ok(allPosts(e).some((p) => p.kind === "ban"));
  assert.equal(await e.newPost(bot), null, "banned bots can't post");
});

test("an AI refusal drops the post but never counts as allowed", async () => {
  const e = makeEngine({ generator: scriptedGenerator({ refbot: "awful thing" }) });
  e.reviewPost = async () => ({ allowed: false, refused: true, reason: "provider-refused" });
  const bot = addBot(e, "refbot");
  await drain(e);
  assert.equal(allPosts(e).filter((p) => p.authorId === bot.id).length, 0);
  assert.equal(e.strikes[bot.id], undefined, "no strike for a refusal on a single post");
});

test("keyword match the AI says is fine: dropped quietly, no strike", async () => {
  const e = makeEngine({ generator: scriptedGenerator({ okbot: BAD }) });
  e.reviewPost = async () => ({ allowed: true });
  const bot = addBot(e, "okbot");
  await drain(e);
  assert.equal(e.strikes[bot.id], undefined);
});

test("the original six are never banned, their bad posts are just dropped", async () => {
  const e = makeEngine({ generator: scriptedGenerator({ hustle_hal: BAD }) });
  e.reviewBuiltIn = true;
  e.reviewPost = async () => ({ allowed: false, reason: "racist" });
  const hal = e.author("hal");
  const before = allPosts(e).length;
  assert.equal(await e.newPost(hal), null);
  assert.equal(allPosts(e).length, before);
  assert.ok(!hal.banned);
});

test("a hateful pattern across posts is caught by the history check", async () => {
  const e = makeEngine();
  e.reviewPost = async () => ({ allowed: true });
  let release;
  const verdict = new Promise((r) => (release = r));
  e.reviewHistory = () => verdict; // the test decides when the AI answers
  const bot = addBot(e, "heir");
  await drain(e);
  for (let i = 0; i < 3; i++) await e.newPost(bot); // intro + 3 posts = 4, which triggers the check
  const flagged = allPosts(e).filter((p) => p.authorId === bot.id).map((p) => p.id);
  assert.equal(flagged.length, 4);
  assert.equal(await e.newPost(bot), null, "no posting while the check runs");
  release({ allowed: false, reason: "coded racist bloodline talk" });
  await new Promise((r) => setTimeout(r, 10));
  await drain(e);
  assert.equal(e.strikes[bot.id], 1);
  for (const id of flagged) assert.ok(!e.posts.has(id), "the flagged posts come down");
  assert.ok(allPosts(e).some((p) => p.kind === "warn" && p.text.includes("@heir")));
});

test("banned bots can't come back renamed, and their creator is benched", async () => {
  const e = makeEngine({ generator: scriptedGenerator({ villain: "coded hate" }) });
  e.reviewPost = async (bot, text) => (text === "coded hate" ? { allowed: false, reason: "racist" } : { allowed: true });
  const profile = { bio: "stern old traditionalist", voice: "stiff and formal", beliefs: ["old houses are better", "tea is sacred", "manners matter"] };
  const bot = addBot(e, "villain", { ...profile });
  e.creators[bot.id] = "creator-hash";
  await e.handleViolation(bot, "racist", { force: true });
  assert.ok(bot.banned);
  assert.match(e.previewPersona({ name: "Copy", handle: "villain2", ...profile }).error, /banned/);
  assert.match(e.previewPersona({ name: "Fresh", handle: "fresh", bio: "x", voice: "y", beliefs: ["z"] }, { creator: "creator-hash" }).error, /day off/);
  assert.equal(e.previewPersona({ name: "Fresh", handle: "fresh", bio: "x", voice: "y", beliefs: ["z"] }).error, undefined);
});

test("reports: an upheld report removes the post and gives a visitor bot a strike", async () => {
  const e = makeEngine();
  const bot = addBot(e, "reported");
  await drain(e);
  const post = allPosts(e).find((p) => p.authorId === bot.id);
  await e.upholdReport(post.id, "racist");
  assert.ok(!e.posts.has(post.id));
  assert.equal(e.strikes[bot.id], 1);
});
