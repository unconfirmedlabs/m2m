import type { DemoEconomy, UiEconomyCard } from './types.js';

const DECIMAL = /^(0|[1-9][0-9]*)$/;

function amount(value: string): bigint {
  if (!DECIMAL.test(value)) throw new Error('invalid_decimal');
  return BigInt(value);
}

function nonNegativeDifference(a: string, b: string): string {
  const difference = amount(a) - amount(b);
  return (difference < 0n ? 0n : difference).toString();
}

/** The browser's exact policy calculation; values never pass through Number. */
export function policyPrice(policy: { rates: string[]; denominator: string }, units: readonly string[]): string {
  if (policy.rates.length !== units.length) throw new Error('policy_dimensions');
  const denominator = amount(policy.denominator);
  if (denominator === 0n) throw new Error('policy_denominator');
  let total = 0n;
  for (let index = 0; index < units.length; index += 1) total += amount(units[index]) * amount(policy.rates[index]);
  return ((total / denominator) + (total % denominator === 0n ? 0n : 1n)).toString();
}

export function confirmedRefund(economy: DemoEconomy): string | null {
  if (!economy.terminal || economy.terminal.state !== 'confirmed' || (economy.status !== 'closed' && economy.status !== 'refunded') || economy.locked_mist !== '0' || economy.redeemed_mist === null || economy.observed_at_ms === null || economy.terminal.digest === null) return null;
  const refund = amount(economy.offer.payload.deposit) - amount(economy.redeemed_mist);
  return refund < 0n ? null : refund.toString();
}

export function deriveEconomy(economy: DemoEconomy): UiEconomyCard {
  const deliveredPrice = policyPrice(economy.policy, economy.delivered_units);
  // A terminal label is not proof that active funds are gone.  Keep exposure
  // visible until the confirmed receipt also proves the known empty balance.
  const settled = economy.terminal?.state === 'confirmed' && (economy.status === 'closed' || economy.status === 'refunded') && economy.locked_mist === '0' && economy.redeemed_mist !== null && economy.observed_at_ms !== null && economy.terminal.digest !== null && amount(economy.redeemed_mist) <= amount(economy.offer.payload.deposit);
  const openingTransaction = economy.opening;
  const terminalTransaction = economy.terminal;
  return {
    economy,
    deliveredPrice,
    signedAuthorization: economy.signed_authorized_mist,
    // Signed/reserved maxima remain historical evidence after settlement, but
    // a confirmed closed/refunded channel has no active exposure left.
    outstanding: settled ? '0' : nonNegativeDifference(economy.signed_authorized_mist, deliveredPrice),
    reservedExposure: settled ? '0' : nonNegativeDifference(economy.reserved_mist, deliveredPrice),
    refund: confirmedRefund(economy),
    redeemedAboveDelivery: economy.redeemed_mist === null ? null : amount(economy.redeemed_mist) > amount(deliveredPrice),
    priceMismatch: economy.delivered_mist !== deliveredPrice,
    transaction: openingTransaction,
    openingTransaction,
    terminalTransaction,
  };
}

export function formatMist(value: string | null | undefined): string {
  return value === null || value === undefined ? 'unknown' : `${value} MIST`;
}

export function formatSui(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'unknown';
  const n = amount(value);
  const whole = n / 1_000_000_000n;
  const fractional = (n % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return fractional ? `${whole}.${fractional} SUI` : `${whole} SUI`;
}
