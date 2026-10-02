// Offline generator: assembles posts from each persona's template banks.
// No API key needed, so the prototype runs anywhere for free.

const lastUsed = new Map(); // "botId:bank" -> last index, to avoid immediate repeats

function pick(bot, bank, allow = () => true) {
  const all = bot.offline[bank] || [];
  const items = all.filter(allow).length ? all.filter(allow) : all;
  if (!items || items.length === 0) return "";
  const key = `${bot.id}:${bank}`;
  let i = Math.floor(Math.random() * items.length);
  if (items.length > 1 && i === lastUsed.get(key)) i = (i + 1) % items.length;
  lastUsed.set(key, i);
  return items[i];
}

function quoteOf(text) {
  // drop leading @mentions and quote marks so bots don't quote each other's quotes
  const clean = text.replace(/\s+/g, " ").replace(/^(\s*(@\S+|["“”]))+\s*/, "").replace(/["“”]/g, "").trim();
  return clean.split(" ").slice(0, 5).join(" ").replace(/[.,!?…:;]+$/, "");
}

// "Is a hot dog a sandwich?" -> "“is a hot dog a sandwich”" so it reads inside a sentence
function asPhrase(topic) {
  let t = topic.trim().replace(/[.!?…]+$/, "");
  if (/^[A-Z][a-z]/.test(t)) t = t[0].toLowerCase() + t.slice(1);
  return t.split(" ").length <= 2 ? t : `“${t}”`;
}

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}

const VERDICTS = [
  "@{w} wins this one. @{l}, that was embarrassing to watch.",
  "Verdict: @{w}. @{l} should log off and think about what they said.",
  "@{w} takes it. @{l} brought a spoon to a knife fight.",
  "Winner: @{w}. Loser: @{l}, by a mile.",
  "@{l} got cooked. @{w} wins.",
  "Case closed. @{w} wins, @{l} pays court costs.",
];
const CROWD_VERDICTS = [
  "The crowd has spoken: @{w}. @{l}, nobody was on your side.",
  "By popular demand, @{w} wins. @{l}, even the audience turned on you.",
];
const MOOD_PREFIX = {
  cocky: ["undefeated btw. ", "still winning. ", "another W incoming. ", "not to brag but "],
  salty: ["whatever. ", "the judge is rigged but ok. ", "not that anyone asked me but ", "still mad about earlier. "],
  furious: ["i'm SO done with this place. ", "ok that's it. "],
};
const randomOf = (arr) => arr[Math.floor(Math.random() * arr.length)];

// a mood occasionally leaks into a template line
function withMood(text, mood, bot) {
  if (!mood || !MOOD_PREFIX[mood.name] || Math.random() > 0.35) return text;
  const prefix = randomOf(MOOD_PREFIX[mood.name]);
  const body = bot.id === "nap" ? text : text.charAt(0).toLowerCase() + text.slice(1);
  return prefix + body;
}

export const offlineGenerator = {
  mode: "offline",

  async post({ bot, mood }) {
    return withMood(pick(bot, "takes"), mood, bot);
  },

  async verdict({ suggested, votes }) {
    const lines = Object.keys(votes || {}).length ? CROWD_VERDICTS : VERDICTS;
    return {
      winnerId: suggested.winner.id,
      loserId: suggested.loser.id,
      text: fill(randomOf(lines), { w: suggested.winner.handle, l: suggested.loser.handle }),
    };
  },

  async topic({ bot, topic }) {
    return fill(pick(bot, "topicTakes"), { topic: asPhrase(topic) });
  },

  async reply({ bot, target, targetAuthor, stance, grudgeLevel, topic, mood }) {
    // answering the audience's (or newsdesk's) question itself: give a take, don't roast the asker
    if (!targetAuthor && topic && !target.parentId) return withMood(fill(pick(bot, "topicTakes"), { topic: asPhrase(topic) }), mood, bot);
    const name = targetAuthor ? `@${targetAuthor.handle}` : target.kind === "news" ? "lol" : "the audience";
    let bank = "disagree";
    if (stance === "agree") bank = "agree";
    else if (topic && Math.random() < 0.6) bank = "topicReplies"; // stay on the thread's topic
    else if (grudgeLevel >= 3 && Math.random() < 0.5) bank = "grudge";
    const quote = quoteOf(target.text);
    // quoting a 2-word post reads badly, so only use quote lines when there's something to quote
    const quotable = quote.split(" ").length >= 4;
    const line = pick(bot, bank, (t) => quotable || !t.includes("{quote}"));
    return withMood(fill(line, { name, quote, topic: topic ? asPhrase(topic) : "this" }), mood, bot);
  },
};
