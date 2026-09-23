#!/usr/bin/env bash
set -Euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
FIRST="${FC_SMOKE_FIRST:-emulator-5554}"
SECOND="${FC_SMOKE_SECOND:-emulator-5556}"
AVD_1="${AVD_1:-}"
AVD_2="${AVD_2:-}"
PREP_PID=""
REBUILD=false
LOG_ROOT="${TMPDIR:-/tmp}"
STARTUP_TIMEOUT=120
RELAY_PID=""
MAP_PID=""
SMOKE_PID=""
STAGES=(prerequisites emulators relay maps smoke shutdown)
declare -A NAMES=(
  [prerequisites]="Prerequisites" [emulators]="Emulator preparation"
  [relay]="Relay startup" [maps]="Map startup"
  [smoke]="Smoke tests" [shutdown]="Service shutdown"
)
declare -A RESULTS TIMES
for stage in "${STAGES[@]}"; do
  RESULTS[$stage]="NOT RUN"
  TIMES[$stage]=0
done
CURRENT_STAGE=""
STARTED=$SECONDS

usage() {
  cat <<'EOF'
Usage: bash scripts/run-emulator-smoke.sh [options]

Start an isolated development relay and local map gateway, run all emulator
smoke flows, stop those services, and print a results overview.

Options:
  --first SERIAL          First running emulator (default: emulator-5554)
  --second SERIAL         Second running emulator (default: emulator-5556)
  --avd-1 NAME            First AVD to prepare (default: detected or Pixel_10_Pro_XL)
  --avd-2 NAME            Second AVD (default: detected or Pixel_10_Pro_XL_2)
  --rebuild               Build and install a fresh APK even if emulators are ready
  --logs-dir DIRECTORY    Parent for a new run directory (default: /tmp)
  --startup-timeout SEC   Service readiness timeout (default: 120)
  -h, --help              Show this help

If either emulator is unready or lacks the app, build and install a release APK
using push-two-emulators-release.sh, then test the serials returned by that script.
Before running: configure two AVDs with secondary-user support, Android build
dependencies, and infra/maps assets using the README. Emulators stay running.
The APK must reach host ports 5080 and 8090 (normally through http://10.0.2.2).
Ports 5080, 8090, and 8091 must be free. Existing services are never stopped.

Runs setup, create/join, messaging, chat actions, location sharing, map gestures,
and offline restart checks. Temporary Android users preserve existing identities/Circles.
Logs and the isolated relay database remain in the printed run directory.
Exit status: 0 = success, nonzero = failed or interrupted.
EOF
}

while (($#)); do
  case "$1" in
    --first|--second|--avd-1|--avd-2|--logs-dir|--startup-timeout)
      [[ $# -ge 2 && -n "$2" ]] || { echo "$1 needs a value." >&2; exit 2; }
      case "$1" in
        --first) FIRST="$2" ;;
        --second) SECOND="$2" ;;
        --avd-1) AVD_1="$2" ;;
        --avd-2) AVD_2="$2" ;;
        --logs-dir) LOG_ROOT="$2" ;;
        --startup-timeout) STARTUP_TIMEOUT="$2" ;;
      esac
      shift 2 ;;
    --rebuild) REBUILD=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ "$STARTUP_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || { echo "Timeout must be a positive integer." >&2; exit 2; }
mkdir -p -- "$LOG_ROOT" || exit 1
LOG_DIR="$(mktemp -d "$LOG_ROOT/family-circle-smoke-run.XXXXXX")" || exit 1
LOG_DIR="$(cd -- "$LOG_DIR" && pwd)"
echo "Run directory: $LOG_DIR"

start_stage() {
  CURRENT_STAGE="$1"
  STAGE_START=$SECONDS
  RESULTS[$CURRENT_STAGE]="RUNNING"
}

complete_stage() {
  RESULTS[$CURRENT_STAGE]="${1:-PASSED}"
  TIMES[$CURRENT_STAGE]=$((SECONDS - STAGE_START))
}

stop_service() {
  local pid="$1" attempt
  [[ -n "$pid" ]] || return 0
  # Each service has its own process group, including dotnet's child and pmtiles.
  if kill -0 -- "-$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    for ((attempt = 0; attempt < 100; attempt++)); do
      kill -0 -- "-$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 -- "-$pid" 2>/dev/null; then
      kill -KILL -- "-$pid" 2>/dev/null || return 1
    fi
  fi
  wait "$pid" 2>/dev/null || true
}

