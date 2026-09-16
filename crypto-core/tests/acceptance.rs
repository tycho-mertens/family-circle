use rand::seq::SliceRandom;

use crypto_core::{
    compute_backup_proof, derive_backup_credentials_from_seed_phrase, generate_seed_phrase,
    random_bytes, CryptoCore, CryptoCoreError, EncryptedEnvelope,
};

struct AdversarialRelay {
    envelopes: Vec<EncryptedEnvelope>,
}

impl AdversarialRelay {
    fn new() -> Self {
        Self {
            envelopes: Vec::new(),
        }
    }

    fn deliver(&mut self, envelope: EncryptedEnvelope) {
        self.envelopes.push(envelope);
    }

    /// Returns delivered envelopes duplicated and shuffled, to exercise
    /// replay and reorder handling on the receiving end.
    fn adversarial_fetch(&self) -> Vec<EncryptedEnvelope> {
        let mut out = self.envelopes.clone();
        out.extend(self.envelopes.iter().cloned()); // duplicate everything once
        let mut rng = rand::thread_rng();
        out.shuffle(&mut rng);
        out
    }
}

struct Three {
    alice: CryptoCore,
    bob: CryptoCore,
    carol: CryptoCore,
    circle: String,
    alice_id: String,
    bob_id: String,
}

impl Three {
    /// Alice removes Bob. Carol and Bob both process the commit, the way a
    /// relay fans it out to everyone who was a member in that epoch. Bob
    /// processing his own removal has to succeed and leave his group
    /// inactive, not error.
    fn remove_bob(&mut self) {
        let commit = self
            .alice
            .remove_member(&self.circle, &self.bob_id)
            .unwrap();
        self.carol
            .process_commit(&self.circle, &commit.commit_bytes)
            .unwrap();
        self.bob
            .process_commit(&self.circle, &commit.commit_bytes)
            .unwrap();
    }
}

/// Alice's Circle, with Bob added and then Carol. Also returns an envelope
/// Alice sent while only she and Bob were in it.
fn three_members() -> (Three, EncryptedEnvelope) {
    let mut alice = CryptoCore::new().unwrap();
    let mut bob = CryptoCore::new().unwrap();
    let mut carol = CryptoCore::new().unwrap();
    let alice_id = alice.identity().device_id;
    let bob_id = bob.identity().device_id;
    let circle = alice.create_circle().unwrap().circle_id;

    let bob_kp = bob.create_key_package().unwrap();
    alice.add_member(&circle, &bob_kp).unwrap();
    let welcome = alice.create_welcome(&circle, &bob_kp).unwrap();
    assert_eq!(bob.join_from_welcome(&welcome).unwrap(), circle);

    let before_carol = alice.encrypt_event(&circle, b"before-carol").unwrap();

    let carol_kp = carol.create_key_package().unwrap();
    let add = alice.add_member(&circle, &carol_kp).unwrap();
    // Bob did not author this commit, so he has to process it to reach the
    // new epoch.
    bob.process_commit(&circle, &add.commit_bytes).unwrap();
    let welcome = alice.create_welcome(&circle, &carol_kp).unwrap();
    assert_eq!(carol.join_from_welcome(&welcome).unwrap(), circle);

    (
        Three {
            alice,
            bob,
            carol,
            circle,
            alice_id,
            bob_id,
        },
        before_carol,
    )
}

#[test]
fn new_member_cannot_read_anything_sent_before_they_joined() {
    let (mut c, before_carol) = three_members();
    // Carol's tracked epoch is the one she joined at, which is already ahead
    // of this envelope.
    assert!(matches!(
        c.carol.decrypt_event(&c.circle, &before_carol),
        Err(CryptoCoreError::StaleEpoch { .. })
    ));
}

#[test]
fn decrypt_event_reports_the_mls_verified_sender() {
    let (mut c, _) = three_members();
    let sent = c.alice.encrypt_event(&c.circle, b"after-carol").unwrap();
    let read = c.carol.decrypt_event(&c.circle, &sent).unwrap();
    assert_eq!(read.plaintext, b"after-carol");
    assert_eq!(read.sender_device_id, c.alice_id);
}

#[test]
fn removed_member_cannot_read_later_events_while_the_rest_still_can() {
    let (mut c, _) = three_members();
    c.remove_bob();
    let after = c.alice.encrypt_event(&c.circle, b"after-removal").unwrap();
    // Removal is prospective. Bob keeps whatever he decrypted while he was a
    // member; nothing here can reach into where he put it.
    assert!(c.bob.decrypt_event(&c.circle, &after).is_err());
    let read = c.carol.decrypt_event(&c.circle, &after).unwrap();
    assert_eq!(read.plaintext, b"after-removal");
    assert_eq!(read.sender_device_id, c.alice_id);
}

