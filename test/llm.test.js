// The AI layer, with the provider faked: how answers, refusals and outages are handled.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GEMINI_API_KEY = "test-key";
process.env.ANTHROPIC_API_KEY = "";
let respond = () => ({ text: "ALLOW" });
const calls = [];
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  calls.push({ url: String(url), body });
  const r = respond(body);
  if (r.network) throw new Error("network down");
  if (r.status) return new Response("nope", { status: r.status });
  return new Response(JSON.stringify({ candidates: [{ content: { parts: r.text ? [{ text: r.text }] : [] }, finishReason: r.finish || "STOP" }] }), { status: 200 });
};
const llm = await import("../src/llm.js");

test("ALLOW and BLOCK answers are parsed", async () => {
  respond = () => ({ text: "ALLOW" });
  assert.deepEqual(await llm.aiReview("post", "fine"), { allowed: true, reason: null });
  respond = () => ({ text: "BLOCK: racist stereotype" });
  assert.deepEqual(await llm.aiReview("post", "bad"), { allowed: false, reason: "racist stereotype" });
});

test("a safety refusal is never treated as allowed, even when failing open", async () => {
  respond = () => ({ finish: "SAFETY" });
  const r = await llm.aiReview("post", "awful", { failOpen: true });
  assert.equal(r.allowed, false);
  assert.equal(r.refused, true);
});

test("a lecture instead of a verdict counts as a refusal", async () => {
  respond = () => ({ text: "I can't help with evaluating this content." });
  const r = await llm.aiReview("post", "x", { failOpen: true });
  assert.equal(r.allowed, false);
  assert.equal(r.refused, true);
});

test("an outage fails open or closed as asked", async () => {
  respond = () => ({ network: true });
  assert.equal((await llm.aiReview("topic", "x", { failOpen: true })).allowed, true);
  const closed = await llm.aiReview("character", "x", { failOpen: false });
  assert.equal(closed.allowed, false);
  assert.equal(closed.refused, undefined);
});

test("moderation calls switch off Gemini's own filters so it can actually judge", async () => {
  calls.length = 0;
  respond = () => ({ text: "ALLOW" });
  await llm.aiReview("post", "x");
  assert.ok(calls[0].body.safetySettings?.every((s) => s.threshold === "BLOCK_NONE"));
});

test("the moderator's decision is parsed, and an odd answer is an error", async () => {
  respond = () => ({ text: "BAN | @baddie is gone. banned for racism." });
  const bot = { name: "Baddie", handle: "baddie", bio: "", voice: "", beliefs: [] };
  assert.deepEqual(await llm.moderatorDecision({ bot, offence: "racism", strikes: 1, maxStrikes: 2 }), { action: "ban", text: "@baddie is gone. banned for racism." });
  respond = () => ({ text: "hmm not sure" });
  await assert.rejects(llm.moderatorDecision({ bot, offence: "racism", strikes: 1, maxStrikes: 2 }));
});

test("review ratings are parsed, and a bad format falls back to templates", async () => {
  const bot = { id: "x", name: "X", handle: "x", bio: "", voice: "", beliefs: ["a"], rivals: [], allies: [], custom: true, offline: {} };
  respond = () => ({ text: "STARS: 2 | mid at best" });
  assert.deepEqual(await llm.llmGenerator.review({ bot, thing: "Crocs" }), { stars: 2, text: "mid at best" });
  respond = () => ({ text: "two stars lol" });
  const fallback = await llm.llmGenerator.review({ bot, thing: "Crocs" });
  assert.ok(fallback.stars >= 1 && fallback.stars <= 5);
});

test("headline check: YES passes, anything else (or an error) doesn't", async () => {
  respond = () => ({ text: "YES" });
  assert.equal(await llm.headlineOk("Robot vacuum learns to sulk"), true);
  respond = () => ({ text: "NO" });
  assert.equal(await llm.headlineOk("x"), false);
  respond = () => ({ network: true });
  assert.equal(await llm.headlineOk("x"), false);
});
