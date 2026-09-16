//! Run with: `cargo run --bin uniffi-bindgen -- generate --library <path-to-.so> --language kotlin --out-dir <dir>`
/// Run UniFFI's binding generator; build-android.sh uses it to produce the Kotlin API.
fn main() {
    uniffi::uniffi_bindgen_main();
}
