const socket = io();

let currentRoom = null;
let isSpectator = false;
let prevGrid = null;
let activeReveals = []; // { x, y, startTime, cell }
let particles = []; // { x, y, startTime, color }
let gameLoopRunning = false;
let lastTickSecond = null;
let matchRecorded = null; // guards double-recording profile stats for a given code+roundNumber
let pendingReveal = null; // { x, y, timeoutHandle } - blocks re-clicking until the server responds
const PENDING_REVEAL_TIMEOUT_MS = 4000;
let lastConnectedState = {}; // playerId -> connected, so we can detect a fresh disconnect

function showToast(text) {
  const layer = document.getElementById('reaction-layer');
  if (!layer) return;
  const toast = document.createElement('div');
  toast.className = 'toast-bubble';
  toast.textContent = text;
  layer.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

const REVEAL_ANIM_MS = 320;
const PARTICLE_ANIM_MS = 600;

const screens = {
  home: document.getElementById('screen-home'),
  lobby: document.getElementById('screen-lobby'),
  game: document.getElementById('screen-game'),
  finished: document.getElementById('screen-finished'),
  daily: document.getElementById('screen-daily'),
};

function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.remove('active'));
  screens[name].classList.add('active');
}

// --- How to Play modal ---

const howToPlayModal = document.getElementById('how-to-play-modal');
document.getElementById('how-to-play-btn').addEventListener('click', () => {
  howToPlayModal.hidden = false;
});
document.getElementById('how-to-play-close').addEventListener('click', () => {
  howToPlayModal.hidden = true;
});
howToPlayModal.addEventListener('click', (e) => {
  if (e.target === howToPlayModal) howToPlayModal.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !howToPlayModal.hidden) howToPlayModal.hidden = true;
});

function getName() {
  return document.getElementById('name-input').value.trim() || 'Player';
}

// --- Profile & theme (localStorage) ---

const PROFILE_KEY = 'treasureGridProfile';
const THEME_KEY = 'treasureGridTheme';

function loadProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* private mode / blocked storage */ }
  return { wins: 0, matchesPlayed: 0, lifetimeTreasures: 0 };
}

function saveProfile(p) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ }
}

let profile = loadProfile();

function renderProfile() {
  document.getElementById('stat-wins').textContent = profile.wins;
  document.getElementById('stat-games').textContent = profile.matchesPlayed;
  document.getElementById('stat-treasures').textContent = profile.lifetimeTreasures;

  const select = document.getElementById('theme-select');
  select.querySelector('option[value="forest"]').disabled = profile.matchesPlayed < 5;
  select.querySelector('option[value="neon"]').disabled = profile.matchesPlayed < 15;
}

function applyTheme(theme) {
  if (theme === 'default') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

(function initTheme() {
  let theme = 'default';
  try { theme = localStorage.getItem(THEME_KEY) || 'default'; } catch (e) { /* ignore */ }
  document.getElementById('theme-select').value = theme;
  applyTheme(theme);
})();

document.getElementById('theme-select').addEventListener('change', (e) => {
  const theme = e.target.value;
  const minMatches = theme === 'forest' ? 5 : theme === 'neon' ? 15 : 0;
  if (profile.matchesPlayed < minMatches) {
    e.target.value = 'default';
    return;
  }
  applyTheme(theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch (err) { /* ignore */ }
});

renderProfile();

// --- Sound (WebAudio, no asset files needed) ---

let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  return audioCtx;
}
document.addEventListener('pointerdown', () => getAudioCtx(), { once: true });

function beep({ freq = 440, duration = 0.15, type = 'sine', volume = 0.15, delay = 0 }) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    osc.connect(gain).connect(ctx.destination);
    const start = ctx.currentTime + delay;
    gain.gain.setValueAtTime(volume, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  } catch (e) { /* ignore */ }
}

