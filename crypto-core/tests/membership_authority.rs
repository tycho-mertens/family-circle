mod common;

use common::authority_bound_pair;
use crypto_core::{CryptoCore, CryptoCoreError};

#[test]
fn rollback_after_rejected_commit_preserves_later_traffic_across_restart() {
    for malformed in [false, true] {
        let mut admin = CryptoCore::new().unwrap();
        let admin_id = admin.identity().device_id;
        let circle = admin.create_circle().unwrap().circle_id;
        let mut recipient = CryptoCore::new().unwrap();
        let joined = admin
            .prepare_membership_change(&circle, &recipient.create_key_package().unwrap(), &[])
            .unwrap();
        admin.process_commit(&circle, &joined.commit_bytes).unwrap();
        recipient
            .join_from_welcome_with_admin(&joined.welcome_bytes.unwrap(), Some(admin_id.clone()))
            .unwrap();

        let mut attacker = CryptoCore::new().unwrap();
        let joined = admin
            .prepare_membership_change(&circle, &attacker.create_key_package().unwrap(), &[])
            .unwrap();
        admin.process_commit(&circle, &joined.commit_bytes).unwrap();
        recipient
            .process_commit(&circle, &joined.commit_bytes)
            .unwrap();
        attacker
            .join_from_welcome_with_admin(&joined.welcome_bytes.unwrap(), Some(admin_id.clone()))
            .unwrap();
        attacker
            .adopt_membership_admin(&circle, &admin_id, &attacker.identity().device_id)
            .unwrap();
        let mut unauthorized_device = CryptoCore::new().unwrap();
        let hostile = attacker
            .prepare_membership_change(
                &circle,
                &unauthorized_device.create_key_package().unwrap(),
                &[],
            )
            .unwrap();

        let key = [42u8; 32];
        let before_members = recipient.list_members(&circle).unwrap();
        let before_epoch = recipient.circle_publication_state(&circle).unwrap().epoch;
        let checkpoint = recipient
            .export_encrypted_state(&key, b"before rejection")
            .unwrap();
        let result = if malformed {
            recipient.process_commit(&circle, &[0])
        } else {
            recipient.process_commit(&circle, &hostile.commit_bytes)
        };
        if malformed {
            assert!(matches!(result, Err(CryptoCoreError::InvalidControl)));
        } else {
            assert!(matches!(
                result,
                Err(CryptoCoreError::UnauthorizedMembershipCommit { .. })
            ));
        }
        assert_eq!(recipient.list_members(&circle).unwrap(), before_members);
        assert_eq!(
            recipient.circle_publication_state(&circle).unwrap().epoch,
            before_epoch
        );

        // Match native transaction abort: discard every processing side effect,
        // not just the visible membership list. Then save the rejection decision
        // with that restored state and simulate another process restart.
        (recipient, _) = CryptoCore::import_encrypted_state(&key, &checkpoint).unwrap();
        let disposition = recipient
            .export_encrypted_state(&key, b"rejected sequence 1")
            .unwrap();
        let (restored, metadata) = CryptoCore::import_encrypted_state(&key, &disposition).unwrap();
        recipient = restored;
        assert_eq!(metadata, b"rejected sequence 1");
        let old = admin
            .encrypt_event(&circle, b"legitimate old epoch")
            .unwrap();
        assert_eq!(
            recipient.decrypt_event(&circle, &old).unwrap().plaintext,
            b"legitimate old epoch"
        );

        let mut invited = CryptoCore::new().unwrap();
        let authorized = admin
            .prepare_membership_change(&circle, &invited.create_key_package().unwrap(), &[])
            .unwrap();
        admin
            .process_commit(&circle, &authorized.commit_bytes)
            .unwrap();
        recipient
            .process_commit(&circle, &authorized.commit_bytes)
            .unwrap();
        let members = recipient.list_members(&circle).unwrap();
        assert!(members.contains(&invited.identity().device_id));
        assert!(!members.contains(&unauthorized_device.identity().device_id));
        assert_eq!(
            recipient.circle_publication_state(&circle).unwrap().epoch,
            before_epoch + 1
        );
        let checkpoint = recipient
            .export_encrypted_state(&key, b"authorized commit applied")
            .unwrap();
        (recipient, _) = CryptoCore::import_encrypted_state(&key, &checkpoint).unwrap();
        let new = admin
            .encrypt_event(&circle, b"legitimate new epoch")
            .unwrap();
        assert_eq!(
            recipient.decrypt_event(&circle, &new).unwrap().plaintext,
            b"legitimate new epoch"
        );
        let reply = recipient
            .encrypt_event(&circle, b"sending resumed")
            .unwrap();
        assert_eq!(
            admin.decrypt_event(&circle, &reply).unwrap().plaintext,
            b"sending resumed"
        );
    }
}

