//! Offline wire examples must be readable by the implementation and form a
//! cryptographically consistent exchange. This does not establish chain state.
use anyhow::{Context, Result, ensure};
use m2m::{channel_protocol as cp, protocol as escrow};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::{fs, path::PathBuf};

fn read<T: DeserializeOwned>(file: &str) -> Result<T> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("examples/messages")
        .join(file);
    serde_json::from_slice(&fs::read(path)?).with_context(|| file.to_owned())
}

fn channel(name: &str) -> Result<cp::Envelope> {
    read(&format!("channel/{name}.json"))
}

fn verify<T: Serialize>(statement: &cp::Signed<T>, key: &[u8]) -> Result<()> {
    escrow::verify(&statement.payload, &statement.signature, key)
}

fn certificate(cert: &cp::CloseCertificate, offer: &cp::Offer) -> Result<()> {
    escrow::verify(&cert.close, &cert.buyer_signature, &offer.buyer_key)?;
    escrow::verify(&cert.close, &cert.provider_signature, &offer.provider_key)
}

#[test]
fn every_channel_example_parses_and_all_embedded_signatures_verify() -> Result<()> {
    let cp::Message::Offer { offer, .. } = channel("payment.offer")?.message else {
        anyhow::bail!("expected offer")
    };
    let cp::Message::Close { close } = channel("payment.close")?.message else {
        anyhow::bail!("expected close")
    };
    let manifest: Value = read("index.json")?;
    for item in manifest["examples"].as_array().unwrap() {
        if item["profile"] != "channel" {
            continue;
        }
        let file = item["file"].as_str().unwrap();
        let envelope: cp::Envelope = read(file)?;
        envelope.validate().with_context(|| file.to_owned())?;
        assert_eq!(envelope.buyer, offer.buyer, "{file}");
        assert_eq!(envelope.provider, offer.provider, "{file}");
        let unfunded = matches!(
            envelope.message,
            cp::Message::OfferRequest { .. } | cp::Message::Offer { .. }
        );
        assert_eq!(
            envelope.agreement_id,
            if unfunded {
                escrow::Address::ZERO
            } else {
                close.channel
            },
            "{file}"
        );
        let check = match &envelope.message {
            cp::Message::Offer { offer, .. } => verify(offer, &offer.provider_key),
            cp::Message::Authorize { request, credit } => {
                assert_eq!(request.request_id, envelope.request_id.as_bytes());
                assert_eq!(request.channel, envelope.agreement_id);
                verify(credit, &offer.buyer_key)
            }
            cp::Message::Acknowledge { ack } => verify(ack, &offer.provider_key),
            cp::Message::Result { result, bytes } => {
                assert_eq!(escrow::hash(bytes), result.result_hash, "{file}");
                verify(result, &offer.provider_key)
            }
            cp::Message::Close { close } => verify(close, &offer.buyer_key),
            cp::Message::CloseAcknowledge { certificate: cert } => certificate(cert, &offer),
            cp::Message::Ready {
                highest_credit,
                certificate: cert,
                ..
            } => {
                if let Some(credit) = highest_credit {
                    verify(credit, &offer.buyer_key)?;
                }
                if let Some(cert) = cert {
                    certificate(cert, &offer)?;
                }
                Ok(())
            }
            cp::Message::OfferRequest { .. }
            | cp::Message::Resume { .. }
            | cp::Message::Get { .. }
            | cp::Message::Settlement { .. }
            | cp::Message::Error { .. } => Ok(()),
        };
        check.with_context(|| file.to_owned())?;
        assert_eq!(
            item["runtime_status"],
            if matches!(envelope.message, cp::Message::Settlement { .. }) {
                "specified_only"
            } else {
                "implemented"
            },
            "{file}"
        );
    }
    Ok(())
}

