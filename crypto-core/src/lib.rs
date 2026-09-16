//! All OpenMLS use for Family Circle lives in this crate.
//!
//! Nothing above it sees an MLS type. MLS epoch secrets, ratchet secrets and
//! the signing key stay in here; what crosses the boundary is opaque ids,
//! TLS-serialized commit/welcome bytes and ciphertext envelopes.
//!
//! `generate_seed_phrase` returns the recovery phrase for the user to save.
//! `derive_backup_credentials_from_seed_phrase` returns `auth_key` and
//! `enc_key` for relay authentication and local backup encryption. The app
//! persists both through Android SecureStore.
//!
//! # Reading the protocol code
//!
//! MLS (Messaging Layer Security) manages the shared encryption state of a group.
//! An epoch is one version of that state. A Proposal requests a change; a Commit
//! applies changes and advances the epoch. A KeyPackage advertises a joining
//! device's public keys, and a Welcome gives that device its initial group state.
//! The ratchet advances message keys as messages are sent or received.
//!
//! This crate produces and consumes bytes; the app handles network delivery and
//! durable checkpoints. A successful method call does not mean anything has
//! reached the relay or another phone yet.
//!
//! # Device slots
//!
//! Exported identity operations take a caller-chosen `device_slot`, allowing
//! independent identities in one process. The app uses one slot per install.
//!
//! # Ordered publication
//!
//! `prepare_membership_change` stages a Commit without changing the active
//! epoch and stores its exact bytes under a marker key in the storage
//! provider. `process_commit` merges that staged state only when those exact
//! bytes come back in mailbox order. An HTTP acknowledgement is not enough:
//! relay order decides which branch of the group is real, and an application
//! message the relay ordered before the Commit still has to decrypt under the
//! old epoch.
//!
//! The eager `add_member` / `remove_member` / `refresh_circle_keys` paths are
//! available for direct Rust consumers and tests. They merge immediately;
//! mobile publication uses the staged path. `add_member` caches the joiner's
//! Welcome per circle for a subsequent `create_welcome` call.
//!
//! # Circle policy
//!
//! MLS lets any member commit, so `CirclePolicy` pins one
//! `membership_admin_id` and recipients check the authenticated committer
//! against it before merging. Pre-authority backups deserialize with `None`
//! and refuse membership changes; there is no trustworthy way to pick an
//! owner out of an existing roster after the fact.
//!
//! The same struct keeps processed event ids and the latest processed epoch.
//! OpenMLS gives per-epoch keys but does not track what this app has already
//! handled, so `decrypt_event` checks both before touching group state.
//!
//! # Encrypted relay backup
//!
//! `export_encrypted_state` dumps the whole `openmls_rust_crypto` storage
//! provider together with this crate's policy bookkeeping, serializes it with
//! postcard, and seals it with ChaCha20-Poly1305 under a caller-supplied
//! `enc_key`. `import_encrypted_state` reverses that and rebuilds each group
//! with `MlsGroup::load`. The export includes all storage entries, rather
//! than selecting individual OpenMLS records.
//!
//! A generated 12-word BIP39 phrase provides 128 bits of entropy. HKDF splits
//! its derived seed into domain-separated subkeys:
//!
//! ```text
//! phrase -> PBKDF2(BIP39) -> 64-byte seed
//!   seed -> identity-v1  -> Ed25519 signing key, this device's MLS identity
//!   seed -> device-id-v1 -> device_id
//!   seed -> auth-v1      -> auth_key, the relay's challenge-response verifier
//!   seed -> enc-v1       -> enc_key, which never leaves the device
//!   SHA-256(domain || seed) -> backup_id, the public lookup key
//! ```
//!
//! The relay stores `backup_id` and `auth_key`. Every read or write after the
//! first registration proves possession of `auth_key` over a nonce the relay
//! issues, so no replayable secret crosses the wire. `enc_key` and the phrase
//! stay on the device.
//!
//! Since the identity is derived, a restore reproduces the `device_id` and
//! signing key the other members already have in their rosters.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use bip39::Mnemonic;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key as AeadKey, Nonce as AeadNonce};
use ed25519_dalek::SigningKey;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use openmls::prelude::tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::random::OpenMlsRand;
use openmls_traits::OpenMlsProvider;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

uniffi::setup_scaffolding!();

mod location;

/// A device's MLS identity. Only the id is exposed; the keys stay in the
/// storage provider.
#[derive(Debug, Clone, Serialize, Deserialize, uniffi::Record)]
pub struct DeviceIdentity {
    pub device_id: String,
}

/// Returned when a device creates a brand-new Circle (MLS group).
#[derive(Debug, Clone, Serialize, Deserialize, uniffi::Record)]
pub struct CircleBootstrap {
    pub circle_id: String,
}

/// Opaque MLS Commit bytes. Passed through, never inspected above this crate.
#[derive(Debug, Clone, Serialize, Deserialize, uniffi::Record)]
pub struct MlsCommit {
    pub commit_bytes: Vec<u8>,
}

/// A staged group update and, when adding a member, their encrypted Welcome.
/// Save both with the local state before sending either to the relay.
#[derive(Debug, Clone, uniffi::Record)]
pub struct PreparedMembershipChange {
    pub commit_bytes: Vec<u8>,
    pub welcome_bytes: Option<Vec<u8>>,
}

/// The active epoch and whether a staged update is blocking new sends.
#[derive(Debug, Clone, uniffi::Record)]
pub struct CirclePublicationState {
    pub epoch: u64,
    pub pending_commit: bool,
}