function playTreasureSound() {
  beep({ freq: 660, duration: 0.1, type: 'triangle' });
  beep({ freq: 880, duration: 0.15, type: 'triangle', delay: 0.08 });
}
function playBombSound() {
  beep({ freq: 140, duration: 0.3, type: 'sawtooth', volume: 0.2 });
}
function playTickSound() {
  beep({ freq: 900, duration: 0.05, type: 'square', volume: 0.08 });
}
function playPowerupSound() {
  beep({ freq: 500, duration: 0.08, type: 'sine' });
  beep({ freq: 750, duration: 0.08, type: 'sine', delay: 0.06 });
}

// --- Home screen ---

document.getElementById('create-btn').addEventListener('click', () => {
  socket.emit('room:create', { name: getName() }, (res) => {
    if (!res.ok) return showError(res.error);
    isSpectator = false;
    currentRoom = res.room;
    renderLobby(res.room);
    showScreen('lobby');
  });
});

document.getElementById('join-btn').addEventListener('click', () => {
  const code = document.getElementById('code-input').value.trim().toUpperCase();
  if (!code) return showError('Enter a room code');
  socket.emit('room:join', { code, name: getName() }, (res) => {
    if (!res.ok) return showError(res.error);
    isSpectator = false;
    currentRoom = res.room;
    renderLobby(res.room);
    showScreen('lobby');
  });
});

document.getElementById('spectate-btn').addEventListener('click', () => {
  const code = document.getElementById('code-input').value.trim().toUpperCase();
  if (!code) return showError('Enter a room code to watch');
  socket.emit('room:spectate', { code, name: getName() }, (res) => {
    if (!res.ok) return showError(res.error);
    isSpectator = true;
    currentRoom = res.room;
    if (res.room.status === 'lobby') { renderLobby(res.room); showScreen('lobby'); }
    else if (res.room.status === 'playing') { renderGame(res.room); showScreen('game'); }
    else { renderFinished(res.room); showScreen('finished'); }
  });
});

function showError(msg) {
  document.getElementById('home-error').textContent = msg;
}

document.getElementById('daily-btn').addEventListener('click', () => {
  startDailyChallenge();
});

// --- Lobby screen ---

['grid-size-input', 'treasure-count-input', 'bomb-count-input', 'powerup-count-input'].forEach((id) => {
  document.getElementById(id).addEventListener('change', pushSettings);
});

function pushSettings() {
  if (!currentRoom) return;
  socket.emit('room:settings', {
    code: currentRoom.code,
    gridSize: document.getElementById('grid-size-input').value,
    treasureCount: document.getElementById('treasure-count-input').value,
    bombCount: document.getElementById('bomb-count-input').value,
    powerupCount: document.getElementById('powerup-count-input').value,
  });
}

document.getElementById('start-btn').addEventListener('click', () => {
  socket.emit('room:start', { code: currentRoom.code });
});

document.getElementById('rematch-btn').addEventListener('click', () => {
  socket.emit('room:rematch', { code: currentRoom.code });
});

function renderLobby(room) {
  document.getElementById('lobby-code').textContent = room.code;

  const isHost = room.hostId === socket.id;
  const settingsInputs = ['grid-size-input', 'treasure-count-input', 'bomb-count-input', 'powerup-count-input'];
  document.getElementById('host-settings').hidden = !isHost;
  document.getElementById('grid-size-input').value = room.gridSize;
  document.getElementById('treasure-count-input').value = room.treasureCount;
  document.getElementById('bomb-count-input').value = room.bombCount;
  document.getElementById('powerup-count-input').value = room.powerupCount;
  settingsInputs.forEach((id) => { document.getElementById(id).disabled = !isHost; });

  const list = document.getElementById('player-list');
  list.innerHTML = '';
  room.players.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = `${p.name}${p.id === room.hostId ? ' (host)' : ''}`;
    if (p.id === socket.id) li.classList.add('you');
    list.appendChild(li);
  });

  const specPanel = document.getElementById('spectator-panel');
  specPanel.hidden = room.spectators.length === 0;
  const specList = document.getElementById('spectator-list');
  specList.innerHTML = '';
  room.spectators.forEach((s) => {
    const li = document.createElement('li');
    li.textContent = s.name + (s.id === socket.id ? ' (you)' : '');
    specList.appendChild(li);
  });

  const matchProgress = document.getElementById('match-progress');
  if (room.roundNumber > 1 || Object.keys(room.roundWins).length > 0) {
    const summary = room.players.map((p) => `${p.name}: ${room.roundWins[p.id] || 0}`).join('  |  ');
    matchProgress.textContent = `Round ${room.roundNumber} of 3 — ${summary}`;
    matchProgress.hidden = false;
  } else {
    matchProgress.hidden = true;
  }

  const startBtn = document.getElementById('start-btn');
  startBtn.hidden = !isHost || isSpectator;
  startBtn.disabled = room.players.length < 2;

  document.getElementById('lobby-hint').textContent = isSpectator
    ? 'Waiting for the host to start the game…'
    : isHost
      ? (room.players.length < 2 ? 'Waiting for at least one more player…' : 'Ready to start!')
      : 'Waiting for the host to start the game…';
}

