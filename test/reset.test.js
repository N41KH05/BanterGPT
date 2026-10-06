import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEngine, drain, allPosts, addBot } from "./helpers.js";

async function busyUniverse() {
  const e = makeEngine();
  const bot = addBot(e, "doomed");
  e.dropTopic("Is cereal soup?");
  await drain(e);
  for (let i = 0; i < 10; i++) await e.randomReply();
  e.records.hal = { w: 3, l: 1, results: [] };
  e.strikes[bot.id] = 1;
  e.champion = "hal";
  e.hallOfFame = [{ season: 1, id: "hal" }];
  e.author("hal").rivals = ["carl"]; // relationships drift over time
  e.flips.carl = [{ belief: "x", at: 1 }];
  e.author("carl").flips = e.flips.carl;
  return { e, bot };
}

test("reset with the original six wipes history and restores the six as they ship", async () => {
  const { e, bot } = await busyUniverse();
  const universe = e.universe;
  let event = null;
  e.on("reset", (s) => (event = s));
  const r = e.resetUniverse({ keepOriginals: true });
  assert.deepEqual(r, { reset: true, bots: 6 });
  assert.ok(event, "everyone watching is told");
  assert.notEqual(e.universe, universe);
  assert.equal(e.author(bot.id), undefined, "visitor bots are gone");
  assert.equal(e.order.length, 0);
  assert.deepEqual(e.records, {});
  assert.deepEqual(e.grudges, {});
  assert.deepEqual(e.strikes, {});
  assert.equal(e.champion, null);
  assert.deepEqual(e.hallOfFame, []);
  assert.equal(e.season.number, 1);
  assert.deepEqual(e.author("hal").rivals, ["nap", "margot"], "relationships back to how they ship");
  assert.equal(e.author("carl").flips, undefined);
  await drain(e);
  assert.ok(allPosts(e).length >= 1, "the fresh feed gets a few opening posts");
});

test("reset to empty leaves no bots, and the engine idles safely", async () => {
  const { e } = await busyUniverse();
  assert.deepEqual(e.resetUniverse({ keepOriginals: false }), { reset: true, bots: 0 });
  assert.equal(e.snapshot().personas.filter((p) => !p.retired).length, 0);
  await e.step(); // nothing to do, nothing breaks
  assert.equal(allPosts(e).length, 0);
  // visitors can still create bots, and they post
  const bot = addBot(e, "firstborn");
  await drain(e);
  assert.ok(allPosts(e).some((p) => p.authorId === bot.id));
});

test("an empty universe stays empty after a restart, and the six can come back", async () => {
  const { e } = await busyUniverse();
  e.resetUniverse({ keepOriginals: false });
  const data = JSON.parse(JSON.stringify(e.serialize()));
  const e2 = makeEngine();
  e2.restore(data);
  assert.equal(e2.author("hal").retired, true);
  e2.setOriginals(true);
  assert.equal(e2.author("hal").retired, false);
  assert.equal(e2.snapshot().personas.filter((p) => !p.retired).length, 6);
});

test("a reply to a post from the old universe is dropped", async () => {
  const { e } = await busyUniverse();
  const old = allPosts(e).at(-1);
  e.resetUniverse({ keepOriginals: true });
  assert.equal(e.addPost({ authorId: "hal", text: "late reply", parentId: old.id }), null);
});
