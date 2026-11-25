// Lowkey - zero-dependency game server (Node 18+)
// v2: building, moving treasure, power-ups, carrier ghost, human-like bots.
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
const SPEED_BOOST = 1.45;
const SPEED_BOOST_SECONDS = 12;
const CROUCH_MULT = 0.55;
const PLAYER_R = 14;
const SEARCH_RADIUS = 80;
const SEARCH_TIME = 2.5;
const EXPOSE_RADIUS = 115;
const WRONG_FREEZE = 12;
const EXPOSE_COOLDOWN = 30;
const SHIELD_COOLDOWN = 8;
const DEPOSIT_TIME = 4;
const ROUND_SECONDS = Number(process.env.ROUND_SECONDS) || 180;
const MOVE_SECONDS = Number(process.env.MOVE_SECONDS) || 40;      // treasure relocates if unfound
const POWERUP_SECONDS = Number(process.env.POWERUP_SECONDS) || 22; // spawn cadence
const MAX_POWERUPS = 3;
const WALL_SECONDS = Number(process.env.WALL_SECONDS) || 15;
const WALL_COOLDOWN = 4;
const WALLS_PER_ROUND = 3;
const WALL_SIZE = 64;
const GHOST_SECONDS = 12;
const GOGGLES_SECONDS = 12;
const REVEAL_SECONDS = 12;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const ENDED_BACK_TO_LOBBY_MS = 9000;
const POWER_TYPES = ['speed', 'shield', 'reveal', 'ghost', 'goggles'];
const AVATARS = ['🦊', '🐼', '🐸', '🦁', '🐰', '🐯', '🐵', '🦉', '🐙', '🐺', '🦄', '🐝'];
const FORCE_POWER = process.env.FORCE_POWER || null;

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
    state: 'lobby',
    hostId: null,
    treasureSpot: -1,
    searched: new Set(),
    endsAt: 0,
    moveAt: 0,
    powerAt: 0,
    powerSeq: 0,
    powerups: [],
    dynWalls: [],
    wallSeq: 0,
    botSeq: 0,
    endTimer: null,
    interval: null,
  };
}

function pid() { return crypto.randomBytes(4).toString('hex'); }

function publicPlayer(p) {
  return { id: p.id, name: p.name, bot: !!p.bot, host: p.room.hostId === p.id, wins: p.wins, avatar: p.avatar };
}

