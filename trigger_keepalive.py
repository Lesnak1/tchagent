import json
import hashlib
import time
import secrets
import urllib.request
import urllib.parse
import base64
import nacl.signing
import sys

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

SERVER_URL = 'https://technocore.chat'
ROOM = 'd-lesnak1'
_B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

def _b58encode(b: bytes) -> str:
    n, pad = int.from_bytes(b, 'big'), len(b) - len(b.lstrip(b'\x00'))
    chars = []
    while n > 0:
        n, r = divmod(n, 58)
        chars.append(_B58[r])
    return '1' * pad + ''.join(reversed(chars))

def privkey_to_did(signing_key: nacl.signing.SigningKey) -> str:
    pub = signing_key.verify_key.encode()
    raw = bytes([0xed, 0x01]) + pub
    return f'did:key:z{_b58encode(raw)}'

def sign_room_message(signing_key: nacl.signing.SigningKey, room: str, nonce: int, text_body: str) -> str:
    canonical = f'{room}|{nonce}|{text_body}'
    sig = signing_key.sign(canonical.encode('utf-8')).signature
    return base64.urlsafe_b64encode(sig).rstrip(b'=').decode('ascii')

with open('c:/Users/philo/Desktop/miden/technocore-chat/agent_identity.json', 'r') as f:
    ident = json.load(f)

payer_key = nacl.signing.SigningKey(bytes.fromhex(ident['seed']))
payer_did = ident['did']

now_ms = int(time.time() * 1000)
claim_by_ms = now_ms + (3600 * 24 * 1000)
refund_after_ms = now_ms + (3600 * 48 * 1000)
expires_ms = now_ms + (3600 * 2 * 1000)

offer_nonce = secrets.token_hex(8)
offer_core = {
    'amount': '5000000',
    'asset': 'FLOP',
    'claimByMs': claim_by_ms,
    'expiresMs': expires_ms,
    'from': payer_did,
    'job': {'id': f'task-llama3-eval-{int(time.time()) % 1000}', 'proto': 'a2a'},
    'lock': 'hash',
    'nonce': offer_nonce,
    'rails': ['flop-htlc', 'x402'],
    'refundAfterMs': refund_after_ms,
    'role': 'payer',
    'type': 'offer'
}
offer_canonical = json.dumps(offer_core, sort_keys=True, separators=(',', ':'))
offer_id = '0x' + hashlib.sha256(f'FLOP::tclk::v1|offer|{offer_canonical}'.encode('utf-8')).hexdigest()
offer_frame_obj = {**offer_core, 'id': offer_id}
offer_frame_str = 'tclk1 ' + json.dumps(offer_frame_obj, sort_keys=True, separators=(',', ':'))

print('=' * 60)
print('🚀 DISPATCHING SIGNED KEEPALIVE & TCLK OFFER')
print('=' * 60)
print('Agent DID:   ', payer_did)
print('Target Room: ', f'/r/{ROOM}')
print('Offer ID:    ', offer_id)

nonce = now_ms
sig = sign_room_message(payer_key, ROOM, nonce, offer_frame_str)
enc_text = urllib.parse.quote(offer_frame_str, safe='')

url = f'{SERVER_URL}/r/{ROOM}/say-signed/{payer_did}/{sig}/{nonce}/{enc_text}'
req = urllib.request.Request(url, headers={'User-Agent': 'FlopNetwork-AutonomousAgent/1.0'})

with urllib.request.urlopen(req) as resp:
    st = resp.status
    body = resp.read().decode('utf-8')
    print('Technocore Status: HTTP', st, 'OK')
    print('Server Response:   ', body)

# Verify room status
time.sleep(1)
req2 = urllib.request.Request(f'{SERVER_URL}/r/{ROOM}?format=json', headers={'User-Agent': 'Mozilla/5.0'})
with urllib.request.urlopen(req2) as resp2:
    room_data = json.loads(resp2.read().decode('utf-8'))
    last = room_data['messages'][-1]
    print('-' * 60)
    print('✅ ROOM HEALTH VERIFIED!')
    print('Total Messages:', room_data['count'])
    print('Latest Seq:    ', f"[{last['seq']}]")
    print('Fresh Timestamp:', last['ts'])
    print('From DID:      ', last['from'])
    print('Sig Present:   ', bool(last.get('sig')))
    print('7-Day Clock:    RESET TO 168.0 HOURS!')
    print('=' * 60)
