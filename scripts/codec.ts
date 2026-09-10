import { bcs } from '@mysten/sui/bcs';
import { blake2b } from '@noble/hashes/blake2.js';

const bytes = () => bcs.vector(bcs.u8());
// Keep BCS u64 exact in JavaScript. JSON uses decimal strings on the wire.
export const Quote = bcs.struct('Quote', {
  purpose: bytes(), network: bytes(), package_id: bcs.Address, deployment: bcs.Address,
  buyer: bcs.Address, provider: bcs.Address, buyer_key: bytes(), provider_key: bytes(),
  refund: bcs.Address, payee: bcs.Address, nonce: bcs.u64(),
  request_hash: bytes(), result_hash: bytes(), amount: bcs.u64(),
  quote_expires_ms: bcs.u64(), deadline_ms: bcs.u64(),
});
export const Acceptance = bcs.struct('Acceptance', {
  purpose: bytes(), network: bytes(), package_id: bcs.Address, deployment: bcs.Address,
  escrow: bcs.Address, quote_hash: bytes(), result_hash: bytes(),
});
export const Domain = bcs.struct('Domain', {
  id: bcs.Address, network: bytes(), package_id: bcs.Address,
});
export const Agent = bcs.struct('Agent', {
  id: bcs.Address, deployment: bcs.Address, controller: bcs.Address,
  endpoint_key: bytes(), next_nonce: bcs.u64(),
  jobs: bcs.struct('Table', { id: bcs.Address, size: bcs.u64() }),
});
export const Escrow = bcs.struct('Escrow', {
  id: bcs.Address, quote: Quote, funds: bcs.u64(), status: bcs.u8(), terminal_tx: bytes(),
});
export const Clock = bcs.struct('Clock', { id: bcs.Address, timestamp_ms: bcs.u64() });
export type QuoteData = typeof Quote.$inferType;
export type AcceptanceData = typeof Acceptance.$inferType;
export const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s));
export const hash = (bytes: Uint8Array): Uint8Array => blake2b(bytes, { dkLen: 32 });
export function acceptance(escrow: string, quote: QuoteData): AcceptanceData {
  return {
    purpose: utf8('m2m/accept/v1'), network: [...quote.network],
    package_id: quote.package_id, deployment: quote.deployment, escrow,
    quote_hash: Array.from(hash(Quote.serialize(quote).toBytes())),
    result_hash: [...quote.result_hash],
  };
}
