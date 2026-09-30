const path = require('path');
const fs = require('fs');
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
const TURN_TIME_MS = 15000;
const SUDDEN_DEATH_TIME_MS = 6000;
const SUDDEN_DEATH_THRESHOLD = 3;
const MATCH_WINS_NEEDED = 2;
const TIER_POINTS = { bronze: 1, silver: 2, gold: 3 };

app.use(express.static(path.join(__dirname, 'public')));

/** @type {Map<string, any>} */
const rooms = new Map();

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function newPlayer(id, name) {
  return { id, name, score: 0, connected: true, treasuresFound: 0, bombHits: 0 };
}

function createRoom(hostSocketId, hostName) {
  const code = makeRoomCode();
  const room = {
    code,
    hostId: hostSocketId,
    players: [newPlayer(hostSocketId, hostName)],
    spectators: [],
    gridSize: 8,
    treasureCount: 10,
    bombCount: 5,
    powerupCount: 3,
    grid: null,
    treasurePositions: null, // Map<cellIndex, tier>
    bombPositions: null, // Set<cellIndex>
    powerupPositions: null, // Map<cellIndex, kind>
    treasuresRemaining: 0,
    turnIndex: 0,
    turnDeadline: null,
    turnTimer: null,
    shields: new Map(), // playerId -> boolean
    roundNumber: 1,
    roundWins: {}, // playerId -> count
    matchOver: false,
    matchChampionId: null,
    status: 'lobby', // lobby | playing | finished
  };
  rooms.set(code, room);
  return room;
}

function pickTier(rand) {
  const r = rand();
  if (r < 0.1) return 'gold';
  if (r < 0.4) return 'silver';
  return 'bronze';
}

function generateBoard(room, rand = Math.random) {
  const size = room.gridSize;
  const total = size * size;
  const treasureCount = Math.min(room.treasureCount, total - 1);
  const remainingAfterTreasures = total - treasureCount;
  const bombCount = Math.min(room.bombCount, remainingAfterTreasures);
  const powerupCount = Math.min(room.powerupCount, remainingAfterTreasures - bombCount);

  const treasurePositions = new Map();
  while (treasurePositions.size < treasureCount) {
    const idx = Math.floor(rand() * total);
    if (!treasurePositions.has(idx)) treasurePositions.set(idx, pickTier(rand));
  }

  const bombPositions = new Set();
  while (bombPositions.size < bombCount) {
    const idx = Math.floor(rand() * total);
    if (!treasurePositions.has(idx) && !bombPositions.has(idx)) bombPositions.add(idx);
  }

  const powerupKinds = ['peek', 'extra-turn', 'shield'];
  const powerupPositions = new Map();
  while (powerupPositions.size < powerupCount) {
    const idx = Math.floor(rand() * total);
    if (!treasurePositions.has(idx) && !bombPositions.has(idx) && !powerupPositions.has(idx)) {
      powerupPositions.set(idx, powerupKinds[Math.floor(rand() * powerupKinds.length)]);
    }
  }

  return { treasurePositions, bombPositions, powerupPositions, treasureCount };
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  room.turnDeadline = null;
}

function scheduleTurnTimeout(room) {
  clearTurnTimer(room);
  if (room.status !== 'playing') return;
  const duration = room.treasuresRemaining <= SUDDEN_DEATH_THRESHOLD ? SUDDEN_DEATH_TIME_MS : TURN_TIME_MS;
  room.turnDeadline = Date.now() + duration;
  room.turnTimer = setTimeout(() => {
    if (room.status !== 'playing') return;
    advanceTurn(room);
    scheduleTurnTimeout(room);
    broadcastRoom(room);
  }, duration);
}

function startGame(room) {
  const size = room.gridSize;
  const board = generateBoard(room);

  room.treasurePositions = board.treasurePositions;
  room.bombPositions = board.bombPositions;
  room.powerupPositions = board.powerupPositions;
  room.treasuresRemaining = board.treasureCount;
  room.grid = Array.from({ length: size }, () => Array(size).fill(null));
  room.turnIndex = 0;
  room.shields = new Map();
  room.players.forEach((p) => {
    p.score = 0;
    p.treasuresFound = 0;
    p.bombHits = 0;
  });
  room.status = 'playing';
  scheduleTurnTimeout(room);
}

