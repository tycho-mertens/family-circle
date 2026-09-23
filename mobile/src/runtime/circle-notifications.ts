import { notificationAllowed } from "../notification-preferences";
import {
  MAX_REACTION_NOTIFICATION_COOLDOWNS,
  REACTION_NOTIFICATION_COOLDOWN_MS,
} from "./circle-constants";
import type { CircleInfo } from "./circle-types";

interface Dependencies {
  getCircle: (id: string) => CircleInfo | undefined;
  getAppState: () => string;
  afterStateCommit: (effect: () => void) => void;
  showNotification: (title: string, body: string) => void;
  reportFailure: (operation: string, error: unknown) => void;
  now?: () => number;
}

export function createCircleNotifications({
  getCircle,
  getAppState,
  afterStateCommit,
  showNotification,
  reportFailure,
  now = Date.now,
}: Dependencies) {
  // Cooldowns are transient and bounded, even when every reaction targets a new message.
  const reactionNotificationCooldowns = new Map<string, number>();
  const notifyIfBackgrounded = (
    circleId: string,
    title: string,
    body: string,
    category: "chat" | "location" | "system" = "system",
  ) => {
    if (category !== "location" && getAppState() === "active") return;
    if (!notificationAllowed(getCircle(circleId)?.notifications, category)) return;
    afterStateCommit(() => {
      try {
        showNotification(title, body);
      } catch (error) {
        reportFailure("Notification delivery", error);
      }
    });
  };

  const shouldNotifyReaction = (
    circleId: string,
    messageId: string,
    reactorId: string,
  ) => {
    const time = now();
    const cooldowns = reactionNotificationCooldowns;
    for (const [key, at] of cooldowns) {
      if (time - at >= REACTION_NOTIFICATION_COOLDOWN_MS) cooldowns.delete(key);
    }
    const key = `${circleId}\u0000${messageId}\u0000${reactorId}`;
    const previous = cooldowns.get(key);
    if (previous !== undefined && time - previous < REACTION_NOTIFICATION_COOLDOWN_MS)
      return false;
    if (cooldowns.size >= MAX_REACTION_NOTIFICATION_COOLDOWNS)
      cooldowns.delete(cooldowns.keys().next().value!);
    cooldowns.set(key, time);
    return true;
  };

  return { notifyIfBackgrounded, shouldNotifyReaction };
}
