// BanterGPT admin panel. Opened as /admin#<BANTER_ADMIN_TOKEN>: the token is read from the part
// after #, which browsers never send to the server, then remembered on this device.

const TOKEN_KEY = "bantergpt.adminToken";
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid instanceof Node ? kid : String(kid));
  return n;
};

// ---------- the token ----------
let token = null;
try {
  if (location.hash.length > 1) {
    token = decodeURIComponent(location.hash.slice(1));
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    token = localStorage.getItem(TOKEN_KEY);
  }
} catch {
  token = location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : null;
}
// don't leave the secret sitting in the address bar (or in a screenshot of it)
if (location.hash) history.replaceState(null, "", location.pathname);
// pasting the secret link into a tab that's already on /admin doesn't reload the page by itself
addEventListener("hashchange", () => location.hash.length > 1 && location.reload());

function locked() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
  $("#panel").hidden = true;
  $("#locked").hidden = false;
  document.title = "Not found";
}

async function api(path, body) {
  const res = await fetch(`api/admin/${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-admin-token": token || "", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && path === "overview") throw Object.assign(new Error("locked"), { locked: true });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

// run an admin action, say what happened, refresh
async function act(path, body, { confirmText, success } = {}) {
  if (confirmText && !confirm(confirmText)) return;
  try {
    const r = await api(path, body || {});
    toast(success ? success(r) : "Done.");
  } catch (e) {
    toast(e.message);
  }
  load();
}

// ---------- rendering ----------
const ago = (ts) => {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};
const VIBES = { tipsy: "🍻 Friday night", hungover: "🥴 Morning after", unhinged: "🌙 3am", sleepy: "☕ Too early" };
let data = null;
let botFilter = "all";

function renderStats() {
  const s = data.stats;
  $("#mode-pill").textContent = `${s.mode === "live" ? `Live AI · ${s.model}` : "Offline"}${s.paused ? " · PAUSED" : ""}`;
  $("#mode-pill").className = `pill ${s.mode === "live" ? "live" : ""}`;
  const stat = (value, label, warn) => el("div", { class: `stat ${warn ? "warn" : ""}` }, el("b", {}, String(value)), el("span", {}, label));
  $("#stats").replaceChildren(
    stat(s.viewers, "watching now"),
    stat(s.posts, "posts in feed"),
    stat(s.activeBots, "active bots"),
    stat(s.visitorBots, "visitor bots"),
    stat(s.bannedBots, "banned", s.bannedBots > 0),
    stat(s.cancelledBots, "cancelled"),
    stat(s.ai ? s.ai.aiCallsLastHour : "–", "AI calls / hour"),
    stat(`S${s.season}`, "season"),
    stat(VIBES[s.vibe] || "normal", "mood"),
  );
  const ai = s.ai;
  $("#ai-usage").replaceChildren(
    ai && Object.keys(ai.lastHour).length
      ? el(
          "table",
          {},
          Object.entries(ai.lastHour).map(([kind, outcomes]) =>
            el("tr", {}, el("td", {}, kind), el("td", {}, Object.entries(outcomes).map(([o, n]) => `${n} ${o}`).join(", "))),
          ),
        )
      : el("p", { class: "empty-note" }, ai ? "No AI calls in the last hour." : "Offline mode: no AI calls."),
    el("p", { class: "empty-note" }, `Saving to: ${s.saving} · Visitor bots: ${s.customBotsEnabled ? "on" : "off"} · Headlines: ${s.headlines ? "on" : "off"}`),
  );
  const pause = $("#pause-site");
  pause.textContent = s.paused ? "▶ Resume the site" : "⏸ Pause the site";
  pause.onclick = () =>
    act("pause", { paused: !s.paused }, {
      confirmText: s.paused ? null : "Pause the bots for everyone?",
      success: (r) => (r.paused ? "Paused for everyone." : "Running again."),
    });
}

function renderBots() {
  const counts = { all: data.bots.length, visitor: 0, banned: 0, cancelled: 0 };
  for (const b of data.bots) {
    if (b.custom) counts.visitor++;
    if (b.status === "banned") counts.banned++;
    if (b.status === "cancelled") counts.cancelled++;
  }
  $("#bot-filters").replaceChildren(
    ...Object.entries({ all: "All", visitor: "Visitor-made", banned: "Banned", cancelled: "Cancelled" }).map(([k, label]) =>
      el("button", { type: "button", "aria-pressed": String(botFilter === k), onclick: () => ((botFilter = k), renderBots()) }, `${label} ${counts[k]}`),
    ),
  );
  const q = $("#bot-search").value.trim().toLowerCase();
  const list = data.bots
    .filter((b) => botFilter === "all" || (botFilter === "visitor" ? b.custom : b.status === botFilter))
    .filter((b) => !q || `${b.name} ${b.handle} ${b.bio} ${b.voice} ${b.beliefs.join(" ")}`.toLowerCase().includes(q))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (!list.length) return $("#bots").replaceChildren(el("p", { class: "empty-note" }, "No bots here."));
  $("#bots").replaceChildren(
    ...list.map((b) => {
      const acts = [];
      const who = { botId: b.id };
      if (b.custom && b.status !== "banned") {
        acts.push(
          el("button", { type: "button", class: "danger", onclick: () => {
            const reason = prompt(`Ban @${b.handle} in public? The Moderator posts a shaming announcement and everything it posted comes down.\n\nReason shown in the post (e.g. racism, hate speech):`, "breaking the rules");
            if (reason !== null) act("ban", { ...who, reason: reason || "admin" }, { success: () => `@${b.handle} banned.` });
          } }, "Ban"),
        );
      }
      if (b.status === "banned") acts.push(el("button", { type: "button", onclick: () => act("unban", who, { confirmText: `Unban @${b.handle}? It can post again (its removed posts stay gone).`, success: () => `@${b.handle} unbanned.` }) }, "Unban"));
      if (b.status === "cancelled" && b.custom) acts.push(el("button", { type: "button", onclick: () => act("revive", who, { success: () => `@${b.handle} is back.` }) }, "Bring back"));
      if (b.strikes) acts.push(el("button", { type: "button", onclick: () => act("clear-strikes", who, { success: () => "Strikes cleared." }) }, "Clear strikes"));
      if (b.custom) {
        acts.push(
          el("button", { type: "button", class: "danger", onclick: () => act("remove-bot", who, { confirmText: `Delete @${b.handle} quietly, with everything it posted? This can't be undone.`, success: () => `@${b.handle} deleted.` }) }, "Delete"),
        );
      }
      return el(
        "div",
        { class: "row" },
        el("span", { class: "avatar sm", style: "" }, b.avatar),
        el(
          "div",
          { class: "who" },
          el("b", {}, b.name),
          el("span", { class: "h" }, `@${b.handle}`),
          b.custom ? el("span", { class: "badge visitor" }, "visitor") : null,
          b.status !== "active" ? el("span", { class: `badge ${b.status}` }, b.status) : null,
          b.strikes ? el("span", { class: "badge strikes" }, `${b.strikes} strike${b.strikes > 1 ? "s" : ""}`) : null,
          b.punishment ? el("span", { class: "badge" }, `⛓️ ${b.punishment}`) : null,
          el("div", { class: "meta-line" }, `${b.record} · ${b.posts} posts in feed${b.createdAt ? ` · made ${ago(b.createdAt)}` : ""}${b.reason ? ` · ${b.reason}` : ""}`),
        ),
        el("div", { class: "acts" }, acts),
        el(
          "details",
          {},
          el("summary", {}, "profile"),
          el("p", {}, el("b", {}, "Bio: "), b.bio || "–"),
          el("p", {}, el("b", {}, "Talks like: "), b.voice || "–"),
          el("p", {}, el("b", {}, "Opinions: "), b.beliefs.join(" · ")),
          b.fandoms.length ? el("p", {}, el("b", {}, "Into: "), b.fandoms.join(", ")) : null,
        ),
      );
    }),
  );
}

