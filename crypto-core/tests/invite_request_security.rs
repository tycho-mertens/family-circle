use crypto_core::{open_invite_request, seal_invite_request};

const INVITE: &str = "0123456789abcdef0123456789abcdef";
const CIRCLE_ID: &str = "circle-a";
const MAILBOX_ID: &str = "11111111111111111111111111111111";
const KIND: &str = "join";
const WRONG_MAILBOX_ID: &str = "22222222222222222222222222222222";
const WRONG_INVITE: &str = "fedcba9876543210fedcba9876543210";

#[test]
fn invite_request_hides_the_invite_and_binds_its_context() {
    let payload = b"a fresh MLS key package".to_vec();
    let sealed = seal_invite_request(
        INVITE.into(),
        CIRCLE_ID.into(),
        MAILBOX_ID.into(),
        KIND.into(),
        payload.clone(),
    )
    .unwrap();

    // Neither the invite secret nor the plaintext payload should appear
    // verbatim in the sealed bytes sent through the relay.
    assert!(!sealed
        .windows(INVITE.len())
        .any(|part| part == INVITE.as_bytes()));
    assert!(!sealed.windows(payload.len()).any(|part| part == payload));
    assert_eq!(
        open_invite_request(
            INVITE.into(),
            CIRCLE_ID.into(),
            MAILBOX_ID.into(),
            KIND.into(),
            sealed.clone(),
        )
        .unwrap(),
        payload
    );

    // Changing only the mailbox context must prevent opening the request.
    assert!(open_invite_request(
        INVITE.into(),
        CIRCLE_ID.into(),
        WRONG_MAILBOX_ID.into(),
        KIND.into(),
        sealed.clone(),
    )
    .is_err());

    // The original context also fails if the invite secret is wrong.
    assert!(open_invite_request(
        WRONG_INVITE.into(),
        CIRCLE_ID.into(),
        MAILBOX_ID.into(),
        KIND.into(),
        sealed,
    )
    .is_err());
}