/// Relay-facing metadata around an opaque MLS application message.
/// The ciphertext contains the MLS message; its encryption is handled by OpenMLS.
#[derive(Debug, Clone, Serialize, Deserialize, uniffi::Record)]
pub struct EncryptedEnvelope {
    pub event_id: String,
    pub epoch: u64,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

/// Result of [`CryptoCore::decrypt_event`]. `sender_device_id` is the
/// MLS-authenticated sender credential, so it is safe to attribute on: a
/// forged sender fails signature verification and never reaches this struct.
#[derive(Debug, Clone, Serialize, Deserialize, uniffi::Record)]
pub struct DecryptedEvent {
    pub sender_device_id: String,
    pub plaintext: Vec<u8>,
}

/// What a seed phrase yields without creating or overwriting a local
/// identity. `backup_id` is the public relay lookup key, `auth_key` is the
/// challenge-response verifier the relay ends up holding, and `enc_key`
/// never leaves this device.
#[derive(Debug, Clone, Serialize, Deserialize, uniffi::Record)]
pub struct BackupCredentials {
    pub backup_id: String,
    pub auth_key: Vec<u8>,
    pub enc_key: Vec<u8>,
}

/// The identity plus the same credentials as [`BackupCredentials`], so the
/// caller can register a backup without deriving them twice.
#[derive(Debug, Clone, Serialize, Deserialize, uniffi::Record)]
pub struct CreatedIdentity {
    pub identity: DeviceIdentity,
    pub backup_id: String,
    pub auth_key: Vec<u8>,
    pub enc_key: Vec<u8>,
}

/// The restored identity plus whatever `app_metadata` the export carried.
#[derive(Debug, Clone, Serialize, Deserialize, uniffi::Record)]
pub struct ImportedBackup {
    pub identity: DeviceIdentity,
    pub app_metadata: Vec<u8>,
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
#[uniffi(flat_error)]
pub enum CryptoCoreError {
    #[error("circle not found: {0}")]
    CircleNotFound(String),
    #[error("no pending welcome for circle: {0}")]
    NoPendingWelcome(String),
    #[error("member not found in circle: {0}")]
    MemberNotFound(String),
    #[error("message rejected: stale epoch (message epoch {message_epoch}, circle is at {current_epoch})")]
    StaleEpoch {
        message_epoch: u64,
        current_epoch: u64,
    },
    #[error("message rejected: already processed (replay of event {0})")]
    AlreadyProcessed(String),
    #[error("message is an outgoing echo from this device")]
    OwnMessage,
    #[error("expected a different message type than what was received")]
    UnexpectedMessageType,
    #[error("membership commit rejected: authenticated committer {committer} is not the Circle administrator {administrator}")]
    UnauthorizedMembershipCommit {
        committer: String,
        administrator: String,
    },
    #[error("membership changes are disabled for this legacy Circle; create a new Circle with an administrator-bound invite")]
    LegacyMembershipAuthority,
    #[error("openmls error: {0}")]
    Mls(String),
    #[error("no device identity created yet — call create_identity first")]
    NoIdentity,
    #[error("backup could not be decrypted — wrong seed phrase, or corrupted/tampered data")]
    BackupDecryptFailed,
    #[error("invalid seed phrase: {0}")]
    InvalidSeedPhrase(String),
}

pub type Result<T> = std::result::Result<T, CryptoCoreError>;

// Map OpenMLS error types to one FFI-compatible error variant.
fn mls_err(e: impl std::fmt::Display) -> CryptoCoreError {
    CryptoCoreError::Mls(e.to_string())
}

#[derive(Clone, Serialize, Deserialize)]
struct CirclePolicy {
    latest_epoch: u64,
    processed_event_ids: HashSet<String>,
    // Only set for authority-v1 Circles. Pre-v1 backups deserialize with
    // `None` and cannot make membership changes: there is no trustworthy way
    // to pick an owner out of an existing roster after the fact.
    #[serde(default)]
    membership_admin_id: Option<String>,
}

const BACKUP_ID_DOMAIN: &[u8] = b"familycircle-backup-id-v1";
const BACKUP_AUTH_DOMAIN: &[u8] = b"familycircle-backup-auth-v1";
const BACKUP_ENC_DOMAIN: &[u8] = b"familycircle-backup-enc-v1";
const BACKUP_IDENTITY_DOMAIN: &[u8] = b"familycircle-backup-identity-v1";
const BACKUP_DEVICE_ID_DOMAIN: &[u8] = b"familycircle-backup-device-id-v1";
const SEED_PHRASE_WORD_COUNT: usize = 12;
const BACKUP_KEY_LEN: usize = 32;
const BACKUP_NONCE_LEN: usize = 12;
const DEVICE_ID_BYTE_LEN: usize = 16;

const INVITE_REQUEST_DOMAIN: &[u8] = b"familycircle-invite-request/v1";
const INVITE_REQUEST_NONCE_LEN: usize = 12;
const INVITE_REQUEST_VERSION: u8 = 1;

/// Derive a request key from the invite secret and its intended destination.
/// Including the request kind separates join requests from other invitation uses.
fn invite_request_key(
    invite_nonce: &str,
    circle_id: &str,
    mailbox_id: &str,
    kind: &str,
) -> Result<[u8; 32]> {
    // secureNonce() makes exactly 16 random bytes and hex-encodes them. Keep
    // this strict so a low-entropy string cannot become an invite key just by
    // being passed in here.
    if invite_nonce.len() != 32 || !invite_nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(mls_err("invite nonce must be 32 hexadecimal characters"));
    }
    let mut hash = Sha256::new();
    hash.update(INVITE_REQUEST_DOMAIN);
    for value in [
        invite_nonce.as_bytes(),
        circle_id.as_bytes(),
        mailbox_id.as_bytes(),
        kind.as_bytes(),
    ] {
        hash.update([0]);
        hash.update(value);
    }
    Ok(hash.finalize().into())
}

/// Public context authenticated alongside the encrypted invitation payload.
/// AAD means additional authenticated data: it is checked, but not encrypted.
fn invite_request_aad(circle_id: &str, mailbox_id: &str, kind: &str) -> Vec<u8> {
    [
        INVITE_REQUEST_DOMAIN,
        circle_id.as_bytes(),
        mailbox_id.as_bytes(),
        kind.as_bytes(),
    ]
    .join(&0)
}

/// Seal pre-membership pairing data for the Circle creator. The relay sees
/// only AEAD bytes and an opaque event id. Copying a request replays the
/// original applicant's KeyPackage at most; it cannot substitute another.
#[uniffi::export]
pub fn seal_invite_request(
    invite_nonce: String,
    circle_id: String,
    mailbox_id: String,
    kind: String,
    payload: Vec<u8>,
) -> Result<Vec<u8>> {
    if payload.is_empty() || payload.len() > 64 * 1024 {
        return Err(mls_err("invalid invite request payload size"));
    }
    let key = invite_request_key(&invite_nonce, &circle_id, &mailbox_id, &kind)?;
    let key =
        AeadKey::try_from(key.as_slice()).map_err(|_| mls_err("invalid invite request key"))?;
    let cipher = ChaCha20Poly1305::new(&key);
    let mut nonce = [0u8; INVITE_REQUEST_NONCE_LEN];
    getrandom_fill(&mut nonce);
    let ciphertext = cipher
        .encrypt(
            &AeadNonce::try_from(nonce.as_slice())
                .map_err(|_| mls_err("invalid invite request nonce"))?,
            chacha20poly1305::aead::Payload {
                msg: &payload,
                aad: &invite_request_aad(&circle_id, &mailbox_id, &kind),
            },
        )
        .map_err(|_| mls_err("could not seal invite request"))?;
    let mut result = Vec::with_capacity(1 + nonce.len() + ciphertext.len());
    result.push(INVITE_REQUEST_VERSION);
    result.extend_from_slice(&nonce);
    result.extend_from_slice(&ciphertext);
    Ok(result)
}

/// Open a pairing request with the creator's active invite secret. Every
/// failure looks alike from outside: wrong key, malformed, or stale.
#[uniffi::export]
pub fn open_invite_request(
    invite_nonce: String,
    circle_id: String,
    mailbox_id: String,
    kind: String,
    sealed: Vec<u8>,
) -> Result<Vec<u8>> {
    if sealed.len() <= 1 + INVITE_REQUEST_NONCE_LEN + 16 || sealed[0] != INVITE_REQUEST_VERSION {
        return Err(mls_err("invalid invite request"));
    }
    let key = invite_request_key(&invite_nonce, &circle_id, &mailbox_id, &kind)?;
    let key =
        AeadKey::try_from(key.as_slice()).map_err(|_| mls_err("invalid invite request key"))?;
    let cipher = ChaCha20Poly1305::new(&key);
    cipher
        .decrypt(
            &AeadNonce::try_from(&sealed[1..1 + INVITE_REQUEST_NONCE_LEN])
                .map_err(|_| mls_err("invalid invite request"))?,
            chacha20poly1305::aead::Payload {
                msg: &sealed[1 + INVITE_REQUEST_NONCE_LEN..],
                aad: &invite_request_aad(&circle_id, &mailbox_id, &kind),
            },
        )
        .map_err(|_| mls_err("invalid invite request"))
}

#[derive(Serialize, Deserialize)]
struct BackupPayload {
    device_id: String,
    credential_with_key: Vec<u8>,
    signature_keys: Vec<u8>,
    circle_ids: Vec<String>,
    policies: HashMap<String, CirclePolicy>,
    storage: Vec<(Vec<u8>, Vec<u8>)>,
    app_metadata: Vec<u8>,
}

/// Seal bytes with a fresh nonce, stored before the authenticated ciphertext.
/// The nonce is public; only the encryption key must remain secret.
fn encrypt_backup_blob(enc_key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    if enc_key.len() != BACKUP_KEY_LEN {
        return Err(mls_err("enc_key must be 32 bytes"));
    }
    let key = AeadKey::try_from(enc_key).map_err(|_| mls_err("enc_key must be 32 bytes"))?;
    let cipher = ChaCha20Poly1305::new(&key);
    let mut nonce_bytes = [0u8; BACKUP_NONCE_LEN];
    getrandom_fill(&mut nonce_bytes);
    let nonce = AeadNonce::from(nonce_bytes);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|_| mls_err("backup encryption failed"))?;
    let mut out = Vec::with_capacity(BACKUP_NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Split the stored nonce from the ciphertext and authenticate before returning bytes.
fn decrypt_backup_blob(enc_key: &[u8], blob: &[u8]) -> Result<Vec<u8>> {
    if enc_key.len() != BACKUP_KEY_LEN {
        return Err(mls_err("enc_key must be 32 bytes"));
    }
    if blob.len() < BACKUP_NONCE_LEN {
        return Err(CryptoCoreError::BackupDecryptFailed);
    }
    let (nonce_bytes, ciphertext) = blob.split_at(BACKUP_NONCE_LEN);
    let key = AeadKey::try_from(enc_key).map_err(|_| mls_err("enc_key must be 32 bytes"))?;
    let cipher = ChaCha20Poly1305::new(&key);
    let nonce =
        AeadNonce::try_from(nonce_bytes).map_err(|_| CryptoCoreError::BackupDecryptFailed)?;
    cipher
        .decrypt(&nonce, ciphertext)
        .map_err(|_| CryptoCoreError::BackupDecryptFailed)
}

/// The live state for a single device identity.
pub struct CryptoCore {
    device_id: String,
    provider: OpenMlsRustCrypto,
    credential_with_key: CredentialWithKey,
    signature_keys: SignatureKeyPair,
    groups: HashMap<String, MlsGroup>,
    policies: HashMap<String, CirclePolicy>,
    // circle_id -> serialized Welcome bytes for the most recently added
    // member. See the module docs on the add_member/create_welcome split.
    pending_welcomes: HashMap<String, Vec<u8>>,
    locations: location::LocationState,
}

/// Read the group tree from the Welcome extension rather than a separate download.
fn group_join_config() -> MlsGroupJoinConfig {
    MlsGroupJoinConfig::builder()
        .use_ratchet_tree_extension(true)
        .build()
}

/// Use the shared cipher suite and include the tree needed by future joiners.
fn group_create_config() -> MlsGroupCreateConfig {
    MlsGroupCreateConfig::builder()
        .ciphersuite(CIPHERSUITE)
        .use_ratchet_tree_extension(true)
        .build()
}

/// Encode the binary MLS group ID for use in app state and bridge calls.
fn circle_id_for(group_id: &GroupId) -> String {
    hex::encode(group_id.as_slice())
}

/// Adapt a byte slice to the Read interface required by tls_codec.
fn deserialize_tls<T: TlsDeserialize>(bytes: &[u8]) -> Result<T> {
    T::tls_deserialize(&mut &*bytes).map_err(mls_err)
}

fn circle_not_found(circle_id: &str) -> CryptoCoreError {
    CryptoCoreError::CircleNotFound(circle_id.to_string())
}

impl CryptoCore {
    /// A fresh random device identity. The keys never leave this struct.
    pub fn new() -> Result<Self> {
        let device_id = format!("device-{}", uuid_like());
        let provider = OpenMlsRustCrypto::default();

        let credential = BasicCredential::new(device_id.as_bytes().to_vec());
        let signature_keys =
            SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).map_err(mls_err)?;
        signature_keys.store(provider.storage()).map_err(mls_err)?;

        let credential_with_key = CredentialWithKey {
            credential: credential.into(),
            signature_key: signature_keys.to_public_vec().into(),
        };

        Ok(Self {
            device_id,
            provider,
            credential_with_key,
            signature_keys,
            groups: HashMap::new(),
            policies: HashMap::new(),
            pending_welcomes: HashMap::new(),
            locations: Default::default(),
        })
    }

    /// Derive a stable device ID and signing keypair from a 32-byte seed.
    /// SignatureKeyPair::from_raw expects private = SigningKey::as_bytes()
    /// and public = VerifyingKey::to_bytes(), matching openmls_basic_credential.
    pub fn new_from_seed(device_id: String, identity_seed: [u8; 32]) -> Result<Self> {
        let provider = OpenMlsRustCrypto::default();

        let signing_key = SigningKey::from_bytes(&identity_seed);
        let private = signing_key.to_bytes().to_vec();
        let public = signing_key.verifying_key().to_bytes().to_vec();
        let signature_keys =
            SignatureKeyPair::from_raw(CIPHERSUITE.signature_algorithm(), private, public);
        signature_keys.store(provider.storage()).map_err(mls_err)?;

        let credential = BasicCredential::new(device_id.as_bytes().to_vec());
        let credential_with_key = CredentialWithKey {
            credential: credential.into(),
            signature_key: signature_keys.to_public_vec().into(),
        };

        Ok(Self {
            device_id,
            provider,
            credential_with_key,
            signature_keys,
            groups: HashMap::new(),
            policies: HashMap::new(),
            pending_welcomes: HashMap::new(),
            locations: Default::default(),
        })
    }

    pub fn identity(&self) -> DeviceIdentity {
        DeviceIdentity {
            device_id: self.device_id.clone(),
        }
    }

    /// Create a new Circle (MLS group) owned by this device.
    pub fn create_circle(&mut self) -> Result<CircleBootstrap> {
        let config = group_create_config();
        let group = MlsGroup::new(
            &self.provider,
            &self.signature_keys,
            &config,
            self.credential_with_key.clone(),
        )
        .map_err(mls_err)?;

        let circle_id = circle_id_for(group.group_id());
        self.groups.insert(circle_id.clone(), group);
        self.policies.insert(
            circle_id.clone(),
            CirclePolicy {
                latest_epoch: 0,
                processed_event_ids: HashSet::new(),
                membership_admin_id: Some(self.device_id.clone()),
            },
        );

        Ok(CircleBootstrap { circle_id })
    }

    /// A KeyPackage for this device, so an admin can add it to a Circle.
    pub fn create_key_package(&mut self) -> Result<Vec<u8>> {
        let bundle = KeyPackage::builder()
            .build(
                CIPHERSUITE,
                &self.provider,
                &self.signature_keys,
                self.credential_with_key.clone(),
            )
            .map_err(mls_err)?;

        bundle
            .key_package()
            .tls_serialize_detached()
            .map_err(mls_err)
    }

    /// Decode and validate the signed public-key bundle before using its identity or keys.
    fn parse_key_package(&self, bytes: &[u8]) -> Result<KeyPackage> {
        let key_package_in: KeyPackageIn = deserialize_tls(bytes)?;
        key_package_in
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(mls_err)
    }

    /// Return the BasicCredential identity from a signature-validated
    /// KeyPackage. This is the joining device's MLS identity, not a field
    /// supplied by the app UI, so it is safe to use for admission policy.
    pub fn key_package_identity(&self, bytes: &[u8]) -> Result<String> {
        let key_package = self.parse_key_package(bytes)?;
        let credential: BasicCredential = key_package
            .leaf_node()
            .credential()
            .clone()
            .try_into()
            .map_err(mls_err)?;
        String::from_utf8(credential.identity().to_vec()).map_err(mls_err)
    }

    /// Propose+commit an Add for `member_key_package` into `circle_id`.
    /// Merges the commit locally and caches the Welcome for `create_welcome`
    /// to hand back. See the module docs.
    pub fn add_member(&mut self, circle_id: &str, member_key_package: &[u8]) -> Result<MlsCommit> {
        self.require_membership_admin(circle_id)?;
        let key_package = self.parse_key_package(member_key_package)?;
        // Borrow `self.groups` directly (not through a helper method) so
        // the borrow checker can see it's disjoint from `self.provider` /
        // `self.signature_keys` below.
        let group = self
            .groups
            .get_mut(circle_id)
            .ok_or_else(|| circle_not_found(circle_id))?;

        let (commit_out, welcome_out, _group_info) = group
            .add_members(
                &self.provider,
                &self.signature_keys,
                core::slice::from_ref(&key_package),
            )
            .map_err(mls_err)?;

        group
            .merge_pending_commit(&self.provider)
            .map_err(mls_err)?;
        let new_epoch = group.epoch().as_u64();

        let commit_bytes = commit_out.tls_serialize_detached().map_err(mls_err)?;
        let welcome_bytes = welcome_out.tls_serialize_detached().map_err(mls_err)?;

        self.pending_welcomes
            .insert(circle_id.to_string(), welcome_bytes);
        if let Some(policy) = self.policies.get_mut(circle_id) {
            policy.latest_epoch = new_epoch;
        }

        Ok(MlsCommit { commit_bytes })
    }

    /// Apply a Commit in relay order, including the exact echo of this
    /// device's own prepared membership change.
    pub fn process_commit(&mut self, circle_id: &str, commit: &[u8]) -> Result<()> {
        // A locally prepared commit is merged only when its exact bytes are
        // received in mailbox order. Never authorize this using an event ID
        // supplied by the relay. The marker shares the encrypted storage dump
        // with OpenMLS's durable PendingCommit state.
        let marker = Self::publication_key(circle_id);
        let own_commit = self
            .provider
            .storage()
            .values
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .get(&marker)
            .cloned();
        let administrator = self
            .policies
            .get(circle_id)
            .ok_or_else(|| circle_not_found(circle_id))?
            .membership_admin_id
            .clone();
        let group = self
            .groups
            .get_mut(circle_id)
            .ok_or_else(|| circle_not_found(circle_id))?;

        if own_commit.as_deref() == Some(commit) {
            if group.pending_commit().is_none() {
                return Err(mls_err("Missing prepared membership state"));
            }
            group
                .merge_pending_commit(&self.provider)
                .map_err(mls_err)?;
            if let Some(policy) = self.policies.get_mut(circle_id) {
                policy.latest_epoch = group.epoch().as_u64();
            }
            self.provider
                .storage()
                .values
                .write()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&marker);
            return Ok(());
        }

        let message_in: MlsMessageIn = deserialize_tls(commit)?;
        let protocol_message = message_in
            .try_into_protocol_message()
            .map_err(|_| CryptoCoreError::UnexpectedMessageType)?;

        let message_epoch = protocol_message.epoch().as_u64();
        let current_epoch = group.epoch().as_u64();
        if message_epoch < current_epoch {
            return Err(CryptoCoreError::StaleEpoch {
                message_epoch,
                current_epoch,
            });
        }

        // The app has one membership committer. A competing commit must not
        // silently invalidate our already-checkpointed Commit/Welcome pair.
        // Fail closed and retain the cursor instead of publishing a Welcome
        // for a different branch of the group.
        if own_commit.is_some() {
            return Err(mls_err(
                "A competing membership update arrived while local publication is pending",
            ));
        }

        let processed = group
            .process_message(&self.provider, protocol_message)
            .map_err(mls_err)?;

        // MLS authenticates this credential as the Commit sender. The group
        // itself permits every member to commit, so enforce the Circle's
        // stricter single-administrator policy before merging the staged
        // state. A malicious member can fork only their own modified client;
        // compliant members never accept that fork or its Welcome.
        if let Some(administrator) = administrator {
            let committer =
                String::from_utf8_lossy(processed.credential().serialized_content()).into_owned();
            if committer != administrator {
                return Err(CryptoCoreError::UnauthorizedMembershipCommit {
                    committer,
                    administrator,
                });
            }
        }

        match processed.into_content() {
            ProcessedMessageContent::StagedCommitMessage(staged_commit) => {
                group
                    .merge_staged_commit(&self.provider, *staged_commit)
                    .map_err(mls_err)?;
            }
            _ => return Err(CryptoCoreError::UnexpectedMessageType),
        }
        let new_epoch = group.epoch().as_u64();

        if let Some(policy) = self.policies.get_mut(circle_id) {
            policy.latest_epoch = new_epoch;
        }

        Ok(())
    }

