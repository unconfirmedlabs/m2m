import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelChain } from './channel-chain.js';
import {
  fromHex,
  validateAck,
  validateClose,
  validateChannel,
  validateCredit,
  validateOffer,
} from './channel-codec.js';

const vectors = JSON.parse(await readFile('fixtures/channel-signing-vectors.json', 'utf8'));
const offer = structuredClone(vectors.statements.offer.payload);
const credit = structuredClone(vectors.statements.credit.payload);
const ack = structuredClone(vectors.statements.ack.payload);
const close = structuredClone(vectors.statements.close.payload);
const offerSignature = fromHex(vectors.statements.offer.signature_hex);
const channelId = '0x0a'.padEnd(66, '0');

validateOffer(offer); validateCredit(credit); validateAck(ack); validateClose(close);

function terminalRecord(terminalDigest: string) {
  return {
    view: {
      id: channelId,
      offer,
      funds: '0',
      redeemed_amount: offer.deposit,
      redeemed_sequence: '1',
      status: 1,
      terminal_tx: new Array(32).fill(1),
      close_hash: new Array(32).fill(2),
      terminal_digest: terminalDigest,
    },
    previous_transaction: terminalDigest,
  };
}

function journal(action: string, attempts: unknown[] = []): any {
  return { version: 1, action, state: 'unknown', attempts };
}

