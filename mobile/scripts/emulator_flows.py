"""UI flows that need fresh identities or a newly created test Circle."""

import re
import time

from emulator_ui import by_id, labels, on_each_phone


def check_setup(first, second):
    # Check both before creating anything. This flow never clears app data.
    for phone in (first, second):
        phone.launch()
        phone.wait_for("Skip intro")
    def finish_setup(phone):
        index = 1 if phone is first else 2
        if index == 1:
            phone.click("Continue")
            phone.click("Continue")
            phone.click("Let's get started")
        else:
            phone.click("Skip intro")
        phone.click("Create my identity")
        phone.wait_for("Your way back in.", timeout=90)
        button = phone.locate("I've saved it — continue")
        if button.get("enabled") != "false":
            raise AssertionError("Recovery acknowledgement did not guard Continue")
        phone.click("Download as a text file")
        phone.locate("Saved in your phone's Downloads folder.")
        phone.click("I've saved my recovery phrase somewhere safe")
        phone.click("I've saved it — continue")
        phone.wait_for("What should we call you?")
        if phone.wait_for("Continue").get("enabled") != "false":
            raise AssertionError("Empty nickname unexpectedly enabled Continue")
        phone.fill("Your nickname", f"Smoke{index}")
        phone.click("Continue")
        phone.click("Maybe later")
        phone.wait_for(f"Hi, Smoke{index}")
        phone.launch()
        phone.wait_for(f"Hi, Smoke{index}")
        print(f"PASS: {phone.serial} completed setup and retained its identity after restart", flush=True)

    on_each_phone((first, second), finish_setup)


def home_name(phone):
    greeting = phone.wait_until("home greeting was not found", lambda nodes: next(
        (n.get("text") for n in nodes if (n.get("text") or "").startswith("Hi, ")), None))
    return greeting.removeprefix("Hi, ")


def open_creation(phone):
    current = labels(phone.nodes())
    if "New Circle" not in current:
        phone.click("Add")
    phone.click("New Circle")


def open_join(phone):
    current = labels(phone.nodes())
    if "Join a Circle" in current:
        phone.click("Join a Circle")
    else:
        phone.click("Add")
        phone.click("Join with an invite")


def check_create_join(first, second, circle):
    owner = home_name(first)
    home_name(second)
    open_creation(first)
    if first.wait_for("Create Circle").get("enabled") != "false":
        raise AssertionError("An empty Circle name enabled creation")
    first.fill("Circle name", circle)
    first.click("Create Circle")
    first.click("Show invite code", stable=True)
    invite = first.wait_for("Invite code").get("text")
    if not invite or not re.fullmatch(r"[A-Za-z0-9.-]+", invite):
        raise AssertionError("The new Circle did not expose an invite code")
    open_join(second)
    if second.wait_for("Join Circle").get("enabled") != "false":
        raise AssertionError("An empty invite code enabled joining")
    second.fill("Invite code", invite)
    second.click("Join Circle")
    second.wait_for("2 members · End-to-end encrypted", timeout=90)
    second.wait_for(circle)
    # Admission must consume the administrator's one-time invitation.
    first.wait_for("This invitation has been used. Make a new one for the next person.",
                   timeout=90, scroll=True)
    for phone in (first, second):
        phone.open_circle(circle)
        phone.wait_for("2 members · End-to-end encrypted")
    print("PASS: created a Circle, joined by invite, consumed the invite, and restored membership", flush=True)
    return owner


def open_map(phone, circle, restart=False):
    if restart:
        phone.open_circle(circle)
    phone.click("Circle map")
    phone.wait_for("Show everyone")


def wait_private(phone):
    phone.wait_labels("Your location is private", "People · 0 sharing")


