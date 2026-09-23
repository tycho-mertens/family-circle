#!/usr/bin/env bash
set -euo pipefail

# Secondary Android users have separate app data and permissions. Exercise a
# first install without clearing the identities used for everyday development.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
FIRST="${FC_SMOKE_FIRST:-emulator-5554}"
SECOND="${FC_SMOKE_SECOND:-emulator-5556}"
PACKAGE="dev.familycircle.poc"
SERIALS=("$FIRST" "$SECOND")
ORIGINAL_USERS=()
TEST_USERS=()

[[ "$FIRST" != "$SECOND" ]] || { echo "Choose two different emulators." >&2; exit 1; }
for serial in "${SERIALS[@]}"; do
  [[ "$serial" == emulator-* ]] || { echo "Only emulators are supported." >&2; exit 1; }
  ORIGINAL_USERS+=("$(adb -s "$serial" shell am get-current-user | tr -d '\r')")
  adb -s "$serial" shell pm path "$PACKAGE" | grep -q '^package:' || {
    echo "Install the release APK on $serial first." >&2; exit 1;
  }
done

restore_users() {
  local status=$? index serial test_user
  trap - EXIT INT TERM
  for index in "${!TEST_USERS[@]}"; do
    serial="${SERIALS[$index]}"
    test_user="${TEST_USERS[$index]}"
    if adb -s "$serial" shell am switch-user "${ORIGINAL_USERS[$index]}"; then
      if ((status == 0)) || [[ "${FC_SMOKE_KEEP_FAILED:-0}" != 1 ]]; then
        adb -s "$serial" shell am stop-user -w "$test_user" || status=1
        removed=false
        for ((attempt = 0; attempt < 10; attempt++)); do
          if adb -s "$serial" shell pm remove-user --wait "$test_user"; then
            removed=true
            break
          fi
          sleep 1
        done
        [[ "$removed" == true ]] || status=1
      else
        echo "Kept test user $test_user on $serial for inspection." >&2
      fi
    else
      echo "Could not restore the original user on $serial." >&2
      status=1
    fi
  done
  exit "$status"
}
trap restore_users EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for index in "${!SERIALS[@]}"; do
  serial="${SERIALS[$index]}"
  result="$(adb -s "$serial" shell pm create-user "FamilyCircleSmoke$(date +%s)")"
  test_user="$(sed -n 's/^Success: created user id \([0-9]*\).*/\1/p' <<< "$result" | tr -d '\r')"
  [[ "$test_user" =~ ^[1-9][0-9]*$ && "$test_user" != "${ORIGINAL_USERS[$index]}" ]] || {
    echo "Could not create an isolated user on $serial: $result" >&2; exit 1;
  }
  TEST_USERS+=("$test_user")
  echo "Using test user $test_user on $serial."
  adb -s "$serial" shell cmd package install-existing --user "$test_user" "$PACKAGE"
  # Skip Android's own welcome wizard; the app's onboarding remains untouched.
  adb -s "$serial" shell settings --user "$test_user" put secure user_setup_complete 1
  adb -s "$serial" shell am start-user -w "$test_user"
  adb -s "$serial" shell settings --user "$test_user" put system screen_off_timeout 1800000
  adb -s "$serial" shell locksettings set-disabled --user "$test_user" true
  adb -s "$serial" shell am switch-user "$test_user"
  for ((attempt = 0; attempt < 30; attempt++)); do
    [[ "$(adb -s "$serial" shell am get-current-user | tr -d '\r')" == "$test_user" ]] && break
    sleep 1
  done
  [[ "$(adb -s "$serial" shell am get-current-user | tr -d '\r')" == "$test_user" ]] || {
    echo "Android did not switch to the test user." >&2; exit 1;
  }
  adb -s "$serial" shell input keyevent KEYCODE_WAKEUP
  adb -s "$serial" shell wm dismiss-keyguard
  adb -s "$serial" shell input keyevent 82
done

python3 "$SCRIPT_DIR/emulator-smoke.py" --first "$FIRST" --second "$SECOND" \
  --setup --create-join --location-sharing "$@"
