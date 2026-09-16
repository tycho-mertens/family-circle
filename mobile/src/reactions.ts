import { EMOJI_CATALOG } from "./emoji-catalog";
export const REACTIONS = [
  { emoji: "❤️", label: "Heart" },
  { emoji: "👍", label: "Thumbs up" },
  { emoji: "😂", label: "Laugh" },
  { emoji: "🎉", label: "Celebrate" },
  { emoji: "😮", label: "Wow" },
  { emoji: "😢", label: "Sad" },
] as const;
const emojiLabels = new Map(EMOJI_CATALOG.map((item) => [item.emoji, item.label]));
for (const item of REACTIONS) emojiLabels.set(item.emoji, item.label);
export const reactionLabel = (emoji: string) => emojiLabels.get(emoji) ?? emoji;
export const doubleTapReaction = (current?: string): string | null =>
  current === "❤️" ? null : "❤️";
export function validReaction(emoji: unknown): emoji is string | null {
  return emoji === null || (typeof emoji === "string" && emojiLabels.has(emoji));
}

export interface EmojiUsage {
  emoji: string;
  count: number;
  lastUsed: number;
}
export function recordEmojiUsage(
  history: EmojiUsage[],
  emoji: string,
  now = Date.now(),
): EmojiUsage[] {
  if (!emoji || !validReaction(emoji)) return history;
  const old = history.find((item) => item.emoji === emoji);
  return [
    { emoji, count: Math.min((old?.count ?? 0) + 1, 1000000), lastUsed: now },
    ...history.filter((item) => item.emoji !== emoji),
  ].slice(0, 48);
}
export function quickReactions(history: EmojiUsage[]): { emoji: string; label: string }[] {
  const recent = [...history].sort((a, b) => b.lastUsed - a.lastUsed);
  const frequent = [...history].sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed);
  return [
    ...new Set([
      ...recent.slice(0, 2).map((item) => item.emoji),
      ...frequent.map((item) => item.emoji),
      ...REACTIONS.map((item) => item.emoji),
    ]),
  ]
    .filter((emoji) => validReaction(emoji))
    .slice(0, 5)
    .map((emoji) => ({ emoji, label: reactionLabel(emoji) }));
}