def allow_location_setup(phone):
    phone.click("Location settings")
    current = labels(phone.nodes())
    if not ({"Ready when you are", "Done"} & current):
        phone.click("Set up location")
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            nodes = phone.nodes()
            if {"Ready when you are", "Done"} & labels(nodes):
                break
            permission = next((n for n in nodes if
                (n.get("resource-id") or "").endswith((
                    "/permission_allow_foreground_only_button", "/permission_allow_button"))), None)
            if permission is not None:
                phone.tap_node(permission)
            time.sleep(1)
        else:
            raise AssertionError("Android location/notification permissions did not complete")
    phone.click("Done")
    wait_private(phone)
    print("PASS: granting location permission alone did not start sharing", flush=True)


def begin_share(phone, battery=True, minutes=None):
    phone.click("Share location")
    if minutes is None:
        phone.click("1 hour")
    phone.click("More options")
    # This controls update frequency; the expiry scenario sets duration separately.
    phone.click("1 min")
    switch = phone.locate("Include battery percentage")
    if (switch.get("checked") == "true") != battery:
        phone.tap_node(switch)
    if minutes is not None:
        phone.click("Custom")
        phone.fill("Duration in minutes", "0")
        if phone.wait_for("Start sharing").get("enabled") != "false":
            raise AssertionError("A zero custom duration enabled sharing")
        phone.fill("Duration in minutes", str(minutes))
    phone.click("Start sharing")
    phone.wait_for("You're sharing")
    # Feed a synthetic Warsaw fix through the emulator GPS, not app internals.
    phone.adb("emu", "geo", "fix", "21.0122", "52.2297", "100", "8")


def pin_details(phone, owner, battery):
    phone.tap_node(phone.wait_for(f"Find {owner}", timeout=90))
    phone.wait_for("Close pin details")
    def matches(nodes):
        details = [n.get("text", "") for n in by_id(nodes, "location-pin-metadata")]
        return any("±" in text and ("Battery" in text) == battery for text in details)
    phone.wait_until("pin accuracy or battery visibility did not match consent", matches)
    phone.click("Close pin details")


def check_location_sharing(first, second, circle, owner, map_gestures=False):
    for phone in (first, second):
        open_map(phone, circle)
        wait_private(phone)
    allow_location_setup(first)
    begin_share(first)
    pin_details(second, owner, battery=True)
    second.wait_labels("Your location is private", "People · 1 sharing")
    print("PASS: a shared GPS fix reached the other phone without sharing its location", flush=True)

    if map_gestures:
        second.check_map(already_open=True)
        open_map(second, circle)

    # Changing battery consent should update the existing session's payload.
    first.click("Sharing settings")
    first.click("More options")
    switch = first.locate("Include battery percentage")
    if switch.get("checked") != "true":
        raise AssertionError("Battery sharing was not enabled")
    first.tap_node(switch)
    first.click("Save sharing settings")
    pin_details(second, owner, battery=False)
    print("PASS: disabling battery sharing removed it from the remote pin", flush=True)

    # Reopen after force-stop: consent survives, and the pin is still available.
    open_map(first, circle, restart=True)
    first.wait_for("You're sharing")
    pin_details(second, owner, battery=False)
    first.click("Stop")
    wait_private(first)
    wait_private(second)
    open_map(first, circle, restart=True)
    wait_private(first)
    print("PASS: sharing consent survived reopen; stopping removed the pin and stayed stopped", flush=True)

    begin_share(first, battery=False, minutes=1)
    pin_details(second, owner, battery=False)
    first.wait_for("Your location is private", timeout=100)
    wait_private(first)
    wait_private(second)
    print("PASS: custom-duration validation and automatic expiry removed the shared pin", flush=True)
    for phone in (first, second):
        phone.click("Circle chat")
        phone.wait_for("Message")


def stop_sharing_after_failure(phone, circle):
    # Diagnostics are already saved. A cleanup failure must not hide the assertion.
    open_map(phone, circle, restart=True)
    if "You're sharing" in labels(phone.nodes()):
        phone.click("Stop")
        phone.wait_for("Your location is private")
