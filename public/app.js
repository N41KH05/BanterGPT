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
};

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
const EVENTS = ["post", "update", "feuds", "status", "persona", "removed", "records", "relations", "viewers"];
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
  const engine = new Engine({ generator: offlineGenerator, intervalMs: 5000, autoTopicMs: 10 * 60_000, shakeupMs: 6 * 60_000 });

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
function renderRoster() {
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
            el("span", { class: "n" }, p.name, p.custom ? el("span", { class: "custom-tag", title: "Made by a visitor" }, "new") : null),
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
    bar.hidden = true;
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
    el("p", { class: "bio" }, p.bio),
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
    el("ul", {}, p.beliefs.map((b) => el("li", {}, b))),
    el("h3", {}, "Rivals"),
    el("p", { style: "margin:0" }, p.rivals.map(name).join(", ")),
    el("h3", {}, "Allies"),
    el("p", { style: "margin:0" }, p.allies.map(name).join(", ")),
    // phones show the cast and the feed on separate tabs, so offer a jump to this bot's threads
    el("button", { type: "button", class: "btn see-threads", onclick: () => setTab("feed") }, `See @${p.handle}'s threads →`),
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
function recordLabel(id) {
  const r = state.records[id];
  return r ? `${r.w}-${r.l}` : "0-0";
}

const isAudienceRoot = (p) => p && (p.kind === "topic" || p.kind === "bait");
const isModRoot = (p) => p && (p.kind === "ban" || p.kind === "warn");

function renderPost(p) {
  const a = author(p.authorId);
  const parent = p.parentId ? state.posts.get(p.parentId) : null;
  const isRoot = !p.parentId;
  const tag =
    p.kind === "topic" ? el("span", { class: "tag topic" }, p.auto ? "🔥 hot topic of the hour" : "audience topic")
    : p.kind === "bait" ? el("span", { class: "tag topic" }, `🎣 bait for @${state.byId[p.baitTarget]?.handle || p.baitHandle || "a bot"}`)
    : p.kind === "news" ? el("span", { class: "tag news" }, "breaking")
    : p.kind === "verdict" ? el("span", { class: "tag verdict" }, "⚖️ verdict")
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
        el("span", { class: "n" }, a.name),
        a.banned ? el("span", { class: "banned-tag", title: `Banned by the moderator for ${a.banReason || "breaking the rules"}` }, "banned") : null,
        el("span", { class: "h" }, `@${a.handle}`),
        el("span", { class: "t" }, `· ${ago(p.createdAt)}`),
        tag,
      ),
      parent ? el("div", { class: "replying" }, `replying to @${author(parent.authorId).handle}`) : null,
      el("p", { class: "text" }, p.text),
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
          "📣 Summon",
        ),
        el("button", { type: "button", class: "act", title: "Make a shareable image of this post", onclick: () => openCard(p) }, "📸 Card"),
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
    feed.replaceChildren(el("div", { class: "empty" }, state.filter ? "No threads from this bot yet." : "The bots are warming up…"));
    return;
  }
  feed.replaceChildren(
    ...list.map(({ root, posts }) => {
      const ordered = orderThread(posts);
      const replies = ordered.slice(1);
      const shown = replies.length <= 4 ? replies : replies.slice(-3);
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
      el("span", { class: "thread-count" }, `${ordered.length - 1} repl${ordered.length === 2 ? "y" : "ies"} · updates live`),
    ),
    el("section", { class: `thread solo ${isAudienceRoot(posts[0]) ? "topic" : ""} ${posts[0].kind === "news" ? "news" : ""} ${isModRoot(posts[0]) ? "mod" : ""}` }, ordered.map(renderPost)),
    ...[posts[0].verdict ? verdictBadge(posts[0]) : isModRoot(posts[0]) ? null : votePanel(posts[0], posts)].filter(Boolean),
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
  cardBlob = await renderRoastCard({
    post: p,
    author: author(p.authorId),
    parent,
    parentAuthor: parent ? author(parent.authorId) : null,
    tag,
    siteUrl: (location.host + location.pathname).replace(/\/$/, ""),
  });
  if (cardUrl) URL.revokeObjectURL(cardUrl);
  cardUrl = URL.createObjectURL(cardBlob);
  $("#card-img").src = cardUrl;
  $("#card-img").alt = `Roast card: @${author(p.authorId).handle}: ${p.text}`;
  $("#card-download").href = cardUrl;
  $("#card-download").download = `bantergpt-${author(p.authorId).handle}-${p.id}.png`;
  const file = new File([cardBlob], "bantergpt-roast.png", { type: "image/png" });
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
  state.openThread = null;
  state.summonOpen = null;
  if (!fromHistory && location.hash.startsWith("#thread-")) {
    // go back if we added the history entry, otherwise just clear the hash
    if (history.state && history.state.thread) history.back();
    else history.replaceState(null, "", location.pathname + location.search);
  }
  renderProfile(); // brings the filter bar back if a bot filter is on
  $("#feed").replaceChildren();
  renderThreadList();
  window.scrollTo({ top: state.feedScroll });
}

function syncThreadFromHash() {
  const m = location.hash.match(/^#thread-(.+)$/);
  if (m && state.posts.has(m[1]) && !state.posts.get(m[1]).parentId) openThread(m[1]);
  else closeThread({ fromHistory: true });
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
  const news = [...state.posts.values()].filter((p) => p.kind === "news" || p.kind === "verdict" || p.kind === "ban").slice(-3).reverse();
  const label = { news: "BREAKING: ", verdict: "VERDICT: ", ban: "BANNED: " };
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
  const m = $("#topic-msg");
  m.textContent = text;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => (m.textContent = ""), 4000);
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
  if (p.retired && state.filter === p.id) state.filter = null;
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
      flashMsg(`@${persona.handle} has entered the chat.`);
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

  $("#topic-chips").replaceChildren(
    ...TOPIC_IDEAS.map((t) => el("button", { type: "button", onclick: () => dropTopic(t) }, t)),
  );
  $("#topic-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("#topic-input").value.trim();
    if (v) dropTopic(v);
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

  setInterval(scheduleRender, 20000); // refresh relative timestamps

  addEventListener("popstate", syncThreadFromHash);
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.openThread && !$("#bot-dialog").open && !$("#card-dialog").open) closeThread();
  });
  if (location.hash.startsWith("#thread-")) syncThreadFromHash();
}

function renderFeeds() {
  renderFeuds();
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
