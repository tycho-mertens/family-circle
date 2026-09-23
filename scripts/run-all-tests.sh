#!/usr/bin/env bash

set -Euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ANDROID=1
RUN_SCALING=1
RELAY_PID=""
TEST_TMP_DIR=""
OVERALL_FAILED=0
RESULT_NAMES=()
RESULT_STATUSES=()
RESULT_DURATIONS=()

usage() {
  cat <<'EOF'
Usage: ./scripts/run-all-tests.sh [options]

Runs every test suite in the repository:
  - Rust unit, integration, and documentation tests
  - Python map gateway tests
  - Emulator runner lifecycle tests (no devices required)
  - Mobile Node tests and TypeScript checking
  - Android bridge unit tests
  - C# relay tests
  - Rust-to-relay HTTP scaling test (10, 20, and 50 members)

Options:
  --skip-android   Skip Android bridge tests and their native build
  --skip-scaling   Skip the long HTTP scaling test
  -h, --help       Show this help

The Android tests require ANDROID_NDK_HOME, cargo-ndk, the Android Rust targets,
and an Android SDK. The scaling test starts an isolated relay automatically.
EOF
}

while (($#)); do
  case "$1" in
    --skip-android)
      RUN_ANDROID=0
      ;;
    --skip-scaling)
      RUN_SCALING=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

section() {
  printf '\n==> %s\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    return 1
  fi
}

add_result() {
  RESULT_NAMES+=("$1")
  RESULT_STATUSES+=("$2")
  RESULT_DURATIONS+=("$3")
}

run_suite() {
  local name="$1"
  local start=$SECONDS
  local status
  shift

  section "$name"
  if "$@"; then
    status="PASSED"
  else
    status="FAILED"
    OVERALL_FAILED=1
  fi
  add_result "$name" "$status" "$((SECONDS - start))s"
}

skip_suite() {
  add_result "$1" "SKIPPED" "-"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  if [[ -n "$RELAY_PID" ]] && kill -0 "$RELAY_PID" 2>/dev/null; then
    kill "$RELAY_PID" 2>/dev/null || true
    wait "$RELAY_PID" 2>/dev/null || true
  fi

  if [[ -n "$TEST_TMP_DIR" && -d "$TEST_TMP_DIR" ]]; then
    rm -rf -- "$TEST_TMP_DIR"
  fi

  exit "$status"
}

trap cleanup EXIT INT TERM

cd "$ROOT_DIR"

rust_tests() {
  require_command cargo && cargo test --workspace
}

python_tests() {
  require_command python3 &&
    python3 -m unittest discover -s infra/maps -p 'test_*.py' -v
}

mobile_tests() {
  require_command npm && npm --prefix mobile test
}

smoke_runner_tests() {
  require_command python3 &&
    python3 -m unittest discover -s scripts/tests -p 'test_*.py' -v
}

mobile_typecheck() {
  require_command npm && npm --prefix mobile run typecheck
}

android_tests() {
  if [[ -z "${ANDROID_NDK_HOME:-}" ]]; then
    echo "Set ANDROID_NDK_HOME to the installed Android NDK directory." >&2
    return 1
  fi
  require_command cargo-ndk || return 1
  require_command npx || return 1
  "$ROOT_DIR/crypto-core/build-android.sh" || return 1

  if [[ ! -x "$ROOT_DIR/mobile/android/gradlew" ]]; then
    (
      cd "$ROOT_DIR/mobile"
      npx expo prebuild --platform android --no-install
    ) || return 1
  fi

  (
    cd "$ROOT_DIR/mobile/android"
    ./gradlew :family-circle-bridge:testDebugUnitTest
  )
}

csharp_tests() {
  require_command dotnet || return 1
  # .NET 10 does not infer this older-style project as a test project, so force
  # test discovery without modifying the project file.
  dotnet test relay/tests/FamilyCircle.Relay.Tests.csproj -p:IsTestProject=true
}

scaling_test() {
  require_command cargo || return 1
  require_command curl || return 1
  require_command dotnet || return 1
  require_command python3 || return 1

  TEST_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/family-circle-tests.XXXXXX")"
  RELAY_PORT="${FC_TEST_RELAY_PORT:-$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')}"
  RELAY_URL="http://127.0.0.1:${RELAY_PORT}"
  RELAY_LOG="$TEST_TMP_DIR/relay.log"

  ASPNETCORE_URLS="$RELAY_URL" \
  ASPNETCORE_ENVIRONMENT=Development \
  ConnectionStrings__Relay="Data Source=$TEST_TMP_DIR/relay.db" \
    dotnet run --project relay/FamilyCircle.Relay.csproj --no-launch-profile --no-restore \
      >"$RELAY_LOG" 2>&1 &
  RELAY_PID=$!

  relay_ready=0
  for _ in {1..120}; do
    if curl --silent --fail "$RELAY_URL/healthz" >/dev/null 2>&1; then
      relay_ready=1
      break
    fi
    if ! kill -0 "$RELAY_PID" 2>/dev/null; then
      echo "The isolated relay exited before becoming ready:" >&2
      cat "$RELAY_LOG" >&2
      RELAY_PID=""
      return 1
    fi
    sleep 0.25
  done

  if ((relay_ready == 0)); then
    echo "The isolated relay did not become ready at $RELAY_URL:" >&2
    cat "$RELAY_LOG" >&2
    return 1
  fi

  local test_status=0
  FC_STRESS_RELAY="$RELAY_URL" cargo test \
    -p crypto-core --test relay_scaling -- --ignored --nocapture || test_status=$?

  kill "$RELAY_PID" 2>/dev/null || true
  wait "$RELAY_PID" 2>/dev/null || true
  RELAY_PID=""
  rm -rf -- "$TEST_TMP_DIR"
  TEST_TMP_DIR=""
  return "$test_status"
}

print_summary() {
  local passed=0
  local failed=0
  local skipped=0
  local index

  section "Test overview"
  printf '%-38s %-9s %s\n' "SUITE" "RESULT" "DURATION"
  printf '%-38s %-9s %s\n' "--------------------------------------" "---------" "--------"
  for index in "${!RESULT_NAMES[@]}"; do
    printf '%-38s %-9s %s\n' \
      "${RESULT_NAMES[$index]}" \
      "${RESULT_STATUSES[$index]}" \
      "${RESULT_DURATIONS[$index]}"
    case "${RESULT_STATUSES[$index]}" in
      PASSED) ((passed += 1)) ;;
      FAILED) ((failed += 1)) ;;
      SKIPPED) ((skipped += 1)) ;;
    esac
  done
  printf '\nSuites: %d passed, %d failed, %d skipped, %d total\n' \
    "$passed" "$failed" "$skipped" "${#RESULT_NAMES[@]}"

  if ((failed == 0)); then
    echo "Overall result: PASSED"
  else
    echo "Overall result: FAILED"
  fi
}

run_suite "Rust tests" rust_tests
run_suite "Python map gateway tests" python_tests
run_suite "Smoke runner lifecycle tests" smoke_runner_tests
run_suite "Mobile behavior tests" mobile_tests
run_suite "Mobile TypeScript check" mobile_typecheck

if ((RUN_ANDROID)); then
  run_suite "Android bridge tests" android_tests
else
  skip_suite "Android bridge tests"
fi

run_suite "C# relay tests" csharp_tests

if ((RUN_SCALING)); then
  run_suite "Rust HTTP scaling test" scaling_test
else
  skip_suite "Rust HTTP scaling test"
fi

print_summary
exit "$OVERALL_FAILED"
