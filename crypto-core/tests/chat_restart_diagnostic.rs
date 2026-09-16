use crypto_core::CryptoCore;

fn pair() -> (CryptoCore, CryptoCore, String) {
    let mut alice = CryptoCore::new().unwrap();
    let mut bob = CryptoCore::new().unwrap();
    let circle = alice.create_circle().unwrap().circle_id;
    let kp = bob.create_key_package().unwrap();
    alice.add_member(&circle, &kp).unwrap();
    let welcome = alice.create_welcome(&circle, &kp).unwrap();
    bob.join_from_welcome(&welcome).unwrap();
    (alice, bob, circle)
}

#[test]
fn stale_sender_checkpoint_rejects_new_messages_until_sender_catches_up() {
    let (mut alice, mut bob, circle) = pair();
    let key = vec![42; 32];
    let checkpoint = alice.export_encrypted_state(&key, b"{}").unwrap();
    for i in 0..3 {
        let message = alice
            .encrypt_event(&circle, format!("before-{i}").as_bytes())
            .unwrap();
        bob.decrypt_event(&circle, &message).unwrap();
    }
    let (mut restarted, _) = CryptoCore::import_encrypted_state(&key, &checkpoint).unwrap();
    for i in 0..3 {
        let message = restarted
            .encrypt_event(&circle, format!("after-{i}").as_bytes())
            .unwrap();
        let error = bob.decrypt_event(&circle, &message).unwrap_err();
        println!("new message {i} after sender restart: {error}");
        assert!(error
            .to_string()
            .contains("deleted to preserve forward secrecy"));
    }
    let message = restarted.encrypt_event(&circle, b"caught-up").unwrap();
    assert_eq!(
        bob.decrypt_event(&circle, &message).unwrap().plaintext,
        b"caught-up"
    );
}

#[test]
fn own_relay_echo_after_restart_is_not_a_peer_message() {
    let (mut alice, mut bob, circle) = pair();
    let key = vec![42; 32];
    let checkpoint = alice.export_encrypted_state(&key, b"{}").unwrap();
    let message = alice.encrypt_event(&circle, b"own message").unwrap();
    bob.decrypt_event(&circle, &message).unwrap();
    let (mut restarted, _) = CryptoCore::import_encrypted_state(&key, &checkpoint).unwrap();
    let error = restarted.decrypt_event(&circle, &message).unwrap_err();
    println!("own echo after stale restart: {error}");
    assert!(matches!(error, crypto_core::CryptoCoreError::OwnMessage));
    // Fetching the old outgoing envelope doesn't repair the sender's ratchet.
    let next = restarted
        .encrypt_event(&circle, b"new outgoing message")
        .unwrap();
    let error = bob.decrypt_event(&circle, &next).unwrap_err();
    assert!(error
        .to_string()
        .contains("deleted to preserve forward secrecy"));
}

#[test]
fn current_checkpoint_preserves_bidirectional_chat_after_restart() {
    let (mut alice, mut bob, circle) = pair();
    let key = vec![42; 32];
    let message = alice.encrypt_event(&circle, b"before").unwrap();
    bob.decrypt_event(&circle, &message).unwrap();
    let checkpoint = alice.export_encrypted_state(&key, b"{}").unwrap();
    let (mut restarted, _) = CryptoCore::import_encrypted_state(&key, &checkpoint).unwrap();
    let message = restarted.encrypt_event(&circle, b"after").unwrap();
    assert_eq!(
        bob.decrypt_event(&circle, &message).unwrap().plaintext,
        b"after"
    );
    let reply = bob.encrypt_event(&circle, b"reply").unwrap();
    assert_eq!(
        restarted.decrypt_event(&circle, &reply).unwrap().plaintext,
        b"reply"
    );
}

#[test]
fn repeated_durable_restarts_preserve_chat_in_both_directions() {
    let (mut alice, mut bob, circle) = pair();
    let key = vec![42; 32];
    for index in 0..12 {
        let outgoing = alice
            .encrypt_event(&circle, format!("alice-{index}").as_bytes())
            .unwrap();
        // State is committed before upload; simulate death before Bob sees it.
        let saved = alice
            .export_encrypted_state(&key, b"pending-envelope")
            .unwrap();
        alice = CryptoCore::import_encrypted_state(&key, &saved).unwrap().0;
        assert_eq!(
            bob.decrypt_event(&circle, &outgoing).unwrap().plaintext,
            format!("alice-{index}").as_bytes()
        );
        let saved = bob
            .export_encrypted_state(&key, b"received-cursor")
            .unwrap();
        bob = CryptoCore::import_encrypted_state(&key, &saved).unwrap().0;
        assert!(matches!(
            bob.decrypt_event(&circle, &outgoing),
            Err(crypto_core::CryptoCoreError::AlreadyProcessed(_))
        ));
        let reply = bob
            .encrypt_event(&circle, format!("bob-{index}").as_bytes())
            .unwrap();
        let saved = bob.export_encrypted_state(&key, b"pending-reply").unwrap();
        bob = CryptoCore::import_encrypted_state(&key, &saved).unwrap().0;
        assert_eq!(
            alice.decrypt_event(&circle, &reply).unwrap().plaintext,
            format!("bob-{index}").as_bytes()
        );
    }
}

#[test]
fn offline_member_catches_up_membership_updates_without_reinvitation() {
    let (mut alice, mut bob, circle) = pair();
    let mut carol = CryptoCore::new().unwrap();
    let kp = carol.create_key_package().unwrap();
    let added = alice.add_member(&circle, &kp).unwrap();
    carol
        .join_from_welcome(&alice.create_welcome(&circle, &kp).unwrap())
        .unwrap();
    let update = alice.refresh_circle_keys(&circle).unwrap();
    let chat = alice
        .encrypt_event(&circle, b"after offline updates")
        .unwrap();
    bob.process_commit(&circle, &added.commit_bytes).unwrap();

    // Bob dies halfway through catch-up. Cursor + state preserve this progress.
    let key = vec![42; 32];
    let saved = bob.export_encrypted_state(&key, b"after-add").unwrap();
    bob = CryptoCore::import_encrypted_state(&key, &saved).unwrap().0;
    assert!(matches!(
        bob.process_commit(&circle, &added.commit_bytes),
        Err(crypto_core::CryptoCoreError::StaleEpoch { .. })
    ));
    bob.process_commit(&circle, &update.commit_bytes).unwrap();
    assert_eq!(
        bob.decrypt_event(&circle, &chat).unwrap().plaintext,
        b"after offline updates"
    );
    let reply = bob.encrypt_event(&circle, b"back online").unwrap();
    assert_eq!(
        alice.decrypt_event(&circle, &reply).unwrap().plaintext,
        b"back online"
    );
}

#[test]
fn creator_refreshes_stale_sender_backup_without_reusing_message_secrets() {
    let (mut alice, mut bob, circle) = pair();
    let key = vec![42; 32];
    let saved = alice.export_encrypted_state(&key, b"old-backup").unwrap();
    for _ in 0..5 {
        let chat = alice.encrypt_event(&circle, b"before loss").unwrap();
        bob.decrypt_event(&circle, &chat).unwrap();
    }
    let (mut restored, _) = CryptoCore::import_encrypted_state(&key, &saved).unwrap();
    let update = restored.refresh_circle_keys(&circle).unwrap();
    bob.process_commit(&circle, &update.commit_bytes).unwrap();
    let chat = restored.encrypt_event(&circle, b"fresh epoch").unwrap();
    assert_eq!(
        bob.decrypt_event(&circle, &chat).unwrap().plaintext,
        b"fresh epoch"
    );
}