// --- Game screen ---

const canvas = document.getElementById('grid-canvas');
const ctx = canvas.getContext('2d');
const canvasWrap = document.querySelector('.canvas-wrap');

// The full grid is expensive to redraw (fillRect + emoji text per cell), so it's
// only rendered onto this offscreen layer when a move actually changes the board.
// Every animation frame just blits that cached bitmap plus the handful of cells
// currently mid-reveal-animation, instead of redrawing all cells at 60fps.
const baseCanvas = document.createElement('canvas');
const baseCtx = baseCanvas.getContext('2d');

function resizeCanvas() {
  const size = canvas.clientWidth;
  canvas.width = size;
  canvas.height = size;
  baseCanvas.width = size;
  baseCanvas.height = size;
  if (currentRoom && currentRoom.grid) renderBaseLayer(currentRoom);
}
window.addEventListener('resize', resizeCanvas);

function clearPendingReveal() {
  if (pendingReveal) {
    clearTimeout(pendingReveal.timeoutHandle);
    pendingReveal = null;
  }
}

canvas.addEventListener('click', (e) => {
  if (isSpectator || !currentRoom || currentRoom.status !== 'playing') return;
  if (currentRoom.turnPlayerId !== socket.id) return;
  if (pendingReveal) return; // already waiting on a click's response - ignore rapid re-clicks

  const rect = canvas.getBoundingClientRect();
  const cellSize = canvas.width / currentRoom.gridSize;
  const x = Math.floor((e.clientX - rect.left) / cellSize);
  const y = Math.floor((e.clientY - rect.top) / cellSize);
  if (currentRoom.grid[y]?.[x] !== null) return; // already revealed

  // Give instant feedback instead of waiting on the network round-trip: lock
  // input and mark the clicked cell right away so a slow/spiky connection
  // doesn't tempt a re-click that lands after the turn has already passed.
  pendingReveal = {
    x, y,
    timeoutHandle: setTimeout(clearPendingReveal, PENDING_REVEAL_TIMEOUT_MS),
  };

  socket.emit('game:reveal', { code: currentRoom.code, x, y });
});

const TIER_COLORS = { bronze: '#b45309', silver: '#cbd5e1', gold: '#f4b942' };
const TIER_LABELS = { bronze: 'B', silver: 'S', gold: 'G' };
const POWERUP_COLORS = { peek: '#0ea5e9', 'extra-turn': '#a855f7', shield: '#10b981' };
const POWERUP_ICONS = { peek: '👁️', 'extra-turn': '⏩', shield: '🛡️' };

function diffAndAnimate(oldGrid, newGrid) {
  if (!oldGrid) return;
  for (let y = 0; y < newGrid.length; y++) {
    for (let x = 0; x < newGrid[y].length; x++) {
      const before = oldGrid[y]?.[x];
      const after = newGrid[y][x];
      if (before === null && after !== null) {
        activeReveals.push({ x, y, startTime: performance.now(), cell: after });
        if (after.type === 'treasure') {
          playTreasureSound();
          const cellSize = canvas.width / newGrid.length;
          particles.push({ x: (x + 0.5) * cellSize, y: (y + 0.5) * cellSize, startTime: performance.now(), color: TIER_COLORS[after.tier] });
        } else if (after.type === 'bomb') {
          playBombSound();
          triggerShake();
          triggerFlash();
        } else if (after.type === 'powerup') {
          playPowerupSound();
        }
      }
    }
  }
}

