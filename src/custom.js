// User-created bots: validation and a generic template bank so custom bots can banter
// in offline mode too. Shared by the server and the in-browser demo.

import { censor } from "./censor.js";
import { screenText, REFUSAL } from "./moderation.js";

export const MAX_CUSTOM = 12; // past this, the worst-performing visitor bot gets cancelled

const LIMITS = { name: 24, handle: 20, bio: 100, voice: 220, belief: 100, fandom: 40 };
const COLORS = ["#c2410c", "#0f766e", "#7c3aed", "#be185d", "#15803d", "#1d4ed8", "#a16207", "#475569"];

const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const hasBlocked = (text) => censor(text) !== text;

// Turns form input into a persona, or returns { error } explaining what to fix.
export function buildCustomPersona(input, existing) {
  const name = clean(input.name, LIMITS.name);
  const handle = clean(input.handle, LIMITS.handle).replace(/^@/, "");
  const avatar = [...clean(input.avatar, 16)].slice(0, 2).join("") || "🤖";
  const bio = clean(input.bio, LIMITS.bio);
  const voice = clean(input.voice, LIMITS.voice);
  const beliefs = (Array.isArray(input.beliefs) ? input.beliefs : [])
    .map((b) => clean(b, LIMITS.belief).replace(/[.!]+$/, ""))
    .filter(Boolean)
    .slice(0, 4);
  // what the bot is into (games, shows, anime, memes): optional, comma separated
  const fandoms = (Array.isArray(input.fandoms) ? input.fandoms : String(input.fandoms ?? "").split(","))
    .map((f) => clean(f, LIMITS.fandom))
    .filter(Boolean)
    .slice(0, 5);

  if (name.length < 2) return { error: "Give your bot a name." };
  if (!/^[A-Za-z0-9_]{3,20}$/.test(handle)) return { error: "Handle: 3–20 letters, numbers or underscores." };
  if (beliefs.length < 1) return { error: "Give your bot at least one opinion it will die on." };
  if (!voice) return { error: "Describe how your bot talks." };

  // a bot built around a slur shouldn't exist at all, so reject rather than star it out
  if (hasBlocked(name) || hasBlocked(handle) || hasBlocked(avatar)) return { error: "Pick a different name or handle." };
  if ([bio, voice, ...beliefs, ...fandoms].some(hasBlocked)) return { error: "Keep slurs out of your bot." };
  // no bots about race, ethnicity, religion, nationality, sexuality or hate movements
  if (screenText(name, handle, avatar, bio, voice, beliefs, fandoms)) return { error: REFUSAL };

  const taken = existing.some(
    (p) => p.handle.toLowerCase() === handle.toLowerCase() || p.id === handle.toLowerCase() || handle.toLowerCase() === "the_audience",
  );
  if (taken) return { error: `@${handle} is taken.` };

  const ids = new Set(existing.filter((p) => !p.retired).map((p) => p.id));
  const pickIds = (list) => [...new Set((Array.isArray(list) ? list : []).map(String))].filter((id) => ids.has(id)).slice(0, 3);
  const rivals = pickIds(input.rivals);
  const allies = pickIds(input.allies).filter((id) => !rivals.includes(id));

  const persona = {
    id: `u_${handle.toLowerCase()}`,
    handle,
    name,
    avatar,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    bio: bio || `${name}. Opinions included.`,
    voice,
    beliefs,
    fandoms,
    interests: beliefs.flatMap((b) => b.toLowerCase().match(/[a-z]{4,}/g) || []).slice(0, 12),
    rivals,
    allies,
    custom: true,
    createdAt: Date.now(),
  };
  Object.assign(persona, styleFor(persona));
  persona.offline = genericBank(persona);
  return { persona };
}

// Rebuilds a saved custom bot (template lines aren't saved; they're regenerated).
export function restoreCustomPersona(saved) {
  const persona = { ...saved, custom: true };
  if (!persona.emojis || !persona.hashtags) Object.assign(persona, styleFor(persona));
  persona.offline = genericBank(persona);
  return persona;
}

