#!/usr/bin/env bash
# Requires cargo-ndk, ANDROID_NDK_HOME, and the aarch64-linux-android /
# x86_64-linux-android Rust targets.
set -euo pipefail
cd "$(dirname "$0")"

: "${ANDROID_NDK_HOME:?Set ANDROID_NDK_HOME to your Android NDK install (e.g. \$ANDROID_HOME/ndk/<version>)}"

MOBILE_MODULE="../mobile/modules/family-circle-bridge/android/src/main"
BINDGEN_OUT="$(mktemp -d)"
trap 'rm -rf "$BINDGEN_OUT"' EXIT

echo "==> Cross-compiling libcrypto_core.so for Android (arm64-v8a, x86_64)"
cargo ndk -t arm64-v8a -t x86_64 -o "$MOBILE_MODULE/jniLibs" build --release

echo "==> Building a host copy for UniFFI bindgen"
cargo build --release

echo "==> Generating Kotlin bindings"
cargo run --bin uniffi-bindgen -- generate \
  --library ../target/release/libcrypto_core.so \
  --language kotlin \
  --out-dir "$BINDGEN_OUT" \
  --no-format

rm -rf "$MOBILE_MODULE/java/uniffi"
mkdir -p "$MOBILE_MODULE/java"
mv "$BINDGEN_OUT/uniffi" "$MOBILE_MODULE/java/uniffi"

echo "==> Done. Native bridge rebuilt under $MOBILE_MODULE"
