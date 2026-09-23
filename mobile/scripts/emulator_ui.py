"""ADB and accessibility helpers shared by the emulator smoke flows."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import re
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET

PACKAGE = "dev.familycircle.poc"
POLL_INTERVAL = 0.25


def labels(nodes):
    return {value for node in nodes for value in
            (node.get("text"), node.get("content-desc")) if value}


def bounds(node):
    values = re.findall(r"-?\d+", node.get("bounds", ""))
    if len(values) != 4:
        raise AssertionError(f"Control has invalid bounds: {node.attrib}")
    return tuple(map(int, values))


def find_node(nodes, label, class_name=None):
    matches = [node for node in nodes
               if label in (node.get("text"), node.get("content-desc"), node.get("resource-id"))
               and (class_name is None or node.get("class") == class_name)]
    return min(matches, key=lambda n: (n.get("clickable") != "true",
                                      n.get("content-desc") != label), default=None)


def by_id(nodes, test_id):
    # React Native versions expose either a bare testID or an Android resource ID.
    return [node for node in nodes if node.get("resource-id", "").split(":id/")[-1] == test_id]


class AndroidPhone:
    def __init__(self, serial):
        if not re.fullmatch(r"emulator-\d+", serial):
            raise ValueError("This smoke check only supports Android emulators")
        self.serial = serial
        self.last_xml = None

    def adb(self, *args):
        return subprocess.check_output(["adb", "-s", self.serial, *args], text=True, timeout=30)

    def nodes(self):
        # One round trip per snapshot; deleting first prevents reading an old dump.
        output = self.adb("shell", "rm -f /data/local/tmp/fc-smoke.xml; "
                          "uiautomator dump /data/local/tmp/fc-smoke.xml >/dev/null; "
                          "if [ -s /data/local/tmp/fc-smoke.xml ]; then "
                          "cat /data/local/tmp/fc-smoke.xml; fi")
        start = output.find("<?xml")
        if start < 0:
            # Android can briefly have no accessibility root during navigation.
            return []
        self.last_xml = output[start:]
        return list(ET.fromstring(self.last_xml).iter("node"))

    def wait_until(self, description, check, timeout=45):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = check(self.nodes())
            # A leaf Element is falsey despite being a successful match.
            if isinstance(result, ET.Element) or result:
                return result
            time.sleep(POLL_INTERVAL)
        raise AssertionError(f"{self.serial}: {description}")

    def wait_for(self, label, timeout=45, scroll=False):
        def check(nodes):
            node = find_node(nodes, label)
            if node is None and scroll:
                self.scroll_chat(nodes)
            return node
        return self.wait_until(f"did not find {label!r}", check, timeout)

    def wait_labels(self, *expected, timeout=45):
        return self.wait_until(f"did not find labels {expected!r}",
                               lambda nodes: set(expected) <= labels(nodes), timeout)

    def tap_node(self, node):
        if node.get("enabled") == "false":
            raise AssertionError(f"{self.serial}: control is disabled: {node.attrib}")
        x1, y1, x2, y2 = bounds(node)
        self.adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))

    def tap(self, label):
        self.tap_node(self.wait_for(label))

    def scroll_chat(self, nodes=None):
        for node in self.nodes() if nodes is None else nodes:
            if node.get("scrollable") == "true":
                x1, y1, x2, y2 = bounds(node)
                x = str((x1 + x2) // 2)
                self.adb("shell", "input", "swipe", x, str(y2 - 100), x, str(y1 + 100), "300")
                return

    def locate(self, label, class_name=None):
        # Search both directions because settings may retain their scroll position.
        for downward in [True] * 4 + [False] * 8 + [True] * 4:
            nodes = self.nodes()
            node = find_node(nodes, label, class_name)
            if node is not None:
                x1, y1, x2, y2 = bounds(node)
                # Android includes controls clipped to a few pixels at the edge
                # of a scroll view. Bring them into view before trying to tap.
                if x2 - x1 >= 24 and y2 - y1 >= 24:
                    return node
            scrollable = [n for n in nodes if n.get("scrollable") == "true"]
            if scrollable:
                x1, y1, x2, y2 = bounds(scrollable[-1])
                x = str((x1 + x2) // 2)
                top, bottom = str(y1 + (y2 - y1) // 4), str(y2 - (y2 - y1) // 4)
                self.adb("shell", "input", "swipe", x, bottom if downward else top,
                         x, top if downward else bottom, "300")
            time.sleep(POLL_INTERVAL)
        raise AssertionError(f"{self.serial}: did not find {label!r} while scrolling")

    def click(self, label, stable=False):
        node = self.locate(label)
        if stable:
            # A status banner can move a control after a screen first appears.
            # Use this extra snapshot only on screens with asynchronous layout.
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                previous = bounds(node)
                node = self.locate(label)
                if bounds(node) == previous:
                    break
            else:
                raise AssertionError(f"{self.serial}: {label!r} never stopped moving")
        self.tap_node(node)

    def fill(self, label, value):
        # adb input passes through a device shell; keep test data shell-safe.
        if not re.fullmatch(r"[A-Za-z0-9 ._-]+", value):
            raise ValueError("Unsupported characters in test input")
        self.tap_node(self.locate(label, "android.widget.EditText"))
        self.wait_until(f"input {label!r} did not gain focus", lambda nodes: any(
            n.get("content-desc") == label and n.get("focused") == "true" for n in nodes))
        self.adb("shell", "input keycombination 113 29 && input text " + value.replace(" ", "%s"))
        self.wait_until(f"input {label!r} did not accept the test value", lambda nodes: any(
            n.get("content-desc") == label and n.get("text") == value for n in nodes))
        self.adb("shell", "input", "keyevent", "4")


def on_each_phone(phones, action):
    # Only independent actions belong here. Join both workers before cleanup can
    # switch Android users or collect failure evidence.
    with ThreadPoolExecutor(max_workers=len(phones)) as pool:
        results = [pool.submit(action, phone) for phone in phones]
        return [result.result() for result in results]


def capture_failure(phones, error):
    """Save evidence before the wrapper removes the temporary Android users."""
    try:
        directory = Path(os.environ.get("FC_SMOKE_ARTIFACTS") or
                         tempfile.mkdtemp(prefix="family-circle-smoke-failure-"))
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "failure.txt").write_text(f"{type(error).__name__}: {error}\n")
    except OSError as diagnostic_error:
        print(f"Could not create failure artifacts: {diagnostic_error}", file=sys.stderr)
        return
    for phone in phones:
        if phone.last_xml:
            try:
                (directory / f"{phone.serial}-last.xml").write_text(phone.last_xml)
            except OSError as diagnostic_error:
                print(f"Could not save last UI snapshot: {diagnostic_error}", file=sys.stderr)
        for name, args in (
            ("screen.png", ("exec-out", "screencap", "-p")),
            ("ui.xml", ("exec-out", "uiautomator", "dump", "/dev/tty")),
        ):
            try:
                data = subprocess.check_output(["adb", "-s", phone.serial, *args], timeout=15)
                if name == "ui.xml":
                    start, end = data.find(b"<?xml"), data.rfind(b"</hierarchy>")
                    if start < 0 or end < 0:
                        raise ValueError("Android did not return a UI hierarchy")
                    data = data[start:end + len(b"</hierarchy>")]
                (directory / f"{phone.serial}-{name}").write_bytes(data)
            except (OSError, ValueError, subprocess.SubprocessError) as diagnostic_error:
                print(f"Could not capture {phone.serial} {name}: {diagnostic_error}", file=sys.stderr)
    print(f"Failure artifacts: {directory}", file=sys.stderr, flush=True)