    /// Namespace the saved commit marker inside the same store as the MLS state.
    fn publication_key(circle_id: &str) -> Vec<u8> {
        format!("familycircle/local-commit/v1/{circle_id}").into_bytes()
    }

    /// Gate locally authored membership changes on this circle's stored authority.
    /// Legacy circles without a pinned administrator cannot pass this check.
    fn require_membership_admin(&self, circle_id: &str) -> Result<()> {
        let policy = self
            .policies
            .get(circle_id)
            .ok_or_else(|| circle_not_found(circle_id))?;
        match policy.membership_admin_id.as_deref() {
            Some(administrator) if administrator == self.device_id => Ok(()),
            Some(administrator) => Err(CryptoCoreError::UnauthorizedMembershipCommit {
                committer: self.device_id.clone(),
                administrator: administrator.to_string(),
            }),
            None => Err(CryptoCoreError::LegacyMembershipAuthority),
        }
    }

    /// Let the caller decide whether to send application messages or finish a pending update.
    pub fn circle_publication_state(&self, circle_id: &str) -> Result<CirclePublicationState> {
        let group = self
            .groups
            .get(circle_id)
            .ok_or_else(|| circle_not_found(circle_id))?;
        Ok(CirclePublicationState {
            epoch: group.epoch().as_u64(),
            pending_commit: group.pending_commit().is_some(),
        })
    }

