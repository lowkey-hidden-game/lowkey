// Lowkey - zero-dependency game server (Node 18+)
// HTTP static + WebSocket (hand-rolled, RFC6455 text frames) on one port.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------- Map ----------------
const MAP = {
  w: 1600,
  h: 1000,
  walls: [
    { x: 0, y: 0, w: 1600, h: 20 },
    { x: 0, y: 980, w: 1600, h: 20 },
    { x: 0, y: 0, w: 20, h: 1000 },
    { x: 1580, y: 0, w: 20, h: 1000 },
    { x: 350, y: 250, w: 220, h: 40 },
    { x: 350, y: 250, w: 40, h: 220 },
    { x: 900, y: 150, w: 40, h: 320 },
    { x: 1150, y: 550, w: 300, h: 40 },
    { x: 700, y: 600, w: 40, h: 280 },
    { x: 1050, y: 750, w: 40, h: 230 },
    { x: 150, y: 650, w: 280, h: 40 },
    { x: 1250, y: 250, w: 200, h: 40 },
  ],
  spots: [
    { x: 150, y: 150 },
    { x: 750, y: 110 },
    { x: 1450, y: 130 },
    { x: 520, y: 900 },
    { x: 1000, y: 480 },
    { x: 1460, y: 420 },
    { x: 830, y: 920 },
    { x: 250, y: 430 },
  ].map((s, i) => ({ id: i, x: s.x, y: s.y })),
  vault: { x: 1360, y: 800, w: 200, h: 160 },
  spawn: { x: 560, y: 330, w: 300, h: 240 },
};

const TICK_MS = 50;
const PLAYER_SPEED = 170;
const CARRIER_SPEED = 148;
const PLAYER_R = 14;
const SEARCH_RADIUS = 80;
const SEARCH_TIME = 2.5;
const EXPOSE_RADIUS = 115;
const WRONG_FREEZE = 12;
const EXPOSE_COOLDOWN = 30;
const DEPOSIT_TIME = 4;
const ROUND_SECONDS = Number(process.env.ROUND_SECONDS) || 180;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const ENDED_BACK_TO_LOBBY_MS = 9000;

// ---------------- Rooms ----------------
const rooms = new Map();

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[crypto.randomInt(chars.length)];
  return rooms.has(c) ? roomCode() : c;
}

function makeRoom(code) {
  return {
    code,
    players: new Map(),
    state: 'lobby', // lobby | playing | ended
    hostId: null,
    treasureSpot: -1,
    searched: new Set(),
    endsAt: 0,
    botSeq: 0,
    endTimer: null,
    interval: null,
  };
}

function pid() {
  return crypto.randomBytes(4).toString('hex');
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, bot: !!p.bot, host: p.room.hostId === p.id, wins: p.wins };
}

function sendTo(p, obj) {
  if (p.bot || !p.ws) return;
  try {
    wsSend(p.ws, JSON.stringify(obj));
  } catch (e) { /* socket dying */ }
}

function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.bot || !p.ws) continue;
    try { wsSend(p.ws, msg); } catch (e) { }
  }
}

function lobbyState(room) {
  broadcast(room, {
    t: 'lobby',
    room: room.code,
    players: [...room.players.values()].map(publicPlayer),
    canStart: room.players.size >= MIN_PLAYERS && room.state === 'lobby',
    minPlayers: MIN_PLAYERS,
  });
}

function ensureHost(room) {
  if (room.hostId && room.players.has(room.hostId)) return;
  const first = room.players.values().next().value;
  room.hostId = first ? first.id : null;
}

function startRound(room) {
  room.state = 'playing';
  room.searched = new Set();
  room.treasureSpot = process.env.FORCE_SPOT !== undefined ? Number(process.env.FORCE_SPOT) : crypto.randomInt(MAP.spots.length);
  room.endsAt = Date.now() + ROUND_SECONDS * 1000;
  let i = 0;
  for (const p of room.players.values()) {
    p.carrier = false;
    p.channel = null;
    p.searchProg = 0;
    p.depositProg = 0;
    p.frozenUntil = 0;
    p.exposeCdUntil = 0;
    p.dx = 0; p.dy = 0;
    p.x = MAP.spawn.x + 30 + (i % 4) * ((MAP.spawn.w - 60) / 3) + crypto.randomInt(20);
    p.y = MAP.spawn.y + 30 + Math.floor(i / 4) * 80 + crypto.randomInt(20);
    p.botTarget = null;
    i++;
  }
  broadcast(room, {
    t: 'begin',
    map: MAP,
    players: [...room.players.values()].map(publicPlayer),
    roundSeconds: ROUND_SECONDS,
  });
}

