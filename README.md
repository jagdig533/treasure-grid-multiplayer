# Treasure Grid

A turn-based multiplayer treasure hunt. One shared grid, hidden treasures, bombs, and power-ups —
players take turns revealing cells.

- **Treasure** (bronze/silver/gold) scores 1/2/3 points and grants a bonus turn.
- **Bomb** costs a point (floored at 0) and ends your turn immediately — unless you're shielded.
- **Power-up**: 👁️ peek (privately reveals a random hidden cell), ⏩ extra turn, 🛡️ shield (blocks
  your next bomb penalty).
- Revealed empty cells show a 🔥 "warmth" hint based on distance to the nearest remaining treasure.
- Turns are timed (15s, or 6s once only a few treasures remain — **Sudden Death**).
- Matches are best-of-3 rounds; the finished screen shows round-by-round wins, MVP (most treasures
  found) and Biggest Gambler (most bombs hit) awards, and a "Copy Result" button.
- Spectators can watch a room live without playing.
- Send emoji reactions mid-game.
- Your win/loss record and lifetime treasures are saved locally (localStorage) and unlock cosmetic
  themes (Forest at 5 matches, Neon at 15).
- **Daily Challenge**: a solo puzzle with the same seeded board for everyone each day, with a
  shared leaderboard.

## Running locally

```bash
npm install
npm start
```

Then open http://localhost:3000 in a few browser tabs (or share your local network address with
friends) to play.

- One player creates a room and shares the 4-letter room code.
- Others join with that code, or watch as a spectator.
- The host sets grid size, treasure/bomb/power-up counts, then starts the game.
- Players take turns clicking cells on the grid until someone wins a best-of-3 match.

## Tech stack

- Node.js + Express (static file serving + a small JSON-file leaderboard for Daily Challenge)
- Socket.IO (real-time turn sync)
- Vanilla HTML/CSS/JS + Canvas (client rendering, animation, and Web Audio sound effects)
