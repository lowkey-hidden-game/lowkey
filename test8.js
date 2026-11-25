// v4.5 test 2: chase-drop, reconnect carrying/dropped, race to grab.
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
    if (m.t === 'joined') { c.id = m.id; c.room = m.room; c.map = m.map; c.tok = m.tok; }
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
  const spot = A.map.spots[0];
  await moveTo(A, spot.x, spot.y, 40);
  A.ws.send(JSON.stringify({ t: 'search' }));
  await until(() => A.msgs.find(m => m.t === 'secret' && m.carrier), 8000, 'A carrier');
  check('A is carrier', true);

  // --- scenario 2a: reconnect while CARRYING keeps the treasure ---
  const aSess = { room: A.room, id: A.id, tok: A.tok };
  A.ws.close();
  await wait(1200);
  const A2 = connect('احمد', A.room);
  A2.ws.onopen = () => A2.ws.send(JSON.stringify({ t: 'hello', name: 'احمد', room: aSess.room, rejoin: aSess }));
  await until(() => A2.id, 5000, 'A rejoined');
  check('rejoin same id while carrying', A2.id === aSess.id);
  const reSecret = await until(() => A2.msgs.find(m => m.t === 'secret' && m.carrier), 4000, 'secret after rejoin');
  check('treasure kept through reconnect', !!reSecret);
  A.ws = A2.ws; A.msgs = A2.msgs; A.id = A2.id; A.tok = A2.tok;

  // --- scenario 1: drop mid-chase, chaser grabs ---
  const chaseIv = setInterval(() => { // A keeps fleeing
    const me = meOf(A);
    if (me) {
      const dx = me.x < 600 ? 1 : -1;
      A.ws.send(JSON.stringify({ t: 'input', dx, dy: 0 }));
    }
  }, 150);
  const t0 = Date.now();
  let exposed = false;
  while (Date.now() - t0 < 20000) { // B chases A live and exposes the moment it is in range
    const meB = meOf(B), meA = meOf(A);
    if (meB && meA) {
      const dx = meA.x - meB.x, dy = meA.y - meB.y, d = Math.hypot(dx, dy);
      if (d < 95) {
        B.ws.send(JSON.stringify({ t: 'input', dx: 0, dy: 0 }));
        B.ws.send(JSON.stringify({ t: 'expose' }));
        exposed = true;
        break;
      }
      B.ws.send(JSON.stringify({ t: 'input', dx: dx / d, dy: dy / d }));
    }
    await wait(120);
  }
  if (!exposed) throw new Error('B never caught A');
  await until(() => B.msgs.find(m => m.t === 'event' && m.kind === 'dropped'), 5000, 'chase drop');
  clearInterval(chaseIv);
  A.ws.send(JSON.stringify({ t: 'input', dx: 0, dy: 0 }));
  const st1 = await until(() => { const s = lastState(B); return s && s.drop ? s : null; }, 3000, 'chase drop state');
  const aNow = st1.players.find(p => p.id === A.id);
  const chaseDist = Math.hypot(st1.drop.x - aNow.x, st1.drop.y - aNow.y);
  check('drop lands at carrier position mid-chase', chaseDist < 90, 'dist=' + Math.round(chaseDist));
  check('round continues after chase drop', !B.msgs.find(m => m.t === 'end'));
  await moveTo(B, st1.drop.x, st1.drop.y, 15);
  const pickB = await until(() => B.msgs.find(m => m.t === 'event' && m.kind === 'picked'), 8000, 'B grabs mid-chase');
  check('chaser (not the dropper) can grab instantly', true);
  check('B is the new carrier', !!(B.msgs.filter(m => m.t === 'secret').pop() || {}).carrier);

  // --- scenario 2b+3: reconnect sees the drop + race, exactly one winner ---
  const bPos = meOf(B);
  await moveTo(A, bPos.x + 90, bPos.y, 30);
  await moveTo(C, bPos.x - 160, bPos.y, 30);
  A.ws.send(JSON.stringify({ t: 'expose' }));
  await until(() => A.msgs.find(m => m.t === 'event' && m.kind === 'dropped'), 5000, 'second drop');
  const st2 = await until(() => { const s = lastState(A); return s && s.drop ? s : null; }, 3000, 'drop2 state');
  // B (locked 3s) walks away so it cannot re-grab
  moveTo(B, st2.drop.x + 320, st2.drop.y, 60);
  // C drops its connection mid-drop and rejoins: the drop must still be visible
  const cSess = { room: C.room, id: C.id, tok: C.tok };
  C.ws.close();
  await wait(1000);
  const C2 = connect('سيد', C.room);
  C2.ws.onopen = () => C2.ws.send(JSON.stringify({ t: 'hello', name: 'سيد', room: cSess.room, rejoin: cSess }));
  await until(() => C2.id, 5000, 'C rejoined');
  const cState = await until(() => { const s = lastState(C2); return s ? s : null; }, 4000, 'C state after rejoin');
  check('rejoining player sees the live drop', !!cState.drop, JSON.stringify(cState.drop));
  C.ws = C2.ws; C.msgs = C2.msgs; C.id = C2.id;
  // race: A and C sprint for it
  const picksBefore = A.msgs.filter(m => m.t === 'event' && m.kind === 'picked').length;
  const raceA = moveTo(A, st2.drop.x, st2.drop.y, 12);
  const raceC = moveTo(C, st2.drop.x, st2.drop.y, 12);
  await Promise.race([raceA, raceC]);
  await until(() => {
    const n = A.msgs.filter(m => m.t === 'event' && m.kind === 'picked').length - picksBefore;
    return n >= 1 ? n : null;
  }, 8000, 'one pick');
  await wait(600);
  const newPicks = A.msgs.filter(m => m.t === 'event' && m.kind === 'picked').length - picksBefore;
  check('exactly one player grabbed the drop', newPicks === 1, 'newPicks=' + newPicks);
  const sEnd = lastState(A);
  const carriers = [A, C].map(c => (c.msgs.filter(m => m.t === 'secret').pop() || {}).carrier === true).filter(Boolean).length;
  check('exactly one carrier after the race', carriers === 1, 'carriers=' + carriers);
  check('round still alive after all of it', !A.msgs.find(m => m.t === 'end'));
  const failed = results.filter(r => !r.ok);
  console.log(failed.length ? 'FAILURES: ' + failed.map(f => f.name).join(', ') : 'ALL TESTS PASSED');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.log('TEST ERROR: ' + e.message); process.exit(1); });
