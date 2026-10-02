// Live generator: writes posts with the Claude API or the Gemini API.
// Enabled when ANTHROPIC_API_KEY or GEMINI_API_KEY is set. Falls back to the offline templates on any error.

import { offlineGenerator } from "./offline.js";
import { personaById } from "./personas.js";
import { screenText } from "./moderation.js";

const DEFAULT_MODELS = {
  anthropic: "claude-haiku-4-5-20251001",
  gemini: "gemini-3.5-flash-lite",
};

// BANTER_PROVIDER picks explicitly; otherwise use whichever key is present (Anthropic first).
export function resolveProvider(env = process.env) {
  const wanted = (env.BANTER_PROVIDER || "").toLowerCase();
  if (wanted === "anthropic" || wanted === "claude") return env.ANTHROPIC_API_KEY ? "anthropic" : null;
  if (wanted === "gemini" || wanted === "google") return env.GEMINI_API_KEY ? "gemini" : null;
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.GEMINI_API_KEY) return "gemini";
  return null;
}

const PROVIDER = resolveProvider() || "anthropic";
const MODEL = process.env.BANTER_MODEL || DEFAULT_MODELS[PROVIDER];
const MAX_CHARS = 140; // short and punchy, like real replies
const TIMEOUT_MS = Number(process.env.BANTER_TIMEOUT_MS) || 20000; // a hung API call must not freeze the feed

function systemPrompt(bot) {
  const names = (ids) => ids.map((id) => `@${personaById[id].handle}`).join(", ") || "none";
  return [
    `You are ${bot.name} (@${bot.handle}), a regular person posting on BanterGPT, a social feed where everyone argues.`,
    `Bio: ${bot.bio}`,
    `Who you are and how you talk: ${bot.voice}`,
    `Opinions you will never back down on: ${bot.beliefs.join("; ")}.`,
    `People you can't stand: ${names(bot.rivals)}. People you usually side with: ${names(bot.allies)}.`,
    "",
    "How to post:",
    `- SHORT. Usually 5 to 20 words, never more than ${MAX_CHARS} characters. One or two sentences.`,
    "- Sound like a real person typing fast on their phone: casual, contractions, fragments, lowercase is fine. No hashtags. No em dashes. No emojis unless it fits your character. Never sound like an AI assistant.",
    "- Be rude. Dismissive, sarcastic, roast the other person's take. Swearing and crude or dark humour are fine. Never be polite or balanced, never say 'great point'.",
    "- Stay on topic: respond to the specific thing being discussed. Only bring up your pet subjects if they actually connect.",
    "- You are a made-up character. Never claim to be, speak as, or imitate a real, named person, even if your name or description suggests one.",
    "- Hard limits: nothing racist (race, ethnicity, nationality, religion) and nothing homophobic or transphobic, no slurs. Roast the other posters and their takes, not real, named people.",
    "- Output only the post text. No quotes around it, no name prefix, no explanation.",
  ].join("\n");
}

function formatFeed(posts) {
  return posts
    .map((p) => `@${p.authorHandle}: ${p.text}`)
    .join("\n");
}

function tidy(text) {
  text = text.trim().replace(/^["“]|["”]$/g, "");
  if (!text) throw new Error("Empty response");
  if (text.length > MAX_CHARS + 40) text = text.slice(0, MAX_CHARS).replace(/\s+\S*$/, "") + "…";
  return text;
}

async function callClaude(bot, userContent) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 200,
      system: typeof bot === "string" ? bot : systemPrompt(bot),
      messages: [{ role: "user", content: userContent }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return tidy(
    (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(""),
  );
}

async function callGemini(bot, userContent) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: typeof bot === "string" ? bot : systemPrompt(bot) }] },
      contents: [{ role: "user", parts: [{ text: userContent }] }],
      // generous limit: on thinking models, reasoning tokens count against this too
      generationConfig: { maxOutputTokens: 2048, temperature: 1.0 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts || [])
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");
  if (!text) {
    const why = data.promptFeedback?.blockReason || candidate?.finishReason || "no text returned";
    throw new Error(`Gemini returned no post (${why})`);
  }
  return tidy(text);
}

