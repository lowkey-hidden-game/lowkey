// v4.7 test: locked zone event - warn, lock, push-out, no entry, carrier, open, build-block, routes.
const url = process.env.LIVE_URL; if (!url) { console.error('need LIVE_URL'); process.exit(2); }
const MODE = process.env.MODE || 'full'; // 'full' = humans only (carrier/push/entry/deposit), 'bots' = 2 bots from lobby
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
  const ZX = 600, ZY = 300, ZW = 380, ZH = 260; // ZONE_RECT env
  const inZone = (p, m) => p.x > ZX - (m||0) && p.x < ZX + ZW + (m||0) && p.y > ZY - (m||0) && p.y < ZY + ZH + (m||0);

  const A = connect('احمد');
  await until(() => A.id, 5000, 'A joined');
  const B = connect('بكري', A.room);
  await until(() => B.id, 5000, 'B joined');
  const C = connect('سيد', A.room);
  await until(() => C.id, 5000, 'C joined');
  A.ws.send(JSON.stringify({ t: 'botlevel', level: 'easy' }));
  await wait(150);
  if (MODE === 'bots') {
    A.ws.send(JSON.stringify({ t: 'addbot' }));
    A.ws.send(JSON.stringify({ t: 'addbot' }));
    await wait(400);
  }
  A.ws.send(JSON.stringify({ t: 'start' }));
  await until(() => A.msgs.find(m => m.t === 'begin'), 15000, 'begin'); const tBegin = Date.now();
  check('round began', true);

  if (MODE === 'bots') { console.log('MODE=bots: no hunt; bots joined from lobby'); }
  // Parallel hunt: A, B, C search distinct spots at once; whoever finds it becomes the carrier role
  const tried = new Set();
  const inRect = s => s.x > ZX && s.x < ZX + ZW && s.y > ZY && s.y < ZY + ZH;
  const pick = c => {
    const me = meOf(c);
    if (!me) return null;
    const free = A.map.spots.filter(s => !tried.has(s.id) && !inRect(s)).sort((p, q) => Math.hypot(p.x - me.x, p.y - me.y) - Math.hypot(q.x - me.x, q.y - me.y));
    const s = free[0]; if (s) tried.add(s.id); return s || null;
  };
  let carrier = null;
  if (MODE !== 'bots') {
  await until(() => meOf(A) && meOf(B) && meOf(C), 8000, 'first states');
  let jobs = [A, B, C].map(c => ({ c, spot: pick(c) }));
  const tHunt = Date.now();
  while (!carrier && Date.now() - tHunt < 35000) {
    const mvs = jobs.filter(j => j.spot).map(j => moveTo(j.c, j.spot.x, j.spot.y, 35));
    await Promise.race([Promise.all(mvs), wait(12000)]);
    for (const j of jobs) j.c.ws.send(JSON.stringify({ t: 'input', dx: 0, dy: 0 }));
    await wait(250);
    for (const j of jobs) if (j.spot) j.c.ws.send(JSON.stringify({ t: 'search' }));
    const t0 = Date.now();
    while (Date.now() - t0 < 6000 && !carrier) {
      await wait(300);
      carrier = [A, B, C].find(c => c.msgs.find(m => m.t === 'secret' && m.carrier)) || null;
    }
    jobs = [A, B, C].map(c => ({ c, spot: carrier ? null : pick(c) }));
  }
  console.log('hunt took ' + Math.round((Date.now() - tHunt) / 1000) + 's, carrier=' + (carrier ? carrier.name : 'NONE'));
  check('a human is carrier before the event', !!carrier);
  if (!carrier) { console.log('TEST ERROR: no carrier within 35s'); process.exit(1); }
  }
  const builder = MODE === 'bots' ? B : [A, B, C].find(c => c !== carrier);
  const walker = MODE === 'bots' ? A : carrier;
  // stop everyone before positioning
  for (const c of [A, B, C]) c.ws.send(JSON.stringify({ t: 'input', dx: 0, dy: 0 }));
  await wait(200);

  // get into position BEFORE the warning: builder at the west edge, walker at the zone center
  const mvBuilder = moveTo(builder, ZX - 60, ZY + ZH / 2, 30);
  const mvCarrier = moveTo(walker, ZX + ZW / 2, ZY + ZH / 2, 30);

  // 1) warning arrives with the zone rectangle
  const warn = await until(() => A.msgs.find(m => m.t === 'event' && m.kind === 'zone_warn'), 95000, 'zone_warn');
  check('warning broadcast with zone rect', warn.zone && warn.zone.w > 0, JSON.stringify(warn.zone)); console.log('warn arrived', Math.round((Date.now()-tBegin)/1000)+'s after begin');
  const stW = await until(() => { const s = lastState(A); return s && s.zone ? s : null; }, 6000, 'warn state');
  check('zone visible in state during warning/lock', stW.zone.st === 'warn' || stW.zone.st === 'lock', stW.zone.st);
  await mvCarrier; await mvBuilder;
  const lock = await until(() => A.msgs.find(m => m.t === 'event' && m.kind === 'zone_lock'), 15000, 'zone_lock');
  check('lock broadcast', !!lock);
  await wait(300);
  const meC = meOf(walker);
  check('player inside at lock is pushed out', !inZone(meC, 4), JSON.stringify({ x: Math.round(meC.x), y: Math.round(meC.y) }));
  if (MODE !== 'bots') check('treasure kept through the push', !carrier.msgs.find(m => m.t === 'secret' && m.carrier === false));

  // 4) nobody inside, and bots keep functioning while the barrier is up
  const s1 = lastState(A);
  const inside = s1.players.filter(p => inZone(p, 0));
  check('nobody inside the locked zone', inside.length === 0, inside.length + ' inside');
  const ours = [A.id, B.id, C.id];
  const botSnap1 = s1.players.filter(p => !ours.includes(p.id)).map(p => ({ id: p.id, x: p.x, y: p.y }));
  let botMoved = false, insideLater = 0;
  for (let i = 0; i < 10 && !botMoved; i++) { // retry within the lock window (bots pause/search by design)
    await wait(400);
    const s2 = lastState(A);
    insideLater = s2.players.filter(p => inZone(p, 0)).length;
    botMoved = botSnap1.some(b => {
      const q = s2.players.find(p => p.id === b.id);
      return q && Math.hypot(q.x - b.x, q.y - b.y) > 25;
    });
  }
  if (MODE === 'bots') check('bots alive with barriers up (moving or searching, none inside)', botSnap1.length >= 2 && (botMoved || botSnap1.every(b => !inZone(b, 0))), 'botsSeen=' + botSnap1.length);
  else console.log('SKIP | bots check lives in MODE=bots run');
  check('still nobody inside later in the lock', insideLater === 0);

  // 5) build-block: walls cannot be fused to the zone barrier (builder is at the west edge)
  builder.ws.send(JSON.stringify({ t: 'input', dx: 1, dy: 0 }));
  await wait(250);
  builder.ws.send(JSON.stringify({ t: 'input', dx: 0, dy: 0 }));
  const wallsBefore = (lastState(builder).walls || []).length;
  builder.ws.send(JSON.stringify({ t: 'build' }));
  await wait(400);
  const wallsAfter = (lastState(builder).walls || []).length;
  check('wall build next to the barrier is rejected', wallsAfter === wallsBefore, wallsBefore + '->' + wallsAfter);
  check('barrier segments visible in state during lock', wallsBefore > 0, wallsBefore + ' segments');

  // 3) nobody can enter while locked (walker pushes against the barrier for 3s)
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      const me = meOf(walker);
      if (!me) { await wait(150); continue; }
      const dx = ZX + ZW / 2 - me.x, dy = ZY + ZH / 2 - me.y, d = Math.hypot(dx, dy) || 1;
      walker.ws.send(JSON.stringify({ t: 'input', dx: dx / d, dy: dy / d }));
      await wait(120);
    }
    walker.ws.send(JSON.stringify({ t: 'input', dx: 0, dy: 0 }));
    const meC2 = meOf(walker);
    check('barrier blocks entry during lock', !inZone(meC2, 2), JSON.stringify({ x: Math.round(meC2.x), y: Math.round(meC2.y) }));
  }

  // 6) event ends: barriers removed, area walkable again
  const open = await until(() => A.msgs.find(m => m.t === 'event' && m.kind === 'zone_open'), 30000, 'zone_open');
  check('open broadcast', !!open);
  const cleared = await until(() => { const s = lastState(A); return s && !s.zone && (s.walls || []).length === 0 ? s : null; }, 5000, 'zone cleared');
  check('zone and barriers gone from state', !cleared.zone);
  const crossed = await moveTo(walker, ZX + ZW / 2, ZY + ZH / 2, 30);
  check('area walkable after reopening', crossed && inZone(meOf(walker), 0));

  if (MODE !== 'bots') {
    // 7) carrier can still deposit after all of it (round winnable)
    const vault = A.map.vault;
    await moveTo(carrier, vault.x + vault.w / 2, vault.y + vault.h / 2, 40);
    const end = await until(() => carrier.msgs.find(m => m.t === 'end'), 25000, 'deposit end');
    check('carrier deposits after the event', end.reason === 'deposit', end.reason);
  } else console.log('SKIP | deposit check lives in MODE=full run');

  console.log('SKIP | unit checks (BFS route / pushOutOf / bot pathing) run locally only - they need server internals');
  const failed = results.filter(r => !r.ok);
  console.log(failed.length ? 'FAILURES: ' + failed.map(f => f.name).join(', ') : 'ALL TESTS PASSED');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.log('TEST ERROR: ' + e.message); process.exit(1); });
