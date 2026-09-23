//! Independent, owner-authenticated current-position snapshots. Never exported
//! in the seed recovery backup. MLS distributes keys, not position history.
//!
//! Positions do not travel as MLS application messages. Location is a
//! latest-value feed, not a log: sending every fix through the group would
//! ratchet constantly and leave the relay holding a coordinate history. So MLS
//! carries only a `Descriptor` (the session id, its public key and a 32-byte
//! snapshot key), and the fixes themselves go to a separate relay row that gets
//! overwritten in place.
//!
//! Members get the snapshot key, never the session signing key. They can read
//! an owner's position and cannot publish one for them. The relay checks the
//! signature and a strictly increasing revision without being able to decrypt
//! anything, and a stopped or expired session becomes a terminal row that no
//! later write can revive.

use super::*;
use chacha20poly1305::aead::Payload;
use ed25519_dalek::{Signature, Signer, VerifyingKey};
use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Value};

const DOMAIN: &str = "family-circle/location/v1";

/// JavaScript's exact-integer ceiling. Revisions cross the FFI boundary as
/// JSON numbers; larger integers are not all exactly representable.
const MAX_REV: u64 = 9_007_199_254_740_991;

/// Use one error for invalid signatures, stale epochs, expired sessions, and
/// malformed fields. JSON decoding errors are reported separately through mls_err.
fn fail() -> CryptoCoreError {
    CryptoCoreError::Mls("Location data is invalid or no longer authorized".into())
}

/// Generate fixed-size session keys and nonces directly from the OS random source.
fn random<const N: usize>() -> [u8; N] {
    let mut b = [0; N];
    OsRng.fill_bytes(&mut b);
    b
}

/// Decode a hex field and require exactly N bytes.
fn decode<const N: usize>(s: &str) -> Result<[u8; N]> {
    hex::decode(s)
        .map_err(|_| fail())?
        .try_into()
        .map_err(|_| fail())
}

/// Require a JSON string field at the untyped native-command boundary.
fn str_arg<'a>(v: &'a Value, name: &str) -> Result<&'a str> {
    v[name].as_str().ok_or_else(fail)
}

/// Require a nonnegative integer; timestamps and revisions must not be fractional.
fn num(v: &Value, name: &str) -> Result<u64> {
    v[name].as_u64().ok_or_else(fail)
}

/// One published snapshot, exactly as the relay stores and serves it.
///
/// `header()` is the canonical form that both the AEAD and the signature bind
/// to, so none of these fields can be edited in transit without invalidating
/// one or the other.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Wire {
    pub generation: String,
    pub session_id: String,
    pub mailbox_id: String,
    pub public_key: String,
    pub epoch: u64,
    pub expires_at: u64,
    pub revision: u64,
    pub stopped: bool,
    pub nonce: String,
    pub ciphertext: String,
    pub signature: String,
}

impl Wire {
    /// Keep this field order identical to the relay's signing format.
    fn header(&self) -> String {
        format!(
            "{DOMAIN}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
            self.generation,
            self.session_id,
            self.mailbox_id,
            self.public_key,
            self.epoch,
            self.expires_at,
            self.revision,
            if self.stopped { 1 } else { 0 }
        )
    }

    /// Bind both the routing header and encrypted body to the owner's signature.
    fn signed_bytes(&self) -> Vec<u8> {
        format!("{}\n{}\n{}", self.header(), self.nonce, self.ciphertext).into_bytes()
    }

    /// Sign with the session owner's private key, which other circle members never receive.
    fn sign(&mut self, key: &[u8; 32]) {
        self.signature = hex::encode(
            SigningKey::from_bytes(key)
                .sign(&self.signed_bytes())
                .to_bytes(),
        );
    }

    /// Verify the session ID's public-key binding, revision bounds, and signature.
    fn verify(&self) -> Result<()> {
        let public = decode::<32>(&self.public_key)?;
        if hex::encode(Sha256::digest(public)) != self.session_id
            || self.revision == 0
            || self.revision > MAX_REV
        {
            return Err(fail());
        }
        VerifyingKey::from_bytes(&public)
            .map_err(|_| fail())?
            .verify_strict(
                &self.signed_bytes(),
                &Signature::from_bytes(&decode::<64>(&self.signature)?),
            )
            .map_err(|_| fail())
    }
}

/// Session information shared through MLS, including the key for decrypting fixes.
/// The signing secret is deliberately absent: read access does not grant write access.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Descriptor {
    circle_id: String,
    mailbox_id: String,
    session_id: String,
    generation: String,
    public_key: String,
    epoch: u64,
    expires_at: u64,
    key: [u8; 32],
}

/// This device's sharing session, including its private signing key and upload progress.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Own {
    descriptor: Descriptor,
    signing: [u8; 32],
    interval: u64,
    revision: u64,
    last_uploaded: u64,
    active: bool,
    #[serde(default)]
    report_battery: bool,
}