function endRound(room, winnerId, reason) {
  if (room.state !== 'playing') return;
  room.state = 'ended';
  const carrier = [...room.players.values()].find(p => p.carrier);
  const winner = winnerId ? room.players.get(winnerId) : null;
  if (winner) winner.wins++;
  broadcast(room, {
    t: 'end',
    winnerId: winner ? winner.id : null,
    winnerName: winner ? winner.name : null,
    carrierId: carrier ? carrier.id : null,
    carrierName: carrier ? carrier.name : null,
    reason, // 'deposit' | 'exposed' | 'timeout' | 'carrier_left'
  });
  for (const p of room.players.values()) { p.dx = 0; p.dy = 0; p.channel = null; p.searching = false; }
  room.endTimer = setTimeout(() => {
    room.state = 'lobby';
    lobbyState(room);
  }, ENDED_BACK_TO_LOBBY_MS);
}

function rectsOverlapCircle(cx, cy, r, rect) {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

function collide(px, py, r) {
  for (const w of MAP.walls) {
    if (rectsOverlapCircle(px, py, r, w)) return true;
  }
  return false;
}

function movePlayer(p, dt) {
  if (Date.now() < p.frozenUntil) return;
  let len = Math.hypot(p.dx, p.dy);
  if (len < 0.01) return;
  if (len > 1) { p.dx /= len; p.dy /= len; }
  // moving cancels an active search channel
  if (p.channel) { p.channel = null; p.searchProg = 0; }
  const speed = p.carrier ? CARRIER_SPEED : PLAYER_SPEED;
  const nx = p.x + p.dx * speed * dt;
  if (!collide(nx, p.y, PLAYER_R)) p.x = nx;
  const ny = p.y + p.dy * speed * dt;
  if (!collide(p.x, ny, PLAYER_R)) p.y = ny;
  p.x = Math.max(PLAYER_R + 20, Math.min(MAP.w - PLAYER_R - 20, p.x));
  p.y = Math.max(PLAYER_R + 20, Math.min(MAP.h - PLAYER_R - 20, p.y));
}

function nearestSpot(p) {
  let best = null, bd = Infinity;
  for (const s of MAP.spots) {
    const d = Math.hypot(p.x - s.x, p.y - s.y);
    if (d < bd) { bd = d; best = s; }
  }
  return { spot: best, dist: bd };
}

function inVault(p) {
  const v = MAP.vault;
  return p.x > v.x && p.x < v.x + v.w && p.y > v.y && p.y < v.y + v.h;
}

function trySearch(room, p) {
  if (room.state !== 'playing' || Date.now() < p.frozenUntil) return;
  const { spot, dist } = nearestSpot(p);
  if (!spot || dist > SEARCH_RADIUS || room.searched.has(spot.id)) return;
  p.channel = { type: 'search', spotId: spot.id };
  p.searchProg = 0;
}

function tryExpose(room, p) {
  const now = Date.now();
  if (room.state !== 'playing' || now < p.frozenUntil || now < p.exposeCdUntil) return;
  let target = null, bd = Infinity;
  for (const q of room.players.values()) {
    if (q.id === p.id) continue;
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < bd) { bd = d; target = q; }
  }
  if (!target || bd > EXPOSE_RADIUS) return;
  if (target.carrier) {
    broadcast(room, { t: 'event', kind: 'exposed', by: p.name, on: target.name });
    endRound(room, p.id, 'exposed');
  } else {
    p.frozenUntil = now + WRONG_FREEZE * 1000;
    p.exposeCdUntil = now + EXPOSE_COOLDOWN * 1000;
    p.channel = null; p.searchProg = 0;
    broadcast(room, { t: 'event', kind: 'wrong_expose', by: p.name, on: target.name });
  }
}

