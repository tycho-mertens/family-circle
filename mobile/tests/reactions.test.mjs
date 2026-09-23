import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";

const { validReaction, doubleTapReaction, recordEmojiUsage, quickReactions, reactionLabel } =
  await loadTypeScriptModule("src/reactions.ts");
test("double tap removes only a red heart and replaces other reactions with a heart", () => {
  assert.equal(doubleTapReaction("❤️"), null);
  for (const current of [undefined, "👍", "🔥", "💙", "😍"])
    assert.equal(doubleTapReaction(current), "❤️");
});
test("library accepts compound, flag and skin-tone emoji but rejects arbitrary text", () => {
  for (const emoji of ["🔥", "👍🏽", "👨‍👩‍👧‍👦", "🇵🇱", "🫠", null])
    assert.equal(validReaction(emoji), true);
  for (const emoji of ["", "abc", "❤️❤️", "https://x.test", {}, "a".repeat(100000)])
    assert.equal(validReaction(emoji), false);
  assert.equal(reactionLabel("🔥"), "fire");
});
test("hotbar combines recent and frequent choices, fills defaults and never duplicates", () => {
  let history = [];
  for (let n = 0; n < 10; n++) history = recordEmojiUsage(history, "🔥", n);
  history = recordEmojiUsage(history, "🐱", 11);
  history = recordEmojiUsage(history, "🚀", 12);
  history = recordEmojiUsage(history, "🫠", 13);
  const bar = Array.from(quickReactions(history), (item) => item.emoji);
  assert.deepEqual(bar.slice(0, 3), ["🫠", "🚀", "🔥"]);
  assert.equal(bar.length, 5);
  assert.equal(new Set(bar).size, 5);
  history = recordEmojiUsage(history, "🔥", 14);
  assert.equal(history[0].count, 11);
  assert.equal(quickReactions(history)[0].emoji, "🔥");
  assert.equal(quickReactions([]).length, 5);
});
