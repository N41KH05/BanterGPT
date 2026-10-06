import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeed, parseFeedSetting, isLightHeadline, fetchGroup, sourceName } from "../src/headlines.js";
import { screenText } from "../src/moderation.js";

const rss = (channel, items) =>
  `<?xml version="1.0"?><rss><channel><title>${channel}</title>${items.map(([t, l]) => `<item><title>${t}</title><link>${l}</link></item>`).join("")}</channel></rss>`;

test("default feeds: Iltalehti with Yle as fallback, plus BBC", () => {
  const groups = parseFeedSetting(undefined);
  assert.equal(groups[0].mode, "fallback");
  assert.match(groups[0].feeds[0], /iltalehti\.fi/);
  assert.match(groups[0].feeds.at(-1), /yle\.fi/);
  assert.equal(groups[1].mode, "merge");
  assert.deepEqual(parseFeedSetting("off"), []);
  assert.deepEqual(parseFeedSetting("https://a/x|https://b/y, https://c+https://d"), [
    { mode: "fallback", feeds: ["https://a/x", "https://b/y"] },
    { mode: "merge", feeds: ["https://c", "https://d"] },
  ]);
});

test("feeds are parsed, CDATA, entities and Finnish letters included", () => {
  const items = parseFeed(rss("Yle Uutiset | Tuoreimmat", [["<![CDATA[Kahvin hinta nousee &amp; suomalaiset raivoavat]]>", "https://yle.fi/a/1"], ["Mökkikausi venyy lokakuulle", "https://yle.fi/a/2"]]), "https://yle.fi/rss");
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Kahvin hinta nousee & suomalaiset raivoavat");
  assert.equal(items[1].source, "Yle Uutiset");
  assert.equal(sourceName("Iltalehti", "https://www.iltalehti.fi/rss.xml"), "Iltalehti");
  assert.equal(sourceName("BBC News - Technology", "x"), "BBC Technology");
});

test("Finnish tragedies, crime and groups are filtered out", () => {
  for (const t of [
    "Mies kuoli liikenneonnettomuudessa Tampereella",
    "Poliisi tutkii ampumista Helsingissä",
    "Venäjä kopioi Ukrainan opit droonisodasta",
    "Lapsi löytyi metsästä yön jälkeen",
    "Oikeus antoi tuomion huijaustapauksessa",
    "Israelilaiset siirtokuntalaiset pahoinpitelivät kuvaajan",
  ]) {
    assert.equal(isLightHeadline(t, screenText), false, t);
  }
});

test("light Finnish and English headlines get through", () => {
  for (const t of ["Mökkikausi venyy lokakuulle – sauna lämpenee vielä", "Uusi kahvila myy pelkkää salmiakkikahvia", "Robot vacuum learns to sulk when ignored"]) {
    assert.equal(isLightHeadline(t, screenText), true, t);
  }
});

test("a failing first feed falls back to the next one", async () => {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(url);
    if (url.includes("iltalehti")) return new Response("nope", { status: 503 });
    return new Response(rss("Yle Uutiset | Tuoreimmat", [["Mökkikausi venyy lokakuulle", "https://yle.fi/a/2"]]), { status: 200 });
  };
  try {
    const items = await fetchGroup({ mode: "fallback", feeds: ["https://www.iltalehti.fi/rss.xml", "https://yle.fi/rss/uutiset/tuoreimmat"] }, () => {});
    assert.equal(items.length, 1);
    assert.equal(items[0].source, "Yle Uutiset");
    assert.equal(asked.length, 2);
  } finally {
    globalThis.fetch = real;
  }
});