overview() {
  local exit_status="$1" index passed=0 skipped=0 line
  printf '\nFamily Circle — emulator smoke overview\n'
  printf '%-24s %-12s %s\n' "Stage" "Result" "Time"
  printf '%-24s %-12s %s\n' "------------------------" "------------" "--------"
  for index in "${STAGES[@]}"; do
    printf '%-24s %-12s %ss\n' "${NAMES[$index]}" "${RESULTS[$index]}" "${TIMES[$index]}"
  done
  printf '\nChecks completed:\n'
  if [[ -f "$LOG_DIR/smoke.log" ]]; then
    while IFS= read -r line; do
      case "$line" in
        PASS:*) printf '  [PASS] %s\n' "${line#PASS: }"; passed=$((passed + 1)) ;;
        SKIP:*) printf '  [SKIP] %s\n' "${line#SKIP: }"; skipped=$((skipped + 1)) ;;
      esac
    done < "$LOG_DIR/smoke.log"
  fi
  ((passed + skipped > 0)) || echo "  No checks completed."
  printf '\nChecks: %s passed, %s skipped. Total time: %ss.\n' "$passed" "$skipped" "$((SECONDS - STARTED))"
  if ((exit_status == 0)); then
    echo "OVERALL: PASSED"
  elif ((exit_status == 130 || exit_status == 143)); then
    echo "OVERALL: INTERRUPTED"
  else
    echo "OVERALL: FAILED"
  fi
  printf 'Logs, summary, and test database: %s\n' "$LOG_DIR"
}

finish() {
  local status=$? cleanup_start=$SECONDS index
  trap - EXIT
  # Let the profile wrapper finish its restoration before stopping the relay.
  trap '' INT TERM
  if [[ -n "$SMOKE_PID" ]] && kill -0 "$SMOKE_PID" 2>/dev/null; then
    kill -TERM -- "-$SMOKE_PID" 2>/dev/null || true
    wait "$SMOKE_PID" 2>/dev/null || true
  fi
  stop_service "$PREP_PID" || status=1
  for index in "${STAGES[@]}"; do
    if [[ "${RESULTS[$index]}" == RUNNING ]]; then
      RESULTS[$index]="FAILED"
      ((status == 130 || status == 143)) && RESULTS[$index]="INTERRUPTED"
      TIMES[$index]=$((SECONDS - STAGE_START))
    fi
  done
  RESULTS[shutdown]="PASSED"
  [[ -n "$MAP_PID$RELAY_PID" ]] || RESULTS[shutdown]="NOT NEEDED"
  stop_service "$MAP_PID" || { RESULTS[shutdown]="FAILED"; status=1; }
  stop_service "$RELAY_PID" || { RESULTS[shutdown]="FAILED"; status=1; }
  TIMES[shutdown]=$((SECONDS - cleanup_start))
  overview "$status" | tee "$LOG_DIR/summary.txt"
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

preflight() {
  local command serial asset
  for command in adb dotnet python3 curl setsid tee; do
    command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; return 1; }
  done
  [[ "$FIRST" != "$SECOND" ]] || { echo "Choose two different emulators." >&2; return 1; }
  for serial in "$FIRST" "$SECOND"; do
    [[ "$serial" == emulator-* ]] || { echo "Only Android emulators are supported." >&2; return 1; }
  done
  [[ -x "$ROOT/infra/maps/.bin/pmtiles" ]] || {
    echo "Map tools are missing. Run python3 infra/maps/prepare.py first." >&2; return 1;
  }
  for asset in data/world.pmtiles public/coverage.json public/styles/light.json public/styles/dark.json; do
    [[ -s "$ROOT/infra/maps/$asset" ]] || {
      echo "Missing map asset: infra/maps/$asset. Follow the README map setup." >&2; return 1;
    }
  done
  python3 - <<'PY'
import socket
import sys

for port in (5080, 8090, 8091):
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(('0.0.0.0', port))
        except OSError as error:
            print(f'Port {port} is unavailable: {error}. Stop its service before running.', file=sys.stderr)
            sys.exit(1)
PY
}

emulator_ready() {
  local serial="$1" state
  state="$(adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
  [[ "$state" == 1 ]] || return 1
  adb -s "$serial" shell pm path dev.familycircle.poc 2>/dev/null | grep -q '^package:'
}

avd_for_serial() {
  adb -s "$1" emu avd name 2>/dev/null | head -n 1 | tr -d '\r'
}

