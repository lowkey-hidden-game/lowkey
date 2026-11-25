// measures botThink + tick cost with a full room of 7 hard bots
const path = process.argv[2] || './server.js';
const S = require(path);
const room = S.makeRoom('BENCH');
S.rooms.set('BENCH', room);
for (let i = 0; i < 7; i++) S.addBot(room);
for (const q of room.players.values()) q.ai = S.AI_LEVELS.hard;
S.startRound(room);
const bots = [...room.players.values()];
// warmup
for (let i = 0; i < 2000; i++) for (const p of bots) S.botThink(room, p, 0.05);
let t0 = process.hrtime.bigint();
const N = 20000;
for (let i = 0; i < N; i++) for (const p of bots) S.botThink(room, p, 0.05);
let t1 = process.hrtime.bigint();
const perThink = Number(t1 - t0) / (N * bots.length);
t0 = process.hrtime.bigint();
const M = 20000;
for (let i = 0; i < M; i++) S.tick(room, 0.05);
t1 = process.hrtime.bigint();
const perTick = Number(t1 - t0) / M;
const mem = process.memoryUsage().heapUsed / 1048576;
console.log(JSON.stringify({ botThink_us: +(perThink / 1000).toFixed(2), tick_us: +(perTick / 1000).toFixed(2), tickBudget_us: 50000, heapMB: +mem.toFixed(1) }));
