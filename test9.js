// v4.6 test: per-bot memory fairness - sight only, ghost-blind, isolated, decaying.
const S = require('./server.js');
const PLAYER_SPEED_TEST = 170;
const { rooms, MAP, AI_LEVELS, makeRoom, addBot, botThink, botSense, hasLOS, BOT_SIGHT } = S;
const results = [];
function check(name, ok, extra) { results.push({name, ok}); console.log((ok?'PASS':'FAIL')+' | '+name+(extra?' | '+extra:'')); }

function mkRoom() {
  const code = 'T' + Math.random().toString(36).slice(2, 5).toUpperCase();
  const room = makeRoom(code);
  rooms.set(code, room);
  return room;
}
function fakeHuman(room, id, x, y) {
  const p = { id, ws: null, bot: false, room, name: 'هـ' + id, avatar: 0,
    x, y, dx: 0, dy: 0, fx: 1, fy: 0, wins: 0, carrier: false, channel: null,
    searchProg: 0, depositProg: 0, frozenUntil: 0, exposeCdUntil: 0, searching: false,
    walls: 3, wallCdUntil: 0, shield: false, speedUntil: 0, revealUntil: 0,
    ghostUsed: false, ghostUntil: 0, gogglesUntil: 0, crouch: false,
    pauseUntil: 0, exposeAt: 0, adjacentSince: 0, gone: false };
  room.players.set(id, p);
  return p;
}
function probe(bot, spot, tries) {
  const room = bot.room;
  for (let i = 0; i < (tries || 40); i++) {
    bot.stuck = 0; bot.lastX = undefined; bot.pauseUntil = 0;
    botThink(room, bot, 0.05);
    if (bot.dx || bot.dy) break;
  }
  return bot.lastGoal && Math.hypot(bot.lastGoal.x - spot.x, bot.lastGoal.y - spot.y) < 5;
}
function mkBot(room, level, x, y) {
  addBot(room);
  const bot = [...room.players.values()].filter(q => q.bot).pop();
  bot.ai = AI_LEVELS[level];
  bot.x = x; bot.y = y;
  botSense(room, bot, Date.now()); // creates the memory store
  return bot;
}
// a wall to hide behind, and clear ground on both sides of its thin axis
const wall = MAP.walls.find(w => w.h >= 2 * w.w && w.x > 300 && w.x + w.w < MAP.w - 300) || MAP.walls.find(w => w.h >= 2 * w.w) || MAP.walls[0];
let L, R;
if (wall.h >= wall.w) {
  L = { x: wall.x - 40, y: wall.y + wall.h / 2 };
  R = { x: wall.x + wall.w + 40, y: wall.y + wall.h / 2 };
} else {
  L = { x: wall.x + wall.w / 2, y: wall.y - 40 };
  R = { x: wall.x + wall.w / 2, y: wall.y + wall.h + 40 };
}

