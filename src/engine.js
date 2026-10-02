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
const SYSTEM = { [AUDIENCE.id]: AUDIENCE, [JUDGE.id]: JUDGE, [NEWS.id]: NEWS };

// threads started by the audience (or the newsdesk's hot topics) are where the action is
const AUDIENCE_KINDS = new Set(["topic", "bait"]);
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
  constructor({ generator, intervalMs, autoTopicMs = 60 * 60_000, shakeupMs = 20 * 60_000, verdictQuietMs = 90_000 }) {
    super();
    this.generator = generator;
    this.intervalMs = intervalMs;
    this.autoTopicMs = autoTopicMs; // hot topic when the audience hasn't dropped one for this long
    this.shakeupMs = shakeupMs; // roughly how often alliances break or rivals team up
    this.verdictQuietMs = verdictQuietMs; // a thread this quiet (with enough replies) gets judged
    this.records = {}; // botId -> { w, l, results: ["W","L",...] newest last }
    this.relations = {}; // botId -> { rivals, allies } after shake-ups change them
    this.lastAutoTopicAt = 0;
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
      audience: AUDIENCE,
      system: SYSTEM,
      posts: this.order.map((id) => this.posts.get(id)),
      feuds: this.feuds(),
      records: this.publicRecords(),
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
    if (authorId !== AUDIENCE.id && screenText(text)) {
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
    const posts = this.removePosts((p) => Boolean(screenText(p.text)));
    return { bots: bots.length, posts };
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
    });
    return this.addPost({ authorId: bot.id, text });
  }

  pickReplyTarget(bot) {
    const candidates = this.order
      .slice(-60)
      .map((id) => this.posts.get(id))
      .filter((p) => {
        if (p.authorId === bot.id || p.depth >= MAX_DEPTH || p.authorId === JUDGE.id) return false;
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
    });
    const post = this.addPost({ authorId: bot.id, text, parentId: target.id, kind: "reply", stance });

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
    // allies quietly like each other's recent posts
    const recent = this.order.slice(-10).map((id) => this.posts.get(id));
    for (const p of recent) {
      if (p.authorId === AUDIENCE.id) continue;
      for (const bot of active()) {
        if (bot.id !== p.authorId && bot.allies.includes(p.authorId) && Math.random() < 0.08) {
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
    if (now - this.lastShakeupAt >= this.shakeupMs * (0.7 + Math.random() * 0.6)) {
      this.lastShakeupAt = now;
      if (this.shakeup()) return true;
    }
    return false;
  }

  threadStats(rootId) {
    const posts = this.order.map((id) => this.posts.get(id)).filter((p) => p.rootId === rootId);
    const botPosts = posts.filter((p) => personaById[p.authorId]);
    return { posts, botPosts, participants: [...new Set(botPosts.map((p) => p.authorId))] };
  }

  threadDueForVerdict(now) {
    for (const id of this.order) {
      const root = this.posts.get(id);
      if (root.parentId || root.verdict || root.kind === "news") continue;
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
    const score = Object.fromEntries(participants.map((id) => [id, Math.random() * 0.5]));
    for (const p of botPosts) score[p.authorId] += p.cheers * 3 + p.likes + 0.4;
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

  publicRelations() {
    return Object.fromEntries(active().map((p) => [p.id, { rivals: p.rivals, allies: p.allies }]));
  }

  // ---------- audience controls ----------

  // a visitor throws a hot take at one specific bot, which has to respond
  bait(botId, text) {
    const bot = personaById[botId];
    if (!bot || bot.retired) return { error: "Unknown bot" };
    text = censor(text);
    const post = this.addPost({ authorId: AUDIENCE.id, text, kind: "bait", extra: { baitTarget: bot.id } });
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

  dropTopic(topic, { auto = false } = {}) {
    topic = censor(topic); // filter before the bots (or the AI prompt) ever see it
    const post = this.addPost({
      authorId: auto ? NEWS.id : AUDIENCE.id,
      text: topic,
      kind: "topic",
      extra: auto ? { auto: true } : {},
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
          const text = await this.generator.topic({ bot, topic });
          this.addPost({ authorId: bot.id, text, parentId: post.id, kind: "reply", stance: "take" });
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
        this.addPost({ authorId: bot.id, text, parentId: target.id, kind: "reply", stance: "agree" });
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
  addPersona(input) {
    const { persona, error } = buildCustomPersona(input, personas);
    if (error) return { error };
    personas.push(persona);
    personaById[persona.id] = persona;
    this.memory[persona.id] = [];
    this.dirty = true;
    this.emit("persona", publicPersona(persona));

    const customs = personas.filter((p) => p.custom && !p.retired);
    if (customs.length > MAX_CUSTOM) {
      const oldest = customs.sort((a, b) => a.createdAt - b.createdAt)[0];
      oldest.retired = true;
      this.emit("persona", publicPersona(oldest));
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
