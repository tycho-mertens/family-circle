use crypto_core::{open_invite_request, seal_invite_request};

const INVITE: &str = "0123456789abcdef0123456789abcdef";

#[test]
fn invite_request_hides_the_invite_and_binds_its_context() {
    let payload = b"a fresh MLS key package".to_vec();
    let sealed = seal_invite_request(
        INVITE.into(),
        "circle-a".into(),
        "0123456789abcdef0123456789abcdef".into(),
        "join".into(),
        payload.clone(),
    )
    .unwrap();

    // The relay-visible bytes contain neither the bearer secret nor its
    // plaintext KeyPackage. A former member can replay them, but cannot make
    // a different request with the recovered invite code.
    assert!(!sealed
        .windows(INVITE.len())
        .any(|part| part == INVITE.as_bytes()));
    assert!(!sealed.windows(payload.len()).any(|part| part == payload));
    assert_eq!(
        open_invite_request(
            INVITE.into(),
            "circle-a".into(),
            "0123456789abcdef0123456789abcdef".into(),
            "join".into(),
            sealed.clone(),
        )
        .unwrap(),
        payload
    );

    assert!(open_invite_request(
        INVITE.into(),
        "circle-a".into(),
        "fedcba9876543210fedcba9876543210".into(),
        "join".into(),
        sealed.clone(),
    )
    .is_err());
    assert!(open_invite_request(
        "fedcba9876543210fedcba9876543210".into(),
        "circle-a".into(),
        "0123456789abcdef0123456789abcdef".into(),
        "join".into(),
        sealed,
    )
    .is_err());
}
