// Content moderation for anything visitors put into the feed (bots they create, topics they
// drop) and a safety net on what the bots post. Two layers:
//
// Scope: only racism and homophobia/transphobia are moderated. Edgy, crude, dark and rude
// content is allowed on purpose.
//
//  1. screenText(): fast keyword rules, always on (server and browser demo). On top of the slur
//     filter, it refuses bots and topics about race, ethnicity, religion, nationality, migration
//     or sexuality, plus hate-movement terms. Broad on purpose, since racist content rarely
//     needs a slur.
//  2. AI review (server with an API key, see llm.js): catches racist or homophobic bots and
//     topics phrased without any of these words.

import { censor } from "./censor.js";

// Terms for groups of people and hate movements, matched as whole words. Stored base64-encoded
// so the source doesn't display them; decode in a terminal: node -e 'console.log(atob("..."))'.
// Overblocking is accepted: harmless mentions get refused too, the price of keeping racism out.
const decodeList = (b64) => JSON.parse(atob(b64));
const GROUP_TERMS = decodeList("WyJyYWNlIiwicmFjZXMiLCJyYWNpYWwiLCJyYWNpc3QiLCJyYWNpc3RzIiwicmFjaXNtIiwiZXRobmljIiwiZXRobmljaXR5IiwiZXRobmljaXRpZXMiLCJibGFjayBwZW9wbGUiLCJibGFjayBwZXJzb24iLCJibGFjayBtZW4iLCJibGFjayB3b21lbiIsImJsYWNrIGd1eXMiLCJibGFja3MiLCJ3aGl0ZSBwZW9wbGUiLCJ3aGl0ZSBwZXJzb24iLCJ3aGl0ZSBtZW4iLCJ3aGl0ZSB3b21lbiIsIndoaXRlIGd1eXMiLCJ3aGl0ZXMiLCJicm93biBwZW9wbGUiLCJhc2lhbiIsImFzaWFucyIsImFmcmljYW4iLCJhZnJpY2FucyIsImFyYWIiLCJhcmFicyIsIm1leGljYW4iLCJtZXhpY2FucyIsImxhdGlubyIsImxhdGlub3MiLCJsYXRpbmEiLCJsYXRpbmFzIiwiaGlzcGFuaWMiLCJoaXNwYW5pY3MiLCJjaGluZXNlIiwiaW5kaWFuIiwiaW5kaWFucyIsInBha2lzdGFuaSIsInBha2lzdGFuaXMiLCJzb21hbGkiLCJzb21hbGlzIiwiZ3lwc3kiLCJneXBzaWVzIiwicm9tYSIsImFib3JpZ2luYWwiLCJhYm9yaWdpbmFscyIsIm5hdGl2ZSBhbWVyaWNhbnMiLCJjYXVjYXNpYW4iLCJjYXVjYXNpYW5zIiwibWlub3JpdGllcyIsIm1pbm9yaXR5IiwiamV3IiwiamV3cyIsImpld2lzaCIsImp1ZGFpc20iLCJtdXNsaW0iLCJtdXNsaW1zIiwiaXNsYW0iLCJpc2xhbWljIiwiY2hyaXN0aWFuIiwiY2hyaXN0aWFucyIsImNocmlzdGlhbml0eSIsImhpbmR1IiwiaGluZHVzIiwic2lraCIsInNpa2hzIiwiYnVkZGhpc3QiLCJidWRkaGlzdHMiLCJhdGhlaXN0IiwiYXRoZWlzdHMiLCJpbW1pZ3JhbnQiLCJpbW1pZ3JhbnRzIiwiaW1taWdyYXRpb24iLCJtaWdyYW50IiwibWlncmFudHMiLCJyZWZ1Z2VlIiwicmVmdWdlZXMiLCJmb3JlaWduZXIiLCJmb3JlaWduZXJzIiwiaWxsZWdhbHMiLCJuYXRpb25hbGl0eSIsIm5hdGlvbmFsaXRpZXMiLCJnYXkiLCJnYXlzIiwibGVzYmlhbiIsImxlc2JpYW5zIiwiaG9tb3NleHVhbCIsImhvbW9zZXh1YWxzIiwidHJhbnMiLCJ0cmFuc2dlbmRlciIsInRyYW5zZ2VuZGVycyIsInF1ZWVyIiwibGdidCIsImxnYnRxIiwiYmlzZXh1YWwiLCJub25iaW5hcnkiLCJub24tYmluYXJ5IiwibmF6aSIsIm5hemlzIiwibmF6aXNtIiwiaGl0bGVyIiwia2trIiwia2xhbiIsImdlbm9jaWRlIiwiaG9sb2NhdXN0Iiwic2xhdmVyeSIsInN1cHJlbWFjeSIsInN1cHJlbWFjaXN0Iiwic3VwcmVtYWNpc3RzIiwibWFzdGVyIHJhY2UiLCJ3aGl0ZSBwb3dlciIsImdyZWF0IHJlcGxhY2VtZW50IiwiZXRobmljIGNsZWFuc2luZyIsIjE0ODgiLCIxNC84OCIsImhlaWwiLCJzaWVnIl0=");

const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[\\s_\\-.]+");
const GROUP_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${GROUP_TERMS.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "iu");

// common l33t substitutions (numbers and symbols standing in for letters)
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s" };
const deLeet = (text) => text.replace(/[0134578@$]/g, (c, i, s) => {
  // leave real numbers alone (some listed terms are numbers)
  const prev = s[i - 1] || " ";
  const next = s[i + 1] || " ";
  return /[a-z]/i.test(prev) || /[a-z]/i.test(next) ? LEET[c] || c : c;
});

// everyday phrases that contain a listed word but aren't about people
const HARMLESS = /\b(?:rat|arms|horse|drag|space|car|foot|relay|boat|bike|bicycle|running|sack|egg[\s-]and[\s-]spoon)[\s-]+races?\b|\braces?[\s-]+(?:cars?|tracks?|day|horses?)\b|\brace\s+against\s+(?:time|the\s+clock)\b|\brace\s+(?:you|ya|u)\b|\b(?:grammar|soup|spelling)[\s-]+nazis?\b/giu;

export const REFUSAL =
  "No racism or homophobia on BanterGPT. Bots and topics can't be about race, ethnicity, religion, nationality or sexuality. Anything else goes.";

// Returns null if the text is fine, or a short reason if it should be refused.
// hate symbols (swastikas and the double sig rune), blocked wherever they appear
const HATE_SYMBOLS = /[\u5350\u534D\u0FD5-\u0FD8]|\u16CB\s*\u16CB|\u03DF\s*\u03DF/u;

export function screenText(...texts) {
  for (const raw of texts.flat()) {
    if (typeof raw !== "string" || !raw) continue;
    if (censor(raw) !== raw) return "slur";
    if (HATE_SYMBOLS.test(raw)) return "group";
    const plain = raw.normalize("NFKC").replace(HARMLESS, " ");
    const t = deLeet(plain);
    if (GROUP_RE.test(t) || GROUP_RE.test(plain)) return "group";
  }
  return null;
}

// convenience for bots: every user-written field of a persona
export function personaTexts(p) {
  return [p.name, p.handle, p.avatar, p.bio, p.voice, ...(p.beliefs || [])];
}
