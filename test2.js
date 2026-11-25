// Deterministic mechanic tests: carrier secret, correct expose, wrong expose,
// empty search, carrier_left. Requires FORCE_SPOT=0 on the server.
const PORT = process.env.PORT || 8791;
const url = `ws://localhost:${PORT}`;
const results = [];
const check = (n, ok, x) => { results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + ' | ' + n + (x ? ' | ' + x : '')); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = fn(); if (v) return v; await wait(80); }
  throw new Error('timeout: ' + label);
}

function connect(name, room) {
  const ws = new WebSocket(url);
  const c = { ws, name, id: null, room: room || '', msgs: [], carrier: false, map: null, end: null, frozen: false };
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name, room }));
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    c.msgs.push(m);
    if (m.t === 'joined') { c.id = m.id; c.room = m.room; c.map = m.map; }
    if (m.t === 'begin') { c.map = m.map; c.end = null; }
    if (m.t === 'secret' && m.carrier) c.carrier = true;
    if (m.t === 'end') c.end = m;
    if (m.t === 'state') {
      const me = m.players.find(p => p.id === c.id);
      if (me) { c.x = me.x; c.y = me.y; c.frozen = !!me.f; }
    }
  };
  return c;
}

// axis-aligned navigation: move vertically to ty, then horizontally to tx.
// If stuck, swap axis order. Resolves when within r of target.
async function goto(c, tx, ty, r, timeoutMs) {
  const t0 = Date.now();
  let phase = 0; // 0: y first, 1: x
  return await new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      if (Date.now() - t0 > (timeoutMs || 25000)) { clearInterval(iv); c.ws.send(JSON.stringify({ t: 'input', dx: 0, dy: 0 })); return reject(new Error('goto timeout')); }
      if (c.x === undefined) return;
      const dFull = Math.hypot(tx - c.x, ty - c.y);
      if (dFull < r) { clearInterval(iv); c.ws.send(JSON.stringify({ t: 'input', dx: 0, dy: 0 })); return resolve(true); }
      if (c._lp && Math.hypot(c.x - c._lp.x, c.y - c._lp.y) < 0.6) { c._st = (c._st || 0) + 1; } else c._st = 0;
      c._lp = { x: c.x, y: c.y };
      if (c._st > 4) { phase = 1 - phase; c._st = 0; }
      let dx = 0, dy = 0;
      if (phase === 0) {
        if (Math.abs(ty - c.y) > 12) dy = Math.sign(ty - c.y);
        else if (Math.abs(tx - c.x) > 12) dx = Math.sign(tx - c.x);
        else dy = Math.sign(ty - c.y);
      } else {
        if (Math.abs(tx - c.x) > 12) dx = Math.sign(tx - c.x);
        else if (Math.abs(ty - c.y) > 12) dy = Math.sign(ty - c.y);
        else dx = Math.sign(tx - c.x);
      }
      c.ws.send(JSON.stringify({ t: 'input', dx, dy }));
    }, 120);
  });
}

(async () => {
  const A = connect('احمد', '');
  await until(() => A.id, 3000, 'A joined');
  const B = connect('بي', A.room);
  const C = connect('سي', A.room);
  await until(() => B.id && C.id, 3000, 'B,C joined');

  // ---------- Round 1: A finds forced spot 0, B exposes A ----------
  A.ws.send(JSON.stringify({ t: 'start' }));
  await until(() => A.msgs.some(m => m.t === 'begin'), 3000, 'begin r1');

  const spot0 = A.map.spots[0];
  goto(A, spot0.x, spot0.y, 45).then(async () => {
    await wait(200);
    A.ws.send(JSON.stringify({ t: 'search' }));
  }).catch(e => console.log('A goto err', e.message));

  await until(() => A.carrier, 30000, 'A becomes carrier');
  check('finder gets secret carrier flag', A.carrier);
  check('non-finders get no secret', !B.carrier && !C.carrier);

  // B walks to A and exposes -> correct expose wins
  goto(B, A.x, A.y, 90).then(() => {
    B.ws.send(JSON.stringify({ t: 'expose' }));
  }).catch(e => console.log('B goto err', e.message));

  const end1 = await until(() => A.end, 40000, 'end r1');
  check('correct expose ends round', end1.reason === 'exposed', 'reason=' + end1.reason);
  check('exposer wins', end1.winnerId === B.id && end1.carrierId === A.id);

  // back to lobby
  const n1 = A.msgs.length;
  await until(() => A.msgs.slice(n1).some(m => m.t === 'lobby'), 15000, 'lobby after r1');

  // ---------- Round 2: empty search, wrong expose, carrier_left ----------
  A.carrier = false; A.end = null; B.end = null; C.end = null;
  A.ws.send(JSON.stringify({ t: 'start' }));
  await until(() => A.msgs.filter(m => m.t === 'begin').length >= 2, 4000, 'begin r2');

  const spot1 = A.map.spots[1];
  goto(A, spot1.x, spot1.y, 45).then(async () => {
    await wait(200);
    A.ws.send(JSON.stringify({ t: 'search' }));
  }).catch(() => { });
  await until(() => A.msgs.some(m => m.t === 'empty'), 30000, 'empty feedback');
  check('searching empty spot reports empty', true);

  goto(C, spot0.x, spot0.y, 45).then(async () => {
    await wait(200);
    C.ws.send(JSON.stringify({ t: 'search' }));
  }).catch(() => { });
  await until(() => C.carrier, 30000, 'C carrier r2');
  check('C finds forced treasure in round 2', true);

  // B (still near spawn) exposes nearest non-carrier... B is far from C; move B to A? A may be frozen? no, A did nothing wrong.
  // B exposes A (not carrier) -> wrong_expose
  goto(B, A.x, A.y, 90).then(() => {
    B.ws.send(JSON.stringify({ t: 'expose' }));
  }).catch(() => { });
  await until(() => A.msgs.some(m => m.t === 'event' && m.kind === 'wrong_expose'), 40000, 'wrong expose');
  check('wrong expose event broadcast', true);
  await until(() => B.frozen, 3000, 'B frozen');
  check('wrong exposer gets frozen', true);

  // C (carrier) disconnects -> carrier_left
  C.ws.close();
  const end2 = await until(() => A.end, 15000, 'end r2');
  check('carrier leaving ends round with carrier_left', end2.reason === 'carrier_left', 'reason=' + end2.reason);
  check('no winner on carrier_left', end2.winnerId === null);

  const fails = results.filter(r => !r).length;
  console.log(fails === 0 ? 'ALL TESTS PASSED' : fails + ' TESTS FAILED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
