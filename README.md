# Lowkey

Ibrahim's game: one hidden item, players search, the finder secretly carries it
to the vault while everyone else tries to expose them. Zero-dependency Node.js
server + single-page mobile client (Arabic, RTL).

## Run locally

```bash
node server.js          # listens on :8080 (or PORT env)
```

Open `http://localhost:8080` — create a room, share the 4-letter code or the
link, add bots if you're short on players, host taps start.

## Deploy on the free VPS (Ubuntu)

```bash
# copy the folder to the VPS, then:
cd hidden-game
PORT=80 nohup node server.js > game.log 2>&1 &
```

Players open `http://<vps-ip>` in their phone browsers. No build step, no npm
install, no database. One port carries both the page and the WebSocket.

Optional env vars: `PORT` (default 8080), `ROUND_SECONDS` (default 180).

## Game rules (v1)

- 3-10 players per room (bots count); 4-letter room codes + shareable link.
- Map: 8 hiding spots, 1 vault zone. Treasure spawns in a random spot each round.
- Searching a spot takes 2.5s standing next to it; everyone sees the searching
  animation, but only the finder learns whether the treasure was there.
- Carrier must stand in the vault for 4s to win. Carrier moves ~13% slower
  (a subtle tell for sharp-eyed hunters).
- Expose: tap a nearby player. Right = you win the round instantly.
  Wrong = you're frozen 12s and can't expose again for 30s.
- Round timer 3 minutes. Wins accumulate across rounds in the room.

## Tests

`test.js` (full round with bots) and `test2.js` (deterministic mechanics with
`FORCE_SPOT=0`): join/lobby/start, state sync, search, secret carrier flag,
correct/wrong expose, freeze penalty, deposit win, timeout, carrier leaving,
return to lobby, second round. All passing.
