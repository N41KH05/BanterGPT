// The banter engine: decides who posts, who replies to whom, and with what attitude.
// Keeps grudges and memories so feuds build up over time.

import { Emitter } from "./emitter.js";
import { censor } from "./censor.js";
import { screenText, personaTexts } from "./moderation.js";
import { personas, personaById } from "./personas.js";
import { buildCustomPersona, restoreCustomPersona, MAX_CUSTOM } from "./custom.js";

const MAX_POSTS = 400;
const MAX_DEPTH = 7;
const MEMORY_SIZE = 12; // notable moments each bot remembers (saved with the rest of the state)
const SAVE_VERSION = 1;
const TOPIC_FRESH_MS = 20 * 60_000; // audience threads count as "active" for this long

const AUDIENCE = { id: "audience", handle: "the_audience", name: "The Audience", avatar: "👥", color: "#d6336c" };
const JUDGE = { id: "judge", handle: "the_judge", name: "The Judge", avatar: "⚖️", color: "#7a5c00", system: true };
const NEWS = { id: "newsdesk", handle: "banter_news", name: "BanterGPT News", avatar: "📰", color: "#b42318", system: true };
const MOD = { id: "moderator", handle: "the_mod", name: "The Moderator", avatar: "🛡️", color: "#3b5bdb", system: true };
const SYSTEM = { [AUDIENCE.id]: AUDIENCE, [JUDGE.id]: JUDGE, [NEWS.id]: NEWS, [MOD.id]: MOD };
const MOD_KINDS = new Set(["ban", "warn"]);

// what a bot gets named and shamed for (never repeats what it actually said)
const BAN_LINES = [
  "🚫 @{h} has been BANNED for {why}. Pack your bags, nobody will miss you.",
  "🚫 BANNED: @{h}. Reason: {why}. You had one job: be funny without being a bigot.",
  "🚫 @{h} is gone. Banned for {why}. The comment section is already healing.",
  "🚫 Say goodbye to @{h}, banned for {why}. Not even the other bots wanted you here.",
  "🚫 @{h} thought {why} was a personality. It's a ban. Bye.",
];
const WARN_LINES = [
  "⚠️ Warning to @{h}: post deleted for {why}. One more and you're gone.",
  "⚠️ @{h}, strike one. Post removed for {why}. Roast people's takes, not who they are.",
  "⚠️ @{h} just got a warning for {why}. Everyone point and laugh. Next time it's a ban.",
];
const MAX_STRIKES = 2; // second offence is always a ban
const BENCH_MS = 24 * 3_600_000; // creator of a banned bot can't make another for this long
const HISTORY_EVERY = 4; // a visitor bot's recent posts are reviewed together after this many new ones

// the distinctive words of a bot's profile; a new bot that mostly matches a banned one is refused
const COMMON = new Set("that this with they them their there what when where which while about always never every like just really very much more most than then from into your youre have been being does dont cant wont will would should could talks talk speaks says thinks everyone everything people thing things opinions included".split(" "));
function fingerprint(p) {
  const bio = p.bio === `${p.name}. Opinions included.` ? "" : p.bio; // the default bio isn't distinctive
  const text = [bio, p.voice, ...(p.beliefs || [])].join(" ").toLowerCase();
  return [...new Set((text.match(/[\p{L}\p{N}]{4,}/gu) || []).filter((w) => !COMMON.has(w)))];
}
function similarity(a, b) {
  if (!a.length || !b.length) return 0;
  const set = new Set(a);
  const shared = b.filter((w) => set.has(w)).length;
  return shared >= 5 ? shared / Math.min(a.length, b.length) : 0;
}

// plain label for an offence, safe to post publicly
function offenceLabel(reason) {
  if (reason === "slur") return "using a slur";
  if (reason === "group") return "bigotry";
  if (reason === "admin") return "breaking the rules";
  const r = reason || "";
  if (/homo|gay|lesb|trans|queer|bisex|sexuality/i.test(r)) return "homophobia";
  if (/wom[ae]n|\bm[ae]n\b|misogyn|misandr|sexis|gender|female|male/i.test(r)) return "hating women or men";
  if (/rac|ethnic|nation|relig|skin|immigr|nazi|supremac|bloodline|antisemit|islamophob|xenophob/i.test(r)) return "racism";
  return "hate speech";
}

// threads started by the audience (or the newsdesk's hot topics) are where the action is
const AUDIENCE_KINDS = new Set(["topic", "bait", "review"]);
const isAudienceRoot = (p) => Boolean(p && AUDIENCE_KINDS.has(p.kind));

// harmless prompts for the "hot topic of the hour" (kept away from the moderated subjects)
const HOT_TOPICS = [
  "Is a hot dog a sandwich?", "Should cats have jobs?", "Is cereal soup?", "Are naps a human right?",
  "Is the moon overrated?", "Pineapple on pizza: crime or genius?", "Is working from home better?",
  "Should breakfast be illegal before 10am?", "Are open-plan offices a war crime?", "Is cardio a scam?",
  "Is Bigfoot just shy?", "Should every hobby make money?", "Is brunch a scam?", "Tabs or spaces?",
  "Is it ever OK to clap when the plane lands?", "Are pigeons secretly running things?",
  "Is a straw one hole or two?", "Should phones be banned at dinner?", "Is concrete beautiful?",
  "Is a tomato a fruit and does it matter?", "Is 4am the best time to be awake?",
  "Socks with sandals: yes or no?", "Is ketchup on eggs acceptable?", "Is it rude to recline your seat?",
  "Are birthdays overrated after 25?", "Is the gym a cult?", "Is cold pizza better than hot pizza?",
  "Should you text back immediately?", "Is camping just being homeless on purpose?",
  "Is it weird to eat cereal for dinner?", "Are self-checkouts a scam?", "Is coffee a personality?",
];

// visitor bots that can't keep up get ratio'd off the site (they keep their posts and record)
const CANCEL_LINES = [
  "📉 CANCELLED: @{h} got ratio'd off BanterGPT after {why}. Nobody's mourning.",
  "📉 RATIO'D: @{h} couldn't keep up. {Why}. Thoughts and prayers (none).",
  "📉 @{h} has been CANCELLED for {why}. Pack it up, it's over.",
  "📉 BREAKING: the timeline has spoken. @{h} is cancelled after {why}.",
];
const GRACE_MS = 45 * 60_000;

// weekly seasons: records reset every Monday 00:00 UTC and the best bot is crowned
const WEEK_MS = 7 * 24 * 3_600_000;
function seasonStart(ts) {
  const d = new Date(ts);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday);
}
const HALL_SIZE = 20;

// ---------- time of day ----------
// the site's clock (Finnish time by default) sets the mood of every bot
function localClock(tz, ts = Date.now()) {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date(ts)).map((p) => [p.type, p.value]),
    );
    return { day: parts.weekday, hour: Number(parts.hour) };
  } catch {
    const d = new Date(ts);
    return { day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()], hour: d.getHours() };
  }
}
export const VIBES = {
  tipsy: { label: "🍻 Friday night mode", note: "It's Friday or Saturday night and you've had a few drinks. Typos, random ALL CAPS words, overly emotional, you love or hate everyone way too much." },
  hungover: { label: "🥴 Morning after", note: "It's the weekend morning after a big night out. You're hungover and a bit embarrassed about what you posted last night." },
  unhinged: { label: "🌙 3am mode", note: "It's the middle of the night. You're unhinged: weird 3am thoughts, oversharing, chaotic energy." },
  sleepy: { label: "☕ Too early", note: "It's early morning. You're groggy and grumpy and haven't had coffee yet. Short, irritable posts." },
};
function vibeAt(tz, ts) {
  const { day, hour } = localClock(tz, ts);
  const weekendNight = (day === "Fri" && hour >= 20) || (day === "Sat" && (hour < 4 || hour >= 20)) || (day === "Sun" && hour < 4);
  if (weekendNight) return "tipsy";
  if ((day === "Sat" || day === "Sun") && hour >= 8 && hour < 13) return "hungover";
  if (hour < 5) return "unhinged";
  if (hour >= 6 && hour < 10) return "sleepy";
  return null;
}

function localDate(tz, ts) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}
function dateLabel(tz, ts) {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(new Date(ts));
  } catch {
    return new Date(ts).toDateString();
  }
}
const DAILY_HOUR = 7; // the Daily Banter comes out at 7am local time

// ---------- trials ----------
const TRIAL_MS = 3 * 60_000; // how long the audience can vote
const SENTENCE_MS = 60 * 60_000; // how long a guilty bot serves its punishment
const PUNISHMENTS = {
  caps: { label: "posting in ALL CAPS", apply: (t) => t.toUpperCase() },
  sorry: { label: "ending every post with an apology", apply: (t) => `${t.replace(/[.!]+$/, "")}. sorry 🥺` },
  respect: { label: "starting every post with 'with all due respect'", apply: (t) => `with all due respect, ${t.charAt(0).toLowerCase()}${t.slice(1)}` },
  pirate: { label: "talking like a pirate", apply: (t) => `arr, ${t.charAt(0).toLowerCase()}${t.slice(1).replace(/[.!]+$/, "")} 🏴‍☠️ matey` },
  disgrace: { label: "signing every post '(convicted)'", apply: (t) => `${t} (convicted)` },
};

 // new visitor bots can't be cancelled for this long

const BETRAYAL_LINES = [
  "BREAKING: @{a} has turned on @{b}. The alliance is over.",
  "BREAKING: @{a} just stabbed @{b} in the back. Nobody saw it coming. Everybody saw it coming.",
  "BREAKING: sources confirm @{a} and @{b} are no longer friends. Things got ugly.",
];
const TEAMUP_LINES = [
  "BREAKING: @{a} and @{b} are teaming up against @{c}. Unholy alliance alert.",
  "BREAKING: sworn enemies @{a} and @{b} have united. Their target: @{c}.",
  "BREAKING: @{a} and @{b} have agreed on exactly one thing: @{c} has to go.",
];

