const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { io } = require('socket.io-client');

const TEST_PORT = 3999;
const URL = `http://localhost:${TEST_PORT}`;
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treasure-grid-test-'));

let serverProcess;

before(async () => {
  serverProcess = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(TEST_PORT), DATA_DIR: TEST_DATA_DIR },
    stdio: 'pipe',
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start in time')), 10000);
    serverProcess.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProcess.on('error', reject);
  });
});

after(() => {
  serverProcess?.kill();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function connect() {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'] });
    s.once('connect', () => resolve(s));
  });
}

function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('room settings clamp to grid capacity', async () => {
  const a = await connect();
  const createRes = await emit(a, 'room:create', { name: 'Alice' });
  assert.equal(createRes.ok, true);
  const code = createRes.room.code;

  a.emit('room:settings', { code, gridSize: 6, treasureCount: 100, bombCount: 100, powerupCount: 100 });
  await sleep(100);

  let latest = null;
  a.on('room:update', (room) => { latest = room; });
  a.emit('room:settings', { code, gridSize: 6, treasureCount: 100, bombCount: 100, powerupCount: 100 });
  await sleep(150);

  const total = latest.gridSize * latest.gridSize;
  assert.ok(latest.treasureCount + latest.bombCount + latest.powerupCount <= total,
    'treasure+bomb+powerup counts must never exceed total grid cells');

  a.disconnect();
});

test('full match: tiers, bombs, shields, powerups, best-of-3 round tracking', async () => {
  const a = await connect();
  const b = await connect();

  const createRes = await emit(a, 'room:create', { name: 'Alice' });
  const code = createRes.room.code;
  await emit(b, 'room:join', { code, name: 'Bob' });

  let latest = null;
  const peeks = [];
  a.on('room:update', (room) => { latest = room; });
  b.on('room:update', (room) => { latest = room; });
  a.on('game:peek', (p) => peeks.push(p));
  b.on('game:peek', (p) => peeks.push(p));

  // dense board so tiers/bombs/shields/powerups all get exercised within one pass
  a.emit('room:settings', { code, gridSize: 6, treasureCount: 15, bombCount: 12, powerupCount: 8 });
  await sleep(150);

  a.emit('room:start', { code });
  await sleep(200);
  assert.equal(latest.status, 'playing');
  assert.ok(latest.turnDeadline !== null, 'turn deadline should be set once play begins');
  assert.equal(latest.roundNumber, 1);

  const size = latest.gridSize;
  const seenTiers = new Set();
  let bombHits = 0, treasureHits = 0, shieldSaves = 0, powerupHits = 0;

  for (let round = 0; round < size * size; round++) {
    if (latest.status !== 'playing') break;
    const turnPlayerId = latest.turnPlayerId;
    const actor = turnPlayerId === a.id ? a : b;

    let target = null;
    outer:
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (latest.grid[y][x] === null) { target = { x, y }; break outer; }
      }
    }
    if (!target) break;

    const before = JSON.parse(JSON.stringify(latest));
    const wasShielded = before.players.find((p) => p.id === turnPlayerId)?.shielded;

    actor.emit('game:reveal', { code, x: target.x, y: target.y });
    await sleep(30);

    const cell = latest.grid[target.y][target.x];
    if (!cell) continue;

    if (cell.type === 'treasure') {
      treasureHits++;
      seenTiers.add(cell.tier);
    } else if (cell.type === 'bomb') {
      bombHits++;
      const afterScore = latest.players.find((p) => p.id === turnPlayerId).score;
      const beforeScore = before.players.find((p) => p.id === turnPlayerId).score;
      if (wasShielded) {
        shieldSaves++;
        assert.equal(afterScore, beforeScore, 'shield must fully negate a bomb score penalty');
      } else {
        assert.equal(afterScore, Math.max(0, beforeScore - 1), 'bomb must cost exactly 1 point, floored at 0');
      }
    } else if (cell.type === 'powerup') {
      powerupHits++;
    }
  }

  assert.ok(bombHits > 0, 'expected at least one bomb hit across a dense board');
  assert.ok(treasureHits > 0, 'expected at least one treasure hit across a dense board');
  assert.ok(seenTiers.size >= 1, 'expected treasure tiers to appear');
  assert.ok(powerupHits > 0, 'expected at least one powerup to trigger');
  assert.equal(latest.status, 'finished', 'round should finish once all treasures are found');

  const roundOneWinner = Object.keys(latest.roundWins)[0];
  assert.ok(roundOneWinner, 'a round winner should be recorded');

  if (!latest.matchOver) {
    a.emit('room:rematch', { code });
    await sleep(200);
    assert.equal(latest.status, 'playing', 'next round should start immediately, not return to lobby');
    assert.equal(latest.roundNumber, 2);
    assert.ok(latest.players.every((p) => p.score === 0), 'scores should reset for the new round');
  }

  a.disconnect();
  b.disconnect();
});

test('spectators can watch without playing', async () => {
  const a = await connect();
  const spectator = await connect();

  const createRes = await emit(a, 'room:create', { name: 'Alice' });
  const code = createRes.room.code;

  const specRes = await emit(spectator, 'room:spectate', { code, name: 'Watcher' });
  assert.equal(specRes.ok, true);
  assert.equal(specRes.spectator, true);
  assert.equal(specRes.room.spectators.length, 1);
  assert.equal(specRes.room.spectators[0].name, 'Watcher');

  a.disconnect();
  spectator.disconnect();
});

test('daily challenge gives everyone the same seeded board and accepts leaderboard submissions', async () => {
  const a = await connect();
  const b = await connect();

  const resA = await emit(a, 'daily:start', {});
  const resB = await emit(b, 'daily:start', {});
  assert.equal(resA.ok, true);
  assert.equal(resA.size, 8);
  assert.equal(resA.totalTreasures, resB.totalTreasures, 'same day must produce the same board for every player');

  let found = 0, submittedScore = 0;
  for (let y = 0; y < 8 && found < 10; y++) {
    for (let x = 0; x < 8; x++) {
      const r = await emit(a, 'daily:reveal', { x, y });
      if (r.ok && r.cell.type === 'treasure') found++;
      if (r.ok) submittedScore = r.score;
      if (r.ok && r.finished) break;
    }
  }

  const submitRes = await emit(a, 'daily:submit', { name: 'TestPlayer' });
  assert.equal(submitRes.ok, true);

  const lbRes = await emit(a, 'daily:leaderboard', {});
  assert.equal(lbRes.ok, true);
  assert.ok(lbRes.leaderboard.some((entry) => entry.name === 'TestPlayer'),
    'submitted score should appear on today\'s leaderboard');

  a.disconnect();
  b.disconnect();
});
