"""Check the runner's failure handling without an Android SDK or live services."""

import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import unittest


RUNNER = Path(__file__).resolve().parents[1] / "run-emulator-smoke.sh"


@unittest.skipUnless(shutil.which("setsid"), "The runner requires Linux setsid")
class EmulatorRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "scripts").mkdir()
        shutil.copyfile(RUNNER, self.root / "scripts/run-emulator-smoke.sh")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.logs = self.root / "logs"
        self.env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}",
                        TEST_STATE=str(self.root), FC_SMOKE_FIRST="emulator-5554",
                        FC_SMOKE_SECOND="emulator-5556")
        for asset in (".bin/pmtiles", "data/world.pmtiles", "public/coverage.json",
                      "public/styles/light.json", "public/styles/dark.json"):
            path = self.root / "infra/maps" / asset
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture")
            path.chmod(0o755)
        self.write(self.bin / "adb", '''
case "$*" in
  *sys.boot_completed*)
    if [[ "$TEST_SCENARIO" == prep-* && ! -f "$TEST_STATE/prepared" ]]; then exit 1; fi
    [[ "$TEST_SCENARIO" == prep-unready ]] && exit 1
    echo 1 ;;
  *"pm path"*)
    [[ "$TEST_SCENARIO" == missing-app && ! -f "$TEST_STATE/prepared" ]] && exit 1
    echo package:/test.apk ;;
  *"emu avd name"*) echo Existing_AVD ;;

esac
''')
        self.write(self.root / "scripts/push-two-emulators-release.sh", '''
printf '%s\\n' "$@" > "$TEST_STATE/push-args"
[[ "$TEST_SCENARIO" == prep-failure ]] && exit 7
while (($#)); do
  if [[ "$1" == --serials-file ]]; then
    printf '%s\\n' emulator-5560 emulator-5562 > "$2"
    [[ "$TEST_SCENARIO" == prep-invalid ]] && echo invalid > "$2"
  fi
  shift
done
touch "$TEST_STATE/prepared"
''')
        service = '''
echo $$ > "$TEST_STATE/$kind.pid"
trap 'exit 0' TERM INT
sleep 300 &
echo $! > "$TEST_STATE/$kind-child.pid"
wait
'''
        self.write(self.bin / "dotnet", '''
[[ "$TEST_SCENARIO" == relay-failure ]] && exit 4
kind=relay
''' + service)
        self.write(self.bin / "python3", '''
if [[ "$1" == - ]]; then
  cat > /dev/null
  if [[ "$TEST_SCENARIO" == occupied ]]; then
    echo 'Port 5080 is unavailable' >&2
    exit 1
  fi
  exit 0
fi
[[ "$TEST_SCENARIO" == map-failure ]] && exit 5
kind=map
''' + service)
        self.write(self.bin / "curl", '''
[[ "$TEST_SCENARIO" == relay-failure ]] && exit 1
[[ "$TEST_SCENARIO" == map-failure && "$*" == *8090* ]] && exit 1
if [[ "$*" == *5080* ]]; then
  [[ -s "$TEST_STATE/relay-child.pid" ]]
else
  [[ -s "$TEST_STATE/map-child.pid" ]]
fi
''')
        self.write(self.root / "mobile/scripts/run-setup-smoke.sh", '''
echo "$FC_SMOKE_FIRST $FC_SMOKE_SECOND" > "$TEST_STATE/suite-started"
echo 'PASS: setup fixture'
if [[ "$TEST_SCENARIO" == test-failure ]]; then
  echo 'AssertionError: location fixture failed' >&2
  exit 9
fi
if [[ "$TEST_SCENARIO" == interrupt ]]; then
  trap 'echo restored > "$TEST_STATE/profiles-restored"; exit 143' TERM INT
  sleep 300 &
  wait
fi
echo 'PASS: location fixture'
''')

    def write(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("#!/usr/bin/env bash\n" + text)
        path.chmod(0o755)

    def command(self):
        return ["bash", str(self.root / "scripts/run-emulator-smoke.sh"),
                "--logs-dir", str(self.logs), "--startup-timeout", "2"]

    def run_scenario(self, scenario, *options):
        self.env["TEST_SCENARIO"] = scenario
        result = subprocess.run(self.command() + list(options), env=self.env, capture_output=True,
                                text=True, timeout=60)
        summaries = list(self.logs.glob("*/summary.txt"))
        self.assertEqual(len(summaries), 1)
        self.assertIn(summaries[0].read_text(), result.stdout)
        self.assert_services_stopped()
        return result

    def assert_services_stopped(self):
        for path in self.root.glob("*.pid"):
            pid = int(path.read_text())
            stat = Path(f"/proc/{pid}/stat")
            if stat.exists():
                # A zombie no longer runs or holds a listening socket.
                self.assertEqual(stat.read_text().split(") ", 1)[1][0], "Z", path.name)

    def test_success_prints_checks_and_stops_service_children(self):
        result = self.run_scenario("success")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.root / "push-args").exists())
        self.assertIn("OVERALL: PASSED", result.stdout)
        self.assertIn("2 passed, 0 skipped", result.stdout)
        self.assertEqual(len(list(self.root.glob("*.pid"))), 4)

    def test_unready_emulators_are_prepared_before_tests(self):
        result = self.run_scenario("prep-success")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        args = (self.root / "push-args").read_text()
        self.assertNotIn("--no-build", args)
        self.assertIn("--avd-1", args)
        self.assertEqual((self.root / "suite-started").read_text().strip(),
                         "emulator-5560 emulator-5562")

    def test_rebuild_prepares_even_ready_emulators(self):
        result = self.run_scenario("success", "--rebuild")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.root / "prepared").exists())

    def test_missing_app_triggers_preparation(self):
        result = self.run_scenario("missing-app")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.root / "prepared").exists())

    def test_failed_build_prevents_services_and_smoke_tests(self):
        result = self.run_scenario("prep-failure")
        self.assertEqual(result.returncode, 7, result.stdout + result.stderr)
        self.assertFalse((self.root / "suite-started").exists())
        self.assertFalse(list(self.root.glob("*.pid")))

    def test_emulators_must_be_ready_after_preparation(self):
        result = self.run_scenario("prep-unready")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("still unready", result.stderr)
        self.assertFalse((self.root / "suite-started").exists())
        self.assertFalse(list(self.root.glob("*.pid")))

    def test_invalid_preparation_output_prevents_services(self):
        result = self.run_scenario("prep-invalid")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("two valid serials", result.stderr)
        self.assertFalse(list(self.root.glob("*.pid")))

    def run_real_push_script(self, build_fails=False):
        shutil.copyfile(RUNNER.with_name("push-two-emulators-release.sh"),
                        self.root / "scripts/push-two-emulators-release.sh")
        self.env["ANDROID_HOME"] = str(self.root / "sdk")
        self.env["BUILD_FAILS"] = "yes" if build_fails else "no"
        self.write(self.bin / "emulator", "exit 1\n")
        self.write(self.bin / "sleep", "exit 0\n")
        self.write(self.bin / "adb", '''
case "$*" in
  devices) printf '%s\\n' 'emulator-5560 device' 'emulator-5562 device' ;;
  *"emu avd name"*)
    [[ "$2" == emulator-5560 ]] && echo First || echo Second ;;
  *sys.boot_completed*)
    if [[ -f "$TEST_STATE/boot-$2" ]]; then echo 1
    else touch "$TEST_STATE/boot-$2"; echo 0; fi ;;
  *"install -r"*) echo "$2" >> "$TEST_STATE/installed" ;;
esac
''')
        self.write(self.root / "mobile/android/gradlew", '''
echo built > "$TEST_STATE/built"
[[ "$BUILD_FAILS" == yes ]] && exit 8
mkdir -p app/build/outputs/apk/release
echo apk > app/build/outputs/apk/release/app-release.apk
''')
        return subprocess.run(
            ["bash", str(self.root / "scripts/push-two-emulators-release.sh"),
             "--avd-1", "First", "--avd-2", "Second", "--serials-file",
             str(self.root / "serials")], env=self.env, capture_output=True,
            text=True, timeout=10)

    def test_push_builds_waits_for_reused_avds_and_reports_installed_serials(self):
        result = self.run_real_push_script()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.root / "built").exists())
        self.assertEqual((self.root / "installed").read_text(),
                         "emulator-5560\nemulator-5562\n")
        self.assertEqual((self.root / "serials").read_text(),
                         (self.root / "installed").read_text())

    def test_push_does_not_install_or_report_serials_after_failed_build(self):
        result = self.run_real_push_script(build_fails=True)
        self.assertEqual(result.returncode, 8, result.stdout + result.stderr)
        self.assertFalse((self.root / "installed").exists())
        self.assertFalse((self.root / "serials").exists())

    def test_occupied_port_does_not_start_services_or_tests(self):
        result = self.run_scenario("occupied")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("OVERALL: FAILED", result.stdout)
        self.assertIn("NOT NEEDED", result.stdout)
        self.assertFalse(list(self.root.glob("*.pid")))
        self.assertFalse((self.root / "suite-started").exists())

    def test_relay_failure_prevents_maps_and_tests(self):
        result = self.run_scenario("relay-failure")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "map.pid").exists())
        self.assertFalse((self.root / "suite-started").exists())

    def test_map_failure_stops_relay_and_prevents_tests(self):
        result = self.run_scenario("map-failure")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.root / "relay.pid").exists())
        self.assertFalse((self.root / "suite-started").exists())

    def test_test_failure_preserves_failure_exit_code_and_partial_results(self):
        result = self.run_scenario("test-failure")
        self.assertEqual(result.returncode, 9)
        self.assertIn("OVERALL: FAILED", result.stdout)
        self.assertIn("1 passed, 0 skipped", result.stdout)
        self.assertIn("location fixture failed", result.stderr)

    def test_interrupt_waits_for_profile_restoration_then_stops_services(self):
        self.env["TEST_SCENARIO"] = "interrupt"
        process = subprocess.Popen(self.command(), env=self.env, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 10
            while not (self.root / "suite-started").exists():
                if process.poll() is not None or time.monotonic() > deadline:
                    self.fail("Smoke fixture never started")
                time.sleep(0.05)
            process.send_signal(signal.SIGTERM)
            stdout, stderr = process.communicate(timeout=60)
            self.assertEqual(process.returncode, 143, stdout + stderr)
            self.assertIn("OVERALL: INTERRUPTED", stdout)
            self.assertTrue((self.root / "profiles-restored").exists())
            self.assert_services_stopped()
        finally:
            if process.poll() is None:
                process.terminate()
                process.communicate(timeout=60)


if __name__ == "__main__":
    unittest.main()