    /// Move the stored authority to `next_admin` after an authenticated
    /// `admin-transfer` message. The caller verifies that message; this only
    /// checks that the successor is in the roster and that `current_admin` is
    /// who the policy currently names.
    pub fn adopt_membership_admin(
        &mut self,
        circle_id: &str,
        current_admin: &str,
        next_admin: &str,
    ) -> Result<()> {
        let group = self
            .groups
            .get(circle_id)
            .ok_or_else(|| circle_not_found(circle_id))?;
        if !group
            .members()
            .any(|member| member.credential.serialized_content() == next_admin.as_bytes())
        {
            return Err(CryptoCoreError::MemberNotFound(next_admin.to_string()));
        }
        let policy = self
            .policies
            .get_mut(circle_id)
            .ok_or_else(|| circle_not_found(circle_id))?;
        if policy.membership_admin_id.as_deref() != Some(current_admin) {
            return Err(CryptoCoreError::UnauthorizedMembershipCommit {
                committer: current_admin.to_string(),
                administrator: policy
                    .membership_admin_id
                    .clone()
                    .unwrap_or_else(|| "legacy".to_string()),
            });
        }
        policy.membership_admin_id = Some(next_admin.to_string());
        Ok(())
    }

    /// Prepare one ordered membership operation without changing the active
    /// epoch. Empty additions/removals perform a standard leaf key update.
    /// Rejoin removes and adds in one commit. The caller must checkpoint this
    /// state and the returned envelopes before publishing, then process its
    /// own commit at its relay position just like every other member.
    pub fn prepare_membership_change(
        &mut self,
        circle_id: &str,
        key_package: &[u8],
        remove_ids: &[String],
    ) -> Result<PreparedMembershipChange> {
        self.require_membership_admin(circle_id)?;
        let adds = if key_package.is_empty() {
            vec![]
        } else {
            vec![self.parse_key_package(key_package)?]
        };
        let group = self
            .groups
            .get_mut(circle_id)
            .ok_or_else(|| circle_not_found(circle_id))?;
        if group.pending_commit().is_some() {
            return Err(mls_err("A membership update is awaiting publication"));
        }
        let removals: Vec<_> = remove_ids
            .iter()
            .map(|id| {
                group
                    .members()
                    .find(|m| m.credential.serialized_content() == id.as_bytes())
                    .map(|m| m.index)
                    .ok_or_else(|| CryptoCoreError::MemberNotFound(id.clone()))
            })
            .collect::<Result<_>>()?;
        // Build only the requested change. Leaving stored proposals out avoids
        // silently including unrelated requests in this publication.
        let bundle = group
            .commit_builder()
            .consume_proposal_store(false)
            .propose_adds(adds)
            .propose_removals(removals)
            .force_self_update(true)
            .load_psks(self.provider.storage())
            .map_err(mls_err)?
            .build(
                self.provider.rand(),
                self.provider.crypto(),
                &self.signature_keys,
                |_| true,
            )
            .map_err(mls_err)?
            .stage_commit(&self.provider)
            .map_err(mls_err)?;
        // Staging preserves the old active epoch. The exact commit bytes become
        // the marker process_commit uses to recognize our own ordered echo.
        let (commit, welcome, _) = bundle.into_messages();
        let commit_bytes = commit.tls_serialize_detached().map_err(mls_err)?;
        let welcome_bytes = welcome
            .map(|w| w.tls_serialize_detached().map_err(mls_err))
            .transpose()?;
        self.provider
            .storage()
            .values
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .insert(Self::publication_key(circle_id), commit_bytes.clone());
        Ok(PreparedMembershipChange {
            commit_bytes,
            welcome_bytes,
        })
    }

