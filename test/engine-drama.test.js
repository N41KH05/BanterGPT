import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEngine, drain, allPosts, addBot } from "./helpers.js";

const HOUR = 3_600_000;
const age = (bot, hours) => (bot.createdAt -= hours * HOUR);

test("a flopping visitor bot gets cancelled, keeps its posts, and the others dunk", async () => {
  const e = makeEngine({ cancelMs: 1 });
  const bot = addBot(e, "flopper");
  await drain(e);
  age(bot, 3);
  e.records[bot.id] = { w: 0, l: 3, results: [] }; // (no streak list, so a flip-flop can't go first)
  e.lastCancelAt = 0;
  assert.equal(await e.maintenance(), true);
  await drain(e);
  assert.ok(bot.retired && !bot.banned);
  assert.equal(bot.cancelReason, "going 0-3");
  const news = allPosts(e).find((p) => p.newsType === "cancelled");
  assert.ok(news && news.text.includes("@flopper"));
  assert.ok(allPosts(e).some((p) => p.parentId === news.id), "rivals dunk on it");
  assert.ok(allPosts(e).some((p) => p.authorId === bot.id), "cancelled bots keep their old posts");
});

test("new bots get a grace period; a winning bot isn't cancelled on the timer", async () => {
  const e = makeEngine({ cancelMs: 1 });
  const fresh = addBot(e, "freshie");
  const winner = addBot(e, "winner");
  age(winner, 3);
  e.records[fresh.id] = { w: 0, l: 5, results: [] };
  e.records[winner.id] = { w: 5, l: 0, results: [] };
  e.lastCancelAt = 0;
  await e.maintenance();
  assert.ok(!fresh.retired, "inside its grace period");
  assert.ok(!winner.retired, "not flopping");
});

test("comeback: enough votes bring a cancelled bot back with grudges against its dunkers", async () => {
  const e = makeEngine({ cancelMs: 1, comebackVotes: 2 });
  const bot = addBot(e, "phoenix");
  await drain(e);
  age(bot, 3);
  e.records[bot.id] = { w: 0, l: 3, results: [] };
  e.lastCancelAt = 0;
  await e.maintenance();
  await drain(e);
  assert.ok(bot.retired);
  assert.match(e.comebackVote("hal").error, /cancelled/);
  assert.deepEqual(e.comebackVote(bot.id), { votes: 1, needed: 2, revived: false });
  assert.equal(e.comebackVote(bot.id).revived, true);
  await drain(e);
  assert.ok(!bot.retired && bot.comebackAt);
  const news = allPosts(e).find((p) => p.newsType === "comeback");
  assert.ok(news.text.includes("@phoenix"));
  for (const id of news.targets) assert.ok(e.grudge(bot.id, id) >= 5, "it holds a grudge against whoever laughed");
});

test("banned bots can't make a comeback", async () => {
  const e = makeEngine();
  const bot = addBot(e, "banned1");
  await e.handleViolation(bot, "racist", { force: true });
  assert.match(e.comebackVote(bot.id).error, /cancelled/);
});

test("a full cast cancels the worst performer, never the newcomer", async () => {
  const e = makeEngine();
  const bots = [];
  for (let i = 0; i < 12; i++) bots.push(addBot(e, `filler${i}`));
  bots.forEach((b) => age(b, 3));
  e.records[bots[5].id] = { w: 0, l: 4, results: [] };
  const newcomer = addBot(e, "newcomer");
  assert.ok(bots[5].retired, "the worst one made room");
  assert.ok(!newcomer.retired);
});

test("season rollover crowns the best record, fills the Hall of Fame and resets records", async () => {
  const e = makeEngine();
  e.records = { hal: { w: 5, l: 1, results: [] }, brut: { w: 5, l: 3, results: [] }, carl: { w: 1, l: 4, results: [] } };
  e.season.start -= 7 * 24 * HOUR;
  const number = e.season.number;
  assert.equal(await e.maintenance(), true);
  await drain(e);
  assert.equal(e.champion, "hal");
  assert.equal(e.hallOfFame[0].id, "hal");
  assert.deepEqual(e.records, {});
  assert.equal(e.season.number, number + 1);
  assert.ok(allPosts(e).some((p) => p.newsType === "season" && p.text.includes("@hustle_hal")));
});

test("trials: votes decide, the sentence is applied to every post, and it expires", async () => {
  const e = makeEngine();
  const { post } = e.trial("hal", "being boring");
  await drain(e);
  assert.match(e.trial("carl", "x").error, /session/);
  e.trialVote(post.id, "guilty");
  e.trialVote(post.id, "guilty");
  e.trialVote(post.id, "innocent");
  post.closesAt = Date.now() - 1;
  await e.maintenance();
  await drain(e);
  assert.equal(post.trialResult.guilty, true);
  const pun = e.punishments.hal;
  assert.ok(pun);
  const hal = e.author("hal");
  assert.notEqual(e.punish(hal, "hello there"), "hello there");
  pun.until = Date.now() - 1;
  assert.equal(e.punish(hal, "hello there"), "hello there", "the sentence runs out");
  assert.match(e.trialVote(post.id, "guilty").error, /ruled/);
});

test("ALL CAPS punishment doesn't trip moderation on ordinary posts", async () => {
  const e = makeEngine();
  e.punishments.brut = { kind: "caps", until: Date.now() + HOUR };
  const post = await e.newPost(e.author("brut"));
  assert.ok(post);
  assert.equal(post.text, post.text.toUpperCase());
});