#[test]
fn replayed_envelope_is_rejected_however_the_relay_reorders_it() {
    let (mut c, before_carol) = three_members();
    c.remove_bob();
    let mut relay = AdversarialRelay::new();
    relay.deliver(before_carol);
    let after = c.alice.encrypt_event(&c.circle, b"after-removal").unwrap();
    relay.deliver(after.clone());
    c.carol.decrypt_event(&c.circle, &after).unwrap();

    // adversarial_fetch duplicates and shuffles everything it holds. Carol has
    // already consumed this event, so every further sighting of it, the
    // original included, has to be a no-op rather than a second delivery.
    let mut sightings = 0;
    for envelope in relay.adversarial_fetch() {
        if envelope.event_id == after.event_id {
            assert!(matches!(
                c.carol.decrypt_event(&c.circle, &envelope),
                Err(CryptoCoreError::AlreadyProcessed(_))
            ));
            sightings += 1;
        }
    }
    assert!(sightings >= 2);
}

#[test]
fn stale_epoch_event_is_rejected_after_the_commit_that_supersedes_it() {
    let (mut c, _) = three_members();
    let stale = c.alice.encrypt_event(&c.circle, b"old epoch").unwrap();
    c.remove_bob();
    assert!(matches!(
        c.carol.decrypt_event(&c.circle, &stale),
        Err(CryptoCoreError::StaleEpoch { .. })
    ));
}

#[test]
fn member_can_propose_to_leave_and_another_member_commits_it() {
    let (mut c, _) = three_members();

    // A plain self-removal fails loudly. Pin the rejection that the
    // propose-then-someone-else-commits flow below exists to work around.
    assert!(c.bob.remove_member(&c.circle, &c.bob_id).is_err());

    // Every member has to see the proposal, not just the committer: a Commit
    // references queued proposals by reference, so a member who never saw the
    // proposal cannot resolve that reference when the Commit arrives.
    let proposal = c.bob.propose_leave(&c.circle).unwrap();
    c.alice.process_proposal(&c.circle, &proposal).unwrap();
    c.carol.process_proposal(&c.circle, &proposal).unwrap();
    let commit = c.alice.commit_pending_proposals(&c.circle).unwrap();
    c.carol
        .process_commit(&c.circle, &commit.commit_bytes)
        .unwrap();
    // Bob receives the commit finalizing his own departure too.
    c.bob
        .process_commit(&c.circle, &commit.commit_bytes)
        .unwrap();

    for view in [
        c.alice.list_members(&c.circle).unwrap(),
        c.carol.list_members(&c.circle).unwrap(),
        // Bob's own view drops him as well, same as for a forced removal.
        c.bob.list_members(&c.circle).unwrap(),
    ] {
        assert!(!view.contains(&c.bob_id));
    }
    assert!(c.bob.encrypt_event(&c.circle, b"after leaving").is_err());
}

