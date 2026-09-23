mod common;

use common::{authority_bound_pair, restart};
use crypto_core::{CryptoCore, CryptoCoreError};

#[test]
fn admin_reads_messages_before_own_update_then_switches_at_its_relay_position() {
    let (mut alice, mut bob, circle) = authority_bound_pair();

    for _ in 0..8 {
        let before = alice.circle_publication_state(&circle).unwrap().epoch;
        let prepared = alice.prepare_membership_change(&circle, &[], &[]).unwrap();

        assert_eq!(
            alice.circle_publication_state(&circle).unwrap().epoch,
            before
        );
        assert!(
            alice
                .circle_publication_state(&circle)
                .unwrap()
                .pending_commit
        );
        assert!(alice.prepare_membership_change(&circle, &[], &[]).is_err());
        assert!(alice.encrypt_event(&circle, b"must wait").is_err());

        // Death before upload (or after acceptance but before its response)
        // preserves both the pending commit and the old receiving ratchet.
        alice = restart(alice);
        let old = bob
            .encrypt_event(&circle, b"arrived before commit")
            .unwrap();
        assert_eq!(
            alice.decrypt_event(&circle, &old).unwrap().plaintext,
            b"arrived before commit"
        );

        alice = restart(alice); // death after old message, before own echo
        alice
            .process_commit(&circle, &prepared.commit_bytes)
            .unwrap();
        alice = restart(alice); // death after confirmed local merge

        assert!(
            !alice
                .circle_publication_state(&circle)
                .unwrap()
                .pending_commit
        );
        assert_eq!(
            alice.circle_publication_state(&circle).unwrap().epoch,
            before + 1
        );
        assert!(matches!(
            alice.process_commit(&circle, &prepared.commit_bytes),
            Err(CryptoCoreError::StaleEpoch { .. })
        ));

        bob.process_commit(&circle, &prepared.commit_bytes).unwrap();
        let new = bob.encrypt_event(&circle, b"arrived after commit").unwrap();

        assert_eq!(
            alice.decrypt_event(&circle, &new).unwrap().plaintext,
            b"arrived after commit"
        );

        let reply = alice.encrypt_event(&circle, b"reply").unwrap();
        assert_eq!(
            bob.decrypt_event(&circle, &reply).unwrap().plaintext,
            b"reply"
        );
    }
}

#[test]
fn add_then_remove_keeps_old_messages_readable_until_each_confirmed_commit() {
    let (mut alice, mut bob, circle) = authority_bound_pair();
    let mut carol = CryptoCore::new().unwrap();
    let kp = carol.create_key_package().unwrap();
    let add = alice.prepare_membership_change(&circle, &kp, &[]).unwrap();

    assert_eq!(alice.list_members(&circle).unwrap().len(), 2);
    let chat = bob.encrypt_event(&circle, b"before carol joined").unwrap();
    assert_eq!(
        alice.decrypt_event(&circle, &chat).unwrap().plaintext,
        b"before carol joined"
    );

    alice = restart(alice);
    alice.process_commit(&circle, &add.commit_bytes).unwrap();
    bob.process_commit(&circle, &add.commit_bytes).unwrap();
    carol
        .join_from_welcome_with_admin(
            &add.welcome_bytes.unwrap(),
            Some(alice.identity().device_id),
        )
        .unwrap();

    assert_eq!(alice.list_members(&circle).unwrap().len(), 3);
    let removal = alice
        .prepare_membership_change(&circle, &[], &[carol.identity().device_id])
        .unwrap();
    let old = carol.encrypt_event(&circle, b"before removal").unwrap();

    assert_eq!(
        alice.decrypt_event(&circle, &old).unwrap().plaintext,
        b"before removal"
    );

    // Carol sends in the old epoch, but Alice receives it after merging the
    // removal. That in-flight message is rejected as StaleEpoch and is lost.
    let late = carol.encrypt_event(&circle, b"after removal").unwrap();
    alice
        .process_commit(&circle, &removal.commit_bytes)
        .unwrap();
    assert!(matches!(
        alice.decrypt_event(&circle, &late),
        Err(CryptoCoreError::StaleEpoch { .. })
    ));
    bob.process_commit(&circle, &removal.commit_bytes).unwrap();
    assert_eq!(alice.list_members(&circle).unwrap().len(), 2);
}

#[test]
fn leave_during_pending_update_is_verified_and_can_be_fulfilled_next_epoch() {
    let (mut alice, mut bob, circle) = authority_bound_pair();
    let update = alice.prepare_membership_change(&circle, &[], &[]).unwrap();

    let leave = bob.propose_leave(&circle).unwrap();
    let member = alice.process_leave(&circle, &leave).unwrap();
    assert_eq!(member, bob.identity().device_id);

    alice = restart(alice);
    alice.process_commit(&circle, &update.commit_bytes).unwrap();
    bob.process_commit(&circle, &update.commit_bytes).unwrap();
    let remove = alice
        .prepare_membership_change(&circle, &[], &[member])
        .unwrap();

    alice.process_commit(&circle, &remove.commit_bytes).unwrap();
    bob.process_commit(&circle, &remove.commit_bytes).unwrap();
    assert_eq!(alice.list_members(&circle).unwrap().len(), 1);
    assert!(bob.encrypt_event(&circle, b"removed").is_err());
}