    /// Verify a voluntary leave and return the authenticated member identity.
    /// The app saves that intent so a proposal arriving while another commit
    /// is pending can be fulfilled in the next epoch, using an inline Remove.
    pub fn process_leave(&mut self, circle_id: &str, proposal: &[u8]) -> Result<String> {
        let group = self
            .groups
            .get_mut(circle_id)
            .ok_or_else(|| circle_not_found(circle_id))?;
        let message: MlsMessageIn = deserialize_tls(proposal)?;
        let protocol = message
            .try_into_protocol_message()
            .map_err(|_| CryptoCoreError::UnexpectedMessageType)?;
        if protocol.epoch().as_u64() < group.epoch().as_u64() {
            return Err(CryptoCoreError::StaleEpoch {
                message_epoch: protocol.epoch().as_u64(),
                current_epoch: group.epoch().as_u64(),
            });
        }
        let processed = group
            .process_message(&self.provider, protocol)
            .map_err(mls_err)?;
        let member_id =
            String::from_utf8_lossy(processed.credential().serialized_content()).into_owned();
        let sender = processed.sender().clone();
        match processed.into_content() {
            ProcessedMessageContent::ProposalMessage(queued) => {
                match (queued.proposal(), sender) {
                    (Proposal::Remove(remove), Sender::Member(index))
                        if remove.removed() == index => {}
                    _ => return Err(CryptoCoreError::UnexpectedMessageType),
                }
                group
                    .store_pending_proposal(self.provider.storage(), *queued)
                    .map_err(mls_err)?;
                Ok(member_id)
            }
            _ => Err(CryptoCoreError::UnexpectedMessageType),
        }
    }

    /// Return the Welcome produced by the most recent [`Self::add_member`]
    /// call on this circle. `member_key_package` is unused: `add_member`
    /// already had OpenMLS bind that Welcome to that recipient. It stays in
    /// the signature so a call site reads as add-then-welcome-for-X.
    pub fn create_welcome(
        &mut self,
        circle_id: &str,
        _member_key_package: &[u8],
    ) -> Result<Vec<u8>> {
        self.pending_welcomes
            .remove(circle_id)
            .ok_or_else(|| CryptoCoreError::NoPendingWelcome(circle_id.to_string()))
    }

    /// Join a Circle from a Welcome. Returns the circle_id.
    pub fn join_from_welcome(&mut self, welcome: &[u8]) -> Result<String> {
        self.join_from_welcome_with_admin(welcome, None)
    }

    /// Join an authority-v1 Circle. The administrator ID is carried in the
    /// out-of-band invite and must already be a credential in the Welcome's
    /// authenticated roster. It is therefore not a relay-controlled label.
    pub fn join_from_welcome_with_admin(
        &mut self,
        welcome: &[u8],
        administrator: Option<String>,
    ) -> Result<String> {
        let message_in: MlsMessageIn = deserialize_tls(welcome)?;
        let welcome = match message_in.extract() {
            MlsMessageBodyIn::Welcome(w) => w,
            _ => return Err(CryptoCoreError::UnexpectedMessageType),
        };

        let config = group_join_config();
        let staged = StagedWelcome::new_from_welcome(&self.provider, &config, welcome, None)
            .map_err(mls_err)?;
        let group = staged.into_group(&self.provider).map_err(mls_err)?;

        let circle_id = circle_id_for(group.group_id());
        let epoch = group.epoch().as_u64();
        if let Some(ref administrator) = administrator {
            if !group
                .members()
                .any(|member| member.credential.serialized_content() == administrator.as_bytes())
            {
                return Err(CryptoCoreError::MemberNotFound(administrator.clone()));
            }
        }
        self.groups.insert(circle_id.clone(), group);
        self.policies.insert(
            circle_id.clone(),
            CirclePolicy {
                latest_epoch: epoch,
                processed_event_ids: HashSet::new(),
                membership_admin_id: administrator,
            },
        );

        Ok(circle_id)
    }

    /// Propose+commit a Remove for `member_id`, matched against the
    /// credential identity bytes.
    pub fn remove_member(&mut self, circle_id: &str, member_id: &str) -> Result<MlsCommit> {
        self.require_membership_admin(circle_id)?;
        let group = self
            .groups
            .get_mut(circle_id)
            .ok_or_else(|| circle_not_found(circle_id))?;

        let target = group
            .members()
            .find(|m| m.credential.serialized_content() == member_id.as_bytes())
            .map(|m| m.index)
            .ok_or_else(|| CryptoCoreError::MemberNotFound(member_id.to_string()))?;

        let (commit_out, _welcome_option, _group_info) = group
            .remove_members(&self.provider, &self.signature_keys, &[target])
            .map_err(mls_err)?;

        group
            .merge_pending_commit(&self.provider)
            .map_err(mls_err)?;
        let new_epoch = group.epoch().as_u64();

        if let Some(policy) = self.policies.get_mut(circle_id) {
            policy.latest_epoch = new_epoch;
        }

        let commit_bytes = commit_out.tls_serialize_detached().map_err(mls_err)?;
        Ok(MlsCommit { commit_bytes })
    }

    /// Propose leaving `circle_id`. OpenMLS rejects a Commit that removes its
    /// own committer ("The Commit tried to remove self from the group. This is
    /// not possible."), so unlike [`Self::remove_member`] this cannot be one
    /// atomic propose+commit. It produces a Remove Proposal that another
    /// member with commit authority turns into a Commit through
    /// [`Self::process_proposal`] and [`Self::commit_pending_proposals`].
    ///
    /// Every member has to see the proposal itself, not just the committer:
    /// a Commit references queued proposals by reference.
    pub fn propose_leave(&mut self, circle_id: &str) -> Result<Vec<u8>> {
        let group = self
            .groups
            .get_mut(circle_id)
            .ok_or_else(|| circle_not_found(circle_id))?;

        let proposal = group
            .leave_group(&self.provider, &self.signature_keys)
            .map_err(mls_err)?;
        proposal.tls_serialize_detached().map_err(mls_err)
    }

    /// Queue a Proposal locally without committing it. Pairs with
    /// [`Self::commit_pending_proposals`].
    pub fn process_proposal(&mut self, circle_id: &str, proposal: &[u8]) -> Result<()> {
        let group = self
            .groups
            .get_mut(circle_id)
            .ok_or_else(|| circle_not_found(circle_id))?;

        let message_in: MlsMessageIn = deserialize_tls(proposal)?;
        let protocol_message = message_in
            .try_into_protocol_message()
            .map_err(|_| CryptoCoreError::UnexpectedMessageType)?;

        let message_epoch = protocol_message.epoch().as_u64();
        let current_epoch = group.epoch().as_u64();
        if message_epoch < current_epoch {
            return Err(CryptoCoreError::StaleEpoch {
                message_epoch,
                current_epoch,
            });
        }

        let processed = group
            .process_message(&self.provider, protocol_message)
            .map_err(mls_err)?;

        match processed.into_content() {
            ProcessedMessageContent::ProposalMessage(staged_proposal) => {
                group
                    .store_pending_proposal(self.provider.storage(), *staged_proposal)
                    .map_err(mls_err)?;
            }
            _ => return Err(CryptoCoreError::UnexpectedMessageType),
        }

        Ok(())
    }

    /// Commit whatever proposals are queued for `circle_id`.
    pub fn commit_pending_proposals(&mut self, circle_id: &str) -> Result<MlsCommit> {
        self.require_membership_admin(circle_id)?;
        let group = self
            .groups
            .get_mut(circle_id)
            .ok_or_else(|| circle_not_found(circle_id))?;

        let (commit_out, _welcome_option, _group_info) = group
            .commit_to_pending_proposals(&self.provider, &self.signature_keys)
            .map_err(mls_err)?;

        group
            .merge_pending_commit(&self.provider)
            .map_err(mls_err)?;
        let new_epoch = group.epoch().as_u64();

        if let Some(policy) = self.policies.get_mut(circle_id) {
            policy.latest_epoch = new_epoch;
        }

        let commit_bytes = commit_out.tls_serialize_detached().map_err(mls_err)?;
        Ok(MlsCommit { commit_bytes })
    }

    /// Current member device_ids of `circle_id` as of the last commit this
    /// device merged. Not global truth: a commit may still be in flight.
    pub fn list_members(&self, circle_id: &str) -> Result<Vec<String>> {
        let group = self
            .groups
            .get(circle_id)
            .ok_or_else(|| circle_not_found(circle_id))?;

        Ok(group
            .members()
            .map(|m| String::from_utf8_lossy(m.credential.serialized_content()).into_owned())
            .collect())
    }

