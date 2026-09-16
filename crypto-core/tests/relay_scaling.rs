//! Run only against an isolated relay: FC_STRESS_RELAY=http://127.0.0.1:5095
//! cargo test -p crypto-core --test relay_scaling -- --ignored --nocapture
use base64::{engine::general_purpose::STANDARD, Engine};
use crypto_core::{CryptoCore, EncryptedEnvelope};
use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};

fn upload(client: &Client, path: &str, body: &Value) -> Value {
    client
        .post(path)
        .json(body)
        .send()
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .unwrap()
}
fn control(bytes: &[u8], id: &str) -> Value {
    json!({"eventId":id,"epoch":0,"kind":"commit","nonce":"AQ==","ciphertext":STANDARD.encode(bytes)})
}
fn application(e: &EncryptedEnvelope, cursor: u64) -> Value {
    json!({"eventId":e.event_id,"epoch":e.epoch,"kind":"application","nonce":STANDARD.encode(&e.nonce),"ciphertext":STANDARD.encode(&e.ciphertext),"expectedSequenceId":cursor,"admission":"membership-v1"})
}
fn decode(wire: &Value) -> EncryptedEnvelope {
    EncryptedEnvelope {
        event_id: wire["eventId"].as_str().unwrap().into(),
        epoch: wire["epoch"].as_u64().unwrap(),
        nonce: STANDARD.decode(wire["nonce"].as_str().unwrap()).unwrap(),
        ciphertext: STANDARD
            .decode(wire["ciphertext"].as_str().unwrap())
            .unwrap(),
    }
}

#[test]
#[ignore = "requires a dedicated HTTP relay; creates isolated test mailboxes"]
fn real_encryption_over_http_at_10_20_50_members() {
    let base = std::env::var("FC_STRESS_RELAY").expect("set FC_STRESS_RELAY to an isolated relay");
    let mut headers = reqwest::header::HeaderMap::new();
    if let Ok(token) = std::env::var("FC_STRESS_TOKEN") {
        headers.insert("X-Installation-Token", token.parse().unwrap());
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .default_headers(headers)
        .build()
        .unwrap();
    for count in [10, 20, 50] {
        let mailbox: Value = client
            .post(format!("{base}/v1/devices"))
            .send()
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .unwrap();
        let path = format!(
            "{base}/v1/mailboxes/{}/events",
            mailbox["mailboxId"].as_str().unwrap()
        );
        let mut members = vec![CryptoCore::new().unwrap()];
        let circle = members[0].create_circle().unwrap().circle_id;
        let mut cursor = 0;
        for index in 1..count {
            let mut joining = CryptoCore::new().unwrap();
            let change = members[0]
                .prepare_membership_change(&circle, &joining.create_key_package().unwrap(), &[])
                .unwrap();
            let stored = upload(
                &client,
                &path,
                &control(&change.commit_bytes, &format!("join-{index}")),
            );
            cursor = stored["sequenceId"].as_u64().unwrap();
            let bytes = STANDARD
                .decode(stored["ciphertext"].as_str().unwrap())
                .unwrap();
            for member in &mut members {
                member.process_commit(&circle, &bytes).unwrap();
            }
            joining
                .join_from_welcome(&change.welcome_bytes.unwrap())
                .unwrap();
            members.push(joining);
        }
        let mut delivered = 0;
        let mut times = vec![];
        for round in 0..4 {
            let outgoing: Vec<_> = members
                .iter_mut()
                .enumerate()
                .map(|(i, m)| {
                    m.encrypt_event(&circle, format!("{round}:{i}").as_bytes())
                        .unwrap()
                })
                .collect();
            let start = Instant::now();
            let accepted: Vec<Value> = std::thread::scope(|scope| {
                let tasks: Vec<_> = outgoing
                    .iter()
                    .map(|e| {
                        let body = application(e, cursor);
                        let client = &client;
                        let path = &path;
                        scope.spawn(move || upload(client, path, &body))
                    })
                    .collect();
                tasks.into_iter().map(|t| t.join().unwrap()).collect()
            });
            assert_eq!(
                accepted
                    .iter()
                    .map(|v| v["sequenceId"].as_u64().unwrap())
                    .collect::<HashSet<_>>()
                    .len(),
                count
            );
            // A lost acknowledgement retries the original bytes after other appends.
            assert_eq!(
                upload(&client, &path, &application(&outgoing[0], cursor))["sequenceId"],
                accepted[0]["sequenceId"]
            );
            for (receiver, member) in members.iter_mut().enumerate() {
                let page: Vec<Value> = client
                    .get(format!("{path}?after={cursor}&limit=100"))
                    .send()
                    .unwrap()
                    .error_for_status()
                    .unwrap()
                    .json()
                    .unwrap();
                assert_eq!(page.len(), count);
                for wire in &page {
                    let e = decode(wire);
                    let sender = outgoing
                        .iter()
                        .position(|sent| sent.event_id == e.event_id)
                        .unwrap();
                    if sender == receiver {
                        continue;
                    }
                    assert_eq!(
                        member.decrypt_event(&circle, &e).unwrap().plaintext,
                        format!("{round}:{sender}").as_bytes()
                    );
                    delivered += 1;
                }
                let snapshot = member
                    .export_encrypted_state(&[42; 32], &cursor.to_le_bytes())
                    .unwrap();
                *member = CryptoCore::import_encrypted_state(&[42; 32], &snapshot)
                    .unwrap()
                    .0;
            }
            times.push(start.elapsed().as_millis());
            cursor = accepted
                .iter()
                .map(|v| v["sequenceId"].as_u64().unwrap())
                .max()
                .unwrap();
        }
        // One member misses the update, restores, then obtains the actual relay chain.
        let before = cursor;
        let change = members[0]
            .prepare_membership_change(&circle, &[], &[])
            .unwrap();
        upload(
            &client,
            &path,
            &control(&change.commit_bytes, "offline-update"),
        );
        for member in members.iter_mut().take(count - 1) {
            member
                .process_commit(&circle, &change.commit_bytes)
                .unwrap();
        }
        let stale = members
            .last_mut()
            .unwrap()
            .encrypt_event(&circle, b"stale")
            .unwrap();
        assert_eq!(
            client
                .post(&path)
                .json(&application(&stale, before))
                .send()
                .unwrap()
                .status()
                .as_u16(),
            409
        );
        let page: Vec<Value> = client
            .get(format!("{path}?after={before}"))
            .send()
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .unwrap();
        for wire in page {
            members
                .last_mut()
                .unwrap()
                .process_commit(
                    &circle,
                    &STANDARD
                        .decode(wire["ciphertext"].as_str().unwrap())
                        .unwrap(),
                )
                .unwrap();
        }
        let returning = members
            .last_mut()
            .unwrap()
            .encrypt_event(&circle, b"recovered")
            .unwrap();
        for member in members.iter_mut().take(count - 1) {
            assert_eq!(
                member.decrypt_event(&circle, &returning).unwrap().plaintext,
                b"recovered"
            );
        }
        // Four rounds, every member sending to every other one.
        assert_eq!(delivered, 4 * count * (count - 1));
        println!("members={count} deliveries={delivered} round_ms={times:?}");
    }
}
