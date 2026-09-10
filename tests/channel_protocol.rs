use anyhow::Result;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use iroh::SecretKey;
use m2m::{channel_protocol as channel, protocol};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn vectors() -> Value {
    serde_json::from_str(include_str!("../fixtures/channel-signing-vectors.json")).unwrap()
}

fn statement<T: DeserializeOwned>(name: &str) -> T {
    serde_json::from_value(vectors()["statements"][name]["payload"].clone()).unwrap()
}

fn statement_bytes(name: &str) -> Vec<u8> {
    hex::decode(vectors()["statements"][name]["bcs_hex"].as_str().unwrap()).unwrap()
}

fn statement_hash(name: &str) -> Vec<u8> {
    hex::decode(vectors()["statements"][name]["hash_hex"].as_str().unwrap()).unwrap()
}

#[test]
fn generated_vectors_are_the_checked_in_golden_fixture() -> Result<()> {
    let expected: Value = vectors();
    assert_eq!(channel::signing_vectors()?, expected);
    Ok(())
}

#[test]
fn every_golden_statement_has_expected_bcs_and_hash() -> Result<()> {
    let names = [
        "terms",
        "request",
        "offer",
        "credit",
        "ack",
        "result",
        "close",
        "transcript_start",
        "transcript_step",
    ];
    for name in names {
        let bytes = statement_bytes(name);
        assert_eq!(protocol::hash(&bytes), statement_hash(name), "{name}");
        match name {
            "terms" => assert_eq!(
                bcs::to_bytes(&statement::<channel::FixtureTerms>(name))?,
                bytes
            ),
            "request" => assert_eq!(
                bcs::to_bytes(&statement::<channel::RequestDescriptor>(name))?,
                bytes
            ),
            "offer" => assert_eq!(bcs::to_bytes(&statement::<channel::Offer>(name))?, bytes),
            "credit" => assert_eq!(bcs::to_bytes(&statement::<channel::Credit>(name))?, bytes),
            "ack" => assert_eq!(bcs::to_bytes(&statement::<channel::Ack>(name))?, bytes),
            "result" => assert_eq!(
                bcs::to_bytes(&statement::<channel::ResultStatement>(name))?,
                bytes
            ),
            "close" => assert_eq!(bcs::to_bytes(&statement::<channel::Close>(name))?, bytes),
            "transcript_start" => {
                assert_eq!(
                    bcs::to_bytes(&statement::<channel::TranscriptStart>(name))?,
                    bytes
                )
            }
            "transcript_step" => {
                assert_eq!(
                    bcs::to_bytes(&statement::<channel::TranscriptStep>(name))?,
                    bytes
                )
            }
            _ => unreachable!(),
        }
    }
    Ok(())
}

#[test]
fn golden_signatures_verify_over_exact_bcs_payloads() -> Result<()> {
    let values = vectors();
    let buyer_public = hex::decode(values["keys"]["buyer_public_key"].as_str().unwrap())?;
    let provider_public = hex::decode(values["keys"]["provider_public_key"].as_str().unwrap())?;
    let buyer = VerifyingKey::from_bytes(buyer_public.as_slice().try_into()?)?;
    let provider = VerifyingKey::from_bytes(provider_public.as_slice().try_into()?)?;

    for (name, key, verifier) in [
        ("offer", "signature_hex", &provider),
        ("ack", "signature_hex", &provider),
        ("result", "signature_hex", &provider),
        ("credit", "signature_hex", &buyer),
    ] {
        let signature = Signature::from_slice(&hex::decode(
            values["statements"][name][key].as_str().unwrap(),
        )?)?;
        verifier.verify(&statement_bytes(name), &signature)?;
    }

    for (key, verifier) in [
        ("buyer_signature_hex", &buyer),
        ("provider_signature_hex", &provider),
    ] {
        let signature = Signature::from_slice(&hex::decode(
            values["statements"]["close"][key].as_str().unwrap(),
        )?)?;
        verifier.verify(&statement_bytes("close"), &signature)?;
    }
    Ok(())
}

#[test]
fn transcript_helpers_reproduce_both_roots() -> Result<()> {
    let offer = statement::<channel::Offer>("offer");
    let request = statement::<channel::RequestDescriptor>("request");
    let credit = statement::<channel::Credit>("credit");
    let ack = statement::<channel::Ack>("ack");
    let result = statement::<channel::ResultStatement>("result");
    let start = statement::<channel::TranscriptStart>("transcript_start");
    assert_eq!(channel::offer_hash(&offer)?, statement_hash("offer"));
    assert_eq!(
        channel::transcript_start(start.channel, &offer)?,
        statement_hash("transcript_start")
    );
    assert_eq!(
        channel::transcript_next(&start_hash(), &request, &credit, &ack, &result,)?,
        vectors()["hashes"]["transcript_final"]
            .as_str()
            .map(hex::decode)
            .unwrap()?
    );
    Ok(())
}