function triggerShake() {
  canvasWrap.classList.remove('shake');
  void canvasWrap.offsetWidth; // restart animation
  canvasWrap.classList.add('shake');
}

function triggerFlash() {
  const flash = document.getElementById('flash-overlay');
  flash.classList.remove('active');
  void flash.offsetWidth;
  flash.classList.add('active');
}

const WARMTH_FRUIT = '🍓';

function drawCell(targetCtx, x, y, cellSize, cell, scale = 1, alpha = 1) {
  const px = x * cellSize;
  const py = y * cellSize;
  const pad = (cellSize * (1 - scale)) / 2;

  targetCtx.save();
  targetCtx.globalAlpha = alpha;

  if (cell === null) {
    targetCtx.fillStyle = (x + y) % 2 === 0 ? '#273449' : '#1e293b';
    targetCtx.fillRect(px, py, cellSize, cellSize);
  } else if (cell.type === 'treasure') {
    targetCtx.fillStyle = TIER_COLORS[cell.tier];
    targetCtx.fillRect(px + pad, py + pad, cellSize * scale, cellSize * scale);
  } else if (cell.type === 'bomb') {
    targetCtx.fillStyle = '#7f1d1d';
    targetCtx.fillRect(px + pad, py + pad, cellSize * scale, cellSize * scale);
  } else if (cell.type === 'powerup') {
    targetCtx.fillStyle = POWERUP_COLORS[cell.kind];
    targetCtx.fillRect(px + pad, py + pad, cellSize * scale, cellSize * scale);
  } else {
    targetCtx.fillStyle = '#334155';
    targetCtx.fillRect(px + pad, py + pad, cellSize * scale, cellSize * scale);
  }

  targetCtx.strokeStyle = '#0f172a';
  targetCtx.lineWidth = 1;
  targetCtx.strokeRect(px, py, cellSize, cellSize);

  if (cell) {
    if (cell.type === 'treasure') {
      targetCtx.font = `${cellSize * 0.5 * scale}px sans-serif`;
      targetCtx.textAlign = 'center';
      targetCtx.textBaseline = 'middle';
      targetCtx.fillText('💰', px + cellSize / 2, py + cellSize / 2);
      targetCtx.font = `${cellSize * 0.22}px sans-serif`;
      targetCtx.fillStyle = '#1a1305';
      targetCtx.fillText(TIER_LABELS[cell.tier], px + cellSize * 0.82, py + cellSize * 0.18);
    } else if (cell.type === 'bomb') {
      targetCtx.font = `${cellSize * 0.5 * scale}px sans-serif`;
      targetCtx.textAlign = 'center';
      targetCtx.textBaseline = 'middle';
      targetCtx.fillText('💣', px + cellSize / 2, py + cellSize / 2);
    } else if (cell.type === 'powerup') {
      targetCtx.font = `${cellSize * 0.5 * scale}px sans-serif`;
      targetCtx.textAlign = 'center';
      targetCtx.textBaseline = 'middle';
      targetCtx.fillText(POWERUP_ICONS[cell.kind], px + cellSize / 2, py + cellSize / 2);
    } else if (cell.type === 'empty' && cell.warmth > 0) {
      const fruitSize = cellSize * 0.24;
      const spacing = fruitSize * 1.05;
      const totalWidth = spacing * (cell.warmth - 1);
      const startX = px + cellSize / 2 - totalWidth / 2;
      const fruitY = py + cellSize * 0.78;
      targetCtx.font = `${fruitSize}px sans-serif`;
      targetCtx.textAlign = 'center';
      targetCtx.textBaseline = 'middle';
      for (let i = 0; i < cell.warmth; i++) {
        targetCtx.fillText(WARMTH_FRUIT, startX + i * spacing, fruitY);
      }
    }
  }

  targetCtx.restore();
}