#[test]
fn backup_export_import_round_trip_and_wrong_seed_phrase_rejected() {
    let mut alice = CryptoCore::new().unwrap();

    let phrase = generate_seed_phrase().unwrap();
    let wrong_phrase = generate_seed_phrase().unwrap();
    assert_ne!(phrase, wrong_phrase);

    let (mut bob, bob_credentials) = CryptoCore::from_seed_phrase(&phrase).unwrap();
    let bob_id = bob.identity().device_id;

    let circle = alice.create_circle().unwrap();
    let circle_id = circle.circle_id;

    let bob_kp = bob.create_key_package().unwrap();
    alice.add_member(&circle_id, &bob_kp).unwrap();
    let welcome_for_bob = alice.create_welcome(&circle_id, &bob_kp).unwrap();
    assert_eq!(bob.join_from_welcome(&welcome_for_bob).unwrap(), circle_id);

    // Process a message before backup so we can check that replay state survives restore.
    let before_loss = alice.encrypt_event(&circle_id, b"before-loss").unwrap();
    let bob_reads_before_loss = bob.decrypt_event(&circle_id, &before_loss).unwrap();
    assert_eq!(bob_reads_before_loss.plaintext, b"before-loss");

    // Creation and restore must derive the same keys from the phrase.
    let keys = derive_backup_credentials_from_seed_phrase(phrase.clone()).unwrap();
    assert_eq!(keys.backup_id, bob_credentials.backup_id,);
    assert_eq!(keys.auth_key, bob_credentials.auth_key);
    assert_eq!(keys.enc_key, bob_credentials.enc_key);
    let keys_again = derive_backup_credentials_from_seed_phrase(phrase.clone()).unwrap();
    assert_eq!(keys.auth_key, keys_again.auth_key);
    assert_eq!(keys.enc_key, keys_again.enc_key);
    // Independent subkeys. The relay is given auth_key, so these sharing
    // bytes would hand it the backup encryption key too.
    assert_ne!(keys.auth_key, keys.enc_key);

    let wrong_keys = derive_backup_credentials_from_seed_phrase(wrong_phrase.clone()).unwrap();
    assert_ne!(keys.backup_id, wrong_keys.backup_id,);

    // A mistyped word is rejected here, before any network call. Use a word
    // that is not in the BIP39 list at all: swapping two valid words only
    // usually breaks the checksum, which would make this test flaky.
    let mut words: Vec<&str> = phrase.split_whitespace().collect();
    words[0] = "zzznotabip39word";
    let mistyped_phrase = words.join(" ");
    let mistyped_attempt = derive_backup_credentials_from_seed_phrase(mistyped_phrase);
    assert!(matches!(
        mistyped_attempt,
        Err(CryptoCoreError::InvalidSeedPhrase(_))
    ),);

    // Challenge-response proof: the right key verifies, a wrong one does not.
    let nonce = b"a-relay-issued-single-use-nonce".to_vec();
    let proof = compute_backup_proof(keys.auth_key.clone(), nonce.clone()).unwrap();
    let proof_recomputed = compute_backup_proof(keys.auth_key.clone(), nonce.clone()).unwrap();
    assert_eq!(proof, proof_recomputed);
    let forged_proof = compute_backup_proof(wrong_keys.auth_key.clone(), nonce).unwrap();
    assert_ne!(proof, forged_proof);

    // Export, lose the device, restore from nothing but the backup.
    // app_metadata is opaque to crypto-core, so check it comes back verbatim
    // rather than being quietly dropped.
    let app_metadata = b"{\"mailboxId\":\"abc123\",\"isCreator\":true}".to_vec();
    let exported = bob
        .export_encrypted_state(&keys.enc_key, &app_metadata)
        .unwrap();
    drop(bob); // the original device is gone, only `exported` + the seed phrase survive

    let wrong_key_attempt = CryptoCore::import_encrypted_state(&wrong_keys.enc_key, &exported);
    assert!(matches!(
        wrong_key_attempt,
        Err(CryptoCoreError::BackupDecryptFailed)
    ),);

    let mut tampered = exported.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 0xFF;
    let tampered_attempt = CryptoCore::import_encrypted_state(&keys.enc_key, &tampered);
    assert!(matches!(
        tampered_attempt,
        Err(CryptoCoreError::BackupDecryptFailed)
    ),);

    let (mut restored_bob, restored_app_metadata) =
        CryptoCore::import_encrypted_state(&keys.enc_key, &exported).unwrap();
    assert_eq!(restored_bob.identity().device_id, bob_id);
    // Byte-for-byte, and never examined by this crate.
    assert_eq!(restored_app_metadata, app_metadata);

    // AlreadyProcessed confirms that restore preserved the replay record,
    // not just the device ID and group membership.
    let restored_bob_rereads_before_loss = restored_bob.decrypt_event(&circle_id, &before_loss);
    assert!(
        matches!(
            restored_bob_rereads_before_loss,
            Err(CryptoCoreError::AlreadyProcessed(_))
        ),
        "restored state must remember before-loss was already processed, proving it's real \
         restored state rather than a hollow fresh identity"
    );

    // ...and participate normally afterward, in both directions.
    let after_restore_from_alice = alice
        .encrypt_event(&circle_id, b"after-restore-from-alice")
        .unwrap();
    let restored_bob_reads_after_restore = restored_bob
        .decrypt_event(&circle_id, &after_restore_from_alice)
        .unwrap();
    assert_eq!(
        restored_bob_reads_after_restore.plaintext,
        b"after-restore-from-alice"
    );

    let from_restored_bob = restored_bob
        .encrypt_event(&circle_id, b"from-restored-bob")
        .unwrap();
    let alice_reads_from_restored_bob =
        alice.decrypt_event(&circle_id, &from_restored_bob).unwrap();
    assert_eq!(
        alice_reads_from_restored_bob.plaintext,
        b"from-restored-bob"
    );
    assert_eq!(alice_reads_from_restored_bob.sender_device_id, bob_id);
}

#[test]
fn random_bytes_is_length_bounded_and_actually_random() {
    let a = random_bytes(16).unwrap();
    assert_eq!(a.len(), 16);
    let b = random_bytes(16).unwrap();
    assert_ne!(a, b);

    let zero = random_bytes(0).unwrap();
    assert_eq!(zero.len(), 0);

    let too_big = random_bytes(1_000_000);
    assert!(matches!(too_big, Err(CryptoCoreError::Mls(_))),);
}
