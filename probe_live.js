const url = 'wss://lowkey-qvj5.onrender.com';
const ws = new WebSocket(url);
let id = null, map = null, msgs = [], lastState = null;
ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name: 'بروب', room: '' }));
ws.onmessage = ev => {
  const m = JSON.parse(ev.data); msgs.push(m);
  if (m.t === 'joined') { id = m.id; map = m.map; }
  if (m.t === 'begin') map = m.map;
  if (m.t === 'state') lastState = m;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await wait(1500);
  ws.send(JSON.stringify({ t: 'botlevel', level: 'easy' }));
  await wait(200);
  ws.send(JSON.stringify({ t: 'addbot' }));
  ws.send(JSON.stringify({ t: 'addbot' }));
  await wait(300);
  ws.send(JSON.stringify({ t: 'start' }));
  await wait(1500);
  for (let i = 0; i < 25; i++) {
    if (lastState) {
      const carriers = lastState.players.filter(p => p.carrier).map(p => p.name);
      const evs = msgs.filter(m => ['secret', 'event', 'end'].includes(m.t)).map(m => m.t + ':' + (m.kind || (m.carrier ? 'carrier' : m.reason || '')));
      console.log(i * 2 + 's', 'carriers=' + JSON.stringify(carriers), 'events=' + JSON.stringify(evs.slice(-3)), 'phase=' + (lastState.phase || '?'));
    }
    await wait(2000);
  }
  process.exit(0);
})();