#[test]
fn channel_examples_bind_one_job_from_offer_through_recovery_and_close() -> Result<()> {
    let cp::Message::Offer { offer, terms } = channel("payment.offer")?.message else {
        anyhow::bail!("expected offer")
    };
    let cp::Message::OfferRequest {
        opening_nonce,
        result_hash,
        jobs,
        max_unit_price,
        deposit,
    } = channel("payment.offer_request")?.message
    else {
        anyhow::bail!("expected offer request")
    };
    assert_eq!(opening_nonce, offer.opening_nonce);
    assert_eq!(result_hash, terms.result_hash);
    assert_eq!(jobs, terms.max_jobs);
    assert!(terms.unit_price <= max_unit_price);
    assert_eq!(deposit, offer.deposit);
    assert_eq!(offer.terms_hash, cp::terms_hash(&terms)?);

    let cp::Message::Authorize { request, credit } = channel("payment.authorize")?.message else {
        anyhow::bail!("expected authorization")
    };
    let cp::Message::Acknowledge { ack } = channel("payment.acknowledge")?.message else {
        anyhow::bail!("expected acknowledgement")
    };
    let cp::Message::Get { request_hash } = channel("work.get")?.message else {
        anyhow::bail!("expected work retrieval")
    };
    let cp::Message::Result { result, bytes } = channel("work.result")?.message else {
        anyhow::bail!("expected work result")
    };
    let cp::Message::Close { close } = channel("payment.close")?.message else {
        anyhow::bail!("expected close")
    };
    let cp::Message::CloseAcknowledge { certificate: cert } =
        channel("payment.close_acknowledge")?.message
    else {
        anyhow::bail!("expected close certificate")
    };
    assert_eq!(cert.close, close.payload);
    assert_eq!(cert.buyer_signature, close.signature);

    // All signed statements share an economic domain, parties, offer and channel.
    let offer_json = serde_json::to_value(&offer.payload)?;
    for statement in [
        serde_json::to_value(&credit.payload)?,
        serde_json::to_value(&ack.payload)?,
        serde_json::to_value(&result.payload)?,
        serde_json::to_value(&close.payload)?,
    ] {
        for field in [
            "method",
            "version",
            "network",
            "package_id",
            "deployment",
            "buyer",
            "provider",
        ] {
            assert_eq!(statement[field], offer_json[field], "{field}");
        }
        assert_eq!(statement["channel"], serde_json::to_value(request.channel)?);
        assert_eq!(
            statement["offer_hash"],
            serde_json::to_value(cp::offer_hash(&offer)?)?
        );
    }
    for message in [
        "payment.authorize",
        "payment.acknowledge",
        "work.get",
        "work.result",
    ] {
        assert_eq!(channel(message)?.request_id.as_bytes(), request.request_id);
    }
    assert_eq!(request.terms_hash, offer.terms_hash);
    assert_eq!(request_hash, cp::request_hash(&request)?);
    assert_eq!(credit.request_hash, request_hash);
    assert_eq!(result.request_hash, request_hash);
    assert_eq!(ack.credit_hash, cp::credit_hash(&credit)?);
    assert_eq!(result.credit_hash, ack.credit_hash);
    assert_eq!(bytes, include_bytes!("../fixtures/hello.txt"));
    assert_eq!(result.result_hash, terms.result_hash);
    assert_eq!(request.request_sequence, 1);
    assert_eq!(credit.sequence, request.request_sequence);
    assert_eq!(ack.sequence, credit.sequence);
    assert_eq!(close.final_sequence, credit.sequence);
    assert_eq!(credit.cumulative_amount, terms.unit_price);
    assert_eq!(ack.cumulative_amount, credit.cumulative_amount);
    assert_eq!(close.final_amount, credit.cumulative_amount);
    assert_eq!(offer.deposit - close.final_amount, 11_000);

    let start = cp::transcript_start(request.channel, &offer)?;
    assert_eq!(credit.previous_transcript_hash, start);
    let end = cp::transcript_next(&start, &request, &credit, &ack, &result)?;
    assert_eq!(close.transcript_hash, end);
    for (name, expected_phase, completed, redeemed, has_cert) in [
        ("session.ready", "active", 0, 0, false),
        ("session.ready.resumed", "active", 1, 0, false),
        ("session.ready.frozen", "frozen", 1, 0, true),
        ("session.ready.closed", "closed", 1, 1000, true),
        ("session.ready.refunded", "refunded", 1, 1000, false),
    ] {
        let cp::Message::Ready {
            phase,
            highest_credit,
            completed_jobs,
            transcript_hash,
            certificate,
            redeemed_amount,
        } = channel(name)?.message
        else {
            anyhow::bail!("expected ready")
        };
        assert_eq!(phase, expected_phase, "{name}");
        assert_eq!(completed_jobs, completed, "{name}");
        assert_eq!(redeemed_amount, redeemed, "{name}");
        assert_eq!(certificate, has_cert.then(|| cert.clone()), "{name}");
        assert_eq!(
            highest_credit,
            (completed > 0).then(|| credit.clone()),
            "{name}"
        );
        assert_eq!(
            transcript_hash,
            if completed == 0 { &start } else { &end }.clone(),
            "{name}"
        );
    }
    Ok(())
}

#[test]
fn escrow_examples_bind_quote_delivery_and_signed_acceptance() -> Result<()> {
    let escrow::Response::Quote { signed } = read("escrow/response.quote.json")? else {
        anyhow::bail!("expected quote")
    };
    let quote = &signed.quote;
    quote.validate()?;
    escrow::verify(quote, &signed.signature, &quote.provider_key)?;
    let escrow::Request::Accept { receipt, .. } = read("escrow/request.accept.json")? else {
        anyhow::bail!("expected acceptance")
    };
    let acceptance = &receipt.acceptance;
    assert_eq!(*acceptance, quote.acceptance(acceptance.escrow)?);
    escrow::verify(acceptance, &receipt.signature, &quote.buyer_key)?;

    let manifest: Value = read("index.json")?;
    for item in manifest["examples"].as_array().unwrap() {
        if item["profile"] != "escrow" {
            continue;
        }
        let file = item["file"].as_str().unwrap();
        if item["direction"] == "buyer_to_provider" {
            let request: escrow::Request = read(file)?;
            request.validate()?;
            match request {
                escrow::Request::Quote {
                    buyer,
                    nonce,
                    result_hash,
                    ..
                } => {
                    assert_eq!(buyer, quote.buyer);
                    assert_eq!(nonce, quote.nonce);
                    assert_eq!(result_hash, quote.result_hash);
                }
                escrow::Request::Deliver { escrow, .. } => assert_eq!(escrow, acceptance.escrow),
                escrow::Request::Accept { .. } => {}
            }
        } else {
            match read::<escrow::Response>(file)? {
                escrow::Response::Result { escrow, bytes } => {
                    assert_eq!(escrow, acceptance.escrow);
                    assert_eq!(bytes, include_bytes!("../fixtures/hello.txt"));
                    assert_eq!(escrow::hash(&bytes), quote.result_hash);
                }
                escrow::Response::Settled { escrow, digest } => {
                    assert_eq!(escrow, acceptance.escrow);
                    ensure!(!digest.is_empty(), "missing illustrative digest");
                }
                escrow::Response::Quote { .. } | escrow::Response::Error { .. } => {}
            }
        }
    }
    Ok(())
}