function finishRound(room) {
  clearTurnTimer(room);
  room.status = 'finished';

  let winnerId = null;
  let maxScore = -1;
  let tie = false;
  for (const p of room.players) {
    if (p.score > maxScore) {
      maxScore = p.score;
      winnerId = p.id;
      tie = false;
    } else if (p.score === maxScore) {
      tie = true;
    }
  }
  if (!tie && winnerId !== null) {
    room.roundWins[winnerId] = (room.roundWins[winnerId] || 0) + 1;
  }

  const champion = Object.entries(room.roundWins).find(([, wins]) => wins >= MATCH_WINS_NEEDED);
  if (champion) {
    room.matchOver = true;
    room.matchChampionId = champion[0];
  } else {
    room.matchOver = false;
  }
}

function computeWarmth(room, x, y) {
  let minDist = Infinity;
  for (const idx of room.treasurePositions.keys()) {
    const tx = idx % room.gridSize;
    const ty = Math.floor(idx / room.gridSize);
    const dist = Math.max(Math.abs(tx - x), Math.abs(ty - y));
    if (dist < minDist) minDist = dist;
  }
  if (minDist <= 1) return 3;
  if (minDist === 2) return 2;
  if (minDist === 3) return 1;
  return 0;
}

function publicRoomState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.connected,
      treasuresFound: p.treasuresFound,
      bombHits: p.bombHits,
      shielded: !!room.shields.get(p.id),
    })),
    spectators: room.spectators.map((s) => ({ id: s.id, name: s.name })),
    gridSize: room.gridSize,
    treasureCount: room.treasureCount,
    bombCount: room.bombCount,
    powerupCount: room.powerupCount,
    grid: room.grid,
    treasuresRemaining: room.treasuresRemaining,
    turnPlayerId: room.status === 'playing' ? room.players[room.turnIndex]?.id : null,
    turnDeadline: room.turnDeadline,
    suddenDeath: room.status === 'playing' && room.treasuresRemaining <= SUDDEN_DEATH_THRESHOLD,
    roundNumber: room.roundNumber,
    roundWins: room.roundWins,
    matchOver: room.matchOver,
    matchChampionId: room.matchChampionId,
    status: room.status,
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room:update', publicRoomState(room));
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

// --- Daily Challenge (solo, same seeded board for everyone each day) ---

const DAILY_GRID_SIZE = 8;
const DAILY_TREASURES = 10;
const DAILY_BOMBS = 8;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LEADERBOARD_PATH = path.join(DATA_DIR, 'leaderboard.json');

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

let dailyBoardCache = null;
function getDailyBoard() {
  const key = todayKey();
  if (dailyBoardCache && dailyBoardCache.key === key) return dailyBoardCache;
  const rand = mulberry32(hashStr(key));
  const board = generateBoard(
    { gridSize: DAILY_GRID_SIZE, treasureCount: DAILY_TREASURES, bombCount: DAILY_BOMBS, powerupCount: 0 },
    rand
  );
  dailyBoardCache = { key, size: DAILY_GRID_SIZE, ...board };
  return dailyBoardCache;
}

/** @type {Map<string, any>} */
const dailyGames = new Map();

