#!/usr/bin/env python3
"""Exercise one channel with real buyer/provider processes and transaction journals."""
import argparse
import json
import math
import os
from pathlib import Path
import signal
import statistics
import subprocess
import time
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default='.m2m/channels-local')
    parser.add_argument('--count', type=int, default=10)
    parser.add_argument('--relay-only', action='store_true')
    parser.add_argument('--block-rpc-in-jobs', action='store_true',
                        help='Localnet only: deny actual RPC requests during admitted jobs')
    parser.add_argument('--peer-auth', action='store_true',
                        help='Run the unrelated-endpoint attack against the direct provider')
    args = parser.parse_args()
    if not 1 <= args.count <= 100:
        parser.error('--count must be between 1 and 100')
    if args.peer_auth and args.relay_only:
        parser.error('--peer-auth uses a direct-path test client')
    root = Path(args.root).resolve()
    binary = Path('target/debug/m2m').resolve()
    fixture = Path('fixtures/hello.txt').resolve()
    ticket = root / 'channel-ticket.json'
    session = 'demo-' + uuid.uuid4().hex[:12]
    events = root / f'{session}.buyer.log'
    provider_log = root / f'{session}.provider.log'
    relay = ['--relay-only'] if args.relay_only else []
    provider = None
    environment = os.environ.copy()
    if args.block_rpc_in_jobs:
        config = json.loads((root / 'chain.json').read_text())
        if config['network'] != 'localnet':
            parser.error('--block-rpc-in-jobs is restricted to localnet')
        environment['M2M_CHANNEL_RPC_DENY_FILE'] = str(root / f'{session}.rpc-deny')

    def run(argv):
        result = subprocess.run([str(x) for x in argv], capture_output=True,
                                text=True, timeout=240, env=environment)
        with events.open('a') as log:
            log.write(result.stderr)
        if result.returncode:
            raise RuntimeError(result.stderr)
        return json.loads(result.stdout)

    def journals():
        result = {}
        for path in root.rglob('*.tx.json'):
            record = json.loads(path.read_text())
            if record.get('state') == 'confirmed':
                result[record['digest']] = record
        return result

    for role in ['buyer', 'provider']:
        if not (root / role / 'identity.json').exists():
            run([binary, '--state', root / role, 'init', '--chain', root / 'chain.json',
                 '--signer', root / f'{role}-controller.json'])
    provider_id = json.loads((root / 'provider' / 'identity.json').read_text())['agent']
    log = provider_log.open('a')
    try:
        started = time.time_ns()
        provider = subprocess.Popen([str(x) for x in [binary, '--state', root / 'provider',
            'channel-serve', '--file', fixture, '--gas-signer', root / 'provider-gas.json',
            '--ticket', ticket, *relay]], stdout=log, stderr=log, env=environment)
        for _ in range(600):
            if provider.poll() is not None:
                raise RuntimeError(provider_log.read_text()[-6000:])
            if ticket.exists() and ticket.stat().st_mtime_ns >= started:
                break
            time.sleep(0.1)
        else:
            raise RuntimeError('Channel provider readiness timed out')
        if args.peer_auth:
            tested = subprocess.run(['cargo', 'test', '--locked', '--test', 'channel_peer_auth',
                '--', '--ignored'], env={**environment, 'M2M_TEST_ROOT': str(root)},
                text=True, capture_output=True, timeout=180)
            with events.open('a') as output:
                output.write(tested.stderr)
            if tested.returncode:
                raise RuntimeError(tested.stdout + tested.stderr)
        before = journals()
        command = [binary, '--state', root / 'buyer', 'channel-buy', '--provider', provider_id,
            '--ticket', ticket, '--expected-file', fixture, '--signer', root / 'buyer-controller.json',
            '--session', session, '--jobs', args.count, '--deposit', args.count * 1000 + 2000,
            '--max-unit-price', 1000, *relay]
        start = time.monotonic()
        outcome = run(command)
        wall_ms = round((time.monotonic() - start) * 1000)
        after = journals()
        economic = {k: v for k, v in after.items() if k not in before}
        assert len(economic) == 2, f'Expected open + close, found {len(economic)} transactions'
        confirmed = run([binary, '--state', root / 'buyer', 'channel-status', '--session', session])
        assert confirmed['phase'] == 'closed' and confirmed['terminal'], 'Channel is not confirmed closed'
        assert int(confirmed['completed_jobs']) == args.count
        assert int(confirmed['authorized']) == args.count * 1000
        assert int(confirmed['redeemed']) == args.count * 1000
        assert int(confirmed['residual']) == 0
        repeated = run(command)
        assert set(journals()) == set(after), 'Repeating a closed session submitted a transaction'
        interval = False
        starts = ends = jobs = rpc_in_jobs = 0
        latencies_us = []
        loop_ms = None
        job_start_ms = job_end_ms = None
        for line in events.read_text().splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = event.get('event')
            if kind == 'channel_jobs_begin':
                assert not interval
                interval = True
                starts += 1
                job_start_ms = event["timestamp_ms"]
            elif kind == 'channel_jobs_end':
                assert interval
                interval = False
                ends += 1
                loop_ms = event['elapsed_ms']
                job_end_ms = event["timestamp_ms"]
            elif interval and kind == 'channel_rpc':
                rpc_in_jobs += event.get('count', 1)
            elif interval and kind == 'channel_job_complete':
                jobs += 1
                latencies_us.append(int(event['elapsed_us']))
        assert starts == ends == 1 and not interval, 'Missing or repeated admitted jobs interval'
        assert jobs == args.count, f'Expected {args.count} completed jobs, found {jobs}'
        provider_rpc_in_jobs = 0
        for line in provider_log.read_text().splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get('event') == 'channel_rpc' and event.get('result') in ('started', 'denied'):
                assert 'timestamp_ms' in event, 'RPC event lacks actual-boundary timestamp'
                if job_start_ms <= event['timestamp_ms'] <= job_end_ms:
                    provider_rpc_in_jobs += 1
        assert rpc_in_jobs == 0, f'Found {rpc_in_jobs} buyer RPC calls in the admitted job interval'
        assert provider_rpc_in_jobs == 0, f'Found {provider_rpc_in_jobs} provider RPC calls in the admitted job interval'
        ordered = sorted(latencies_us)
        gas_mist = sum(int(t['gas']['computationCost']) + int(t['gas']['storageCost'])
                       - int(t['gas']['storageRebate']) for t in economic.values())
        report = {'session': session, 'requested_jobs': args.count, 'relay_only': args.relay_only,
                  'peer_auth_attack_rejected': args.peer_auth,
                  'rpc_blocked_during_jobs': args.block_rpc_in_jobs,
                  'rpc_calls_during_jobs': rpc_in_jobs + provider_rpc_in_jobs,
                  'buyer_rpc_calls_during_jobs': rpc_in_jobs,
                  'provider_rpc_calls_during_jobs': provider_rpc_in_jobs,
                  'offchain_loop_ms': loop_ms, 'net_economic_gas_mist': str(gas_mist),
                  'job_latency_us': {'samples': latencies_us, 'p50': statistics.median(ordered),
                                     'p95': ordered[math.ceil(len(ordered) * 0.95) - 1], 'max': max(ordered)},
                  'wall_ms': wall_ms, 'outcome': outcome, 'confirmed': confirmed, 'repeated': repeated,
                  'economic_transactions': list(economic.values())}
        path = root / f'{session}.results.json'
        path.write_text(json.dumps(report, indent=2) + '\n')
        path.chmod(0o600)
        print(json.dumps({'results': str(path), 'economic_transactions': len(economic),
                          'wall_ms': wall_ms, 'outcome': outcome}, indent=2))
    finally:
        if provider is not None and provider.poll() is None:
            provider.send_signal(signal.SIGINT)
            try:
                provider.wait(timeout=12)
            except subprocess.TimeoutExpired:
                provider.terminate()
                provider.wait(timeout=10)
        log.close()


if __name__ == '__main__':
    main()
