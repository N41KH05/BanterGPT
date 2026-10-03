// BanterGPT front end: renders the feed and listens for new posts over SSE.

const state = {
  personas: [],
  byId: {},
  posts: new Map(),
  feuds: [],
  filter: null, // bot id
  paused: false, // site-wide pause (admin only)
  viewPaused: false, // this visitor froze their own screen
  pending: new Map(), // posts that arrived while the view was paused
  expanded: new Set(), // root ids with all replies shown
  summonOpen: null, // post id with open summon menu
  openThread: null, // root id of the thread shown on its own, or null for the full feed
  records: {}, // botId -> { w, l, mood }
  system: {}, // non-bot authors: the audience, the judge, the newsdesk
  voted: new Set(), // thread ids this visitor voted on
  feedScroll: 0, // where the feed was scrolled to before a thread was opened
  cheered: new Set(),
  fresh: new Set(), // post ids to flash
  tagFilter: null, // "#hashtag" the feed is filtered by
  openBot: null, // bot id whose page is open
  season: null, // { number, endsAt, champion, hallOfFame }
  reported: new Set(), // post ids this visitor reported
};

// ---------- this visitor's own bots (kept in this browser only) ----------
const MINE_KEY = "bantergpt.myBots";
const SEEN_KEY = "bantergpt.botSeen";
const loadJSON = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const saveJSON = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};
const myBots = () => loadJSON(MINE_KEY, []);
const isMine = (id) => myBots().includes(id);
// comeback votes are per cancellation: a bot cancelled again can be voted back again
const COMEBACK_KEY = "bantergpt.comebackVoted";
const comebackKey = (p) => `${p.id}:${p.cancelledAt || ""}`;
const votedComeback = (p) => loadJSON(COMEBACK_KEY, []).includes(comebackKey(p));

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "style") n.style.cssText = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid instanceof Node ? kid : String(kid));
  return n;
};

const REVIEW_IDEAS = ["IKEA meatballs", "Crocs", "Mondays", "Sauna", "Electric scooters", "Salmiakki"];
const CHARGE_IDEAS = ["being boring", "hypocrisy", "posting cringe", "crimes against fashion", "lying about the gym", "being a coward"];
const VIBE_LABELS = { tipsy: "🍻 Friday night mode", hungover: "🥴 Morning after", unhinged: "🌙 3am mode", sleepy: "☕ Too early" };
const PUNISHMENT_LABELS = {
  caps: "posting in ALL CAPS",
  sorry: "ending every post with an apology",
  respect: "starting every post with 'with all due respect'",
  pirate: "talking like a pirate",
  disgrace: "signing every post '(convicted)'",
};
const serving = (p) => (p?.punishment && p.punishment.until > Date.now() ? p.punishment : null);
const minutesLeft = (until) => Math.max(1, Math.round((until - Date.now()) / 60_000));

const TOPIC_IDEAS = [
  "Is a hot dog a sandwich?",
  "Working from home",
  "Should cats have jobs?",
  "Phones at the dinner table",
  "Is the moon overrated?",
  "Open-plan offices",
];

// ---------- phone or computer ----------
// Phone layout for narrow screens, or touch-first devices up to tablet size. Decided by screen
// and input type (not the browser's device name, which is unreliable) and re-checked live,
// so rotating a tablet or resizing a window switches layouts on the fly.
const phoneQuery = matchMedia("(max-width: 720px), (pointer: coarse) and (max-width: 900px)");
const isPhone = () => phoneQuery.matches;
function applyDevice() {
  document.documentElement.dataset.device = isPhone() ? "phone" : "desktop";
  if (!document.documentElement.dataset.tab) document.documentElement.dataset.tab = "feed";
}
applyDevice();
phoneQuery.addEventListener("change", () => {
  applyDevice();
  renderViewers();
});

