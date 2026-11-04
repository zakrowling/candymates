(() => {
  const socket = window.CandymatesNet.createNet();
  const { TICK_RATE } = window.CandymatesEngine;

  const CELL = 1032 / 16; // board cell size in CSS pixels: the board is as wide as the Pacmates maze (1032px)
  // Candy colours: red bean, orange drop, yellow lemon, green chew, blue gumball, purple gem.
  // Sweet pastel-candy colours: strawberry heart, peach drop, lemon star, mint chew, blueberry
  // gumdrop and lavender gem.
  const CANDY = [
    { base: '#ff2f86', light: '#ffb3d4', dark: '#a80f55', glow: '#ffd0e4' },
    { base: '#ff8a1f', light: '#ffd3a3', dark: '#b84a00', glow: '#ffe1bd' },
    { base: '#ffcc1a', light: '#fff1a3', dark: '#b58200', glow: '#fff4c2' },
    { base: '#22c98a', light: '#a9f2d4', dark: '#0b7a4c', glow: '#c9f9e4' },
    { base: '#2e9dff', light: '#b3dcff', dark: '#1259b0', glow: '#cfe8ff' },
    { base: '#a14dff', light: '#dcbcff', dark: '#5a1fb0', glow: '#e9d8ff' },
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

  // A bright bell: a sine with a soft higher partial, like a little music-box chime.
  function bell(ac, f, t0, dur, peak) {
    osc(ac, { from: f, t0, dur, peak, attack: 0.003 });
    osc(ac, { from: f * 2.76, t0, dur: dur * 0.5, peak: peak * 0.3, attack: 0.002 });
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
    // Matches: a bouncy "pi-pu!" chirp and a little bell, climbing a cute scale each cascade.
    pop(ac, level = 1) {
      const t = ac.currentTime;
      const f = SCALE[Math.min(SCALE.length - 1, level - 1)];
      osc(ac, { from: f, to: f * 1.5, dur: 0.07, peak: 0.36, t0: t, attack: 0.003 });
      osc(ac, { from: f * 1.33, to: f * 2, dur: 0.09, peak: 0.32, t0: t + 0.075, attack: 0.003 });
      bell(ac, f * 2, t + 0.07, 0.35, 0.16);
    },
    // A special candy is made: a magical twinkle running up the scale.
    special(ac) {
      const t = ac.currentTime;
      [1047, 1319, 1568, 2093, 2637].forEach((f, i) => bell(ac, f, t + i * 0.055, 0.4, 0.15));
      noise(ac, { t0: t, dur: 0.4, peak: 0.06, type: 'highpass', from: 6000, to: 9000 });
    },
    // Striped candy goes off: a sparkly swish.
    stripe(ac) {
      const t = ac.currentTime;
      osc(ac, { type: 'triangle', from: 600, to: 2400, dur: 0.22, peak: 0.22 });
      noise(ac, { dur: 0.28, peak: 0.12, from: 2000, to: 7000, q: 0.8 });
      [1568, 2093, 2637].forEach((f, i) => bell(ac, f, t + 0.12 + i * 0.05, 0.3, 0.1));
    },
    // Wrapped candy goes off: a springy "boing".
    wrapped(ac) {
      const t = ac.currentTime;
      const o = ac.createOscillator();
      const vib = ac.createOscillator();
      const vibGain = ac.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(220, t);
      o.frequency.exponentialRampToValueAtTime(660, t + 0.08);
      o.frequency.exponentialRampToValueAtTime(330, t + 0.4);
      vib.frequency.value = 22;
      vibGain.gain.value = 40;
      vib.connect(vibGain).connect(o.frequency);
      o.connect(envGain(ac, t, 0.4, 0.005, 0.4));
      o.start(t);
      vib.start(t);
      o.stop(t + 0.5);
      vib.stop(t + 0.5);
      bell(ac, 1319, t + 0.05, 0.3, 0.1);
    },
    // Colour bomb: a rainbow glissando of bells.
    bomb(ac) {
      const t = ac.currentTime;
      [523, 659, 784, 1047, 1319, 1568, 2093, 2637, 3136].forEach((f, i) => bell(ac, f, t + i * 0.04, 0.45, 0.14));
      osc(ac, { from: 260, to: 520, t0: t, dur: 0.3, peak: 0.25 });
    },
    ready(ac) {
      osc(ac, { type: 'square', from: 660, dur: 0.12, peak: 0.07 });
    },
    // "Ta-da!"
    go(ac) {
      const t = ac.currentTime;
      [784, 1047, 1319, 1568].forEach((f, i) => bell(ac, f, t + i * 0.07, 0.5, 0.14));
      osc(ac, { from: 1047, to: 2093, t0: t + 0.28, dur: 0.12, peak: 0.25 });
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

  // ---------- Background music ----------
  // A different track each round, in this order, then back to the first.
  const MUSIC_TRACKS = [
    'assets/audio/mochamusic-sugar-rush.mp3',
    'assets/audio/mochamusic-cotton-confetti.mp3',
    'assets/audio/mochamusic-playful-pastries.mp3',
  ];
  // Plays quietly while a game is on. Its position follows the shared game clock (seconds since
  // play started), so every player hears the same part of the track, even if their browser only
  // lets it start after a click or key press. At the end of the track it crossfades into the
  // start again (two copies of the track overlap for a moment), so the loop feels continuous.
  const music = (() => {
    const VOLUME = 0.2;
    const FADE = 2.5; // seconds of crossfade at the loop point (and fade in/out at start/stop)
    const tracks = [new Audio(MUSIC_TRACKS[0]), new Audio(MUSIC_TRACKS[0])];
    tracks.forEach((t) => { t.preload = 'auto'; t.volume = 0; });
    let source = MUSIC_TRACKS[0];
    let clock = null; // () => seconds into the game, or null when stopped
    let fadeOutFrom = 0; // when stopping: performance.now() the fade out began
    let timer = null;

    const play = (t) => { if (t.paused) t.play().catch(() => {}); };
    const seek = (t, at) => { if (Math.abs(t.currentTime - at) > 0.3) t.currentTime = at; };

    function update() {
      const duration = tracks[0].duration;
      if (fadeOutFrom) {
        const k = 1 - (performance.now() - fadeOutFrom) / (FADE * 1000);
        tracks.forEach((t) => { t.volume = Math.max(0, t.volume * Math.max(0, k)); });
        if (k <= 0) halt();
        return;
      }
      if (!clock) return;
      if (!state.playing) { halt(); return; }
      const elapsed = Math.max(0, clock());
      if (!(duration > FADE * 2)) {
        // Length not known yet: just start playing; the loop maths takes over once it's loaded.
        play(tracks[0]);
        tracks[0].volume = VOLUME * Math.min(1, elapsed / FADE);
        return;
      }
      const period = duration - FADE; // each loop starts as the previous one begins to fade
      const loop = Math.floor(elapsed / period);
      const at = elapsed - loop * period;
      const cur = tracks[loop % 2];
      const prev = tracks[(loop + 1) % 2];
      play(cur);
      seek(cur, at);
      cur.volume = VOLUME * Math.min(1, at / FADE);
      if (loop > 0 && at < FADE) {
        // The previous loop's tail fading out underneath.
        play(prev);
        seek(prev, at + period);
        prev.volume = VOLUME * (1 - at / FADE);
      } else if (!prev.paused) {
        prev.pause();
      }
    }

    function halt() {
      clearInterval(timer);
      timer = null;
      clock = null;
      fadeOutFrom = 0;
      tracks.forEach((t) => { t.pause(); t.volume = 0; });
    }

    // If autoplay was blocked, the next click or key press starts it (in the right place).
    ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => { if (clock) update(); }));

    return {
      // src: this round's track.
      start(gameClock, src = source) {
        if (!state.playing) return; // only ever during a game
        if (src !== source) {
          halt();
          source = src;
          tracks.forEach((t) => { t.src = src; t.load(); });
        }
        fadeOutFrom = 0;
        clock = gameClock;
        if (!timer) timer = setInterval(update, 100);
        update();
      },
      // Gentle fade out (game over).
      fadeOut() {
        if (clock && !fadeOutFrom) fadeOutFrom = performance.now();
      },
      stop: halt,
    };
  })();

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
    if (colour === 0) { // heart
      c.moveTo(0, r * 0.92);
      c.bezierCurveTo(-r * 0.2, r * 0.7, -r * 1.02, r * 0.2, -r * 0.95, -r * 0.3);
      c.bezierCurveTo(-r * 0.9, -r * 0.95, -r * 0.15, -r * 1.0, 0, -r * 0.42);
      c.bezierCurveTo(r * 0.15, -r * 1.0, r * 0.9, -r * 0.95, r * 0.95, -r * 0.3);
      c.bezierCurveTo(r * 1.02, r * 0.2, r * 0.2, r * 0.7, 0, r * 0.92);
    } else if (colour === 1) { // round drop
      c.arc(0, r * 0.04, r * 0.86, 0, Math.PI * 2);
    } else if (colour === 2) { // puffy star
      for (let i = 0; i < 5; i++) {
        const a0 = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
        const a1 = a0 + Math.PI / 5;
        const outer = [Math.cos(a0) * r * 0.98, Math.sin(a0) * r * 0.98 + r * 0.06];
        const inner = [Math.cos(a1) * r * 0.5, Math.sin(a1) * r * 0.5 + r * 0.06];
        if (i === 0) c.moveTo(...outer);
        else c.quadraticCurveTo(Math.cos(a0 - Math.PI / 5) * r * 0.55, Math.sin(a0 - Math.PI / 5) * r * 0.55 + r * 0.06, ...outer);
        c.quadraticCurveTo(Math.cos(a0) * r * 1.02, Math.sin(a0) * r * 1.02 + r * 0.06, ...outer);
        c.lineTo(...inner);
      }
      c.closePath();
    } else if (colour === 3) { // square chew
      roundRect(c, -r * 0.8, -r * 0.8, r * 1.6, r * 1.6, r * 0.42);
    } else if (colour === 4) { // gumdrop
      c.moveTo(-r * 0.86, r * 0.7);
      c.bezierCurveTo(-r * 0.95, -r * 0.2, -r * 0.6, -r * 0.9, 0, -r * 0.9);
      c.bezierCurveTo(r * 0.6, -r * 0.9, r * 0.95, -r * 0.2, r * 0.86, r * 0.7);
      c.quadraticCurveTo(0, r * 0.95, -r * 0.86, r * 0.7);
    } else { // gem
      c.moveTo(0, -r * 0.95);
      c.quadraticCurveTo(r * 0.3, -r * 0.3, r * 0.92, 0);
      c.quadraticCurveTo(r * 0.3, r * 0.3, 0, r * 0.95);
      c.quadraticCurveTo(-r * 0.3, r * 0.3, -r * 0.92, 0);
      c.quadraticCurveTo(-r * 0.3, -r * 0.3, 0, -r * 0.95);
    }
  }

  // Boiled-sweet / jelly shading for the current path, clipped to the candy so nothing spills
  // past its edge:
  //  - a juicy body gradient, lit from the top left, darker and richer towards the edge;
  //  - light glowing through the translucent candy at the bottom;
  //  - a glassy rim of light along the top edge;
  //  - a big soft shine, a crisp little glint and a sparkle.
  function shine(c, pal, r, path) {
    c.save();
    path();
    c.shadowColor = 'rgba(150, 25, 95, 0.38)';
    c.shadowBlur = r * 0.4;
    c.shadowOffsetY = r * 0.14;
    const body = c.createRadialGradient(-r * 0.32, -r * 0.42, r * 0.04, 0, r * 0.05, r * 1.1);
    body.addColorStop(0, pal.light);
    body.addColorStop(0.35, pal.base);
    body.addColorStop(0.8, pal.dark);
    body.addColorStop(1, pal.dark);
    c.fillStyle = body;
    c.fill();
    c.restore();

    c.save();
    path();
    c.clip();
    // Translucent glow: light passing through the sweet and out of its lower half.
    const glow = c.createRadialGradient(r * 0.12, r * 0.62, r * 0.05, r * 0.12, r * 0.55, r * 0.75);
    glow.addColorStop(0, `${pal.glow}e6`);
    glow.addColorStop(0.5, `${pal.light}66`);
    glow.addColorStop(1, `${pal.light}00`);
    c.fillStyle = glow;
    c.fillRect(-r * 1.3, -r * 1.3, r * 2.6, r * 2.6);
    // Depth: the colour gets richer near the edge, like looking through thicker candy.
    const depth = c.createRadialGradient(0, 0, r * 0.55, 0, 0, r * 1.05);
    depth.addColorStop(0, 'rgba(0, 0, 0, 0)');
    depth.addColorStop(1, `${pal.dark}88`);
    c.fillStyle = depth;
    c.fillRect(-r * 1.3, -r * 1.3, r * 2.6, r * 2.6);
    // Glassy rim light along the top edge.
    const rim = c.createLinearGradient(0, -r, 0, r * 0.2);
    rim.addColorStop(0, 'rgba(255, 255, 255, 0.85)');
    rim.addColorStop(1, 'rgba(255, 255, 255, 0)');
    c.strokeStyle = rim;
    c.lineWidth = r * 0.16;
    path();
    c.stroke();
    // Big soft shine.
    const hl = c.createLinearGradient(0, -r * 0.95, 0, -r * 0.1);
    hl.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
    hl.addColorStop(1, 'rgba(255, 255, 255, 0)');
    c.fillStyle = hl;
    c.beginPath();
    c.ellipse(-r * 0.1, -r * 0.45, r * 0.58, r * 0.32, -0.2, 0, Math.PI * 2);
    c.fill();
    // Crisp glint, a dot beside it, and a sparkle on the lit side.
    c.fillStyle = '#fff';
    c.beginPath();
    c.ellipse(-r * 0.38, -r * 0.48, r * 0.14, r * 0.075, -0.65, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.arc(-r * 0.16, -r * 0.6, r * 0.045, 0, Math.PI * 2);
    c.fill();
    sparkle(c, r * 0.36, -r * 0.08, r * 0.08);
    c.restore();

    // Fine darker outline so each sweet stands out from its neighbours.
    c.save();
    path();
    c.lineWidth = Math.max(1, r * 0.05);
    c.strokeStyle = pal.dark;
    c.globalAlpha = 0.85;
    c.stroke();
    c.restore();
  }

  function sparkle(c, x, y, s) {
    c.save();
    c.fillStyle = 'rgba(255, 255, 255, 0.95)';
    c.beginPath();
    c.moveTo(x, y - s * 2);
    c.quadraticCurveTo(x + s * 0.25, y - s * 0.25, x + s * 2, y);
    c.quadraticCurveTo(x + s * 0.25, y + s * 0.25, x, y + s * 2);
    c.quadraticCurveTo(x - s * 0.25, y + s * 0.25, x - s * 2, y);
    c.quadraticCurveTo(x - s * 0.25, y - s * 0.25, x, y - s * 2);
    c.fill();
    c.restore();
  }

  function heartPath(c, x, y, s) {
    c.beginPath();
    c.moveTo(x, y + s * 0.9);
    c.bezierCurveTo(x - s * 1.1, y + s * 0.1, x - s * 0.8, y - s * 0.9, x, y - s * 0.35);
    c.bezierCurveTo(x + s * 0.8, y - s * 0.9, x + s * 1.1, y + s * 0.1, x, y + s * 0.9);
  }

  // Colour bomb: a glossy chocolate truffle covered in rainbow sprinkles.
  function drawChocolateBomb(c, r) {
    const pal = { base: '#7a3f22', light: '#c98a5e', dark: '#3a1608', glow: '#d9a27a' };
    const path = () => { c.beginPath(); c.arc(0, 0, r * 0.88, 0, Math.PI * 2); };
    shine(c, pal, r, path);
    c.save();
    path();
    c.clip();
    const colours = ['#ff4f9a', '#ff9a3d', '#ffd23d', '#3fd49a', '#4cb4ff', '#b06bff', '#ffffff'];
    for (let i = 0; i < 18; i++) {
      const a = i * 2.4;
      const d = r * (0.15 + ((i * 37) % 10) / 13);
      c.save();
      c.translate(Math.cos(a) * d, Math.sin(a) * d);
      c.rotate(a * 1.7);
      c.fillStyle = colours[i % colours.length];
      roundRect(c, -r * 0.13, -r * 0.045, r * 0.26, r * 0.09, r * 0.045);
      c.fill();
      c.restore();
    }
    // Shine over the sprinkles too.
    c.fillStyle = 'rgba(255, 255, 255, 0.35)';
    c.beginPath();
    c.ellipse(-r * 0.1, -r * 0.45, r * 0.55, r * 0.3, -0.15, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  // Draws a candy centred at 0,0. A striped candy has bold white stripes; a wrapped candy sits in
  // a glossy wrapper with twisted ends; a colour bomb is a chocolate truffle with sprinkles.
  function drawCandy(c, colour, special, r) {
    if (special === 'bomb') {
      drawChocolateBomb(c, r);
      return;
    }
    const pal = CANDY[colour];
    if (special === 'w') {
      // Wrapper twists either side, in shiny cellophane.
      [-1, 1].forEach((side) => {
        const twist = () => {
          c.beginPath();
          c.moveTo(side * r * 0.55, -r * 0.12);
          c.quadraticCurveTo(side * r * 0.85, -r * 0.65, side * r * 1.08, -r * 0.48);
          c.quadraticCurveTo(side * r * 0.9, 0, side * r * 1.08, r * 0.48);
          c.quadraticCurveTo(side * r * 0.85, r * 0.65, side * r * 0.55, r * 0.12);
          c.closePath();
        };
        twist();
        const g = c.createLinearGradient(0, -r * 0.6, 0, r * 0.6);
        g.addColorStop(0, pal.light);
        g.addColorStop(0.5, pal.base);
        g.addColorStop(1, pal.dark);
        c.fillStyle = g;
        c.fill();
        c.strokeStyle = pal.dark;
        c.lineWidth = Math.max(1, r * 0.05);
        c.stroke();
      });
      const path = () => { c.beginPath(); c.ellipse(0, 0, r * 0.66, r * 0.6, 0, 0, Math.PI * 2); };
      shine(c, pal, r * 0.85, path);
      // A white ribbon band around the middle.
      c.save();
      path();
      c.clip();
      c.fillStyle = 'rgba(255, 255, 255, 0.55)';
      c.fillRect(-r * 0.12, -r, r * 0.24, r * 2);
      c.restore();
      return;
    }
    const path = () => candyPath(c, colour, r);
    shine(c, pal, r, path);
    if (special === 'h' || special === 'v') {
      c.save();
      path();
      c.clip();
      if (special === 'v') c.rotate(Math.PI / 2);
      for (let i = -2; i <= 2; i++) {
        const y = i * r * 0.42;
        const g = c.createLinearGradient(0, y - r * 0.1, 0, y + r * 0.1);
        g.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
        g.addColorStop(1, 'rgba(255, 230, 245, 0.75)');
        c.fillStyle = g;
        c.fillRect(-r * 1.2, y - r * 0.09, r * 2.4, r * 0.18);
      }
      c.restore();
    }
  }

  // Candies are pre-drawn once at screen resolution (with room for their soft shadow) and reused.
  const SPRITE_PAD = 1.25;
  const spriteCache = new Map();
  function candySprite(colour, special) {
    const dpr = window.devicePixelRatio || 1;
    const key = `${colour}:${special}:${dpr}`;
    if (!spriteCache.has(key)) {
      const box = CELL * SPRITE_PAD;
      const size = Math.ceil(box * dpr);
      const off = document.createElement('canvas');
      off.width = size;
      off.height = size;
      const g = off.getContext('2d');
      g.scale(dpr, dpr);
      g.translate(box / 2, box / 2);
      drawCandy(g, colour, special, CELL * 0.4);
      spriteCache.set(key, off);
    }
    return spriteCache.get(key);
  }

  // A glossy wrapped candy in a player's own colour, for the lobby slots.
  function drawPlayerCandy(c, color, cx, cy, r, now) {
    const shade = (hex, amt) => {
      const n = parseInt(hex.slice(1), 16);
      const ch = (v) => Math.max(0, Math.min(255, Math.round(v + amt * 255)));
      return `#${[ch(n >> 16), ch((n >> 8) & 255), ch(n & 255)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    };
    const pal = { base: color, light: shade(color, 0.4), dark: shade(color, -0.3), glow: shade(color, 0.5) };
    c.save();
    c.translate(cx, cy + Math.sin(now / 300) * 3);
    c.rotate(Math.sin(now / 600) * 0.15);
    drawCandyWithPalette(c, pal, r);
    c.restore();
  }

  function drawCandyWithPalette(c, pal, r) {
    [-1, 1].forEach((side) => {
      c.beginPath();
      c.moveTo(side * r * 0.55, -r * 0.12);
      c.quadraticCurveTo(side * r * 0.85, -r * 0.65, side * r * 1.1, -r * 0.5);
      c.quadraticCurveTo(side * r * 0.92, 0, side * r * 1.1, r * 0.5);
      c.quadraticCurveTo(side * r * 0.85, r * 0.65, side * r * 0.55, r * 0.12);
      c.closePath();
      const g = c.createLinearGradient(0, -r * 0.6, 0, r * 0.6);
      g.addColorStop(0, pal.light);
      g.addColorStop(0.5, pal.base);
      g.addColorStop(1, pal.dark);
      c.fillStyle = g;
      c.fill();
    });
    const path = () => { c.beginPath(); c.arc(0, 0, r * 0.66, 0, Math.PI * 2); };
    shine(c, pal, r * 0.75, path);
    c.save();
    path();
    c.clip();
    c.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    c.lineWidth = r * 0.13;
    for (let i = -2; i <= 2; i++) {
      c.beginPath();
      c.moveTo(i * r * 0.42 - r, -r);
      c.lineTo(i * r * 0.42 + r, r);
      c.stroke();
    }
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
        c.strokeStyle = '#ffb3d9';
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
    musicOn = false;
    music.stop();
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

  socket.on('lobbyUpdate', (payload) => {
    applyLobby(payload);
    // Someone joining (or leaving) mid-game: show their score tag and pointer colour straight away,
    // without interrupting the round.
    if (state.playing) updateScoreboard(payload.players);
  });
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
    state.gameSeconds = payload.gameSeconds;
    state.round = payload.round;
    state.lastStateAt = performance.now();
    musicOn = false;
    music.stop();
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
    state.lastStateAt = performance.now();
    state.cursors = snapshot.cursors;
    const readySecs = Math.ceil(state.readyTicks / TICK_RATE);
    if (state.readyTicks > 0 && readySecs !== state.lastReadySecs) playSound('ready');
    state.lastReadySecs = readySecs;
    if (wasReady && state.readyTicks === 0) {
      state.goUntil = performance.now() + 700;
      playSound('go');
    }
    if (state.readyTicks === 0 && state.ticksLeft > 0 && state.playing) startMusic();
  });

  // Seconds of play so far, from the shared clock (smoothed between the host's 10 ticks a second).
  function gameElapsed() {
    const sinceTick = Math.min(state.tickMs, performance.now() - state.lastStateAt) / 1000;
    return state.gameSeconds - (state.ticksLeft * state.tickMs) / 1000 + sinceTick;
  }
  let musicOn = false;
  function startMusic() {
    if (musicOn) return;
    musicOn = true;
    // Round 1 plays the first track, round 2 the second, and so on, looping back to the first.
    const round = Math.max(1, state.round || 1);
    music.start(gameElapsed, MUSIC_TRACKS[(round - 1) % MUSIC_TRACKS.length]);
  }

  // Live pointer moves from the host (more often than the regular state updates).
  socket.on('cursors', (cursors) => {
    if (state.grid) state.cursors = cursors;
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
    musicOn = false;
    music.fadeOut();
  });

  // ---------- Animation queue ----------
  // Each swap arrives as a list of steps (what was cleared, then the board after candies fall).
  // They play one after another so every player sees the same thing; if several players swap at
  // once the queue speeds up to keep up.

  // Cascade cheers, getting sweeter the longer the chain.
  const CUTE_WORDS = ['Yummy!', 'Sweet!', 'Kawaii!', 'Sugar rush!', 'Sooo sweet!'];

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
        const pal = cl.c === null ? { base: '#ff4f9a' } : CANDY[cl.c];
        for (let i = 0; i < 5; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 1.5 + Math.random() * 3;
          state.particles.push({ x: cl.x + 0.5, y: cl.y + 0.5, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.5, color: i % 2 ? '#fff' : pal.base, kind: i === 0 ? 'heart' : 'sparkle', born: now, life: 500 + Math.random() * 300 });
        }
        if (cl.s === 'h') state.beams.push({ kind: 'row', y: cl.y, start: now });
        if (cl.s === 'v') state.beams.push({ kind: 'col', x: cl.x, start: now });
        if (cl.s === 'w') state.beams.push({ kind: 'ring', x: cl.x, y: cl.y, start: now });
        if (cl.s === 'bomb') state.beams.push({ kind: 'flash', start: now });
      });
      const n = step.cleared.length || 1;
      state.popups.push({ text: `+${step.points}`, x: sx / n + 0.5, y: sy / n + 0.5, color, born: now, big: step.level > 1 });
      if (step.level > 1) {
        const word = CUTE_WORDS[Math.min(CUTE_WORDS.length - 1, step.level - 2)];
        state.popups.push({ text: `${word} x${step.level}`, x: sx / n + 0.5, y: sy / n - 0.2, color: '#e0237e', born: now, small: true });
      }
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

  // The cell under the pointer, plus its exact position in board cells (px, py).
  function cellFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * state.cols;
    const py = ((e.clientY - rect.top) / rect.height) * state.rows;
    const x = Math.floor(px);
    const y = Math.floor(py);
    if (x < 0 || y < 0 || x >= state.cols || y >= state.rows) return null;
    return { x, y, px, py };
  }

  let lastCursorSent = 0;
  let cursorTimer = null;
  function sendCursor(cell) {
    const send = () => {
      lastCursorSent = performance.now();
      cursorTimer = null;
      const c = state.hover;
      if (!c) return socket.emit('input', { type: 'cursor' });
      const msg = { type: 'cursor', x: c.x, y: c.y, sel: !!state.selected && state.selected.x === c.x && state.selected.y === c.y };
      if (c.px !== undefined) {
        msg.px = c.px;
        msg.py = c.py;
      }
      socket.emit('input', msg);
    };
    state.hover = cell;
    if (cursorTimer) return;
    // Up to 20 updates a second, so other players can watch your pointer move.
    const wait = 50 - (performance.now() - lastCursorSent);
    if (wait <= 0) send();
    else cursorTimer = setTimeout(send, wait);
  }

  function canPlay() {
    return state.playing && state.readyTicks <= 0 && state.ticksLeft > 0;
  }

  // Before you pick or swap, your screen skips to the latest board (finishing anyone else's
  // animations instantly), so you're always playing on what's really there, even when four people
  // are swapping at once and the animations have fallen behind.
  function catchUp() {
    if (state.current || state.queue.length) flushQueue();
  }

  // The candy you picked, remembered by id: if someone else's cascade takes it before you finish
  // the swap, the host refuses it rather than swapping something you didn't choose.
  function pick(cell) {
    const candy = state.grid[cell.y] && state.grid[cell.y][cell.x];
    return { ...cell, id: candy && candy.id };
  }

  function trySwap(a, b) {
    if (!canPlay()) return;
    if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) !== 1) return;
    catchUp();
    const ca = state.grid[a.y] && state.grid[a.y][a.x];
    const cb = state.grid[b.y] && state.grid[b.y][b.x];
    if (!ca || !cb) return;
    const aId = a.id !== undefined ? a.id : ca.id;
    socket.emit('input', { type: 'swap', a: { x: a.x, y: a.y, id: aId }, b: { x: b.x, y: b.y, id: cb.id } });
    state.selected = null;
    state.drag = null;
  }

  // Your own pointer: a mouse over the board shows your cute cursor (labelled "You") instead of
  // the system arrow. Touch has no pointer to draw.
  function trackMyPointer(e) {
    if (e.pointerType === 'touch') return;
    const rect = canvas.getBoundingClientRect();
    state.myPointer = {
      x: ((e.clientX - rect.left) / rect.width) * state.cols * CELL,
      y: ((e.clientY - rect.top) / rect.height) * state.rows * CELL,
    };
  }

  canvas.addEventListener('pointerdown', (e) => {
    trackMyPointer(e);
    if (!state.playing) return;
    const cell = cellFromEvent(e);
    if (!cell) return;
    canvas.setPointerCapture(e.pointerId);
    const sel = state.selected;
    if (sel && Math.abs(sel.x - cell.x) + Math.abs(sel.y - cell.y) === 1) {
      trySwap(sel, cell);
      return;
    }
    catchUp();
    const picked = pick(cell);
    state.selected = sel && sel.x === cell.x && sel.y === cell.y ? null : picked;
    state.drag = { cell: picked, px: e.clientX, py: e.clientY };
    sendCursor(cell);
  });

  canvas.addEventListener('pointermove', (e) => {
    trackMyPointer(e);
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
    sendCursor(cell);
  });

  const endDrag = () => { state.drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    state.myPointer = null;
    if (!state.drag) sendCursor(null);
  });

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
      catchUp();
      state.selected = state.selected ? null : pick(here);
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

  // Frosted pink glass with glossy little wells for the candies; drawn once per size and reused.
  let boardLayer = null;
  function drawBoardBackground(w, h) {
    const dpr = canvas.width / w;
    const key = `${w}x${h}@${dpr}`;
    if (!boardLayer || boardLayer.key !== key) {
      const off = document.createElement('canvas');
      off.width = Math.round(w * dpr);
      off.height = Math.round(h * dpr);
      const g = off.getContext('2d');
      g.scale(dpr, dpr);
      const glass = g.createLinearGradient(0, 0, 0, h);
      glass.addColorStop(0, 'rgba(255, 255, 255, 0.78)');
      glass.addColorStop(1, 'rgba(255, 214, 236, 0.72)');
      g.fillStyle = glass;
      roundRect(g, 0, 0, w, h, 16);
      g.fill();
      for (let y = 0; y < state.rows; y++) {
        for (let x = 0; x < state.cols; x++) {
          const px = x * CELL + 3;
          const py = y * CELL + 3;
          const s = CELL - 6;
          const well = g.createLinearGradient(0, py, 0, py + s);
          if ((x + y) % 2) {
            well.addColorStop(0, 'rgba(255, 196, 226, 0.55)');
            well.addColorStop(1, 'rgba(255, 228, 242, 0.75)');
          } else {
            well.addColorStop(0, 'rgba(255, 226, 241, 0.65)');
            well.addColorStop(1, 'rgba(255, 246, 251, 0.9)');
          }
          g.fillStyle = well;
          roundRect(g, px, py, s, s, 16);
          g.fill();
          // Soft inner shadow at the top and a glint along the bottom edge.
          g.strokeStyle = 'rgba(214, 90, 160, 0.18)';
          g.lineWidth = 2;
          roundRect(g, px + 1, py + 1, s - 2, s - 2, 15);
          g.stroke();
        }
      }
      // A glossy sheen across the top of the whole board.
      g.save();
      roundRect(g, 0, 0, w, h, 16);
      g.clip();
      const sheen = g.createLinearGradient(0, 0, 0, h * 0.35);
      sheen.addColorStop(0, 'rgba(255, 255, 255, 0.45)');
      sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
      g.fillStyle = sheen;
      g.fillRect(0, 0, w, h * 0.35);
      g.restore();
      g.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      g.lineWidth = 4;
      roundRect(g, 2, 2, w - 4, h - 4, 14);
      g.stroke();
      boardLayer = { key, canvas: off };
    }
    ctx.drawImage(boardLayer.canvas, 0, 0, w, h);
  }

  function cellBox(x, y, inset, radius) {
    roundRect(ctx, x * CELL + inset, y * CELL + inset, CELL - inset * 2, CELL - inset * 2, radius);
  }

  // Other players' pointers glide towards their latest position, so they move smoothly even
  // though updates only arrive a few times a second.
  const pointerPos = new Map();
  let lastPointerFrame = 0;

  // A cute pointer: a soft, rounded arrow in the player's colour with a white outline and a glossy shine.
  function drawPointer(x, y, color) {
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(1, 1);
      ctx.quadraticCurveTo(0, 0, 0.5, 2.5);
      ctx.lineTo(3.5, 20);
      ctx.quadraticCurveTo(4.5, 23, 6.5, 20.5);
      ctx.lineTo(9.5, 15.5);
      ctx.lineTo(16, 15.5);
      ctx.quadraticCurveTo(19.5, 15, 17, 12.5);
      ctx.closePath();
    };
    ctx.save();
    ctx.translate(x, y);
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(120, 20, 80, 0.35)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    path();
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.shadowColor = 'transparent';
    path();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.save();
    path();
    ctx.clip();
    const g = ctx.createLinearGradient(0, 0, 8, 12);
    g.addColorStop(0, 'rgba(255, 255, 255, 0.75)');
    g.addColorStop(0.6, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 20, 24);
    ctx.restore();
    ctx.restore();
  }

  function nameTag(name, color, x, y) {
    ctx.font = '500 11px "Kiwi Maru", sans-serif';
    const w = ctx.measureText(name).width + 14;
    const tx = Math.max(0, Math.min(state.cols * CELL - w, x));
    const ty = Math.max(0, Math.min(state.rows * CELL - 18, y));
    ctx.save();
    ctx.shadowColor = 'rgba(120, 20, 80, 0.3)';
    ctx.shadowBlur = 5;
    ctx.fillStyle = color;
    roundRect(ctx, tx, ty, w, 18, 9);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    roundRect(ctx, tx, ty, w, 18, 9);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    // Centre on the letters' measured height ('middle' sits low for this font).
    ctx.textBaseline = 'alphabetic';
    const m = ctx.measureText(name);
    ctx.fillText(name, tx + w / 2, ty + 9 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
  }

  function drawCursors(now) {
    const dt = Math.min(100, now - (lastPointerFrame || now));
    lastPointerFrame = now;
    const ease = 1 - Math.exp(-dt / 55);
    const pointers = [];
    // Other players: their colour around the candy they're on (filled glow once they've picked it),
    // and their pointer gliding over the board.
    state.cursors.forEach((cur) => {
      if (cur.id === state.playerId) return;
      const p = playerById(cur.id);
      if (!p || !cur.on) {
        pointerPos.delete(cur.id);
        return;
      }
      ctx.save();
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 3;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = cur.sel ? 14 : 6;
      cellBox(cur.x, cur.y, 3, 16);
      ctx.stroke();
      if (cur.sel) {
        ctx.fillStyle = `${p.color}33`;
        ctx.fill();
      }
      ctx.restore();
      if (cur.px === undefined) {
        // No pointer position (e.g. playing with the keyboard): just a name tag above the candy.
        pointerPos.delete(cur.id);
        nameTag(p.name, p.color, cur.x * CELL + CELL / 2 - 20, cur.y * CELL - 9);
        return;
      }
      const target = { x: cur.px * CELL, y: cur.py * CELL };
      const pos = pointerPos.get(cur.id) || { ...target };
      pos.x += (target.x - pos.x) * ease;
      pos.y += (target.y - pos.y) * ease;
      pointerPos.set(cur.id, pos);
      pointers.push([p, pos]);
    });
    // Pointers are drawn after the candies (see render) so they float on top.
    state.pointerDraws = pointers;
    const me = playerById(state.playerId);
    const myColor = me ? me.color : '#fff';
    if (state.hover && canPlay()) {
      ctx.strokeStyle = 'rgba(224, 35, 126, 0.45)';
      ctx.lineWidth = 2;
      cellBox(state.hover.x, state.hover.y, 3, 16);
      ctx.stroke();
    }
    if (state.selected) {
      const pulse = 0.6 + 0.4 * Math.sin(now / 120);
      ctx.save();
      ctx.strokeStyle = myColor;
      ctx.lineWidth = 3.5;
      ctx.shadowColor = myColor;
      ctx.shadowBlur = 16 * pulse;
      cellBox(state.selected.x, state.selected.y, 3, 16);
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
    roundRect(ctx, 0, 0, state.cols * CELL, state.rows * CELL, 16);
    ctx.clip(); // new candies dropping in appear from the top edge
    state.sprites.forEach((sp, id) => {
      const [nx, ny] = nudge.get(id) || [0, 0];
      const img = candySprite(sp.c, sp.s);
      const size = CELL * SPRITE_PAD * sp.scale;
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
      ctx.shadowColor = '#ff4f9a';
      ctx.shadowBlur = 24;
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
      if (p.kind === 'heart') {
        heartPath(ctx, x, y, 6);
        ctx.fill();
      } else {
        ctx.save();
        ctx.fillStyle = p.color;
        sparkle(ctx, x, y, 2.6);
        ctx.restore();
        if (p.color === '#fff') {
          ctx.fillStyle = 'rgba(255, 140, 200, 0.9)';
          ctx.beginPath();
          ctx.arc(x, y, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
    ctx.globalAlpha = 1;
    // Points float up in the colour of the player who scored them.
    state.popups = state.popups.filter((p) => now - p.born < 900);
    state.popups.forEach((p) => {
      const t = (now - p.born) / 900;
      const size = p.small ? 13 : p.big ? 24 : 19;
      ctx.font = `500 ${size}px "Kiwi Maru", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const x = Math.max(40, Math.min(w - 40, p.x * CELL));
      const y = p.y * CELL - t * CELL * 0.8;
      ctx.globalAlpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#fff';
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
    ctx.fillStyle = 'rgba(255, 214, 236, 0.6)';
    roundRect(ctx, 0, 0, w, h, 16);
    ctx.fill();
    ctx.font = '500 64px "Kiwi Maru", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 14;
    ctx.strokeStyle = '#fff';
    ctx.strokeText(text, w / 2, h / 2);
    ctx.fillStyle = '#ff3d9a';
    ctx.shadowColor = 'rgba(224, 35, 126, 0.5)';
    ctx.shadowBlur = 16;
    ctx.fillText(text, w / 2, h / 2);
    ctx.shadowBlur = 0;
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
    (state.pointerDraws || []).forEach(([p, pos]) => {
      drawPointer(pos.x, pos.y, p.color);
      nameTag(p.name, p.color, pos.x + 14, pos.y + 20);
    });
    if (state.myPointer) {
      const me = playerById(state.playerId);
      const color = me ? me.color : '#d6176f';
      drawPointer(state.myPointer.x, state.myPointer.y, color);
      nameTag('YOU', color, state.myPointer.x + 14, state.myPointer.y + 20);
    }
    drawReady(now);
  }

  // Debug aid: ?debug exposes the client state (and a way to skip to the end of the animations).
  if (new URLSearchParams(location.search).has('debug')) window.__candymatesDebug = { state, flushQueue, music, render };

  buildSlots();
  renderSlots();
  enterRoomFromUrl();
  requestAnimationFrame(animateSlots);
})();