function tick(room, dt) {
  const now = Date.now();
  if (now >= room.endsAt) { endRound(room, null, 'timeout'); return; }

  for (const p of room.players.values()) {
    if (p.bot) botThink(room, p, dt);
    movePlayer(p, dt);

    // search channel progress
    if (p.channel && p.channel.type === 'search') {
      const spot = MAP.spots[p.channel.spotId];
      if (room.searched.has(spot.id) || Math.hypot(p.x - spot.x, p.y - spot.y) > SEARCH_RADIUS) {
        p.channel = null; p.searchProg = 0;
      } else {
        p.searchProg += dt;
        p.searching = true;
        if (p.searchProg >= SEARCH_TIME) {
          room.searched.add(spot.id);
          p.channel = null; p.searchProg = 0; p.searching = false;
          broadcast(room, { t: 'spot', id: spot.id });
          if (spot.id === room.treasureSpot) {
            p.carrier = true;
            room.treasureSpot = -1;
            sendTo(p, { t: 'secret', carrier: true });
            if (p.bot) p.botKnows = true;
          } else {
            sendTo(p, { t: 'empty', spotId: spot.id });
          }
        }
      }
    } else {
      p.searching = false;
    }

    // deposit progress
    if (p.carrier && now >= p.frozenUntil && inVault(p)) {
      p.depositProg += dt;
      if (p.depositProg >= DEPOSIT_TIME) {
        broadcast(room, { t: 'event', kind: 'deposit', by: p.name });
        endRound(room, p.id, 'deposit');
        return;
      }
    } else {
      p.depositProg = 0;
    }
  }

  broadcast(room, {
    t: 'state',
    left: Math.max(0, Math.ceil((room.endsAt - now) / 1000)),
    players: [...room.players.values()].map(p => ({
      id: p.id,
      x: Math.round(p.x),
      y: Math.round(p.y),
      s: p.searching ? 1 : 0,
      f: now < p.frozenUntil ? 1 : 0,
    })),
    spots: [...room.searched],
  });
}

// ---------------- Bots ----------------
function botThink(room, p, dt) {
  const now = Date.now();
  if (now < p.frozenUntil) { p.dx = 0; p.dy = 0; return; }
  if (p.channel) { p.dx = 0; p.dy = 0; return; } // searching: stand still

  let tx, ty;
  if (p.carrier) {
    tx = MAP.vault.x + MAP.vault.w / 2;
    ty = MAP.vault.y + MAP.vault.h / 2;
  } else {
    // nearest unsearched spot
    let best = null, bd = Infinity;
    for (const s of MAP.spots) {
      if (room.searched.has(s.id)) continue;
      const d = Math.hypot(p.x - s.x, p.y - s.y);
      if (d < bd) { bd = d; best = s; }
    }
    if (!best) {
      // all searched: wander near center and expose carrier-ish behavior is overkill; just wander
      if (!p.botTarget || Math.hypot(p.x - p.botTarget.x, p.y - p.botTarget.y) < 40) {
        p.botTarget = { x: 300 + crypto.randomInt(1000), y: 150 + crypto.randomInt(700) };
      }
      tx = p.botTarget.x; ty = p.botTarget.y;
    } else if (bd < SEARCH_RADIUS * 0.6) {
      trySearch(room, p);
      p.dx = 0; p.dy = 0;
      return;
    } else {
      tx = best.x; ty = best.y;
    }
  }

  // simple unstick: if barely moving, sidestep
  if (p.lastX !== undefined && Math.hypot(p.x - p.lastX, p.y - p.lastY) < 0.5 && (p.dx || p.dy)) {
    p.stuck = (p.stuck || 0) + 1;
  } else {
    p.stuck = 0;
  }
  p.lastX = p.x; p.lastY = p.y;

  let ang = Math.atan2(ty - p.y, tx - p.x);
  if (p.stuck > 4) ang += (crypto.randomInt(2) ? 1 : -1) * Math.PI / 2;
  p.dx = Math.cos(ang);
  p.dy = Math.sin(ang);
}

