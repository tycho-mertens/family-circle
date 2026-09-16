use crypto_core::{CryptoCore, CryptoCoreError};

#[test]
fn sixteen_members_chat_restart_and_catch_up_across_membership_changes() {
    let mut members = vec![CryptoCore::new().unwrap()];
    let circle = members[0].create_circle().unwrap().circle_id;
    for _ in 1..16 {
        let mut joining = CryptoCore::new().unwrap();
        let kp = joining.create_key_package().unwrap();
        let change = members[0]
            .prepare_membership_change(&circle, &kp, &[])
            .unwrap();
        for member in &mut members {
            member
                .process_commit(&circle, &change.commit_bytes)
                .unwrap();
        }
        joining
            .join_from_welcome(&change.welcome_bytes.unwrap())
            .unwrap();
        members.push(joining);
    }
    assert!(members
        .iter()
        .all(|m| m.list_members(&circle).unwrap().len() == 16));
    // All senders prepare before anyone receives: independent sender ratchets.
    let mut deliveries = 0;
    for round in 0..4 {
        let envelopes: Vec<_> = members
            .iter_mut()
            .enumerate()
            .map(|(sender, member)| {
                member
                    .encrypt_event(&circle, format!("{round}:{sender}").as_bytes())
                    .unwrap()
            })
            .collect();
        for (receiver, member) in members.iter_mut().enumerate() {
            for (sender, envelope) in envelopes.iter().enumerate() {
                if sender == receiver {
                    continue;
                }
                assert_eq!(
                    member.decrypt_event(&circle, envelope).unwrap().plaintext,
                    format!("{round}:{sender}").as_bytes()
                );
                deliveries += 1;
            }
            let saved = member
                .export_encrypted_state(&[42; 32], b"cursor/outbox")
                .unwrap();
            *member = CryptoCore::import_encrypted_state(&[42; 32], &saved)
                .unwrap()
                .0;
        }
    }
    assert_eq!(deliveries, 960);
    let mut offline = members.pop().unwrap();
    let update = members[0]
        .prepare_membership_change(&circle, &[], &[])
        .unwrap();
    // Fifteen-member fanout while the admin still has a staged update.
    let old = members[1].encrypt_event(&circle, b"before update").unwrap();
    assert_eq!(
        members[0].decrypt_event(&circle, &old).unwrap().plaintext,
        b"before update"
    );
    for member in &mut members {
        member
            .process_commit(&circle, &update.commit_bytes)
            .unwrap();
    }
    let removed_id = members.last().unwrap().identity().device_id;
    let remove = members[0]
        .prepare_membership_change(&circle, &[], &[removed_id])
        .unwrap();
    for member in &mut members {
        member
            .process_commit(&circle, &remove.commit_bytes)
            .unwrap();
    }
    let mut removed = members.pop().unwrap();
    assert!(removed.encrypt_event(&circle, b"not allowed").is_err());
    offline
        .process_commit(&circle, &update.commit_bytes)
        .unwrap();
    let saved = offline
        .export_encrypted_state(&[42; 32], b"mid-catchup")
        .unwrap();
    offline = CryptoCore::import_encrypted_state(&[42; 32], &saved)
        .unwrap()
        .0;
    offline
        .process_commit(&circle, &remove.commit_bytes)
        .unwrap();
    members.push(offline);
    assert!(members
        .iter()
        .all(|m| m.list_members(&circle).unwrap().len() == 15));
    let returning = members
        .last_mut()
        .unwrap()
        .encrypt_event(&circle, b"back online")
        .unwrap();
    for member in members.iter_mut().take(14) {
        assert_eq!(
            member.decrypt_event(&circle, &returning).unwrap().plaintext,
            b"back online"
        );
        assert!(matches!(
            member.decrypt_event(&circle, &returning),
            Err(CryptoCoreError::AlreadyProcessed(_))
        ));
    }
}
