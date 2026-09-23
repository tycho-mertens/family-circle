#![allow(dead_code)] // Each integration-test binary uses a different slice of these fixtures.

use crypto_core::CryptoCore;

const TEST_BACKUP_KEY: [u8; 32] = [42; 32];

/// Builds the two-member Circle used by the restart tests. Most tests care
/// about ratchet behavior, so keeping the invitation ceremony here leaves each
/// scenario focused on the state transition it is trying to prove.
pub fn joined_pair() -> (CryptoCore, CryptoCore, String) {
    let mut alice = CryptoCore::new().unwrap();
    let mut bob = CryptoCore::new().unwrap();
    let circle = alice.create_circle().unwrap().circle_id;

    let key_package = bob.create_key_package().unwrap();
    alice.add_member(&circle, &key_package).unwrap();
    let welcome = alice.create_welcome(&circle, &key_package).unwrap();
    bob.join_from_welcome(&welcome).unwrap();

    (alice, bob, circle)
}

/// Same small Circle, but with the creator bound as membership authority.
/// Staged-membership tests need that policy while ordinary chat tests do not.
pub fn authority_bound_pair() -> (CryptoCore, CryptoCore, String) {
    let mut alice = CryptoCore::new().unwrap();
    let mut bob = CryptoCore::new().unwrap();
    let circle = alice.create_circle().unwrap().circle_id;
    let admin = alice.identity().device_id;

    let key_package = bob.create_key_package().unwrap();
    alice.add_member(&circle, &key_package).unwrap();
    let welcome = alice.create_welcome(&circle, &key_package).unwrap();
    bob.join_from_welcome_with_admin(&welcome, Some(admin))
        .unwrap();

    (alice, bob, circle)
}

/// Takes the same durable path as an application restart instead of cloning
/// in-memory state, which would miss serialization and restoration bugs.
pub fn restart(core: CryptoCore) -> CryptoCore {
    let saved = core
        .export_encrypted_state(&TEST_BACKUP_KEY, b"durable outbox and cursor")
        .unwrap();

    CryptoCore::import_encrypted_state(&TEST_BACKUP_KEY, &saved)
        .unwrap()
        .0
}