function readLeaderboard() {
  try {
    return JSON.parse(fs.readFileSync(LEADERBOARD_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeLeaderboard(data) {
  fs.mkdirSync(path.dirname(LEADERBOARD_PATH), { recursive: true });
  fs.writeFileSync(LEADERBOARD_PATH, JSON.stringify(data, null, 2));
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

    room.players.push(newPlayer(socket.id, (name || 'Player').slice(0, 20)));
    socket.join(room.code);
    cb?.({ ok: true, room: publicRoomState(room) });
    broadcastRoom(room);
  });

  socket.on('room:spectate', ({ code, name }, cb) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    room.spectators.push({ id: socket.id, name: (name || 'Spectator').slice(0, 20) });
    socket.join(room.code);
    cb?.({ ok: true, room: publicRoomState(room), spectator: true });
    broadcastRoom(room);
  });

  socket.on('room:settings', ({ code, gridSize, treasureCount, bombCount, powerupCount }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;
    room.gridSize = Math.max(MIN_GRID_SIZE, Math.min(MAX_GRID_SIZE, Number(gridSize) || room.gridSize));
    const total = room.gridSize * room.gridSize;
    room.treasureCount = Math.max(1, Math.min(total - 1, Number(treasureCount) || room.treasureCount));
    const afterTreasures = total - room.treasureCount;
    room.bombCount = Math.max(0, Math.min(afterTreasures, Number.isFinite(Number(bombCount)) ? Number(bombCount) : room.bombCount));
    const afterBombs = afterTreasures - room.bombCount;
    room.powerupCount = Math.max(0, Math.min(afterBombs, Number.isFinite(Number(powerupCount)) ? Number(powerupCount) : room.powerupCount));
    broadcastRoom(room);
  });

  socket.on('room:start', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;
    if (room.players.length < 2) return;
    room.roundNumber = 1;
    room.roundWins = {};
    room.matchOver = false;
    room.matchChampionId = null;
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
    let bonusTurn = false;

    if (room.treasurePositions.has(cellIndex)) {
      const tier = room.treasurePositions.get(cellIndex);
      room.grid[y][x] = { type: 'treasure', tier };
      currentPlayer.score += TIER_POINTS[tier];
      currentPlayer.treasuresFound += 1;
      room.treasuresRemaining -= 1;
      room.treasurePositions.delete(cellIndex);
      bonusTurn = true;
    } else if (room.bombPositions.has(cellIndex)) {
      room.grid[y][x] = { type: 'bomb' };
      room.bombPositions.delete(cellIndex);
      currentPlayer.bombHits += 1;
      if (room.shields.get(currentPlayer.id)) {
        room.shields.set(currentPlayer.id, false);
      } else {
        currentPlayer.score = Math.max(0, currentPlayer.score - 1);
      }
    } else if (room.powerupPositions.has(cellIndex)) {
      const kind = room.powerupPositions.get(cellIndex);
      room.grid[y][x] = { type: 'powerup', kind };
      room.powerupPositions.delete(cellIndex);

      if (kind === 'extra-turn') {
        bonusTurn = true;
      } else if (kind === 'shield') {
        room.shields.set(currentPlayer.id, true);
      } else if (kind === 'peek') {
        const hidden = [];
        for (let yy = 0; yy < room.gridSize; yy++) {
          for (let xx = 0; xx < room.gridSize; xx++) {
            if (room.grid[yy][xx] === null) hidden.push({ x: xx, y: yy });
          }
        }
        if (hidden.length) {
          const target = hidden[Math.floor(Math.random() * hidden.length)];
          const idx2 = target.y * room.gridSize + target.x;
          let content = { type: 'empty' };
          if (room.treasurePositions.has(idx2)) content = { type: 'treasure', tier: room.treasurePositions.get(idx2) };
          else if (room.bombPositions.has(idx2)) content = { type: 'bomb' };
          else if (room.powerupPositions.has(idx2)) content = { type: 'powerup', kind: room.powerupPositions.get(idx2) };
          io.to(currentPlayer.id).emit('game:peek', { x: target.x, y: target.y, content });
        }
      }
    } else {
      room.grid[y][x] = { type: 'empty', warmth: computeWarmth(room, x, y) };
    }

    if (!bonusTurn) advanceTurn(room);

    if (room.treasuresRemaining <= 0) {
      finishRound(room);
    } else {
      scheduleTurnTimeout(room);
    }

    broadcastRoom(room);
  });

  socket.on('game:reaction', ({ code, emoji }) => {
    const room = rooms.get(code);
    if (!room) return;
    const sender = room.players.find((p) => p.id === socket.id) || room.spectators.find((s) => s.id === socket.id);
    if (!sender) return;
    io.to(room.code).emit('game:reaction', { name: sender.name, emoji: String(emoji || '').slice(0, 8) });
  });

  socket.on('room:rematch', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id || room.status !== 'finished') return;

    if (room.matchOver) {
      room.status = 'lobby';
      room.grid = null;
      room.treasurePositions = null;
      room.bombPositions = null;
      room.powerupPositions = null;
      room.roundNumber = 1;
      room.roundWins = {};
      room.matchOver = false;
      room.matchChampionId = null;
    } else {
      room.roundNumber += 1;
      startGame(room);
    }
    broadcastRoom(room);
  });

  // --- Daily Challenge ---

  socket.on('daily:start', (_payload, cb) => {
    const board = getDailyBoard();
    const state = {
      boardKey: board.key,
      grid: Array.from({ length: board.size }, () => Array(board.size).fill(null)),
      remainingTreasures: new Set(board.treasurePositions.keys()),
      score: 0,
      treasuresFound: 0,
      bombHits: 0,
      finished: false,
    };
    dailyGames.set(socket.id, state);
    cb?.({
      ok: true,
      size: board.size,
      grid: state.grid,
      score: state.score,
      totalTreasures: board.treasurePositions.size,
      treasuresRemaining: state.remainingTreasures.size,
      finished: false,
    });
  });

  socket.on('daily:reveal', ({ x, y }, cb) => {
    const state = dailyGames.get(socket.id);
    const board = getDailyBoard();
    if (!state || state.finished || state.boardKey !== board.key) return cb?.({ ok: false });
    if (x < 0 || y < 0 || x >= board.size || y >= board.size) return cb?.({ ok: false });
    if (state.grid[y][x] !== null) return cb?.({ ok: false });

    const idx = y * board.size + x;
    let cell;
    if (board.treasurePositions.has(idx) && state.remainingTreasures.has(idx)) {
      const tier = board.treasurePositions.get(idx);
      cell = { type: 'treasure', tier };
      state.score += TIER_POINTS[tier];
      state.treasuresFound += 1;
      state.remainingTreasures.delete(idx);
    } else if (board.bombPositions.has(idx)) {
      cell = { type: 'bomb' };
      state.bombHits += 1;
      state.score = Math.max(0, state.score - 1);
    } else {
      cell = { type: 'empty' };
    }
    state.grid[y][x] = cell;

    if (state.remainingTreasures.size === 0) state.finished = true;

    cb?.({
      ok: true,
      cell,
      score: state.score,
      treasuresRemaining: state.remainingTreasures.size,
      finished: state.finished,
    });
  });

  socket.on('daily:submit', ({ name }, cb) => {
    const state = dailyGames.get(socket.id);
    if (!state) return cb?.({ ok: false, error: 'No active daily game' });
    const key = todayKey();
    const board = readLeaderboard();
    board[key] = board[key] || [];
    board[key].push({ name: (name || 'Player').slice(0, 20), score: state.score, at: Date.now() });
    board[key].sort((a, b) => b.score - a.score);
    board[key] = board[key].slice(0, 50);
    writeLeaderboard(board);
    cb?.({ ok: true, leaderboard: board[key].slice(0, 10) });
  });

  socket.on('daily:leaderboard', (_payload, cb) => {
    const key = todayKey();
    const board = readLeaderboard();
    cb?.({ ok: true, leaderboard: (board[key] || []).slice(0, 10) });
  });

  socket.on('disconnect', () => {
    dailyGames.delete(socket.id);

    for (const room of rooms.values()) {
      const specIdx = room.spectators.findIndex((s) => s.id === socket.id);
      if (specIdx !== -1) {
        room.spectators.splice(specIdx, 1);
        broadcastRoom(room);
        continue;
      }

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
          clearTurnTimer(room);
          rooms.delete(room.code);
          continue;
        }
        if (room.players[room.turnIndex]?.id === socket.id) {
          room.turnIndex = nextConnectedIndexFrom(room, room.turnIndex);
          scheduleTurnTimeout(room);
        }
      }

      broadcastRoom(room);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Treasure Grid server listening on http://localhost:${PORT}`);
});