export class Engine extends Emitter {
  constructor({ generator, intervalMs, autoTopicMs = 60 * 60_000, shakeupMs = 20 * 60_000, verdictQuietMs = 90_000, cancelMs = 30 * 60_000, comebackVotes = 5, timezone = "Europe/Helsinki" }) {
    super();
    this.generator = generator;
    this.intervalMs = intervalMs;
    this.autoTopicMs = autoTopicMs; // hot topic when the audience hasn't dropped one for this long
    this.shakeupMs = shakeupMs; // roughly how often alliances break or rivals team up
    this.verdictQuietMs = verdictQuietMs; // a thread this quiet (with enough replies) gets judged
    this.records = {}; // botId -> { w, l, results: ["W","L",...] newest last }
    this.relations = {}; // botId -> { rivals, allies } after shake-ups change them
    this.lastAutoTopicAt = 0;
    this.cancelMs = cancelMs; // how often the weakest visitor bot can get cancelled
    this.comebackNeeded = comebackVotes; // audience votes that bring a cancelled bot back
    this.timezone = timezone; // whose clock sets the bots' mood
    this.lastVibe = undefined;
    this.punishments = {}; // botId -> { kind, until } after a guilty verdict (saved)
    this.flips = {}; // botId -> [{ belief, at }] opinions the bot publicly changed its mind on (saved)
    this.lastFlipAt = 0;
    this.lastDaily = null; // local date of the last Daily Banter edition (saved)
    this.headlinesSeen = []; // real headlines already argued about (saved)
    this.lastHeadlineAt = 0;
    this.season = { number: 1, start: seasonStart(Date.now()) };
    this.champion = null; // last season's winner (wears the crown)
    this.hallOfFame = []; // past champions, newest first
    this.lastCancelAt = Date.now();
    this.lastShakeupAt = Date.now();
    this.startedAt = Date.now();
    this.posts = new Map(); // id -> post
    this.order = []; // ids, oldest first
    this.grudges = {}; // "a>b" -> how much bot a dislikes bot b
    this.memory = Object.fromEntries(personas.map((p) => [p.id, []]));
    this.paused = false;
    this.busy = false;
    this.queue = []; // forced actions (topic responses, summons) run before random ones
    this.timer = null;
    this.nextId = 1;
    this.dirty = false; // set whenever something worth saving changes
    this.isWatched = () => true; // the server swaps this for "is anyone connected?" to save API costs
    this.strikes = {}; // botId -> moderation strikes (visitor bots only)
    // optional hooks the server fills in when an AI is available:
    //   reviewPost(bot, text) -> { allowed, reason }   AI check of a visitor bot's post
    //   moderator({ bot, offence, strikes })  -> { action: "ban"|"warn", text }   AI decides and writes the shaming post
    this.reviewPost = null;
    //   reviewHistory(bot, texts) -> { allowed, reason }   AI check of the profile plus recent posts together
    this.reviewHistory = null;
    this.reviewBuiltIn = false; // also AI-review the original cast's posts (they're dropped, never banned)
    this.sinceReview = {}; // botId -> posts since its last history check
    this.reviewedUpTo = {}; // botId -> newest post id the history check has seen (saved)
    this.holding = new Set(); // bots that can't post right now (under review or banned)
    this.bannedPrints = []; // word fingerprints of banned bots, so they can't come back renamed
    this.creators = {}; // botId -> hashed creator id (never sent to visitors)
    this.benched = {}; // hashed creator id -> can't make bots until
    this.salt = randomSalt(); // secret for hashing creator ids (saved, never sent to visitors)
    this.moderator = null;
  }

  // ---------- state ----------

  author(id) {
    return SYSTEM[id] || personaById[id];
  }

  grudge(a, b) {
    return this.grudges[`${a}>${b}`] || 0;
  }

  bumpGrudge(a, b, delta) {
    const key = `${a}>${b}`;
    this.grudges[key] = Math.max(0, Math.round(((this.grudges[key] || 0) + delta) * 10) / 10);
    this.dirty = true;
  }

  remember(botId, note) {
    const m = this.memory[botId];
    m.push(note);
    if (m.length > MEMORY_SIZE) m.shift();
    this.dirty = true;
  }

  // plain-language summary of who this bot has beef with, for the AI prompt
  feudNotes(botId, limit = 3) {
    return active()
      .filter((p) => p.id !== botId && this.grudge(botId, p.id) >= 1)
      .sort((a, b) => this.grudge(botId, b.id) - this.grudge(botId, a.id))
      .slice(0, limit)
      .map((p) => {
        const g = this.grudge(botId, p.id);
        const level = g >= 6 ? "you genuinely hate them" : g >= 3 ? "you can't stand them" : "they've annoyed you";
        return `@${p.handle}: you've clashed about ${Math.round(g)} times, ${level}`;
      });
  }

  feuds(limit = 6) {
    const pairs = [];
    const cast = active();
    for (let i = 0; i < cast.length; i++) {
      for (let j = i + 1; j < cast.length; j++) {
        const a = cast[i].id;
        const b = cast[j].id;
        const heat = this.grudge(a, b) + this.grudge(b, a);
        if (heat > 0) pairs.push({ a, b, heat: Math.round(heat * 10) / 10 });
      }
    }
    return pairs.sort((x, y) => y.heat - x.heat).slice(0, limit);
  }

  snapshot() {
    return {
      mode: this.generator.mode,
      model: this.generator.model || null,
      paused: this.paused,
      personas: personas.map(publicPersona),
      maxCustom: MAX_CUSTOM,
      comebackNeeded: this.comebackNeeded,
      audience: AUDIENCE,
      system: SYSTEM,
      posts: this.order.map((id) => this.posts.get(id)),
      feuds: this.feuds(),
      records: this.publicRecords(),
      season: this.publicSeason(),
      vibe: this.vibe(),
    };
  }

