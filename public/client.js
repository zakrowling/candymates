(() => {
  const socket = window.CandymatesNet.createNet();
  const { TICK_RATE } = window.CandymatesEngine;

  const CELL = 56; // board cell size in CSS pixels
  // Candy colours: red bean, orange drop, yellow lemon, green chew, blue gumball, purple gem.
  const CANDY = [
    { base: '#ff3b4e', light: '#ff9aa6', dark: '#a3122a' },
    { base: '#ff9a2e', light: '#ffd29a', dark: '#b4520a' },
    { base: '#ffd93b', light: '#fff3a8', dark: '#b88a00' },
    { base: '#4fd65a', light: '#b4f5b0', dark: '#1d7a2a' },
    { base: '#3aa0ff', light: '#a8d6ff', dark: '#0d4f9e' },
    { base: '#b35cff', light: '#e2b8ff', dark: '#5e1aa6' },
  ];

  const $ = (id) => document.getElementById(id);
  const canvas = $('game-canvas');
  const ctx = canvas.getContext('2d');

  const state = {
    playerId: null,
    hostId: null,
    linkRoom: false, // entered via a link like /candymates/mate: no room code UI
    lobbyPlayers: [],
    players: [],
    cols: 16,
    rows: 10,
    grid: null, // what's on screen right now: rows of { id, c, s } (or null mid-animation)
    sprites: new Map(), // candy id -> { c, s, x, y, scale, alpha } in board cells
    queue: [], // animations waiting to play, one after another
    current: null,
    popups: [],
    particles: [],
    beams: [],
    wiggles: [],
    cursors: [],
    ticksLeft: 0,
    readyTicks: 0,
    tickMs: 1000 / TICK_RATE,
    lastTimerSecs: undefined,
    playing: false,
    rafId: null,
    selected: null, // { x, y } the candy you've picked
    hover: null,
    drag: null,
    goUntil: 0,
  };

  // ---------- Sound (all synthesized with Web Audio) ----------

  let audioCtx = null;
  let master = null;
  let noiseBuffer = null;
  function getAudioCtx() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
      const comp = audioCtx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 6;
      master = audioCtx.createGain();
      master.gain.value = 0.8;
      master.connect(comp).connect(audioCtx.destination);
      noiseBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  // Browsers only allow audio after a user gesture.
  ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, getAudioCtx, { once: true }));

  function envGain(ac, t0, peak, attack, decay) {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    g.connect(master);
    return g;
  }

  function osc(ac, { type = 'sine', from, to = from, t0 = ac.currentTime, dur, peak, attack = 0.005 }) {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, t0);
    o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    o.connect(envGain(ac, t0, peak, attack, dur));
    o.start(t0);
    o.stop(t0 + attack + dur + 0.05);
  }

  function noise(ac, { t0 = ac.currentTime, dur, peak, type = 'bandpass', from, to = from, q = 1 }) {
    const src = ac.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    const filter = ac.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, t0);
    filter.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    src.connect(filter).connect(envGain(ac, t0, peak, 0.003, dur));
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + dur + 0.05);
  }

  // A major pentatonic run, so cascades climb up a happy scale.
  const SCALE = [523, 587, 659, 784, 880, 1047, 1175, 1319, 1568, 1760];
  const SFX = {
    swap(ac) {
      noise(ac, { dur: 0.12, peak: 0.12, from: 900, to: 2400, q: 0.8 });
    },
    bad(ac) {
      osc(ac, { type: 'triangle', from: 220, to: 160, dur: 0.12, peak: 0.18 });
      osc(ac, { type: 'triangle', from: 180, to: 130, t0: ac.currentTime + 0.12, dur: 0.14, peak: 0.16 });
    },
    // Matched candies pop: bubbly blips that climb with each cascade.
    pop(ac, level = 1) {
      const t = ac.currentTime;
      const f = SCALE[Math.min(SCALE.length - 1, level - 1)];
      osc(ac, { from: f * 0.6, to: f, dur: 0.09, peak: 0.22, t0: t });
      osc(ac, { type: 'triangle', from: f * 1.5, to: f * 2, dur: 0.08, peak: 0.08, t0: t + 0.04 });
      noise(ac, { t0: t, dur: 0.05, peak: 0.08, type: 'highpass', from: 3000 });
    },
    special(ac) {
      const t = ac.currentTime;
      [1047, 1319, 1568, 2093].forEach((f, i) => osc(ac, { type: 'triangle', from: f, t0: t + i * 0.05, dur: 0.18, peak: 0.08 }));
    },
    stripe(ac) {
      osc(ac, { type: 'sawtooth', from: 1800, to: 300, dur: 0.3, peak: 0.08 });
      noise(ac, { dur: 0.3, peak: 0.12, from: 4000, to: 800, q: 0.6 });
    },
    wrapped(ac) {
      osc(ac, { from: 160, to: 50, dur: 0.4, peak: 0.4 });
      noise(ac, { dur: 0.35, peak: 0.25, type: 'lowpass', from: 2000, to: 200 });
    },
    bomb(ac) {
      const t = ac.currentTime;
      for (let i = 0; i < 10; i++) osc(ac, { type: 'triangle', from: 600 + i * 150, to: 1800 + i * 200, t0: t + i * 0.03, dur: 0.12, peak: 0.06 });
      osc(ac, { from: 120, to: 40, t0: t + 0.1, dur: 0.6, peak: 0.35 });
    },
    shuffle(ac) {
      for (let i = 0; i < 6; i++) noise(ac, { t0: ac.currentTime + i * 0.06, dur: 0.06, peak: 0.1, from: 1200 + i * 300, q: 2 });
    },
    ready(ac) {
      osc(ac, { type: 'square', from: 660, dur: 0.12, peak: 0.07 });
    },
    go(ac) {
      const t = ac.currentTime;
      [523, 659, 784, 1047].forEach((f, i) => osc(ac, { type: 'square', from: f, t0: t + i * 0.07, dur: 0.12, peak: 0.07 }));
    },
    tick(ac, secs) {
      const f = secs <= 3 ? 1760 : 1320;
      noise(ac, { dur: 0.03, peak: 0.45, type: 'highpass', from: 4000 });
      osc(ac, { type: 'square', from: f, dur: 0.07, peak: 0.25, attack: 0.002 });
      osc(ac, { from: f / 2, dur: 0.09, peak: 0.28, attack: 0.002 });
    },
    end(ac) {
      const t = ac.currentTime;
      [1047, 784, 659, 523, 659, 784, 1047].forEach((f, i) => osc(ac, { type: 'triangle', from: f, t0: t + i * 0.11, dur: 0.16, peak: 0.12 }));
    },
  };

  function playSound(key, arg) {
    const ac = getAudioCtx();
    if (!ac || !SFX[key]) return;
    SFX[key](ac, arg);
  }

  // ---------- Candy drawing ----------

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // The outline of each candy shape, centred on 0,0 at radius r.
  function candyPath(c, colour, r) {
    c.beginPath();
    if (colour === 0) { // jelly bean
      c.ellipse(0, 0, r, r * 0.72, -0.35, 0, Math.PI * 2);
    } else if (colour === 1) { // round drop with a flat-ish top
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        const rr = r * 0.95;
        if (i === 0) c.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        else c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      c.closePath();
    } else if (colour === 2) { // lemon drop
      c.moveTo(0, -r);
      c.bezierCurveTo(r * 0.95, -r * 0.55, r * 0.85, r * 0.7, 0, r);
      c.bezierCurveTo(-r * 0.85, r * 0.7, -r * 0.95, -r * 0.55, 0, -r);
    } else if (colour === 3) { // square chew
      roundRect(c, -r * 0.82, -r * 0.82, r * 1.64, r * 1.64, r * 0.35);
    } else if (colour === 4) { // gumball
      c.arc(0, 0, r * 0.88, 0, Math.PI * 2);
    } else { // gem
      c.moveTo(0, -r);
      c.quadraticCurveTo(r * 0.25, -r * 0.25, r, 0);
      c.quadraticCurveTo(r * 0.25, r * 0.25, 0, r);
      c.quadraticCurveTo(-r * 0.25, r * 0.25, -r, 0);
      c.quadraticCurveTo(-r * 0.25, -r * 0.25, 0, -r);
    }
  }

  function glossyFill(c, pal, r) {
    const g = c.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r * 1.1);
    g.addColorStop(0, pal.light);
    g.addColorStop(0.45, pal.base);
    g.addColorStop(1, pal.dark);
    c.fillStyle = g;
    c.fill();
    c.lineWidth = Math.max(1.2, r * 0.07);
    c.strokeStyle = pal.dark;
    c.stroke();
  }

  function gloss(c, r) {
    c.fillStyle = 'rgba(255, 255, 255, 0.55)';
    c.beginPath();
    c.ellipse(-r * 0.3, -r * 0.42, r * 0.32, r * 0.16, -0.5, 0, Math.PI * 2);
    c.fill();
  }

  function drawChocolateBomb(c, r) {
    const g = c.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r);
    g.addColorStop(0, '#9a6040');
    g.addColorStop(0.5, '#5a3020');
    g.addColorStop(1, '#2a140a');
    c.fillStyle = g;
    c.beginPath();
    c.arc(0, 0, r * 0.9, 0, Math.PI * 2);
    c.fill();
    // Rainbow sprinkles.
    const colours = ['#ff3b4e', '#ff9a2e', '#ffd93b', '#4fd65a', '#3aa0ff', '#b35cff', '#ffffff'];
    for (let i = 0; i < 16; i++) {
      const a = i * 2.4;
      const d = r * (0.2 + ((i * 37) % 10) / 15);
      c.save();
      c.translate(Math.cos(a) * d, Math.sin(a) * d);
      c.rotate(a * 1.7);
      c.fillStyle = colours[i % colours.length];
      roundRect(c, -r * 0.12, -r * 0.04, r * 0.24, r * 0.08, r * 0.04);
      c.fill();
      c.restore();
    }
    gloss(c, r);
  }

  // Draws a candy centred at 0,0. A striped candy has bold white stripes; a wrapped candy has
  // twisted wrapper ends; a colour bomb is a chocolate ball with sprinkles.
  function drawCandy(c, colour, special, r, now = 0) {
    if (special === 'bomb') {
      drawChocolateBomb(c, r);
      return;
    }
    const pal = CANDY[colour];
    if (special === 'w') {
      // Wrapper twists either side.
      c.fillStyle = pal.base;
      c.strokeStyle = pal.dark;
      c.lineWidth = Math.max(1, r * 0.06);
      [-1, 1].forEach((side) => {
        c.beginPath();
        c.moveTo(side * r * 0.55, 0);
        c.lineTo(side * r * 1.05, -r * 0.5);
        c.lineTo(side * r * 0.95, 0);
        c.lineTo(side * r * 1.05, r * 0.5);
        c.closePath();
        c.fill();
        c.stroke();
      });
      c.save();
      c.scale(0.78, 0.78);
      candyPath(c, colour, r);
      glossyFill(c, pal, r);
      // Shiny cellophane band.
      c.clip();
      c.fillStyle = 'rgba(255, 255, 255, 0.35)';
      c.fillRect(-r, -r * 0.15, r * 2, r * 0.3);
      c.restore();
      gloss(c, r * 0.8);
      return;
    }
    candyPath(c, colour, r);
    glossyFill(c, pal, r);
    if (special === 'h' || special === 'v') {
      c.save();
      candyPath(c, colour, r);
      c.clip();
      c.fillStyle = 'rgba(255, 255, 255, 0.85)';
      if (special === 'v') c.rotate(Math.PI / 2);
      for (let i = -2; i <= 2; i++) c.fillRect(-r * 1.2, i * r * 0.42 - r * 0.09, r * 2.4, r * 0.18);
      c.restore();
      candyPath(c, colour, r);
      c.lineWidth = Math.max(1.2, r * 0.07);
      c.strokeStyle = pal.dark;
      c.stroke();
    }
    gloss(c, r);
  }

  // Candies are pre-drawn once at screen resolution and reused every frame.
  const spriteCache = new Map();
  function candySprite(colour, special) {
    const dpr = window.devicePixelRatio || 1;
    const key = `${colour}:${special}:${dpr}`;
    if (!spriteCache.has(key)) {
      const size = Math.ceil(CELL * dpr);
      const off = document.createElement('canvas');
      off.width = size;
      off.height = size;
      const g = off.getContext('2d');
      g.scale(dpr, dpr);
      g.translate(CELL / 2, CELL / 2);
      drawCandy(g, colour, special, CELL * 0.4);
      spriteCache.set(key, off);
    }
    return spriteCache.get(key);
  }

  // A candy in a player's own colour, for the lobby slots.
  function drawPlayerCandy(c, color, cx, cy, r, now) {
    const shade = (hex, amt) => {
      const n = parseInt(hex.slice(1), 16);
      const ch = (v) => Math.max(0, Math.min(255, Math.round(v + amt * 255)));
      return `rgb(${ch(n >> 16)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)})`;
    };
    const pal = { base: color, light: shade(color, 0.35), dark: shade(color, -0.4) };
    c.save();
    c.translate(cx, cy + Math.sin(now / 300) * 3);
    c.rotate(Math.sin(now / 600) * 0.15);
    c.fillStyle = pal.base;
    c.strokeStyle = pal.dark;
    c.lineWidth = 1.5;
    [-1, 1].forEach((side) => {
      c.beginPath();
      c.moveTo(side * r * 0.55, 0);
      c.lineTo(side * r * 1.15, -r * 0.55);
      c.lineTo(side * r * 1.0, 0);
      c.lineTo(side * r * 1.15, r * 0.55);
      c.closePath();
      c.fill();
      c.stroke();
    });
    c.beginPath();
    c.arc(0, 0, r * 0.7, 0, Math.PI * 2);
    glossyFill(c, pal, r * 0.7);
    c.save();
    c.beginPath();
    c.arc(0, 0, r * 0.7, 0, Math.PI * 2);
    c.clip();
    c.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    c.lineWidth = r * 0.14;
    for (let i = -2; i <= 2; i++) {
      c.beginPath();
      c.moveTo(i * r * 0.4 - r, -r);
      c.lineTo(i * r * 0.4 + r, r);
      c.stroke();
    }
    c.restore();
    gloss(c, r * 0.7);
    c.restore();
  }

  // ---------- Lobby UI ----------

  function showError(msg) {
    $('error-msg').textContent = msg || '';
  }

  function playerLabel(p) {
    return `${p.name}${p.id === state.playerId ? ' (YOU)' : ''}`;
  }

  const PREVIEW_PLAYER = { id: 'preview', number: 1, name: '', color: '#ff4fa3' };

  function buildSlots() {
    $('slots').replaceChildren(...[1, 2, 3, 4].map((n) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.innerHTML = `<span class="slot-num">P${n}</span><canvas width="128" height="128"></canvas>`
        + '<span class="slot-name"></span><span class="slot-tag"></span>';
      return slot;
    }));
  }

  function slotPlayers() {
    if (!state.playerId) return [PREVIEW_PLAYER];
    return state.lobbyPlayers;
  }

  function renderSlots() {
    const players = slotPlayers();
    [...$('slots').children].forEach((slot, i) => {
      const p = players.find((pl) => pl.number === i + 1);
      const isYou = p && (p.id === state.playerId || p === PREVIEW_PLAYER);
      slot.classList.toggle('filled', !!p);
      slot.classList.toggle('you', !!isYou);
      slot.style.color = p ? p.color : '';
      slot.style.borderColor = p ? p.color : '';
      slot.querySelector('.slot-name').textContent = p ? (p.name || 'YOU') : 'EMPTY';
      let tag = '';
      if (p && p !== PREVIEW_PLAYER) {
        tag = [isYou && '(YOU)', !state.linkRoom && p.id === state.hostId && 'HOST'].filter(Boolean).join(' ');
      }
      slot.querySelector('.slot-tag').textContent = tag;
    });
  }

  function animateSlots(now) {
    requestAnimationFrame(animateSlots);
    if ($('lobby-card').style.display === 'none') return;
    const players = slotPlayers();
    [...$('slots').children].forEach((slot, i) => {
      const c = slot.querySelector('canvas').getContext('2d');
      c.setTransform(2, 0, 0, 2, 0, 0);
      c.clearRect(0, 0, 64, 64);
      const p = players.find((pl) => pl.number === i + 1);
      if (p) {
        drawPlayerCandy(c, p.color, 32, 32, 22, now + i * 400);
      } else {
        c.strokeStyle = '#4a2a58';
        c.setLineDash([4, 4]);
        c.beginPath();
        c.arc(32, 32, 18, 0, Math.PI * 2);
        c.stroke();
        c.setLineDash([]);
      }
    });
  }

  function renderPlayerList(ul, players, rightText) {
    ul.replaceChildren(...players.map((p) => {
      const li = document.createElement('li');
      li.className = 'player-item';
      li.style.background = `${p.color}22`;
      li.style.color = p.color;
      const name = document.createElement('span');
      name.textContent = playerLabel(p);
      const right = document.createElement('span');
      right.textContent = rightText(p);
      li.append(name, right);
      return li;
    }));
  }

  function applyLobby(payload) {
    state.hostId = payload.hostId;
    state.lobbyPlayers = payload.players;
    $('setup-view').style.display = 'none';
    $('room-view').style.display = 'block';
    $('room-code-txt').textContent = payload.roomCode;
    $('lobby-card').classList.toggle('link-room', state.linkRoom);
    renderSlots();
    const count = payload.players.length;
    $('start-btn').textContent = `Start game with ${count} player${count === 1 ? '' : 's'}`;
    $('start-btn').style.display = 'block';
    $('room-code-txt').classList.toggle('long', payload.roomCode.length > 6);
    $('share-link').value = shareLink(payload.roomCode);
    history.replaceState(null, '', `${basePath()}?room=${encodeURIComponent(payload.roomCode.toLowerCase())}`);
  }

  function showLobby() {
    state.playing = false;
    state.selected = null;
    $('game-view').style.display = 'none';
    $('game-over').style.display = 'none';
    $('lobby-card').style.display = 'block';
    document.body.classList.remove('in-game');
  }

  // Directory the game is served from, e.g. "/candymates/" on GitHub Pages or "/" locally.
  function basePath() {
    return location.pathname.replace(/[^/]*$/, '');
  }

  function shareLink(roomCode) {
    return `${location.origin}${basePath()}${roomCode.toLowerCase()}`;
  }

  function resetToSetup() {
    history.replaceState(null, '', basePath());
    state.linkRoom = false;
    $('lobby-card').classList.remove('link-room');
    state.playerId = null;
    state.hostId = null;
    state.lobbyPlayers = [];
    renderSlots();
    $('room-view').style.display = 'none';
    $('setup-view').style.display = 'block';
    showLobby();
  }

  function setConnecting(connecting) {
    $('create-btn').disabled = connecting;
    $('join-btn').disabled = connecting;
    if (connecting) showError('');
    $('connecting-hint').textContent = 'Connecting...';
    $('connecting-hint').style.display = connecting ? 'block' : 'none';
  }

  function handleJoinResponse(res) {
    setConnecting(false);
    if (!res.ok) {
      if (state.linkRoom || $('room-view').style.display === 'block') resetToSetup();
      return showError(res.error);
    }
    showError('');
    state.playerId = res.playerId;
    applyLobby(res);
  }

  $('create-btn').addEventListener('click', () => {
    setConnecting(true);
    socket.emit('createRoom', handleJoinResponse);
  });
  $('join-btn').addEventListener('click', () => {
    const code = $('room-input').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) return showError('Enter a 4-letter room code.');
    setConnecting(true);
    socket.emit('joinRoom', code, handleJoinResponse);
  });
  $('room-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('join-btn').click();
  });
  $('start-btn').addEventListener('click', () => socket.emit('startGame'));
  $('again-btn').addEventListener('click', () => socket.emit('startGame'));
  $('leave-btn').addEventListener('click', () => {
    socket.emit('leaveRoom');
    resetToSetup();
  });
  $('exit-btn').addEventListener('click', showLobby);
  // Link rooms: leave and go back to the home screen to create or join a different room.
  $('home-btn').addEventListener('click', () => {
    socket.emit('leaveRoom');
    resetToSetup();
  });

  socket.on('lobbyUpdate', applyLobby);
  socket.on('disconnect', (reason) => {
    resetToSetup();
    showError(reason || 'Disconnected.');
  });
  // Progress through connection steps, so a stuck step is visible instead of a bare "Connecting...".
  socket.on('status', (text) => {
    if ($('connecting-hint').style.display === 'block') $('connecting-hint').textContent = text;
    if ($('reconnect-hint').style.display === 'block') $('reconnect-hint').textContent = text;
  });
  socket.on('reconnecting', (message) => {
    showLobby();
    $('start-btn').style.display = 'none';
    showError('');
    $('reconnect-hint').textContent = message;
    $('reconnect-hint').style.display = 'block';
  });
  socket.on('rejoined', (res) => {
    $('reconnect-hint').style.display = 'none';
    handleJoinResponse(res);
  });

  $('copy-btn').addEventListener('click', async () => {
    const input = $('share-link');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    $('copy-btn').textContent = 'Copied!';
    setTimeout(() => { $('copy-btn').textContent = 'Copy'; }, 1500);
  });

  // Links like /candymates/mate (or ?room=mate) open that room: join it if someone is hosting, otherwise host it.
  function enterRoomFromUrl() {
    const requested = new URLSearchParams(location.search).get('room');
    if (!requested) return;
    if (!window.CandymatesNet.normaliseRoomName(requested)) {
      history.replaceState(null, '', basePath());
      return showError('Room names are 2-16 letters, numbers or dashes.');
    }
    state.linkRoom = true;
    $('lobby-card').classList.add('link-room');
    setConnecting(true);
    socket.emit('enterRoom', requested, handleJoinResponse);
  }

  // ---------- Game ----------

  function updateScoreboard(players) {
    state.players = players;
    document.querySelectorAll('.score-tag[data-slot]').forEach((tag) => {
      const p = players.find((pl) => pl.number === Number(tag.dataset.slot));
      tag.classList.toggle('empty', !p);
      if (!p) return;
      tag.style.color = p.color;
      if (!tag.firstChild) tag.innerHTML = '<span class="tag-name"></span><span class="tag-score"></span>';
      tag.querySelector('.tag-name').textContent = playerLabel(p);
      const scoreEl = tag.querySelector('.tag-score');
      if (scoreEl.textContent !== String(p.score)) {
        if (scoreEl.textContent !== '' && p.score > Number(scoreEl.textContent)) {
          tag.classList.remove('bump');
          void tag.offsetWidth; // restart the animation
          tag.classList.add('bump');
        }
        scoreEl.textContent = p.score;
      }
    });
  }

  const playerById = (id) => state.players.find((p) => p.id === id);

  // Puts the whole board on screen as it is (new game, or joining mid-game).
  function setBoard(grid) {
    state.grid = grid.map((row) => row.map((cell) => (cell ? { ...cell } : null)));
    state.sprites = new Map();
    grid.forEach((row, y) => row.forEach((cell, x) => {
      if (cell) state.sprites.set(cell.id, { c: cell.c, s: cell.s, x, y, scale: 1, alpha: 1 });
    }));
    state.queue = [];
    state.current = null;
  }

  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = state.cols * CELL;
    const h = state.rows * CELL;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    document.querySelectorAll('.hud').forEach((hud) => { hud.style.maxWidth = `${w}px`; });
  }

  socket.on('gameStarted', (payload) => {
    applyLobby(payload);
    state.cols = payload.board.cols;
    state.rows = payload.board.rows;
    state.tickMs = 1000 / payload.tickRate;
    state.ticksLeft = payload.ticksLeft;
    state.readyTicks = payload.readyTicks;
    state.lastTimerSecs = undefined;
    state.lastReadySecs = undefined;
    state.popups = [];
    state.particles = [];
    state.beams = [];
    state.wiggles = [];
    state.cursors = [];
    state.selected = null;
    state.goUntil = 0;
    setBoard(payload.board.grid);
    sizeCanvas();
    state.playing = true;

    $('lobby-card').style.display = 'none';
    $('game-over').style.display = 'none';
    $('game-view').style.display = 'flex';
    document.body.classList.add('in-game');
    updateScoreboard(payload.players);
    if (!state.rafId) state.rafId = requestAnimationFrame(render);
  });

  socket.on('state', (snapshot) => {
    if (!state.grid) return;
    const wasReady = state.readyTicks > 0;
    state.ticksLeft = snapshot.ticksLeft;
    state.readyTicks = snapshot.readyTicks;
    state.cursors = snapshot.cursors;
    const readySecs = Math.ceil(state.readyTicks / TICK_RATE);
    if (state.readyTicks > 0 && readySecs !== state.lastReadySecs) playSound('ready');
    state.lastReadySecs = readySecs;
    if (wasReady && state.readyTicks === 0) {
      state.goUntil = performance.now() + 700;
      playSound('go');
    }
  });

  socket.on('swap', (msg) => {
    if (!state.grid) return;
    queueSwap(msg);
    if (document.hidden) flushQueue();
    updateScoreboard(msg.players);
  });

  socket.on('swapRejected', ({ a, b }) => {
    // Your swap didn't make a match: the two candies nudge towards each other and back.
    state.wiggles.push({ a, b, start: performance.now() });
    playSound('bad');
  });

  socket.on('gameOver', ({ standings, winnerIds }) => {
    state.playing = false;
    state.selected = null;
    const winners = standings.filter((p) => winnerIds.includes(p.id));
    let title = 'TIME UP!';
    if (winners.length === 1) title = winners[0].id === state.playerId ? 'YOU WIN!' : `${winners[0].name} WINS!`;
    else if (winners.length > 1) title = "IT'S A DRAW!";
    $('game-over-title').textContent = title;
    renderPlayerList($('standings'), standings, (p) => `${p.score}`);
    $('game-over').style.display = 'block';
    playSound('end');
  });

  // ---------- Animation queue ----------
  // Each swap arrives as a list of steps (what was cleared, then the board after candies fall).
  // They play one after another so every player sees the same thing; if several players swap at
  // once the queue speeds up to keep up.

  const easeOut = (t) => 1 - (1 - t) ** 3;
  const easeOutBack = (t) => {
    const c1 = 1.4;
    return 1 + (c1 + 1) * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  };

  function queueSwap(msg) {
    const color = (playerById(msg.by) || {}).color || '#fff';
    state.queue.push({ kind: 'swap', a: msg.a, b: msg.b, dur: 140 });
    msg.steps.forEach((step) => {
      if (step.shuffle) {
        state.queue.push({ kind: 'shuffle', board: step.board, dur: 450 });
        return;
      }
      state.queue.push({ kind: 'pop', step, color, by: msg.by, dur: 200 });
      state.queue.push({
        kind: 'fall',
        board: step.board,
        created: new Set(step.created.map((m) => m.id)),
        madeAt: new Map(step.created.map((m) => [m.id, { x: m.x, y: m.y }])),
        dur: 240,
      });
    });
  }

  // quiet: catching up (hidden tab or a big backlog), so no sounds or effects.
  function startTask(task, now, quiet = false) {
    task.start = now;
    if (quiet) task.quiet = true;
    if (task.kind === 'swap') {
      const { a, b } = task;
      const ca = state.grid[a.y][a.x];
      const cb = state.grid[b.y][b.x];
      task.ids = [ca && ca.id, cb && cb.id];
      state.grid[a.y][a.x] = cb;
      state.grid[b.y][b.x] = ca;
      if (state.selected) state.selected = null;
      if (!quiet) playSound('swap');
    } else if (task.kind === 'pop' && quiet) {
      task.ids = task.step.cleared.map((cl) => cl.id);
    } else if (task.kind === 'pop') {
      const { step, color } = task;
      let sx = 0;
      let sy = 0;
      step.cleared.forEach((cl) => {
        sx += cl.x;
        sy += cl.y;
        const pal = cl.c === null ? { base: '#c8864a' } : CANDY[cl.c];
        for (let i = 0; i < 5; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 1.5 + Math.random() * 3;
          state.particles.push({ x: cl.x + 0.5, y: cl.y + 0.5, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.5, color: pal.base, born: now, life: 500 + Math.random() * 300 });
        }
        if (cl.s === 'h') state.beams.push({ kind: 'row', y: cl.y, start: now });
        if (cl.s === 'v') state.beams.push({ kind: 'col', x: cl.x, start: now });
        if (cl.s === 'w') state.beams.push({ kind: 'ring', x: cl.x, y: cl.y, start: now });
        if (cl.s === 'bomb') state.beams.push({ kind: 'flash', start: now });
      });
      const n = step.cleared.length || 1;
      state.popups.push({ text: `+${step.points}`, x: sx / n + 0.5, y: sy / n + 0.5, color, born: now, big: step.level > 1 });
      if (step.level > 1) state.popups.push({ text: `Combo x${step.level}`, x: sx / n + 0.5, y: sy / n - 0.2, color: '#fff', born: now, small: true });
      const kinds = new Set(step.cleared.map((cl) => cl.s));
      if (kinds.has('bomb')) playSound('bomb');
      else if (kinds.has('w')) playSound('wrapped');
      else if (kinds.has('h') || kinds.has('v')) playSound('stripe');
      playSound('pop', step.level);
      if (step.created.length) playSound('special');
      task.ids = step.cleared.map((cl) => cl.id);
    } else if (task.kind === 'fall' || task.kind === 'shuffle') {
      // Work out where every candy comes from and where it lands.
      const from = new Map();
      state.sprites.forEach((sp, id) => from.set(id, { x: sp.x, y: sp.y }));
      const next = new Map();
      const created = task.created || new Set();
      const newPerCol = new Array(state.cols).fill(0);
      task.board.forEach((row) => row.forEach((cell, x) => { if (cell && !from.has(cell.id) && !created.has(cell.id)) newPerCol[x]++; }));
      const seen = new Array(state.cols).fill(0);
      task.board.forEach((row, y) => row.forEach((cell, x) => {
        if (!cell) return;
        let start = from.get(cell.id);
        const made = created.has(cell.id);
        if (!start && made) {
          // A new special candy appears where it was made (it can still fall from there).
          const at = task.madeAt && task.madeAt.get(cell.id);
          start = at || { x, y };
        } else if (!start) {
          // New candies drop in from above the board.
          seen[x]++;
          start = { x, y: -newPerCol[x] + seen[x] - 1 };
        }
        next.set(cell.id, { c: cell.c, s: cell.s, x: start.x, y: start.y, fx: start.x, fy: start.y, tx: x, ty: y, scale: made ? 1.25 : 1, alpha: 1, made });
      }));
      state.sprites = next;
      state.grid = task.board.map((row) => row.map((cell) => (cell ? { ...cell } : null)));
      if (task.kind === 'shuffle' && !quiet) playSound('shuffle');
    }
  }

  function updateTask(task, t) {
    if (task.kind === 'swap') {
      const [ia, ib] = task.ids;
      const k = easeOut(t);
      const sa = state.sprites.get(ia);
      const sb = state.sprites.get(ib);
      if (sa) { sa.x = task.a.x + (task.b.x - task.a.x) * k; sa.y = task.a.y + (task.b.y - task.a.y) * k; }
      if (sb) { sb.x = task.b.x + (task.a.x - task.b.x) * k; sb.y = task.b.y + (task.a.y - task.b.y) * k; }
    } else if (task.kind === 'pop') {
      task.ids.forEach((id) => {
        const sp = state.sprites.get(id);
        if (!sp) return;
        sp.scale = t < 0.3 ? 1 + t : 1.3 * (1 - (t - 0.3) / 0.7);
        sp.alpha = 1 - t * 0.6;
      });
    } else {
      const k = task.kind === 'shuffle' ? easeOut(t) : easeOutBack(t);
      state.sprites.forEach((sp) => {
        sp.x = sp.fx + (sp.tx - sp.fx) * k;
        sp.y = sp.fy + (sp.ty - sp.fy) * k;
        if (sp.made) sp.scale = 1.25 - 0.25 * t;
      });
    }
  }

  function finishTask(task) {
    updateTask(task, 1);
    if (task.kind === 'pop') task.ids.forEach((id) => state.sprites.delete(id));
  }

  // Jumps straight to the end of everything queued, without animating it.
  function flushQueue() {
    const now = performance.now();
    if (state.current) finishTask(state.current);
    state.current = null;
    while (state.queue.length) {
      const task = state.queue.shift();
      startTask(task, now, true);
      finishTask(task);
    }
  }
  // Browsers pause animation in hidden tabs: catch up instantly there instead of piling up a backlog.
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushQueue(); });

  function runQueue(now) {
    // A huge backlog (e.g. the tab was busy): skip ahead to the latest board.
    if (state.queue.length > 24) flushQueue();
    // Busy board: play the backlog faster.
    const speed = 1 + Math.max(0, state.queue.length - 2) * 0.35;
    for (let guard = 0; guard < 50; guard++) {
      if (!state.current) {
        const next = state.queue.shift();
        if (!next) return;
        startTask(next, now);
        state.current = next;
      }
      const task = state.current;
      const t = Math.min(1, ((now - task.start) * speed) / task.dur);
      updateTask(task, t);
      if (t < 1) return;
      finishTask(task);
      state.current = null;
    }
  }

  // ---------- Controls ----------

  function cellFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * state.cols);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * state.rows);
    if (x < 0 || y < 0 || x >= state.cols || y >= state.rows) return null;
    return { x, y };
  }

  let lastCursorSent = 0;
  let cursorTimer = null;
  function sendCursor(cell) {
    const send = () => {
      lastCursorSent = performance.now();
      cursorTimer = null;
      const c = state.hover;
      socket.emit('input', c ? { type: 'cursor', x: c.x, y: c.y, sel: !!state.selected && state.selected.x === c.x && state.selected.y === c.y } : { type: 'cursor' });
    };
    state.hover = cell;
    if (cursorTimer) return;
    const wait = 80 - (performance.now() - lastCursorSent);
    if (wait <= 0) send();
    else cursorTimer = setTimeout(send, wait);
  }

  function canPlay() {
    return state.playing && state.readyTicks <= 0 && state.ticksLeft > 0;
  }

  function trySwap(a, b) {
    if (!canPlay()) return;
    if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) !== 1) return;
    const ca = state.grid[a.y] && state.grid[a.y][a.x];
    const cb = state.grid[b.y] && state.grid[b.y][b.x];
    if (!ca || !cb) return;
    socket.emit('input', { type: 'swap', a: { x: a.x, y: a.y, id: ca.id }, b: { x: b.x, y: b.y, id: cb.id } });
    state.selected = null;
    state.drag = null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!state.playing) return;
    const cell = cellFromEvent(e);
    if (!cell) return;
    canvas.setPointerCapture(e.pointerId);
    const sel = state.selected;
    if (sel && Math.abs(sel.x - cell.x) + Math.abs(sel.y - cell.y) === 1) {
      trySwap(sel, cell);
      return;
    }
    state.selected = sel && sel.x === cell.x && sel.y === cell.y ? null : cell;
    state.drag = { cell, px: e.clientX, py: e.clientY };
    sendCursor(cell);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!state.playing) return;
    const cell = cellFromEvent(e);
    if (state.drag) {
      // Dragging a candy far enough towards a neighbour swaps them.
      const rect = canvas.getBoundingClientRect();
      const cellPx = rect.width / state.cols;
      const dx = e.clientX - state.drag.px;
      const dy = e.clientY - state.drag.py;
      if (Math.max(Math.abs(dx), Math.abs(dy)) > cellPx * 0.4) {
        const from = state.drag.cell;
        const to = Math.abs(dx) > Math.abs(dy) ? { x: from.x + Math.sign(dx), y: from.y } : { x: from.x, y: from.y + Math.sign(dy) };
        if (to.x >= 0 && to.y >= 0 && to.x < state.cols && to.y < state.rows) trySwap(from, to);
        state.drag = null;
      }
    }
    if (!cell || !state.hover || cell.x !== state.hover.x || cell.y !== state.hover.y) sendCursor(cell);
  });

  const endDrag = () => { state.drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => { if (!state.drag) sendCursor(null); });

  // Keyboard: arrows move, Space/Enter picks a candy, then an arrow swaps it that way.
  const DIRS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0] };
  window.addEventListener('keydown', (e) => {
    if (!state.playing || e.target.tagName === 'INPUT') return;
    const dir = DIRS[e.key] || DIRS[e.key.toLowerCase()];
    const here = state.hover || { x: Math.floor(state.cols / 2), y: Math.floor(state.rows / 2) };
    if (dir) {
      e.preventDefault();
      const to = { x: Math.max(0, Math.min(state.cols - 1, here.x + dir[0])), y: Math.max(0, Math.min(state.rows - 1, here.y + dir[1])) };
      if (state.selected) {
        trySwap(state.selected, to);
        sendCursor(to);
      } else {
        sendCursor(to);
      }
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      state.selected = state.selected ? null : here;
      sendCursor(here);
    } else if (e.key === 'Escape') {
      state.selected = null;
    }
  });

  // ---------- Render ----------

  function drawTimer() {
    const secs = Math.max(0, Math.ceil(state.ticksLeft * state.tickMs / 1000));
    const text = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    const el = $('timer');
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle('low', secs <= 10);
    if (secs !== state.lastTimerSecs) {
      if (state.playing && state.readyTicks <= 0 && secs >= 1 && secs <= 10 && state.lastTimerSecs !== undefined) {
        playSound('tick', secs);
        el.classList.remove('pulse');
        void el.offsetWidth; // restart the animation
        el.classList.add('pulse');
      }
      state.lastTimerSecs = secs;
    }
  }

  function drawBoardBackground(w, h) {
    ctx.fillStyle = 'rgba(42, 16, 51, 0.92)';
    roundRect(ctx, 0, 0, w, h, 18);
    ctx.fill();
    for (let y = 0; y < state.rows; y++) {
      for (let x = 0; x < state.cols; x++) {
        ctx.fillStyle = (x + y) % 2 ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.1)';
        roundRect(ctx, x * CELL + 2, y * CELL + 2, CELL - 4, CELL - 4, 10);
        ctx.fill();
      }
    }
  }

  function cellBox(x, y, inset, radius) {
    roundRect(ctx, x * CELL + inset, y * CELL + inset, CELL - inset * 2, CELL - inset * 2, radius);
  }

  function drawCursors(now) {
    // Other players: their colour around the candy they're on (filled glow once they've picked it).
    state.cursors.forEach((cur) => {
      if (!cur.on || cur.id === state.playerId) return;
      const p = playerById(cur.id);
      if (!p) return;
      ctx.save();
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 3;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = cur.sel ? 14 : 6;
      cellBox(cur.x, cur.y, 3, 10);
      ctx.stroke();
      if (cur.sel) {
        ctx.fillStyle = `${p.color}33`;
        ctx.fill();
      }
      ctx.restore();
      // Name tag above the cell.
      ctx.font = '10px "Geist Pixel", monospace';
      const w = ctx.measureText(p.name).width + 10;
      const tx = Math.max(0, Math.min(state.cols * CELL - w, cur.x * CELL + CELL / 2 - w / 2));
      const ty = Math.max(0, cur.y * CELL - 8);
      ctx.fillStyle = p.color;
      roundRect(ctx, tx, ty, w, 14, 7);
      ctx.fill();
      ctx.fillStyle = '#12051a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.name, tx + w / 2, ty + 7.5);
    });
    const me = playerById(state.playerId);
    const myColor = me ? me.color : '#fff';
    if (state.hover && canPlay()) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.lineWidth = 2;
      cellBox(state.hover.x, state.hover.y, 3, 10);
      ctx.stroke();
    }
    if (state.selected) {
      const pulse = 0.6 + 0.4 * Math.sin(now / 120);
      ctx.save();
      ctx.strokeStyle = myColor;
      ctx.lineWidth = 3.5;
      ctx.shadowColor = myColor;
      ctx.shadowBlur = 16 * pulse;
      cellBox(state.selected.x, state.selected.y, 2, 11);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawCandies(now) {
    // Rejected swaps: the two candies nudge towards each other and back.
    const nudge = new Map();
    state.wiggles = state.wiggles.filter((wg) => now - wg.start < 260);
    state.wiggles.forEach((wg) => {
      const t = (now - wg.start) / 260;
      const k = Math.sin(t * Math.PI) * 0.3;
      const ca = state.grid[wg.a.y] && state.grid[wg.a.y][wg.a.x];
      const cb = state.grid[wg.b.y] && state.grid[wg.b.y][wg.b.x];
      if (ca) nudge.set(ca.id, [(wg.b.x - wg.a.x) * k, (wg.b.y - wg.a.y) * k]);
      if (cb) nudge.set(cb.id, [(wg.a.x - wg.b.x) * k, (wg.a.y - wg.b.y) * k]);
    });
    ctx.save();
    roundRect(ctx, 0, 0, state.cols * CELL, state.rows * CELL, 18);
    ctx.clip(); // new candies dropping in appear from the top edge
    state.sprites.forEach((sp, id) => {
      const [nx, ny] = nudge.get(id) || [0, 0];
      const img = candySprite(sp.c, sp.s);
      const size = CELL * sp.scale;
      const cx = (sp.x + nx + 0.5) * CELL;
      const cy = (sp.y + ny + 0.5) * CELL;
      ctx.globalAlpha = sp.alpha;
      ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    });
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawEffects(now) {
    const w = state.cols * CELL;
    const h = state.rows * CELL;
    // Striped beams, wrapped blasts and colour-bomb flashes.
    state.beams = state.beams.filter((b) => now - b.start < 400);
    state.beams.forEach((b) => {
      const t = (now - b.start) / 400;
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = '#fff';
      ctx.shadowColor = '#fff';
      ctx.shadowBlur = 20;
      const thick = CELL * 0.5 * (1 - t * 0.6);
      if (b.kind === 'row') ctx.fillRect(0, (b.y + 0.5) * CELL - thick / 2, w, thick);
      else if (b.kind === 'col') ctx.fillRect((b.x + 0.5) * CELL - thick / 2, 0, thick, h);
      else if (b.kind === 'ring') {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 6 * (1 - t);
        ctx.beginPath();
        ctx.arc((b.x + 0.5) * CELL, (b.y + 0.5) * CELL, CELL * (0.5 + t * 1.6), 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.globalAlpha = 0.45 * (1 - t);
        ctx.fillRect(0, 0, w, h);
      }
      ctx.restore();
    });
    // Sparkly bits from popped candies.
    state.particles = state.particles.filter((p) => now - p.born < p.life);
    state.particles.forEach((p) => {
      const t = (now - p.born) / 1000;
      const x = (p.x + p.vx * t * 0.6) * CELL;
      const y = (p.y + p.vy * t * 0.6 + 2.5 * t * t) * CELL;
      ctx.globalAlpha = 1 - (now - p.born) / p.life;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    // Points float up in the colour of the player who scored them.
    state.popups = state.popups.filter((p) => now - p.born < 900);
    state.popups.forEach((p) => {
      const t = (now - p.born) / 900;
      const size = p.small ? 13 : p.big ? 24 : 19;
      ctx.font = `${size}px "Geist Pixel", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const x = Math.max(40, Math.min(w - 40, p.x * CELL));
      const y = p.y * CELL - t * CELL * 0.8;
      ctx.globalAlpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(18, 5, 26, 0.85)';
      ctx.strokeText(p.text, x, y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, x, y);
    });
    ctx.globalAlpha = 1;
  }

  // "Ready?" and a countdown before the board opens, then "Go!".
  function drawReady(now) {
    const w = state.cols * CELL;
    const h = state.rows * CELL;
    let text = null;
    if (state.readyTicks > 0) text = `Ready? ${Math.ceil(state.readyTicks / TICK_RATE)}`;
    else if (now < state.goUntil) text = 'Go!';
    if (!text) return;
    ctx.fillStyle = 'rgba(18, 5, 26, 0.55)';
    roundRect(ctx, 0, 0, w, h, 18);
    ctx.fill();
    ctx.font = '56px "Geist Pixel", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#5a1240';
    ctx.strokeText(text, w / 2, h / 2);
    ctx.fillStyle = '#ffe14f';
    ctx.fillText(text, w / 2, h / 2);
  }

  function render(now) {
    state.rafId = requestAnimationFrame(render);
    if (!state.grid || $('game-view').style.display === 'none') return;
    runQueue(now);
    const dpr = canvas.width / (state.cols * CELL);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, state.cols * CELL, state.rows * CELL);
    drawTimer();
    drawBoardBackground(state.cols * CELL, state.rows * CELL);
    drawCursors(now);
    drawCandies(now);
    drawEffects(now);
    drawReady(now);
  }

  // Debug aid: ?debug exposes the client state (and a way to skip to the end of the animations).
  if (new URLSearchParams(location.search).has('debug')) window.__candymatesDebug = { state, flushQueue };

  buildSlots();
  renderSlots();
  enterRoomFromUrl();
  requestAnimationFrame(animateSlots);
})();