function addBot(room) {
  if (room.players.size >= MAX_PLAYERS) return false;
  const id = pid();
  const bot = {
    id, ws: null, bot: true, room,
    name: 'بوت ' + (++room.botSeq),
    x: 0, y: 0, dx: 0, dy: 0, wins: 0,
    carrier: false, channel: null, searchProg: 0, depositProg: 0,
    frozenUntil: 0, exposeCdUntil: 0, searching: false,
  };
  room.players.set(id, bot);
  ensureHost(room);
  lobbyState(room);
  return true;
}

// ---------------- HTTP + WebSocket ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  handleConnection(socket);
});

function wsSend(socket, str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function handleConnection(socket) {
  let buf = Buffer.alloc(0);
  let player = null;
  let frag = [];

  function leave() {
    if (!player) return;
    const room = player.room;
    room.players.delete(player.id);
    if (player.carrier && room.state === 'playing') {
      endRound(room, null, 'carrier_left');
    }
    if (room.players.size === 0) {
      if (room.endTimer) clearTimeout(room.endTimer);
      if (room.interval) clearInterval(room.interval);
      rooms.delete(room.code);
    } else {
      ensureHost(room);
      lobbyState(room);
    }
    player = null;
  }

  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2)); off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.slice(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = buf.slice(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.slice(off + maskLen + len);

      if (op === 8) { socket.end(); return; }
      if (op === 9) { // ping -> pong
        const h = Buffer.from([0x8A, payload.length]);
        socket.write(Buffer.concat([h, payload]));
        continue;
      }
      if (op === 10) continue;
      if (op === 1 || op === 2 || op === 0) {
        frag.push(payload);
        if (!fin) continue;
        const full = Buffer.concat(frag).toString('utf8');
        frag = [];
        let msg;
        try { msg = JSON.parse(full); } catch (e) { continue; }
        handleMessage(msg, p => { player = p; }, () => player, socket, leave);
      }
    }
  });

  socket.on('close', leave);
  socket.on('error', () => { try { socket.destroy(); } catch (e) { } leave(); });
}

function handleMessage(msg, setPlayer, getPlayer, socket, leave) {
  const player = getPlayer();
  if (msg.t === 'hello') {
    if (player) return;
    const name = String(msg.name || '').trim().slice(0, 14) || 'لاعب';
    let code = String(msg.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    let room;
    if (code && rooms.has(code)) {
      room = rooms.get(code);
    } else if (code) {
      socket && wsSend(socket, JSON.stringify({ t: 'error', msg: 'room_not_found' }));
      return;
    } else {
      code = roomCode();
      room = makeRoom(code);
      rooms.set(code, room);
      room.interval = setInterval(() => { if (room.state === 'playing') tick(room, TICK_MS / 1000); }, TICK_MS);
    }
    if (room.players.size >= MAX_PLAYERS) {
      wsSend(socket, JSON.stringify({ t: 'error', msg: 'room_full' }));
      return;
    }
    const id = pid();
    const p = {
      id, ws: socket, bot: false, room, name,
      x: 0, y: 0, dx: 0, dy: 0, wins: 0,
      carrier: false, channel: null, searchProg: 0, depositProg: 0,
      frozenUntil: 0, exposeCdUntil: 0, searching: false,
    };
    room.players.set(id, p);
    ensureHost(room);
    setPlayer(p);
    wsSend(socket, JSON.stringify({ t: 'joined', id, room: room.code, map: MAP }));
    lobbyState(room);
    return;
  }
  if (!player) return;
  const room = player.room;
  switch (msg.t) {
    case 'input':
      player.dx = Math.max(-1, Math.min(1, Number(msg.dx) || 0));
      player.dy = Math.max(-1, Math.min(1, Number(msg.dy) || 0));
      break;
    case 'search':
      trySearch(room, player);
      break;
    case 'expose':
      tryExpose(room, player);
      break;
    case 'start':
      if (room.hostId === player.id && room.state === 'lobby' && room.players.size >= MIN_PLAYERS) {
        startRound(room);
      }
      break;
    case 'addbot':
      if (room.hostId === player.id && room.state === 'lobby') addBot(room);
      break;
    case 'rmbot': {
      if (room.hostId !== player.id || room.state !== 'lobby') break;
      const bot = [...room.players.values()].find(q => q.bot);
      if (bot) { room.players.delete(bot.id); lobbyState(room); }
      break;
    }
  }
}

server.listen(PORT, () => {
  console.log('Lowkey server on :' + PORT);
});
