"""Exercise UI matching and diagnostics without Android or a running app."""

from contextlib import redirect_stderr
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
import xml.etree.ElementTree as ET

SCRIPTS = Path(__file__).resolve().parents[2] / "mobile/scripts"
sys.path.insert(0, str(SCRIPTS))
from emulator_ui import AndroidPhone, bounds, by_id, capture_failure, find_node, on_each_phone

spec = importlib.util.spec_from_file_location("emulator_smoke", SCRIPTS / "emulator-smoke.py")
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def tree(xml):
    return list(ET.fromstring(xml).iter("node"))


class UiTests(unittest.TestCase):
    def test_control_is_preferred_to_its_text_label(self):
        nodes = tree('''<hierarchy>
          <node text="Continue" />
          <node content-desc="Continue" clickable="true" enabled="false" bounds="[0,0][10,10]" />
        </hierarchy>''')
        phone = AndroidPhone("emulator-5554")
        phone.adb = Mock()
        with self.assertRaisesRegex(AssertionError, "disabled"):
            phone.tap_node(find_node(nodes, "Continue"))
        phone.adb.assert_not_called()

    def test_leaf_node_is_a_successful_wait_result(self):
        phone = AndroidPhone("emulator-5554")
        phone.nodes = Mock(return_value=tree('<node text="Ready" />'))
        self.assertEqual(phone.wait_for("Ready").get("text"), "Ready")
        self.assertEqual(phone.nodes.call_count, 1)

    def test_scroll_reuses_the_snapshot_that_failed_to_match(self):
        phone = AndroidPhone("emulator-5554")
        phone.nodes = Mock(side_effect=[tree('<node scrollable="true" bounds="[0,0][400,900]" />'),
                                       tree('<node text="Message" />')])
        phone.adb = Mock()
        with patch("emulator_ui.time.sleep"):
            phone.wait_for("Message", scroll=True)
        self.assertEqual(phone.nodes.call_count, 2)
        phone.adb.assert_called_once()

    def test_snapshot_uses_one_adb_call_and_handles_missing_root(self):
        phone = AndroidPhone("emulator-5554")
        phone.adb = Mock(side_effect=['<?xml version="1.0"?><hierarchy><node text="Ready" /></hierarchy>', ''])
        self.assertEqual(phone.nodes()[0].get("text"), "Ready")
        self.assertEqual(phone.nodes(), [])
        self.assertEqual(phone.adb.call_count, 2)
        self.assertIn("Ready", phone.last_xml)

    def test_resource_ids_work_with_android_namespace(self):
        nodes = tree('<hierarchy><node resource-id="dev.familycircle.poc:id/pin" />'
                     '<node resource-id="pin" /></hierarchy>')
        self.assertEqual(len(by_id(nodes, "pin")), 2)

    def test_locate_scrolls_past_a_clipped_control(self):
        phone = AndroidPhone("emulator-5554")
        phone.adb = Mock()
        phone.nodes = Mock(side_effect=[tree('''<hierarchy>
          <node scrollable="true" bounds="[0,100][400,900]" />
          <node content-desc="Show invite code" bounds="[10,893][390,900]" />
        </hierarchy>'''), tree('<node content-desc="Show invite code" bounds="[10,300][390,400]" />')])
        with patch("emulator_ui.time.sleep"):
            phone.click("Show invite code")
        self.assertEqual(phone.adb.call_count, 2)
        self.assertIn("swipe", phone.adb.call_args_list[0].args)
        self.assertEqual(phone.adb.call_args_list[1].args[-2:], ("200", "350"))

    def test_stable_click_uses_the_position_after_layout_settles(self):
        phone = AndroidPhone("emulator-5554")
        phone.adb = Mock()
        before = ET.Element("node", bounds="[10,200][390,300]")
        after = ET.Element("node", bounds="[10,400][390,500]")
        phone.locate = Mock(side_effect=[before, after, after])
        phone.click("Show invite code", stable=True)
        phone.adb.assert_called_once_with("shell", "input", "tap", "200", "450")

    def test_bounds_keep_negative_coordinates(self):
        self.assertEqual(bounds(ET.Element("node", bounds="[-10,20][300,400]")), (-10, 20, 300, 400))

    def test_reaction_must_belong_to_the_target_message(self):
        nodes = tree('''<hierarchy>
          <node resource-id="chat-message-row">
            <node content-desc="Target" />
            <node text="Extra layout child" />
            <node resource-id="chat-message-reactions" content-desc="Heart: 1" />
          </node>
          <node resource-id="chat-message-row"><node content-desc="Other" /></node>
        </hierarchy>''')
        phone = smoke.Phone("emulator-5554")
        phone.nodes = Mock(return_value=nodes)
        phone.wait_reaction("Target", True)
        phone.wait_reaction("Other", False)

    def test_deleted_reply_checks_its_own_preview(self):
        nodes = tree('''<hierarchy>
          <node resource-id="chat-message-row"><node text="Other reply" />
            <node resource-id="chat-reply-preview" content-desc="Message deleted" /></node>
          <node resource-id="chat-message-row"><node text="Target reply" />
            <node resource-id="chat-reply-preview" content-desc="Reply to Smoke: Original" /></node>
        </hierarchy>''')
        phone = smoke.Phone("emulator-5554")
        phone.wait_for = Mock()
        phone.wait_until = lambda description, check: self.assertFalse(check(nodes))
        phone.check_deleted_reply("Target reply", "Original")

    def test_deleted_reply_does_not_hide_a_still_visible_original(self):
        nodes = tree('''<hierarchy>
          <node text="Original" />
          <node resource-id="chat-message-row"><node text="Target reply" />
            <node resource-id="chat-reply-preview" content-desc="Message deleted" /></node>
        </hierarchy>''')
        phone = smoke.Phone("emulator-5554")
        phone.wait_for = Mock()
        phone.wait_until = lambda description, check: self.assertFalse(check(nodes))
        phone.check_deleted_reply("Target reply", "Original")

    def test_independent_actions_overlap_and_finish_before_returning(self):
        barrier = threading.Barrier(2, timeout=5)
        def action(phone):
            barrier.wait()
            return phone
        self.assertEqual(on_each_phone(["first", "second"], action), ["first", "second"])

    def test_worker_failure_waits_for_other_device_before_cleanup(self):
        finished = threading.Event()
        def action(phone):
            if phone == "first":
                raise AssertionError("Original failure")
            finished.set()
        with self.assertRaisesRegex(AssertionError, "Original failure"):
            on_each_phone(["first", "second"], action)
        self.assertTrue(finished.is_set())

    def test_capture_keeps_original_error_when_device_is_unavailable(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, FC_SMOKE_ARTIFACTS=temp):
            phone = AndroidPhone("emulator-5554")
            phone.last_xml = '<hierarchy />'
            with patch("emulator_ui.subprocess.check_output", side_effect=subprocess.TimeoutExpired("adb", 15)), redirect_stderr(io.StringIO()):
                capture_failure([phone], AssertionError("Missing pin"))
            self.assertIn("Missing pin", (Path(temp) / "failure.txt").read_text())
            self.assertEqual((Path(temp) / "emulator-5554-last.xml").read_text(), '<hierarchy />')

    def test_capture_writes_screenshot_and_valid_xml(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, FC_SMOKE_ARTIFACTS=temp):
            with patch("emulator_ui.subprocess.check_output", side_effect=[b'png', b'<?xml version="1.0"?><hierarchy></hierarchy>UI dumped']), redirect_stderr(io.StringIO()):
                capture_failure([AndroidPhone("emulator-5554")], AssertionError("Missing pin"))
            self.assertEqual((Path(temp) / "emulator-5554-screen.png").read_bytes(), b'png')
            ET.parse(Path(temp) / "emulator-5554-ui.xml")


if __name__ == "__main__":
    unittest.main()