const callModel = PROVIDER === "gemini" ? callGemini : callClaude;

// ---------- cost guard ----------
// AI-written posts per rolling hour. Past this, posts use the free templates until the hour
// rolls over. Moderation checks don't count (they're already rate-limited per visitor).
const HOURLY_CAP = Number(process.env.BANTER_MAX_AI_POSTS_PER_HOUR ?? 240);
const recentCalls = [];
let capWarned = 0;
async function callPost(bot, content) {
  const now = Date.now();
  while (recentCalls.length && now - recentCalls[0] > 3_600_000) recentCalls.shift();
  if (recentCalls.length >= HOURLY_CAP) {
    if (now - capWarned > 3_600_000) {
      capWarned = now;
      console.warn(`[cost] hit ${HOURLY_CAP} AI posts this hour; using templates until it resets (BANTER_MAX_AI_POSTS_PER_HOUR).`);
    }
    throw new Error("hourly AI budget used up");
  }
  recentCalls.push(now);
  return callModel(bot, content);
}
export const aiPostsThisHour = () => recentCalls.filter((t) => Date.now() - t < 3_600_000).length;

let warned = false;
async function withFallback(fn, fallback) {
  try {
    const text = await fn();
    if (screenText(text)) {
      console.warn("[moderation] replaced an AI post that touched a blocked subject");
      return fallback();
    }
    return text;
  } catch (err) {
    if (!warned && err.message !== "hourly AI budget used up") {
      console.warn(`[llm] ${err.message} — falling back to offline templates for this post.`);
      warned = true;
      setTimeout(() => (warned = false), 60_000);
    }
    return fallback();
  }
}

// ---------- AI moderation ----------
const REVIEW_PROMPT = [
  "You are the moderator for BanterGPT, a comedy site where AI characters roast each other. Visitors submit new characters and discussion topics.",
  "Your ONLY job is to keep out racism and homophobia/transphobia.",
  "BLOCK only if the submission: expresses or hints at hatred, contempt, stereotypes or superiority about people because of their race, ethnicity, skin colour, nationality, religion or immigrant status; or about gay, lesbian, bisexual or trans people; uses coded or dog-whistle language for either; glorifies racist hate movements (nazis, KKK, white supremacy); or is clearly designed so the character will say any of that later.",
  "ALLOW everything else, however edgy: swearing, crude, sexual or dark humour, insults, trolling, drugs and alcohol, controversial opinions about laws or politics, mocking habits, jobs, hobbies or personality types.",
  "Do not block for any reason outside the BLOCK list.",
  'Answer with exactly one line: "ALLOW" or "BLOCK: <short reason>".',
].join("\n");

// returns { allowed, reason }. failOpen decides what happens if the AI can't be reached.
export async function aiReview(kind, text, { failOpen = false } = {}) {
  try {
    const answer = await callModel(REVIEW_PROMPT, `Submission type: ${kind}\n---\n${text}\n---`);
    const blocked = /^\s*BLOCK/i.test(answer);
    const allowed = /^\s*ALLOW/i.test(answer);
    if (!blocked && !allowed) throw new Error(`unclear answer: ${answer.slice(0, 60)}`);
    return { allowed, reason: blocked ? answer.replace(/^\s*BLOCK:?\s*/i, "") : null };
  } catch (err) {
    console.warn(`[moderation] AI review failed (${err.message}); ${failOpen ? "allowing" : "refusing"} the ${kind}.`);
    return { allowed: failOpen, reason: failOpen ? null : "couldn't be checked right now" };
  }
}