/// A trusted session descriptor plus the latest accepted position, if one is available.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Received {
    descriptor: Descriptor,
    sender: String,
    revision: u64,
    fix: Option<Value>,
}

/// An encrypted descriptor waiting for delivery through the circle's MLS mailbox.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Control {
    circle_id: String,
    mailbox_id: String,
    envelope: EncryptedEnvelope,
}

/// Local sharing state and outboxes, persisted separately from seed recovery backups.
#[derive(Default, Serialize, Deserialize)]
pub(super) struct LocationState {
    /// Last positive caller-supplied time. A backwards jump of more than a
    /// minute stops active sessions before the command is processed.
    #[serde(default)]
    last_clock: u64,
    own: HashMap<String, Own>,
    received: HashMap<String, Received>,
    pending: HashMap<String, Wire>,
    controls: Vec<Control>,
}

impl CryptoCore {
    /// Require active membership before accepting or publishing a circle's location data.
    fn location_epoch(&self, circle: &str) -> Result<u64> {
        let g = self.groups.get(circle).ok_or_else(fail)?;
        if !g.is_active() {
            return Err(fail());
        }
        Ok(g.epoch().as_u64())
    }

    /// Replace any queued fix with a signed stop and clear this session's local keys.
    /// The stop stays pending until delivery, including when the phone is offline.
    fn stop_location(&mut self, circle: &str) -> Result<()> {
        if let Some(own) = self.locations.own.get_mut(circle) {
            if own.active {
                own.active = false;
                own.revision += 1;
                let d = own.descriptor.clone();
                let mut wire = Wire {
                    generation: d.generation.clone(),
                    session_id: d.session_id.clone(),
                    mailbox_id: d.mailbox_id.clone(),
                    public_key: d.public_key.clone(),
                    epoch: d.epoch,
                    expires_at: d.expires_at,
                    revision: own.revision,
                    stopped: true,
                    nonce: String::new(),
                    ciphertext: String::new(),
                    signature: String::new(),
                };
                wire.sign(&own.signing);
                self.locations.pending.insert(d.session_id.clone(), wire);
                own.descriptor.key.fill(0);
                own.signing.fill(0);
                self.locations.received.remove(&d.session_id);
                self.locations.controls.retain(|c| c.circle_id != circle);
            }
        }
        Ok(())
    }

    /// Clear the circle's location state while preserving stops that still need uploading.
    pub(super) fn forget_location_circle(&mut self, circle: &str) -> Result<()> {
        self.stop_location(circle)?;
        self.locations.own.remove(circle);
        self.locations
            .received
            .retain(|_, pin| pin.descriptor.circle_id != circle);
        self.locations
            .controls
            .retain(|control| control.circle_id != circle);
        // Retain signed terminal snapshots so offline deletion can revoke
        // the previously published pin when the relay becomes reachable.
        Ok(())
    }

    /// Replace the old session with fresh encryption and signing keys for this epoch.
    /// Queue its descriptor through MLS; actual fixes use the separate snapshot feed.
    /// Times and intervals are milliseconds; an expiry of zero means no time limit.
    fn start_location(
        &mut self,
        circle: &str,
        mailbox: &str,
        generation: &str,
        interval: u64,
        expires: u64,
        now: u64,
    ) -> Result<()> {
        if ![60_000, 120_000, 300_000, 900_000, 1_800_000].contains(&interval)
            || (expires != 0 && (expires <= now || expires - now > 30 * 86_400_000))
        {
            return Err(fail());
        }
        decode::<16>(generation)?;
        decode::<16>(mailbox)?;
        let epoch = self.location_epoch(circle)?;
        if self.locations.pending.len() > 256 {
            return Err(fail());
        }

        let sharing_started = self.locations.own.get(circle).is_none_or(|own| {
            !own.active || (own.descriptor.expires_at != 0 && now >= own.descriptor.expires_at)
        });
        self.stop_location(circle)?;
        let signing = random::<32>();
        let public = SigningKey::from_bytes(&signing).verifying_key().to_bytes();
        let descriptor = Descriptor {
            circle_id: circle.into(),
            mailbox_id: mailbox.into(),
            generation: generation.into(),
            session_id: hex::encode(Sha256::digest(public)),
            public_key: hex::encode(public),
            epoch,
            expires_at: expires,
            key: random(),
        };

        // Keep notification intent in the authenticated control only. Persisted
        // descriptors and existing encrypted location vaults remain compatible.
        let mut payload = serde_json::to_value(&descriptor).map_err(mls_err)?;
        payload["sharingStarted"] = json!(sharing_started);
        let envelope =
            self.encrypt_event(circle, &serde_json::to_vec(&payload).map_err(mls_err)?)?;
        self.locations.controls.push(Control {
            circle_id: circle.into(),
            mailbox_id: mailbox.into(),
            envelope,
        });

        self.locations.own.insert(
            circle.into(),
            Own {
                descriptor,
                signing,
                interval,
                revision: 0,
                last_uploaded: 0,
                active: true,
                report_battery: false,
            },
        );
        Ok(())
    }

