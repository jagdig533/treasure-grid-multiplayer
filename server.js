const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;
const MIN_GRID_SIZE = 5;
const MAX_GRID_SIZE = 15;
const MAX_PLAYERS = 6;

app.use(express.static(path.join(__dirname, 'public')));

/** @type {Map<string, Room>} */
const rooms = new Map();

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(hostSocketId, hostName) {
  const code = makeRoomCode();
  const room = {
    code,
    hostId: hostSocketId,
    players: [{ id: hostSocketId, name: hostName, score: 0, connected: true }],
    gridSize: 8,
    treasureCount: 10,
    bombCount: 5,
    grid: null, // revealed by [x][y]: null = hidden, 'treasure' | 'empty' | 'bomb'
    treasurePositions: null,
    bombPositions: null,
    treasuresRemaining: 0,
    turnIndex: 0,
    status: 'lobby', // lobby | playing | finished
  };
  rooms.set(code, room);
  return room;
}

function publicRoomState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    players: room.players.map((p) => ({ id: p.id, name: p.name, score: p.score, connected: p.connected })),
    gridSize: room.gridSize,
    treasureCount: room.treasureCount,
    bombCount: room.bombCount,
    grid: room.grid,
    treasuresRemaining: room.treasuresRemaining,
    turnPlayerId: room.status === 'playing' ? room.players[room.turnIndex]?.id : null,
    status: room.status,
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room:update', publicRoomState(room));
}

function startGame(room) {
  const size = room.gridSize;
  const total = size * size;
  const treasureCount = Math.min(room.treasureCount, total - 1);
  const bombCount = Math.min(room.bombCount, total - treasureCount);

  const treasurePositions = new Set();
  while (treasurePositions.size < treasureCount) {
    treasurePositions.add(Math.floor(Math.random() * total));
  }

  const bombPositions = new Set();
  while (bombPositions.size < bombCount) {
    const candidate = Math.floor(Math.random() * total);
    if (!treasurePositions.has(candidate)) bombPositions.add(candidate);
  }

  room.treasurePositions = treasurePositions;
  room.bombPositions = bombPositions;
  room.treasuresRemaining = treasureCount;
  room.grid = Array.from({ length: size }, () => Array(size).fill(null));
  room.turnIndex = 0;
  room.players.forEach((p) => (p.score = 0));
  room.status = 'playing';
}

function advanceTurn(room) {
  const active = room.players.filter((p) => p.connected);
  if (active.length === 0) return;
  let next = room.turnIndex;
  do {
    next = (next + 1) % room.players.length;
  } while (!room.players[next].connected);
  room.turnIndex = next;
}

function nextConnectedIndexFrom(room, startIndex) {
  const n = room.players.length;
  for (let i = 0; i < n; i++) {
    const idx = (startIndex + i) % n;
    if (room.players[idx].connected) return idx;
  }
  return startIndex;
}

io.on('connection', (socket) => {
  socket.on('room:create', ({ name }, cb) => {
    const room = createRoom(socket.id, (name || 'Host').slice(0, 20));
    socket.join(room.code);
    cb?.({ ok: true, room: publicRoomState(room) });
  });

  socket.on('room:join', ({ code, name }, cb) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    if (room.status !== 'lobby') return cb?.({ ok: false, error: 'Game already started' });
    if (room.players.length >= MAX_PLAYERS) return cb?.({ ok: false, error: 'Room is full' });

    room.players.push({ id: socket.id, name: (name || 'Player').slice(0, 20), score: 0, connected: true });
    socket.join(room.code);
    cb?.({ ok: true, room: publicRoomState(room) });
    broadcastRoom(room);
  });

  socket.on('room:settings', ({ code, gridSize, treasureCount, bombCount }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;
    room.gridSize = Math.max(MIN_GRID_SIZE, Math.min(MAX_GRID_SIZE, Number(gridSize) || room.gridSize));
    const total = room.gridSize * room.gridSize;
    room.treasureCount = Math.max(1, Math.min(total - 1, Number(treasureCount) || room.treasureCount));
    const maxBombs = total - room.treasureCount;
    room.bombCount = Math.max(0, Math.min(maxBombs, Number.isFinite(Number(bombCount)) ? Number(bombCount) : room.bombCount));
    broadcastRoom(room);
  });

  socket.on('room:start', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;
    if (room.players.length < 2) return;
    startGame(room);
    broadcastRoom(room);
  });

  socket.on('game:reveal', ({ code, x, y }) => {
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return;

    const currentPlayer = room.players[room.turnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) return;
    if (x < 0 || y < 0 || x >= room.gridSize || y >= room.gridSize) return;
    if (room.grid[y][x] !== null) return;

    const cellIndex = y * room.gridSize + x;
    const isTreasure = room.treasurePositions.has(cellIndex);
    const isBomb = room.bombPositions.has(cellIndex);

    room.grid[y][x] = isTreasure ? 'treasure' : isBomb ? 'bomb' : 'empty';

    if (isTreasure) {
      currentPlayer.score += 1;
      room.treasuresRemaining -= 1;
      room.treasurePositions.delete(cellIndex);
    } else if (isBomb) {
      currentPlayer.score = Math.max(0, currentPlayer.score - 1);
      room.bombPositions.delete(cellIndex);
      advanceTurn(room);
    } else {
      advanceTurn(room);
    }

    if (room.treasuresRemaining <= 0) {
      room.status = 'finished';
    }

    broadcastRoom(room);
  });

  socket.on('room:rematch', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id || room.status !== 'finished') return;
    room.status = 'lobby';
    room.grid = null;
    room.treasurePositions = null;
    room.bombPositions = null;
    broadcastRoom(room);
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const player = room.players.find((p) => p.id === socket.id);
      if (!player) continue;

      player.connected = false;

      if (room.status === 'lobby') {
        room.players = room.players.filter((p) => p.id !== socket.id);
        if (room.players.length === 0) {
          rooms.delete(room.code);
          continue;
        }
        if (room.hostId === socket.id) {
          room.hostId = room.players[0].id;
        }
      } else if (room.status === 'playing') {
        if (room.players.every((p) => !p.connected)) {
          rooms.delete(room.code);
          continue;
        }
        if (room.players[room.turnIndex]?.id === socket.id) {
          room.turnIndex = nextConnectedIndexFrom(room, room.turnIndex);
        }
      }

      broadcastRoom(room);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Treasure Grid server listening on http://localhost:${PORT}`);
});
