use crypto_core::{CryptoCore, CryptoCoreError};

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