#[test]
fn only_proven_invalid_commit_input_gets_a_permanent_classification() {
    let (mut admin, mut member, circle) = authority_bound_pair();
    for bytes in [vec![], vec![0], vec![0, 1], vec![0, 1, 0, 255]] {
        assert!(matches!(
            member.process_commit(&circle, &bytes),
            Err(CryptoCoreError::InvalidControl)
        ));
    }
    // Unknown versions must not be parsed using the current message layout.
    assert!(matches!(
        member.process_commit(&circle, &[0, 2]),
        Err(CryptoCoreError::Mls(_))
    ));
    assert!(matches!(
        member.process_commit("missing", &[0]),
        Err(CryptoCoreError::CircleNotFound(_))
    ));

    let chat = admin.encrypt_event(&circle, b"not a commit").unwrap();
    assert!(matches!(
        member.process_commit(&circle, &chat.ciphertext),
        Err(CryptoCoreError::InvalidControl)
    ));
    assert_eq!(
        member.decrypt_event(&circle, &chat).unwrap().plaintext,
        b"not a commit"
    );

    let first = admin.prepare_membership_change(&circle, &[], &[]).unwrap();
    let mut trailing = first.commit_bytes.clone();
    trailing.push(0);
    assert!(matches!(
        member.process_commit(&circle, &trailing),
        Err(CryptoCoreError::InvalidControl)
    ));
    admin.process_commit(&circle, &first.commit_bytes).unwrap();
    let future = admin.prepare_membership_change(&circle, &[], &[]).unwrap();
    assert!(matches!(
        member.process_commit(&circle, &future.commit_bytes),
        Err(CryptoCoreError::Mls(_))
    ));
    member.process_commit(&circle, &first.commit_bytes).unwrap();
    member
        .process_commit(&circle, &future.commit_bytes)
        .unwrap();
}

#[test]
fn competing_prepared_commit_is_not_classified_as_discardable() {
    let (mut admin, mut member, circle) = authority_bound_pair();
    let admin_id = admin.identity().device_id;
    member
        .adopt_membership_admin(&circle, &admin_id, &member.identity().device_id)
        .unwrap();
    let hostile = member.prepare_membership_change(&circle, &[], &[]).unwrap();
    let own = admin.prepare_membership_change(&circle, &[], &[]).unwrap();
    assert!(matches!(
        admin.process_commit(&circle, &hostile.commit_bytes),
        Err(CryptoCoreError::Mls(_))
    ));
    assert!(
        admin
            .circle_publication_state(&circle)
            .unwrap()
            .pending_commit
    );
    admin.process_commit(&circle, &own.commit_bytes).unwrap();
    assert!(
        !admin
            .circle_publication_state(&circle)
            .unwrap()
            .pending_commit
    );
}