    /// Delete local group state after the app has handled departure from the circle.
    /// This does not remove the member from other phones; signed location stops
    /// remain queued so an offline departure can revoke the published position later.
    pub fn forget_circle(&mut self, circle_id: &str) -> Result<()> {
        self.forget_location_circle(circle_id)?;
        if let Some(mut group) = self.groups.remove(circle_id) {
            group.delete(self.provider.storage()).map_err(mls_err)?;
        }
        self.policies.remove(circle_id);
        self.provider
            .storage()
            .values
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&Self::publication_key(circle_id));
        Ok(())
    }

    /// Encrypt an application payload for the current epoch of `circle_id`.
    pub fn encrypt_event(&mut self, circle_id: &str, payload: &[u8]) -> Result<EncryptedEnvelope> {
        if self.circle_publication_state(circle_id)?.pending_commit {
            return Err(mls_err("A membership update is awaiting publication"));
        }
        // Hold sends while a commit is staged: its eventual relay position decides
        // which epoch future messages must use. OpenMLS advances the send ratchet below.
        let event_id = uuid_like();
        let nonce = self.provider.rand().random_vec(12).map_err(mls_err)?;

        let group = self
            .groups
            .get_mut(circle_id)
            .ok_or_else(|| circle_not_found(circle_id))?;
        let epoch = group.epoch().as_u64();

        let mls_message_out = group
            .create_message(&self.provider, &self.signature_keys, payload)
            .map_err(mls_err)?;
        let ciphertext = mls_message_out.tls_serialize_detached().map_err(mls_err)?;

        Ok(EncryptedEnvelope {
            event_id,
            epoch,
            nonce,
            ciphertext,
        })
    }

    /// Refresh this leaf using the standard MLS Update commit. Used by the
    /// creator after catching up an old backup, before resuming application
    /// sends. It establishes a new epoch rather than reusing a saved ratchet.
    pub fn refresh_circle_keys(&mut self, circle_id: &str) -> Result<MlsCommit> {
        self.require_membership_admin(circle_id)?;
        let group = self
            .groups
            .get_mut(circle_id)
            .ok_or_else(|| circle_not_found(circle_id))?;
        let bundle = group
            .self_update(
                &self.provider,
                &self.signature_keys,
                LeafNodeParameters::default(),
            )
            .map_err(mls_err)?;
        let commit_bytes = bundle.commit().tls_serialize_detached().map_err(mls_err)?;
        group
            .merge_pending_commit(&self.provider)
            .map_err(mls_err)?;
        if let Some(policy) = self.policies.get_mut(circle_id) {
            policy.latest_epoch = group.epoch().as_u64();
        }
        Ok(MlsCommit { commit_bytes })
    }

    /// Authenticate and decrypt an application message, returning its verified sender.
    /// Successful reads advance MLS state and replay tracking, so the caller must
    /// checkpoint them together with its mailbox cursor before acknowledging delivery.
    pub fn decrypt_event(
        &mut self,
        circle_id: &str,
        envelope: &EncryptedEnvelope,
    ) -> Result<DecryptedEvent> {
        let policy = self
            .policies
            .get(circle_id)
            .ok_or_else(|| CryptoCoreError::CircleNotFound(circle_id.to_string()))?;

        // Replay: reject a duplicate event_id without touching OpenMLS state.
        if policy.processed_event_ids.contains(&envelope.event_id) {
            return Err(CryptoCoreError::AlreadyProcessed(envelope.event_id.clone()));
        }
        // Stale epoch. OpenMLS usually cannot decrypt an old epoch anyway,
        // since it erases those secrets on commit, but checking here makes the
        // policy explicit and produces a better error than a generic
        // decryption failure.
        if envelope.epoch < policy.latest_epoch {
            return Err(CryptoCoreError::StaleEpoch {
                message_epoch: envelope.epoch,
                current_epoch: policy.latest_epoch,
            });
        }

        let group = self
            .groups
            .get_mut(circle_id)
            .ok_or_else(|| circle_not_found(circle_id))?;
        let message_in: MlsMessageIn = deserialize_tls(&envelope.ciphertext)?;
        let protocol_message = message_in
            .try_into_protocol_message()
            .map_err(|_| CryptoCoreError::UnexpectedMessageType)?;

        let processed = group
            .process_message(&self.provider, protocol_message)
            .map_err(mls_err)?;

        // Read the verified sender credential before into_content consumes processed.
        let sender_device_id =
            String::from_utf8_lossy(processed.credential().serialized_content()).into_owned();

        let plaintext = match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(app_msg) => app_msg.into_bytes(),
            ProcessedMessageContent::OwnPrivateMessage => return Err(CryptoCoreError::OwnMessage),
            _ => return Err(CryptoCoreError::UnexpectedMessageType),
        };

        if let Some(policy) = self.policies.get_mut(circle_id) {
            policy.processed_event_ids.insert(envelope.event_id.clone());
        }

        Ok(DecryptedEvent {
            sender_device_id,
            plaintext,
        })
    }

    /// Seal this device's identity and Circle state under `enc_key`, which
    /// the caller derives and this crate never stores. See the "Encrypted
    /// relay backup" section of the module docs for what goes into the blob.
    ///
    /// `app_metadata` is round-tripped unread and handed back by
    /// `import_encrypted_state`, so `mobile/src/backup.ts` can carry its own
    /// bookkeeping (mailbox ids, invite state) in the same container without
    /// a second encryption scheme.
    pub fn export_encrypted_state(&self, enc_key: &[u8], app_metadata: &[u8]) -> Result<Vec<u8>> {
        let storage: Vec<(Vec<u8>, Vec<u8>)> = self
            .provider
            .storage()
            .values
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        let payload = BackupPayload {
            device_id: self.device_id.clone(),
            credential_with_key: postcard::to_allocvec(&self.credential_with_key)
                .map_err(mls_err)?,
            signature_keys: postcard::to_allocvec(&self.signature_keys).map_err(mls_err)?,
            circle_ids: self.groups.keys().cloned().collect(),
            policies: self.policies.clone(),
            storage,
            app_metadata: app_metadata.to_vec(),
        };

        let plaintext = postcard::to_allocvec(&payload).map_err(mls_err)?;
        encrypt_backup_blob(enc_key, &plaintext)
    }

    /// Restore an export using its original enc_key. Authentication failure returns
    /// [`CryptoCoreError::BackupDecryptFailed`] before deserializing any state.
    /// Returns the restored core and the original app_metadata.
    pub fn import_encrypted_state(enc_key: &[u8], ciphertext: &[u8]) -> Result<(Self, Vec<u8>)> {
        let plaintext = decrypt_backup_blob(enc_key, ciphertext)?;
        let payload: BackupPayload =
            postcard::from_bytes(&plaintext).map_err(|_| CryptoCoreError::BackupDecryptFailed)?;

        let credential_with_key: CredentialWithKey =
            postcard::from_bytes(&payload.credential_with_key)
                .map_err(|_| CryptoCoreError::BackupDecryptFailed)?;
        let signature_keys: SignatureKeyPair = postcard::from_bytes(&payload.signature_keys)
            .map_err(|_| CryptoCoreError::BackupDecryptFailed)?;

        // Rehydrate the provider first: each MlsGroup::load below resolves its
        // keys and pending protocol state from this restored storage.
        let provider = OpenMlsRustCrypto::default();
        {
            let mut values = provider
                .storage()
                .values
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            values.extend(payload.storage);
        }

        let mut groups = HashMap::new();
        for circle_id in &payload.circle_ids {
            let group_id_bytes =
                hex::decode(circle_id).map_err(|_| CryptoCoreError::BackupDecryptFailed)?;
            let group_id = GroupId::from_slice(&group_id_bytes);
            let group = MlsGroup::load(provider.storage(), &group_id)
                .map_err(mls_err)?
                .ok_or_else(|| circle_not_found(circle_id))?;
            groups.insert(circle_id.clone(), group);
        }

        let core = Self {
            device_id: payload.device_id,
            provider,
            credential_with_key,
            signature_keys,
            groups,
            policies: payload.policies,
            pending_welcomes: HashMap::new(),
            locations: Default::default(),
        };
        Ok((core, payload.app_metadata))
    }

    /// Build a device identity and its backup credentials from a seed phrase.
    /// Registers nothing in the `DEVICES` map, so a test can hold several
    /// independent cores in one process without them sharing that global. The
    /// FFI wrapper `create_identity_from_seed_phrase` does the registration.
    pub fn from_seed_phrase(phrase: &str) -> Result<(Self, BackupCredentials)> {
        let seed = parse_seed_phrase(phrase)?;
        let identity_seed = hkdf_expand_32(&seed, BACKUP_IDENTITY_DOMAIN)?;

        let mut device_id_bytes = [0u8; DEVICE_ID_BYTE_LEN];
        let hk = Hkdf::<Sha256>::new(None, &seed);
        hk.expand(BACKUP_DEVICE_ID_DOMAIN, &mut device_id_bytes)
            .map_err(mls_err)?;
        let device_id = format!("device-{}", hex::encode(device_id_bytes));

        let core = Self::new_from_seed(device_id, identity_seed)?;
        let credentials = BackupCredentials {
            backup_id: backup_id_for_seed(&seed),
            auth_key: hkdf_expand_32(&seed, BACKUP_AUTH_DOMAIN)?.to_vec(),
            enc_key: hkdf_expand_32(&seed, BACKUP_ENC_DOMAIN)?.to_vec(),
        };
        Ok((core, credentials))
    }
}

