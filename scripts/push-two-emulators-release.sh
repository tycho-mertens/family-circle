#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
AVD_1="${AVD_1:-Pixel_10_Pro_XL}"
AVD_2="${AVD_2:-Pixel_10_Pro_XL_2}"
BUILD=true
SERIALS_FILE=""

usage() {
  cat <<'EOF'
Usage: scripts/push-two-emulators-release.sh [--avd-1 NAME] [--avd-2 NAME] [--no-build] [--serials-file PATH]

Builds mobile/android/app/build/outputs/apk/release/app-release.apk, boots or
reuses two AVDs, installs the release APK on both, and launches the app.
EOF
}
while (($#)); do
  case "$1" in
    --avd-1) [[ $# -ge 2 ]] || { echo "--avd-1 requires a name" >&2; exit 2; }; AVD_1="$2"; shift 2 ;;
    --avd-2) [[ $# -ge 2 ]] || { echo "--avd-2 requires a name" >&2; exit 2; }; AVD_2="$2"; shift 2 ;;
    --serials-file) [[ $# -ge 2 && -n "$2" ]] || { echo "--serials-file requires a path" >&2; exit 2; }; SERIALS_FILE="$2"; shift 2 ;;
    --no-build) BUILD=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$AVD_1" != "$AVD_2" ]] || { echo "Choose two different AVDs." >&2; exit 2; }

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
command -v adb >/dev/null || { echo "adb is required." >&2; exit 1; }
command -v emulator >/dev/null || { echo "emulator is required." >&2; exit 1; }
command -v setsid >/dev/null || { echo "setsid is required." >&2; exit 1; }
adb start-server >/dev/null

APK="$ROOT/mobile/android/app/build/outputs/apk/release/app-release.apk"
if [[ "$BUILD" == true ]]; then
  [[ -x "$ROOT/mobile/android/gradlew" ]] || { echo "mobile/android is missing; run Expo prebuild first." >&2; exit 1; }
  (cd "$ROOT/mobile/android" && ./gradlew :app:assembleRelease --console=plain -PreactNativeArchitectures=arm64-v8a,x86_64)
fi
[[ -f "$APK" ]] || { echo "Release APK not found: $APK" >&2; exit 1; }

list_emulators() { adb devices | awk '/^emulator-/{print $1}'; }
find_avd() {
  local wanted="$1" serial name
  for serial in $(list_emulators); do
    name="$(adb -s "$serial" emu avd name 2>/dev/null | head -1 | tr -d '\r')"
    [[ "$name" == "$wanted" ]] && { echo "$serial"; return 0; }
  done
  return 1
}
wait_for_avd() {
  local avd="$1" n=0 serial
  while ((n < 60)); do
    if serial="$(find_avd "$avd")"; then echo "$serial"; return 0; fi
    sleep 2; n=$((n + 1))
  done
  return 1
}
wait_for_boot() {
  local serial="$1" n=0
  while ((n < 90)); do
    [[ "$(adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]] && return 0
    sleep 2; n=$((n + 1))
  done
  return 1
}
resolve_avd() {
  local avd="$1" serial
  if serial="$(find_avd "$avd")"; then
    wait_for_boot "$serial" || { echo "Timed out waiting for $serial to boot" >&2; return 1; }
    echo "$serial"; return 0
  fi
  emulator -list-avds | grep -Fxq "$avd" || { echo "AVD not found: $avd" >&2; return 1; }
  echo "Booting $avd..." >&2
  nohup setsid emulator -avd "$avd" >"/tmp/${avd}.emulator.log" 2>&1 < /dev/null &
  serial="$(wait_for_avd "$avd")" || { echo "Timed out waiting for $avd" >&2; return 1; }
  wait_for_boot "$serial" || { echo "Timed out waiting for $serial to boot" >&2; return 1; }
  echo "$serial"
}

SERIAL_1="$(resolve_avd "$AVD_1")"
SERIAL_2="$(resolve_avd "$AVD_2")"
PACKAGE="dev.familycircle.poc"
for serial in "$SERIAL_1" "$SERIAL_2"; do
  echo "Installing release APK on $serial..." >&2
  adb -s "$serial" install -r "$APK" >/dev/null
  adb -s "$serial" shell am force-stop "$PACKAGE" || true
  adb -s "$serial" shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 >/dev/null
done
echo "Release APK installed and launched on $SERIAL_1 ($AVD_1) and $SERIAL_2 ($AVD_2)."

if [[ -n "$SERIALS_FILE" ]]; then
  printf '%s\n' "$SERIAL_1" "$SERIAL_2" > "$SERIALS_FILE"
fi