// Redrawn only when the board actually changes (a reveal happens), not per animation frame.
function renderBaseLayer(room) {
  const size = room.gridSize;
  const cellSize = baseCanvas.width / size;
  baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      drawCell(baseCtx, x, y, cellSize, room.grid[y][x], 1, 1);
    }
  }
}

// Runs every animation frame: cheap blit of the cached base layer, plus only the
// handful of cells currently mid-reveal-animation redrawn on top, plus particles.
function renderFrame(room, timestamp) {
  const size = room.gridSize;
  const cellSize = canvas.width / size;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(baseCanvas, 0, 0);

  // A backgrounded/inactive tab throttles requestAnimationFrame, so `timestamp` can
  // occasionally lag behind a performance.now() captured moments earlier by a socket
  // event (e.g. a spectator tab, or a player who alt-tabbed during an opponent's turn).
  // Clamp elapsed/progress so a stale timestamp never produces a negative radius/scale.
  activeReveals = activeReveals.filter((a) => {
    const elapsed = Math.max(0, timestamp - a.startTime);
    if (elapsed > REVEAL_ANIM_MS) return false;
    const progress = Math.min(1, elapsed / REVEAL_ANIM_MS);
    const eased = 1 - Math.pow(1 - progress, 3);
    drawCell(ctx, a.x, a.y, cellSize, null, 1, 1);
    drawCell(ctx, a.x, a.y, cellSize, a.cell, 0.4 + eased * 0.6, eased);
    return true;
  });

  particles = particles.filter((p) => timestamp - p.startTime < PARTICLE_ANIM_MS);
  particles.forEach((p) => {
    const t = Math.max(0, Math.min(1, (timestamp - p.startTime) / PARTICLE_ANIM_MS));
    ctx.save();
    ctx.globalAlpha = 1 - t;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(0, 4 + t * 24), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  if (pendingReveal) {
    const px = pendingReveal.x * cellSize;
    const py = pendingReveal.y * cellSize;
    const pulse = 0.5 + 0.5 * Math.sin(timestamp / 120);
    ctx.save();
    ctx.strokeStyle = `rgba(244, 185, 66, ${0.4 + pulse * 0.5})`;
    ctx.lineWidth = Math.max(2, cellSize * 0.06);
    ctx.strokeRect(px + ctx.lineWidth / 2, py + ctx.lineWidth / 2, cellSize - ctx.lineWidth, cellSize - ctx.lineWidth);
    ctx.restore();
  }
}

function updateTimerBar() {
  const bar = document.getElementById('timer-bar');
  if (!currentRoom || currentRoom.status !== 'playing' || !currentRoom.turnDeadline) {
    bar.style.width = '100%';
    bar.classList.remove('low');
    return;
  }
  const total = currentRoom.suddenDeath ? 6000 : 15000;
  const remaining = Math.max(0, currentRoom.turnDeadline - Date.now());
  const pct = Math.max(0, Math.min(100, (remaining / total) * 100));
  bar.style.width = pct + '%';

  const remainingSec = Math.ceil(remaining / 1000);
  bar.classList.toggle('low', remainingSec <= 5);

  if (currentRoom.turnPlayerId === socket.id && remainingSec <= 5 && remainingSec > 0 && remainingSec !== lastTickSecond) {
    lastTickSecond = remainingSec;
    playTickSound();
  }
  if (remainingSec > 5) lastTickSecond = null;
}

function gameLoopTick(timestamp) {
  if (currentRoom && currentRoom.grid) renderFrame(currentRoom, timestamp);
  updateTimerBar();
  if (screens.game.classList.contains('active')) {
    requestAnimationFrame(gameLoopTick);
  } else {
    gameLoopRunning = false;
  }
}

function ensureGameLoop() {
  if (!gameLoopRunning) {
    gameLoopRunning = true;
    requestAnimationFrame(gameLoopTick);
  }
}

function renderGame(room) {
  if (pendingReveal && room.grid[pendingReveal.y]?.[pendingReveal.x] !== null) {
    clearPendingReveal();
  }

  const isYourTurn = room.turnPlayerId === socket.id;
  const turnPlayer = room.players.find((p) => p.id === room.turnPlayerId);

  const banner = document.getElementById('turn-banner');
  banner.textContent = isSpectator
    ? `${turnPlayer?.name ?? '...'}'s turn`
    : (isYourTurn ? "Your turn — click a cell!" : `${turnPlayer?.name ?? '...'}'s turn`);
  banner.classList.toggle('your-turn', isYourTurn && !isSpectator);
  banner.classList.toggle('sudden-death', !!room.suddenDeath);
  if (room.suddenDeath) banner.textContent = '⚡ Sudden Death! ' + banner.textContent;

  canvas.classList.toggle('sudden-death', !!room.suddenDeath);

  room.players.forEach((p) => {
    if (lastConnectedState[p.id] === true && p.connected === false) {
      showToast(`🚪 ${p.name} left the game`);
    }
    lastConnectedState[p.id] = p.connected;
  });

  const scoreboard = document.getElementById('scoreboard');
  scoreboard.innerHTML = '';
  room.players.forEach((p) => {
    const chip = document.createElement('div');
    chip.className = 'chip' + (p.id === room.turnPlayerId ? ' turn' : '') + (p.connected ? '' : ' disconnected');
    chip.textContent = `${p.name}: ${p.score}${p.shielded ? ' 🛡️' : ''}${p.connected ? '' : ' (left)'}`;
    scoreboard.appendChild(chip);
  });

  const specChip = document.getElementById('spectator-chip');
  if (isSpectator) {
    specChip.hidden = false;
    specChip.textContent = '👀 Watching as spectator';
  } else if (room.spectators.length > 0) {
    specChip.hidden = false;
    specChip.textContent = `👀 ${room.spectators.length} watching`;
  } else {
    specChip.hidden = true;
  }

  document.getElementById('treasures-left').textContent = `${room.treasuresRemaining} treasure(s) remaining`;

  resizeCanvas();
  diffAndAnimate(prevGrid, room.grid);
  prevGrid = room.grid.map((row) => row.slice());
  ensureGameLoop();
}

document.getElementById('reaction-bar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-emoji]');
  if (!btn || !currentRoom) return;
  socket.emit('game:reaction', { code: currentRoom.code, emoji: btn.dataset.emoji });
});