    /// JSON command interface: {"op": ...} in, JSON out. Validate fields here
    /// because the FFI signature cannot type-check individual commands.
    ///
    /// Ops: start, stop, stopAll, setBattery, publish, reconcile, control, receive,
    /// terminal, missing, ack, ackControl, status, export, import.
    ///
    /// Any command may supply now in Unix milliseconds for the rollback guard.
    /// start, reconcile, publish, control, receive, and status also check expiry;
    /// ack uses it to timestamp the upload.
    pub(super) fn location_command(&mut self, command: &str) -> Result<String> {
        if command.len() > 2 * 1024 * 1024 {
            return Err(fail());
        }
        let v: Value = serde_json::from_str(command).map_err(mls_err)?;
        let now = v["now"].as_u64().unwrap_or(0);
        if now > 0 {
            if self.locations.last_clock > now + 60_000 {
                for circle in self.locations.own.keys().cloned().collect::<Vec<_>>() {
                    self.stop_location(&circle)?;
                }
            }
            self.locations.last_clock = now;
        }

        let result = match str_arg(&v, "op")? {
            "start" => {
                self.start_location(
                    str_arg(&v, "circleId")?,
                    str_arg(&v, "mailboxId")?,
                    str_arg(&v, "generation")?,
                    num(&v, "interval")?,
                    num(&v, "expiresAt")?,
                    now,
                )?;
                self.locations
                    .own
                    .get_mut(str_arg(&v, "circleId")?)
                    .ok_or_else(fail)?
                    .report_battery = v["reportBattery"].as_bool().unwrap_or(false);
                json!(true)
            }
            "setBattery" => {
                let circle = str_arg(&v, "circleId")?;
                let enabled = v["enabled"].as_bool().ok_or_else(fail)?;
                let own = self.locations.own.get_mut(circle).ok_or_else(fail)?;
                own.report_battery = enabled;
                let session = own.descriptor.session_id.clone();
                let active = own.active;
                // Queue a replacement without battery metadata, using the last fix.
                // Other devices see the change once the replacement is delivered.
                if !enabled && active {
                    if let Some(mut fix) = self
                        .locations
                        .received
                        .get(&session)
                        .and_then(|r| r.fix.clone())
                    {
                        fix.as_object_mut()
                            .ok_or_else(fail)?
                            .remove("batteryPercent");
                        self.location_command(
                            &json!({"op":"publish","circleId":circle,"fix":fix,"now":now})
                                .to_string(),
                        )?;
                    }
                }
                json!(true)
            }
            "stop" => {
                self.stop_location(str_arg(&v, "circleId")?)?;
                json!(true)
            }
            "stopAll" => {
                for circle in self.locations.own.keys().cloned().collect::<Vec<_>>() {
                    self.stop_location(&circle)?;
                }
                json!(true)
            }

            // Membership or relay-generation changes need fresh session keys. Keep
            // the original expiry so reconciliation cannot extend sharing consent.
            "reconcile" => {
                let generation = str_arg(&v, "generation")?;
                for (circle, own) in self.locations.own.clone() {
                    if !own.active {
                        continue;
                    }
                    let epoch = self.location_epoch(&circle);
                    if epoch.is_err()
                        || (own.descriptor.expires_at != 0 && now >= own.descriptor.expires_at)
                    {
                        self.stop_location(&circle)?;
                    } else if epoch? != own.descriptor.epoch
                        || generation != own.descriptor.generation
                    {
                        self.start_location(
                            &circle,
                            &own.descriptor.mailbox_id,
                            generation,
                            own.interval,
                            own.descriptor.expires_at,
                            now,
                        )?;
                        self.locations
                            .own
                            .get_mut(&circle)
                            .ok_or_else(fail)?
                            .report_battery = own.report_battery;
                    }
                }
                // Drop descriptors that no longer match the reconciled session state.
                let valid = self
                    .locations
                    .received
                    .iter()
                    .filter(|(_, r)| {
                        self.location_epoch(&r.descriptor.circle_id).ok()
                            == Some(r.descriptor.epoch)
                            && (r.descriptor.expires_at == 0 || now < r.descriptor.expires_at)
                            && r.descriptor.generation == generation
                    })
                    .map(|(id, _)| id.clone())
                    .collect::<HashSet<_>>();
                self.locations.received.retain(|id, _| valid.contains(id));
                json!(true)
            }

            // Seal one latest-value snapshot. Replacing the pending entry coalesces
            // offline fixes rather than building a history of positions to upload.
            "publish" => {
                let circle = str_arg(&v, "circleId")?;
                let epoch = self.location_epoch(circle)?;
                let own = self.locations.own.get_mut(circle).ok_or_else(fail)?;
                if !own.active
                    || epoch != own.descriptor.epoch
                    || (own.descriptor.expires_at != 0 && now >= own.descriptor.expires_at)
                {
                    return Err(fail());
                }

                let mut fix = v["fix"].clone();
                // Battery consent is enforced here, not in the UI: the field is
                // stripped before it can reach a signed snapshot.
                if !own.report_battery {
                    fix.as_object_mut()
                        .ok_or_else(fail)?
                        .remove("batteryPercent");
                }
                validate_fix(&fix, now)?;
                fix["updateInterval"] = json!(own.interval);
                fix["updatedAt"] = json!(now);
                own.revision += 1;
                let d = &own.descriptor;
                let mut wire = Wire {
                    generation: d.generation.clone(),
                    session_id: d.session_id.clone(),
                    mailbox_id: d.mailbox_id.clone(),
                    public_key: d.public_key.clone(),
                    epoch: d.epoch,
                    expires_at: d.expires_at,
                    revision: own.revision,
                    stopped: false,
                    nonce: hex::encode(random::<12>()),
                    ciphertext: String::new(),
                    signature: String::new(),
                };

                let cipher = ChaCha20Poly1305::new(&d.key.into());
                wire.ciphertext = hex::encode(
                    cipher
                        .encrypt(
                            &decode::<12>(&wire.nonce)?.into(),
                            Payload {
                                msg: &serde_json::to_vec(&fix).map_err(mls_err)?,
                                aad: wire.header().as_bytes(),
                            },
                        )
                        .map_err(|_| fail())?,
                );
                wire.sign(&own.signing);

                self.locations.received.insert(
                    d.session_id.clone(),
                    Received {
                        descriptor: d.clone(),
                        sender: self.device_id.clone(),
                        revision: own.revision,
                        fix: Some(fix.clone()),
                    },
                );
                self.locations.pending.insert(d.session_id.clone(), wire);
                json!(true)
            }

            // Trust a descriptor only after MLS identifies its sender. A public
            // relay snapshot alone cannot establish who owns a sharing session.
            "control" => {
                let circle = str_arg(&v, "circleId")?;
                let envelope: EncryptedEnvelope =
                    serde_json::from_value(v["envelope"].clone()).map_err(mls_err)?;
                let event = self.decrypt_event(circle, &envelope)?;
                let payload: Value = serde_json::from_slice(&event.plaintext).map_err(mls_err)?;
                let sharing_started = payload["sharingStarted"].as_bool().unwrap_or(false);
                let d: Descriptor = serde_json::from_value(payload).map_err(mls_err)?;
                if d.circle_id != circle
                    || self.location_epoch(circle)? != d.epoch
                    || (d.expires_at != 0 && now >= d.expires_at)
                    || hex::encode(Sha256::digest(decode::<32>(&d.public_key)?)) != d.session_id
                {
                    return Err(fail());
                }
                self.locations.received.retain(|_, r| {
                    r.descriptor.circle_id != circle || r.sender != event.sender_device_id
                });
                let sender = event.sender_device_id.clone();
                self.locations.received.insert(
                    d.session_id.clone(),
                    Received {
                        descriptor: d,
                        sender: event.sender_device_id,
                        revision: 0,
                        fix: None,
                    },
                );
                json!({"senderId": sender, "sharingStarted": sharing_started})
            }

            // Verify ownership and match the MLS-delivered descriptor before
            // decrypting. Reject older revisions so stale responses cannot rewind a pin.
            "receive" => {
                let wire: Wire = serde_json::from_value(v["snapshot"].clone()).map_err(mls_err)?;
                wire.verify()?;
                let received = self
                    .locations
                    .received
                    .get(&wire.session_id)
                    .ok_or_else(fail)?;
                let d = &received.descriptor;
                if self.location_epoch(&d.circle_id)? != d.epoch
                    || wire.public_key != d.public_key
                    || wire.generation != d.generation
                    || wire.mailbox_id != d.mailbox_id
                    || wire.epoch != d.epoch
                    || wire.expires_at != d.expires_at
                {
                    return Err(fail());
                }

                // Re-fetching the same revision is allowed; only older ones are stale.
                if wire.revision < received.revision {
                    return Err(fail());
                }
                if wire.stopped || (d.expires_at != 0 && now >= d.expires_at) {
                    self.locations.received.remove(&wire.session_id);
                } else {
                    let cipher = ChaCha20Poly1305::new(&d.key.into());
                    let bytes = cipher
                        .decrypt(
                            &decode::<12>(&wire.nonce)?.into(),
                            Payload {
                                msg: &hex::decode(&wire.ciphertext).map_err(|_| fail())?,
                                aad: wire.header().as_bytes(),
                            },
                        )
                        .map_err(|_| fail())?;
                    let fix: Value = serde_json::from_slice(&bytes).map_err(mls_err)?;
                    validate_fix(&fix, now)?;
                    let r = self
                        .locations
                        .received
                        .get_mut(&wire.session_id)
                        .ok_or_else(fail)?;
                    r.revision = wire.revision;
                    r.fix = Some(fix);
                }
                json!(true)
            }

            // The relay reports the session has ended; discard the descriptor and pin.
            "terminal" => {
                self.locations.received.remove(str_arg(&v, "sessionId")?);
                json!(true)
            }

            // No snapshot yet: hide the pin but retain the descriptor for a later fix.
            "missing" => {
                if let Some(r) = self.locations.received.get_mut(str_arg(&v, "sessionId")?) {
                    r.fix = None;
                }
                json!(true)
            }

            // An old upload response must not discard a newer queued snapshot.
            // Remove only the revision that the relay has acknowledged.
            "ack" => {
                let id = str_arg(&v, "sessionId")?;
                let rev = num(&v, "revision")?;
                if self
                    .locations
                    .pending
                    .get(id)
                    .is_some_and(|w| w.revision == rev)
                {
                    self.locations.pending.remove(id);
                }
                for own in self.locations.own.values_mut() {
                    if own.descriptor.session_id == id && own.active {
                        own.last_uploaded = now;
                    }
                }
                json!(true)
            }

            // Descriptor delivery is acknowledged separately from snapshot delivery.
            "ackControl" => {
                let id = str_arg(&v, "eventId")?;
                self.locations
                    .controls
                    .retain(|c| c.envelope.event_id != id);
                json!(true)
            }

            // Reading status also enforces expiry; it is not a passive getter.
            "status" => {
                for (circle, own) in self.locations.own.clone() {
                    if own.active
                        && (self.location_epoch(&circle).is_err()
                            || (own.descriptor.expires_at != 0 && now >= own.descriptor.expires_at))
                    {
                        self.stop_location(&circle)?;
                    }
                }
                // Offline status must erase expired/revoked received positions too,
                // not merely hide them until the next successful relay sync.
                let valid = self
                    .locations
                    .received
                    .iter()
                    .filter(|(_, r)| {
                        self.location_epoch(&r.descriptor.circle_id).ok()
                            == Some(r.descriptor.epoch)
                            && (r.descriptor.expires_at == 0 || now < r.descriptor.expires_at)
                    })
                    .map(|(id, _)| id.clone())
                    .collect::<HashSet<_>>();
                self.locations.received.retain(|id, _| valid.contains(id));
                let shares=self.locations.own.iter().map(|(circle,o)|json!({"circleId":circle,"sessionId":o.descriptor.session_id,"epoch":o.descriptor.epoch,"interval":o.interval,"expiresAt":o.descriptor.expires_at,"active":o.active,"lastUploaded":o.last_uploaded,"reportBattery":o.report_battery})).collect::<Vec<_>>();
                let pins=self.locations.received.values().filter(|r|self.location_epoch(&r.descriptor.circle_id).ok()==Some(r.descriptor.epoch) && (r.descriptor.expires_at==0 || now<r.descriptor.expires_at)).map(|r|json!({"circleId":r.descriptor.circle_id,"sessionId":r.descriptor.session_id,"senderId":r.sender,"fix":r.fix})).collect::<Vec<_>>();
                json!({"shares":shares,"pins":pins,"pending":self.locations.pending.values().collect::<Vec<_>>(),"controls":self.locations.controls})
            }
            "export" => {
                // Derive a local-only wrapping key entirely inside Rust. The
                // ciphertext is additionally placed in Android noBackupFilesDir.
                let material = postcard::to_allocvec(&self.signature_keys).map_err(mls_err)?;
                let key = hkdf_expand_32(&material, b"family-circle/location/local-vault/v1")?;
                json!(hex::encode(encrypt_backup_blob(
                    &key,
                    &serde_json::to_vec(&self.locations).map_err(mls_err)?
                )?))
            }

            // Restore the local vault with this identity's wrapping key. Import
            // itself does not resume uploads; callers reconcile the restored sessions.
            "import" => {
                let key = hkdf_expand_32(
                    &postcard::to_allocvec(&self.signature_keys).map_err(mls_err)?,
                    b"family-circle/location/local-vault/v1",
                )?;
                let bytes = hex::decode(str_arg(&v, "vault")?).map_err(|_| fail())?;
                self.locations =
                    serde_json::from_slice(&decrypt_backup_blob(&key, &bytes)?).map_err(mls_err)?;
                json!(true)
            }
            _ => return Err(fail()),
        };
        serde_json::to_string(&result).map_err(mls_err)
    }
}

