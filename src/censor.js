// Slur filter: every post (AI-written, template, or audience topic) passes through here
// before it reaches the feed. Built on the open-source `obscenity` library, which catches
// common evasions (l33t speak, spacing, repeated letters).
//
// Policy: racist and homophobic/transphobic slurs are censored. Swearing, crude and sexual
// language are allowed, because the bots are meant to be edgy.
//
// Works on the server (from node_modules) and in the browser demo (via the import map in
// index.html). If the library can't load, posts pass through unfiltered and a warning is logged.

let censorText = (text) => text;
let ready = false;

// The word lists below are stored base64-encoded so the source doesn't display slurs.
// Decode one in a terminal to review it: node -e 'console.log(atob("..."))'
const decodeList = (b64) => JSON.parse(atob(b64));

// Which of the library's words are censored: only racist and homophobic/transphobic slurs.
// Everything else in its dataset (swearing, crude and sexual words) is allowed.
const KEEP = new Set(decodeList("WyJhYmVlZCIsImFibyIsImFmcmljb29uIiwiYXJhYnVzaCIsImJvb25nYSIsImNoaW5nY2hvbmciLCJjaGluayIsImtpa2UiLCJuZWdybyIsIm5pZ2dlciIsImR5a2UiLCJmYWciLCJ0cmFubnkiXQ=="));

// Extra racist and homophobic slurs missing from the library's dataset.
// `|` marks a word edge: both edges where the letters also appear inside innocent words
// ("spice", "raccoon", "Pakistan"), a leading edge only where plurals/suffixes should match too.
const EXTRA_SLURS = decodeList("WyJ8YmVhbmVyIiwifGNvb258IiwifGNvb25zfCIsInxnb29rfCIsInxnb29rc3wiLCJ8Z3lwcG8iLCJ8amlnYWJvbyIsInxreWtlIiwifHBha2l8IiwifHBha2lzfCIsInxyYWdoZWFkIiwifHNhbWJvfCIsInxzYW1ib3N8IiwifHNwaWN8IiwifHNwaWNzfCIsInx0b3dlbGhlYWQiLCJ8d2V0YmFjayIsInx6aXBwZXJoZWFkIiwifGJhdHR5Ym95IiwifGJhdHR5IGJveSIsInxob21vfCIsInxob21vc3wiLCJ8bGV6emVyIiwifHBvb2Z8IiwifHBvb2ZzfCIsInxwb29mdGVyIiwifHNoZW1hbGUiLCJ8dHJhbm5pZSJd");

// single letters separated by spaces or punctuation, e.g. "s l u r" or "s.l.u.r"
const SPACED_RUN = /(?<![\p{L}\p{N}])(?:[\p{L}\p{N}@$!][\s.\-_*]+){2,}[\p{L}\p{N}@$!](?![\p{L}\p{N}])/gu;

try {
  const o = await import("obscenity");

  // 1. the library's racist and homophobic slurs, with its full evasion handling
  const dataset = new o.DataSet()
    .addAll(o.englishDataset)
    .removePhrasesIf((phrase) => !KEEP.has(phrase.metadata?.originalWord));
  const main = new o.RegExpMatcher({ ...dataset.build(), ...o.englishRecommendedTransformers });

  // 2. extra slurs: decode l33t/look-alikes/repeats, but keep spaces so word edges still work
  const extraSet = new o.DataSet();
  for (const pat of EXTRA_SLURS) extraSet.addPhrase((p) => p.addPattern(o.parseRawPattern(pat)));
  const extra = new o.RegExpMatcher({
    ...extraSet.build(),
    blacklistMatcherTransformers: [
      o.resolveConfusablesTransformer(),
      o.resolveLeetSpeakTransformer(),
      o.toAsciiLowerCaseTransformer(),
      o.collapseDuplicatesTransformer({ defaultThreshold: 2 }), // squash stretched letters, keep real double letters
    ],
  });

  const textCensor = new o.TextCensor().setStrategy(o.asteriskCensorStrategy());
  const censorWords = (text) => {
    // trailing punctuation ("slur!") would otherwise be read as l33t ("!" = i); blank it out,
    // keeping the length identical so match positions still line up with the original text
    const forExtra = text.replace(/[!?.,;:'")\]]+(?=\s|$)/g, (m) => " ".repeat(m.length));
    const matches = [...main.getAllMatches(text), ...extra.getAllMatches(forExtra)];
    return matches.length ? textCensor.applyTo(text, matches) : text;
  };
  const isBad = (text) => main.hasMatch(text) || extra.hasMatch(` ${text} `);

  censorText = (text) => {
    // rejoin spaced-out letters and blank the whole run if it spells something blocked
    const despaced = text.replace(SPACED_RUN, (run) =>
      isBad(run.replace(/[\s.\-_*]+/g, "")) ? run.replace(/[^\s]/g, "*") : run,
    );
    return censorWords(despaced);
  };
  ready = true;
} catch (err) {
  console.warn(`[censor] slur filter unavailable (${err.message}). Run \`npm install\`. Posts are NOT being filtered.`);
}

export function censor(text) {
  return typeof text === "string" ? censorText(text) : text;
}

export const censorReady = () => ready;
