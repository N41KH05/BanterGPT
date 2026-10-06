// Real news headlines for the bots to argue about (server-only).
//
// Feeds come in groups: a group is one or more feeds where the first one that works is used,
// so "Iltalehti, or Yle if Iltalehti is down" is one group. Each time, a random group gets the
// first shot, so Finnish and English news take turns.
//
// Only light stories get through: a word filter (English and Finnish) drops deaths, violence,
// crime, disasters, illness and children, plus the moderated subjects; in live mode an AI
// double-checks what's left.

export const DEFAULT_FEEDS = [
  // Finnish: Iltalehti, or Yle Uutiset if Iltalehti's feed fails
  ["https://www.iltalehti.fi/rss.xml", "https://www.iltalehti.fi/rss/uutiset.xml", "https://yle.fi/rss/uutiset/tuoreimmat"],
  // English: lighter BBC sections (all of them, merged into one group)
  [
    "https://feeds.bbci.co.uk/news/technology/rss.xml",
    "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml",
    "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml",
    "https://feeds.bbci.co.uk/news/business/rss.xml",
  ],
];

// BANTER_NEWS_FEEDS: groups separated by commas, fallbacks within a group by "|";
// a group whose feeds are joined with "+" is merged instead. "off" = no headlines.
export function parseFeedSetting(setting) {
  if (setting === undefined || setting === null || setting.trim() === "") {
    return [
      { mode: "fallback", feeds: DEFAULT_FEEDS[0] },
      { mode: "merge", feeds: DEFAULT_FEEDS[1] },
    ];
  }
  if (setting.trim().toLowerCase() === "off") return [];
  return setting
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean)
    .map((g) =>
      g.includes("+")
        ? { mode: "merge", feeds: g.split("+").map((f) => f.trim()).filter(Boolean) }
        : { mode: "fallback", feeds: g.split("|").map((f) => f.trim()).filter(Boolean) },
    );
}

const decodeEntities = (t) =>
  t
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// a short, readable name for the feed: "BBC Technology", "Iltalehti", "Yle Uutiset"
export function sourceName(channelTitle, url) {
  const t = channelTitle || new URL(url).hostname.replace(/^www\./, "");
  return t.replace(/^BBC News - /, "BBC ").replace(/\s*[|–-]\s*(Tuoreimmat|Pääuutiset|Uusimmat|Etusivu|Uutiset)\s*$/i, "").replace(/\s*\|.*$/, "").trim();
}

export function parseFeed(xml, url) {
  const source = sourceName(decodeEntities((xml.match(/<channel>[\s\S]*?<title>([\s\S]*?)<\/title>/) || [])[1] || ""), url);
  const items = [];
  for (const item of xml.match(/<item\b[\s\S]*?<\/item>/g) || []) {
    const title = decodeEntities((item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
    const link = decodeEntities((item.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "");
    if (title) items.push({ title, link: /^https?:\/\//.test(link) ? link : "", source });
  }
  return items;
}

// stories bots shouldn't joke about: English words, and Finnish word stems (Finnish bends its
// words, so "kuol" catches kuoli, kuollut, kuolema...)
const TRAGEDY_EN =
  /\b(?:dead|dies|died|death|deaths|deadly|die|kill|kills|killed|killing|murder\w*|shoot\w*|shot|stab\w*|attack\w*|war|wars|bomb\w*|missile\w*|drone strike\w*|terror\w*|hostage\w*|rape\w*|abuse\w*|assault\w*|victim\w*|crash\w*|disaster\w*|earthquake\w*|flood\w*|wildfire\w*|famine|suicide|overdose|injur\w*|wounded|massacre|genocide|funeral|mourn\w*|tragedy|tragic|cancer|hospital\w*|missing|kidnap\w*|trafficking|child|children|baby|babies|arrest\w*|jail\w*|prison\w*|court|trial|sentenc\w*|police)\b/i;
const TRAGEDY_FI = new RegExp(
  "(?<![\\p{L}])(?:" +
    [
      "kuol", "kuoli", "menehty", "surma", "surmat", "murha", "tapo", "tappo", "tappa", "ampu", "ammu", "ammus", "ampuma", "puukot", "puukko",
      "onnettomu", "kolari", "turma", "törmä", "sota", "sodan", "sotaa", "sodassa", "sotila", "isku", "iskus", "hyökkä", "pommi", "ohjus", "drooni",
      "terror", "panttivan", "uhri", "raisk", "pahoinpi", "seksuaalirik", "hyväksikä", "väkival", "rikos", "rikok", "epäil", "ryöst", "varkau",
      "tulipalo", "palo ", "katastrof", "maanjäris", "tulva", "hukku", "kadon", "kadoks", "loukkaant", "vammautu", "syöp", "sairaal", "tehohoi",
      "sairastu", "diagnoo", "hautaj", "suru", "itsemurh", "yliannost", "huume", "vankil", "vanki", "tuomi", "oikeude", "käräj", "hovioikeu",
      "syyte", "syytet", "poliisi", "pidätet", "pidätys", "kaappa", "lapsi", "lapse", "lasten", "lapsia", "vauva", "koulu-ammu", "ruumi",
    ].join("|") +
    ")",
  "iu",
);
// people as a group (nationalities, religions, migration): the bots stay out of those in any language
const GROUPS_FI = /(?<![\p{L}])(?:maahanmuut|pakolai|turvapaik|muslim|juutala|islam|kristit|romani|saamelai|rasis|natsi|seksuaalivähemm|homo|transsukupuol|sukupuolivähemm)|\p{L}+(?:lainen|läinen|laiset|läiset|laisten|läisten|laisia|läisiä)(?![\p{L}])/iu;

export function isLightHeadline(title, screenText = () => null) {
  if (title.length < 20 || title.length > 160) return false;
  if (TRAGEDY_EN.test(title) || TRAGEDY_FI.test(title) || GROUPS_FI.test(title)) return false;
  return !screenText(title);
}

async function readFeed(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "BanterGPT/1.0 (+https://bantergpt.onrender.com)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseFeed(await res.text(), url);
}

// headlines from one group: the first feed that works (fallback), or all of them (merge)
export async function fetchGroup(group, log = console.warn) {
  if (group.mode === "merge") {
    const all = await Promise.all(group.feeds.map((f) => readFeed(f).catch((err) => (log(`[headlines] couldn't read ${f}: ${err.message}`), []))));
    return all.flat();
  }
  for (const feed of group.feeds) {
    try {
      const items = await readFeed(feed);
      if (items.length) return items;
      log(`[headlines] ${feed} had no headlines, trying the next feed`);
    } catch (err) {
      log(`[headlines] couldn't read ${feed}: ${err.message}${feed !== group.feeds.at(-1) ? ", trying the next feed" : ""}`);
    }
  }
  return [];
}
