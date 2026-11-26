// Pure crypto helpers for the identity system. No game-code coupling.
// Player ID: public identity. Recovery Key: 128-bit secret, stored only as scrypt hash.
const crypto = require('crypto');

const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars: no 0,1,I,O - readable aloud

// Public Player ID, e.g. LK-7F3K-9Q2M. Not secret, grants nothing by itself.
function genPlayerId() {
  const g = n => Array.from(crypto.randomBytes(n)).map(b => B32[b % 32]).join('');
  return 'LK-' + g(4) + '-' + g(4);
}

// Recovery Key: 160 bits, shown once as 8 groups of 4 chars (32 chars total, 160/5 = 32 exactly)
function genRecoveryKey() {
  const bytes = crypto.randomBytes(20); // 160 bits
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < 160; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out.match(/.{1,4}/g).join('-');
}

// Normalize before verify: uppercase, strip dashes/spaces
function normRecoveryKey(key) {
  return String(key || '').toUpperCase().replace(/[-\s]/g, '');
}

// scrypt hash, format: scrypt$N$r$p$salt_b64$hash_b64
function hashRecoveryKey(key) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const h = crypto.scryptSync(normRecoveryKey(key), salt, 32, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64'), h.toString('base64')].join('$');
}

function verifyRecoveryKey(key, stored) {
  try {
    const [alg, N, r, p, saltB64, hashB64] = String(stored || '').split('$');
    if (alg !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const h = crypto.scryptSync(normRecoveryKey(key), salt, expected.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(h, expected);
  } catch (e) {
    return false;
  }
}

// Device token: random 256-bit, stored as sha256 hash (token itself is high-entropy)
function genDeviceToken() { return crypto.randomBytes(32).toString('base64url'); }
function hashDeviceToken(tok) { return crypto.createHash('sha256').update(String(tok)).digest('base64'); }

module.exports = { genPlayerId, genRecoveryKey, normRecoveryKey, hashRecoveryKey, verifyRecoveryKey, genDeviceToken, hashDeviceToken };