/// Validate a seed phrase with `Mnemonic::parse` (checksum, word list, word
/// count) and return the 64-byte BIP39 seed. `to_seed("")` passes no BIP39
/// passphrase: the phrase is meant to be the only secret. Shared by the
/// functions below so parsing and its error mapping live in one place.
fn parse_seed_phrase(phrase: &str) -> Result<[u8; 64]> {
    let mnemonic =
        Mnemonic::parse(phrase).map_err(|e| CryptoCoreError::InvalidSeedPhrase(e.to_string()))?;
    Ok(mnemonic.to_seed(""))
}

/// Derive a purpose-specific key; distinct domain labels keep key uses separate.
fn hkdf_expand_32(seed: &[u8], domain: &[u8]) -> Result<[u8; BACKUP_KEY_LEN]> {
    let hk = Hkdf::<Sha256>::new(None, seed);
    let mut out = [0u8; BACKUP_KEY_LEN];
    hk.expand(domain, &mut out).map_err(mls_err)?;
    Ok(out)
}

/// Public backup lookup key: SHA-256(domain || seed). The generated BIP39
/// phrase provides 128 bits of entropy; this hash is not a password KDF.
fn backup_id_for_seed(seed: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(BACKUP_ID_DOMAIN);
    hasher.update(seed);
    hex::encode(hasher.finalize())
}

/// A fresh 12-word BIP39 phrase, from `bip39`'s own `rand::thread_rng()`.
///
/// This and the derivation helpers below are free functions rather than
/// `device_slot`-scoped methods because a fresh install restoring from a
/// phrase needs them before any identity exists to scope them by.
#[uniffi::export]
pub fn generate_seed_phrase() -> std::result::Result<String, CryptoCoreError> {
    let mnemonic = Mnemonic::generate(SEED_PHRASE_WORD_COUNT)
        .map_err(|e| CryptoCoreError::InvalidSeedPhrase(e.to_string()))?;
    Ok(mnemonic.to_string())
}

/// Derive a phrase's relay credentials without creating or touching a local
/// identity. Used to tell register from restore (does a backup for this
/// `backup_id` already exist?) and as the first step of a restore;
/// [`import_encrypted_state`] does the rest. A mistyped word fails the BIP39
/// checksum here, before any network call.
#[uniffi::export]
pub fn derive_backup_credentials_from_seed_phrase(
    phrase: String,
) -> std::result::Result<BackupCredentials, CryptoCoreError> {
    let seed = parse_seed_phrase(&phrase)?;
    Ok(BackupCredentials {
        backup_id: backup_id_for_seed(&seed),
        auth_key: hkdf_expand_32(&seed, BACKUP_AUTH_DOMAIN)?.to_vec(),
        enc_key: hkdf_expand_32(&seed, BACKUP_ENC_DOMAIN)?.to_vec(),
    })
}

/// Create a device identity from a seed phrase and register it under
/// `device_slot`, like [`create_identity`]. The phrase reproduces the same
/// keypair and `device_id` every time (see [`CryptoCore::new_from_seed`]),
/// which is what lets a restored install keep the identity other members
/// already have in their rosters.
#[uniffi::export]
pub fn create_identity_from_seed_phrase(
    device_slot: String,
    phrase: String,
) -> std::result::Result<CreatedIdentity, CryptoCoreError> {
    let (core, credentials) = CryptoCore::from_seed_phrase(&phrase)?;
    let identity = core.identity();

    let mut guard = DEVICES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard
        .get_or_insert_with(HashMap::new)
        .insert(device_slot, core);

    Ok(CreatedIdentity {
        identity,
        backup_id: credentials.backup_id,
        auth_key: credentials.auth_key,
        enc_key: credentials.enc_key,
    })
}

/// HMAC-SHA256 proof over a relay-issued challenge nonce. Verified by
/// `relay/Program.cs`'s `/v1/backups` endpoints.
#[uniffi::export]
pub fn compute_backup_proof(
    auth_key: Vec<u8>,
    nonce: Vec<u8>,
) -> std::result::Result<Vec<u8>, CryptoCoreError> {
    let mut mac = Hmac::<Sha256>::new_from_slice(&auth_key).map_err(mls_err)?;
    mac.update(&nonce);
    Ok(mac.finalize().into_bytes().to_vec())
}

const MAX_RANDOM_BYTES_LEN: u32 = 1024;

/// Supply OS-generated random bytes to the app, capped at 1024 bytes per call.
/// Used for invitation secrets, unlike the display/event identifiers below.
#[uniffi::export]
pub fn random_bytes(len: u32) -> std::result::Result<Vec<u8>, CryptoCoreError> {
    if len > MAX_RANDOM_BYTES_LEN {
        return Err(mls_err(format!(
            "random_bytes: len must be <= {MAX_RANDOM_BYTES_LEN}"
        )));
    }
    let mut buf = vec![0u8; len as usize];
    getrandom_fill(&mut buf);
    Ok(buf)
}

/// Short, unique-enough string for device and event ids. Not a security
/// value. Uses the system RNG because it runs before any particular circle's
/// OpenMLS provider exists.
fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut buf = [0u8; 8];
    getrandom_fill(&mut buf);
    format!("{nanos:x}-{}", hex::encode(buf))
}

fn getrandom_fill(buf: &mut [u8]) {
    // OS CSPRNG via `getrandom`. This also backs `random_bytes`, which the
    // app uses for invite nonces, so it has to stay a CSPRNG.
    use rand::RngCore;
    rand::rngs::OsRng.fill_bytes(buf);
}

// UniFFI calls carry slot names rather than Rust references. This registry owns
// the corresponding cores for the lifetime of the process, not across restarts.
static DEVICES: Mutex<Option<HashMap<String, CryptoCore>>> = Mutex::new(None);

/// Resolve a bridge slot and hold the registry lock throughout its operation.
/// This serializes access to mutable MLS state across native callers.
fn with_device<T>(device_slot: &str, f: impl FnOnce(&mut CryptoCore) -> Result<T>) -> Result<T> {
    let mut guard = DEVICES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    let core = map
        .get_mut(device_slot)
        .ok_or(CryptoCoreError::NoIdentity)?;
    f(core)
}

/// Create a random identity in this slot, replacing any core already stored there.
#[uniffi::export]
pub fn create_identity(
    device_slot: String,
) -> std::result::Result<DeviceIdentity, CryptoCoreError> {
    let core = CryptoCore::new()?;
    let identity = core.identity();
    let mut guard = DEVICES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard
        .get_or_insert_with(HashMap::new)
        .insert(device_slot, core);
    Ok(identity)
}

/// Create a circle for the selected device; see [`CryptoCore::create_circle`].
#[uniffi::export]
pub fn create_circle(device_slot: String) -> std::result::Result<CircleBootstrap, CryptoCoreError> {
    with_device(&device_slot, |core| core.create_circle())
}