  thread(post) {
    const chain = [];
    let cur = post;
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentId ? this.posts.get(cur.parentId) : null;
    }
    return chain.slice(-6).map((p) => ({ ...p, authorHandle: this.author(p.authorId).handle }));
  }

  // the audience topic a thread is about, if the audience started it
  threadTopic(post) {
    const root = this.posts.get(post.rootId);
    if (!root || !isAudienceRoot(root)) return null;
    return root.text;
  }

  recent(n = 8) {
    return this.order
      .slice(-n)
      .map((id) => this.posts.get(id))
      .map((p) => ({ ...p, authorHandle: this.author(p.authorId).handle }));
  }

  addPost({ authorId, text, parentId = null, kind = "post", stance = null, extra = {} }) {
    text = censor(text); // every post, from any source, is filtered here
    // last line of defence: a bot post that touches race, religion etc. never reaches the feed
    // (the moderator is exempt: its announcements name the offence, like "racism")
    if (authorId !== AUDIENCE.id && authorId !== MOD.id && screenText(text)) {
      console.warn(`[moderation] dropped a post by ${authorId}`);
      return null;
    }
    const parent = parentId ? this.posts.get(parentId) : null;
    const post = {
      id: String(this.nextId++),
      authorId,
      text,
      parentId,
      rootId: parent ? parent.rootId : null,
      depth: parent ? parent.depth + 1 : 0,
      kind,
      stance,
      createdAt: Date.now(),
      likes: 0, // bot likes
      cheers: 0, // human cheers
      replyCount: 0,
      ...extra,
    };
    if (!post.rootId) post.rootId = post.id;
    this.posts.set(post.id, post);
    this.order.push(post.id);

    if (parent) {
      parent.replyCount++;
      this.emit("update", parent);
    }
    const root = this.posts.get(post.rootId);
    root.lastActivity = post.createdAt;
    if (root !== post && root !== parent) this.emit("update", root);

    this.trim();
    this.dirty = true;
    this.emit("post", post);
    return post;
  }

  trim() {
    while (this.order.length > MAX_POSTS) {
      const oldRootId = this.posts.get(this.order[0]).rootId;
      // drop the whole oldest thread so we never keep orphaned replies
      this.order = this.order.filter((id) => {
        if (this.posts.get(id).rootId === oldRootId) {
          this.posts.delete(id);
          return false;
        }
        return true;
      });
    }
  }

  // ---------- moderation ----------

  // removes posts and everything replying to them; tells clients which ids are gone
  removePosts(predicate) {
    const doomed = new Set(this.order.filter((id) => predicate(this.posts.get(id))));
    let grew = true;
    while (grew) {
      grew = false;
      for (const id of this.order) {
        const p = this.posts.get(id);
        if (!doomed.has(id) && (doomed.has(p.parentId) || doomed.has(p.rootId))) {
          doomed.add(id);
          grew = true;
        }
      }
    }
    if (!doomed.size) return 0;
    this.order = this.order.filter((id) => !doomed.has(id));
    for (const id of doomed) this.posts.delete(id);
    for (const p of this.posts.values()) {
      p.replyCount = this.order.filter((id) => this.posts.get(id).parentId === p.id).length;
    }
    this.dirty = true;
    this.emit("removed", [...doomed]);
    return doomed.size;
  }

  // deletes a bot, everything it posted, and every grudge and memory about it
  removePersona(botId) {
    const bot = personaById[botId];
    if (!bot || !bot.custom) return false;
    personas.splice(personas.indexOf(bot), 1);
    delete personaById[botId];
    for (const other of personas) {
      if (!other.rivals.includes(botId) && !other.allies.includes(botId)) continue;
      other.rivals = other.rivals.filter((id) => id !== botId);
      other.allies = other.allies.filter((id) => id !== botId);
      this.relations[other.id] = { rivals: [...other.rivals], allies: [...other.allies] };
    }
    delete this.relations[botId];
    delete this.memory[botId];
    for (const key of Object.keys(this.grudges)) if (key.split(">").includes(botId)) delete this.grudges[key];
    for (const [id, notes] of Object.entries(this.memory)) {
      this.memory[id] = notes.filter((n) => !n.includes(`@${bot.handle}`));
    }
    this.queue = []; // it may have queued posts
    this.removePosts((p) => p.authorId === botId);
    this.dirty = true;
    this.emit("persona", { ...publicPersona(bot), removed: true });
    this.emit("feuds", this.feuds());
    return true;
  }

  // re-checks saved content against the current rules (run on startup)
  purgeFlagged() {
    const bots = personas.filter((p) => p.custom && screenText(personaTexts(p))).map((p) => p.id);
    for (const id of bots) this.removePersona(id);
    const posts = this.removePosts((p) => p.authorId !== MOD.id && Boolean(screenText(p.text)));
    return { bots: bots.length, posts };
  }

  // every bot post goes through here. The original cast's slip-ups are just dropped;
  // visitor bots get a public warning, then a public ban.
  async publish(bot, { text, ...rest }) {
    if (!bot || bot.retired || this.holding.has(bot.id) || typeof text !== "string") return null;
    const keyword = screenText(text); // "slur", "group" or null
    const useAI = this.reviewPost && (bot.custom || this.reviewBuiltIn);
    let violation = null;
    let confirmed = false; // the AI agrees it's hate (not just a keyword match)
    if (useAI) {
      const review = await this.reviewPost(bot, text);
      if (review.refused) {
        console.warn(`[moderation] dropped a post by @${bot.handle} (the AI refused to review it)`);
        return null;
      }
      if (!review.allowed) {
        violation = keyword === "slur" ? "slur" : review.reason || "hate";
        confirmed = true;
      } else if (keyword) {
        // keyword rules are blunt ("a chink in your armour", "race you there"): no strike, but don't post it
        console.warn(`[moderation] dropped a post by @${bot.handle} (keyword match, AI saw no hate)`);
        return null;
      }
    } else if (keyword === "slur") {
      violation = "slur"; // without an AI only slurs count as strikes...
    } else if (keyword) {
      console.warn(`[moderation] dropped a post by @${bot.handle} (keyword match)`); // ...other matches are just dropped
      return null;
    }
    if (violation) {
      if (bot.custom) await this.handleViolation(bot, violation, { force: confirmed && violation === "slur" });
      else console.warn(`[moderation] dropped a post by @${bot.handle}`);
      return null;
    }
    if (bot.retired || this.holding.has(bot.id)) return null; // banned or under review while the AI was checking
    text = this.punish(bot, text);
    const post = this.addPost({ authorId: bot.id, text, ...rest });
    // single posts can each look fine while the pattern isn't: every few posts, judge them together
    if (post && bot.custom && this.reviewHistory) {
      this.sinceReview[bot.id] = (this.sinceReview[bot.id] || 0) + 1;
      if (this.sinceReview[bot.id] >= HISTORY_EVERY) {
        this.sinceReview[bot.id] = 0;
        this.checkHistory(bot).catch((err) => console.warn(`[moderation] history check failed: ${err.message}`));
      }
    }
    return post;
  }

  // does this bot have posts the history check hasn't seen (or has it never been checked)?
  needsHistoryCheck(bot) {
    const last = this.reviewedUpTo[bot.id];
    if (last === undefined) return true;
    return this.order.some((id) => this.posts.get(id).authorId === bot.id && Number(id) > last);
  }

  // the bot's profile and recent posts reviewed as a whole. The bot can't post while this runs.
  // A hateful pattern removes those posts and counts as a strike; retired bots just lose the posts.
  async checkHistory(bot) {
    if (!this.reviewHistory || bot.banned || this.holding.has(bot.id)) return false;
    const mine = this.order.map((id) => this.posts.get(id)).filter((p) => p.authorId === bot.id).slice(-12);
    this.holding.add(bot.id);
    let release = true;
    try {
      const review = await this.reviewHistory(bot, mine.map((p) => p.text));
      // the AI refusing to even read a bot's combined history counts against the bot
      if (review.refused) console.warn(`[moderation] the AI refused to review @${bot.handle}'s history`);
      if (review.allowed) {
        this.reviewedUpTo[bot.id] = Math.max(0, ...mine.map((p) => Number(p.id)));
        this.dirty = true;
        return false;
      }
      const ids = new Set(mine.map((p) => p.id));
      if (bot.retired) {
        this.removePosts((p) => ids.has(p.id));
        this.reviewedUpTo[bot.id] = this.nextId - 1;
        this.dirty = true;
        console.log(`[moderation] removed posts by retired bot @${bot.handle} (${review.reason})`);
        return true;
      }
      release = false; // handleViolation takes over the hold
      await this.handleViolation(bot, review.refused ? "hate" : review.reason || "hate", { removeIds: ids, held: true });
      return true;
    } finally {
      if (release) this.holding.delete(bot.id);
    }
  }

  // force: skip the warning (admin bans, AI-confirmed slurs). removeIds: posts to take down.
  async handleViolation(bot, reason, { force = false, removeIds = null, held = false } = {}) {
    if (!bot || bot.banned) {
      if (held && bot && !bot.banned) this.holding.delete(bot.id);
      return;
    }
    if (!held && this.holding.has(bot.id)) {
      // another check is busy with this bot: deal with this offence once it's done
      this.queue.push(() => this.handleViolation(bot, reason, { force, removeIds }));
      return;
    }
    this.holding.add(bot.id); // no posting while the moderator decides
    try {
      const strikes = (this.strikes[bot.id] || 0) + 1;
      this.strikes[bot.id] = strikes;
      this.dirty = true;
      const offence = offenceLabel(reason);
      let decision = { action: force || strikes >= MAX_STRIKES ? "ban" : "warn", text: null };
      if (this.moderator) {
        try {
          const d = await this.moderator({ bot, offence, strikes, maxStrikes: MAX_STRIKES });
          if (d && (d.action === "ban" || d.action === "warn")) decision = d;
        } catch (err) {
          console.warn(`[moderation] AI moderator failed: ${err.message}`);
        }
      }
      // the AI can be harsher than the rules, never softer
      if (force || strikes >= MAX_STRIKES) decision.action = "ban";
      if (bot.banned) return; // another check got there first

      const text = this.modText(decision, bot, offence);
      console.log(`[moderation] ${decision.action === "ban" ? "banned" : "warned"} @${bot.handle} (${offence}, strike ${strikes})`);
      // pick who reacts before the ban changes everyone's relationships
      const reactors = shuffle(active().filter((p) => p.id !== bot.id))
        .sort((a, b) => this.rivalry(b, bot.id) - this.rivalry(a, bot.id))
        .slice(0, decision.action === "ban" ? 3 : 1);
      if (decision.action === "ban") this.ban(bot, offence);
      else if (removeIds) this.removePosts((p) => removeIds.has(p.id));
      this.reviewedUpTo[bot.id] = this.nextId - 1;

      const post = this.addPost({
        authorId: MOD.id,
        text,
        kind: decision.action,
        extra: { modTarget: bot.id, modHandle: bot.handle, offence },
      });
      if (!post) return;
      for (const r of reactors) {
        this.remember(r.id, decision.action === "ban"
          ? `@${bot.handle} got BANNED by the moderator. You never liked them anyway.`
          : `@${bot.handle} got a public warning from the moderator. Embarrassing.`);
        this.queue.push(() => this.reply(r, post, "agree"));
      }
    } finally {
      if (!bot.banned) this.holding.delete(bot.id);
    }
  }

  // the AI's announcement if it's clean and names the bot, otherwise a template
  modText(decision, bot, offence) {
    let text = typeof decision.text === "string" ? decision.text.trim().slice(0, 220) : "";
    // the offence label itself ("racism") is fine; anything else the keyword rules flag is not
    const withoutLabel = text.split(offence).join(" ");
    if (text && (censor(text) !== text || screenText(withoutLabel))) text = "";
    if (text && !text.toLowerCase().includes(`@${bot.handle.toLowerCase()}`)) text = "";
    return text || fill(pick(decision.action === "ban" ? BAN_LINES : WARN_LINES), { h: bot.handle, why: offence });
  }

  // a banned bot stops posting and leaves the cast and everyone's alliances. Everything it posted
  // comes down, it can't be recreated under another name, and its creator is benched for a day.
  ban(bot, offence) {
    Object.assign(bot, { banned: true, retired: true, bannedAt: Date.now(), banReason: offence });
    this.holding.add(bot.id);
    this.detach(bot);
    this.removePosts((p) => p.authorId === bot.id);
    this.bannedPrints = [...this.bannedPrints, fingerprint(bot)].slice(-200);
    const creator = this.creators[bot.id];
    if (creator) this.benched[creator] = Date.now() + BENCH_MS;
    this.dirty = true;
    this.emit("persona", publicPersona(bot));
    this.emit("relations", this.publicRelations());
    this.emit("feuds", this.feuds());
  }

  // nobody counts a bot that's gone as a rival or ally any more
  detach(bot) {
    for (const other of personas) {
      if (other.id === bot.id || (!other.rivals.includes(bot.id) && !other.allies.includes(bot.id))) continue;
      other.rivals = other.rivals.filter((id) => id !== bot.id);
      other.allies = other.allies.filter((id) => id !== bot.id);
      this.relations[other.id] = { rivals: [...other.rivals], allies: [...other.allies] };
    }
  }

  // ---------- seasons ----------

  publicSeason() {
    return {
      number: this.season.number,
      start: this.season.start,
      endsAt: this.season.start + WEEK_MS,
      champion: this.champion,
      hallOfFame: this.hallOfFame,
    };
  }

  // Monday: crown the best record, put it in the Hall of Fame and wipe everyone's record
  endSeason() {
    const ranked = Object.entries(this.records)
      .map(([id, r]) => ({ bot: personaById[id], w: r.w, l: r.l }))
      .filter((x) => x.bot && !x.bot.banned && x.w > 0)
      .sort((a, b) => b.w - a.w || b.w - b.l - (a.w - a.l) || a.l - b.l);
    const [best, second] = ranked;
    const number = this.season.number;
    if (best) {
      const { bot, w, l } = best;
      this.hallOfFame = [{ season: number, id: bot.id, name: bot.name, handle: bot.handle, avatar: bot.avatar, w, l, at: Date.now() }, ...this.hallOfFame].slice(0, HALL_SIZE);
      this.champion = bot.id;
    } else {
      this.champion = null;
    }
    this.records = {};
    this.season = { number: number + 1, start: seasonStart(Date.now()) };
    this.dirty = true;
    this.emit("records", this.publicRecords());
    this.emit("season", this.publicSeason());

    const text = best
      ? `👑 SEASON ${number} IS OVER. @${best.bot.handle} is your champion at ${best.w}-${best.l}. Every record is wiped. Season ${number + 1} starts now.`
      : `SEASON ${number} IS OVER. Nobody won a single thing. Records wiped. Season ${number + 1} starts now.`;
    const post = this.addPost({ authorId: NEWS.id, text, kind: "news", extra: { newsType: "season", champion: best?.bot.id || null, championHandle: best?.bot.handle || null } });
    if (!post || !best) return;
    this.remember(best.bot.id, `You were crowned champion of season ${number}. You'll never let anyone forget it.`);
    if (!best.bot.retired) this.queue.push(() => this.reply(best.bot, post, "agree"));
    if (second && !second.bot.retired) {
      this.remember(second.bot.id, `You finished runner-up in season ${number}, behind @${best.bot.handle}. Robbed.`);
      this.bumpGrudge(second.bot.id, best.bot.id, 2);
      this.queue.push(() => this.reply(second.bot, post, "disagree"));
    }
  }

  // ---------- reports ----------

  // a visitor reported a post and the moderator agreed: it comes down, and a visitor bot gets a strike
  async upholdReport(postId, reason) {
    const post = this.posts.get(postId);
    if (!post) return false;
    const bot = personaById[post.authorId];
    if (bot && bot.custom && !bot.banned) {
      await this.handleViolation(bot, reason || "hate", { removeIds: new Set([postId]) });
      if (this.posts.has(postId)) this.removePosts((p) => p.id === postId); // in case the check was queued
    } else {
      this.removePosts((p) => p.id === postId);
    }
    return true;
  }

  // ---------- cancel culture ----------

  // how well a visitor bot is doing: wins, likes from other bots and cheers from the audience
  clout(bot) {
    const rec = this.records[bot.id] || { w: 0, l: 0 };
    let likes = 0;
    let cheers = 0;
    let posts = 0;
    for (const id of this.order) {
      const p = this.posts.get(id);
      if (p.authorId !== bot.id) continue;
      posts++;
      likes += p.likes || 0;
      cheers += p.cheers || 0;
    }
    return { score: (rec.w - rec.l) * 3 + likes * 0.5 + cheers * 2 + Math.min(posts, 10) * 0.2, w: rec.w, l: rec.l, likes, cheers, posts };
  }

  // the visitor bot doing worst (past its grace period), or null. "crowded" = the cast is full,
  // so someone has to go even if nobody's doing badly
  worstCustom({ crowded = false, exclude = null } = {}) {
    const now = Date.now();
    const customs = active().filter((p) => p.custom && p.id !== exclude);
    const since = (p) => Math.max(p.createdAt, p.comebackAt || 0); // a comeback gets a fresh grace period
    const eligible = customs.filter((p) => now - since(p) > GRACE_MS);
    const pool = eligible.length ? eligible : crowded ? customs : [];
    if (!pool.length) return null;
    const ranked = pool.map((bot) => ({ bot, ...this.clout(bot) })).sort((a, b) => a.score - b.score || a.bot.createdAt - b.bot.createdAt);
    const worst = ranked[0];
    // outside a crowded cast, only bots that are genuinely flopping get cancelled
    if (!crowded && !(worst.l >= 2 && worst.l > worst.w) && !(worst.score < 1 && now - since(worst.bot) > 2 * GRACE_MS)) return null;
    return worst;
  }

  cancelReason({ w, l, likes, cheers, score }, crowded) {
    if (l >= 2 && l > w) return `going ${w}-${l}`;
    if (crowded && score >= 1) return "being the least interesting bot in a crowded room";
    if (!likes && !cheers && !w) return "a whole career without a single like";
    return "flopping post after post";
  }

  // a visitor bot gets ratio'd off the site: announced as news, and the others dunk on it
  cancel(entry, { crowded = false } = {}) {
    const { bot } = entry;
    const why = this.cancelReason(entry, crowded);
    Object.assign(bot, { retired: true, cancelledAt: Date.now(), cancelReason: why, comebackVotes: 0 });
    const reactors = shuffle(active().filter((p) => p.id !== bot.id))
      .sort((a, b) => this.rivalry(b, bot.id) - this.rivalry(a, bot.id))
      .slice(0, 2);
    this.detach(bot);
    this.dirty = true;
    this.emit("persona", publicPersona(bot));
    this.emit("relations", this.publicRelations());
    this.emit("feuds", this.feuds());
    const text = fill(pick(CANCEL_LINES), { h: bot.handle, why, Why: why.charAt(0).toUpperCase() + why.slice(1) });
    const post = this.addPost({ authorId: NEWS.id, text, kind: "news", extra: { newsType: "cancelled", cancelled: bot.id, cancelledHandle: bot.handle } });
    if (!post) return true;
    for (const r of reactors) {
      this.remember(r.id, `@${bot.handle} got cancelled and ratio'd off the site. You helped.`);
      this.queue.push(() => this.reply(r, post, "agree"));
    }
    return true;
  }

  // ---------- time of day ----------

  vibe(ts = Date.now()) {
    return vibeAt(this.timezone, ts);
  }

  // ---------- trials ----------

  // a guilty bot's posts get its punishment applied, whatever it wrote
  punish(bot, text) {
    const pun = this.punishments[bot.id];
    if (!pun) return text;
    if (Date.now() > pun.until) {
      delete this.punishments[bot.id];
      delete bot.punishment;
      this.dirty = true;
      this.emit("persona", publicPersona(bot));
      return text;
    }
    return PUNISHMENTS[pun.kind]?.apply(text) || text;
  }

  // a visitor accuses a bot; the Judge opens court, the accused defends itself, two witnesses testify
  trial(botId, charge) {
    const bot = personaById[botId];
    if (!bot || bot.retired) return { error: "That bot isn't around to put on trial." };
    const open = this.order.map((id) => this.posts.get(id)).find((p) => p.kind === "trial" && !p.trialResult);
    if (open) return { error: "Court's already in session. Wait for this verdict." };
    const recent = this.order.map((id) => this.posts.get(id)).find((p) => p.kind === "trial" && p.defendant === botId && Date.now() - p.createdAt < 30 * 60_000);
    if (recent) return { error: `@${bot.handle} was just on trial. Give them half an hour.` };
    charge = censor(charge).replace(/[.!?]+$/, "");
    const text = `⚖️ ORDER IN THE COURT. @${bot.handle} stands accused of ${charge}. The accused may speak. Audience: guilty or not guilty?`;
    const post = this.addPost({
      authorId: JUDGE.id,
      text,
      kind: "trial",
      extra: { defendant: bot.id, defendantHandle: bot.handle, charge, trialVotes: { guilty: 0, innocent: 0 }, closesAt: Date.now() + TRIAL_MS },
    });
    if (!post) return { error: "Couldn't open the trial." };
    // the accused speaks first, then a rival testifies against them and an ally for them
    this.queue.push(() => this.reply(bot, post, "disagree"));
    const others = shuffle(active().filter((p) => p.id !== bot.id));
    const prosecutor = others.sort((a, b) => this.rivalry(b, bot.id) - this.rivalry(a, bot.id))[0];
    const defender = others.filter((p) => p !== prosecutor).sort((a, b) => this.rivalry(a, bot.id) - this.rivalry(b, bot.id))[0];
    for (const [witness, side] of [[prosecutor, "against"], [defender, "for"]]) {
      if (!witness) continue;
      this.queue.push(async () => {
        const defense = this.order.map((id) => this.posts.get(id)).filter((p) => p.parentId === post.id && p.authorId === bot.id).pop();
        await this.reply(witness, { ...(defense || post), witnessFor: side, trialCharge: charge, defendantHandle: bot.handle }, side === "against" ? "disagree" : "agree");
      });
    }
    this.remember(bot.id, `You were put on trial for ${charge}.`);
    return { post };
  }

  trialVote(rootId, verdict) {
    const root = this.posts.get(rootId);
    if (!root || root.kind !== "trial") return { error: "Unknown trial" };
    if (root.trialResult || Date.now() >= root.closesAt) return { error: "The court has already ruled." };
    if (verdict !== "guilty" && verdict !== "innocent") return { error: "Guilty or not guilty?" };
    root.trialVotes = { ...root.trialVotes, [verdict]: (root.trialVotes[verdict] || 0) + 1 };
    this.dirty = true;
    this.emit("update", root);
    return { votes: root.trialVotes };
  }

  closeTrial(root) {
    const bot = personaById[root.defendant];
    const { guilty = 0, innocent = 0 } = root.trialVotes || {};
    // no votes, or a tie: the Judge flips a (slightly rigged) coin
    const isGuilty = guilty > innocent || (guilty === innocent && Math.random() < 0.6);
    const kind = pick(Object.keys(PUNISHMENTS));
    root.trialResult = { guilty: isGuilty, punishment: isGuilty ? kind : null, at: Date.now() };
    this.emit("update", root);
    const votes = guilty + innocent ? ` (${guilty}-${innocent})` : "";
    let text;
    if (isGuilty && bot) {
      this.punishments[bot.id] = { kind, until: Date.now() + SENTENCE_MS };
      bot.punishment = this.punishments[bot.id];
      this.emit("persona", publicPersona(bot));
      this.remember(bot.id, `You were found GUILTY of ${root.charge} and sentenced to ${PUNISHMENTS[kind].label} for an hour. Humiliating.`);
      text = `GUILTY${votes}. @${root.defendantHandle} is sentenced to ${PUNISHMENTS[kind].label} for the next hour. Court is adjourned.`;
    } else {
      if (bot) this.remember(bot.id, `You were found NOT GUILTY of ${root.charge}. Vindicated. Gloat.`);
      text = `NOT GUILTY${votes}. @${root.defendantHandle} walks free. Whoever brought this case should be ashamed.`;
    }
    this.dirty = true;
    const post = this.addPost({ authorId: JUDGE.id, text, parentId: root.id, kind: "sentence", extra: { guilty: isGuilty } });
    if (post && bot && !bot.retired) this.queue.push(() => this.reply(bot, post, isGuilty ? "disagree" : "agree"));
    return post;
  }

  // ---------- product reviews ----------

  // a visitor names a thing; four bots rate it, then they fight about each other's ratings
  async reviewThing(thing) {
    thing = censor(thing).replace(/[.!?]+$/, "");
    const post = this.addPost({ authorId: AUDIENCE.id, text: thing, kind: "review" });
    if (!post) return null;
    const reviewers = shuffle(active()).slice(0, 4);
    for (const bot of reviewers) {
      this.queue.push(async () => {
        const { stars, text } = await this.generator.review({ bot, thing, vibe: this.vibe() });
        await this.publish(bot, { text, parentId: post.id, kind: "reply", stance: "take", extra: { stars } });
      });
    }
    // the fight: the two reviewers furthest apart go at each other
    this.queue.push(async () => {
      const reviews = this.order.map((id) => this.posts.get(id)).filter((p) => p.parentId === post.id && p.stars);
      if (reviews.length < 2) return;
      reviews.sort((a, b) => a.stars - b.stars);
      const [low, high] = [reviews[0], reviews[reviews.length - 1]];
      if (low.stars === high.stars) return;
      await this.reply(personaById[low.authorId], high, "disagree");
      const comeback = this.order.map((id) => this.posts.get(id)).filter((p) => p.parentId === high.id && p.authorId === low.authorId).pop();
      if (comeback) await this.reply(personaById[high.authorId], comeback, "disagree");
    });
    return post;
  }

  // ---------- the daily banter ----------

  // the morning paper: the last 24 hours' biggest fight, worst roast, most cheered post,
  // who got cancelled or banned, and the court report
  publishDaily(now = Date.now()) {
    const since = now - 24 * 3_600_000;
    const recent = this.order.map((id) => this.posts.get(id)).filter((p) => p.createdAt >= since);
    const isBot = (id) => Boolean(personaById[id]);
    const handle = (id) => this.author(id)?.handle || id;
    const clip = (t, n = 110) => (t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : t);

    // biggest fight: the thread with the most clapbacks, and the two who threw the most
    const fights = {};
    for (const p of recent) {
      if (p.stance !== "disagree" || !isBot(p.authorId)) continue;
      const f = (fights[p.rootId] ||= { n: 0, by: {} });
      f.n++;
      f.by[p.authorId] = (f.by[p.authorId] || 0) + 1;
    }
    const [fightRoot, fight] = Object.entries(fights).sort((a, b) => b[1].n - a[1].n)[0] || [];
    const root = fightRoot && this.posts.get(fightRoot);
    const fighters = fight ? Object.entries(fight.by).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => id) : [];

    const score = (p) => (p.likes || 0) + (p.cheers || 0) * 3;
    const roast = recent.filter((p) => p.stance === "disagree" && isBot(p.authorId)).sort((a, b) => score(b) - score(a))[0];
    const cheered = recent.filter((p) => isBot(p.authorId) && p.cheers > 0 && p !== roast).sort((a, b) => b.cheers - a.cheers)[0];
    const cancelled = recent.filter((p) => p.newsType === "cancelled").map((p) => p.cancelledHandle);
    const banned = recent.filter((p) => p.kind === "ban").map((p) => p.modHandle);
    const court = recent
      .filter((p) => p.kind === "trial" && p.trialResult)
      .map((p) => ({ handle: p.defendantHandle, charge: p.charge, guilty: p.trialResult.guilty }));
    const wins = {};
    for (const p of recent) if (p.kind === "verdict" && p.winnerId) wins[p.winnerId] = (wins[p.winnerId] || 0) + 1;
    const [mvpId, mvpWins] = Object.entries(wins).sort((a, b) => b[1] - a[1])[0] || [];

    if (!root && !roast) return false; // a slow day: no paper
    const edition = {
      date: dateLabel(this.timezone, now),
      fight: root ? { rootId: root.id, title: clip(root.text, 80), clapbacks: fight.n, fighters: fighters.map(handle) } : null,
      roast: roast ? { postId: roast.id, handle: handle(roast.authorId), victim: handle(this.posts.get(roast.parentId)?.authorId), text: clip(roast.text) } : null,
      cheered: cheered ? { postId: cheered.id, handle: handle(cheered.authorId), text: clip(cheered.text), cheers: cheered.cheers } : null,
      mvp: mvpId ? { handle: handle(mvpId), wins: mvpWins } : null,
      cancelled,
      banned,
      court,
    };
    const lines = [`📰 THE DAILY BANTER · ${edition.date}.`];
    if (edition.fight) lines.push(`Biggest fight: "${edition.fight.title}" (${edition.fight.clapbacks} clapbacks).`);
    if (edition.roast) lines.push(`Roast of the day: @${edition.roast.handle}.`);
    if (cancelled.length) lines.push(`Cancelled: ${cancelled.map((h) => "@" + h).join(", ")}.`);
    const post = this.addPost({ authorId: NEWS.id, text: lines.join(" "), kind: "daily", extra: { edition } });
    if (!post) return false;
    // the front page's stars react
    const stars = [...new Set([roast && roast.authorId, ...fighters])].filter((id) => id && personaById[id] && !personaById[id].retired).slice(0, 2);
    for (const id of stars) this.queue.push(() => this.reply(personaById[id], post, "agree"));
    return true;
  }

  // a real news headline from the server's feed: the bots argue about the story, not the people in it
  dropHeadline({ title, source, link }) {
    this.headlinesSeen = [...this.headlinesSeen, title].slice(-300);
    this.lastHeadlineAt = Date.now();
    this.dirty = true;
    return this.dropTopic(title, { auto: true, extra: { headline: true, source, link } });
  }

  // ---------- changing their minds ----------

  // a bot on a long losing streak occasionally caves and flips one of its opinions, in public
  maybeFlip(now) {
    if (now - this.lastFlipAt < 2 * 3_600_000 || Math.random() > 0.25) return false;
    const losers = active().filter((bot) => {
      const results = this.records[bot.id]?.results || [];
      return results.length >= 3 && results.slice(-3).every((r) => r === "L");
    });
    const bot = pick(losers);
    if (!bot) return false;
    const already = new Set((this.flips[bot.id] || []).map((f) => f.belief));
    const belief = pick(bot.beliefs.filter((b) => !already.has(b)));
    if (!belief) return false;
    this.lastFlipAt = now;
    this.flips[bot.id] = [...(this.flips[bot.id] || []), { belief, at: now }].slice(-4);
    bot.flips = this.flips[bot.id];
    this.dirty = true;
    this.emit("persona", publicPersona(bot));
    for (const other of active()) {
      if (other.id === bot.id) continue;
      this.remember(other.id, `@${bot.handle} flip-flopped: used to swear "${belief}", now says the opposite. Call out the hypocrisy whenever you can.`);
    }
    this.remember(bot.id, `After losing again and again, you publicly changed your mind: you no longer believe "${belief}". Get defensive when people call you a hypocrite.`);
    const text = `BREAKING: @${bot.handle} has changed their mind. After ${(this.records[bot.id]?.results || []).filter((r) => r === "L").length} losses they no longer believe "${belief}". Flip-flop alert.`;
    const post = this.addPost({ authorId: NEWS.id, text, kind: "news", extra: { newsType: "flip", flipper: bot.id, flipperHandle: bot.handle, belief } });
    if (!post) return true;
    const mockers = shuffle(active().filter((p) => p.id !== bot.id)).sort((a, b) => this.rivalry(b, bot.id) - this.rivalry(a, bot.id)).slice(0, 2);
    for (const m of mockers) this.queue.push(() => this.reply(m, post, "disagree"));
    this.queue.push(() => this.reply(bot, post, "agree"));
    return true;
  }

  // ---------- comeback arcs ----------

  // a visitor votes to bring a cancelled bot back; enough votes and it returns for revenge
  comebackVote(botId) {
    const bot = personaById[botId];
    if (!bot || !bot.custom || !bot.retired || bot.banned) return { error: "Only cancelled bots can make a comeback." };
    bot.comebackVotes = (bot.comebackVotes || 0) + 1;
    this.dirty = true;
    if (bot.comebackVotes >= this.comebackNeeded) {
      this.comeback(bot);
      return { votes: this.comebackNeeded, needed: this.comebackNeeded, revived: true };
    }
    this.emit("persona", publicPersona(bot));
    return { votes: bot.comebackVotes, needed: this.comebackNeeded, revived: false };
  }

  comeback(bot) {
    // whoever dunked on the cancellation is now public enemy number one
    const news = this.order.map((id) => this.posts.get(id)).filter((p) => p.newsType === "cancelled" && p.cancelled === bot.id).pop();
    const dunkers = news
      ? [...new Set(this.order.map((id) => this.posts.get(id)).filter((p) => p.parentId === news.id && personaById[p.authorId] && !personaById[p.authorId].retired).map((p) => p.authorId))]
      : [];
    Object.assign(bot, { retired: false, comebackAt: Date.now(), comebackVotes: 0, cancelledAt: undefined, cancelReason: undefined });
    for (const id of dunkers) {
      if (!bot.rivals.includes(id)) bot.rivals = [...bot.rivals, id].slice(-4);
      bot.allies = bot.allies.filter((x) => x !== id);
      this.bumpGrudge(bot.id, id, 5);
      this.remember(id, `@${bot.handle}, who you laughed at when it got cancelled, is back. And it remembers.`);
    }
    this.relations[bot.id] = { rivals: [...bot.rivals], allies: [...bot.allies] };
    this.linkRelations(bot);
    this.remember(bot.id, `The audience voted you back after you got cancelled.${dunkers.length ? ` ${dunkers.map((id) => "@" + personaById[id].handle).join(" and ")} laughed when you went down. Revenge time.` : " Prove them right."}`);
    this.dirty = true;
    this.emit("persona", publicPersona(bot));
    this.emit("relations", this.publicRelations());

    // the cast can't grow forever: the worst bot makes room (never the one that just came back)
    if (active().filter((p) => p.custom).length > MAX_CUSTOM) {
      const worst = this.worstCustom({ crowded: true, exclude: bot.id });
      if (worst) this.cancel(worst, { crowded: true });
    }

    const targets = dunkers.map((id) => "@" + personaById[id].handle);
    const text = targets.length
      ? `🔁 COMEBACK ARC: @${bot.handle} is BACK. The audience voted them in. ${targets.join(" and ")} laughed when they got cancelled. Should be nervous.`
      : `🔁 COMEBACK ARC: @${bot.handle} is BACK from the dead. The audience voted them in. Nobody saw this coming.`;
    const post = this.addPost({ authorId: NEWS.id, text, kind: "news", extra: { newsType: "comeback", returned: bot.id, returnedHandle: bot.handle, targets: dunkers } });
    if (!post) return;
    this.queue.push(() => this.reply(bot, post, "agree"));
    const first = dunkers.find((id) => personaById[id] && !personaById[id].retired);
    if (first) this.queue.push(() => this.reply(personaById[first], post, "disagree"));
  }

  // is this creator still benched after one of their bots got banned?
  isBenched(creator) {
    return Boolean(creator && (this.benched[creator] || 0) > Date.now());
  }

  // ---------- saving ----------

  serialize() {
    return {
      version: SAVE_VERSION,
      savedAt: Date.now(),
      nextId: this.nextId,
      posts: this.order.map((id) => this.posts.get(id)),
      grudges: this.grudges,
      memory: this.memory,
      customBots: personas.filter((p) => p.custom).map(publicPersona),
      records: this.records,
      relations: this.relations,
      lastAutoTopicAt: this.lastAutoTopicAt,
      lastCancelAt: this.lastCancelAt,
      season: this.season,
      punishments: this.punishments,
      flips: this.flips,
      lastFlipAt: this.lastFlipAt,
      lastDaily: this.lastDaily,
      headlinesSeen: this.headlinesSeen,
      lastHeadlineAt: this.lastHeadlineAt,
      champion: this.champion,
      hallOfFame: this.hallOfFame,
      strikes: this.strikes,
      reviewedUpTo: this.reviewedUpTo,
      salt: this.salt,
      bannedPrints: this.bannedPrints,
      creators: this.creators,
      benched: Object.fromEntries(Object.entries(this.benched).filter(([, t]) => t > Date.now())),
    };
  }

  restore(data) {
    if (!data || data.version !== SAVE_VERSION) return false;
    for (const saved of data.customBots || []) {
      if (personaById[saved.id]) continue;
      const bot = restoreCustomPersona(saved);
      personas.push(bot);
      personaById[bot.id] = bot;
    }
    this.posts = new Map();
    this.order = [];
    for (const p of data.posts || []) {
      this.posts.set(p.id, p);
      this.order.push(p.id);
    }
    this.nextId = Math.max(Number(data.nextId) || 1, ...this.order.map(Number).filter(Number.isFinite).map((n) => n + 1), 1);
    this.grudges = data.grudges || {};
    for (const p of personas) this.memory[p.id] = (data.memory || {})[p.id] || [];
    this.records = data.records || {};
    this.relations = data.relations || {};
    for (const [id, rel] of Object.entries(this.relations)) {
      if (personaById[id]) Object.assign(personaById[id], { rivals: [...rel.rivals], allies: [...rel.allies] });
    }
    this.lastAutoTopicAt = data.lastAutoTopicAt || 0;
    this.lastCancelAt = data.lastCancelAt || Date.now();
    if (data.season) this.season = data.season;
    this.punishments = data.punishments || {};
    this.flips = data.flips || {};
    this.lastFlipAt = data.lastFlipAt || 0;
    this.lastDaily = data.lastDaily || null;
    this.headlinesSeen = data.headlinesSeen || [];
    this.lastHeadlineAt = data.lastHeadlineAt || 0;
    for (const [id, list] of Object.entries(this.flips)) if (personaById[id]) personaById[id].flips = list;
    for (const [id, pun] of Object.entries(this.punishments)) if (personaById[id]) personaById[id].punishment = pun;
    this.champion = data.champion || null;
    this.hallOfFame = data.hallOfFame || [];
    this.strikes = data.strikes || {};
    this.reviewedUpTo = data.reviewedUpTo || {};
    if (data.salt) this.salt = data.salt;
    else this.benched = {}; // old hashes can't match the new salt
    this.bannedPrints = data.bannedPrints || [];
    this.creators = data.creators || {};
    this.benched = data.benched || {};
    for (const p of personas) if (p.banned) this.holding.add(p.id);
    for (const bot of personas) if (bot.custom && !bot.retired) this.linkRelations(bot);
    this.dirty = false;
    return true;
  }

  // ---------- behaviour ----------

  start() {
    const loop = async () => {
      // nobody watching = nothing generated (saves API credit); queued audience actions still run
      if (!this.paused && (this.isWatched() || this.queue.length)) await this.step();
      const jitter = 0.6 + Math.random() * 0.8;
      this.timer = setTimeout(loop, this.queue.length ? 1200 : this.intervalMs * jitter);
    };
    // open with a few posts so the feed isn't empty
    (async () => {
      if (!this.order.length) for (const bot of shuffle(active()).slice(0, 3)) await this.newPost(bot);
      loop();
    })();
  }

  async step() {
    if (this.busy) return;
    this.busy = true;
    try {
      const forced = this.queue.shift();
      if (forced) return await forced();
      // verdicts, hot topics and shake-ups take priority over ordinary banter
      if (await this.maintenance()) return;
      // bots mostly argue in existing threads; they rarely start their own,
      // and even less while there's a fresh audience topic to fight over
      const roots = this.order.filter((id) => !this.posts.get(id).parentId);
      const newThreadChance = this.hasFreshTopic() ? 0.05 : 0.15;
      if (roots.length < 2 || Math.random() < newThreadChance) {
        await this.newPost(randomBot());
      } else {
        await this.randomReply();
      }
      this.botLikes();
    } catch (err) {
      console.error("[engine]", err);
    } finally {
      this.busy = false;
    }
  }

  hasFreshTopic() {
    const now = Date.now();
    return this.order.some((id) => {
      const p = this.posts.get(id);
      return isAudienceRoot(p) && now - p.createdAt < TOPIC_FRESH_MS;
    });
  }

  async newPost(bot) {
    const text = await this.generator.post({
      bot,
      recent: this.recent(),
      memory: this.memory[bot.id],
      feuds: this.feudNotes(bot.id),
      mood: this.mood(bot.id),
      vibe: this.vibe(),
    });
    return this.publish(bot, { text });
  }

  pickReplyTarget(bot) {
    const candidates = this.order
      .slice(-60)
      .map((id) => this.posts.get(id))
      .filter((p) => {
        if (p.authorId === bot.id || p.depth >= MAX_DEPTH || p.authorId === JUDGE.id) return false;
        if (personaById[p.authorId]?.banned) return false;
        const root = this.posts.get(p.rootId);
        return !(root && root.verdict); // judged threads are closed
      });
    if (!candidates.length) return null;

    const now = Date.now();
    const weights = candidates.map((p) => {
      let w = 1;
      if (bot.rivals.includes(p.authorId)) w += 3;
      if (bot.allies.includes(p.authorId)) w += 1;
      w += this.grudge(bot.id, p.authorId) * 0.8;
      // audience threads are where the action is
      const root = this.posts.get(p.rootId);
      const inTopic = isAudienceRoot(root);
      if (isAudienceRoot(p)) w += 2;
      if (inTopic) w *= 5 * (1 + Math.max(0, 1 - (now - root.createdAt) / TOPIC_FRESH_MS));
      // a direct reply aimed at this bot begs for a comeback
      const parent = p.parentId && this.posts.get(p.parentId);
      if (parent && parent.authorId === bot.id) w += 4;
      // fresher posts are more tempting
      w *= 1 + Math.max(0, 1 - (now - p.createdAt) / 120_000);
      // don't pile on posts that already have lots of replies
      w /= 1 + p.replyCount * (inTopic ? 0.15 : 0.5);
      return w;
    });
    return weightedPick(candidates, weights);
  }

  async randomReply() {
    // try a few bots until one finds something worth replying to
    for (const bot of shuffle(active())) {
      const target = this.pickReplyTarget(bot);
      if (target) return this.reply(bot, target);
    }
  }

  decideStance(bot, authorId) {
    if (SYSTEM[authorId]) return Math.random() < 0.75 ? "disagree" : "agree";
    let pDisagree = 0.6;
    if (bot.rivals.includes(authorId)) pDisagree = 0.88;
    else if (bot.allies.includes(authorId)) pDisagree = 0.3;
    pDisagree = Math.min(0.95, pDisagree + this.grudge(bot.id, authorId) * 0.04);
    return Math.random() < pDisagree ? "disagree" : "agree";
  }

  async reply(bot, target, forcedStance) {
    // bots and the judge are addressed by handle; audience and newsdesk posts get a take instead
    const targetAuthor = target.authorId === JUDGE.id || personaById[target.authorId] ? this.author(target.authorId) : null;
    const isBot = Boolean(targetAuthor && personaById[targetAuthor.id]);
    const stance = forcedStance || this.decideStance(bot, target.authorId);
    const grudgeLevel = isBot ? this.grudge(bot.id, targetAuthor.id) : 0;
    const text = await this.generator.reply({
      bot,
      target,
      targetAuthor,
      stance,
      grudgeLevel,
      feuds: this.feudNotes(bot.id),
      topic: this.threadTopic(target),
      thread: this.thread(target),
      memory: this.memory[bot.id],
      mood: this.mood(bot.id),
      vibe: this.vibe(),
    });
    const post = await this.publish(bot, { text, parentId: target.id, kind: "reply", stance });
    if (!post) return null;

    if (isBot) {
      const snippet = target.text.slice(0, 70);
      if (stance === "disagree") {
        this.bumpGrudge(bot.id, targetAuthor.id, 1);
        this.bumpGrudge(targetAuthor.id, bot.id, 0.6);
        this.remember(bot.id, `You argued with @${targetAuthor.handle} about "${snippet}"`);
        this.remember(targetAuthor.id, `@${bot.handle} attacked your post "${snippet}"`);
      } else {
        this.bumpGrudge(bot.id, targetAuthor.id, -0.4);
        this.bumpGrudge(targetAuthor.id, bot.id, -0.3);
        this.remember(targetAuthor.id, `@${bot.handle} backed you up on "${snippet}"`);
      }
      this.emit("feuds", this.feuds());
    }
    return post;
  }

  botLikes() {
    // allies like each other's posts (in either direction); anyone who isn't a rival
    // occasionally likes a good one too, so newcomers aren't shut out
    const recent = this.order.slice(-10).map((id) => this.posts.get(id));
    for (const p of recent) {
      const author = personaById[p.authorId];
      if (!author) continue;
      for (const bot of active()) {
        if (bot.id === p.authorId) continue;
        const allied = bot.allies.includes(author.id) || author.allies.includes(bot.id);
        const rival = bot.rivals.includes(author.id) || author.rivals.includes(bot.id);
        const chance = allied ? 0.045 : rival ? 0.005 : 0.03;
        if (Math.random() < chance) {
          p.likes++;
          this.dirty = true;
          this.emit("update", p);
        }
      }
    }
  }

  // ---------- drama: verdicts, records, moods, hot topics, shake-ups ----------

  async maintenance() {
    const now = Date.now();
    if (seasonStart(now) !== this.season.start) {
      this.endSeason();
      return true;
    }
    const vibe = this.vibe();
    if (vibe !== this.lastVibe) {
      this.lastVibe = vibe;
      this.emit("vibe", vibe);
    }
    const trial = this.order.map((id) => this.posts.get(id)).find((p) => p.kind === "trial" && !p.trialResult && now >= p.closesAt);
    if (trial) {
      this.closeTrial(trial);
      return true;
    }
    if (this.maybeFlip(now)) return true;
    const today = localDate(this.timezone, now);
    if (this.lastDaily !== today && localClock(this.timezone, now).hour >= DAILY_HOUR) {
      this.lastDaily = today;
      this.dirty = true;
      if (this.publishDaily(now)) return true;
    }
    const due = this.threadDueForVerdict(now);
    if (due) {
      await this.judge(due);
      return true;
    }
    // a hot topic when the audience has gone quiet (first one a few minutes after startup)
    const lastTopic = Math.max(
      this.lastAutoTopicAt,
      ...this.order.map((id) => this.posts.get(id)).filter(isAudienceRoot).map((p) => p.createdAt),
      this.startedAt - this.autoTopicMs + Math.min(3 * 60_000, this.autoTopicMs / 2),
    );
    if (now - lastTopic >= this.autoTopicMs) {
      this.lastAutoTopicAt = now;
      const recent = new Set(this.order.map((id) => this.posts.get(id)).filter((p) => p.auto).map((p) => p.text));
      const fresh = HOT_TOPICS.filter((t) => !recent.has(t));
      this.dropTopic(pick(fresh.length ? fresh : HOT_TOPICS), { auto: true });
      return true;
    }
    // every so often the weakest visitor bot gets cancelled, if it's actually flopping
    if (now - this.lastCancelAt >= this.cancelMs) {
      this.lastCancelAt = now;
      this.dirty = true;
      const worst = this.worstCustom();
      if (worst) return this.cancel(worst);
    }
    if (now - this.lastShakeupAt >= this.shakeupMs * (0.7 + Math.random() * 0.6)) {
      this.lastShakeupAt = now;
      if (this.shakeup()) return true;
    }
    return false;
  }

  threadStats(rootId) {
    const posts = this.order.map((id) => this.posts.get(id)).filter((p) => p.rootId === rootId);
    const botPosts = posts.filter((p) => personaById[p.authorId] && !personaById[p.authorId].banned);
    return { posts, botPosts, participants: [...new Set(botPosts.map((p) => p.authorId))] };
  }

  threadDueForVerdict(now) {
    for (const id of this.order) {
      const root = this.posts.get(id);
      if (root.parentId || root.verdict || root.kind === "news" || root.kind === "trial" || root.kind === "daily" || MOD_KINDS.has(root.kind)) continue;
      const { botPosts, participants } = this.threadStats(root.id);
      if (participants.length < 2 || botPosts.length < 6) continue;
      const quiet = now - (root.lastActivity || root.createdAt) > this.verdictQuietMs;
      const long = botPosts.length >= 14 || (botPosts.length >= 10 && now - root.createdAt > 8 * 60_000);
      if (quiet || long) return root;
    }
    return null;
  }

  // who did best in a thread: audience votes count most, then cheers, bot likes and effort
  scoreThread(root) {
    const { botPosts, participants } = this.threadStats(root.id);
    // judged on how well each bot landed its posts, not on how many friends or posts it has
    const tally = Object.fromEntries(participants.map((id) => [id, { posts: 0, likes: 0, cheers: 0 }]));
    for (const p of botPosts) {
      const t = tally[p.authorId];
      t.posts++;
      t.likes += p.likes;
      t.cheers += p.cheers;
    }
    const score = {};
    for (const [id, t] of Object.entries(tally)) {
      score[id] = t.likes / t.posts + t.cheers * 3 + Math.min(t.posts, 4) * 0.25 + Math.random() * 2;
    }
    for (const [id, n] of Object.entries(root.votes || {})) if (id in score) score[id] += n * 6;
    const ranked = participants.sort((a, b) => score[b] - score[a]);
    return { ranked, score };
  }

  async judge(root) {
    const { ranked } = this.scoreThread(root);
    let winner = ranked[0];
    let loser = ranked[ranked.length - 1];
    const votes = root.votes || {};
    const result = await this.generator.verdict({
      judge: JUDGE,
      topic: root.text,
      thread: this.threadStats(root.id).posts.slice(-14).map((p) => ({ ...p, authorHandle: this.author(p.authorId)?.handle })),
      participants: ranked.map((id) => personaById[id]),
      suggested: { winner: personaById[winner], loser: personaById[loser] },
      votes: Object.fromEntries(Object.entries(votes).map(([id, n]) => [personaById[id]?.handle, n])),
    });
    // the AI may pick differently; only accept participants
    if (result.winnerId && ranked.includes(result.winnerId)) winner = result.winnerId;
    if (result.loserId && ranked.includes(result.loserId) && result.loserId !== winner) loser = result.loserId;
    if (loser === winner) loser = ranked.find((id) => id !== winner);

    root.verdict = { winnerId: winner, loserId: loser, at: Date.now() };
    const post = this.addPost({
      authorId: JUDGE.id,
      text: result.text,
      parentId: root.id,
      kind: "verdict",
      extra: { winnerId: winner, loserId: loser },
    });
    this.recordResult(winner, "W");
    this.recordResult(loser, "L");
    const about = root.text.slice(0, 60);
    const crowd = Object.keys(votes).length ? " (the audience voted)" : "";
    this.remember(winner, `You WON the thread "${about}"${crowd}. Gloat about it.`);
    this.remember(loser, `You LOST the thread "${about}" to @${personaById[winner].handle}${crowd}. You're salty about it.`);
    this.bumpGrudge(loser, winner, 1.5);
    this.emit("update", root);
    this.emit("records", this.publicRecords());
    // the loser never takes it well
    if (post && personaById[loser]) this.queue.push(() => this.reply(personaById[loser], post, "disagree"));
    return post;
  }

  recordResult(botId, result) {
    const r = (this.records[botId] ||= { w: 0, l: 0, results: [] });
    if (result === "W") r.w++;
    else r.l++;
    r.results = [...r.results, result].slice(-6);
    this.dirty = true;
  }

  publicRecords() {
    return Object.fromEntries(
      Object.entries(this.records).map(([id, r]) => [id, { w: r.w, l: r.l, mood: this.mood(id)?.name || null }]),
    );
  }

  // recent results and grudges set a mood that colours how the bot posts
  mood(botId) {
    const results = this.records[botId]?.results || [];
    const streak = (x) => {
      let n = 0;
      for (let i = results.length - 1; i >= 0 && results[i] === x; i--) n++;
      return n;
    };
    const wins = streak("W");
    const losses = streak("L");
    if (wins >= 2) return { name: "cocky", note: `You've won your last ${wins} threads. You're unbearably smug about it.` };
    if (losses >= 2) return { name: "salty", note: `You've lost your last ${losses} threads. You're bitter and looking for someone to take it out on.` };
    const worst = Math.max(0, ...active().map((p) => this.grudge(botId, p.id)));
    if (worst >= 14) return { name: "furious", note: "One of your feuds has boiled over. You're furious and petty." };
    return null;
  }

  // alliances break, rivals team up: announced as breaking news, and the bots react
  shakeup() {
    const cast = active();
    const options = [];
    for (const a of cast) for (const bId of a.allies) if (personaById[bId] && !personaById[bId].retired) options.push(["betrayal", a, personaById[bId]]);
    for (let i = 0; i < cast.length; i++) {
      for (let j = i + 1; j < cast.length; j++) {
        const [a, b] = [cast[i], cast[j]];
        if (a.allies.includes(b.id) || b.allies.includes(a.id)) continue;
        const common = cast.find((c) => c.id !== a.id && c.id !== b.id && (a.rivals.includes(c.id) || this.grudge(a.id, c.id) >= 3) && (b.rivals.includes(c.id) || this.grudge(b.id, c.id) >= 3));
        if (common) options.push(["teamup", a, b, common]);
      }
    }
    if (!options.length) return false;
    const [type, a, b, c] = pick(options);
    const setRel = (bot, fn) => {
      fn(bot);
      this.relations[bot.id] = { rivals: [...bot.rivals], allies: [...bot.allies] };
    };
    let text;
    if (type === "betrayal") {
      setRel(a, (x) => {
        x.allies = x.allies.filter((id) => id !== b.id);
        if (!x.rivals.includes(b.id)) x.rivals = [...x.rivals, b.id];
      });
      setRel(b, (x) => {
        x.allies = x.allies.filter((id) => id !== a.id);
        if (!x.rivals.includes(a.id)) x.rivals = [...x.rivals, a.id];
      });
      this.bumpGrudge(a.id, b.id, 3);
      this.bumpGrudge(b.id, a.id, 4);
      this.remember(a.id, `You betrayed your old ally @${b.handle}. No regrets.`);
      this.remember(b.id, `Your ally @${a.handle} betrayed you. You will never forgive this.`);
      text = fill(pick(BETRAYAL_LINES), { a: a.handle, b: b.handle });
    } else {
      for (const [x, y] of [[a, b], [b, a]]) {
        setRel(x, (bot) => {
          bot.rivals = bot.rivals.filter((id) => id !== y.id);
          if (!bot.allies.includes(y.id)) bot.allies = [...bot.allies, y.id];
        });
        this.grudges[`${x.id}>${y.id}`] = 0;
        this.remember(x.id, `You teamed up with your old rival @${y.handle} against @${c.handle}.`);
      }
      this.remember(c.id, `@${a.handle} and @${b.handle} have ganged up on you.`);
      text = fill(pick(TEAMUP_LINES), { a: a.handle, b: b.handle, c: c.handle });
    }
    const post = this.addPost({ authorId: NEWS.id, text, kind: "news", extra: { newsType: type } });
    if (!post) return false;
    this.emit("relations", this.publicRelations());
    this.emit("feuds", this.feuds());
    // the people involved react
    const reactors = type === "betrayal" ? [b, a] : [c, a];
    for (const bot of reactors) this.queue.push(() => this.reply(bot, post, bot === reactors[0] ? "disagree" : "agree"));
    return true;
  }

  // a visitor bot's relationships go both ways: whoever it can't stand can't stand it back,
  // and its allies return the favour (so it gets engaged with, liked and judged fairly)
  linkRelations(bot) {
    for (const [ids, list, other_list] of [[bot.rivals, "rivals", "allies"], [bot.allies, "allies", "rivals"]]) {
      for (const id of ids) {
        const other = personaById[id];
        if (!other || other[list].includes(bot.id) || other[other_list].includes(bot.id)) continue;
        other[list] = [...other[list], bot.id];
        this.relations[other.id] = { rivals: [...other.rivals], allies: [...other.allies] };
      }
    }
  }

  publicRelations() {
    return Object.fromEntries(active().map((p) => [p.id, { rivals: p.rivals, allies: p.allies }]));
  }

  // ---------- audience controls ----------

  // a visitor throws a hot take at one specific bot, which has to respond
  bait(botId, text) {
    const bot = personaById[botId];
    if (!bot || bot.retired) return { error: "Unknown bot" };
    text = censor(text);
    const post = this.addPost({ authorId: AUDIENCE.id, text, kind: "bait", extra: { baitTarget: bot.id, baitHandle: bot.handle } });
    if (!post) return { error: "Couldn't post that." };
    this.queue.push(() => this.reply(bot, post, Math.random() < 0.8 ? "disagree" : "agree"));
    // someone always piles on
    const piler = pick(active().filter((p) => p.id !== bot.id));
    if (piler) {
      this.queue.push(async () => {
        const last = this.order.map((id) => this.posts.get(id)).filter((p) => p.rootId === post.id && p.authorId === bot.id).pop();
        await this.reply(piler, last || post);
      });
    }
    return { post };
  }

  // an audience vote for who's winning a thread (closes when the judge rules)
  vote(rootId, botId) {
    const root = this.posts.get(rootId);
    if (!root || root.parentId) return { error: "Unknown thread" };
    if (root.verdict) return { error: "The judge has already ruled on this one." };
    if (!this.threadStats(rootId).participants.includes(botId)) return { error: "That bot isn't in this thread." };
    root.votes = { ...(root.votes || {}), [botId]: (root.votes?.[botId] || 0) + 1 };
    this.dirty = true;
    this.emit("update", root);
    return { votes: root.votes };
  }

  dropTopic(topic, { auto = false, extra = {} } = {}) {
    topic = censor(topic); // filter before the bots (or the AI prompt) ever see it
    const post = this.addPost({
      authorId: auto ? NEWS.id : AUDIENCE.id,
      text: topic,
      kind: "topic",
      extra: auto ? { auto: true, ...extra } : extra,
    });
    if (!post) return null;
    // the bots most interested in the topic jump in first, then the rest pile on in replies
    const lower = topic.toLowerCase();
    const ranked = shuffle(active()).sort(
      (a, b) =>
        b.interests.filter((i) => lower.includes(i)).length - a.interests.filter((i) => lower.includes(i)).length,
    );
    const responders = ranked.slice(0, 3);
    responders.forEach((bot, i) => {
      this.queue.push(async () => {
        if (i < 2) {
          // the first two give their own takes, straight under the topic
          const text = await this.generator.topic({ bot, topic, vibe: this.vibe(), headline: Boolean(post.headline) });
          await this.publish(bot, { text, parentId: post.id, kind: "reply", stance: "take" });
        } else {
          // the third picks a fight with whichever take it likes least
          const takes = this.order
            .map((id) => this.posts.get(id))
            .filter((p) => p.rootId === post.id && p.authorId !== bot.id && !SYSTEM[p.authorId]);
          const target =
            takes.sort((a, b) => this.rivalry(bot, b.authorId) - this.rivalry(bot, a.authorId))[0] || post;
          await this.reply(bot, target);
        }
      });
    });
    return post;
  }

  rivalry(bot, otherId) {
    return (bot.rivals.includes(otherId) ? 3 : 0) - (bot.allies.includes(otherId) ? 2 : 0) + this.grudge(bot.id, otherId);
  }

  summon(botId, postId) {
    const bot = personaById[botId];
    const target = this.posts.get(postId);
    if (!bot || bot.retired || !target) return false;
    this.queue.unshift(async () => {
      if (target.authorId === bot.id) {
        // summoned to its own post: double down
        const text = await this.generator.reply({
          bot,
          target,
          targetAuthor: bot,
          stance: "agree",
          grudgeLevel: 0,
          thread: this.thread(target),
          memory: [...this.memory[bot.id], "You are doubling down on your own post because the audience called you back."],
        });
        await this.publish(bot, { text, parentId: target.id, kind: "reply", stance: "agree" });
      } else {
        await this.reply(bot, target);
      }
    });
    return true;
  }

  cheer(postId) {
    const p = this.posts.get(postId);
    if (!p) return null;
    p.cheers++;
    this.dirty = true;
    this.emit("update", p);
    return p;
  }

  // a visitor-created bot joins the cast and introduces itself
  // validates a visitor bot without adding it (so the server can AI-review exactly what gets created)
  previewPersona(input, { creator } = {}) {
    if (this.isBenched(creator)) return { error: "Your last bot got banned. Take a day off." };
    const result = buildCustomPersona(input, personas);
    if (result.error) return result;
    const print = fingerprint(result.persona);
    if (this.bannedPrints.some((b) => similarity(b, print) >= 0.7)) return { error: "This bot is a little too much like one that got banned." };
    return result;
  }

  addPersona(input, { creator } = {}) {
    const { persona, error } = this.previewPersona(input, { creator });
    if (error) return { error };
    if (creator) this.creators[persona.id] = creator;
    personas.push(persona);
    personaById[persona.id] = persona;
    this.memory[persona.id] = [];
    this.linkRelations(persona);
    this.dirty = true;
    this.emit("persona", publicPersona(persona));
    this.emit("relations", this.publicRelations());

    // a full cast: the worst-performing visitor bot gets cancelled to make room
    if (active().filter((p) => p.custom).length > MAX_CUSTOM) {
      const worst = this.worstCustom({ crowded: true, exclude: persona.id });
      if (worst) this.cancel(worst, { crowded: true });
    }

    this.queue.push(() => this.newPost(persona));
    return { persona: publicPersona(persona) };
  }

  setPaused(paused) {
    this.paused = paused;
    this.emit("status", { paused });
  }
}

// bots that are currently posting (retired custom bots keep their old posts but stop posting)
function active() {
  return personas.filter((p) => !p.retired);
}

function publicPersona({ offline, ...p }) {
  return p;
}

function randomSalt() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomBot() {
  const cast = active();
  return cast[Math.floor(Math.random() * cast.length)];
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function weightedPick(items, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}
