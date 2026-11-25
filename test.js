// End-to-end test for server.js: 1 scripted client + 2 bots play a full round.
const PORT = process.env.PORT || 8791;
const url = `ws://localhost:${PORT}`;

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok, extra });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
}

function connect(name, room) {
  const ws = new WebSocket(url);
  const c = { ws, name, id: null, room: room || '', msgs: [], carrier: false, map: null, roster: [] };
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name, room }));
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    c.msgs.push(m);
    if (m.t === 'joined') { c.id = m.id; c.room = m.room; c.map = m.map; }
    if (m.t === 'begin') { c.roster = m.players; c.map = m.map; }
    if (m.t === 'secret' && m.carrier) c.carrier = true;
    if (m.t === 'end') c.end = m;
  };
  return c;
}

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = fn();
    if (v) return v;
    await wait(100);
  }
  throw new Error('timeout: ' + label);
}

(async () => {
  const A = connect('اختبار', '');
  await until(() => A.id, 3000, 'A joined');
  check('join creates room', A.room && A.room.length === 4, 'room=' + A.room);

  const B = connect('ضيف', A.room);
  await until(() => B.id, 3000, 'B joined');
  const lobbyA = A.msgs.filter(m => m.t === 'lobby').pop();
  check('second player joins room', lobbyA && lobbyA.players.length === 2);

  // host adds a bot -> 3 players
  A.ws.send(JSON.stringify({ t: 'addbot' }));
  await until(() => {
    const l = A.msgs.filter(m => m.t === 'lobby').pop();
    return l && l.players.length === 3 && l.players.some(p => p.bot) && l.canStart;
  }, 3000, 'bot added');
  check('bot added, canStart=true', true);

  // non-host cannot start
  B.ws.send(JSON.stringify({ t: 'start' }));
  await wait(400);
  check('non-host start ignored', !B.msgs.some(m => m.t === 'begin'));

  // host starts
  A.ws.send(JSON.stringify({ t: 'start' }));
  await until(() => A.msgs.some(m => m.t === 'begin') && B.msgs.some(m => m.t === 'begin'), 3000, 'begin');
  check('round begins for all', true);
  const begin = A.msgs.find(m => m.t === 'begin');
  check('begin carries map with 8 spots', begin.map.spots.length === 8);

  // state flowing
  await until(() => A.msgs.filter(m => m.t === 'state').length > 5, 3000, 'state ticks');
  const st = A.msgs.filter(m => m.t === 'state').pop();
  check('state ticks broadcast positions', st.players.length === 3 && typeof st.left === 'number', 'left=' + st.left);

  // A walks toward the nearest unsearched spot and searches (greedy steer + unstick)
  let target = null;
  const nav = setInterval(() => {
    if (A.end) return;
    const s = A.msgs.filter(m => m.t === 'state').pop();
    if (!s || !A.map) return;
    const me = s.players.find(p => p.id === A.id);
    if (!me) return;
    if (A.carrier) {
      target = { x: A.map.vault.x + A.map.vault.w / 2, y: A.map.vault.y + A.map.vault.h / 2 };
    } else if (!target || A.msgs.filter(m => m.t === 'spot').some(m => m.id === target.id)) {
      const un = A.map.spots.filter(sp => !A.msgs.some(m => m.t === 'spot' && m.id === sp.id));
      target = un.length ? un[cryptoRandom(un.length)] : null;
    }
    if (!target) return;
    let dx = target.x - me.x, dy = target.y - me.y;
    const d = Math.hypot(dx, dy);
    if (!A.carrier && d < 50) {
      A.ws.send(JSON.stringify({ t: 'input', dx: 0, dy: 0 }));
      A.ws.send(JSON.stringify({ t: 'search' }));
      return;
    }
    if (A.carrier && d < 30) {
      A.ws.send(JSON.stringify({ t: 'input', dx: 0, dy: 0 }));
      return;
    }
    dx /= d; dy /= d;
    // unstick
    if (A.lastPos && Math.hypot(me.x - A.lastPos.x, me.y - A.lastPos.y) < 1) {
      A.stuck = (A.stuck || 0) + 1;
    } else A.stuck = 0;
    A.lastPos = me;
    if (A.stuck > 3) { const t = dx; dx = -dy; dy = t; }
    A.ws.send(JSON.stringify({ t: 'input', dx, dy }));
  }, 150);

  // also spam expose occasionally near others to try to trigger wrong_expose
  const exposeTimer = setInterval(() => {
    if (!A.end) A.ws.send(JSON.stringify({ t: 'expose' }));
  }, 3000);

  function cryptoRandom(n) { return Math.floor(Math.random() * n); }

  // wait for round end (bots search too; someone deposits or time runs out)
  const end = await until(() => A.end, 100000, 'round end');
  const msgsAtEnd = A.msgs.length;
  clearInterval(nav); clearInterval(exposeTimer);
  check('round ended', true, 'reason=' + end.reason + ' winner=' + end.winnerName + ' carrier=' + end.carrierName);
  check('end reason valid', ['deposit', 'exposed', 'timeout', 'carrier_left'].includes(end.reason));
  if (end.reason === 'deposit') check('winner is the carrier', end.winnerId === end.carrierId);
  if (end.reason === 'exposed') check('winner is not the carrier', end.winnerId !== end.carrierId);

  // someone found the treasure? carrier revealed unless timeout-without-find
  check('treasure was found (carrier exists) OR timeout-without-carrier',
    !!end.carrierId || end.reason === 'timeout');

  const wrongExpose = A.msgs.some(m => m.t === 'event' && m.kind === 'wrong_expose');
  const emptyMsg = A.msgs.some(m => m.t === 'empty');
  console.log('INFO | wrong_expose seen: ' + wrongExpose + ' | empty-spot feedback seen: ' + emptyMsg);
  console.log('INFO | A was carrier: ' + A.carrier);

  // back to lobby after ~9s
  await until(() => A.msgs.slice(msgsAtEnd).some(m => m.t === 'lobby'), 15000, 'back to lobby');
  check('returns to lobby after round', true);

  // round 2 can start
  A.ws.send(JSON.stringify({ t: 'start' }));
  await until(() => A.msgs.filter(m => m.t === 'begin').length >= 2, 4000, 'round 2 begins');
  check('second round starts', true);

  // round 2: hunt nearest player and expose -> expect wrong_expose or exposed end
  A.end = null; A.carrier = false; A.round2 = true;
  const nav2 = setInterval(() => {
    if (A.end) return;
    const s = A.msgs.filter(m => m.t === 'state').pop();
    if (!s) return;
    const me = s.players.find(p => p.id === A.id);
    if (!me) return;
    const others = s.players.filter(p => p.id !== A.id);
    if (!others.length) return;
    others.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
    const t0 = others[0];
    const d = Math.hypot(t0.x - me.x, t0.y - me.y);
    if (d < 100) {
      A.ws.send(JSON.stringify({ t: 'input', dx: 0, dy: 0 }));
      A.ws.send(JSON.stringify({ t: 'expose' }));
      return;
    }
    let dx = (t0.x - me.x) / d, dy = (t0.y - me.y) / d;
    if (A.lastPos && Math.hypot(me.x - A.lastPos.x, me.y - A.lastPos.y) < 1) A.stuck = (A.stuck || 0) + 1; else A.stuck = 0;
    A.lastPos = me;
    if (A.stuck > 3) { const t = dx; dx = -dy; dy = t; }
    A.ws.send(JSON.stringify({ t: 'input', dx, dy }));
  }, 150);
  const exposeSeen = await until(() =>
    A.msgs.some(m => m.t === 'event' && m.kind === 'wrong_expose') ||
    (A.end && A.end.reason === 'exposed'), 60000, 'expose outcome');
  clearInterval(nav2);
  check('expose path works (wrong_expose event or exposed win)', !!exposeSeen);
  // wait for round 2 to end cleanly
  await until(() => A.end, 100000, 'round 2 end');
  check('round 2 ended', true, 'reason=' + A.end.reason);

  const fails = results.filter(r => !r.ok).length;
  console.log(fails === 0 ? 'ALL TESTS PASSED' : fails + ' TESTS FAILED');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