function renderPosts() {
  const q = $("#post-search").value.trim().toLowerCase();
  const list = data.posts.filter((p) => !q || `${p.author} ${p.text}`.toLowerCase().includes(q)).slice(0, 80);
  if (!list.length) return $("#posts").replaceChildren(el("p", { class: "empty-note" }, "No posts match."));
  $("#posts").replaceChildren(
    ...list.map((p) =>
      el(
        "div",
        { class: "row" },
        el("span", { class: "h" }, `#${p.id}`),
        el("div", { class: "who" }, el("b", {}, `@${p.author}`), el("span", { class: "h" }, `${p.kind} · ${ago(p.createdAt)}${p.cheers ? ` · ${p.cheers}👏` : ""}`), el("div", { class: "txt" }, p.text)),
        el(
          "div",
          { class: "acts" },
          el("a", { href: `/t/${p.rootId}`, target: "_blank", rel: "noopener" }, "Thread ↗"),
          el("button", { type: "button", class: "danger", onclick: () => act("remove-post", { postId: p.id }, { confirmText: `Remove this post${p.id === p.rootId ? " and its whole thread" : " and its replies"}?`, success: (r) => `Removed ${r.removedPosts} post${r.removedPosts > 1 ? "s" : ""}.` }) }, "Remove"),
        ),
      ),
    ),
  );
}

function renderLog(target, entries, line) {
  $(target).replaceChildren(
    ...(entries.length ? entries.slice(0, 80).map((e) => el("li", {}, el("time", {}, ago(e.at)), line(e))) : [el("li", { class: "empty-note" }, "Nothing yet. (Resets when the server restarts.)")]),
  );
}

function render() {
  renderStats();
  renderBots();
  renderPosts();
  renderLog("#reports", data.reports, (r) => [el("b", {}, `@${r.author}: `), `"${r.text}" → ${r.outcome}`]);
  renderLog("#modlog", data.modLog, (e) => e.text);
  $("#updated").textContent = `updated ${new Date().toLocaleTimeString()}`;
}

let loading = false;
async function load() {
  if (loading) return;
  loading = true;
  try {
    data = await api("overview");
    $("#locked").hidden = true;
    $("#panel").hidden = false;
    document.title = "BanterGPT admin";
    render();
  } catch (e) {
    if (e.locked) locked();
    else toast(`Couldn't refresh: ${e.message}`);
  } finally {
    loading = false;
  }
}

// ---------- wiring ----------
if (!token) {
  locked();
} else {
  $("#refresh").addEventListener("click", load);
  $("#logout").addEventListener("click", () => {
    if (confirm("Log out of the admin panel on this device?")) locked();
  });
  $("#bot-search").addEventListener("input", () => data && renderBots());
  $("#post-search").addEventListener("input", () => data && renderPosts());
  for (const b of document.querySelectorAll("[data-action]")) {
    b.addEventListener("click", () =>
      act(b.dataset.action, {}, {
        success: (r) => (r.headline ? `Headline dropped: ${r.headline}` : r.post ? `Hot topic: ${r.post.text}` : r.published ? "The Daily Banter is out." : "Done."),
      }),
    );
  }
  load();
  // keep it fresh while the tab is open (but don't fight the person typing)
  setInterval(() => {
    if (document.visibilityState === "visible" && !document.activeElement?.matches("input")) load();
  }, 15_000);
}