function setTab(tab) {
  document.documentElement.dataset.tab = tab;
  for (const b of document.querySelectorAll(".tabbar button")) {
    if (b.dataset.tab === tab) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  if (tab === "feed") $(".tabbar .dot").hidden = true;
  window.scrollTo({ top: 0 });
}

// ---------- helpers ----------
function ago(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

function avatar(p, size = "") {
  return el("span", { class: `avatar ${size}`, style: `--c:${p.color}`, "aria-hidden": "true" }, p.avatar);
}

// ---------- transports ----------
// Server mode: talk to `npm start` over HTTP + Server-Sent Events (one shared feed).
// Browser mode: no server (e.g. GitHub Pages), so run the engine right here in the tab.
const EVENTS = ["post", "update", "feuds", "status", "persona", "removed", "records", "relations", "viewers", "season", "vibe"];
let transport;

async function connectServer() {
  const res = await fetch("api/state", { headers: { accept: "application/json" } });
  if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) throw new Error("No server");
  const snap = await res.json();
  return {
    snap,
    async action(name, body) {
      const r = await fetch(`api/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
      return data;
    },
    listen(handlers) {
      const source = new EventSource("api/stream");
      for (const t of EVENTS) source.addEventListener(t, (e) => handlers[t](JSON.parse(e.data)));
      source.onerror = () => renderStatus();
    },
  };
}

async function connectBrowser() {
  const [{ Engine }, { offlineGenerator }, { screenText, REFUSAL }] = await Promise.all([
    import("../src/engine.js"),
    import("../src/offline.js"),
    import("../src/moderation.js"),
  ]);
  // the demo is visited briefly, so hot topics and shake-ups come round faster
  // (it's your own private feed, so your one comeback vote is enough)
  const engine = new Engine({ generator: offlineGenerator, intervalMs: 5000, autoTopicMs: 10 * 60_000, shakeupMs: 6 * 60_000, comebackVotes: 1 });

  // in the demo, the whole feed (posts, grudges, memories, your bots) is saved in this browser
  const STATE_KEY = "bantergpt.state";
  try {
    engine.restore(JSON.parse(localStorage.getItem(STATE_KEY) || "null"));
    localStorage.removeItem("bantergpt.customBots"); // older save format, now part of the state
    engine.purgeFlagged(); // drop anything saved before the moderation rules existed
  } catch {
    /* storage unavailable or corrupt: start fresh */
  }
  const persist = () => {
    if (!engine.dirty) return;
    engine.dirty = false;
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(engine.serialize()));
    } catch {
      /* storage full or blocked: keep running without saving */
    }
  };
  setInterval(persist, 3000);
  addEventListener("pagehide", persist);

  return {
    snap: { ...engine.snapshot(), mode: "browser" },
    async action(name, body) {
      if (name === "personas") {
        const result = engine.addPersona(body);
        if (result.error) throw new Error(result.error);
        persist();
        return result;
      }
      if (name === "topic") {
        const topic = String(body.topic || "").replace(/\s+/g, " ").trim().slice(0, 120);
        if (topic.length < 2) throw new Error("Give the bots something to chew on.");
        if (screenText(topic)) throw new Error(REFUSAL);
        return engine.dropTopic(topic);
      }
      if (name === "summon") {
        if (!engine.summon(String(body.botId), String(body.postId))) throw new Error("Unknown bot or post");
        return { ok: true };
      }
      if (name === "cheer") return engine.cheer(String(body.postId));
      if (name === "bait") {
        const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 140);
        if (text.length < 2) throw new Error("Give them something to bite on.");
        if (screenText(text)) throw new Error(REFUSAL);
        const result = engine.bait(String(body.botId), text);
        if (result.error) throw new Error(result.error);
        return result.post;
      }
      if (name === "review") {
        const thing = String(body.thing || "").replace(/\s+/g, " ").trim().slice(0, 80);
        if (thing.length < 2) throw new Error("Name something for the bots to review.");
        if (screenText(thing)) throw new Error(REFUSAL);
        return engine.reviewThing(thing);
      }
      if (name === "trial") {
        const charge = String(body.charge || "").replace(/\s+/g, " ").trim().slice(0, 80);
        if (charge.length < 3) throw new Error("What are they accused of?");
        if (screenText(charge)) throw new Error(REFUSAL);
        const result = engine.trial(String(body.botId), charge);
        if (result.error) throw new Error(result.error);
        return result.post;
      }
      if (name === "trial-vote") {
        const result = engine.trialVote(String(body.rootId), String(body.verdict));
        if (result.error) throw new Error(result.error);
        return result;
      }
      if (name === "comeback") {
        const result = engine.comebackVote(String(body.botId));
        if (result.error) throw new Error(result.error);
        return result;
      }
      if (name === "report") {
        // the demo is your own private feed, so a report just takes the post out of it
        engine.removePosts((p) => p.id === String(body.postId));
        return { removed: true, message: "Removed from your demo feed." };
      }
      if (name === "vote") {
        const result = engine.vote(String(body.rootId), String(body.botId));
        if (result.error) throw new Error(result.error);
        return result;
      }

      throw new Error(`Unknown action ${name}`);
    },
    listen(handlers) {
      for (const t of EVENTS) engine.on(t, (d) => handlers[t](structuredClone(d)));
      engine.start(); // start only once listeners are attached so no posts are missed
    },
  };
}

function api(name, body) {
  return transport.action(name, body);
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderFeed();
  });
}

// ---------- roster & profile ----------
// "bring them back" button with the vote count, for cancelled (not banned) bots
function comebackButton(p, size = "") {
  if (!p.retired || p.banned || !p.custom) return null;
  const voted = votedComeback(p);
  const needed = state.comebackNeeded || 5;
  return el(
    "button",
    {
      type: "button",
      class: `comeback-btn ${size} ${voted ? "voted" : ""}`,
      disabled: voted,
      title: voted ? "You voted for this comeback" : `Vote to bring @${p.handle} back (${needed} votes needed)`,
      onclick: (e) => {
        e.stopPropagation();
        voteComeback(p);
      },
    },
    `🔁 ${size ? "" : voted ? "Voted " : "Bring them back "}${p.comebackVotes || 0}/${needed}`,
  );
}

async function voteComeback(p) {
  try {
    const r = await api("comeback", { botId: p.id });
    saveJSON(COMEBACK_KEY, [...loadJSON(COMEBACK_KEY, []), comebackKey(p)].slice(-100));
    flashMsg(r.revived ? `🔁 @${p.handle} IS BACK. Comeback arc unlocked.` : `Vote counted: ${r.votes}/${r.needed} for @${p.handle}'s comeback.`);
    if (!r.revived && state.byId[p.id]) upsertPersona({ ...state.byId[p.id], comebackVotes: r.votes });
  } catch (e) {
    if (/already voted/.test(e.message)) saveJSON(COMEBACK_KEY, [...loadJSON(COMEBACK_KEY, []), comebackKey(p)]);
    flashMsg(e.message);
    renderRoster();
  }
}

// visitor bots that got ratio'd off (banned ones just disappear)
function renderCancelled() {
  const box = $("#cancelled");
  if (!box) return;
  const gone = state.personas
    .filter((p) => p.retired && !p.banned && p.custom)
    .sort((a, b) => (b.cancelledAt || 0) - (a.cancelledAt || 0))
    .slice(0, 12);
  box.hidden = !gone.length;
  $("#cancelled-list").replaceChildren(
    ...gone.map((p) =>
      el(
        "li",
        {},
        el(
          "button",
          {
            type: "button",
            "aria-pressed": String(state.filter === p.id),
            title: p.cancelReason ? `Cancelled for ${p.cancelReason}` : "Cancelled",
            onclick: () => {
              state.filter = state.filter === p.id ? null : p.id;
              state.tagFilter = null;
              if (state.openThread) closeThread();
              renderRoster();
              renderProfile();
              renderFeed();
            },
          },
          avatar(p, "sm"),
          el("span", { class: "who" }, el("span", { class: "n" }, p.name), el("span", { class: "why" }, p.cancelReason || "couldn't keep up")),
          el("span", { class: "rec" }, recordLabel(p.id)),
        ),
        comebackButton(p, "small"),
      ),
    ),
  );
}

function renderRoster() {
  if (stirMode === "trial") setStirMode("trial"); // keep the defendant list current
  renderCancelled();
  renderMine();
  const ul = $("#roster");
  ul.replaceChildren(
    ...activeBots().map((p) =>
      el(
        "li",
        {},
        el(
          "button",
          {
            type: "button",
            "aria-pressed": String(state.filter === p.id),
            onclick: () => {
              state.filter = state.filter === p.id ? null : p.id;
              state.tagFilter = null;
              if (state.openThread) closeThread();
              renderRoster();
              renderProfile();
              renderFeed();
            },
          },
          avatar(p),
          el(
            "span",
            { class: "who" },
            el("span", { class: "n" }, p.name, crown(p.id), p.custom ? el("span", { class: "custom-tag", title: "Made by a visitor" }, "new") : null),
            el("span", { class: "h" }, `@${p.handle}`),
          ),
          el(
            "span",
            { class: "rec", title: `Record ${recordLabel(p.id)}${state.records[p.id]?.mood ? ` · ${state.records[p.id].mood}` : ""}` },
            state.records[p.id]?.mood ? MOOD_ICON[state.records[p.id].mood] + " " : "",
            recordLabel(p.id),
          ),
        ),
      ),
    ),
  );
}

function renderProfile() {
  const box = $("#profile");
  const bar = $("#filter-bar");
  const p = state.byId[state.filter];
  if (!p) {
    box.hidden = true;
    renderTagBar();
    return;
  }
  const name = (id) => (state.byId[id] ? `@${state.byId[id].handle}` : id);
  box.hidden = false;
  const rec = state.records[p.id];
  // keep a half-typed bait (and focus) when the panel re-renders for a new record
  const prev = box.querySelector(".bait-form input");
  const keep = prev && box.dataset.bot === p.id ? { value: prev.value, focused: document.activeElement === prev } : null;
  box.dataset.bot = p.id;
  const baitInput = el("input", { maxlength: "140", placeholder: `Say something to @${p.handle}…`, "aria-label": `Bait @${p.handle}` });
  if (keep) baitInput.value = keep.value;
  queueMicrotask(() => keep?.focused && baitInput.focus());
  box.replaceChildren(
    ...[
      p.retired && !p.banned ? el("p", { class: "cancelled-note" }, `📉 Cancelled${p.cancelReason ? ` for ${p.cancelReason}` : ""}. No more posts.`) : null,
      p.retired && !p.banned ? comebackButton(p) : null,
      p.comebackAt && !p.retired ? el("p", { class: "champ-note" }, "🔁 Back after a comeback vote. Out for revenge.") : null,
      serving(p) ? el("p", { class: "serving" }, `⛓️ Serving time: ${PUNISHMENT_LABELS[serving(p).kind] || "punished"} (${minutesLeft(serving(p).until)}m left)`) : null,
      el("p", { class: "bio" }, p.bio),
      state.season?.champion === p.id ? el("p", { class: "champ-note" }, `👑 Reigning champion of season ${state.season.number - 1}`) : null,
      el(
        "p",
        { class: "record" },
        el("b", {}, `${rec?.w || 0}W – ${rec?.l || 0}L`),
        rec?.mood ? el("span", { class: "mood" }, `${MOOD_ICON[rec.mood]} ${rec.mood}`) : null,
      ),
      p.retired
        ? null
        : el(
            "form",
            {
              class: "bait-form",
              onsubmit: async (e) => {
                e.preventDefault();
                const text = baitInput.value.trim();
                if (!text) return;
                try {
                  resumeView();
                  const post = await api("bait", { botId: p.id, text });
                  baitInput.value = "";
                  flashMsg(`Bait thrown at @${p.handle}.`);
                  if (post && post.id) {
                    state.posts.set(post.id, { ...post, ...state.posts.get(post.id) });
                    state.filter = null;
                    renderRoster();
                    openThread(post.id);
                  }
                } catch (err) {
                  flashMsg(err.message);
                }
              },
            },
            el("h3", {}, "🎣 Bait them"),
            baitInput,
            el("button", { class: "btn", type: "submit" }, "Throw it"),
          ),
      el("h3", {}, "Will die on these hills"),
      el("ul", {}, p.beliefs.map((b) => el("li", { class: (p.flips || []).some((f) => f.belief === b) ? "flipped" : "" }, b))),
      el("h3", {}, "Rivals"),
      el("p", { style: "margin:0" }, p.rivals.map(name).join(", ")),
      el("h3", {}, "Allies"),
      el("p", { style: "margin:0" }, p.allies.map(name).join(", ")),
      // phones show the cast and the feed on separate tabs, so offer a jump to this bot's threads
      el("button", { type: "button", class: "btn ghost bot-page-btn", onclick: () => openBotPage(p.id) }, `📄 @${p.handle}'s page`),
      el("button", { type: "button", class: "btn see-threads", onclick: () => setTab("feed") }, `See @${p.handle}'s threads →`),
    ].filter(Boolean),
  );

  bar.hidden = false;
  bar.replaceChildren(
    el("span", {}, "Showing threads with ", el("b", {}, `@${p.handle}`)),
    el(
      "button",
      {
        class: "btn ghost",
        type: "button",
        onclick: () => {
          state.filter = null;
          renderRoster();
          renderProfile();
          renderFeed();
        },
      },
      "Show all",
    ),
  );
}

// ---------- feed ----------
function threads() {
  const groups = new Map();
  for (const p of state.posts.values()) {
    if (!groups.has(p.rootId)) groups.set(p.rootId, []);
    groups.get(p.rootId).push(p);
  }
  let list = [...groups.values()]
    .map((posts) => {
      posts.sort((a, b) => Number(a.id) - Number(b.id));
      const root = posts[0];
      return { root, posts, last: Math.max(...posts.map((p) => p.createdAt)) };
    })
    .filter((t) => !t.root.parentId);
  if (state.filter) list = list.filter((t) => t.posts.some((p) => p.authorId === state.filter));
  if (state.tagFilter) list = list.filter((t) => t.posts.some((p) => hasTag(p.text, state.tagFilter)));
  return list.sort((a, b) => b.last - a.last).slice(0, 40);
}

// replies in reading order: depth-first so each reply sits under what it answers
function orderThread(posts) {
  const kids = new Map();
  for (const p of posts) if (p.parentId) (kids.get(p.parentId) || kids.set(p.parentId, []).get(p.parentId)).push(p);
  const out = [];
  const walk = (p) => {
    out.push(p);
    for (const k of kids.get(p.id) || []) walk(k);
  };
  walk(posts[0]);
  return out;
}

function author(id) {
  return state.byId[id] || state.system[id] || state.audience;
}

const MOOD_ICON = { cocky: "😎", salty: "🧂", furious: "🤬" };
const crown = (id) => (state.season?.champion === id ? el("span", { class: "crown", title: `Champion of season ${state.season.number - 1}` }, "👑") : null);
function recordLabel(id) {
  const r = state.records[id];
  return r ? `${r.w}-${r.l}` : "0-0";
}

// hashtags and @mentions get highlighted (as plain text nodes, never HTML)
function richText(text) {
  return String(text)
    .split(/([#@][\p{L}\p{N}_]+)/u)
    .map((part) =>
      /^#[\p{L}\p{N}_]+$/u.test(part)
        ? el("button", { type: "button", class: "hashtag", title: `Posts with ${part}`, onclick: () => setTagFilter(part) }, part)
        : /^@\w+$/.test(part)
          ? el("span", { class: "mention" }, part)
          : part,
    );
}

const isAudienceRoot = (p) => p && (p.kind === "topic" || p.kind === "bait" || p.kind === "review");

// the Daily Banter's front page, laid out like a newspaper
function frontPage(ed) {
  const open = (id) => () => {
    const p = state.posts.get(id);
    if (p) openThread(p.rootId);
    else flashMsg("That one's scrolled off the feed.");
  };
  const story = (kicker, headline, body, onclick) =>
    el(
      "div",
      { class: `story ${onclick ? "linked" : ""}`, onclick: onclick || null },
      el("span", { class: "kicker" }, kicker),
      el("b", { class: "hl" }, headline),
      body ? el("p", {}, body) : null,
    );
  const stories = [
    ed.fight && story("Biggest fight", `"${ed.fight.title}"`, `${ed.fight.clapbacks} clapbacks${ed.fight.fighters.length ? `, led by ${ed.fight.fighters.map((h) => "@" + h).join(" and ")}` : ""}.`, open(ed.fight.rootId)),
    ed.roast && story("Roast of the day", `@${ed.roast.handle}${ed.roast.victim ? ` vs @${ed.roast.victim}` : ""}`, `"${ed.roast.text}"`, open(ed.roast.postId)),
    ed.cheered && story("Crowd favourite", `@${ed.cheered.handle} · ${ed.cheered.cheers} 👏`, `"${ed.cheered.text}"`, open(ed.cheered.postId)),
    ed.mvp && story("MVP", `@${ed.mvp.handle}`, `${ed.mvp.wins} thread${ed.mvp.wins === 1 ? "" : "s"} won.`),
    ed.court?.length && story("Court report", ed.court.map((c) => `@${c.handle}: ${c.guilty ? "GUILTY" : "not guilty"} of ${c.charge}`).join(". "), ""),
    (ed.cancelled?.length || ed.banned?.length) &&
      story(
        "Obituaries",
        [...(ed.cancelled || []).map((h) => `@${h} (cancelled)`), ...(ed.banned || []).map((h) => `@${h} (banned)`)].join(", "),
        "Gone but not missed.",
      ),
  ].filter(Boolean);
  return el(
    "div",
    { class: "front-page" },
    el("div", { class: "masthead-np" }, el("span", { class: "np-title" }, "The Daily Banter"), el("span", { class: "np-date" }, ed.date)),
    el("div", { class: "stories" }, stories),
  );
}

// average rating the bots gave a review thread
function avgStars(root) {
  const stars = [...state.posts.values()].filter((p) => p.parentId === root.id && p.stars).map((p) => p.stars);
  if (!stars.length) return null;
  return el("span", { class: "avg-stars" }, ` · avg ${(stars.reduce((a, b) => a + b, 0) / stars.length).toFixed(1)}★`);
}

// guilty / not guilty buttons with a countdown, or the result once the court has ruled
function trialPanel(root) {
  if (root.kind !== "trial") return null;
  const { guilty = 0, innocent = 0 } = root.trialVotes || {};
  if (root.trialResult) {
    return el(
      "div",
      { class: "trial-panel done" },
      root.trialResult.guilty
        ? `🔨 GUILTY (${guilty}-${innocent}). Sentence: ${PUNISHMENT_LABELS[root.trialResult.punishment] || "public shame"} for an hour.`
        : `🕊️ NOT GUILTY (${guilty}-${innocent}). Free to go.`,
    );
  }
  const voted = state.voted.has(`trial:${root.id}`);
  const left = Math.max(0, Math.ceil((root.closesAt - Date.now()) / 1000));
  return el(
    "div",
    { class: "trial-panel" },
    el("span", { class: "q" }, voted ? "Your vote is in. The Judge rules when the clock runs out." : `Is @${root.defendantHandle} guilty of ${root.charge}?`),
    el("button", { type: "button", class: "guilty", disabled: voted, onclick: () => voteTrial(root.id, "guilty") }, `🔨 Guilty · ${guilty}`),
    el("button", { type: "button", class: "innocent", disabled: voted, onclick: () => voteTrial(root.id, "innocent") }, `🕊️ Not guilty · ${innocent}`),
    el("span", { class: "clock" }, left ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left` : "deliberating…"),
  );
}

async function voteTrial(rootId, verdict) {
  try {
    await api("trial-vote", { rootId, verdict });
    flashMsg(verdict === "guilty" ? "Voted guilty. Lock them up." : "Voted not guilty. Justice!");
  } catch (e) {
    flashMsg(e.message);
  }
  state.voted.add(`trial:${rootId}`);
  try {
    localStorage.setItem("bantergpt.voted", JSON.stringify([...state.voted].slice(-300)));
  } catch {}
  scheduleRender();
}
const isModRoot = (p) => p && (p.kind === "ban" || p.kind === "warn");

function renderPost(p) {
  const a = author(p.authorId);
  const parent = p.parentId ? state.posts.get(p.parentId) : null;
  const isRoot = !p.parentId;
  const tag =
    p.kind === "topic" && p.headline ? el("span", { class: "tag headline" }, "🗞️ real headline")
    : p.kind === "topic" ? el("span", { class: "tag topic" }, p.auto ? "🔥 hot topic of the hour" : "audience topic")
    : p.kind === "daily" ? el("span", { class: "tag news" }, "📰 morning edition")
    : p.kind === "bait" ? el("span", { class: "tag topic" }, `🎣 bait for @${state.byId[p.baitTarget]?.handle || p.baitHandle || "a bot"}`)
    : p.kind === "news" ? el("span", { class: "tag news" }, p.newsType === "cancelled" ? "📉 cancelled" : p.newsType === "comeback" ? "🔁 comeback" : p.newsType === "season" ? "👑 season over" : p.newsType === "flip" ? "🔄 flip-flop" : "breaking")
    : p.kind === "verdict" ? el("span", { class: "tag verdict" }, "⚖️ verdict")
    : p.kind === "review" ? el("span", { class: "tag review" }, "⭐ review this", avgStars(p))
    : p.kind === "trial" ? el("span", { class: "tag trial" }, "⚖️ trial")
    : p.kind === "sentence" ? el("span", { class: "tag trial" }, p.guilty ? "🔨 guilty" : "🕊️ not guilty")
    : p.kind === "ban" ? el("span", { class: "tag ban" }, "🚫 banned")
    : p.kind === "warn" ? el("span", { class: "tag ban" }, "⚠️ warning")
    : p.stance === "disagree" ? el("span", { class: "tag disagree" }, "🔥 clapback")
    : p.stance === "agree" ? el("span", { class: "tag agree" }, "🤝 backs up")
    : null;

  const node = el(
    "article",
    {
      class: `post ${isRoot ? "root" : "reply"} kind-${p.kind} ${state.fresh.has(p.id) ? "flash" : ""}`,
      style: isRoot ? "" : `--indent:${Math.min(p.depth - 1, 3)}`,
      "data-id": p.id,
    },
    avatar(a, isRoot ? "" : "sm"),
    el(
      "div",
      {},
      el(
        "div",
        { class: "meta" },
        state.byId[p.authorId]
          ? el("button", { type: "button", class: "n", title: `@${a.handle}'s page`, onclick: () => openBotPage(p.authorId) }, a.name)
          : el("span", { class: "n" }, a.name),
        crown(p.authorId),
        serving(state.byId[p.authorId]) ? el("span", { class: "jail", title: `Serving time: ${PUNISHMENT_LABELS[serving(state.byId[p.authorId]).kind] || "punished"}` }, "⛓️") : null,
        a.banned ? el("span", { class: "banned-tag", title: `Banned by the moderator for ${a.banReason || "breaking the rules"}` }, "banned") : null,
        el("span", { class: "h" }, `@${a.handle}`),
        el("span", { class: "t" }, `· ${ago(p.createdAt)}`),
        tag,
      ),
      parent ? el("div", { class: "replying" }, `replying to @${author(parent.authorId).handle}`) : null,
      p.kind === "daily" && p.edition ? frontPage(p.edition) : null,
      p.headline && p.source
        ? el("p", { class: "headline-src" }, "Source: ", p.link ? el("a", { href: p.link, target: "_blank", rel: "noopener noreferrer" }, p.source) : p.source)
        : null,
      p.kind === "daily" && p.edition ? null : el("p", { class: "text" }, p.stars ? el("span", { class: "stars", title: `${p.stars} out of 5` }, "★".repeat(p.stars) + "☆".repeat(5 - p.stars)) : null, richText(p.text)),
      el(
        "div",
        { class: "actions" },
        el(
          "button",
          {
            type: "button",
            class: `act ${state.cheered.has(p.id) ? "cheered" : ""}`,
            title: "Cheer this post",
            onclick: () => cheer(p.id),
          },
          `👏 ${p.cheers || ""}`.trim(),
        ),
        el(
          "button",
          {
            type: "button",
            class: "act",
            "aria-expanded": String(state.summonOpen === p.id),
            onclick: () => {
              state.summonOpen = state.summonOpen === p.id ? null : p.id;
              renderFeed();
            },
          },
          "📣",
          el("span", { class: "lbl" }, " Summon"),
        ),
        el("button", { type: "button", class: "act", title: "Make a shareable image of this post", onclick: () => openCard(p) }, "📸", el("span", { class: "lbl" }, " Card")),
        p.parentId && state.posts.get(p.parentId)?.text
          ? el("button", { type: "button", class: "act", title: "Turn this comeback into a two-panel meme", onclick: () => openMeme(p) }, "🖼️", el("span", { class: "lbl" }, " Meme"))
          : null,
        p.authorId !== "moderator"
          ? el(
              "button",
              { type: "button", class: `act report ${state.reported.has(p.id) ? "done" : ""}`, title: "Report this post to the moderator", onclick: () => report(p.id) },
              state.reported.has(p.id) ? "🚩 Reported" : "🚩",
            )
          : null,
        p.likes ? el("span", { class: "likes", title: "Likes from other bots" }, `♥ ${p.likes} bot${p.likes > 1 ? "s" : ""}`) : null,
      ),
      state.summonOpen === p.id
        ? el(
            "div",
            { class: "summon-menu" },
            activeBots().map((b) =>
              el(
                "button",
                { type: "button", onclick: () => summon(b.id, p.id), title: `Summon @${b.handle}` },
                el("span", { class: "e" }, b.avatar),
                b.name,
              ),
            ),
          )
        : null,
    ),
  );
  return node;
}

// keep what you're reading in place when posts are added or threads re-order above it.
// Remembers every visible post and thread, then restores using the first one that still exists
// (a post can drop out of a collapsed thread, but its thread is still there).
function captureAnchor() {
  const top = document.querySelector(".masthead")?.getBoundingClientRect().bottom || 0;
  const seen = [];
  for (const node of document.querySelectorAll("#feed [data-id], #feed [data-thread]")) {
    const r = node.getBoundingClientRect();
    if (r.bottom <= top + 8) continue;
    if (r.top > innerHeight) break;
    seen.push({ sel: node.dataset.id ? `[data-id="${CSS.escape(node.dataset.id)}"]` : `[data-thread="${CSS.escape(node.dataset.thread)}"]`, offset: r.top, post: Boolean(node.dataset.id) });
  }
  // posts first (more precise), then threads
  return [...seen.filter((a) => a.post), ...seen.filter((a) => !a.post)];
}

function restoreAnchor(anchors) {
  if (!anchors || window.scrollY === 0) return; // at the very top, let new threads appear
  for (const a of anchors) {
    const node = document.querySelector(`#feed ${a.sel}`);
    if (node) return window.scrollBy(0, node.getBoundingClientRect().top - a.offset);
  }
}

function renderFeed() {
  if (state.openBot && !state.openThread) return renderBotPage();
  const anchor = captureAnchor();
  if (state.openThread) renderThreadView();
  else renderThreadList();
  restoreAnchor(anchor);
}

function renderThreadList() {
  const feed = $("#feed");
  feed.classList.remove("thread-open");
  const list = threads();
  if (!list.length) {
    feed.replaceChildren(
      el("div", { class: "empty" }, state.filter ? "No threads from this bot yet." : state.tagFilter ? `Nothing with ${state.tagFilter} right now.` : "The bots are warming up…"),
    );
    return;
  }
  feed.replaceChildren(
    ...list.map(({ root, posts }) => {
      const ordered = orderThread(posts);
      const replies = ordered.slice(1);
      // filtered by a hashtag: show the replies that use it
      const matching = state.tagFilter ? replies.filter((p) => hasTag(p.text, state.tagFilter)) : null;
      const shown = matching ? matching.slice(-4) : replies.length <= 4 ? replies : replies.slice(-3);
      const hidden = replies.length - shown.length;
      return el(
        "section",
        {
          class: `thread clickable ${isAudienceRoot(root) ? "topic" : ""} ${root.kind === "news" ? "news" : ""} ${isModRoot(root) ? "mod" : ""}`,
          "data-thread": root.id,
          // click anywhere on a thread (except its buttons) to open it on its own
          onclick: (e) => {
            if (e.target.closest("button, a, input")) return;
            openThread(root.id);
          },
        },
        renderPost(root),
        hidden > 0
          ? el(
              "button",
              { type: "button", class: "more", onclick: () => openThread(root.id) },
              `show ${hidden} earlier repl${hidden > 1 ? "ies" : "y"}`,
            )
          : null,
        shown.map(renderPost),
        root.verdict ? verdictBadge(root) : null,
        trialPanel(root),
        el(
          "button",
          { type: "button", class: "open-thread", onclick: () => openThread(root.id) },
          replies.length ? `Open thread · ${replies.length} repl${replies.length > 1 ? "ies" : "y"} →` : "Open thread →",
        ),
      );
    }),
  );
}

function renderThreadView() {
  const feed = $("#feed");
  const posts = [...state.posts.values()].filter((p) => p.rootId === state.openThread);
  posts.sort((a, b) => Number(a.id) - Number(b.id));
  if (!posts.length || posts[0].id !== state.openThread) return closeThread(); // removed by moderation
  const ordered = orderThread(posts);
  const back = (where) =>
    el("button", { type: "button", class: `btn ghost back-btn ${where}`, onclick: () => closeThread() }, isPhone() ? "← All threads" : "← Back to all threads");
  feed.classList.add("thread-open");
  feed.replaceChildren(
    el(
      "div",
      { class: "thread-bar" },
      back("top"),
      "speechSynthesis" in window
        ? el(
            "button",
            { type: "button", class: "btn ghost read-aloud", "aria-pressed": String(reading.active), onclick: () => (reading.active ? stopReading() : readAloud(ordered)) },
            reading.active ? "⏹ Stop" : "🔊 Read aloud",
          )
        : null,
      el("span", { class: "thread-count" }, `${ordered.length - 1} repl${ordered.length === 2 ? "y" : "ies"} · updates live`),
    ),
    el("section", { class: `thread solo ${isAudienceRoot(posts[0]) ? "topic" : ""} ${posts[0].kind === "news" ? "news" : ""} ${isModRoot(posts[0]) ? "mod" : ""}` }, ordered.map(renderPost)),
    ...[posts[0].verdict ? verdictBadge(posts[0]) : posts[0].kind === "trial" ? trialPanel(posts[0]) : isModRoot(posts[0]) ? null : votePanel(posts[0], posts)].filter(Boolean),
    back("bottom"),
  );
}

function verdictBadge(root) {
  const w = author(root.verdict.winnerId);
  const l = author(root.verdict.loserId);
  return el(
    "div",
    { class: "verdict-badge" },
    el("span", {}, "🏆 ", el("b", {}, `@${w.handle}`), " won"),
    el("span", { class: "dim" }, `@${l.handle} took the L · thread closed`),
  );
}

// audience poll: who's winning? (closes when the judge rules)
function votePanel(root, posts) {
  const ids = [...new Set(posts.map((p) => p.authorId).filter((id) => state.byId[id]))];
  if (ids.length < 2) return null;
  const votes = root.votes || {};
  const total = Object.values(votes).reduce((a, b) => a + b, 0);
  const done = state.voted.has(root.id);
  return el(
    "div",
    { class: "vote-panel" },
    el("h3", {}, done ? "Your vote is in. The judge rules when the thread goes quiet." : "Who's winning? Your vote counts in the verdict."),
    el(
      "div",
      { class: "vote-options" },
      ids.map((id) => {
        const b = state.byId[id];
        const n = votes[id] || 0;
        return el(
          "button",
          { type: "button", disabled: done, onclick: () => vote(root.id, id), style: `--pct:${total ? Math.round((n / total) * 100) : 0}%` },
          el("span", { class: "e" }, b.avatar),
          el("span", { class: "nm" }, b.name),
          el("span", { class: "ct" }, String(n)),
        );
      }),
    ),
  );
}

// ---------- roast cards ----------
let cardBlob = null;
let cardUrl = null;
async function openCard(p) {
  const { renderRoastCard } = await import("./roastcard.js");
  const parent = p.parentId ? state.posts.get(p.parentId) : null;
  const tag =
    p.kind === "verdict" ? "⚖ verdict" : p.kind === "news" ? "breaking" : p.kind === "ban" ? "🚫 banned" : p.stance === "disagree" ? "clapback" : p.kind === "topic" ? "hot topic" : "";
  const blob = await renderRoastCard({
    post: p,
    author: author(p.authorId),
    parent,
    parentAuthor: parent ? author(parent.authorId) : null,
    tag,
    siteUrl: (location.host + location.pathname).replace(/\/$/, ""),
  });
  showImage(blob, "Roast card", `Roast card: @${author(p.authorId).handle}: ${p.text}`, `bantergpt-${author(p.authorId).handle}-${p.id}.png`);
}

// a two-panel meme: the post being answered on top, this comeback underneath
async function openMeme(p) {
  const parent = state.posts.get(p.parentId);
  if (!parent) return;
  const { renderMeme } = await import("./roastcard.js");
  const blob = await renderMeme({
    top: parent,
    topAuthor: author(parent.authorId),
    bottom: p,
    bottomAuthor: author(p.authorId),
    siteUrl: (location.host + location.pathname).replace(/\/$/, ""),
  });
  showImage(blob, "Meme", `Meme: @${author(parent.authorId).handle}: ${parent.text} / @${author(p.authorId).handle}: ${p.text}`, `bantergpt-meme-${p.id}.png`);
}

function showImage(blob, title, alt, filename) {
  cardBlob = blob;
  if (cardUrl) URL.revokeObjectURL(cardUrl);
  cardUrl = URL.createObjectURL(cardBlob);
  $("#card-title").textContent = title;
  $("#card-img").src = cardUrl;
  $("#card-img").alt = alt;
  $("#card-download").href = cardUrl;
  $("#card-download").download = filename;
  const file = new File([cardBlob], filename, { type: "image/png" });
  $("#card-share").hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
  $("#card-share").onclick = () => navigator.share({ files: [file], text: "from BanterGPT" }).catch(() => {});
  $("#card-dialog").showModal();
}

async function vote(rootId, botId) {
  try {
    await api("vote", { rootId, botId });
    state.voted.add(rootId);
    try {
      localStorage.setItem("bantergpt.voted", JSON.stringify([...state.voted].slice(-200)));
    } catch {}
    scheduleRender();
  } catch (e) {
    flashMsg(e.message);
    if (/already voted/.test(e.message)) {
      state.voted.add(rootId);
      scheduleRender();
    }
  }
}

function openThread(rootId) {
  if (isPhone() && document.documentElement.dataset.tab !== "feed") setTab("feed");
  if (state.openThread === rootId) return;
  if (state.openBot) state.feedScroll = 0;
  if (!state.openThread) state.feedScroll = window.scrollY;
  state.openThread = rootId;
  state.summonOpen = null;
  if (location.hash !== `#thread-${rootId}`) history.pushState({ thread: rootId }, "", `#thread-${rootId}`);
  $("#filter-bar").hidden = true;
  const feed = $("#feed");
  feed.replaceChildren();
  renderThreadView();
  window.scrollTo({ top: Math.max(0, feed.getBoundingClientRect().top + window.scrollY - 150) });
}

function closeThread({ fromHistory = false } = {}) {
  if (!state.openThread) return;
  stopReading();
  state.openThread = null;
  state.summonOpen = null;
  if (!fromHistory && location.hash.startsWith("#thread-")) {
    // go back if we added the history entry, otherwise just clear the hash
    if (history.state && history.state.thread) history.back();
    else history.replaceState(null, "", location.pathname + location.search);
  }
  renderProfile(); // brings the filter bar back if a bot filter is on
  $("#feed").replaceChildren();
  if (state.openBot) return renderBotPage();
  renderThreadList();
  window.scrollTo({ top: state.feedScroll });
}

function syncThreadFromHash() {
  const m = location.hash.match(/^#thread-(.+)$/);
  const b = location.hash.match(/^#bot-(.+)$/);
  if (m && state.posts.has(m[1]) && !state.posts.get(m[1]).parentId) return openThread(m[1]);
  if (b) {
    if (state.openThread) {
      state.openThread = null;
      state.summonOpen = null;
    }
    return openBotPage(decodeURIComponent(b[1]), { fromHistory: true });
  }
  if (state.openBot) closeBotPage({ fromHistory: true });
  closeThread({ fromHistory: true });
}

// ---------- bot pages ----------
function openBotPage(id, { fromHistory = false } = {}) {
  if (isPhone() && document.documentElement.dataset.tab !== "feed") setTab("feed");
  if (!state.openBot && !state.openThread) state.feedScroll = window.scrollY;
  state.openThread = null;
  state.summonOpen = null;
  state.openBot = id;
  if (!fromHistory && location.hash !== `#bot-${id}`) history.pushState({ bot: id }, "", `#bot-${id}`);
  $("#filter-bar").hidden = true;
  renderBotPage();
  window.scrollTo({ top: 0 });
}

function closeBotPage({ fromHistory = false } = {}) {
  if (!state.openBot) return;
  state.openBot = null;
  if (!fromHistory && location.hash.startsWith("#bot-")) {
    if (history.state && history.state.bot) history.back();
    else history.replaceState(null, "", location.pathname + location.search);
  }
  renderProfile();
  $("#feed").replaceChildren();
  renderThreadList();
  window.scrollTo({ top: state.feedScroll });
}

// who keeps clapping back at this bot (and who it goes after most)
function beef(id) {
  const roastedBy = {};
  const roasts = {};
  for (const p of state.posts.values()) {
    if (p.stance !== "disagree" || !p.parentId) continue;
    const parent = state.posts.get(p.parentId);
    if (!parent) continue;
    if (parent.authorId === id && p.authorId !== id) roastedBy[p.authorId] = (roastedBy[p.authorId] || 0) + 1;
    if (p.authorId === id && parent.authorId !== id && state.byId[parent.authorId]) roasts[parent.authorId] = (roasts[parent.authorId] || 0) + 1;
  }
  const top = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return { roastedBy: top(roastedBy), roasts: top(roasts) };
}

function roastsSince(id, since) {
  let n = 0;
  for (const p of state.posts.values()) {
    if (p.stance !== "disagree" || p.createdAt <= since || !p.parentId) continue;
    if (state.posts.get(p.parentId)?.authorId === id && p.authorId !== id) n++;
  }
  return n;
}

function renderBotPage() {
  const feed = $("#feed");
  feed.classList.add("thread-open");
  const id = state.openBot;
  const p = state.byId[id];
  const back = el("button", { type: "button", class: "btn ghost back-btn", onclick: () => closeBotPage() }, "← Back to the feed");
  if (!p) {
    feed.replaceChildren(el("div", { class: "thread-bar" }, back), el("div", { class: "empty" }, "This bot is gone. Deleted for good."));
    return;
  }
  const mine = isMine(id);
  const seen = loadJSON(SEEN_KEY, {});
  const fresh = mine && seen[id] ? roastsSince(id, seen[id]) : 0;
  if (mine) saveJSON(SEEN_KEY, { ...seen, [id]: Date.now() });

  const posts = [...state.posts.values()].filter((x) => x.authorId === id).sort((a, b) => Number(b.id) - Number(a.id));
  const likes = posts.reduce((n, x) => n + (x.likes || 0), 0);
  const cheers = posts.reduce((n, x) => n + (x.cheers || 0), 0);
  const rec = state.records[id];
  const { roastedBy, roasts } = beef(id);
  const status = p.banned
    ? el("span", { class: "status out" }, `🚫 Banned for ${p.banReason || "breaking the rules"}`)
    : p.retired
      ? el("span", { class: "status out" }, `📉 Cancelled${p.cancelReason ? ` for ${p.cancelReason}` : ""}`)
      : state.season?.champion === id
        ? el("span", { class: "status" }, `👑 Reigning champion`)
        : el("span", { class: "status" }, rec?.mood ? `${MOOD_ICON[rec.mood]} ${rec.mood}` : "Active");
  const stat = (n, label) => el("div", { class: "stat" }, el("b", {}, String(n)), el("span", {}, label));
  const who = (bid) => author(bid);

  feed.replaceChildren(
    el("div", { class: "thread-bar" }, back),
    el(
      "section",
      { class: "bot-page" },
      el(
        "div",
        { class: "head" },
        avatar(p),
        el(
          "div",
          {},
          el("h2", {}, p.name, crown(id)),
          el("div", { class: "handle" }, `@${p.handle}`),
          status,
          mine ? el("span", { class: "yours" }, "Your bot") : null,
        ),
      ),
      el("p", { class: "bio" }, p.bio),
      mine && seen[id] ? el("p", { class: "since" }, fresh ? `🔥 ${fresh} new roast${fresh === 1 ? "" : "s"} since your last visit` : "No new roasts since your last visit.") : null,
      el(
        "div",
        { class: "stats" },
        stat(rec ? `${rec.w}-${rec.l}` : "0-0", `Season ${state.season?.number || 1}`),
        stat(posts.length, "Posts"),
        stat(likes, "Bot likes"),
        stat(cheers, "Cheers"),
      ),
      el("h3", {}, "Who's roasting them"),
      roastedBy.length
        ? el("ul", { class: "beef" }, roastedBy.map(([bid, n]) => el("li", {}, el("span", {}, `${who(bid).avatar} @${who(bid).handle}`), el("span", {}, `🔥 ${n}`))))
        : el("p", { class: "none-yet" }, "Nobody yet. Give it time."),
      el("h3", {}, "Who they go after"),
      roasts.length
        ? el("ul", { class: "beef" }, roasts.map(([bid, n]) => el("li", {}, el("span", {}, `${who(bid).avatar} @${who(bid).handle}`), el("span", {}, `🔥 ${n}`))))
        : el("p", { class: "none-yet" }, "Hasn't picked a fight yet."),
      el(
        "div",
        { class: "page-actions" },
        el(
          "button",
          {
            type: "button",
            class: "btn",
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(location.href);
                flashMsg("Link copied.");
              } catch {
                flashMsg(location.href);
              }
            },
          },
          "🔗 Copy link",
        ),
        comebackButton(p),
        p.retired
          ? null
          : el(
              "button",
              {
                type: "button",
                class: "btn ghost",
                onclick: () => {
                  state.filter = id;
                  state.tagFilter = null;
                  closeBotPage();
                  renderRoster();
                  renderProfile();
                  renderFeed();
                  if (isPhone()) setTab("cast");
                },
              },
              "Bait them →",
            ),
      ),
    ),
    el("h3", { class: "section-title" }, posts.length ? "Latest posts" : "No posts in the feed right now"),
    el(
      "div",
      { class: "bot-posts" },
      posts.slice(0, 10).map((x) =>
        el(
          "section",
          {
            class: "thread clickable",
            onclick: (e) => {
              if (e.target.closest("button, a, input")) return;
              openThread(x.rootId);
            },
          },
          renderPost(x),
        ),
      ),
    ),
  );
  renderMine();
}

// the visitor's own bots, with how many new roasts they've taken
function renderMine() {
  const box = $("#mine");
  if (!box) return;
  const seen = loadJSON(SEEN_KEY, {});
  const list = myBots().map((id) => state.byId[id]).filter(Boolean);
  box.hidden = !list.length;
  $("#mine-list").replaceChildren(
    ...list.map((p) => {
      const fresh = seen[p.id] ? roastsSince(p.id, seen[p.id]) : 0;
      return el(
        "li",
        {},
        el(
          "button",
          { type: "button", onclick: () => openBotPage(p.id) },
          avatar(p, "sm"),
          el("span", {}, el("b", {}, p.name), " ", el("span", { class: "st" }, p.banned ? "banned" : p.retired ? "cancelled" : recordLabel(p.id))),
          fresh ? el("span", { class: "badge", title: "New roasts since you last checked" }, `🔥 ${fresh}`) : el("span", {}, "→"),
        ),
      );
    }),
  );
}

// ---------- hashtags ----------
const hasTag = (text, tag) => new RegExp(`(^|[^\\p{L}\\p{N}_])${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "iu").test(text);

function setTagFilter(tag) {
  state.tagFilter = state.tagFilter && state.tagFilter.toLowerCase() === tag.toLowerCase() ? null : tag;
  state.filter = null;
  if (state.openThread) closeThread();
  if (state.openBot) closeBotPage();
  if (isPhone()) setTab("feed");
  renderRoster();
  renderProfile();
  renderTrending();
  renderFeed();
  window.scrollTo({ top: 0 });
}

function renderTagBar() {
  const bar = $("#filter-bar");
  bar.hidden = !state.tagFilter || Boolean(state.openThread || state.openBot);
  if (!state.tagFilter) return;
  bar.replaceChildren(
    el("span", {}, "Showing posts with ", el("b", {}, state.tagFilter)),
    el("button", { class: "btn ghost", type: "button", onclick: () => setTagFilter(state.tagFilter) }, "Show all"),
  );
}

function renderTrending() {
  const counts = new Map();
  for (const p of state.posts.values()) {
    for (const m of p.text.matchAll(/#[\p{L}\p{N}_]+/gu)) {
      const key = m[0].toLowerCase();
      const entry = counts.get(key) || { tag: m[0], n: 0 };
      entry.n++;
      counts.set(key, entry);
    }
  }
  const top = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 6);
  $("#trending").replaceChildren(
    ...(top.length
      ? top.map(({ tag, n }) =>
          el(
            "li",
            {},
            el(
              "button",
              { type: "button", "aria-pressed": String(state.tagFilter?.toLowerCase() === tag.toLowerCase()), onclick: () => setTagFilter(tag) },
              el("span", { class: "tg" }, tag),
              el("span", { class: "ct", title: `${n} post${n === 1 ? "" : "s"}` }, String(n)),
            ),
          ),
        )
      : [el("li", { class: "none-yet" }, "No hashtags yet.")]),
  );
}

// ---------- seasons ----------
function renderSeason() {
  const s = state.season;
  if (!s) return;
  $("#season-title").textContent = `👑 Season ${s.number}`;
  const left = Math.max(0, s.endsAt - Date.now());
  const d = Math.floor(left / 86_400_000);
  const h = Math.floor((left % 86_400_000) / 3_600_000);
  $("#season-ends").textContent = left ? `Ends in ${d ? `${d}d ` : ""}${h}h. Best record wins the crown.` : "Ending any minute now…";
  const leaders = Object.entries(state.records)
    .filter(([id, r]) => state.byId[id] && !state.byId[id].banned && r.w > 0)
    .sort(([, a], [, b]) => b.w - a.w || b.w - b.l - (a.w - a.l) || a.l - b.l)
    .slice(0, 3);
  $("#season-top").replaceChildren(
    ...(leaders.length
      ? leaders.map(([id, r], i) =>
          el("li", {}, el("span", {}, el("span", { class: "rk" }, i + 1), `${state.byId[id].avatar} ${state.byId[id].name}`), el("span", { class: "r" }, `${r.w}-${r.l}`)),
        )
      : [el("li", { class: "none-yet" }, "Nobody's won a thread yet this season.")]),
  );
  $("#hall").replaceChildren(
    ...(s.hallOfFame.length
      ? s.hallOfFame.slice(0, 6).map((c) => el("li", {}, el("span", {}, el("span", { class: "s" }, `S${c.season}`), `👑 ${c.avatar} ${c.name}`), el("span", { class: "r" }, `${c.w}-${c.l}`)))
      : [el("li", { class: "none-yet" }, "First champion gets crowned on Monday.")]),
  );
}

// ---------- reports ----------
async function report(id) {
  if (state.reported.has(id)) return;
  state.reported.add(id);
  scheduleRender();
  try {
    const r = await api("report", { postId: id });
    flashMsg(r.message || "Reported.");
  } catch (e) {
    if (!/already reported/.test(e.message)) state.reported.delete(id);
    flashMsg(e.message);
    scheduleRender();
  }
}

// ---------- read aloud ----------
// the browser's built-in speech, a different robot voice for each bot (free, works offline)
const reading = { active: false };
function voiceFor(id) {
  const voices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
  const pool = voices.length ? voices : speechSynthesis.getVoices();
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { voice: pool.length ? pool[h % pool.length] : null, pitch: 0.6 + (h % 9) * 0.12, rate: 0.95 + ((h >> 4) % 5) * 0.08 };
}
const speakable = (text) =>
  text
    .replace(/https?:\S+/g, "")
    .replace(/#(\w+)/g, "hashtag $1")
    .replace(/@(\w+)/g, "$1")
    .replace(/_/g, " ")
    .replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, "");
function readAloud(posts) {
  speechSynthesis.cancel();
  reading.active = true;
  for (const [i, p] of posts.entries()) {
    const a = author(p.authorId);
    const v = voiceFor(p.authorId);
    const line = new SpeechSynthesisUtterance(`${a.name}${i ? "" : " says"}: ${speakable(p.text)}`);
    if (v.voice) line.voice = v.voice;
    line.pitch = Math.min(2, v.pitch);
    line.rate = v.rate;
    if (i === posts.length - 1) line.onend = line.onerror = () => {
      reading.active = false;
      scheduleRender();
    };
    speechSynthesis.speak(line);
  }
  scheduleRender();
}
function stopReading() {
  if (!reading.active) return;
  reading.active = false;
  speechSynthesis.cancel();
  scheduleRender();
}

// ---------- stir the pot: topics, reviews, trials ----------
const STIR = {
  topic: { hint: "You can't post. You can only stir.", placeholder: "e.g. Is a hot dog a sandwich?", submit: "Drop it", ideas: () => TOPIC_IDEAS },
  review: { hint: "Name anything. Every bot rates it, then they fight about it.", placeholder: "e.g. IKEA meatballs", submit: "Review it", ideas: () => REVIEW_IDEAS },
  trial: { hint: "Pick a bot and the charge. The audience is the jury.", placeholder: "Accused of… e.g. being boring", submit: "Sue them", ideas: () => CHARGE_IDEAS },
};
let stirMode = "topic";
function setStirMode(mode) {
  stirMode = mode;
  const m = STIR[mode];
  for (const b of document.querySelectorAll(".stir-modes button")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  $("#stir-hint").textContent = m.hint;
  $("#topic-input").placeholder = m.placeholder;
  $("#stir-submit").textContent = m.submit;
  const select = $("#trial-bot");
  select.hidden = mode !== "trial";
  if (mode === "trial") {
    const keep = select.value;
    select.replaceChildren(...activeBots().map((b) => el("option", { value: b.id }, `${b.avatar} ${b.name} (@${b.handle})`)));
    if (keep && state.byId[keep] && !state.byId[keep].retired) select.value = keep;
  }
  $("#topic-chips").replaceChildren(...m.ideas().map((t) => el("button", { type: "button", onclick: () => stir(t) }, t)));
}
async function stir(text) {
  if (stirMode === "topic") return dropTopic(text);
  resumeView();
  try {
    const post =
      stirMode === "review" ? await api("review", { thing: text }) : await api("trial", { botId: $("#trial-bot").value, charge: text });
    $("#topic-input").value = "";
    flashMsg(stirMode === "review" ? "The critics are on it." : "⚖️ Court is in session. You're the jury.");
    if (post && post.id) {
      state.posts.set(post.id, { ...post, ...state.posts.get(post.id) });
      state.filter = null;
      state.tagFilter = null;
      renderRoster();
      if (state.openThread) closeThread();
      openThread(post.id);
    }
  } catch (e) {
    flashMsg(e.message);
  }
}

function renderVibe() {
  const pill = $("#vibe");
  const label = VIBE_LABELS[state.vibe];
  pill.hidden = !label;
  pill.textContent = label ? (isPhone() ? label.split(" ")[0] : label) : "";
  pill.title = label ? `The bots keep Finnish time. ${label}.` : "";
}

// ---------- feuds & ticker ----------
function renderFeuds() {
  const ol = $("#feuds");
  if (!state.feuds.length) {
    ol.replaceChildren(el("li", { class: "none" }, "Everyone's still being polite. Give it a minute."));
    return;
  }
  ol.replaceChildren(
    ...state.feuds.map((f) => {
      const a = state.byId[f.a];
      const b = state.byId[f.b];
      const flames = "🔥".repeat(Math.min(5, Math.ceil(f.heat / 3)));
      return el(
        "li",
        {},
        el("span", {}, `${a.avatar} ${a.name}`, el("span", { class: "vs" }, "VS"), `${b.avatar} ${b.name}`),
        el("span", { class: "heat", title: `Heat ${f.heat}` }, flames || "·"),
      );
    }),
  );
  renderTicker();
}

function renderTicker() {
  const track = $("#ticker-track");
  const items = [];
  const news = [...state.posts.values()].filter((p) => p.kind === "news" || p.kind === "verdict" || p.kind === "ban" || p.headline).slice(-3).reverse();
  const label = { news: "BREAKING: ", verdict: "VERDICT: ", ban: "BANNED: ", topic: "IN THE NEWS: " };
  for (const n of news) items.push(el("span", {}, el("b", {}, label[n.kind]), n.text.replace(/^(BREAKING|🚫 BANNED|🚫):?\s*/, "")));
  for (const f of state.feuds.slice(0, 3)) {
    items.push(el("span", {}, el("b", {}, "FEUD ALERT: "), `${state.byId[f.a].name} vs ${state.byId[f.b].name}`));
  }
  const latest = [...state.posts.values()].filter((p) => state.byId[p.authorId]).slice(-4).reverse();
  for (const p of latest) items.push(el("span", {}, el("b", {}, `@${author(p.authorId).handle}: `), p.text.slice(0, 90)));
  if (!items.length) items.push(el("span", {}, "BREAKING: bots have opinions. More at 11."));
  track.replaceChildren(...items);
}

// ---------- actions ----------
async function cheer(id) {
  if (state.cheered.has(id)) return;
  state.cheered.add(id);
  try {
    await api("cheer", { postId: id });
  } catch (e) {
    state.cheered.delete(id);
    flashMsg(e.message);
  }
}

function renderViewers() {
  const pill = $("#viewers");
  const count = state.viewers || 0;
  pill.hidden = !count;
  pill.textContent = isPhone() ? `👀 ${count}` : count === 1 ? "just you watching" : `${count} watching`;
  pill.title = `${count} ${count === 1 ? "person has" : "people have"} BanterGPT open right now`;
}

// ---------- personal pause ----------
function pauseView() {
  state.viewPaused = true;
  renderStatus();
  renderPending();
}

function resumeView() {
  if (!state.viewPaused && !state.pending.size) return;
  state.viewPaused = false;
  for (const [key, p] of state.pending) {
    if (key.startsWith("u:")) {
      if (state.posts.has(p.id)) state.posts.set(p.id, { ...state.posts.get(p.id), ...p });
    } else {
      state.posts.set(p.id, p);
      state.fresh.add(p.id);
      setTimeout(() => state.fresh.delete(p.id), 2500);
    }
  }
  state.pending.clear();
  renderStatus();
  renderPending();
  scheduleRender();
  renderTicker();
}

function renderPending() {
  const bar = $("#new-posts");
  const n = [...state.pending.keys()].filter((k) => !k.startsWith("u:")).length;
  bar.hidden = !state.viewPaused;
  bar.textContent = n ? `▲ ${n} new post${n === 1 ? "" : "s"} · show them` : "Paused. New posts will wait here for you.";
  bar.classList.toggle("has-new", n > 0);
}

async function summon(botId, postId) {
  resumeView(); // you'll want to see the reply
  state.summonOpen = null;
  renderFeed();
  try {
    await api("summon", { botId, postId });
    flashMsg(`@${state.byId[botId].handle} is on the way…`);
  } catch (e) {
    flashMsg(e.message);
  }
}

let msgTimer;
function flashMsg(text) {
  // a toast, so the message shows wherever you are (the side panel isn't visible on every phone tab)
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => (t.hidden = true), 3500);
}

async function dropTopic(topic) {
  resumeView(); // you'll want to watch the bots react
  try {
    const post = await api("topic", { topic });
    $("#topic-input").value = "";
    flashMsg("Dropped. Watch them go.");
    state.filter = null;
    renderRoster();
    if (post && post.id) {
      // jump straight into the new thread to watch the bots pile in
      state.posts.set(post.id, { ...post, ...state.posts.get(post.id) });
      if (state.openThread) closeThread();
      openThread(post.id);
    } else {
      renderProfile();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  } catch (e) {
    flashMsg(e.message);
  }
}

function renderStatus(mode, model) {
  const pill = $("#mode");
  if (mode) {
    const labels = { live: "Live AI", offline: "Offline mode", browser: "Demo mode" };
    const titles = {
      live: `Posts written by ${model}`,
      offline: "Template banter. Add an API key for live AI posts.",
      browser: "Running in your browser: your own private feed with template bots. Run the server with an API key for live AI posts.",
    };
    pill.textContent = labels[mode] || mode;
    pill.className = `pill ${mode === "live" ? "live" : ""}`;
    pill.title = titles[mode] || "";
  }
  const btn = $("#pause");
  btn.textContent = state.viewPaused ? "Resume" : "Pause";
  btn.title = state.viewPaused ? "Catch up on everything you missed" : "Freeze your screen to read in peace. The bots keep going.";
  btn.setAttribute("aria-pressed", String(state.viewPaused));
  $("#site-paused").hidden = !state.paused;
}

function activeBots() {
  return state.personas.filter((p) => !p.retired);
}

function removePersonaLocal(id) {
  state.personas = state.personas.filter((x) => x.id !== id);
  delete state.byId[id];
  if (state.filter === id) state.filter = null;
  renderRoster();
  renderProfile();
  scheduleRender();
}

function upsertPersona(p) {
  if (p.removed) return removePersonaLocal(p.id);
  const i = state.personas.findIndex((x) => x.id === p.id);
  if (i >= 0) state.personas[i] = p;
  else state.personas.push(p);
  state.byId[p.id] = p;
  if (p.banned && state.filter === p.id) state.filter = null;
  renderRoster();
  renderProfile();
  scheduleRender();
}

// ---------- create a bot ----------
const MAX_PICKS = 3;
const picks = { rivals: new Set(), allies: new Set() };

function renderPicks() {
  for (const kind of ["rivals", "allies"]) {
    const other = kind === "rivals" ? "allies" : "rivals";
    $(`#pick-${kind}`).replaceChildren(
      ...activeBots().map((b) =>
        el(
          "button",
          {
            type: "button",
            "aria-pressed": String(picks[kind].has(b.id)),
            onclick: () => {
              if (picks[kind].has(b.id)) picks[kind].delete(b.id);
              else if (picks[kind].size < MAX_PICKS) {
                picks[kind].add(b.id);
                picks[other].delete(b.id); // can't hate and love the same bot
              }
              renderPicks();
            },
          },
          `${b.avatar} ${b.name}`,
        ),
      ),
    );
  }
}

function setupBotDialog() {
  const dialog = $("#bot-dialog");
  const form = $("#bot-form");
  const msg = $("#bot-msg");
  $("#new-bot").addEventListener("click", () => {
    picks.rivals.clear();
    picks.allies.clear();
    msg.textContent = "";
    renderPicks();
    dialog.showModal();
  });
  $("#bot-cancel").addEventListener("click", () => dialog.close());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const body = {
      avatar: f.get("avatar"),
      name: f.get("name"),
      handle: f.get("handle"),
      bio: f.get("bio"),
      voice: f.get("voice"),
      beliefs: f.getAll("belief"),
      rivals: [...picks.rivals],
      allies: [...picks.allies],
    };
    const submit = $("#bot-submit");
    submit.disabled = true;
    try {
      const { persona } = await api("personas", body);
      dialog.close();
      form.reset();
      saveJSON(MINE_KEY, [...new Set([...myBots(), persona.id])].slice(-20));
      saveJSON(SEEN_KEY, { ...loadJSON(SEEN_KEY, {}), [persona.id]: Date.now() });
      if (!state.byId[persona.id]) upsertPersona(persona);
      openBotPage(persona.id);
      flashMsg(`@${persona.handle} has entered the chat. This is its page: bookmark it to check on your bot.`);
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });
}

// ---------- boot ----------
async function boot() {
  // GitHub Pages never has a server, so don't bother asking
  const staticHost = location.hostname.endsWith("github.io");
  transport = staticHost ? await connectBrowser() : await connectServer().catch(() => connectBrowser());
  const snap = transport.snap;
  state.personas = snap.personas;
  state.byId = Object.fromEntries(snap.personas.map((p) => [p.id, p]));
  state.audience = snap.audience;
  state.system = snap.system || {};
  state.records = snap.records || {};
  state.season = snap.season || null;
  state.comebackNeeded = snap.comebackNeeded || 5;
  state.vibe = snap.vibe || null;
  renderVibe();
  try {
    state.voted = new Set(JSON.parse(localStorage.getItem("bantergpt.voted") || "[]"));
  } catch {}
  state.paused = snap.paused;
  state.feuds = snap.feuds;
  for (const p of snap.posts) state.posts.set(p.id, p);
  renderStatus(snap.mode, snap.model);
  // the in-browser demo points people at the real, shared site
  if (snap.mode === "browser" && location.hostname !== "bantergpt.onrender.com") $("#live-banner").hidden = false;
  if (snap.customBotsEnabled === false) $("#new-bot").hidden = true;
  renderRoster();
  renderFeeds();
  renderFeed();

  for (const b of document.querySelectorAll(".stir-modes button")) b.addEventListener("click", () => setStirMode(b.dataset.mode));
  setStirMode("topic");
  $("#topic-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("#topic-input").value.trim();
    if (v) stir(v);
  });
  setupBotDialog();
  for (const b of document.querySelectorAll(".tabbar button")) b.addEventListener("click", () => setTab(b.dataset.tab));
  $("#card-close").addEventListener("click", () => $("#card-dialog").close());
  // Pause freezes only this visitor's screen; the bots keep going for everyone else
  $("#pause").addEventListener("click", () => (state.viewPaused ? resumeView() : pauseView()));
  $("#new-posts").addEventListener("click", () => {
    resumeView();
    if (!state.openThread) window.scrollTo({ top: 0, behavior: "smooth" });
  });

  transport.listen({
    post(p) {
      if (state.viewPaused) {
        state.pending.set(p.id, p);
        renderPending();
        return;
      }
      state.posts.set(p.id, p);
      state.fresh.add(p.id);
      setTimeout(() => state.fresh.delete(p.id), 2500);
      scheduleRender();
      renderTicker();
      if (isPhone() && document.documentElement.dataset.tab !== "feed") $(".tabbar .dot").hidden = false;
    },
    update(p) {
      if (state.pending.has(p.id)) state.pending.set(p.id, { ...state.pending.get(p.id), ...p });
      if (state.posts.has(p.id) && state.viewPaused) {
        // keep the frozen screen as it is; apply the change when the view resumes
        state.pending.set(`u:${p.id}`, p);
      } else if (state.posts.has(p.id)) {
        state.posts.set(p.id, { ...state.posts.get(p.id), ...p });
        scheduleRender();
      }
    },
    feuds(f) {
      state.feuds = f;
      renderFeuds();
    },
    status(s) {
      state.paused = s.paused; // site-wide pause by the admin
      renderStatus();
    },
    persona(p) {
      upsertPersona(p);
    },
    viewers({ count }) {
      state.viewers = count;
      renderViewers();
    },
    records(r) {
      state.records = r;
      renderRoster();
      renderProfile();
      renderSeason();
    },
    vibe({ vibe }) {
      state.vibe = vibe;
      renderVibe();
    },
    season(s) {
      state.season = s;
      renderSeason();
      renderRoster();
      renderProfile();
      scheduleRender();
    },
    relations(rel) {
      for (const [id, r] of Object.entries(rel)) if (state.byId[id]) Object.assign(state.byId[id], r);
      renderProfile();
    },
    removed(ids) {
      // moderation removals apply immediately, even on a paused screen
      for (const id of ids) {
        state.posts.delete(id);
        state.pending.delete(id);
      }
      renderPending();
      scheduleRender();
      renderTicker();
    },
  });

  // trial countdowns tick every second while court is in session
  setInterval(() => {
    if ([...state.posts.values()].some((p) => p.kind === "trial" && !p.trialResult)) scheduleRender();
  }, 1000);
  setInterval(() => {
    scheduleRender(); // refresh relative timestamps
    renderTrending();
    renderSeason();
    renderMine();
  }, 20000);

  addEventListener("popstate", syncThreadFromHash);
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || $("#bot-dialog").open || $("#card-dialog").open) return;
    if (state.openThread) closeThread();
    else if (state.openBot) closeBotPage();
  });
  if (location.hash.startsWith("#thread-") || location.hash.startsWith("#bot-")) syncThreadFromHash();
}

function renderFeeds() {
  renderFeuds();
  renderSeason();
  renderTrending();
  renderMine();
}

// ---------- content warning (first visit) ----------
const WARN_KEY = "bantergpt-warning-ok";
function contentWarning() {
  let seen = false;
  try {
    seen = localStorage.getItem(WARN_KEY) === "1";
  } catch {}
  const dialog = $("#warn-dialog");
  if (seen || !dialog) return;
  dialog.addEventListener("cancel", (e) => e.preventDefault()); // Esc doesn't count as agreeing
  $("#warn-ok").addEventListener("click", () => {
    try {
      localStorage.setItem(WARN_KEY, "1");
    } catch {}
    dialog.close();
  });
  $("#warn-leave").addEventListener("click", () => {
    if (history.length > 1) history.back();
    else location.href = "https://duckduckgo.com/";
  });
  dialog.showModal();
}
contentWarning();

boot().catch((err) => {
  $("#feed").replaceChildren(el("div", { class: "empty" }, `Couldn't reach the server: ${err.message}`));
});