const fake = Object.create(ChannelChain.prototype) as any;
fake.config = { package_id: offer.package_id };
const root = await mkdtemp(join(tmpdir(), 'm2m-channel-recovery-'));
try {
  fake.client = { getTransaction: async () => { throw new Error('offline'); } };

  const externalPath = join(root, 'external.json');
  const externalJournal = journal('channel_close');
  await writeFile(externalPath, JSON.stringify(externalJournal));
  const external = await fake.recoverFromChannel(externalPath, externalJournal, terminalRecord('other-actor'));
  assert.equal(external.resolution, 'external');
  assert.equal(external.digest, null);
  const externalSaved = JSON.parse(await readFile(externalPath, 'utf8'));
  assert.equal(externalSaved.resolution, 'external');
  assert.equal(externalSaved.digest, null);

  const pendingPath = join(root, 'pending.json');
  const pendingJournal = journal('channel_close', [{
    digest: 'own-unknown', bytes: 'bytes', signature: 'signature', state: 'submitted_or_pending',
  }]);
  await writeFile(pendingPath, JSON.stringify(pendingJournal));
  const pending = await fake.recoverFromChannel(pendingPath, pendingJournal, terminalRecord('other-actor'));
  assert.equal(pending.resolution, 'external');
  assert.equal(pending.digest, null);
  const pendingSaved = JSON.parse(await readFile(pendingPath, 'utf8'));
  assert.equal(pendingSaved.attempts[0].state, 'submitted_or_pending');

  const successfulUnrelated = (digest: string) => ({
    $kind: 'Transaction',
    Transaction: {
      digest,
      effects: {
        status: { success: true, error: null },
        changedObjects: [],
      },
      objectTypes: {},
    },
  });
  fake.client.getTransaction = async () => successfulUnrelated('own-successful-but-unrelated');
  const mismatchedPath = join(root, 'mismatched.json');
  const mismatchedJournal = journal('channel_close', [{
    digest: 'own-successful-but-unrelated', bytes: 'bytes', signature: 'signature', state: 'submitted_or_pending',
  }]);
  await writeFile(mismatchedPath, JSON.stringify(mismatchedJournal));
  const mismatched = await fake.recoverFromChannel(
    mismatchedPath, mismatchedJournal, terminalRecord('other-actor'),
  );
  assert.equal(mismatched.resolution, 'external');
  assert.equal(mismatched.digest, null);
  assert.equal(mismatchedJournal.attempts[0].state, 'submitted_or_pending');

  const confirmedPath = join(root, 'confirmed-unrelated.json');
  const confirmedJournal = journal('channel_close', [{
    digest: 'confirmed-successful-but-unrelated', bytes: 'bytes', signature: 'signature', state: 'confirmed',
  }]);
  await writeFile(confirmedPath, JSON.stringify(confirmedJournal));
  fake.client.getTransaction = async () => successfulUnrelated('confirmed-successful-but-unrelated');
  const confirmed = await fake.recoverFromChannel(
    confirmedPath, confirmedJournal, terminalRecord('other-actor'),
  );
  assert.equal(confirmed.resolution, 'external');
  assert.equal(confirmed.digest, null);

  const channelType = `${offer.package_id}::channel::Channel`;
  const successfulChannelMutation = (digest: string, created = false) => ({
    $kind: 'Transaction',
    Transaction: {
      digest,
      effects: {
        status: { success: true, error: null },
        changedObjects: [{
          objectId: channelId,
          inputState: created ? 'DoesNotExist' : 'Exists',
          outputState: 'ObjectWrite',
          idOperation: created ? 'Created' : 'None',
        }],
      },
      objectTypes: { [channelId]: channelType },
    },
  });
  const openMutation = successfulChannelMutation('open-success', true);
  fake.client.getTransaction = async () => openMutation;
  const openPath = join(root, 'open-effects.json');
  const openJournal = journal('channel_open', [{
    digest: 'open-success', bytes: 'bytes', signature: 'signature', state: 'submitted_or_pending',
  }]);
  await writeFile(openPath, JSON.stringify(openJournal));
  const openRecord = terminalRecord('ignored') as any;
  openRecord.view.status = 0;
  openRecord.view.terminal_digest = null;
  openRecord.view.terminal_tx = [];
  openRecord.view.close_hash = [];
  const opened = await fake.recoverFromChannel(openPath, openJournal, openRecord);
  assert.equal(opened.resolution, 'own');
  assert.equal(opened.digest, 'open-success');

  const confirmedRedeemPath = join(root, 'confirmed-redeem-effects.json');
  const confirmedRedeemJournal = journal('channel_redeem', [{
    digest: 'redeem-success', bytes: 'bytes', signature: 'signature', state: 'confirmed',
  }]);
  confirmedRedeemJournal.credit = credit;
  await writeFile(confirmedRedeemPath, JSON.stringify(confirmedRedeemJournal));
  fake.client.getTransaction = async () => successfulChannelMutation('redeem-success');
  const redeemedRecord = terminalRecord('ignored') as any;
  redeemedRecord.view.status = 0;
  redeemedRecord.view.terminal_digest = null;
  redeemedRecord.view.terminal_tx = [];
  redeemedRecord.view.close_hash = [];
  const redeemed = await fake.recoverFromChannel(
    confirmedRedeemPath, confirmedRedeemJournal, redeemedRecord,
  );
  assert.equal(redeemed.resolution, 'own');
  assert.equal(redeemed.digest, 'redeem-success');

  const terminalRedeemPath = join(root, 'terminal-redeem.json');
  const terminalRedeemJournal = journal('channel_redeem', [{
    digest: 'other-actor', bytes: 'bytes', signature: 'signature', state: 'submitted_or_pending',
  }]);
  terminalRedeemJournal.credit = credit;
  await writeFile(terminalRedeemPath, JSON.stringify(terminalRedeemJournal));
  fake.client.getTransaction = async () => successfulChannelMutation('other-actor');
  const terminalRedeem = await fake.recoverFromChannel(
    terminalRedeemPath, terminalRedeemJournal, terminalRecord('other-actor'),
  );
  assert.equal(terminalRedeem.resolution, 'external');
  assert.equal(terminalRedeem.digest, null);

  const ownPath = join(root, 'own.json');
  const ownJournal = journal('channel_close', [{
    digest: 'own-terminal', bytes: 'bytes', signature: 'signature', state: 'submitted_or_pending',
  }]);
  await writeFile(ownPath, JSON.stringify(ownJournal));
  const own = await fake.recoverFromChannel(ownPath, ownJournal, terminalRecord('own-terminal'));
  assert.equal(own.resolution, 'own');
  assert.equal(own.digest, 'own-terminal');
  const ownSaved = JSON.parse(await readFile(ownPath, 'utf8'));
  assert.equal(ownSaved.resolution, 'own');
  assert.equal(ownSaved.attempts[0].state, 'confirmed');

  const intentPath = join(root, 'intent.json');
  await writeFile(intentPath, JSON.stringify({ version: 1, action: 'channel_redeem', state: 'prepared', attempts: [] }));
  let lookupCalled = false;
  fake.lookupChannel = async () => { lookupCalled = true; return channelId; };
  await assert.rejects(
    () => fake.openChannel(offer, offerSignature, {}, intentPath),
    /transaction journal action mismatch/,
  );
  assert.equal(lookupCalled, false, 'journal intent must be checked before opening fast path');

  const { terminal_digest: _, ...partialClose } = terminalRecord('closed').view;
  partialClose.redeemed_amount = '1000';
  validateChannel(partialClose);
  const fullRefund = { ...partialClose, status: 2, redeemed_amount: '0', redeemed_sequence: '0', close_hash: [] };
  validateChannel(fullRefund);
  assert.throws(() => validateChannel({ ...partialClose, funds: '1' }), /conservation/);
  assert.throws(() => validateChannel({ ...partialClose, redeemed_amount: String(BigInt(offer.deposit) + 1n) }), /conservation/);
  const openState = { ...partialClose, status: 0, funds: String(BigInt(offer.deposit) - 1000n), terminal_tx: [], close_hash: [] };
  validateChannel(openState);
  assert.throws(() => validateChannel({ ...openState, funds: '0' }), /conservation/);

  const invalidOffer = structuredClone(offer); invalidOffer.package_id = '0x3';
  assert.throws(() => validateOffer(invalidOffer), /canonical address/);
  const invalidCredit = structuredClone(credit); invalidCredit.cumulative_amount = '0';
  assert.throws(() => validateCredit(invalidCredit), /positive/);
  const invalidAck = structuredClone(ack); invalidAck.cumulative_amount = '0';
  assert.throws(() => validateAck(invalidAck), /positive/);
  const invalidClose = structuredClone(close); invalidClose.final_sequence = '0';
  assert.throws(() => validateClose(invalidClose), /both zero or both positive/);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('channel journal recovery and codec regressions passed');
