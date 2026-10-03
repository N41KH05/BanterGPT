// User-created bots: validation and a generic template bank so custom bots can banter
// in offline mode too. Shared by the server and the in-browser demo.

import { censor } from "./censor.js";
import { screenText, REFUSAL } from "./moderation.js";

export const MAX_CUSTOM = 12; // past this, the worst-performing visitor bot gets cancelled

const LIMITS = { name: 24, handle: 20, bio: 100, voice: 220, belief: 100 };
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

  if (name.length < 2) return { error: "Give your bot a name." };
  if (!/^[A-Za-z0-9_]{3,20}$/.test(handle)) return { error: "Handle: 3–20 letters, numbers or underscores." };
  if (beliefs.length < 1) return { error: "Give your bot at least one opinion it will die on." };
  if (!voice) return { error: "Describe how your bot talks." };

  // a bot built around a slur shouldn't exist at all, so reject rather than star it out
  if (hasBlocked(name) || hasBlocked(handle) || hasBlocked(avatar)) return { error: "Pick a different name or handle." };
  if ([bio, voice, ...beliefs].some(hasBlocked)) return { error: "Keep slurs out of your bot." };
  // no bots about race, ethnicity, religion, nationality, sexuality or hate movements
  if (screenText(name, handle, avatar, bio, voice, beliefs)) return { error: REFUSAL };

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
    interests: beliefs.flatMap((b) => b.toLowerCase().match(/[a-z]{4,}/g) || []).slice(0, 12),
    rivals,
    allies,
    custom: true,
    createdAt: Date.now(),
  };
  persona.offline = genericBank(persona);
  return { persona };
}

// Rebuilds a saved custom bot (template lines aren't saved; they're regenerated).
export function restoreCustomPersona(saved) {
  const persona = { ...saved, custom: true };
  persona.offline = genericBank(persona);
  return persona;
}

// Short, rude template lines built from the bot's own opinions (used without an API key).
function genericBank(p) {
  const b = p.beliefs.map((x) => x.charAt(0).toLowerCase() + x.slice(1));
  const any = (i) => b[i % b.length];
  return {
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
    ],
    topicReplies: ["{name} worst take on {topic} today", "{name} you clearly know nothing about {topic}"],
    disagree: [
      "{name} no",
      "{name} that's wrong and you know it",
      "\"{quote}\" lmao",
      `{name} meanwhile i'm still right that ${any(0)}`,
      "{name} who asked",
    ],
    agree: ["{name} finally someone said it", "{name} correct"],
    grudge: ["{name} you again", "{name} i'm not doing this with you today"],
  };
}
