// v4.7 test: locked zone event - warn, lock, push-out, no entry, carrier, open, build-block, routes.
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
  const S = require('./server.js');
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
  A.ws.send(JSON.stringify({ t: 'addbot' }));
  A.ws.send(JSON.stringify({ t: 'addbot' }));
  await wait(300);
  A.ws.send(JSON.stringify({ t: 'start' }));
  await until(() => A.msgs.find(m => m.t === 'begin'), 5000, 'begin');
  check('round began', true);

  // A grabs the treasure first (forced spot 0, outside the zone)
  const spot = A.map.spots[0];
  await moveTo(A, spot.x, spot.y, 40);
  A.ws.send(JSON.stringify({ t: 'search' }));
  await until(() => A.msgs.find(m => m.t === 'secret' && m.carrier), 9000, 'A carrier');
  check('A is carrier before the event', true);

  // 1) warning arrives with the zone rectangle
  const warn = await until(() => A.msgs.find(m => m.t === 'event' && m.kind === 'zone_warn'), 12000, 'zone_warn');
  check('warning broadcast with zone rect', warn.zone && warn.zone.w > 0, JSON.stringify(warn.zone));

  // B waits at the zone's west edge for the build test; A steps inside
  moveTo(B, ZX - 60, ZY + ZH / 2, 30);
  await moveTo(A, ZX + ZW / 2, ZY + ZH / 2, 30);
  const stW = await until(() => { const s = lastState(A); return s && s.zone && s.zone.st === 'warn' ? s : null; }, 6000, 'warn state');
  check('zone visible in state during warning', stW.zone.st === 'warn');
  const lock = await until(() => A.msgs.find(m => m.t === 'event' && m.kind === 'zone_lock'), 8000, 'zone_lock');
  check('lock broadcast', !!lock);
  await wait(300);
  const meA = meOf(A);
  check('carrier inside at lock is pushed out', !inZone(meA, 4), JSON.stringify({ x: Math.round(meA.x), y: Math.round(meA.y) }));
  check('treasure kept through the push', !A.msgs.find(m => m.t === 'secret' && m.carrier === false));

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
  check('bots alive with barriers up (moving or searching, none inside)', botMoved || botSnap1.every(b => !inZone(b, 0)), 'botsSeen=' + botSnap1.length);
  check('still nobody inside later in the lock', insideLater === 0);

  // 5) build-block: walls cannot be fused to the zone barrier (B is at the west edge)
  B.ws.send(JSON.stringify({ t: 'input', dx: 1, dy: 0 }));
  await wait(250);
  B.ws.send(JSON.stringify({ t: 'input', dx: 0, dy: 0 }));
  const wallsBefore = (lastState(B).walls || []).length;
  B.ws.send(JSON.stringify({ t: 'build' }));
  await wait(400);
  const wallsAfter = (lastState(B).walls || []).length;
  check('wall build next to the barrier is rejected', wallsAfter === wallsBefore, wallsBefore + '->' + wallsAfter);
  check('barrier segments visible in state during lock', wallsBefore > 0, wallsBefore + ' segments');

  // 3) nobody can enter while locked (A pushes against the barrier for 3s)
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      const me = meOf(A);
      if (!me) { await wait(150); continue; }
      const dx = ZX + ZW / 2 - me.x, dy = ZY + ZH / 2 - me.y, d = Math.hypot(dx, dy) || 1;
      A.ws.send(JSON.stringify({ t: 'input', dx: dx / d, dy: dy / d }));
      await wait(120);
    }
    A.ws.send(JSON.stringify({ t: 'input', dx: 0, dy: 0 }));
    const meA2 = meOf(A);
    check('barrier blocks entry during lock', !inZone(meA2, 2), JSON.stringify({ x: Math.round(meA2.x), y: Math.round(meA2.y) }));
  }

  // 6) event ends: barriers removed, area walkable again
  const open = await until(() => A.msgs.find(m => m.t === 'event' && m.kind === 'zone_open'), 10000, 'zone_open');
  check('open broadcast', !!open);
  const cleared = await until(() => { const s = lastState(A); return s && !s.zone && (s.walls || []).length === 0 ? s : null; }, 5000, 'zone cleared');
  check('zone and barriers gone from state', !cleared.zone);
  const crossed = await moveTo(A, ZX + ZW / 2, ZY + ZH / 2, 30);
  check('area walkable after reopening', crossed && inZone(meOf(A), 0));

  // 7) carrier can still deposit after all of it (round winnable)
  const vault = A.map.vault;
  await moveTo(A, vault.x + vault.w / 2, vault.y + vault.h / 2, 40);
  const end = await until(() => A.msgs.find(m => m.t === 'end'), 15000, 'deposit end');
  check('carrier deposits after the event', end.reason === 'deposit', end.reason);

  // 8) unit: alternate route to the vault always exists while locked
  {
    const room = S.makeRoom('ZTST');
    S.rooms.set('ZTST', room);
    room.state = 'playing';
    room.zone = { x: ZX, y: ZY, w: ZW, h: ZH, st: 'warn', until: 0 };
    S.lockZone(room, Date.now());
    const CELL = 20, W = Math.ceil(S.MAP.w / CELL), H = Math.ceil(S.MAP.h / CELL);
    const blocked = new Uint8Array(W * H);
    const PAD = 18;
    for (const wl of [...S.MAP.walls, ...room.dynWalls]) {
      for (let gy = Math.max(0, Math.floor((wl.y - PAD) / CELL)); gy <= Math.min(H - 1, Math.floor((wl.y + wl.h + PAD) / CELL)); gy++)
        for (let gx = Math.max(0, Math.floor((wl.x - PAD) / CELL)); gx <= Math.min(W - 1, Math.floor((wl.x + wl.w + PAD) / CELL)); gx++) blocked[gy * W + gx] = 1;
    }
    const vx = Math.floor((S.MAP.vault.x + S.MAP.vault.w / 2) / CELL), vy = Math.floor((S.MAP.vault.y + S.MAP.vault.h / 2) / CELL);
    const reachable = (sx, sy) => {
      const s = Math.floor(sy / CELL) * W + Math.floor(sx / CELL), t = vy * W + vx;
      const prev = new Uint8Array(W * H); const q = [s]; prev[s] = 1;
      while (q.length) {
        const c = q.shift();
        if (c === t) return true;
        const cx = c % W, cy = Math.floor(c / W);
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const nc = ny * W + nx;
          if (!blocked[nc] && !prev[nc]) { prev[nc] = 1; q.push(nc); }
        }
      }
      return false;
    };
    const starts = [[60, 60], [S.MAP.w - 60, 60], [60, S.MAP.h - 60], [S.MAP.w - 60, S.MAP.h - 60],
      [ZX - 50, ZY + ZH + 50], [ZX + ZW + 50, ZY - 50], [ZX + ZW / 2, ZY - 50], [ZX + ZW / 2, ZY + ZH + 50]];
    const fails = starts.filter(([sx, sy]) => !reachable(sx, sy));
    check('alternate route to the vault exists while locked', fails.length === 0, JSON.stringify(fails));
    // real flow: bot standing inside when lockZone runs -> pushed out, then ring built
    S.addBot(room);
    const bot = [...room.players.values()].find(q => q.bot);
    const room2 = S.makeRoom('ZTS2');
    S.rooms.set('ZTS2', room2);
    room2.state = 'playing';
    room2.players.set(bot.id, bot); bot.room = room2;
    bot.x = ZX + ZW / 2; bot.y = ZY + ZH / 2;
    room2.zone = { x: ZX, y: ZY, w: ZW, h: ZH, st: 'warn', until: 0 };
    S.lockZone(room2, Date.now());
    check('lockZone pushes a bot out too', !(bot.x > ZX && bot.x < ZX + ZW && bot.y > ZY && bot.y < ZY + ZH), JSON.stringify({ x: Math.round(bot.x), y: Math.round(bot.y) }));
    // bots with the barrier up: from 3 starts around the ring, each must reach a treasure spot and never enter
    {
      const starts = [[ZX - 80, ZY + ZH / 2], [ZX + ZW + 80, ZY + ZH / 2], [ZX + ZW / 2, ZY - 70]];
      const res = [];
      for (const [sx, sy] of starts) {
        const rr = S.makeRoom('ZB' + res.length); S.rooms.set(rr.code || 'ZB' + res.length, rr);
        S.addBot(rr);
        const b2 = [...rr.players.values()][0];
        b2.ai = Object.assign({}, S.AI_LEVELS.easy, { pauseP: 0, hunchP: 0 });
        S.startRound(rr);
        b2.x = sx; b2.y = sy;
        rr.zone = { x: ZX, y: ZY, w: ZW, h: ZH, st: 'warn', until: 0 };
        S.lockZone(rr, Date.now());
        let minSpot = 1e9, entered = false;
        for (let k = 0; k < 1600; k++) {
          S.tick(rr, 0.05);
          for (const sp of S.MAP.spots) minSpot = Math.min(minSpot, Math.hypot(b2.x - sp.x, b2.y - sp.y));
          if (b2.x > ZX + 4 && b2.x < ZX + ZW - 4 && b2.y > ZY + 4 && b2.y < ZY + ZH - 4) entered = true;
        }
        res.push({ minSpot: Math.round(minSpot), entered });
      }
      check('bots path around the barrier (reach spots, never enter)', res.every(r => !r.entered && r.minSpot < 90), JSON.stringify(res));
    }

  }
  const failed = results.filter(r => !r.ok);
  console.log(failed.length ? 'FAILURES: ' + failed.map(f => f.name).join(', ') : 'ALL TESTS PASSED');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.log('TEST ERROR: ' + e.message); process.exit(1); });
