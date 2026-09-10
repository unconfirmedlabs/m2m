#[test_only]
module m2m::channel_signing_tests;

use m2m::channel;

// Public deterministic vectors from fixtures/channel-signing-vectors.json.
// The corresponding seeds are [1;32] and [2;32]; they never fund accounts.
const BUYER_KEY: vector<u8> = x"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c";
const PROVIDER_KEY: vector<u8> = x"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394";
const PACKAGE: address = @0x0303030303030303030303030303030303030303030303030303030303030303;
const DEPLOYMENT: address = @0x0404040404040404040404040404040404040404040404040404040404040404;
const BUYER: address = @0x0505050505050505050505050505050505050505050505050505050505050505;
const PROVIDER: address = @0x0606060606060606060606060606060606060606060606060606060606060606;
const REFUND: address = @0x0707070707070707070707070707070707070707070707070707070707070707;
const PAYEE: address = @0x0808080808080808080808080808080808080808080808080808080808080808;
const CHANNEL: address = @0x0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a;
const NETWORK: vector<u8> = b"test-vector";
const NONCE: vector<u8> = x"0909090909090909090909090909090909090909090909090909090909090909";
const TERMS_HASH: vector<u8> = x"42fa5bc6754a4ae3bd28ef9b5a91e82738bcbd8c25bdd314efc9e376e11e6f78";
const OFFER_HASH: vector<u8> = x"4a6eaf62023281018d98b19f33b236d91cb4110631a6522e906ad4b0bca8b4f7";
const REQUEST_HASH: vector<u8> = x"8c162f19ff41f127afa9ba6b7fb0d871236fdde2ad417e70790b4a4ee162c331";
const CREDIT_HASH: vector<u8> = x"8ecef8b9e4136d75f854d9c9fd79c58a01d4a3a3cc7c095de3e20dad9b069633";
const TRANSCRIPT_START: vector<u8> = x"d0ac1a12dff646c5811a11e355c40f23b933e71137c1e3f9266f59ba40782483";
const TRANSCRIPT_FINAL: vector<u8> = x"d1502f4a1d23e7d16f4ec47495d978ea5a965fdf9406f08f4375169f0d22956b";

const OFFER_SIG: vector<u8> = x"81717d8b354733973211114c8b1e6f413b90320e167aacfd0e9b8b3879fa0902cd84dcd127ed4477b139883099f820e0258bf99bf52e43547629e354a6306c01";
const CREDIT_SIG: vector<u8> = x"65d88b91339b4b7a68efb0599d5a0cd434fd06598e80d2f7cc7dc52731ef07a97be084c50f38b86bc70d1ec2d462b82d53c691996d2163674af1d7b3a917ca03";
const CLOSE_BUYER_SIG: vector<u8> = x"8e8b1147753f065ab8646a32f63f21d984f13365ddf5a13e133532cccecbb360f2e7acbe19b79af7e14199994cd3497fbad9d556ef1f7b685e1bd8e2e908d504";
const CLOSE_PROVIDER_SIG: vector<u8> = x"84f98075c9506ff1670afeb57bebe3b121f04bff9df6dea74f68520ad99db73694e13f1d6a7fdbff4a7fcdefea68898f3f5a07a5365ba99a487aa1f52f9ee10b";

#[test]
fun reconstructed_offer_credit_and_close_match_golden_vectors() {
    let offer_hash = channel::verify_offer_vector_test(
        NETWORK, PACKAGE, DEPLOYMENT, BUYER, PROVIDER, BUYER_KEY, PROVIDER_KEY,
        REFUND, PAYEE, NONCE, TERMS_HASH, 12_000, 1_800_000_060_000,
        1_800_000_300_000, 1_800_000_360_000, OFFER_SIG,
    );
    assert!(offer_hash == OFFER_HASH);

    let credit_hash = channel::verify_credit_vector_test(
        NETWORK, PACKAGE, DEPLOYMENT, BUYER, PROVIDER, CHANNEL, OFFER_HASH,
        1, 1_000, REQUEST_HASH, TRANSCRIPT_START, BUYER_KEY, CREDIT_SIG,
    );
    assert!(credit_hash == CREDIT_HASH);

    let close_hash = channel::verify_close_vector_test(
        NETWORK, PACKAGE, DEPLOYMENT, BUYER, PROVIDER, CHANNEL, OFFER_HASH,
        1, 1_000, TRANSCRIPT_FINAL, BUYER_KEY, PROVIDER_KEY,
        CLOSE_BUYER_SIG, CLOSE_PROVIDER_SIG,
    );
    assert!(close_hash == x"189481496b8e99df4d7343528a26c2e9478e2985ef886ff3a15c3c40ffdf7b60");
}

#[test, expected_failure(abort_code = 3, location = m2m::channel)]
fun wrong_role_key_is_rejected_after_offer_reconstruction() {
    channel::verify_offer_vector_test(
        NETWORK, PACKAGE, DEPLOYMENT, BUYER, PROVIDER, BUYER_KEY, BUYER_KEY,
        REFUND, PAYEE, NONCE, TERMS_HASH, 12_000, 1_800_000_060_000,
        1_800_000_300_000, 1_800_000_360_000, OFFER_SIG,
    );
}

#[test, expected_failure(abort_code = 3, location = m2m::channel)]
fun tampered_signature_is_rejected_after_credit_reconstruction() {
    let mut signature = CREDIT_SIG;
    *vector::borrow_mut(&mut signature, 0) = 0;
    channel::verify_credit_vector_test(
        NETWORK, PACKAGE, DEPLOYMENT, BUYER, PROVIDER, CHANNEL, OFFER_HASH,
        1, 1_000, REQUEST_HASH, TRANSCRIPT_START, BUYER_KEY, signature,
    );
}