prepare_emulators() {
  if [[ "$REBUILD" == false ]] && emulator_ready "$FIRST" && emulator_ready "$SECOND"; then
    echo "Both emulators are ready; using the installed APK."
    return 0
  fi
  AVD_1="${AVD_1:-$(avd_for_serial "$FIRST")}"
  AVD_2="${AVD_2:-$(avd_for_serial "$SECOND")}"
  AVD_1="${AVD_1:-Pixel_10_Pro_XL}"
  AVD_2="${AVD_2:-Pixel_10_Pro_XL_2}"
  echo "Preparing $AVD_1 and $AVD_2: building and installing the release APK..."
  echo "Build output: $LOG_DIR/emulators.log"
  setsid bash "$ROOT/scripts/push-two-emulators-release.sh" \
    --avd-1 "$AVD_1" --avd-2 "$AVD_2" --serials-file "$LOG_DIR/emulator-serials.txt" \
    > "$LOG_DIR/emulators.log" 2>&1 &
  PREP_PID=$!
  local prep_status=0
  wait "$PREP_PID" || prep_status=$?
  # Keep the PID for cleanup if preparation failed with a child still running.
  if ((prep_status != 0)); then
    tail -n 20 "$LOG_DIR/emulators.log" >&2
    return "$prep_status"
  fi
  PREP_PID=""
  local -a serials=()
  [[ -f "$LOG_DIR/emulator-serials.txt" ]] && mapfile -t serials < "$LOG_DIR/emulator-serials.txt"
  if ((${#serials[@]} != 2)) || [[ ! "${serials[0]}" =~ ^emulator-[0-9]+$ || ! "${serials[1]}" =~ ^emulator-[0-9]+$ || "${serials[0]}" == "${serials[1]}" ]]; then
    echo "Emulator preparation did not return two valid serials." >&2
    return 1
  fi
  FIRST="${serials[0]}"
  SECOND="${serials[1]}"
  emulator_ready "$FIRST" && emulator_ready "$SECOND" || {
    echo "Emulators are still unready after preparation. See $LOG_DIR/emulators.log" >&2
    return 1
  }
}

wait_ready() {
  local pid="$1" url="$2" deadline=$((SECONDS + STARTUP_TIMEOUT))
  while ((SECONDS < deadline)); do
    kill -0 "$pid" 2>/dev/null || return 1
    if curl --fail --silent --max-time 3 "$url" > /dev/null; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

start_stage prerequisites
preflight > "$LOG_DIR/preflight.log" 2>&1 || { cat "$LOG_DIR/preflight.log" >&2; exit 1; }
complete_stage

start_stage emulators
prepare_emulators || exit $?
complete_stage

echo "Starting relay on :5080..."
start_stage relay
ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS=http://0.0.0.0:5080 \
  Access__RequireInstallation=false Logging__LogLevel__Default=Warning \
  ConnectionStrings__Relay="Data Source=$LOG_DIR/relay.db" \
  Locations__DatabasePath="$LOG_DIR/relay.locations" \
  setsid dotnet run --project "$ROOT/relay" --no-launch-profile \
  > "$LOG_DIR/relay.log" 2>&1 &
RELAY_PID=$!
wait_ready "$RELAY_PID" http://127.0.0.1:5080/healthz || {
  echo "Relay did not become ready. See $LOG_DIR/relay.log" >&2; exit 1;
}
complete_stage

echo "Starting local map gateway on :8090..."
start_stage maps
MAP_PROVIDER=local MAP_PORT=8090 setsid python3 "$ROOT/infra/maps/serve.py" \
  > "$LOG_DIR/maps.log" 2>&1 &
MAP_PID=$!
for route in healthz coverage.json styles/light.json styles/dark.json tiles/world/0/0/0.mvt; do
  wait_ready "$MAP_PID" "http://127.0.0.1:8090/$route" || {
    echo "Map readiness failed at /$route. See $LOG_DIR/maps.log" >&2; exit 1;
  }
done
complete_stage

echo "Running smoke tests on $FIRST and $SECOND (this takes several minutes)..."
echo "Live output: tail -f $LOG_DIR/smoke.log"
start_stage smoke
FC_SMOKE_FIRST="$FIRST" FC_SMOKE_SECOND="$SECOND" FC_SMOKE_KEEP_FAILED=0 \
  FC_SMOKE_ARTIFACTS="$LOG_DIR/artifacts" \
  setsid bash "$ROOT/mobile/scripts/run-setup-smoke.sh" --chat-actions --offline-restart --map-gestures \
  > "$LOG_DIR/smoke.log" 2>&1 &
SMOKE_PID=$!
test_status=0
wait "$SMOKE_PID" || test_status=$?
SMOKE_PID=""
if ((test_status != 0)); then
  complete_stage FAILED
  echo "Smoke tests failed. Last output:" >&2
  tail -n 20 "$LOG_DIR/smoke.log" >&2
  exit "$test_status"
fi
complete_stage
exit 0
