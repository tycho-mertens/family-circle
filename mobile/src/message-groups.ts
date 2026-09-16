import type { SavedChatItem } from "./backup";

export interface MessageGroupDisplay {
  startsGroup: boolean;
  endsGroup: boolean;
  status?: string;
}
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
export function continuesMessageGroup(
  previous: SavedChatItem | undefined,
  current: SavedChatItem,
): boolean {
  return (
    !!previous &&
    previous.kind === "chat" &&
    current.kind === "chat" &&
    !!current.senderId &&
    previous.circleId === current.circleId &&
    previous.senderId === current.senderId &&
    current.at >= previous.at &&
    current.at - previous.at < 60_000 &&
    sameDay(previous.at, current.at)
  );
}

// A later receipt must not hide an earlier message that is still queued or
// undelivered. Count people who received every message addressed to them.
export function groupDeliveryStatus(items: SavedChatItem[]): string | undefined {
  if (!items.length) return undefined;
  if (items.some((item) => item.delivery === "waiting")) return "Waiting for connection";
  if (items.some((item) => !item.delivery)) return undefined;
  if (items.some((item) => item.delivery === "sent")) return "Sent";
  const recipients = [...new Set(items.flatMap((item) => item.recipients ?? []))];
  const delivered = recipients.filter((id) =>
    items.every((item) => !item.recipients?.includes(id) || item.deliveredTo?.includes(id)),
  );
  if (recipients.length > 1) return `Delivered to ${delivered.length}/${recipients.length}`;
  return recipients.length && !delivered.length ? "Sent" : "Delivered";
}

export function messageGroupDisplay(items: SavedChatItem[]): MessageGroupDisplay[] {
  const result: MessageGroupDisplay[] = items.map(() => ({ startsGroup: true, endsGroup: true }));
  // Receipt grouping is independent of the one-minute avatar/bubble grouping.
  // Only complete deliveries can share a footer; pending/partial sends stay visible.
  const complete = (item: SavedChatItem) =>
    item.kind === "chat" &&
    item.delivery === "delivered" &&
    (item.recipients ?? []).every((id) => item.deliveredTo?.includes(id));
  let receiptStart = 0;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item.kind !== "chat") {
      receiptStart = index + 1;
      continue;
    }
    const previous = items[index - 1],
      next = items[index + 1];
    const sameSender = (other: SavedChatItem | undefined) =>
      !!other &&
      other.kind === "chat" &&
      !!item.senderId &&
      other.senderId === item.senderId &&
      other.circleId === item.circleId;
    if (!complete(item) || !sameSender(previous) || !complete(previous)) receiptStart = index;
    const continuesReceipts = complete(item) && sameSender(next) && complete(next);
    result[index] = {
      startsGroup: !continuesMessageGroup(previous, item),
      endsGroup: !next || !continuesMessageGroup(item, next),
      ...(!continuesReceipts
        ? { status: groupDeliveryStatus(items.slice(receiptStart, index + 1)) }
        : {}),
    };
  }
  return result;
}