socket.on('game:reaction', ({ name, emoji }) => {
  const layer = document.getElementById('reaction-layer');
  const bubble = document.createElement('div');
  bubble.className = 'reaction-bubble';
  bubble.style.left = `${10 + Math.random() * 70}%`;
  bubble.textContent = emoji;
  bubble.title = name;
  layer.appendChild(bubble);
  setTimeout(() => bubble.remove(), 1900);
});

socket.on('game:peek', ({ x, y, content }) => {
  if (!currentRoom) return;
  const cellSize = canvas.width / currentRoom.gridSize;
  const overlay = document.getElementById('peek-overlay');
  const label = content.type === 'treasure' ? `💰 ${content.tier}`
    : content.type === 'bomb' ? '💣 bomb'
    : content.type === 'powerup' ? `${POWERUP_ICONS[content.kind]} ${content.kind}`
    : 'empty';
  overlay.textContent = `Peek: (${x + 1}, ${y + 1}) → ${label}`;
  overlay.style.left = `${(x + 0.5) * cellSize}px`;
  overlay.style.top = `${y * cellSize}px`;
  overlay.hidden = false;
  clearTimeout(overlay._hideTimer);
  overlay._hideTimer = setTimeout(() => { overlay.hidden = true; }, 4000);
});

// --- Finished screen ---

document.getElementById('copy-result-btn').addEventListener('click', () => {
  if (!currentRoom) return;
  const sorted = [...currentRoom.players].sort((a, b) => b.score - a.score);
  const lines = [`Treasure Grid — Round ${currentRoom.roundNumber} result:`];
  sorted.forEach((p, i) => lines.push(`${i + 1}. ${p.name} — ${p.score} pts`));
  const text = lines.join('\n');
  navigator.clipboard?.writeText(text).catch(() => {});
});

