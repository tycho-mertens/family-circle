import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";

const { notificationAllowed, defaultNotifications, deliveryLabel } =
  await loadTypeScriptModule("src/notification-preferences.ts");
const at = (hour, minute = 0) => new Date(2026, 8, 9, hour, minute);
test("quiet hours span midnight and use inclusive start, exclusive end", () => {
  const settings = { ...defaultNotifications, quietHours: true };
  for (const category of ["chat", "location", "system"]) {
    assert.equal(notificationAllowed(settings, category, at(21, 59)), true);
    assert.equal(notificationAllowed(settings, category, at(22)), false);
    assert.equal(notificationAllowed(settings, category, at(0)), false);
    assert.equal(notificationAllowed(settings, category, at(7, 59)), false);
    assert.equal(notificationAllowed(settings, category, at(8)), true);
  }
});
test("daytime quiet hours and category mutes are independent", () => {
  const settings = {
    ...defaultNotifications,
    chat: false,
    quietHours: true,
    quietStart: "09:00",
    quietEnd: "17:00",
  };
  assert.equal(notificationAllowed(settings, "location", at(8)), true);
  assert.equal(notificationAllowed(settings, "chat", at(8)), false);
  assert.equal(notificationAllowed(settings, "location", at(9)), false);
  assert.equal(notificationAllowed(settings, "location", at(17)), true);
});
test("delivery labels never invent receipts for legacy messages", () => {
  assert.equal(deliveryLabel({}), undefined);
  assert.equal(deliveryLabel({ delivery: "waiting" }), "Waiting for connection");
  assert.equal(deliveryLabel({ delivery: "sent" }), "Sent");
  assert.equal(
    deliveryLabel({ delivery: "delivered", deliveredTo: ["a"], recipients: ["a", "b"] }),
    "Delivered to 1/2",
  );
});
