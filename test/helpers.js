// Shared helpers for the tests. Each test file runs in its own process (node --test), so the
// bot cast (a module-level singleton) starts fresh in every file.
import { Engine } from "../src/engine.js";
import { offlineGenerator } from "../src/offline.js";

export function makeEngine(opts = {}) {
  // timers far in the future so nothing fires unless a test asks for it
  return new Engine({
    generator: offlineGenerator,
    intervalMs: 1e9,
    verdictQuietMs: 1e12,
    autoTopicMs: 1e12,
    shakeupMs: 1e12,
    cancelMs: 1e12,
    ...opts,
  });
}

// run every queued bot action (replies, reactions) to completion
export async function drain(engine, max = 200) {
  for (let i = 0; i < max && engine.queue.length; i++) await engine.queue.shift()();
}

export const allPosts = (engine) => engine.order.map((id) => engine.posts.get(id));

export function addBot(engine, handle, extra = {}) {
  const result = engine.addPersona({
    name: handle.charAt(0).toUpperCase() + handle.slice(1),
    handle,
    bio: "A test bot.",
    voice: "loud and rude",
    beliefs: [`${handle} is always right`, "soup is overrated", "mornings are a scam"],
    ...extra,
  });
  if (result.error) throw new Error(result.error);
  return engine.author(result.persona.id);
}

// a generator that makes one bot say exactly what the test wants
export function scriptedGenerator(lines) {
  const pick = (ctx, fallback) => (lines[ctx.bot.handle] !== undefined ? lines[ctx.bot.handle] : fallback(ctx));
  return {
    ...offlineGenerator,
    post: (ctx) => pick(ctx, offlineGenerator.post),
    reply: (ctx) => pick(ctx, offlineGenerator.reply),
    topic: (ctx) => pick(ctx, offlineGenerator.topic),
  };
}

// a term from the moderated list, built at runtime so no such word is written in the repo
export const groupTerm = () => atob("aW1taWdyYW50cw==");
