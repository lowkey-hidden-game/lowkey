// v2 mechanics: invisibility power-up (anyone can pick it up and vanish).
// Env: FORCE_SPOT=0 MOVE_SECONDS=999 ROUND_SECONDS=120 POWERUP_SECONDS=3 FORCE_POWER=ghost
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
    if (m.t === 'lobby') c.lobby = m;
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
  await until(() => B.id, 3000, 'B joined');
  A.ws.send(JSON.stringify({ t: 'addbot' }));
  await until(() => A.lobby && (A.lobby.players || []).length >= 3, 3000, 'bot added');

  // avatar picking in lobby
  A.ws.send(JSON.stringify({ t: 'avatar', a: 3 }));
  await until(() => A.lobby && (A.lobby.players.find(p => p.id === A.id) || {}).avatar === 3, 3000, 'avatar change');
  check('avatar change in lobby works', true);
  const botAvatar = (A.lobby.players.find(p => p.bot) || {}).avatar;
  check('bot has an avatar', botAvatar !== undefined && botAvatar >= 0);
  A.ws.send(JSON.stringify({ t: 'start' }));
  await until(() => A.msgs.some(m => m.t === 'begin'), 3000, 'begin');
  check('avatar present in game state', (A.lastState.players.find(p => p.id === A.id) || {}).a === 3);

  // A grabs the forced ghost power-up at spawn center
  goto(A, 710, 450, 12, 20000).catch(() => { });
  await until(() => A.msgs.some(m => m.t === 'power' && m.type === 'ghost'), 25000, 'ghost pickup');
  check('invisibility power-up pickup works (non-carrier)', true);
  check('me.ghost active for picker', (A.lastState.me || {}).ghost === 1);

  // B sees A hidden while powerup ghost active
  await until(() => {
    const s = B.lastState;
    if (!s) return false;
    const pa = s.players.find(p => p.id === A.id);
    return pa && pa.x === -500;
  }, 2000, 'A hidden from B');
  check('invisible player hidden from others', true);

  await until(() => {
    const s = B.lastState;
    if (!s) return false;
    const pa = s.players.find(p => p.id === A.id);
    return pa && pa.x > 0;
  }, 17000, 'A visible again');
  check('invisibility expires', true);

  const fails = results.filter(r => !r).length;
  console.log(fails === 0 ? 'ALL TESTS PASSED' : fails + ' TESTS FAILED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