#[test]
fn hostile_member_commit_is_rejected_before_merging() {
    let mut owner = CryptoCore::new().unwrap();
    let owner_id = owner.identity().device_id;
    let circle = owner.create_circle().unwrap().circle_id;

    let mut member = CryptoCore::new().unwrap();
    let member_id = member.identity().device_id;
    let join = owner
        .prepare_membership_change(&circle, &member.create_key_package().unwrap(), &[])
        .unwrap();
    owner.process_commit(&circle, &join.commit_bytes).unwrap();
    member
        .join_from_welcome_with_admin(&join.welcome_bytes.unwrap(), Some(owner_id.clone()))
        .unwrap();

    // A hostile client can alter its own local authority setting and create a
    // valid MLS commit. Honest members still inspect MLS's authenticated
    // committer credential and reject it before merging the staged commit.
    member
        .adopt_membership_admin(&circle, &owner_id, &member_id)
        .unwrap();
    let mut attacker_device = CryptoCore::new().unwrap();
    let hostile = member
        .prepare_membership_change(&circle, &attacker_device.create_key_package().unwrap(), &[])
        .unwrap();
    assert!(
        matches!(owner.process_commit(&circle, &hostile.commit_bytes),
        Err(CryptoCoreError::UnauthorizedMembershipCommit { ref committer, ref administrator })
            if committer == &member_id && administrator == &owner_id)
    );
    assert_eq!(
        owner.list_members(&circle).unwrap(),
        vec![owner_id.clone(), member_id.clone()]
    );
}

#[test]
fn bound_admin_changes_and_verified_transfer_recover_authority() {
    let mut owner = CryptoCore::new().unwrap();
    let owner_id = owner.identity().device_id;
    let circle = owner.create_circle().unwrap().circle_id;
    let mut member = CryptoCore::new().unwrap();
    let member_id = member.identity().device_id;
    let join = owner
        .prepare_membership_change(&circle, &member.create_key_package().unwrap(), &[])
        .unwrap();
    owner.process_commit(&circle, &join.commit_bytes).unwrap();
    member
        .join_from_welcome_with_admin(&join.welcome_bytes.unwrap(), Some(owner_id.clone()))
        .unwrap();

    // The bound administrator can make a normal add, and every compliant
    // recipient accepts the same commit.
    let mut invited = CryptoCore::new().unwrap();
    let authorized = owner
        .prepare_membership_change(&circle, &invited.create_key_package().unwrap(), &[])
        .unwrap();
    owner
        .process_commit(&circle, &authorized.commit_bytes)
        .unwrap();
    member
        .process_commit(&circle, &authorized.commit_bytes)
        .unwrap();
    invited
        .join_from_welcome_with_admin(&authorized.welcome_bytes.unwrap(), Some(owner_id.clone()))
        .unwrap();

    // Apply the transfer directly to the owner and successor's local policies.
    // Check that the owner accepts a later commit from the successor; the
    // app's authentication and delivery of the transfer are outside this test.
    owner
        .adopt_membership_admin(&circle, &owner_id, &member_id)
        .unwrap();
    member
        .adopt_membership_admin(&circle, &owner_id, &member_id)
        .unwrap();
    let mut recovery_joiner = CryptoCore::new().unwrap();
    let recovery = member
        .prepare_membership_change(&circle, &recovery_joiner.create_key_package().unwrap(), &[])
        .unwrap();
    owner
        .process_commit(&circle, &recovery.commit_bytes)
        .unwrap();
    recovery_joiner
        .join_from_welcome_with_admin(&recovery.welcome_bytes.unwrap(), Some(member_id))
        .unwrap();
    assert_eq!(owner.list_members(&circle).unwrap().len(), 4);
}

#[test]
fn welcome_without_authority_binding_cannot_silently_gain_membership_authority() {
    let mut owner = CryptoCore::new().unwrap();
    let circle = owner.create_circle().unwrap().circle_id;
    // The compatibility welcome intentionally has no authority binding.
    let mut legacy = CryptoCore::new().unwrap();
    let change = owner
        .prepare_membership_change(&circle, &legacy.create_key_package().unwrap(), &[])
        .unwrap();
    owner.process_commit(&circle, &change.commit_bytes).unwrap();
    legacy
        .join_from_welcome(&change.welcome_bytes.unwrap())
        .unwrap();
    assert!(matches!(
        legacy.prepare_membership_change(&circle, &[], &[]),
        Err(CryptoCoreError::LegacyMembershipAuthority)
    ));
}
