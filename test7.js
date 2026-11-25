// v4.5 test: treasure drop on expose, 3s re-pick lock, 10s relocate, round continues.
const PORT = process.env.PORT || 8791;
const url = `ws://localhost:${PORT}`;
const results = [];
function check(name, ok, extra) { results.push({name, ok}); console.log((ok?'PASS':'FAIL')+' | '+name+(extra?' | '+extra:'')); }
const wait = ms => new Promise(r => setTimeout(r, ms));
function until(fn, timeout, label) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const v = fn();
      if (v) { clearInterval(iv); res(v); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error('timeout: ' + label)); }
    }, 80);
  });
}
function connect(name, room) {
  const ws = new WebSocket(url);
  const c = { ws, name, msgs: [], id: null, room: room || '', map: null };
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name, room: c.room }));
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    c.msgs.push(m);
    if (m.t === 'joined') { c.id = m.id; c.room = m.room; c.map = m.map; }
    if (m.t === 'begin') c.map = m.map;
  };
  return c;
}
function lastState(c) { return c.msgs.filter(m => m.t === 'state').pop(); }
function meOf(c) { const s = lastState(c); return s && s.players.find(p => p.id === c.id); }
const CELL = 40;
function gridFor(map) {
  const W = Math.ceil(map.w / CELL), H = Math.ceil(map.h / CELL);
  const blocked = new Uint8Array(W * H);
  const PAD = 22;
  for (const w of map.walls) {
    const x0 = Math.floor((w.x - PAD) / CELL), x1 = Math.floor((w.x + w.w + PAD) / CELL);
    const y0 = Math.floor((w.y - PAD) / CELL), y1 = Math.floor((w.y + w.h + PAD) / CELL);
    for (let gy = Math.max(0, y0); gy <= Math.min(H - 1, y1); gy++)
      for (let gx = Math.max(0, x0); gx <= Math.min(W - 1, x1); gx++) blocked[gy * W + gx] = 1;
  }
  return { W, H, blocked };
}
function bfsPath(map, sx, sy, tx, ty) {
  const { W, H, blocked } = bfsPath.g || (bfsPath.g = gridFor(map));
  const cs = Math.min(H - 1, Math.max(0, Math.floor(sy / CELL))) * W + Math.min(W - 1, Math.max(0, Math.floor(sx / CELL)));
  const ct = Math.min(H - 1, Math.max(0, Math.floor(ty / CELL))) * W + Math.min(W - 1, Math.max(0, Math.floor(tx / CELL)));
  const prev = new Int32Array(W * H).fill(-1);
  const q = [cs]; prev[cs] = cs;
  while (q.length) {
    const cur = q.shift();
    if (cur === ct) break;
    const cx = cur % W, cy = (cur / W) | 0;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const nc = ny * W + nx;
      if (blocked[nc] && nc !== ct) continue;
      if (prev[nc] === -1) { prev[nc] = cur; q.push(nc); }
    }
  }
  if (prev[ct] === -1) return null;
  const cells = [];
  for (let c = ct; c !== cs; c = prev[c]) cells.push(c);
  cells.reverse();
  return cells.map(c => ({ x: (c % W) * CELL + CELL / 2, y: ((c / W) | 0) * CELL + CELL / 2 }));
}
async function moveTo(c, x, y, tol) {
  tol = tol || 25;
  const t0 = Date.now();
  let path = null, pi = 0;
  while (Date.now() - t0 < 40000) {
    const me = meOf(c);
    if (!me) { await wait(150); continue; }
    if (!path) {
      path = bfsPath(c.map, me.x, me.y, x, y) || [{ x, y }];
      path.push({ x, y });
      pi = 0;
    }
    const wp = path[pi];
    const dx = wp.x - me.x, dy = wp.y - me.y;
    const near = pi === path.length - 1 ? tol : 30;
    if (Math.hypot(dx, dy) < near) {
      pi++;
      if (pi >= path.length) { c.ws.send(JSON.stringify({ t: 'input', dx: 0, dy: 0 })); return true; }
      continue;
    }
    const d = Math.hypot(dx, dy);
    c.ws.send(JSON.stringify({ t: 'input', dx: dx / d, dy: dy / d }));
    await wait(120);
  }
  return false;
}
(async () => {
  const A = connect('احمد');
  await until(() => A.id, 5000, 'A joined');
  const B = connect('بكري', A.room);
  await until(() => B.id, 5000, 'B joined');
  const C = connect('سيد', A.room);
  await until(() => C.id, 5000, 'C joined');
  A.ws.send(JSON.stringify({ t: 'start' }));
  await until(() => A.msgs.find(m => m.t === 'begin'), 5000, 'begin');
  check('round began', true);
  // A finds the treasure at forced spot 0
  const spot = A.map.spots[0];
  await moveTo(A, spot.x, spot.y, 40);
  A.ws.send(JSON.stringify({ t: 'search' }));
  await until(() => A.msgs.find(m => m.t === 'secret' && m.carrier), 8000, 'A carrier');
  check('A is carrier', true);
  // B walks to A and exposes -> drop, round continues
  const aPos = meOf(A);
  await moveTo(B, aPos.x + 90, aPos.y, 30);
  B.ws.send(JSON.stringify({ t: 'expose' }));
  const ev = await until(() => B.msgs.find(m => m.t === 'event' && m.kind === 'dropped'), 5000, 'dropped event');
  check('expose drops the treasure', ev.on === 'احمد');
  check('round did NOT end on expose', !B.msgs.find(m => m.t === 'end'));
  const dropState = await until(() => { const s = lastState(B); return s && s.drop ? s : null; }, 4000, 'drop in state');
  check('drop visible in state', !!dropState.drop, JSON.stringify(dropState.drop));
  // A lost carrier status
  check('A got secret:false', !!A.msgs.find(m => m.t === 'secret' && m.carrier === false));
  // B steps away so it does not pick the drop
  await moveTo(B, aPos.x + 220, aPos.y, 60);
  // A walks onto the drop immediately: locked for 3s
  await moveTo(A, dropState.drop.x, dropState.drop.y, 15);
  await wait(1200);
  const earlyPick = A.msgs.find(m => m.t === 'event' && m.kind === 'picked');
  check('ex-carrier locked out at ~1.2s', !earlyPick);
  const pickA = await until(() => A.msgs.find(m => m.t === 'event' && m.kind === 'picked'), 6000, 'A re-picks after lock');
  check('ex-carrier re-picks after 3s', true);
  check('A is carrier again', !!A.msgs.filter(m => m.t === 'secret').pop().carrier);
  // second drop -> nobody claims -> relocates after 10s
  const a2 = meOf(A);
  await moveTo(B, a2.x + 90, a2.y, 30);
  B.ws.send(JSON.stringify({ t: 'expose' }));
  await until(() => B.msgs.filter(m => m.t === 'event' && m.kind === 'dropped').length >= 2, 5000, 'second drop');
  const d2 = lastState(B).drop || (await until(() => { const s = lastState(B); return s && s.drop ? s : null; }, 3000, 'drop2 state')).drop;
  // while the treasure is on the ground, exposing a non-carrier: soft toast, no freeze
  B.ws.send(JSON.stringify({ t: 'expose' }));
  const soft = await until(() => B.msgs.find(m => m.t === 'toast'), 4000, 'soft toast');
  check('expose while treasure is down: feedback, no freeze', !!soft && !B.msgs.find(m => m.t === 'frozen'));
  // nobody claims it -> relocates after ~10s
  await moveTo(A, d2.x + 260, d2.y, 60);
  await moveTo(B, d2.x + 350, d2.y, 60);
  const moved = await until(() => B.msgs.filter(m => m.t === 'event' && m.kind === 'treasure_moved').length >= 1, 14000, 'relocate after 10s');
  check('unclaimed drop relocates after ~10s', !!moved);
  const sAfter = await until(() => { const s = lastState(B); return s && !s.drop ? s : null; }, 3000, 'drop cleared');
  check('drop cleared from state', !sAfter.drop);
  check('still no round end', !B.msgs.find(m => m.t === 'end'));
  const failed = results.filter(r => !r.ok);
  console.log(failed.length ? 'FAILURES: ' + failed.map(f => f.name).join(', ') : 'ALL TESTS PASSED');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.log('TEST ERROR: ' + e.message); process.exit(1); });
