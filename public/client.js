const socket = io();

let myId = null;
let currentRoom = null;

const screens = {
  home: document.getElementById('screen-home'),
  lobby: document.getElementById('screen-lobby'),
  game: document.getElementById('screen-game'),
  finished: document.getElementById('screen-finished'),
};

function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.remove('active'));
  screens[name].classList.add('active');
}

function getName() {
  return document.getElementById('name-input').value.trim() || 'Player';
}

// --- Home screen ---

document.getElementById('create-btn').addEventListener('click', () => {
  socket.emit('room:create', { name: getName() }, (res) => {
    if (!res.ok) return showError(res.error);
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
    currentRoom = res.room;
    renderLobby(res.room);
    showScreen('lobby');
  });
});

function showError(msg) {
  document.getElementById('home-error').textContent = msg;
}

// --- Lobby screen ---

document.getElementById('grid-size-input').addEventListener('change', pushSettings);
document.getElementById('treasure-count-input').addEventListener('change', pushSettings);

function pushSettings() {
  if (!currentRoom) return;
  socket.emit('room:settings', {
    code: currentRoom.code,
    gridSize: document.getElementById('grid-size-input').value,
    treasureCount: document.getElementById('treasure-count-input').value,
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
  document.getElementById('host-settings').hidden = !isHost;
  document.getElementById('grid-size-input').value = room.gridSize;
  document.getElementById('treasure-count-input').value = room.treasureCount;
  document.getElementById('grid-size-input').disabled = !isHost;
  document.getElementById('treasure-count-input').disabled = !isHost;

  const list = document.getElementById('player-list');
  list.innerHTML = '';
  room.players.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = `${p.name}${p.id === room.hostId ? ' (host)' : ''}`;
    if (p.id === socket.id) li.classList.add('you');
    list.appendChild(li);
  });

  const startBtn = document.getElementById('start-btn');
  startBtn.hidden = !isHost;
  startBtn.disabled = room.players.length < 2;

  document.getElementById('lobby-hint').textContent = isHost
    ? (room.players.length < 2 ? 'Waiting for at least one more player…' : 'Ready to start!')
    : 'Waiting for the host to start the game…';
}

// --- Game screen ---

const canvas = document.getElementById('grid-canvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  const size = canvas.clientWidth;
  canvas.width = size;
  canvas.height = size;
  if (currentRoom?.grid) drawGrid(currentRoom);
}
window.addEventListener('resize', resizeCanvas);

canvas.addEventListener('click', (e) => {
  if (!currentRoom || currentRoom.status !== 'playing') return;
  if (currentRoom.turnPlayerId !== socket.id) return;

  const rect = canvas.getBoundingClientRect();
  const cellSize = canvas.width / currentRoom.gridSize;
  const x = Math.floor((e.clientX - rect.left) / cellSize);
  const y = Math.floor((e.clientY - rect.top) / cellSize);

  socket.emit('game:reveal', { code: currentRoom.code, x, y });
});

function drawGrid(room) {
  const size = room.gridSize;
  const cellSize = canvas.width / size;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cell = room.grid[y][x];
      const px = x * cellSize;
      const py = y * cellSize;

      if (cell === null) {
        ctx.fillStyle = (x + y) % 2 === 0 ? '#273449' : '#1e293b';
      } else if (cell === 'treasure') {
        ctx.fillStyle = '#f4b942';
      } else {
        ctx.fillStyle = '#334155';
      }
      ctx.fillRect(px, py, cellSize, cellSize);
      ctx.strokeStyle = '#0f172a';
      ctx.strokeRect(px, py, cellSize, cellSize);

      if (cell === 'treasure') {
        ctx.font = `${cellSize * 0.5}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('💰', px + cellSize / 2, py + cellSize / 2);
      }
    }
  }
}

function renderGame(room) {
  const isYourTurn = room.turnPlayerId === socket.id;
  const turnPlayer = room.players.find((p) => p.id === room.turnPlayerId);

  const banner = document.getElementById('turn-banner');
  banner.textContent = isYourTurn ? "Your turn — click a cell!" : `${turnPlayer?.name ?? '...'}'s turn`;
  banner.classList.toggle('your-turn', isYourTurn);

  const scoreboard = document.getElementById('scoreboard');
  scoreboard.innerHTML = '';
  room.players.forEach((p) => {
    const chip = document.createElement('div');
    chip.className = 'chip' + (p.id === room.turnPlayerId ? ' turn' : '');
    chip.textContent = `${p.name}: ${p.score}${p.connected ? '' : ' (left)'}`;
    scoreboard.appendChild(chip);
  });

  document.getElementById('treasures-left').textContent = `${room.treasuresRemaining} treasure(s) remaining`;

  resizeCanvas();
  drawGrid(room);
}

function renderFinished(room) {
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  const list = document.getElementById('final-scores');
  list.innerHTML = '';
  sorted.forEach((p, i) => {
    const li = document.createElement('li');
    li.textContent = `${i + 1}. ${p.name} — ${p.score} treasure(s)`;
    if (p.id === socket.id) li.classList.add('you');
    list.appendChild(li);
  });

  const isHost = room.hostId === socket.id;
  const rematchBtn = document.getElementById('rematch-btn');
  rematchBtn.hidden = !isHost;
  document.getElementById('finished-hint').textContent = isHost
    ? ''
    : 'Waiting for the host to start a rematch…';
}

// --- Socket events ---

socket.on('connect', () => {
  myId = socket.id;
});

socket.on('room:update', (room) => {
  currentRoom = room;

  if (room.status === 'lobby') {
    renderLobby(room);
    showScreen('lobby');
  } else if (room.status === 'playing') {
    renderGame(room);
    showScreen('game');
  } else if (room.status === 'finished') {
    renderFinished(room);
    showScreen('finished');
  }
});