#[test]
fn rejoin_replaces_the_stale_leaf_in_one_staged_commit() {
    let (mut alice, bob, circle) = authority_bound_pair();
    let mut restored_bob = restart(bob);
    let kp = restored_bob.create_key_package().unwrap();
    let change = alice
        .prepare_membership_change(&circle, &kp, &[restored_bob.identity().device_id])
        .unwrap();

    alice = restart(alice);
    alice.process_commit(&circle, &change.commit_bytes).unwrap();
    // Discard Bob's old local group and policy before installing the Welcome
    // for his replacement leaf in the same Circle.
    restored_bob.forget_circle(&circle).unwrap();
    restored_bob
        .join_from_welcome_with_admin(
            &change.welcome_bytes.unwrap(),
            Some(alice.identity().device_id),
        )
        .unwrap();

    let chat = restored_bob.encrypt_event(&circle, b"rejoined").unwrap();
    assert_eq!(
        alice.decrypt_event(&circle, &chat).unwrap().plaintext,
        b"rejoined"
    );
    assert_eq!(alice.list_members(&circle).unwrap().len(), 2);
}

#[test]
fn altered_own_echo_cannot_confirm_the_prepared_commit() {
    let (mut alice, mut bob, circle) = authority_bound_pair();
    let mut prepared = alice.prepare_membership_change(&circle, &[], &[]).unwrap();
    let epoch = alice.circle_publication_state(&circle).unwrap().epoch;
    let last = prepared.commit_bytes.len() - 1;
    prepared.commit_bytes[last] ^= 1;

    assert!(alice
        .process_commit(&circle, &prepared.commit_bytes)
        .is_err());
    assert_eq!(
        alice.circle_publication_state(&circle).unwrap().epoch,
        epoch
    );
    assert!(
        alice
            .circle_publication_state(&circle)
            .unwrap()
            .pending_commit
    );

    let chat = bob.encrypt_event(&circle, b"still old epoch").unwrap();
    assert_eq!(
        alice.decrypt_event(&circle, &chat).unwrap().plaintext,
        b"still old epoch"
    );
}

#[test]
fn competing_commit_fails_closed_without_losing_the_prepared_state() {
    let (mut alice, mut bob, circle) = authority_bound_pair();
    let prepared = alice.prepare_membership_change(&circle, &[], &[]).unwrap();
    let epoch = alice.circle_publication_state(&circle).unwrap().epoch;
    let alice_id = alice.identity().device_id;
    let bob_id = bob.identity().device_id;

    // Simulate a modified client that makes itself admin in its local policy.
    bob.adopt_membership_admin(&circle, &alice_id, &bob_id)
        .unwrap();
    let competing = bob.refresh_circle_keys(&circle).unwrap();

    assert!(alice
        .process_commit(&circle, &competing.commit_bytes)
        .unwrap_err()
        .to_string()
        .contains("competing membership"));

    alice = restart(alice);
    assert_eq!(
        alice.circle_publication_state(&circle).unwrap().epoch,
        epoch
    );
    assert!(
        alice
            .circle_publication_state(&circle)
            .unwrap()
            .pending_commit
    );
    // The failure did not discard or silently replace the prepared commit.
    alice
        .process_commit(&circle, &prepared.commit_bytes)
        .unwrap();
}

#[test]
fn creator_can_leave_and_successor_can_manage_the_remaining_circle() {
    let (mut alice, mut bob, circle) = authority_bound_pair();
    let alice_id = alice.identity().device_id;
    let bob_id = bob.identity().device_id;
    let proposal = alice.propose_leave(&circle).unwrap();

    assert_eq!(bob.process_leave(&circle, &proposal).unwrap(), alice_id);

    // Apply the transfer to both local policies before Alice leaves. This
    // exercises the policy change; it does not test transport authentication.
    alice
        .adopt_membership_admin(&circle, &alice_id, &bob_id)
        .unwrap();
    bob.adopt_membership_admin(&circle, &alice_id, &bob_id)
        .unwrap();
    bob = restart(bob);

    let change = bob
        .prepare_membership_change(&circle, &[], &[alice_id.clone()])
        .unwrap();
    bob.process_commit(&circle, &change.commit_bytes).unwrap();
    alice.process_commit(&circle, &change.commit_bytes).unwrap();
    assert!(!alice.list_members(&circle).unwrap().contains(&alice_id));
    assert!(alice.encrypt_event(&circle, b"no access").is_err());

    let mut carol = CryptoCore::new().unwrap();
    let kp = carol.create_key_package().unwrap();
    let add = bob.prepare_membership_change(&circle, &kp, &[]).unwrap();
    bob.process_commit(&circle, &add.commit_bytes).unwrap();
    carol
        .join_from_welcome_with_admin(&add.welcome_bytes.unwrap(), Some(bob_id))
        .unwrap();

    assert_eq!(bob.list_members(&circle).unwrap().len(), 2);
    let message = bob.encrypt_event(&circle, b"successor admin").unwrap();
    assert_eq!(
        carol.decrypt_event(&circle, &message).unwrap().plaintext,
        b"successor admin"
    );
}
