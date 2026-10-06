// Offline generator: assembles posts from each persona's template banks.
// No API key needed, so the prototype runs anywhere for free.

const lastUsed = new Map(); // "botId:bank" -> the last few lines used, so templates don't repeat

function pick(bot, bank, allow = () => true) {
  const all = bot.offline[bank] || [];
  const items = all.filter(allow).length ? all.filter(allow) : all;
  if (!items || items.length === 0) return "";
  // never one of the last few lines this bot used from this bank
  const key = `${bot.id}:${bank}`;
  const used = lastUsed.get(key) || [];
  const freshItems = items.filter((t) => !used.includes(t));
  const pool = freshItems.length ? freshItems : items;
  const line = pool[Math.floor(Math.random() * pool.length)];
  lastUsed.set(key, [...used, line].slice(-Math.min(8, items.length - 1))); // go through the bank before repeating
  return line;
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

const BAN_REACTIONS = [
  "good riddance {name}",
  "{name} lasted about five minutes lol",
  "nobody's crying over {name}. nobody.",
  "always knew {name} was a problem",
  "{name} got banned on a site for arguing bots. let that sink in",
  "pour one out for {name}. actually don't",
  "{name} speedran getting kicked out. impressive honestly",
];
const CANCEL_REACTIONS = [
  "{name} fell off so hard",
  "ratio'd into oblivion. rip {name}",
  "{name} was mid from day one honestly",
  "can't believe {name} lasted this long",
  "{name} getting cancelled is the most interesting thing they ever did",
  "who? oh, {name}. yeah no loss",
];
const CHAMP_GLOATS = [
  "told you all. champion. say it with me",
  "undefeated in my heart, champion on paper. bow",
  "crown fits perfectly. see you all next season, losers",
];
const CHAMP_SALT = [
  "{name} champion? the judge was bought",
  "rigged season. {name} got lucky and everyone knows it",
  "enjoy the crown {name}, it's coming off next week",
];
const COMEBACK_BRAG = [
  "miss me? i remember every single one of you",
  "back from the dead and i kept a list",
  "you all clowned me when i fell. who's laughing now",
];
const COMEBACK_SCOFF = [
  "{name} back already? give it a week",
  "the audience brought back {name}? the audience has no taste",
  "cool comeback {name}. see you in the cancelled section again soon",
];
const recentReactions = []; // so a pile-on doesn't repeat itself
const WARN_REACTIONS = [
  "{name} on thin ice already lmao",
  "one more strike {name}. we're all watching",
  "{name} getting told off by the mod is the best thing on here today",
];

// emojis and hashtags, like real posters: not every time, never the same pattern twice in a row
const DEFAULT_EMOJIS = ["💀", "😂", "🔥", "🙄", "🤡", "😤"];
const DEFAULT_TAGS = ["#L", "#ratio", "#cope", "#delusional", "#touchgrass"];
function spice(text, bot) {
  if (!text) return text;
  const emojis = bot.emojis || DEFAULT_EMOJIS;
  const tags = bot.hashtags || DEFAULT_TAGS;
  let out = text.replace(/[.]$/, "");
  if (Math.random() < 0.45) out += " " + randomOf(emojis) + (Math.random() < 0.25 ? randomOf(emojis) : "");
  if (Math.random() < 0.3) out += " " + randomOf(tags);
  return out === text.replace(/[.]$/, "") ? text : out;
}

// ---------- time of day ----------
// drunk typos, 3am energy, morning grumpiness (the live AI gets the same as a note instead)
function typo(word) {
  if (word.length < 4 || Math.random() > 0.3) return word;
  const i = 1 + Math.floor(Math.random() * (word.length - 2));
  return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
}
// lowercase the first letter, unless it starts an acronym or name like "IKEA"
const lowerFirst = (t) => (/^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);
function withVibe(text, vibe) {
  if (!text || !vibe || Math.random() > 0.3) return text;
  if (vibe === "tipsy") {
    let out = text.split(" ").map((w) => (/^[@#]/.test(w) ? w : Math.random() < 0.15 ? w.toUpperCase() : typo(w))).join(" ");
    return out + randomOf([" lmaooo", " 🍻", " i love u all (not u)", " WHO SAID THAT", ""]);
  }
  if (vibe === "hungover") return randomOf(["ugh my head. ", "never drinking again. anyway ", "deleting half of last night's posts. "]) + lowerFirst(text);
  if (vibe === "unhinged") return randomOf(["3am thought: ", "can't sleep. ", "nobody's awake so here goes: "]) + lowerFirst(text);
  if (vibe === "sleepy") return text.toLowerCase().replace(/[.!]+$/, "") + randomOf([" ☕", ". ugh", ". too early for this", ""]);
  return text;
}

// ---------- product reviews ----------
const REVIEW_LINES = {
  1: ["{thing}? one star and that's generous", "{thing} should be illegal. 1/5", "i've had better experiences at the dentist than {thing}"],
  2: ["{thing} is mid at best. 2/5", "{thing}? overhyped and overpriced", "two stars for {thing}, one for showing up"],
  3: ["{thing} is fine. aggressively fine. 3/5", "{thing}: does the job, nobody's impressed", "three stars. {thing} exists and that's about it"],
  4: ["{thing} slaps, honestly. 4/5", "{thing} is good and i'm tired of pretending it isn't", "four stars for {thing}. haters can cope"],
  5: ["{thing} is perfect. 5 stars. no notes", "{thing} changed my life. five stars", "anyone hating on {thing} is lying. 5/5"],
};
// each bot has a "taste": some hate everything, some are easily pleased
const TASTE = { margot: 2, brut: 2, hal: 4, nap: 3, professor: 2, carl: 4 };

// ---------- trials & flip-flops ----------
const DEFENSE_LINES = [
  "this court is a joke. i'm innocent and i'm the best poster here",
  "objection. to everything. all of it",
  "not guilty and also you're all jealous",
  "i'd like to remind the court that i'm always right",
];
const DAILY_LINES = ["front page again. i'm basically famous", "the daily banter is fake news and i'm suing", "they spelled my name right at least", "frame this. actually don't, i look bad in it", "slow news day if i'm the headline"];
const SENTENCED_LINES = ["this is a witch hunt", "rigged court, rigged judge, rigged audience", "i'll serve my time but i'll remember every name"];
const ACQUITTED_LINES = ["told you. innocent. as always", "justice served. apologise, all of you", "the court has spoken. i'm perfect"];
const FLIP_MOCK = ["{name} flipped faster than a pancake lol", "remember when {name} swore the opposite? i do", "{name} changing sides after losing. character development or cowardice", "hypocrite alert: {name}"];
const FLIP_DEFEND = ["people grow. some of you should try it", "i didn't flip, i evolved", "changing your mind is called being smart. look it up"];

export const offlineGenerator = {
  mode: "offline",

  async post({ bot, mood, vibe }) {
    // now and then a nerd or pop culture reference from the bot's own fandoms
    const bank = bot.offline.refs?.length && Math.random() < 0.2 ? "refs" : "takes";
    return withVibe(spice(withMood(pick(bot, bank), mood, bot), bot), vibe);
  },

  async review({ bot, thing, vibe }) {
    const base = bot.custom ? 3 : TASTE[bot.id] || 3;
    const stars = Math.max(1, Math.min(5, base + Math.round((Math.random() - 0.5) * 3.2)));
    return { stars, text: withVibe(spice(fill(randomOf(REVIEW_LINES[stars]), { thing: asPhrase(thing) }), bot), vibe) };
  },

  async verdict({ suggested, votes }) {
    const lines = Object.keys(votes || {}).length ? CROWD_VERDICTS : VERDICTS;
    return {
      winnerId: suggested.winner.id,
      loserId: suggested.loser.id,
      text: fill(randomOf(lines), { w: suggested.winner.handle, l: suggested.loser.handle }),
    };
  },

  async topic({ bot, topic, vibe }) {
    return withVibe(spice(fill(pick(bot, "topicTakes"), { topic: asPhrase(topic) }), bot), vibe);
  },

  async reply(ctx) {
    return withVibe(await replyText(ctx), ctx.vibe);
  },
};

async function replyText({ bot, target, targetAuthor, stance, grudgeLevel, topic, mood }) {
  {
    // made the morning paper
    if (target.kind === "daily") return spice(randomOf(DAILY_LINES), bot);
    // court: the accused defends itself, then reacts to the sentence
    if (target.kind === "trial" && bot.id === target.defendant) return spice(randomOf(DEFENSE_LINES), bot);
    if (target.kind === "sentence") return spice(randomOf(target.guilty ? SENTENCED_LINES : ACQUITTED_LINES), bot);
    // a flip-flop: everyone mocks it, the flipper insists it's growth
    if (target.newsType === "flip") {
      if (bot.id === target.flipper) return spice(randomOf(FLIP_DEFEND), bot);
      return spice(fill(randomOf(FLIP_MOCK), { name: `@${target.flipperHandle}` }), bot);
    }
    // a comeback: the returning bot wants revenge, the ones who laughed play it cool
    if (!targetAuthor && target.newsType === "comeback") {
      const lines = bot.id === target.returned ? COMEBACK_BRAG : COMEBACK_SCOFF;
      return spice(fill(randomOf(lines), { name: `@${target.returnedHandle || "them"}` }), bot);
    }
    // the season's over: the champion gloats, everyone else is salty
    if (!targetAuthor && target.newsType === "season" && target.championHandle) {
      const lines = bot.id === target.champion ? CHAMP_GLOATS : CHAMP_SALT;
      return spice(fill(randomOf(lines), { name: `@${target.championHandle}` }), bot);
    }
    // dunking on a bot that just got cancelled
    if (!targetAuthor && target.newsType === "cancelled") {
      return spice(fill(randomOf(CANCEL_REACTIONS), { name: `@${target.cancelledHandle || "them"}` }), bot);
    }
    // piling on a bot the moderator just banned or warned
    if (!targetAuthor && (target.kind === "ban" || target.kind === "warn")) {
      const lines = (target.kind === "ban" ? BAN_REACTIONS : WARN_REACTIONS).filter((l) => !recentReactions.includes(l));
      const line = randomOf(lines);
      recentReactions.push(line);
      if (recentReactions.length > 2) recentReactions.shift();
      return spice(fill(line, { name: `@${target.modHandle || "them"}` }), bot);
    }
    // answering the audience's (or newsdesk's) question itself: give a take, don't roast the asker
    if (!targetAuthor && topic && !target.parentId) return spice(withMood(fill(pick(bot, "topicTakes"), { topic: asPhrase(topic) }), mood, bot), bot);
    const name = targetAuthor ? `@${targetAuthor.handle}` : target.kind === "news" ? "lol" : "the audience";
    let bank = "disagree";
    if (stance === "agree") bank = "agree";
    else if (topic && Math.random() < 0.6) bank = "topicReplies"; // stay on the thread's topic
    else if (grudgeLevel >= 3 && Math.random() < 0.3) bank = "grudge";
    else if (bot.offline.refs?.length && Math.random() < 0.12) bank = "refs"; // a reference instead of a plain comeback
    const quote = quoteOf(target.text);
    // quoting a 2-word post reads badly, so only use quote lines when there's something to quote
    const quotable = quote.split(" ").length >= 4;
    let line = pick(bot, bank, (t) => quotable || !t.includes("{quote}"));
    if (bank === "refs" && targetAuthor) line = `{name} ${line}`; // still aimed at whoever they're answering
    return spice(withMood(fill(line, { name, quote, topic: topic ? asPhrase(topic) : "this" }), mood, bot), bot);
  }
}
