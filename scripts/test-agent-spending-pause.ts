/** Race-focused spending admission tests; no chain, wallet, or credentials. */
import { strict as assert } from 'node:assert';
import { AgentServiceClient } from './agent-service-client.js';

interface GateSurface {
  spendingPaused: boolean;
  spendingWaiters: Set<() => void>;
  spendingQueue: Promise<unknown>;
  setSpendingPaused(paused: boolean): void;
  waitForSpending(signal?: AbortSignal): Promise<void>;
  withCreditAdmission<T>(requestId: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const client = Object.create(AgentServiceClient.prototype) as GateSurface;
  client.spendingPaused = false;
  client.spendingWaiters = new Set();
  client.spendingQueue = Promise.resolve();

  client.setSpendingPaused(true);
  let calls = 0;
  const pending = client.withCreditAdmission('11'.repeat(32), async () => { calls += 1; return 'signed'; });
  await sleep(5);
  assert.equal(calls, 0, 'a paused admission must not sign');
  client.setSpendingPaused(false);
  assert.equal(await pending, 'signed');
  assert.equal(calls, 1);

  client.setSpendingPaused(true);
  const controller = new AbortController();
  const aborted = client.waitForSpending(controller.signal);
  controller.abort();
  await assert.rejects(aborted, /cancelled/);
  client.setSpendingPaused(false);

  const order: string[] = [];
  const first = client.withCreditAdmission('22'.repeat(32), async () => { order.push('first'); await sleep(2); return 1; });
  const second = client.withCreditAdmission('33'.repeat(32), async () => { order.push('second'); return 2; });
  assert.deepEqual([await first, await second], [1, 2]);
  assert.deepEqual(order, ['first', 'second']);
  console.log('PASS spending admission: pause blocks signing, abort wakes waiter, admissions serialize');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
