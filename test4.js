// v2 mechanics: carrier ghost invisibility + goggles counter.
// Env: FORCE_SPOT=0 MOVE_SECONDS=999 ROUND_SECONDS=120 POWERUP_SECONDS=3 FORCE_POWER=goggles
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
  const c = { ws, name, id: null, room: room || '', msgs: [], carrier: false, map: null };
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name, room }));
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    c.msgs.push(m);
    if (m.t === 'joined') { c.id = m.id; c.room = m.room; c.map = m.map; }
    if (m.t === 'begin') c.map = m.map;
    if (m.t === 'secret' && m.carrier) c.carrier = true;
    if (m.t === 'state') { const me = m.players.find(p => p.id === c.id); if (me) { c.x = me.x; c.y = me.y; } c.lastState = m; }
  };
  return c;
}
async function goto(c, tx, ty, r, timeoutMs) {
  const t0 = Date.now();
  let phase = 0;
  return await new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      if (Date.now() - t0 > (timeoutMs || 25000)) { clearInterval(iv); c.ws.send(JSON.stringify({ t: 'input', dx: 0, dy: 0 })); return reject(new Error('goto timeout')); }
      if (c.x === undefined) return;
      if (Math.hypot(tx - c.x, ty - c.y) < r) { clearInterval(iv); c.ws.send(JSON.stringify({ t: 'input', dx: 0, dy: 0 })); return resolve(true); }
      if (c._lp && Math.hypot(c.x - c._lp.x, c.y - c._lp.y) < 0.6) c._st = (c._st || 0) + 1; else c._st = 0;
      c._lp = { x: c.x, y: c.y };
      if (c._st > 4) { phase = 1 - phase; c._st = 0; }
      let dx = 0, dy = 0;
      if (phase === 0) {
        if (Math.abs(ty - c.y) > 12) dy = Math.sign(ty - c.y);
        else dx = Math.sign(tx - c.x);
      } else {
        if (Math.abs(tx - c.x) > 12) dx = Math.sign(tx - c.x);
        else dy = Math.sign(ty - c.y);
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
  A.ws.send(JSON.stringify({ t: 'start' }));
  await until(() => A.msgs.some(m => m.t === 'begin'), 3000, 'begin');

  const spot0 = A.map.spots[0];
  // A parks next to the treasure spot but does not search yet
  const parked = goto(A, spot0.x, spot0.y, 42);
  // B walks to the forced goggles power-up at the spawn center
  goto(B, 710, 450, 12, 20000).catch(() => { });
  await until(() => B.msgs.some(m => m.t === 'power' && m.type === 'goggles'), 25000, 'goggles pickup');
  check('goggles power-up pickup works', true);
  await parked;

  // now A searches and becomes carrier while B's goggles are still active
  A.ws.send(JSON.stringify({ t: 'search' }));
  await until(() => A.carrier, 15000, 'A carrier');
  check('A becomes carrier', true);
  check('me.ghostLeft available for carrier', (A.lastState.me || {}).ghostLeft === 1);

  // non-carrier ghost button ignored
  C.ws.send(JSON.stringify({ t: 'ghost' }));
  await wait(400);
  check('non-carrier ghost ignored', !C.msgs.some(m => m.t === 'ghost'));

  A.ws.send(JSON.stringify({ t: 'ghost' }));
  await until(() => A.msgs.some(m => m.t === 'ghost'), 3000, 'ghost ack');
  check('carrier gets ghost confirmation', true);

  // C (no goggles): A hidden at -500
  await until(() => {
    const s = C.lastState;
    if (!s) return false;
    const pa = s.players.find(p => p.id === A.id);
    return pa && pa.x === -500;
  }, 2000, 'A hidden from C');
  check('ghosted carrier hidden from players without goggles', true);

  // B (goggles active): still sees A with g flag
  const sb = B.lastState;
  const pab = sb && sb.players.find(p => p.id === A.id);
  check('goggles wearer still sees ghosted carrier', !!pab && pab.x > 0 && pab.g === 1, pab ? 'x=' + pab.x + ' g=' + pab.g : 'no state');

  // A still sees itself
  check('ghosted carrier still sees self', A.x > 0);

  // after ~2.5s visible to C again
  await until(() => {
    const s = C.lastState;
    if (!s) return false;
    const pa = s.players.find(p => p.id === A.id);
    return pa && pa.x > 0;
  }, 6000, 'A visible again');
  check('ghost expires, carrier visible again', true);

  // ghost button is once per round
  A.ws.send(JSON.stringify({ t: 'ghost' }));
  await wait(400);
  check('second ghost refused', A.msgs.filter(m => m.t === 'ghost').length === 1);

  const fails = results.filter(r => !r).length;
  console.log(fails === 0 ? 'ALL TESTS PASSED' : fails + ' TESTS FAILED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
