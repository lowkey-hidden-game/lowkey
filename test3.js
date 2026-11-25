// v2 mechanics: treasure relocation, power-up pickup, shield block, building.
// Env: FORCE_SPOT=0 MOVE_SECONDS=6 POWERUP_SECONDS=3 WALL_SECONDS=6 FORCE_POWER=shield
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
  const c = { ws, name, id: null, room: room || '', msgs: [], carrier: false, map: null, end: null };
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name, room }));
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    c.msgs.push(m);
    if (m.t === 'joined') { c.id = m.id; c.room = m.room; c.map = m.map; }
    if (m.t === 'begin') { c.map = m.map; c.end = null; }
    if (m.t === 'secret' && m.carrier) c.carrier = true;
    if (m.t === 'end') c.end = m;
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

  // 1. treasure relocates while unfound
  await until(() => A.msgs.some(m => m.t === 'event' && m.kind === 'treasure_moved'), 12000, 'treasure moved');
  check('treasure relocates while unfound', true);

  // 2. forced power-up (shield) spawns at spawn center; A picks it up
  await goto(A, 710, 450, 12, 20000);
  await until(() => A.msgs.some(m => m.t === 'power' && m.type === 'shield'), 15000, 'shield pickup');
  check('power-up pickup grants shield', true);
  check('state.me reflects shield', (A.lastState.me || {}).shield === 1);

  // 3. shield blocks expose (no freeze for exposer)
  goto(B, A.x, A.y, 90).then(() => B.ws.send(JSON.stringify({ t: 'expose' }))).catch(() => { });
  await until(() => A.msgs.some(m => m.t === 'event' && m.kind === 'shielded'), 30000, 'shielded event');
  check('shield blocks expose with shielded event', true);
  const bFrozen = B.msgs.some(m => m.t === 'event' && m.kind === 'wrong_expose');
  check('shielded exposer not punished as wrong', !bFrozen);

  // 4. building: A builds a wall, it appears in state and expires
  A.ws.send(JSON.stringify({ t: 'build' }));
  await until(() => (A.lastState.walls || []).length === 1, 5000, 'wall appears');
  check('build places a dynamic wall', true);
  check('me.walls decremented', (A.lastState.me || {}).walls === 2);
  await until(() => (A.lastState.walls || []).length === 0, 12000, 'wall expires');
  check('wall expires after WALL_SECONDS', true);

  const fails = results.filter(r => !r).length;
  console.log(fails === 0 ? 'ALL TESTS PASSED' : fails + ' TESTS FAILED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
