import type { CircleNotifications } from "./backup";

export const defaultNotifications: CircleNotifications = {
  chat: true,
  location: true,
  quietHours: false,
  quietStart: "22:00",
  quietEnd: "08:00",
};

/** Device-local time; the interval includes its start and excludes its end. */
export function notificationAllowed(
  preferences: CircleNotifications | undefined,
  category: "chat" | "location" | "system",
  now = new Date(),
): boolean {
  const settings = { ...defaultNotifications, ...preferences };
  if (category !== "system" && !settings[category]) return false;
  if (!settings.quietHours) return true;
  const minutes = (time: string) => {
    const [hour, minute] = time.split(":").map(Number);
    return hour * 60 + minute;
  };
  const start = minutes(settings.quietStart),
    end = minutes(settings.quietEnd),
    current = now.getHours() * 60 + now.getMinutes();
  const quiet = start < end ? current >= start && current < end : current >= start || current < end;
  return !quiet;
}

export function deliveryLabel(item: {
  delivery?: "waiting" | "sent" | "delivered";
  deliveredTo?: string[];
  recipients?: string[];
}): string | undefined {
  if (item.delivery === "waiting") return "Waiting for connection";
  if (item.delivery === "sent") return "Sent";
  if (item.delivery === "delivered")
    return item.recipients && item.recipients.length > 1
      ? `Delivered to ${item.deliveredTo?.length ?? 0}/${item.recipients.length}`
      : "Delivered";
  return undefined;
}