fn start_hash() -> Vec<u8> {
    statement_hash("transcript_start")
}

#[test]
fn mutation_and_domain_changes_are_rejected() -> Result<()> {
    let mut offer = statement::<channel::Offer>("offer");
    offer.purpose[0] ^= 1;
    assert!(offer.validate().is_err());

    let mut credit = statement::<channel::Credit>("credit");
    credit.method = b"other.method".to_vec();
    assert!(credit.validate().is_err());

    let mut request = statement::<channel::RequestDescriptor>("request");
    request.request_id = b"job with spaces".to_vec();
    assert!(request.validate().is_err());

    let mut close = statement::<channel::Close>("close");
    close.transcript_hash.pop();
    assert!(close.validate().is_err());
    Ok(())
}

#[test]
fn json_is_strict_at_nested_boundaries_and_u64_is_decimal() -> Result<()> {
    let offer_value = vectors()["statements"]["offer"]["payload"].clone();
    let mut offer_object = offer_value.as_object().unwrap().clone();
    offer_object.insert("extra".into(), json!(true));
    assert!(serde_json::from_value::<channel::Offer>(Value::Object(offer_object)).is_err());

    let mut request_object = vectors()["statements"]["request"]["payload"]
        .as_object()
        .unwrap()
        .clone();
    request_object.insert("request_sequence".into(), json!(1));
    assert!(
        serde_json::from_value::<channel::RequestDescriptor>(Value::Object(request_object))
            .is_err()
    );

    let mut envelope = json!({
        "version": 1,
        "method": channel::METHOD,
        "buyer": "0x0505050505050505050505050505050505050505050505050505050505050505",
        "provider": "0x0606060606060606060606060606060606060606060606060606060606060606",
        "agreement_id": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "request_id": "",
        "message": {
            "type": "payment.offer_request",
            "opening_nonce": [9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9],
            "result_hash": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
            "jobs": "10",
            "max_unit_price": "1000",
            "deposit": "12000"
        }
    });
    assert!(
        serde_json::from_value::<channel::Envelope>(envelope.clone())?
            .validate()
            .is_ok()
    );
    envelope["message"]["extra"] = json!(true);
    assert!(serde_json::from_value::<channel::Envelope>(envelope).is_err());
    Ok(())
}

#[test]
fn shortened_addresses_are_not_accepted_on_wire() {
    let mut value = vectors()["statements"]["offer"]["payload"].clone();
    value["buyer"] = json!("0x5");
    assert!(serde_json::from_value::<channel::Offer>(value).is_err());
}

#[test]
fn ticket_rejects_unknown_endpoint_and_transport_fields() -> Result<()> {
    let endpoint_id = vectors()["keys"]["provider_public_key"]
        .as_str()
        .unwrap()
        .to_owned();
    let base = json!({
        "version": 1,
        "method": channel::METHOD,
        "agent": "0x0606060606060606060606060606060606060606060606060606060606060606",
        "endpoint": { "id": endpoint_id, "addrs": [] }
    });
    let ticket: channel::Ticket = serde_json::from_value(base.clone())?;
    ticket.validate()?;

    let mut endpoint_extra = base.clone();
    endpoint_extra["endpoint"]["unexpected"] = json!(true);
    assert!(serde_json::from_value::<channel::Ticket>(endpoint_extra).is_err());

    let mut transport_extra = base;
    transport_extra["endpoint"]["addrs"] = json!([{"Ip": "127.0.0.1:9", "unexpected": true}]);
    assert!(serde_json::from_value::<channel::Ticket>(transport_extra).is_err());
    Ok(())
}

#[test]
fn application_signing_uses_raw_bcs_without_a_sui_intent() -> Result<()> {
    let offer = statement::<channel::Offer>("offer");
    let signature = protocol::sign(&offer, &SecretKey::from_bytes(&[2; 32]))?;
    protocol::verify(
        &offer,
        &signature,
        &hex::decode(vectors()["keys"]["provider_public_key"].as_str().unwrap())?,
    )?;
    assert_eq!(signature.len(), 64);
    Ok(())
}