/// Generate the public-key bundle another device needs to add this device.
#[uniffi::export]
pub fn create_key_package(device_slot: String) -> std::result::Result<Vec<u8>, CryptoCoreError> {
    with_device(&device_slot, |core| core.create_key_package())
}

/// Read the joining identity from a validated KeyPackage, not a UI-supplied name.
#[uniffi::export]
pub fn key_package_identity(
    device_slot: String,
    key_package: Vec<u8>,
) -> std::result::Result<String, CryptoCoreError> {
    with_device(&device_slot, |core| core.key_package_identity(&key_package))
}

/// Add and immediately merge a member locally; mobile sends use the staged API instead.
#[uniffi::export]
pub fn add_member(
    device_slot: String,
    circle_id: String,
    member_key_package: Vec<u8>,
) -> std::result::Result<MlsCommit, CryptoCoreError> {
    with_device(&device_slot, |core| {
        core.add_member(&circle_id, &member_key_package)
    })
}

/// Apply a received membership update at its position in the ordered mailbox.
#[uniffi::export]
pub fn process_commit(
    device_slot: String,
    circle_id: String,
    commit: Vec<u8>,
) -> std::result::Result<(), CryptoCoreError> {
    with_device(&device_slot, |core| {
        core.process_commit(&circle_id, &commit)
    })
}

/// Take the cached Welcome from the most recent eager add; it can be retrieved once.
#[uniffi::export]
pub fn create_welcome(
    device_slot: String,
    circle_id: String,
    member_key_package: Vec<u8>,
) -> std::result::Result<Vec<u8>, CryptoCoreError> {
    with_device(&device_slot, |core| {
        core.create_welcome(&circle_id, &member_key_package)
    })
}

/// Join without pinning an administrator, for the legacy compatibility path.
#[uniffi::export]
pub fn join_from_welcome(
    device_slot: String,
    welcome: Vec<u8>,
) -> std::result::Result<String, CryptoCoreError> {
    with_device(&device_slot, |core| core.join_from_welcome(&welcome))
}

/// Join and bind membership authority to the administrator named in the invitation.
#[uniffi::export]
pub fn join_from_welcome_with_admin(
    device_slot: String,
    welcome: Vec<u8>,
    administrator: String,
) -> std::result::Result<String, CryptoCoreError> {
    with_device(&device_slot, |core| {
        core.join_from_welcome_with_admin(&welcome, Some(administrator))
    })
}

/// Record a handover after the caller authenticates the administrator-transfer message.
#[uniffi::export]
pub fn adopt_membership_admin(
    device_slot: String,
    circle_id: String,
    current_admin: String,
    next_admin: String,
) -> std::result::Result<(), CryptoCoreError> {
    with_device(&device_slot, |core| {
        core.adopt_membership_admin(&circle_id, &current_admin, &next_admin)
    })
}

/// Remove and immediately merge locally; use staged changes for ordered mobile delivery.
#[uniffi::export]
pub fn remove_member(
    device_slot: String,
    circle_id: String,
    member_id: String,
) -> std::result::Result<MlsCommit, CryptoCoreError> {
    with_device(&device_slot, |core| {
        core.remove_member(&circle_id, &member_id)
    })
}

/// Return the roster this device currently knows, which may lag behind other phones.
#[uniffi::export]
pub fn list_members(
    device_slot: String,
    circle_id: String,
) -> std::result::Result<Vec<String>, CryptoCoreError> {
    with_device(&device_slot, |core| core.list_members(&circle_id))
}

/// See [`CryptoCore::forget_circle`].
#[uniffi::export]
pub fn forget_circle(
    device_slot: String,
    circle_id: String,
) -> std::result::Result<(), CryptoCoreError> {
    with_device(&device_slot, |core| core.forget_circle(&circle_id))
}

/// Produce a signed departure proposal for an administrator to commit.
#[uniffi::export]
pub fn propose_leave(
    device_slot: String,
    circle_id: String,
) -> std::result::Result<Vec<u8>, CryptoCoreError> {
    with_device(&device_slot, |core| core.propose_leave(&circle_id))
}

/// Validate and queue a proposal without yet applying its membership change.
#[uniffi::export]
pub fn process_proposal(
    device_slot: String,
    circle_id: String,
    proposal: Vec<u8>,
) -> std::result::Result<(), CryptoCoreError> {
    with_device(&device_slot, |core| {
        core.process_proposal(&circle_id, &proposal)
    })
}

/// Commit queued proposals as administrator and advance local group state immediately.
#[uniffi::export]
pub fn commit_pending_proposals(
    device_slot: String,
    circle_id: String,
) -> std::result::Result<MlsCommit, CryptoCoreError> {
    with_device(&device_slot, |core| {
        core.commit_pending_proposals(&circle_id)
    })
}

/// Encrypt bytes for the circle; save the changed state and envelope before sending.
#[uniffi::export]
pub fn encrypt_event(
    device_slot: String,
    circle_id: String,
    payload: Vec<u8>,
) -> std::result::Result<EncryptedEnvelope, CryptoCoreError> {
    with_device(&device_slot, |core| {
        core.encrypt_event(&circle_id, &payload)
    })
}

/// Immediately advance to a fresh epoch using an administrator-authored key update.
#[uniffi::export]
pub fn refresh_circle_keys(device_slot: String, circle_id: String) -> Result<MlsCommit> {
    with_device(&device_slot, |core| core.refresh_circle_keys(&circle_id))
}

/// Stage an update for ordered publication; see [`CryptoCore::prepare_membership_change`].
#[uniffi::export]
pub fn prepare_membership_change(
    device_slot: String,
    circle_id: String,
    key_package: Vec<u8>,
    remove_ids: Vec<String>,
) -> Result<PreparedMembershipChange> {
    with_device(&device_slot, |core| {
        core.prepare_membership_change(&circle_id, &key_package, &remove_ids)
    })
}

/// Expose the epoch and pending-update flag without changing group state.
#[uniffi::export]
pub fn circle_publication_state(
    device_slot: String,
    circle_id: String,
) -> Result<CirclePublicationState> {
    with_device(&device_slot, |core| {
        core.circle_publication_state(&circle_id)
    })
}

/// Verify that a departure proposal removes its own sender and return that sender ID.
#[uniffi::export]
pub fn process_leave(device_slot: String, circle_id: String, proposal: Vec<u8>) -> Result<String> {
    with_device(&device_slot, |core| {
        core.process_leave(&circle_id, &proposal)
    })
}

/// Decrypt for the selected device and return plaintext with the authenticated sender ID.
#[uniffi::export]
pub fn decrypt_event(
    device_slot: String,
    circle_id: String,
    envelope: EncryptedEnvelope,
) -> std::result::Result<DecryptedEvent, CryptoCoreError> {
    with_device(&device_slot, |core| {
        core.decrypt_event(&circle_id, &envelope)
    })
}

/// Encrypt identity, MLS state, and opaque app metadata into a checkpoint or recovery blob.
#[uniffi::export]
pub fn export_encrypted_state(
    device_slot: String,
    enc_key: Vec<u8>,
    app_metadata: Vec<u8>,
) -> std::result::Result<Vec<u8>, CryptoCoreError> {
    with_device(&device_slot, |core| {
        core.export_encrypted_state(&enc_key, &app_metadata)
    })
}

/// Authenticate and restore a blob, replacing this slot only after import succeeds.
#[uniffi::export]
pub fn import_encrypted_state(
    device_slot: String,
    enc_key: Vec<u8>,
    state: Vec<u8>,
) -> std::result::Result<ImportedBackup, CryptoCoreError> {
    let (core, app_metadata) = CryptoCore::import_encrypted_state(&enc_key, &state)?;
    let identity = core.identity();
    let mut guard = DEVICES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard
        .get_or_insert_with(HashMap::new)
        .insert(device_slot, core);
    Ok(ImportedBackup {
        identity,
        app_metadata,
    })
}

/// Dispatch a JSON location operation for this device; returns JSON and performs no network I/O.
#[uniffi::export]
pub fn location_command(device_slot: String, command: String) -> Result<String> {
    with_device(&device_slot, |core| core.location_command(&command))
}
