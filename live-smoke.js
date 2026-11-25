// Live smoke test against the deployed Lowkey server (wss).
const URL = process.env.LIVE_URL || 'wss://lowkey-qvj5.onrender.com';
const results = [];
const check = (n, ok, x) => { results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + ' | ' + n + (x ? ' | ' + x : '')); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = fn(); if (v) return v; await wait(150); }
  throw new Error('timeout: ' + label);
}

(async () => {
  const ws = new WebSocket(URL);
  const msgs = [];
  let id = null, room = null;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name: 'تجربة', room: '' }));
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    msgs.push(m);
    if (m.t === 'joined') { id = m.id; room = m.room; }
  };
  await until(() => id, 20000, 'joined over wss');
  check('wss join creates room', !!room, 'room=' + room);

  ws.send(JSON.stringify({ t: 'addbot' }));
  ws.send(JSON.stringify({ t: 'addbot' }));
  await until(() => {
    const l = msgs.filter(m => m.t === 'lobby').pop();
    return l && l.players.length === 3 && l.canStart;
  }, 10000, 'bots added');
  check('bots added over wss', true);

  ws.send(JSON.stringify({ t: 'start' }));
  await until(() => msgs.some(m => m.t === 'begin'), 10000, 'begin');
  check('round begins over wss', true);

  await until(() => msgs.filter(m => m.t === 'state').length > 10, 10000, 'state ticks');
  check('live state ticks flow (20Hz)', true);

  // bots should clear at least one spot within ~70s
  await until(() => msgs.some(m => m.t === 'spot'), 70000, 'a spot searched');
  check('bots search and clear spots live', true);

  ws.close();
  const fails = results.filter(r => !r).length;
  console.log(fails === 0 ? 'LIVE SMOKE PASSED' : fails + ' FAILED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('SMOKE ERROR:', e.message); process.exit(1); });
