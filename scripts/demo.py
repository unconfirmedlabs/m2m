#!/usr/bin/env python3
"""Run real separate buyer/provider processes against an already deployed Sui package."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--root', default='.m2m/demo')
parser.add_argument('--count', type=int, default=10)
parser.add_argument('--failures', action='store_true')
parser.add_argument('--relay', action='store_true')
parser.add_argument('--relay-only', action='store_true')
parser.add_argument('--rpc-outage', action='store_true', help='run just the RPC outage scenario in addition to purchases')
args = parser.parse_args()
root = Path(args.root).resolve()
binary = Path('target/debug/m2m').resolve()
fixture = Path('fixtures/hello.txt').resolve()
ticket = root / 'provider-ticket.json'
prefix = uuid.uuid4().hex[:10]
results = []
server = None
server_log = None

def run(argv, succeeds=True):
    r = subprocess.run([str(x) for x in argv], capture_output=True, text=True, timeout=200)
    with open(root / 'demo-events.log', 'a') as events:
        events.write(r.stderr)
    if succeeds and r.returncode:
        raise RuntimeError(r.stderr)
    if not succeeds:
        assert r.returncode != 0, 'Expected injected failure'
        return r
    return json.loads(r.stdout)

def init(role):
    if not (root / role / 'identity.json').exists():
        run([binary, '--state', root / role, 'init', '--chain', root / 'chain.json',
             '--signer', root / f'{role}-controller.json'])

def start(*extra):
    global server, server_log
    stop()
    started = time.time_ns()
    server_log = open(root / 'demo-provider.log', 'a')
    cmd = [str(binary), '--state', str(root / 'provider'), 'serve', '--file', str(fixture),
           '--gas-signer', str(root / 'provider-gas.json'), '--ticket', str(ticket), *extra]
    if args.relay:
        cmd.append('--relay')
    if args.relay_only:
        cmd.append('--relay-only')
    server = subprocess.Popen(cmd, stdout=server_log, stderr=server_log)
    for _ in range(400):
        if server.poll() is not None:
            raise RuntimeError((root / 'demo-provider.log').read_text()[-6000:])
        if ticket.exists() and ticket.stat().st_mtime_ns >= started:
            return
        time.sleep(0.1)
    raise RuntimeError('Provider readiness timed out')

def stop():
    global server, server_log
    if server is not None and server.poll() is None:
        server.send_signal(signal.SIGINT)
        try:
            server.wait(timeout=12)
        except subprocess.TimeoutExpired:
            server.terminate()
            server.wait(timeout=10)
    server = None
    if server_log:
        server_log.close()
        server_log = None

def buy(name, *extra, succeeds=True):
    cmd = [binary, '--state', root / 'buyer', 'buy', '--provider', provider,
           '--ticket', ticket, '--expected-file', fixture,
           '--signer', root / 'buyer-controller.json', '--request', f'{prefix}-{name}', *extra]
    if args.relay:
        cmd.append('--relay')
    if args.relay_only:
        cmd.append('--relay-only')
    return run(cmd, succeeds)

def job(name):
    return root / 'buyer' / 'purchases' / f'{prefix}-{name}.json'

def record(name, outcome):
    results.append({'test':name, **outcome})
    print(f"PASS {name}: {outcome.get('escrow', '')}", flush=True)

try:
    init('buyer')
    init('provider')
    provider = json.loads((root / 'provider' / 'identity.json').read_text())['agent']
    start()
    for n in range(args.count):
        before=time.monotonic()
        result=buy(f'purchase-{n}')
        assert result['status']=='settled'
        result['wall_ms']=round((time.monotonic()-before)*1000)
        record(f'purchase-{n}',result)
    if args.failures:
        funded=buy('funding-recovery','--stop-after','funded')
        pending=json.loads(job('funding-recovery').read_text())
        pending['escrow']=None  # simulate losing the funding reply/local reference
        job('funding-recovery').write_text(json.dumps(pending))
        recovered=buy('funding-recovery')
        assert recovered['escrow']==funded['escrow']
        again=buy('funding-recovery')
        assert again['digest']==recovered['digest'] and again['recovered']
        record('funding-recovery-and-repeat',recovered)

        accepted=buy('buyer-restart','--stop-after','accepted')
        receipt=json.loads(job('buyer-restart').read_text())['receipt']
        recovered=buy('buyer-restart')
        assert recovered['escrow']==accepted['escrow']
        assert json.loads(job('buyer-restart').read_text())['receipt']==receipt
        record('buyer-restart-after-acceptance',recovered)

        start('--drop-after-delivery')
        buy('provider-restart',succeeds=False)
        pending=json.loads(job('provider-restart').read_text())
        assert (root/'provider'/'results'/f"{pending['escrow']}.json").exists()
        start()
        recovered=buy('provider-restart')
        assert recovered['escrow']==pending['escrow']
        record('provider-restart-after-persisting-result',recovered)

        start('--drop-after-settle')
        recovered=buy('lost-settlement-reply')
        assert recovered['status']=='settled'
        record('lost-settlement-reply',recovered)

        start('--lifetime-ms','20000')
        funded=buy('timeout','--stop-after','funded')
        pending=json.loads(job('timeout').read_text())
        deadline=int(pending['quote']['quote']['deadline_ms'])
        while int(time.time()*1000) <= deadline+1500:
            time.sleep(0.25)
        result=run([binary,'--state',root/'buyer','refund','--request',f'{prefix}-timeout',
                    '--gas-signer',root/'provider-gas.json'])
        repeated=run([binary,'--state',root/'buyer','refund','--request',f'{prefix}-timeout',
                      '--gas-signer',root/'provider-gas.json'])
        assert repeated['status']==2 and repeated['funds']=='0'
        record('timeout-refund-and-repeat',{'escrow':funded['escrow'],'digest':result['digest']})
    if args.failures or args.rpc_outage:
        start()
        funded=buy('rpc-outage','--stop-after','funded')
        identity_path=root/'buyer'/'identity.json'
        original_identity=identity_path.read_text()
        original_job=job('rpc-outage').read_text()
        broken=json.loads(original_identity)
        broken['chain']['rpc_url']='http://127.0.0.1:1'
        try:
            identity_path.write_text(json.dumps(broken))
            failed=buy('rpc-outage',succeeds=False)
            assert 'Sui operation failed' in failed.stderr
            assert job('rpc-outage').read_text()==original_job
        finally:
            identity_path.write_text(original_identity)
        recovered=buy('rpc-outage')
        assert recovered['escrow']==funded['escrow']
        record('rpc-outage-keeps-original-agreement',recovered)
    (root / f'demo-results-{prefix}.json').write_text(json.dumps(results,indent=2))
    print(f'Results: {root}/demo-results-{prefix}.json',flush=True)
finally:
    stop()
