// v4.3/v4.4 test: rejoin with token, late-join spectate -> player conversion, bad token rejected.
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
    }, 100);
  });
}
function connect(hello) {
  const ws = new WebSocket(url);
  const c = { ws, msgs: [], id: null, tok: null, room: null };
  ws.onopen = () => ws.send(JSON.stringify(hello));
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    c.msgs.push(m);
    if (m.t === 'joined') { c.id = m.id; c.tok = m.tok; c.room = m.room; }
  };
  return c;
}
(async () => {
  const A = connect({ t: 'hello', name: 'اختبار', room: '' });
  await until(() => A.id, 5000, 'A joined');
  check('A joined with token', !!A.tok && !!A.room, 'room=' + A.room);
  A.ws.send(JSON.stringify({ t: 'addbot' }));
  A.ws.send(JSON.stringify({ t: 'addbot' }));
  await wait(300);
  A.ws.send(JSON.stringify({ t: 'start' }));
  await until(() => A.msgs.find(m => m.t === 'begin'), 5000, 'begin');
  check('round began', true);
  // botlevel message accepted (host, lobby-only: now playing, should be ignored silently)
  A.ws.close();
  await wait(700);
  // rejoin with correct token
  const A2 = connect({ t: 'hello', rejoin: { id: A.id, tok: A.tok, room: A.room } });
  const j = await until(() => A2.msgs.find(m => m.t === 'joined'), 5000, 'rejoin joined');
  check('rejoin restores same id', j.id === A.id && j.tok === A.tok);
  const b = await until(() => A2.msgs.find(m => m.t === 'begin'), 5000, 'rejoin begin');
  check('rejoin gets begin mid-round', b.players.length >= 3);
  const st = await until(() => A2.msgs.find(m => m.t === 'state' && m.players.some(p => p.id === A.id)), 5000, 'state after rejoin');
  check('rejoined player present in state', true);
  // input still works
  const before = st.players.find(p => p.id === A.id);
  A2.ws.send(JSON.stringify({ t: 'input', dx: 1, dy: 0 }));
  const moved = await until(() => {
    const s = A2.msgs.filter(m => m.t === 'state').pop();
    const me = s && s.players.find(p => p.id === A.id);
    return me && Math.abs(me.x - before.x) > 8 ? me : null;
  }, 6000, 'movement after rejoin');
  check('movement works after rejoin', !!moved);
  // late join -> spectator
  const C = connect({ t: 'hello', name: 'متفرج', room: A.room });
  const sp = await until(() => C.msgs.find(m => m.t === 'spectate'), 5000, 'spectate');
  check('late join gets spectate', !!sp && sp.players.length >= 3);
  const cst = await until(() => C.msgs.find(m => m.t === 'state'), 5000, 'spectator state');
  check('spectator receives live state', cst.players.length >= 3);
  // bad token rejected
  const D = connect({ t: 'hello', rejoin: { id: A.id, tok: 'badtoken', room: A.room } });
  const err = await until(() => D.msgs.find(m => m.t === 'error'), 5000, 'rejoin_failed');
  check('bad token rejected', err.msg === 'rejoin_failed');
  // round ends -> spectator converts to player
  const cj = await until(() => C.msgs.find(m => m.t === 'joined'), 40000, 'spectator converted');
  check('spectator becomes player next round', !!cj.tok);
  const lob = await until(() => C.msgs.find(m => m.t === 'lobby'), 5000, 'lobby after convert');
  check('lobby includes converted player', lob.players.some(p => p.id === cj.id));
  check('lobby carries botLevel', lob.botLevel === 'normal', 'botLevel=' + lob.botLevel);
  const failed = results.filter(r => !r.ok);
  console.log(failed.length ? 'FAILURES: ' + failed.map(f => f.name).join(', ') : 'ALL TESTS PASSED');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.log('TEST ERROR: ' + e.message); process.exit(1); });