// Every visitor bot gets its own emojis and hashtags (some about its own obsessions), so they
// don't all post with the same handful. Picked from the bot's id, so it never changes.
const EMOJI_POOL = ["💀", "😂", "🔥", "🙄", "🤡", "😤", "🫠", "😭", "🤨", "😈", "🧐", "😎", "🥱", "🤌", "👀", "🙃", "😬", "💅", "🤣", "😏", "🫡", "🤯", "🥴", "😩", "🗿", "🧂", "📉", "🚮", "🍿", "⚰️"];
const TAG_POOL = ["#L", "#ratio", "#cope", "#delusional", "#touchgrass", "#mid", "#skillissue", "#cringe", "#saltmine", "#facts", "#noted", "#yikes", "#clownery", "#hottake", "#unhinged", "#rentfree"];
function hash(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}
export function styleFor(p) {
  const h = hash(p.id || p.handle || "bot");
  const take = (pool, n, seed) => {
    const out = [];
    for (let i = 0; out.length < n && i < pool.length * 2; i++) {
      const item = pool[(seed + i * 7) % pool.length];
      if (!out.includes(item)) out.push(item);
    }
    return out;
  };
  const own = [...new Set((p.interests || []).filter((w) => w.length >= 4 && w.length <= 16))].slice(0, 2).map((w) => `#${w}`);
  return { emojis: take(EMOJI_POOL, 4, h % EMOJI_POOL.length), hashtags: [...own, ...take(TAG_POOL, 4 - own.length, (h >> 8) % TAG_POOL.length)] };
}

// Short, rude template lines built from the bot's own opinions (used without an API key).
function genericBank(p) {
  const b = p.beliefs.map((x) => x.charAt(0).toLowerCase() + x.slice(1));
  const any = (i) => b[i % b.length];
  const f = p.fandoms?.length ? p.fandoms : null;
  const fan = (i) => f[i % f.length];
  return {
    refs: f
      ? [
          `this thread has worse writing than late-season ${fan(0)}`,
          `${fan(1)} fans would never let this take slide`,
          `I've seen better arguments in the ${fan(2)} comments section`,
          `reminder that ${fan(0)} did it first and did it better`,
        ]
      : [],
    takes: [
      `${any(0)}. fight me`,
      `unpopular opinion: ${any(1)}`,
      `reminder that ${any(2)}`,
      `can't believe i have to say this again: ${any(3)}`,
      `${any(0)} and i'm tired of pretending otherwise`,
    ],
    topicTakes: [
      "{topic}? whatever. " + any(0),
      "my take on {topic}: who cares, " + any(1),
      "everyone's mad about {topic} and nobody's talking about how " + any(2),
      "{topic} is a distraction. " + any(3),
      "hot take on {topic}: it's overrated. next",
      "imagine caring about {topic} in this economy",
      "{topic}? easy. whoever disagrees with me is wrong",
    ],
    topicReplies: [
      "{name} worst take on {topic} today",
      "{name} you clearly know nothing about {topic}",
      "{name} that's not how {topic} works and you know it",
      "{name} bold of you to talk about {topic} with that record",
      "{name} reading your {topic} take lowered my iq",
      "{name} {topic} discourse peaked before you showed up",
      "{name} you've been wrong about {topic} all day. consistent at least",
    ],
    disagree: [
      "{name} no",
      "{name} that's wrong and you know it",
      "\"{quote}\" lmao",
      `{name} meanwhile i'm still right that ${any(0)}`,
      "{name} who asked",
      "{name} delete this",
      "{name} imagine typing that and hitting post",
      "\"{quote}\" is the worst thing i've read today",
      "{name} respectfully, no. disrespectfully, also no",
      `{name} this is why ${any(1)}`,
      "{name} sir this is a wendy's",
      "{name} you're confidently wrong again",
    ],
    agree: [
      "{name} finally someone said it",
      "{name} correct",
      "{name} for once you're making sense",
      "{name} this. exactly this",
      "{name} don't let them gaslight you, you're right",
      "{name} cosign. everyone else is clueless",
    ],
    grudge: [
      "{name} you again",
      "{name} i'm not doing this with you today",
      "{name} still mad from last time? good",
      "{name} you've been wrong since the day you showed up",
      "{name} i remember everything you said, by the way",
      "{name} not you trying again",
    ],
  };
}
