#!/usr/bin/env python3
"""Exercise messaging or map interactions on Android test emulators.

The default mode adds messages to an existing test Circle on two emulators.
--offline-restart also temporarily disconnects one emulator and restarts its app,
restoring network settings in a finally block. --map-only uses one emulator and
checks navigation and gestures without sending messages or changing sharing consent.
--chat-actions checks replies, reactions, edits, deletion, and saved edit history.
--setup requires fresh app installs. --create-join creates a new test Circle;
--location-sharing uses that Circle to check location consent and pin delivery.
"""
import argparse
import re
import sys
import time
import uuid

from emulator_ui import AndroidPhone, PACKAGE, bounds, by_id, capture_failure, on_each_phone


class Phone(AndroidPhone):
    def message_menu(self, text):
        node = self.wait_for(text, scroll=True)
        x1, y1, x2, y2 = bounds(node)
        x, y = str((x1 + x2) // 2), str((y1 + y2) // 2)
        self.adb("shell", "input", "swipe", x, y, x, y, "700")
        self.wait_for("Close message menu")

    def message_row(self, nodes, message):
        rows = by_id(nodes, "chat-message-row")
        return next((row for row in rows if any(
            message in (n.get("text"), n.get("content-desc")) for n in row.iter())), None)

    def wait_reaction(self, message, present):
        def matches(nodes):
            row = self.message_row(nodes, message)
            if row is None:
                return False
            reactions = by_id(row.iter(), "chat-message-reactions")
            heart = any((n.get("content-desc") or "").startswith("Heart:") for n in reactions)
            return heart == present
        self.wait_until(f"heart reaction did not become {present} on {message!r}", matches)

    def reply_preview(self, original):
        def find(nodes):
            return next((node.get("content-desc") for node in nodes
                         if (node.get("content-desc") or "").startswith("Reply to ")
                         and (node.get("content-desc") or "").endswith(f": {original}")), None)
        return self.wait_until(f"reply preview did not reference {original!r}", find)

    def edit_message(self, original, replacement):
        self.message_menu(original)
        self.tap("Edit")
        self.fill("Edit message text", replacement)
        self.tap("Save edit")
        self.wait_for(replacement, scroll=True)

    def check_original(self, edited, original):
        self.message_menu(edited)
        self.tap("View original")
        self.wait_labels("Original message", original)
        self.tap("Close")

    def check_deleted_reply(self, reply, deleted):
        self.wait_for(reply, scroll=True)
        def matches(nodes):
            row = self.message_row(nodes, reply)
            if row is None:
                return False
            previews = by_id(row.iter(), "chat-reply-preview")
            return any(n.get("content-desc") == "Message deleted" for n in previews) and not any(
                deleted in (n.get("text"), n.get("content-desc")) for n in nodes)
        self.wait_until("deleted message or its reply preview did not update", matches)

    def launch(self):
        # Target the foreground Android user, including isolated setup profiles.
        self.adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
        self.adb("shell", "wm", "dismiss-keyguard")
        self.adb("shell", "am", "force-stop", "--user", "current", PACKAGE)
        result = self.adb("shell", "am", "start", "-W", "--user", "current",
                          "-n", f"{PACKAGE}/.MainActivity")
        if "Error:" in result:
            raise AssertionError(f"{self.serial}: Android could not launch the app")

    def open_circle(self, name):
        # Start from the home screen, regardless of where the last check ended.
        self.launch()
        self.tap(f"Open {name}")
        self.wait_for("Message")
        self.scroll_chat()

    def send(self, text):
        self.tap("Message")
        self.adb("shell", "input", "text", text.replace(" ", "%s"))
        self.tap("Send message")
        self.adb("shell", "input", "keyevent", "4")
        self.wait_for(text)

    def check_map(self, already_open=False):
        if not already_open:
            self.tap("Circle map")
        self.wait_for("Show everyone")
        self.tap("Show everyone")

        # adb uses physical pixels; React Native gesture thresholds use dp.
        densities = re.findall(r"density:\s*(\d+)", self.adb("shell", "wm", "density"))
        # When an override is set, wm lists it after the physical density.
        pixels_per_dp = int(densities[-1]) / 160
        for label, distance_dp, next_label in (
            ("Drag down to hide the people list", 260, "Drag up to show the people list"),
            ("Drag up to show the people list", -260, "Drag down to hide the people list"),
        ):
            handle = self.wait_for(label)
            x1, y1, x2, y2 = bounds(handle)
            x, y = (x1 + x2) // 2, (y1 + y2) // 2
            distance = round(distance_dp * pixels_per_dp)
            self.adb("shell", "input", "swipe", str(x), str(y), str(x), str(y + distance), "400")
            self.wait_for(next_label)
        print("PASS: native map panel collapses and expands", flush=True)

        # Use a location that's already shared; this check doesn't start sharing.
        people = [node.get("content-desc") for node in self.nodes()
                  if (node.get("content-desc") or "").startswith("Find ")]
        if people:
            self.tap(people[0])
            self.wait_for("Close pin details")
            self.tap("Close pin details")
            print("PASS: member selection opens and closes pin details", flush=True)
        else:
            print("SKIP: member selection requires an existing shared location", flush=True)
        self.tap("Circle chat")
        self.wait_for("Message")


def check_chat_actions(first, second, circle, stamp):
    original = f"Smoke {stamp} editable"
    edited = f"Smoke {stamp} revised"
    final = f"Smoke {stamp} final"
    reply = f"Smoke {stamp} reply"
    first.send(original)
    second.wait_for(original, scroll=True)

    second.message_menu(original)
    labels = {node.get("content-desc") for node in second.nodes()}
    if labels & {"Edit", "Delete for everyone"}:
        raise AssertionError("Another member's message exposes edit or delete")
    second.tap("Close message menu")
    print("PASS: another member's message has no edit or delete action", flush=True)

    second.message_menu(original)
    second.tap("Heart")
    second.wait_reaction(original, True)
    first.wait_reaction(original, True)
    second.message_menu(original)
    second.tap("Heart")
    second.wait_reaction(original, False)
    first.wait_reaction(original, False)
    print("PASS: adding and removing a reaction synchronizes", flush=True)

    second.message_menu(original)
    second.tap("Reply")
    second.send(reply)
    first.wait_for(reply, scroll=True)
    for phone in (first, second):
        preview = phone.reply_preview(original)
        phone.tap(preview)
        phone.wait_for(original)
    print("PASS: replies reference the original message on both phones", flush=True)

    first.edit_message(original, edited)
    second.wait_for(edited, scroll=True)
    second.reply_preview(edited)
    first.edit_message(edited, final)
    second.wait_for(final, scroll=True)
    second.reply_preview(final)
    def check_edit_persistence(phone):
        phone.check_original(final, original)
        phone.open_circle(circle)
        phone.wait_for(final, scroll=True)
        phone.check_original(final, original)
    on_each_phone((first, second), check_edit_persistence)
    print("PASS: repeated edits synchronize and preserve the original through restart", flush=True)

    first.message_menu(final)
    first.tap("Delete for everyone")
    first.wait_for("Delete for everyone?")
    first.tap("DELETE")
    def check_deletion_persistence(phone):
        phone.check_deleted_reply(reply, final)
        phone.open_circle(circle)
        phone.check_deleted_reply(reply, final)
    on_each_phone((first, second), check_deletion_persistence)
    print("PASS: deletion updates both reply previews and survives restart", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--circle", help="Existing test Circle visible on both home screens")
    parser.add_argument("--first", default="emulator-5554")
    parser.add_argument("--second", default="emulator-5556")
    parser.add_argument("--offline-restart", action="store_true")
    parser.add_argument("--chat-actions", action="store_true",
                        help="Check replies, reactions, edits, and deletion on new test messages")
    parser.add_argument("--setup", action="store_true",
                        help="Create identities on two fresh installs; requires --create-join")
    parser.add_argument("--create-join", action="store_true",
                        help="Create and join a uniquely named Circle instead of using --circle")
    parser.add_argument("--location-sharing", action="store_true",
                        help="Share emulator GPS fixes and test consent; requires --create-join")
    parser.add_argument("--map-gestures", action="store_true",
                        help="Also check map panel gestures during the location-sharing flow")
    parser.add_argument("--map-only", action="store_true",
                        help="Check map navigation and gestures on --first without sending messages")
    args = parser.parse_args()

    if args.map_gestures and not args.location_sharing:
        parser.error("--map-gestures requires --location-sharing")
    if (args.setup or args.location_sharing) and not args.create_join:
        parser.error("--setup and --location-sharing require --create-join")
    if args.create_join and (args.circle or args.map_only):
        parser.error("--create-join cannot be combined with --circle or --map-only")
    if not args.create_join and not args.circle:
        parser.error("Choose --circle or --create-join")

    if args.map_only and (args.offline_restart or args.chat_actions):
        parser.error("--map-only cannot be combined with --offline-restart or --chat-actions")
    if args.first == args.second and not args.map_only:
        parser.error("Choose two different emulators")
    phones = [Phone(args.first)] if args.map_only else [Phone(args.first), Phone(args.second)]
    try:
        run_checks(args, phones)
    except Exception as error:
        capture_failure(phones, error)
        if args.location_sharing and args.circle:
            try:
                from emulator_flows import stop_sharing_after_failure
                stop_sharing_after_failure(phones[0], args.circle)
            except Exception as cleanup_error:
                print(f"Could not stop sharing during cleanup: {cleanup_error}", file=sys.stderr)
        raise


def run_checks(args, phones):
    if args.map_only:
        phone = phones[0]
        phone.open_circle(args.circle)
        phone.check_map()
        return
    first, second = phones
    if args.create_join:
        from emulator_flows import check_setup, check_create_join, check_location_sharing
        if args.setup:
            check_setup(first, second)
        else:
            on_each_phone(phones, lambda phone: phone.launch())
        args.circle = f"Smoke Circle {uuid.uuid4().hex[:8]}"
        owner = check_create_join(first, second, args.circle)
        print(f"Test Circle: {args.circle}", flush=True)
    else:
        for phone in (first, second):
            phone.open_circle(args.circle)

    # Give this run distinct messages so old chat history won't satisfy the checks.
    stamp = uuid.uuid4().hex[:12]
    outgoing = f"Smoke {stamp} from first"
    first.send(outgoing)
    second.wait_for(outgoing, scroll=True)
    print("PASS: first message arrived on second emulator", flush=True)

    reply = f"Smoke {stamp} from second"
    second.send(reply)
    first.wait_for(reply, scroll=True)
    print("PASS: return message arrived on first emulator", flush=True)
    if args.chat_actions:
        check_chat_actions(first, second, args.circle, stamp)
    if args.location_sharing:
        check_location_sharing(first, second, args.circle, owner, map_gestures=args.map_gestures)
    if not args.offline_restart:
        return

    # Remember both settings before disconnecting so a failed check can restore them.
    wifi = first.adb("shell", "settings", "get", "global", "wifi_on").strip() == "1"
    data = first.adb("shell", "settings", "get", "global", "mobile_data").strip() == "1"
    offline_message = f"Smoke {stamp} survives restart"
    try:
        first.adb("shell", "svc", "wifi", "disable")
        first.adb("shell", "svc", "data", "disable")
        time.sleep(3)
        first.send(offline_message)
        first.wait_for("Waiting for connection")

        # open_circle force-stops the app, so this checks the saved draft on disk.
        first.open_circle(args.circle)
        first.wait_for(offline_message, scroll=True)
        first.wait_for("Waiting for connection")
        print("PASS: offline draft survived force-stop and relaunch", flush=True)
    finally:
        first.adb("shell", "svc", "wifi", "enable" if wifi else "disable")
        first.adb("shell", "svc", "data", "enable" if data else "disable")

    second.wait_for(offline_message, scroll=True)
    print("PASS: restored draft arrived after reconnecting", flush=True)


if __name__ == "__main__":
    main()
