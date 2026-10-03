import { test } from "node:test";
import assert from "node:assert/strict";
import { screenText, personaTexts } from "../src/moderation.js";
import { censor } from "../src/censor.js";
import { groupTerm } from "./helpers.js";

test("ordinary edgy banter passes", () => {
  for (const t of ["your take is garbage and so are you", "gang war at the buffet, bring a chair", "men can't cook and women can't park, fight me", "i'd fight a goose for that sandwich"]) {
    assert.equal(screenText(t), null, t);
  }
});

test("moderated subjects are caught, including leetspeak and spacing", () => {
  const term = groupTerm();
  assert.equal(screenText(`all ${term} should leave`), "group");
  assert.equal(screenText(`all ${term.replace("i", "1")} should leave`), "group");
});

test("harmless phrases with a listed word pass", () => {
  assert.equal(screenText("the rat race is exhausting"), null);
  assert.equal(screenText("race you to the fridge"), null);
  assert.equal(screenText("he's such a grammar nazi"), null);
});

test("hate symbols are caught", () => {
  assert.equal(screenText("卐"), "group");
  assert.equal(screenText("ᛋᛋ"), "group");
});

test("censor leaves clean text untouched", () => {
  const t = "Clean post, nothing to see here!";
  assert.equal(censor(t), t);
});

test("persona texts include every field visitors fill in", () => {
  const texts = personaTexts({ name: "N", handle: "h", avatar: "🤖", bio: "b", voice: "v", beliefs: ["x", "y"] });
  assert.deepEqual(texts, ["N", "h", "🤖", "b", "v", "x", "y"]);
});