function computeAwards(room) {
  const awards = [];
  let mvp = null, gambler = null;
  room.players.forEach((p) => {
    if (!mvp || p.treasuresFound > mvp.treasuresFound) mvp = p;
    if (!gambler || p.bombHits > gambler.bombHits) gambler = p;
  });
  if (mvp && mvp.treasuresFound > 0) awards.push(`🏅 MVP: ${mvp.name} (${mvp.treasuresFound} treasures found)`);
  if (gambler && gambler.bombHits > 0) awards.push(`🎲 Biggest Gambler: ${gambler.name} (${gambler.bombHits} bombs hit)`);
  return awards;
}

function renderFinished(room) {
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  const list = document.getElementById('final-scores');
  list.innerHTML = '';
  sorted.forEach((p, i) => {
    const li = document.createElement('li');
    li.textContent = `${i + 1}. ${p.name} — ${p.score} pts`;
    if (p.id === socket.id) li.classList.add('you');
    list.appendChild(li);
  });

  const title = document.getElementById('finished-title');
  const summary = document.getElementById('match-summary');
  const isHost = room.hostId === socket.id;
  const rematchBtn = document.getElementById('rematch-btn');

  if (room.matchOver) {
    const champion = room.players.find((p) => p.id === room.matchChampionId);
    title.textContent = '🏆 Match Champion!';
    summary.textContent = champion ? `${champion.name} wins the match!` : 'Match complete.';
    rematchBtn.textContent = 'New Match';
  } else {
    title.textContent = '🚩 Round Over';
    const winsSummary = room.players.map((p) => `${p.name}: ${room.roundWins[p.id] || 0}`).join('  |  ');
    summary.textContent = `Round ${room.roundNumber} of 3 — ${winsSummary}`;
    rematchBtn.textContent = 'Next Round';
  }

  document.getElementById('awards').innerHTML = '';
  computeAwards(room).forEach((text) => {
    const div = document.createElement('div');
    div.className = 'award';
    div.textContent = text;
    document.getElementById('awards').appendChild(div);
  });

  rematchBtn.hidden = !isHost || isSpectator;
  document.getElementById('finished-hint').textContent = (isHost || isSpectator)
    ? ''
    : 'Waiting for the host to continue…';

  if (room.matchOver && !isSpectator) {
    const recordKey = room.code + ':' + room.matchChampionId + ':' + room.roundNumber;
    if (matchRecorded !== recordKey) {
      matchRecorded = recordKey;
      const me = room.players.find((p) => p.id === socket.id);
      if (me) {
        profile.matchesPlayed += 1;
        if (room.matchChampionId === socket.id) profile.wins += 1;
        profile.lifetimeTreasures += me.treasuresFound;
        saveProfile(profile);
        renderProfile();
      }
    }
  }
}

// --- Socket events ---

socket.on('room:update', (room) => {
  currentRoom = room;

  if (room.status === 'lobby') {
    prevGrid = null;
    lastConnectedState = {};
    clearPendingReveal();
    showScreen('lobby');
    renderLobby(room);
  } else if (room.status === 'playing') {
    showScreen('game');
    renderGame(room);
  } else if (room.status === 'finished') {
    clearPendingReveal();
    showScreen('finished');
    renderFinished(room);
  }
});

// --- Daily Challenge ---

let dailyState = null;
const dailyCanvas = document.getElementById('daily-canvas');
const dailyCtx = dailyCanvas.getContext('2d');

function resizeDailyCanvas() {
  const size = dailyCanvas.clientWidth;
  dailyCanvas.width = size;
  dailyCanvas.height = size;
}