// 1) no line of sight -> no memory at all
{
  const room = mkRoom();
  const b = mkBot(room, 'hard', L.x, L.y);
  const h = fakeHuman(room, 'h1', R.x, R.y);
  botSense(room, b, Date.now());
  check('wall blocks sight: no memory formed', !b.mem.players.h1);
  check('hasLOS false through wall', !hasLOS(room, L.x, L.y, R.x, R.y));
}
// 2) ghosted player is invisible to bots
{
  const room = mkRoom();
  const b = mkBot(room, 'hard', 600, 360);
  const h = fakeHuman(room, 'h2', 700, 360);
  h.ghostUntil = Date.now() + 5000;
  botSense(room, b, Date.now());
  check('ghosted player leaves no trace', !b.mem.players.h2);
}
// 3) visible player: position, direction and route recorded
{
  const room = mkRoom();
  const b = mkBot(room, 'hard', 600, 360);
  const h = fakeHuman(room, 'h3', 700, 400);
  h.fx = 0.6; h.fy = -0.8;
  botSense(room, b, Date.now());
  const e = b.mem.players.h3;
  check('visible player remembered with heading', !!e && e.x === 700 && e.vx === 0.6);
  check('route cells recorded', (b.mem.routes.h3 || []).length === 1);
}
// 4) memories are independent per bot
{
  const room = mkRoom();
  const b1 = mkBot(room, 'hard', 600, 360);
  const b2 = mkBot(room, 'hard', 60, 60);
  fakeHuman(room, 'h4', 700, 400);
  botSense(room, b1, Date.now());
  botSense(room, b2, Date.now());
  check('bot A knowledge never leaks to bot B', !!b1.mem.players.h4 && !b2.mem.players.h4);
}
// 5) easy bots ignore sight-learned spot info; hard bots use it
{
  const room = mkRoom();
  const spot = MAP.spots[0];
  const be = mkBot(room, 'easy', spot.x + 260, spot.y);
  const bh = mkBot(room, 'hard', spot.x + 260, spot.y);
  be.mem.spots[spot.id] = { searched: true, at: Date.now() };       // learned by sight
  bh.mem.spots[spot.id] = { searched: true, at: Date.now() };
  be.pauseUntil = 0; bh.pauseUntil = 0;
  be.mem.players = {}; bh.mem.players = {};
  room.players.delete(bh.id);
  const easyGoes = probe(be, spot);
  room.players.set(bh.id, bh); room.players.delete(be.id);
  const hardAvoids = !probe(bh, spot);
  check('easy bot still walks to a spot it merely SAW searched', easyGoes);
  check('hard bot avoids a spot it saw searched', hardAvoids);
}
// 6) memory decays: old info is forgotten
{
  const room = mkRoom();
  const spot = MAP.spots[0];
  const bh = mkBot(room, 'hard', spot.x + 260, spot.y);
  bh.mem.spots[spot.id] = { searched: true, at: Date.now() - (AI_LEVELS.hard.memSec + 5) * 1000 };
  check('hard bot forgets after memory expires', probe(bh, spot));
}
// 7) own searches are remembered by every level
{
  const room = mkRoom();
  const spot = MAP.spots[0];
  const be = mkBot(room, 'easy', spot.x + 260, spot.y);
  be.mem.spots[spot.id] = { searched: true, at: Date.now(), self: true };
  check('easy bot never re-searches its own box', !probe(be, spot));
}
// 8) hard bot leads a moving target (prediction), easy never investigates
{
  const room = mkRoom();
  const bh = mkBot(room, 'hard', 600, 360);
  const be = mkBot(room, 'easy', 600, 360);
  const now = Date.now();
  const mem = { x: 900, y: 360, vx: 1, vy: 0, at: now - 1000 };
  bh.mem.players.hX = { ...mem }; be.mem.players.hX = { ...mem };
  bh.mem.spots = Object.fromEntries(MAP.spots.map(s => [s.id, { searched: true, at: now, self: true }]));
  be.mem.spots = Object.fromEntries(MAP.spots.map(s => [s.id, { searched: true, at: now, self: true }]));
  let hardLed = false;
  for (let i = 0; i < 400 && !hardLed; i++) {
    bh.botTarget = null; bh.stuck = 0; bh.lastX = undefined; bh.pauseUntil = 0;
    botThink(room, bh, 0.05);
    if (bh.botTarget && bh.botTarget.x > mem.x + 50) hardLed = true; // ahead of last seen
  }
  let easyInvestigated = false;
  for (let i = 0; i < 200; i++) {
    const had = be.botTarget;
    be.stuck = 0; be.lastX = undefined; be.pauseUntil = 0;
    botThink(room, be, 0.05);
    if (be.botTarget && be.botTarget.until && be.botTarget !== had) easyInvestigated = true;
  }
  check('hard bot pursues ahead of last seen position', hardLed);
  check('easy bot never investigates memories', !easyInvestigated);
}
// 9) pattern intercept: hard bot cuts off a repeated route
{
  const room = mkRoom();
  const bh = mkBot(room, 'hard', 100, 100);
  const now = Date.now();
  bh.mem.players.hY = { x: 500, y: 300, vx: 0, vy: 1, at: now };
  bh.mem.routes.hY = ['2,1', '3,1', '2,1', '3,1'];
  bh.mem.spots = Object.fromEntries(MAP.spots.map(s => [s.id, { searched: true, at: now, self: true }]));
  bh.botTarget = null;
  botThink(room, bh, 0.05);
  const t = bh.botTarget;
  const inCell = t && ((t.x === 2 * 200 + 100 && t.y === 1 * 200 + 100) || (t.x === 3 * 200 + 100 && t.y === 1 * 200 + 100));
  check('hard bot intercepts a repeated route', !!inCell, JSON.stringify(t));
}