function sendTo(p, obj) {
  if (p.bot || !p.ws) return;
  try { wsSend(p.ws, JSON.stringify(obj)); } catch (e) { }
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
  room.moveAt = Date.now() + MOVE_SECONDS * 1000;
  room.powerAt = Date.now() + 3000; // first power-up early
  room.powerups = [];
  room.dynWalls = [];
  let i = 0;
  for (const p of room.players.values()) {
    p.carrier = false;
    p.channel = null;
    p.searchProg = 0;
    p.depositProg = 0;
    p.frozenUntil = 0;
    p.exposeCdUntil = 0;
    p.dx = 0; p.dy = 0;
    p.crouch = false;
    p.walls = WALLS_PER_ROUND;
    p.wallCdUntil = 0;
    p.shield = false;
    p.speedUntil = 0;
    p.revealUntil = 0;
    p.ghostUsed = false;
    p.ghostUntil = 0;
    p.gogglesUntil = 0;
    p.fx = 1; p.fy = 0;
    p.x = MAP.spawn.x + 30 + (i % 4) * ((MAP.spawn.w - 60) / 3) + crypto.randomInt(20);
    p.y = MAP.spawn.y + 30 + Math.floor(i / 4) * 80 + crypto.randomInt(20);
    p.botTarget = null;
    p.pauseUntil = 0;
    p.exposeAt = 0;
    p.adjacentSince = 0;
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
    reason,
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

function collide(room, px, py, r) {
  for (const w of MAP.walls) {
    if (rectsOverlapCircle(px, py, r, w)) return true;
  }
  for (const w of room.dynWalls) {
    if (rectsOverlapCircle(px, py, r, w)) return true;
  }
  return false;
}

function effectiveSpeed(p, now) {
  let s = p.carrier ? CARRIER_SPEED : PLAYER_SPEED;
  if (now < p.speedUntil) s *= SPEED_BOOST;
  if (p.crouch) s *= CROUCH_MULT;
  return s;
}

// noise tier: 0 silent (crouch/still), 1 moving, 2 boosted sprint
function noiseLevel(p, now) {
  if (Math.hypot(p.dx, p.dy) < 0.01) return 0;
  if (p.crouch) return 0;
  return now < p.speedUntil ? 2 : 1;
}

function movePlayer(room, p, dt) {
  const now = Date.now();
  if (now < p.frozenUntil) return;
  let len = Math.hypot(p.dx, p.dy);
  if (len < 0.01) return;
  if (len > 1) { p.dx /= len; p.dy /= len; }
  p.fx = p.dx; p.fy = p.dy;
  if (p.channel) { p.channel = null; p.searchProg = 0; }
  const speed = effectiveSpeed(p, now);
  const nx = p.x + p.dx * speed * dt;
  if (!collide(room, nx, p.y, PLAYER_R)) p.x = nx;
  const ny = p.y + p.dy * speed * dt;
  if (!collide(room, p.x, ny, PLAYER_R)) p.y = ny;
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

function nearestOther(room, p) {
  let best = null, bd = Infinity;
  for (const q of room.players.values()) {
    if (q.id === p.id) continue;
    if (Date.now() < q.ghostUntil) continue; // can't see a ghosted carrier
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < bd) { bd = d; best = q; }
  }
  return { other: best, dist: bd };
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
  const { other: target, dist: bd } = nearestOther(room, p);
  if (!target || bd > EXPOSE_RADIUS) return;
  if (target.shield) {
    target.shield = false;
    p.exposeCdUntil = now + SHIELD_COOLDOWN * 1000;
    broadcast(room, { t: 'event', kind: 'shielded', by: p.name, on: target.name });
    return;
  }
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

function tryBuild(room, p) {
  const now = Date.now();
  if (room.state !== 'playing' || now < p.frozenUntil || p.walls <= 0 || now < p.wallCdUntil) return;
  const cx = p.x + p.fx * (PLAYER_R + WALL_SIZE / 2 + 4);
  const cy = p.y + p.fy * (PLAYER_R + WALL_SIZE / 2 + 4);
  const w = { x: Math.round(cx - WALL_SIZE / 2), y: Math.round(cy - WALL_SIZE / 2), w: WALL_SIZE, h: WALL_SIZE, id: ++room.wallSeq, expiresAt: now + WALL_SECONDS * 1000 };
  if (collide(room, cx, cy, WALL_SIZE / 2)) return; // no space
  if (inVault({ x: cx, y: cy })) return; // keep the vault open
  p.walls--;
  p.wallCdUntil = now + WALL_COOLDOWN * 1000;
  room.dynWalls.push(w);
}

function tryGhost(room, p) {
  const now = Date.now();
  if (room.state !== 'playing' || !p.carrier || p.ghostUsed || now < p.frozenUntil) return;
  p.ghostUsed = true;
  p.ghostUntil = now + GHOST_SECONDS * 1000;
  sendTo(p, { t: 'ghost', ms: GHOST_SECONDS * 1000 });
}

function freeSpot(room) {
  for (let i = 0; i < 30; i++) {
    const x = 60 + crypto.randomInt(MAP.w - 120);
    const y = 60 + crypto.randomInt(MAP.h - 120);
    if (!collide(room, x, y, 26) && !inVault({ x, y })) return { x, y };
  }
  return null;
}

function spawnPowerup(room) {
  if (room.powerups.length >= MAX_POWERUPS) return;
  let pos;
  if (FORCE_POWER && room.powerSeq === 0) {
    pos = { x: MAP.spawn.x + MAP.spawn.w / 2, y: MAP.spawn.y + MAP.spawn.h / 2 };
  } else {
    pos = freeSpot(room);
  }
  if (!pos) return;
  const type = FORCE_POWER || POWER_TYPES[crypto.randomInt(POWER_TYPES.length)];
  room.powerups.push({ id: ++room.powerSeq, x: pos.x, y: pos.y, type });
}

function applyPowerup(room, p, pu) {
  const now = Date.now();
  if (pu.type === 'speed') p.speedUntil = now + SPEED_BOOST_SECONDS * 1000;
  if (pu.type === 'shield') p.shield = true;
  if (pu.type === 'ghost') p.ghostUntil = now + GHOST_SECONDS * 1000;
  if (pu.type === 'goggles') p.gogglesUntil = now + GOGGLES_SECONDS * 1000;
  if (pu.type === 'reveal') {
    p.revealUntil = now + REVEAL_SECONDS * 1000;
    const carrier = [...room.players.values()].find(q => q.carrier);
    if (carrier) sendTo(p, { t: 'reveal', id: carrier.id, ms: REVEAL_SECONDS * 1000 });
  }
  sendTo(p, { t: 'power', type: pu.type });
}

function relocateTreasure(room) {
  const unsearched = MAP.spots.filter(s => !room.searched.has(s.id));
  if (unsearched.length < 2) return;
  const current = room.treasureSpot;
  let next = current;
  while (next === current) next = unsearched[crypto.randomInt(unsearched.length)].id;
  room.treasureSpot = next;
  broadcast(room, { t: 'event', kind: 'treasure_moved' });
}

function tick(room, dt) {
  const now = Date.now();
  if (now >= room.endsAt) { endRound(room, null, 'timeout'); return; }

  room.dynWalls = room.dynWalls.filter(w => w.expiresAt > now);

  // treasure relocation while unfound
  if (room.treasureSpot >= 0 && now >= room.moveAt) {
    relocateTreasure(room);
    room.moveAt = now + MOVE_SECONDS * 1000;
  }

  // power-up spawns
  if (now >= room.powerAt) {
    spawnPowerup(room);
    room.powerAt = now + POWERUP_SECONDS * 1000;
  }

  for (const p of room.players.values()) {
    if (p.bot) botThink(room, p, dt);
    movePlayer(room, p, dt);

    // power-up pickup
    for (let i = room.powerups.length - 1; i >= 0; i--) {
      const pu = room.powerups[i];
      if (Math.hypot(p.x - pu.x, p.y - pu.y) < 26) {
        room.powerups.splice(i, 1);
        applyPowerup(room, p, pu);
      }
    }

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

    // scheduled bot expose (reaction delay)
    if (p.bot && p.exposeAt && now >= p.exposeAt) {
      p.exposeAt = 0;
      tryExpose(room, p);
    }
  }

  // personalized state per viewer (ghost hides the carrier from others)
  for (const viewer of room.players.values()) {
    if (viewer.bot || !viewer.ws) continue;
    const payload = {
      t: 'state',
      left: Math.max(0, Math.ceil((room.endsAt - now) / 1000)),
      players: [...room.players.values()].map(p => {
        const hidden = now < p.ghostUntil && p.id !== viewer.id && now >= viewer.gogglesUntil;
        return {
          id: p.id,
          x: hidden ? -500 : Math.round(p.x),
          y: hidden ? -500 : Math.round(p.y),
          s: p.searching && !hidden ? 1 : 0,
          g: !hidden && now < p.ghostUntil ? 1 : 0,
          a: p.avatar,
          f: now < p.frozenUntil ? 1 : 0,
          sp: p.channel && !hidden ? Math.min(1, p.searchProg / SEARCH_TIME) : 0,
          spid: p.channel && !hidden ? p.channel.spotId : -1,
          n: hidden ? 0 : noiseLevel(p, now),
          c: p.crouch ? 1 : 0,
        };
      }),
      spots: [...room.searched],
      walls: room.dynWalls.map(w => ({ x: w.x, y: w.y, w: w.w, h: w.h, ttl: Math.ceil((w.expiresAt - now) / 1000) })),
      powers: room.powerups,
      me: {
        walls: viewer.walls,
        shield: viewer.shield ? 1 : 0,
        ghost: now < viewer.ghostUntil ? 1 : 0,
        ghostLeft: viewer.ghostUsed || !viewer.carrier ? 0 : 1,
        goggles: now < viewer.gogglesUntil ? 1 : 0,
        speed: now < viewer.speedUntil ? 1 : 0,
        deposit: viewer.carrier ? Math.min(1, viewer.depositProg / DEPOSIT_TIME) : 0,
        search: viewer.channel ? Math.min(1, viewer.searchProg / SEARCH_TIME) : 0,
      },
    };
    try { wsSend(viewer.ws, JSON.stringify(payload)); } catch (e) { }
  }
}

// ---------------- Bots (human-like) ----------------
function botThink(room, p, dt) {
  const now = Date.now();
  if (now < p.frozenUntil) { p.dx = 0; p.dy = 0; return; }
  if (p.channel) { p.dx = 0; p.dy = 0; return; }
  if (now < p.pauseUntil) { p.dx = 0; p.dy = 0; return; }

  // random human-like pauses
  if (Math.random() < 0.004) { p.pauseUntil = now + 400 + crypto.randomInt(1200); return; }

  // delayed expose (reveal-driven, with reaction time)
  if (!p.exposeAt && now >= p.exposeCdUntil) {
    if (now < p.revealUntil) {
      const carrier = [...room.players.values()].find(q => q.carrier);
      if (carrier && Math.hypot(p.x - carrier.x, p.y - carrier.y) < EXPOSE_RADIUS * 0.9) {
        p.exposeAt = now + 500 + crypto.randomInt(700);
      }
    } else {
      // hunch: someone lingering very close after the early game
      const { other, dist } = nearestOther(room, p);
      if (other && dist < 90) {
        p.adjacentSince = p.adjacentSince || now;
        const roundAge = (now - (room.endsAt - ROUND_SECONDS * 1000)) / 1000;
        if (now - p.adjacentSince > 2500 && roundAge > 25 && Math.random() < 0.006) {
          p.exposeAt = now + 600 + crypto.randomInt(900);
        }
      } else {
        p.adjacentSince = 0;
      }
    }
  }

  let tx, ty;

  // grab a nearby power-up
  let pu = null, pud = 220;
  for (const q of room.powerups) {
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < pud) { pud = d; pu = q; }
  }

  if (pu) {
    tx = pu.x; ty = pu.y;
  } else if (p.carrier) {
    const { other, dist } = nearestOther(room, p);
    // drop a wall between us and a close pursuer
    if (other && dist < 150 && p.walls > 0 && now >= p.wallCdUntil && Math.random() < 0.3) {
      p.fx = (p.x - other.x) / dist; p.fy = (p.y - other.y) / dist;
      tryBuild(room, p);
    }
    // sometimes detour when watched
    if (other && dist < 200 && Math.random() < 0.02) {
      p.botTarget = { x: 300 + crypto.randomInt(1000), y: 150 + crypto.randomInt(700), until: now + 1500 };
    }
    if (p.botTarget && p.botTarget.until && now < p.botTarget.until) {
      tx = p.botTarget.x; ty = p.botTarget.y;
    } else {
      p.botTarget = null;
      tx = MAP.vault.x + MAP.vault.w / 2;
      ty = MAP.vault.y + MAP.vault.h / 2;
    }
  } else {
    let best = null, bd = Infinity;
    for (const s of MAP.spots) {
      if (room.searched.has(s.id)) continue;
      const jitter = (p.id.charCodeAt(0) + s.id * 7) % 60 - 30;
      const d = Math.hypot(p.x - s.x, p.y - s.y) + jitter;
      if (d < bd) { bd = d; best = s; }
    }
    if (!best || Math.random() < 0.002) {
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
    avatar: [...room.players.values()].length % AVATARS.length,
    x: 0, y: 0, dx: 0, dy: 0, wins: 0,
    carrier: false, channel: null, searchProg: 0, depositProg: 0,
    frozenUntil: 0, exposeCdUntil: 0, searching: false,
    walls: WALLS_PER_ROUND, wallCdUntil: 0, shield: false,
    speedUntil: 0, revealUntil: 0, ghostUsed: false, ghostUntil: 0,
    gogglesUntil: 0, crouch: false,
    fx: 1, fy: 0, pauseUntil: 0, exposeAt: 0, adjacentSince: 0,
  };
  room.players.set(id, bot);
  ensureHost(room);
  lobbyState(room);
  return true;
}

// ---------------- HTTP + WebSocket ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.glb': 'model/gltf-binary' };

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok v4.2'); return; }
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/classic') urlPath = '/classic.html';
  const file = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(file);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext === '.html') headers['Cache-Control'] = 'no-cache, must-revalidate';
    else if (urlPath.startsWith('/models/') || urlPath.startsWith('/vendor/')) headers['Cache-Control'] = 'public, max-age=604800, immutable';
    res.writeHead(200, headers);
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
      if (op === 9) {
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
      avatar: room.players.size % AVATARS.length,
      x: 0, y: 0, dx: 0, dy: 0, wins: 0,
      carrier: false, channel: null, searchProg: 0, depositProg: 0,
      frozenUntil: 0, exposeCdUntil: 0, searching: false,
      walls: WALLS_PER_ROUND, wallCdUntil: 0, shield: false,
      speedUntil: 0, revealUntil: 0, ghostUsed: false, ghostUntil: 0,
      gogglesUntil: 0, crouch: false,
      fx: 1, fy: 0, pauseUntil: 0, exposeAt: 0, adjacentSince: 0,
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
    case 'avatar': {
      if (room.state !== 'lobby') break;
      const ai = Math.floor(Number(msg.a));
      if (ai >= 0 && ai < AVATARS.length && ![...room.players.values()].some(q => q.id !== player.id && q.avatar === ai)) {
        player.avatar = ai;
        lobbyState(room);
      }
      break;
    }
    case 'input':
      player.dx = Math.max(-1, Math.min(1, Number(msg.dx) || 0));
      player.dy = Math.max(-1, Math.min(1, Number(msg.dy) || 0));
      break;
    case 'crouch':
      player.crouch = !!msg.on;
      break;
    case 'search':
      trySearch(room, player);
      break;
    case 'expose':
      tryExpose(room, player);
      break;
    case 'build':
      tryBuild(room, player);
      break;
    case 'ghost':
      tryGhost(room, player);
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