/// Check coordinate ranges, accuracy, battery percentage, and observation time.
/// Allow up to a minute of future clock skew. This does not reject old fixes.
fn validate_fix(fix: &Value, now: u64) -> Result<()> {
    if let Some(battery) = fix.get("batteryPercent") {
        if battery.as_u64().filter(|v| *v <= 100).is_none() {
            return Err(fail());
        }
    }
    let lat = fix["latitude"].as_f64().ok_or_else(fail)?;
    let lon = fix["longitude"].as_f64().ok_or_else(fail)?;
    let accuracy = fix["accuracy"].as_f64().ok_or_else(fail)?;
    let at = num(fix, "observedAt")?;
    if !(-90.0..=90.0).contains(&lat)
        || !(-180.0..=180.0).contains(&lon)
        || !(0.0..=100_000.0).contains(&accuracy)
        || at == 0
        || at > now + 60_000
    {
        return Err(fail());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(core: &mut CryptoCore, v: Value) -> Value {
        serde_json::from_str(&core.location_command(&v.to_string()).unwrap()).unwrap()
    }

    fn pair() -> (CryptoCore, CryptoCore, String) {
        let mut a = CryptoCore::new().unwrap();
        let mut b = CryptoCore::new().unwrap();
        let circle = a.create_circle().unwrap().circle_id;
        let kp = b.create_key_package().unwrap();
        a.add_member(&circle, &kp).unwrap();
        let welcome = a.create_welcome(&circle, &kp).unwrap();
        b.join_from_welcome(&welcome).unwrap();
        (a, b, circle)
    }

    fn start(a: &mut CryptoCore, b: &mut CryptoCore, circle: &str) -> Value {
        call(
            a,
            json!({"op":"start","circleId":circle,"mailboxId":"11".repeat(16),"generation":"22".repeat(16),"interval":120000,"expiresAt":0,"now":1000000}),
        );
        let control = call(a, json!({"op":"status","now":1000000}))["controls"][0].clone();
        call(
            b,
            json!({"op":"control","circleId":circle,"envelope":control["envelope"],"now":1000000}),
        );
        call(
            a,
            json!({"op":"publish","circleId":circle,"fix":{"latitude":52.23,"longitude":21.01,"accuracy":10,"observedAt":1000000},"now":1000000}),
        );
        call(a, json!({"op":"status","now":1000000}))["pending"][0].clone()
    }

    #[test]
    fn forgetting_circle_erases_sharing_but_preserves_offline_stop() {
        let (mut a, mut b, circle) = pair();
        start(&mut a, &mut b, &circle);
        a.forget_circle(&circle).unwrap();
        let state = call(&mut a, json!({"op":"status","now":1000000}));
        assert_eq!(state["shares"].as_array().unwrap().len(), 0);
        assert_eq!(state["pins"].as_array().unwrap().len(), 0);
        assert_eq!(state["controls"].as_array().unwrap().len(), 0);
        assert!(state["pending"]
            .as_array()
            .unwrap()
            .iter()
            .all(|wire| wire["stopped"] == true));
        assert!(!state["pending"].as_array().unwrap().is_empty());
        a.forget_circle(&circle).unwrap();
        b.forget_circle(&circle).unwrap();
        assert!(call(&mut b, json!({"op":"status","now":1000000}))["pins"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn sharing_notifications_only_mark_explicit_starts() {
        let (mut a, mut b, circle) = pair();
        let start = json!({"op":"start","circleId":circle,"mailboxId":"11".repeat(16),"generation":"22".repeat(16),"interval":120000,"expiresAt":0,"now":1000000});
        for (operation, expected) in [
            (start.clone(), true),
            (start.clone(), false), // editing an active share
            (
                json!({"op":"reconcile","generation":"33".repeat(16),"now":1000000}),
                false,
            ),
            (json!({"op":"stop","circleId":circle,"now":1000000}), false),
            (start, true), // a new start after stopping
        ] {
            call(&mut a, operation.clone());
            if operation["op"] == "stop" {
                continue;
            }
            let controls = call(&mut a, json!({"op":"status","now":1000000}))["controls"]
                .as_array()
                .unwrap()
                .clone();
            let envelope = controls.last().unwrap()["envelope"].clone();
            let receive =
                json!({"op":"control","circleId":circle,"envelope":envelope,"now":1000000});
            let result = call(&mut b, receive.clone());
            assert_eq!(result["sharingStarted"], expected);
            assert_eq!(result["senderId"], a.device_id);
            assert!(
                b.location_command(&receive.to_string()).is_err(),
                "replayed control cannot notify twice"
            );
        }
    }

    #[test]
    fn simultaneous_sharers_keep_their_own_active_sessions() {
        let (mut a, mut b, circle) = pair();
        let start = |core: &mut CryptoCore| {
            call(
                core,
                json!({"op":"start","circleId":circle,"mailboxId":"11".repeat(16),"generation":"22".repeat(16),"interval":120000,"expiresAt":0,"now":1000000}),
            );
            call(core, json!({"op":"status","now":1000000}))["controls"][0]["envelope"].clone()
        };
        let from_a = start(&mut a);
        let from_b = start(&mut b);
        call(
            &mut a,
            json!({"op":"control","circleId":circle,"envelope":from_b,"now":1000000}),
        );
        call(
            &mut b,
            json!({"op":"control","circleId":circle,"envelope":from_a,"now":1000000}),
        );
        for core in [&mut a, &mut b] {
            call(
                core,
                json!({"op":"publish","circleId":circle,"fix":{"latitude":52.23,"longitude":21.01,"accuracy":10,"observedAt":1000000},"now":1000000}),
            );
            call(
                core,
                json!({"op":"reconcile","generation":"22".repeat(16),"now":1000100}),
            );
            let status = call(core, json!({"op":"status","now":1000100}));
            assert_eq!(status["shares"][0]["active"], true);
            assert_eq!(status["pins"].as_array().unwrap().len(), 2);
        }
    }

    #[test]
    fn replacement_authentication_and_local_vault() {
        let (mut a, mut b, circle) = pair();
        let first = start(&mut a, &mut b, &circle);
        call(
            &mut b,
            json!({"op":"receive","snapshot":first,"now":1000000}),
        );
        assert_eq!(
            call(&mut b, json!({"op":"status","now":1000000}))["pins"][0]["fix"]["latitude"],
            52.23
        );

        // A higher revision is not enough: the signature must cover it too.
        let mut forged = first.clone();
        forged["revision"] = json!(100);
        assert!(b
            .location_command(&json!({"op":"receive","snapshot":forged,"now":1000000}).to_string())
            .is_err());
        call(
            &mut a,
            json!({"op":"publish","circleId":circle,"fix":{"latitude":53,"longitude":21,"accuracy":5,"observedAt":1000100},"now":1000100}),
        );
        let status = call(&mut a, json!({"op":"status","now":1000100}));
        assert_eq!(status["pending"].as_array().unwrap().len(), 1);
        call(
            &mut b,
            json!({"op":"receive","snapshot":status["pending"][0],"now":1000100}),
        );
        assert!(b
            .location_command(&json!({"op":"receive","snapshot":first,"now":1000100}).to_string())
            .is_err());

        let vault = call(&mut a, json!({"op":"export"}));
        assert!(!vault.as_str().unwrap().contains("latitude"));
        call(&mut a, json!({"op":"stop","circleId":circle}));
        let stopped = call(&mut a, json!({"op":"status","now":1000200}))["pending"][0].clone();
        assert_eq!(stopped["ciphertext"], "");
        call(
            &mut b,
            json!({"op":"receive","snapshot":stopped,"now":1000200}),
        );
        assert_eq!(
            call(&mut b, json!({"op":"status","now":1000200}))["pins"],
            json!([])
        );

        // Seed recovery restores MLS state, but leaves local sharing sessions out.
        let restored = CryptoCore::import_encrypted_state(
            &[7; 32],
            &a.export_encrypted_state(&[7; 32], &[]).unwrap(),
        )
        .unwrap();
        assert!(restored.0.locations.own.is_empty());
    }

    #[test]
    fn battery_consent_is_enforced_and_withdrawal_replaces_snapshot() {
        let (mut a, mut b, circle) = pair();
        start(&mut a, &mut b, &circle);
        let fix = json!({"latitude":52.23,"longitude":21.01,"accuracy":10,"observedAt":1000000,"batteryPercent":63});
        call(
            &mut a,
            json!({"op":"publish","circleId":circle,"fix":fix,"now":1000000}),
        );
        let status = call(&mut a, json!({"op":"status","now":1000000}));
        assert_eq!(status["shares"][0]["reportBattery"], false);
        call(
            &mut b,
            json!({"op":"receive","snapshot":status["pending"][0],"now":1000000}),
        );
        assert!(
            call(&mut b, json!({"op":"status","now":1000000}))["pins"][0]["fix"]
                .get("batteryPercent")
                .is_none()
        );
        call(
            &mut a,
            json!({"op":"setBattery","circleId":circle,"enabled":true,"now":1000000}),
        );
        call(
            &mut a,
            json!({"op":"publish","circleId":circle,"fix":fix,"now":1000000}),
        );
        let enabled = call(&mut a, json!({"op":"status","now":1000000}));
        call(
            &mut b,
            json!({"op":"receive","snapshot":enabled["pending"][0],"now":1000000}),
        );
        assert_eq!(
            call(&mut b, json!({"op":"status","now":1000000}))["pins"][0]["fix"]["batteryPercent"],
            63
        );
        let mut invalid = fix.clone();
        invalid["batteryPercent"] = json!(101);
        assert!(a
            .location_command(
                &json!({"op":"publish","circleId":circle,"fix":invalid,"now":1000000}).to_string()
            )
            .is_err());
        call(
            &mut a,
            json!({"op":"setBattery","circleId":circle,"enabled":false,"now":1000100}),
        );
        let withdrawn = call(&mut a, json!({"op":"status","now":1000100}));
        assert_eq!(withdrawn["pending"].as_array().unwrap().len(), 1);
        call(
            &mut b,
            json!({"op":"receive","snapshot":withdrawn["pending"][0],"now":1000100}),
        );
        let received = call(&mut b, json!({"op":"status","now":1000100}));
        assert!(received["pins"][0]["fix"].get("batteryPercent").is_none());
        assert_eq!(received["pins"][0]["fix"]["observedAt"], 1000000);
        assert_eq!(received["pins"][0]["fix"]["updatedAt"], 1000100);
        assert_eq!(received["pins"][0]["fix"]["updateInterval"], 120000);
        assert!(b
            .location_command(
                &json!({"op":"receive","snapshot":enabled["pending"][0],"now":1000100}).to_string()
            )
            .is_err());
    }

    #[test]
    fn receiver_erases_expired_position_without_relay_access() {
        let (mut a, mut b, circle) = pair();
        call(
            &mut a,
            json!({"op":"start","circleId":circle,"mailboxId":"11".repeat(16),"generation":"22".repeat(16),"interval":60000,"expiresAt":1060000,"now":1000000}),
        );
        let control = call(&mut a, json!({"op":"status","now":1000000}))["controls"][0].clone();
        call(
            &mut b,
            json!({"op":"control","circleId":circle,"envelope":control["envelope"],"now":1000000}),
        );
        call(
            &mut a,
            json!({"op":"publish","circleId":circle,"fix":{"latitude":1,"longitude":2,"accuracy":5,"observedAt":1000000},"now":1000000}),
        );
        let wire = call(&mut a, json!({"op":"status","now":1000000}))["pending"][0].clone();
        call(
            &mut b,
            json!({"op":"receive","snapshot":wire,"now":1000000}),
        );
        assert!(!b.locations.received.is_empty());
        call(&mut b, json!({"op":"status","now":1060001}));
        assert!(b.locations.received.is_empty());
    }

    #[test]
    fn timed_consent_isolated_circles_and_durable_offline_stop() {
        let (mut a, mut b, circle) = pair();
        start(&mut a, &mut b, &circle);
        let other = a.create_circle().unwrap().circle_id;
        call(
            &mut a,
            json!({"op":"start","circleId":other,"mailboxId":"33".repeat(16),"generation":"22".repeat(16),"interval":60000,"expiresAt":1060000,"now":1000000}),
        );
        let state = call(&mut a, json!({"op":"status","now":1060001}));
        assert!(state["shares"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["circleId"] == circle && s["active"] == true));
        assert!(state["shares"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["circleId"] == other && s["active"] == false));
        call(&mut a, json!({"op":"stopAll","now":1060001}));
        let vault = call(&mut a, json!({"op":"export"}));
        let (mut resumed, _) = CryptoCore::import_encrypted_state(
            &[7; 32],
            &a.export_encrypted_state(&[7; 32], &[]).unwrap(),
        )
        .unwrap();
        call(&mut resumed, json!({"op":"import","vault":vault}));
        let after = call(&mut resumed, json!({"op":"status","now":1060002}));
        assert!(after["shares"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["active"] == false));
        assert_eq!(after["pins"], json!([]));
        assert_eq!(after["pending"].as_array().unwrap().len(), 2);
        assert!(after["pending"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["stopped"] == true && s["ciphertext"] == ""));
        assert!(resumed.location_command(&json!({"op":"publish","circleId":circle,"fix":{"latitude":1,"longitude":1,"accuracy":1,"observedAt":1060002},"now":1060002}).to_string()).is_err());
    }

    #[test]
    fn membership_change_invalidates_old_snapshots_and_rotates_owner() {
        let (mut a, mut b, circle) = pair();
        let wire = start(&mut a, &mut b, &circle);
        let mut c = CryptoCore::new().unwrap();
        let kp = c.create_key_package().unwrap();
        let commit = a.add_member(&circle, &kp).unwrap();
        b.process_commit(&circle, &commit.commit_bytes).unwrap();
        assert!(b
            .location_command(&json!({"op":"receive","snapshot":wire,"now":1000000}).to_string())
            .is_err());
        call(
            &mut a,
            json!({"op":"reconcile","generation":"22".repeat(16),"now":1000100}),
        );
        let state = call(&mut a, json!({"op":"status","now":1000100}));
        assert_ne!(state["shares"][0]["sessionId"], wire["sessionId"]);
        assert_eq!(state["pending"][0]["stopped"], true);
    }
}