// 10) gradual trick-learning: deception never stops working entirely
{
  const room = mkRoom();
  const bh = mkBot(room, 'hard', 600, 360);
  const now = Date.now();
  bh.mem.players.hZ = { x: 900, y: 360, vx: 1, vy: 0, at: now - 1000 };
  bh.mem.jukedBy.hZ = 10; // a notorious trickster
  bh.mem.spots = Object.fromEntries(MAP.spots.map(s => [s.id, { searched: true, at: now, self: true }]));
  let countered = 0, normal = 0;
  for (let i = 0; i < 8000 && (countered + normal) < 150; i++) {
    bh.botTarget = null; bh.stuck = 0; bh.lastX = undefined; bh.pauseUntil = 0;
    botThink(room, bh, 0.05);
    if (bh.botTarget && bh.botTarget.until) {
      if (bh.botTarget.x > 900 + PLAYER_SPEED_TEST * 2) countered++; else normal++;
    }
  }
  const total = countered + normal;
  const ratio = countered / total;
  check('hard bot counters a trickster often but not always', total > 20 && ratio > 0.45 && ratio < 0.95,
    'countered=' + countered + '/' + total);
}
// 11) two players vanish behind a wall in opposite directions: memories stay independent
{
  const room = mkRoom();
  const wy = wall.y + wall.h / 2;
  const b = mkBot(room, 'hard', wall.x - 120, wy);
  const h1 = fakeHuman(room, 'p1', wall.x - 60, wy);
  const h2 = fakeHuman(room, 'p2', wall.x - 90, wy);
  h1.fx = 1; h1.fy = 0;   // p1 last seen heading east (around the wall)
  h2.fx = -1; h2.fy = 0;  // p2 last seen heading west (away from it)
  const t0 = Date.now();
  botSense(room, b, t0);
  const e1 = b.mem.players.p1, e2 = b.mem.players.p2;
  check('both players seen with their own headings', !!e1 && !!e2 && e1.vx === 1 && e2.vx === -1);
  // both slip out of sight in opposite directions
  h1.x = wall.x + wall.w + 60; h1.y = wy;   // actually went east, behind the wall
  h2.x = wall.x - 500; h2.y = wy;           // actually went far west
  botSense(room, b, t0 + 3000);
  const m1 = b.mem.players.p1, m2 = b.mem.players.p2;
  check('no new sight: bot does not know where either one went',
    m1.x === wall.x - 60 && m2.x === wall.x - 90, JSON.stringify({m1: m1.x, m2: m2.x, real1: h1.x, real2: h2.x}));
  check('memories independent: p1 memory still east, p2 still west', m1.vx === 1 && m2.vx === -1);
  // inference: the bot pursues p1 from ITS memory (stale + heading), not p1's real spot
  m1.at = Date.now(); m2.at = Date.now() - 8000; // p1 the fresher suspect
  b.mem.spots = Object.fromEntries(MAP.spots.map(s => [s.id, { searched: true, at: Date.now(), self: true }]));
  let target = null;
  for (let i = 0; i < 600 && !target; i++) {
    b.botTarget = null; b.stuck = 0; b.lastX = undefined; b.pauseUntil = 0;
    botThink(room, b, 0.05);
    if (b.botTarget && b.botTarget.until) target = { ...b.botTarget };
  }
  // normal prediction lands <= lastSeen + 170*1.4; a grown suspicion may cut up to 170*2.5 ahead
  const nearP1Memory = target && Math.abs(target.y - wy) < 120 && target.x > m1.x - 30 && target.x < m1.x + 170 * 2.6;
  const notReal = target && Math.abs(target.x - h1.x) > 10;
  check('bot infers from stale memory, not real position', !!target && nearP1Memory && notReal,
    JSON.stringify({target, memP1: m1.x, realP1: h1.x}));
}
const failed = results.filter(r => !r.ok);
console.log(failed.length ? 'FAILURES: ' + failed.map(f => f.name).join(', ') : 'ALL TESTS PASSED');
process.exit(failed.length ? 1 : 0);
