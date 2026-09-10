#!/usr/bin/env python3
"""Generate/check public wire examples. Reads only repository test fixtures."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'examples/messages'
# Deliberately synthetic: a well-formed-looking digest is not settlement evidence.
DIGEST = '1' * 32


def render(value, depth=0):
    """Readable exact JSON: byte arrays stay on one line; objects are indented."""
    if isinstance(value, dict) and value:
        pad = '  ' * (depth + 1)
        return '{\n' + ',\n'.join(pad + json.dumps(k) + ': ' + render(v, depth + 1)
                                   for k, v in value.items()) + '\n' + '  ' * depth + '}'
    if isinstance(value, list) and any(isinstance(v, (dict, list)) for v in value):
        return '[\n' + ',\n'.join('  ' * (depth + 1) + render(v, depth + 1)
                                   for v in value) + '\n' + '  ' * depth + ']'
    return json.dumps(value, ensure_ascii=False)


def corpus():
    vector = json.loads((ROOT / 'fixtures/channel-signing-vectors.json').read_text())
    legacy = json.loads((ROOT / 'fixtures/signing-vectors.json').read_text())
    data = vector['statements']
    payload = lambda name: data[name]['payload']
    raw = lambda value: list(bytes.fromhex(value))
    signed = lambda name: {'payload': payload(name), 'signature': raw(data[name]['signature_hex'])}
    offer, terms, request = payload('offer'), payload('terms'), payload('request')
    channel = request['channel']
    request_id = bytes(request['request_id']).decode('ascii')
    cert = {'close': payload('close'),
            'buyer_signature': raw(data['close']['buyer_signature_hex']),
            'provider_signature': raw(data['close']['provider_signature_hex'])}
    files, entries = {}, []

    def add(profile, name, message, direction, summary, status='implemented', variant=False):
        path = f'{profile}/{name}.json'
        files[path] = message
        kind = message['message']['type'] if profile == 'channel' else message.get('method', message.get('kind'))
        entries.append({'file': path, 'profile': profile, 'type': kind, 'direction': direction,
                        'runtime_status': status, 'variant': variant, 'summary': summary})

    def frame(kind, fields, *, job=False, unfunded=False):
        return {'version': 1, 'method': vector['method'], 'buyer': offer['buyer'],
                'provider': offer['provider'], 'agreement_id': '0x' + '0' * 64 if unfunded else channel,
                'request_id': request_id if job else '', 'message': {'type': kind, **fields}}

    def message(kind, fields, direction, summary, **kwargs):
        status = kwargs.pop('status', 'implemented')
        add('channel', kind, frame(kind, fields, **kwargs), direction, summary, status)

    message('payment.offer_request', {'opening_nonce': offer['opening_nonce'],
            'result_hash': terms['result_hash'], 'jobs': terms['max_jobs'],
            'max_unit_price': terms['unit_price'], 'deposit': offer['deposit']},
            'buyer_to_provider', 'Request a ten-job ceiling; this walkthrough closes after one job.', unfunded=True)
    message('payment.offer', {'offer': signed('offer'), 'terms': terms},
            'provider_to_buyer', 'Signed provider terms before the buyer funds the channel.', unfunded=True)
    message('session.resume', {}, 'buyer_to_provider', 'Admit or resume the synthetic funded channel.')
    ready = {'phase': 'active', 'highest_credit': None, 'completed_jobs': '0',
             'transcript_hash': raw(vector['hashes']['transcript_start']),
             'certificate': None, 'redeemed_amount': '0'}
    message('session.ready', ready, 'provider_to_buyer', 'Freshly admitted; no credit has been issued.')
    message('payment.authorize', {'request': request, 'credit': signed('credit')},
            'buyer_to_provider', 'Preauthorize job-0001 for 1,000 MIST cumulative.', job=True)
    message('payment.acknowledge', {'ack': signed('ack')},
            'provider_to_buyer', 'Acknowledge durable credit receipt; this does not prove delivery or payment.', job=True)
    message('work.get', {'request_hash': payload('credit')['request_hash']},
            'buyer_to_provider', 'Retrieve the exact request already backed by a saved credit.', job=True)
    message('work.result', {'result': signed('result'), 'bytes': list((ROOT / 'fixtures/hello.txt').read_bytes())},
            'provider_to_buyer', 'Return the fixture bytes and their signed request/credit binding.', job=True)
    message('payment.close', {'close': {'payload': payload('close'),
            'signature': cert['buyer_signature']}}, 'buyer_to_provider', 'Propose an early close after one completed job.')
    message('payment.close_acknowledge', {'certificate': cert},
            'provider_to_buyer', 'Countersign the close after freezing; the buyer submits it separately to Sui.')
    message('payment.settlement', {'digest': DIGEST}, 'buyer_to_provider',
            'Specified post-submission hint. No runtime sender/handler exists; digest is synthetic.', status='specified_only')
    message('error', {'code': 'conflict', 'message': 'conflicting repeated credit'},
            'provider_to_buyer', 'Alternative failure branch: the same request conflicts with saved credit.', job=True)

    resumed = {**ready, 'highest_credit': signed('credit'), 'completed_jobs': '1',
               'transcript_hash': raw(vector['hashes']['transcript_final'])}
    for label, fields, summary in [
        ('resumed', resumed, 'Restart after one result, before closing; no funds redeemed yet.'),
        ('frozen', {**resumed, 'phase': 'frozen', 'certificate': cert},
         'Close certificate saved; onchain settlement has not yet been observed.'),
        ('closed', {**resumed, 'phase': 'closed', 'certificate': cert, 'redeemed_amount': '1000'},
         'Cooperative-close branch: 1,000 MIST paid and 11,000 refunded.'),
        ('refunded', {**resumed, 'phase': 'refunded', 'redeemed_amount': '1000'},
         'Alternative branch: unilateral 1,000-MIST redemption followed by residual expiry refund.'),
    ]:
        add('channel', f'session.ready.{label}', frame('session.ready', fields),
            'provider_to_buyer', summary, variant=True)

    quote, acceptance = legacy['quote'], legacy['acceptance']
    signed_quote = {'quote': quote, 'signature': raw(legacy['quote_signature'])}
    receipt = {'acceptance': acceptance, 'signature': raw(legacy['acceptance_signature'])}
    for name, value, direction, summary in [
        ('request.quote', {'method': 'quote', 'version': 1, 'buyer': quote['buyer'],
         'nonce': quote['nonce'], 'result_hash': quote['result_hash']}, 'buyer_to_provider', 'Request the fixture quote.'),
        ('response.quote', {'kind': 'quote', 'signed': signed_quote}, 'provider_to_buyer', 'Sign 1,000-MIST escrow terms.'),
        ('request.deliver', {'method': 'deliver', 'version': 1, 'escrow': acceptance['escrow']},
         'buyer_to_provider', 'Retrieve the funded fixture.'),
        ('response.result', {'kind': 'result', 'escrow': acceptance['escrow'],
         'bytes': list((ROOT / 'fixtures/hello.txt').read_bytes())}, 'provider_to_buyer', 'Return fixture bytes.'),
        ('request.accept', {'method': 'accept', 'version': 1, 'receipt': receipt},
         'buyer_to_provider', 'Sign acceptance after verifying the delivered fixture.'),
        ('response.settled', {'kind': 'settled', 'escrow': acceptance['escrow'], 'digest': DIGEST},
         'provider_to_buyer', 'Implemented settlement response; this illustrative digest is not a chain transaction.'),
        ('response.error', {'kind': 'error', 'code': 'request_failed', 'message': 'quote expired'},
         'provider_to_buyer', 'Alternative error branch; reconcile before taking economic action.'),
    ]:
        add('escrow', name, value, direction, summary)

    files['index.json'] = {'format_version': 1, 'synthetic': True,
        'notice': 'Offline examples from public signing vectors. Object IDs, network, times and digests are synthetic; do not fund the test keys.',
        'profiles': {'channel': {'alpn': 'm2m/payment/1', 'method': 'sui.channel.v1',
                     'schema': '../../schemas/channel-v1.schema.json'},
                     'escrow': {'alpn': 'm2m/fixture/1', 'schema': '../../schemas/exchange-v1.schema.json'}},
        'examples': entries}
    return files


def validate(files):
    try:
        from jsonschema import Draft202012Validator
    except ImportError as error:
        raise SystemExit('Schema checks require jsonschema; see examples/messages/README.md for setup.') from error
    schemas = {name: json.loads((ROOT / 'schemas' / path).read_text()) for name, path in
               [('channel', 'channel-v1.schema.json'), ('escrow', 'exchange-v1.schema.json')]}
    for schema in schemas.values():
        Draft202012Validator.check_schema(schema)
    validators = {name: Draft202012Validator(schema) for name, schema in schemas.items()}
    for item in files['index.json']['examples']:
        validators[item['profile']].validate(files[item['file']])
    # Read the declared variants from the schemas, not a second handwritten list.
    def tags(branches, name):
        return {branch['properties'][name]['const'] for branch in branches}
    entries = files['index.json']['examples']
    declared = tags(schemas['channel']['$defs']['Message']['oneOf'], 'type')
    actual = {item['type'] for item in entries if item['profile'] == 'channel' and not item['variant']}
    if actual != declared:
        raise SystemExit(f'Channel message coverage differs: missing={declared - actual}, extra={actual - declared}')
    for definition, direction, tag in [('Request', 'buyer_to_provider', 'method'), ('Response', 'provider_to_buyer', 'kind')]:
        declared = tags(schemas['escrow']['$defs'][definition]['oneOf'], tag)
        actual = {item['type'] for item in entries if item['profile'] == 'escrow' and item['direction'] == direction}
        if actual != declared:
            raise SystemExit(f'Escrow {definition} coverage differs: {actual ^ declared}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--write', action='store_true', help='regenerate examples from public vectors')
    modes.add_argument('--check', action='store_true', help='check schemas, coverage, and exact regeneration (default)')
    args = parser.parse_args()
    files = corpus()
    validate(files)
    stale = []
    for name, data in files.items():
        path, expected = DEST / name, render(data) + '\n'
        if args.write:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(expected)
        elif not path.exists() or path.read_text() != expected:
            stale.append(name)
    existing = {str(p.relative_to(DEST)) for folder in ['channel', 'escrow']
                for p in (DEST / folder).glob('*.json')}
    extra = existing - set(files)
    if stale or extra:
        raise SystemExit(f'Examples differ: stale={sorted(stale)}, unindexed={sorted(extra)}; regenerate with --write.')
    entries = files['index.json']['examples']
    channel_count = sum(e['profile'] == 'channel' and not e['variant'] for e in entries)
    escrow_count = sum(e['profile'] == 'escrow' and not e['variant'] for e in entries)
    print(f'{"Generated" if args.write else "Verified"} {len(files) - 1} examples '
          f'covering all {channel_count} channel and {escrow_count} escrow message shapes.')


if __name__ == '__main__':
    main()
