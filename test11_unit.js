// Unit tests for crypto_utils.js - pure functions, no server needed.
const C = require('./crypto_utils');
let pass = 0, fail = 0;
function check(name, ok, extra) { ok ? pass++ : fail++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : '')); }

// Player ID shape and uniqueness
const id1 = C.genPlayerId(), id2 = C.genPlayerId();
check('player id shape LK-XXXX-XXXX', /^LK-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(id1), id1);
check('player ids unique', id1 !== id2);

// Recovery key shape: 8 groups of 4, base32 without ambiguous chars
const k1 = C.genRecoveryKey();
check('recovery key 8x4 groups', /^([A-Z2-9]{4}-){7}[A-Z2-9]{4}$/.test(k1), k1);
check('recovery key no ambiguous chars (0,O,1,I)', !/[01OI]/.test(k1.replace(/-/g, '')));

// Hash + verify round trip
const h = C.hashRecoveryKey(k1);
check('hash format scrypt$N$r$p$salt$hash', /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(h));
check('verify accepts the exact key', C.verifyRecoveryKey(k1, h));
check('verify accepts normalized variants (lowercase, no dashes)', C.verifyRecoveryKey(k1.toLowerCase().replace(/-/g, ''), h));
check('verify accepts spaced variant', C.verifyRecoveryKey(k1.split('-').join(' '), h));
const k2 = C.genRecoveryKey();
check('verify rejects a different key', !C.verifyRecoveryKey(k2, h));
check('verify rejects garbage input', !C.verifyRecoveryKey('AAAA', h) && !C.verifyRecoveryKey('', h) && !C.verifyRecoveryKey(null, h));
check('verify rejects a tampered stored hash', !C.verifyRecoveryKey(k1, h.replace(/.$/, h.endsWith('A') ? 'B' : 'A')));
check('two hashes of the same key differ (random salt)', C.hashRecoveryKey(k1) !== C.hashRecoveryKey(k1));

// Device tokens
const t1 = C.genDeviceToken();
check('device token 256-bit base64url', /^[A-Za-z0-9_-]{43}$/.test(t1));
check('device token hash deterministic', C.hashDeviceToken(t1) === C.hashDeviceToken(t1));
check('device token hash differs per token', C.hashDeviceToken(t1) !== C.hashDeviceToken(C.genDeviceToken()));

console.log(fail ? 'FAILURES: ' + fail : 'ALL ' + pass + ' UNIT TESTS PASSED');
process.exit(fail ? 1 : 0);