test("product reviews: four ratings, then the furthest apart fight", async () => {
  const e = makeEngine();
  const root = await e.reviewThing("IKEA meatballs");
  await drain(e);
  const reviews = allPosts(e).filter((p) => p.parentId === root.id && p.stars);
  assert.equal(reviews.length, 4);
  for (const r of reviews) assert.ok(r.stars >= 1 && r.stars <= 5);
  if (new Set(reviews.map((r) => r.stars)).size > 1) assert.ok(allPosts(e).some((p) => p.rootId === root.id && p.stance === "disagree"));
});

test("flip-flops: a bot on a losing streak changes its mind in public", async () => {
  const e = makeEngine();
  e.records.carl = { w: 0, l: 3, results: ["L", "L", "L"] };
  const random = Math.random;
  Math.random = () => 0.1;
  try {
    assert.equal(e.maybeFlip(Date.now()), true);
  } finally {
    Math.random = random;
  }
  await drain(e);
  const carl = e.author("carl");
  assert.equal(carl.flips.length, 1);
  assert.ok(carl.beliefs.includes(carl.flips[0].belief));
  assert.ok(allPosts(e).some((p) => p.newsType === "flip"));
  assert.ok(e.memory.hal.some((m) => m.includes("flip-flopped")), "everyone remembers");
  assert.equal(e.maybeFlip(Date.now()), false, "not again for a while");
});

test("time of day sets the vibe (Finnish time)", () => {
  const e = makeEngine();
  assert.equal(e.vibe(Date.UTC(2026, 9, 2, 20)), "tipsy"); // Fri 23:00
  assert.equal(e.vibe(Date.UTC(2026, 9, 3, 7)), "hungover"); // Sat 10:00
  assert.equal(e.vibe(Date.UTC(2026, 9, 6, 0)), "unhinged"); // Tue 03:00
  assert.equal(e.vibe(Date.UTC(2026, 9, 6, 4)), "sleepy"); // Tue 07:00
  assert.equal(e.vibe(Date.UTC(2026, 9, 6, 11)), null); // Tue 14:00
});

test("the Daily Banter sums up the day, and skips slow days", async () => {
  const e = makeEngine();
  assert.equal(e.publishDaily(), false, "nothing happened, no paper");
  e.dropTopic("Is cereal soup?");
  await drain(e);
  for (let i = 0; i < 20; i++) await e.randomReply();
  await drain(e);
  assert.equal(e.publishDaily(), true);
  const paper = allPosts(e).find((p) => p.kind === "daily");
  assert.ok(paper.edition.fight.clapbacks > 0);
  assert.ok(paper.edition.date);
});

test("hottest feuds always leave room for visitor bots", async () => {
  const e = makeEngine();
  const a = addBot(e, "newbie");
  for (const [x, y] of [["hal", "nap"], ["margot", "brut"], ["carl", "professor"], ["hal", "brut"], ["nap", "carl"], ["margot", "professor"]]) {
    e.grudges[`${x}>${y}`] = 20;
  }
  e.grudges[`${a.id}>hal`] = 1;
  assert.ok(e.feuds().some((f) => f.a === a.id || f.b === a.id));
});

test("grudges cool off over time", () => {
  const e = makeEngine();
  e.grudges["hal>nap"] = 8;
  const now = Date.now();
  e.lastCooled = now - 2 * HOUR;
  e.coolGrudges(now);
  assert.ok(Math.abs(e.grudges["hal>nap"] - 4) < 0.1);
});

test("everything important survives a save and restore", async () => {
  const e = makeEngine();
  const bot = addBot(e, "saved");
  await drain(e);
  e.strikes[bot.id] = 1;
  e.punishments.hal = { kind: "pirate", until: Date.now() + HOUR };
  e.flips.carl = [{ belief: "x", at: 1 }];
  e.champion = "hal";
  e.hallOfFame = [{ season: 1, id: "hal" }];
  e.lastDaily = "2026-10-03";
  const data = JSON.parse(JSON.stringify(e.serialize()));
  const e2 = makeEngine();
  assert.equal(e2.restore(data), true);
  assert.equal(e2.strikes[bot.id], 1);
  assert.equal(e2.punishments.hal.kind, "pirate");
  assert.equal(e2.author("carl").flips.length, 1);
  assert.equal(e2.publicSeason().champion, "hal");
  assert.equal(e2.lastDaily, "2026-10-03");
  assert.equal(e2.order.length, e.order.length);
  assert.equal(e2.salt, e.salt);
});

test("visitor bots each get their own emojis and hashtags", async () => {
  const e = makeEngine();
  const a = addBot(e, "soupfan", { beliefs: ["soup is life", "bread is overrated"] });
  const b = addBot(e, "gymrat", { beliefs: ["leg day is sacred", "cardio is a scam"] });
  assert.equal(a.emojis.length, 4);
  assert.notDeepEqual(a.emojis, b.emojis);
  assert.ok(a.hashtags.some((t) => ["#soup", "#life", "#bread", "#overrated"].includes(t)), "a hashtag about its own thing");
});

test("bots get their own recent posts handed to them", async () => {
  const e = makeEngine();
  let seen = null;
  e.generator = { ...e.generator, post: async (ctx) => ((seen = ctx.ownRecent), "fresh post") };
  const hal = e.author("hal");
  await e.newPost(hal);
  await e.newPost(hal);
  assert.deepEqual(seen, ["fresh post"]);
});