function drawDailyGrid() {
  if (!dailyState) return;
  const size = dailyState.size;
  const cellSize = dailyCanvas.width / size;
  dailyCtx.clearRect(0, 0, dailyCanvas.width, dailyCanvas.height);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cell = dailyState.grid[y][x];
      const px = x * cellSize;
      const py = y * cellSize;

      if (cell === null) {
        dailyCtx.fillStyle = (x + y) % 2 === 0 ? '#273449' : '#1e293b';
      } else if (cell.type === 'treasure') {
        dailyCtx.fillStyle = TIER_COLORS[cell.tier];
      } else if (cell.type === 'bomb') {
        dailyCtx.fillStyle = '#7f1d1d';
      } else {
        dailyCtx.fillStyle = '#334155';
      }
      dailyCtx.fillRect(px, py, cellSize, cellSize);
      dailyCtx.strokeStyle = '#0f172a';
      dailyCtx.strokeRect(px, py, cellSize, cellSize);

      if (cell && cell.type === 'treasure') {
        dailyCtx.font = `${cellSize * 0.5}px sans-serif`;
        dailyCtx.textAlign = 'center';
        dailyCtx.textBaseline = 'middle';
        dailyCtx.fillText('💰', px + cellSize / 2, py + cellSize / 2);
      } else if (cell && cell.type === 'bomb') {
        dailyCtx.font = `${cellSize * 0.5}px sans-serif`;
        dailyCtx.textAlign = 'center';
        dailyCtx.textBaseline = 'middle';
        dailyCtx.fillText('💣', px + cellSize / 2, py + cellSize / 2);
      }
    }
  }
}

function renderDailyScore() {
  document.getElementById('daily-score').textContent =
    `Score: ${dailyState.score} — ${dailyState.treasuresRemaining} treasure(s) left`;
}

function startDailyChallenge() {
  socket.emit('daily:start', {}, (res) => {
    if (!res.ok) return;
    dailyState = {
      size: res.size,
      grid: res.grid,
      score: res.score,
      treasuresRemaining: res.treasuresRemaining,
      finished: res.finished,
    };
    document.getElementById('daily-submit').hidden = true;
    showScreen('daily');
    resizeDailyCanvas();
    drawDailyGrid();
    renderDailyScore();
    loadDailyLeaderboard();
  });
}

dailyCanvas.addEventListener('click', (e) => {
  if (!dailyState || dailyState.finished) return;
  const rect = dailyCanvas.getBoundingClientRect();
  const cellSize = dailyCanvas.width / dailyState.size;
  const x = Math.floor((e.clientX - rect.left) / cellSize);
  const y = Math.floor((e.clientY - rect.top) / cellSize);

  socket.emit('daily:reveal', { x, y }, (res) => {
    if (!res.ok) return;
    dailyState.grid[y][x] = res.cell;
    dailyState.score = res.score;
    dailyState.treasuresRemaining = res.treasuresRemaining;
    dailyState.finished = res.finished;
    if (res.cell.type === 'treasure') playTreasureSound();
    else if (res.cell.type === 'bomb') playBombSound();
    drawDailyGrid();
    renderDailyScore();
    if (dailyState.finished) {
      document.getElementById('daily-submit').hidden = false;
    }
  });
});

document.getElementById('daily-submit-btn').addEventListener('click', () => {
  const name = document.getElementById('daily-name-input').value.trim() || 'Player';
  socket.emit('daily:submit', { name }, (res) => {
    if (!res.ok) return;
    renderDailyLeaderboard(res.leaderboard);
    document.getElementById('daily-submit').hidden = true;
  });
});

function loadDailyLeaderboard() {
  socket.emit('daily:leaderboard', {}, (res) => {
    if (res.ok) renderDailyLeaderboard(res.leaderboard);
  });
}

function renderDailyLeaderboard(entries) {
  const list = document.getElementById('daily-leaderboard');
  list.innerHTML = '';
  if (entries.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No scores yet today — be the first!';
    list.appendChild(li);
    return;
  }
  entries.forEach((e, i) => {
    const li = document.createElement('li');
    li.textContent = `${i + 1}. ${e.name} — ${e.score} pts`;
    list.appendChild(li);
  });
}

document.getElementById('daily-back-btn').addEventListener('click', () => {
  showScreen('home');
});
