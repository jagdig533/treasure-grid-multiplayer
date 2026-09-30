# Treasure Grid

A turn-based multiplayer treasure hunt. One shared grid, hidden treasures — players take turns
revealing cells. Find a treasure, score a point and go again; reveal an empty cell and the turn
passes to the next player. Most treasures found when the grid is cleared wins.

## Running locally

```bash
npm install
npm start
```

Then open http://localhost:3000 in a few browser tabs (or share your local network address with
friends) to play.

- One player creates a room and shares the 4-letter room code.
- Others join with that code.
- The host sets grid size and treasure count, then starts the game.
- Players take turns clicking cells on the grid.

## Tech stack

- Node.js + Express (static file serving)
- Socket.IO (real-time turn sync)
- Vanilla HTML/CSS/JS + Canvas (client rendering)