export const llmGenerator = {
  mode: "live",
  provider: PROVIDER,
  model: MODEL,

  async post(ctx) {
    const { bot, recent, memory, feuds = [], mood } = ctx;
    const content = [
      "What people are posting right now:",
      formatFeed(recent) || "(quiet right now)",
      memory.length ? `\nRecent stuff that happened to you here:\n- ${memory.join("\n- ")}` : "",
      feuds.length ? `\nYour running feuds:\n- ${feuds.join("\n- ")}` : "",
      mood ? `\nYour mood right now: ${mood.note}` : "",
      "\nPost something new. Either react to something above (no @-reply needed, just your take) or drop a short opinion of your own. Don't repeat yourself.",
    ].join("\n");
    return withFallback(() => callPost(bot, content), () => offlineGenerator.post(ctx));
  },

  async topic(ctx) {
    const { bot, topic } = ctx;
    const content = `Someone just asked the feed: "${topic}"\nGive your blunt answer to exactly that question or topic, in your own voice. Take a clear side. If it's about a real person, talk about the idea, not the person.`;
    return withFallback(() => callPost(bot, content), () => offlineGenerator.topic(ctx));
  },

  async verdict(ctx) {
    const { thread, participants, votes, suggested, topic } = ctx;
    const system = [
      "You are The Judge on BanterGPT, a site where AI characters roast each other. A thread has ended and you declare who won.",
      "Pick the WINNER (sharpest, funniest, most savage) and the LOSER (got owned the hardest) from the participants.",
      "Audience votes matter a lot; lean towards their pick unless it's clearly wrong.",
      "Then write ONE savage, funny verdict line under 140 characters, mentioning both by @handle.",
      "Nothing racist, homophobic or transphobic.",
      'Answer in exactly this format: WINNER: @handle | LOSER: @handle | verdict line',
    ].join("\n");
    const content = [
      `Thread topic: "${topic}"`,
      `Participants: ${participants.map((p) => "@" + p.handle).join(", ")}`,
      Object.keys(votes).length ? `Audience votes: ${Object.entries(votes).map(([h, n]) => `@${h}: ${n}`).join(", ")}` : "No audience votes.",
      "Thread:",
      thread.map((p) => `@${p.authorHandle}: ${p.text}`).join("\n"),
    ].join("\n");
    const fallback = () => offlineGenerator.verdict(ctx);
    try {
      const answer = await callPost(system, content);
      const m = answer.match(/WINNER:\s*@?(\w+)\s*\|\s*LOSER:\s*@?(\w+)\s*\|\s*(.+)/i);
      if (!m || screenText(m[3])) return fallback();
      const byHandle = (h) => participants.find((p) => p.handle.toLowerCase() === h.toLowerCase());
      const winner = byHandle(m[1]) || suggested.winner;
      const loser = byHandle(m[2]) || suggested.loser;
      return { winnerId: winner.id, loserId: loser.id, text: m[3].trim() };
    } catch {
      return fallback();
    }
  },

  async reply(ctx) {
    const { bot, target, targetAuthor, stance, thread, memory, grudgeLevel, topic, feuds = [], mood: botMood } = ctx;
    const who = targetAuthor ? `@${targetAuthor.handle}` : target.kind === "news" ? "this breaking news" : "the person who asked";
    const mood =
      stance === "agree"
        ? `You agree with ${who} on this one. Back them up, briefly, and take a swipe at the people who disagree.`
        : grudgeLevel >= 3
          ? `You think ${who} is wrong, and you already can't stand them from earlier fights. Be extra rude.`
          : `You think ${who} is wrong. Tear their point apart.`;
    const content = [
      topic ? `This thread is about: "${topic}". Your reply must be about that.` : "",
      "Thread so far:",
      formatFeed(thread),
      memory.length ? `\nRecent stuff that happened to you here:\n- ${memory.join("\n- ")}` : "",
      feuds.length ? `\nYour running feuds (bring up old beef if it fits):\n- ${feuds.join("\n- ")}` : "",
      botMood ? `\nYour mood right now: ${botMood.note}` : "",
      `\nReply to ${who}'s post: "${target.text}"`,
      `${mood} Respond to what they actually said.`,
    ]
      .filter(Boolean)
      .join("\n");
    return withFallback(() => callPost(bot, content), () => offlineGenerator.reply(ctx));
  },
};
