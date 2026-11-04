// Authoritative Candymates game engine: up to 4 players race on one shared candy board for the
// highest score in 3 minutes. Runs in the host's browser (window.CandymatesEngine) and in Node for
// tests (require). It knows nothing about networking: the caller supplies broadcast(event, data)
// and send(playerId, event, data).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./board.js'));
  else root.CandymatesEngine = factory(root.CandymatesBoard);
})(typeof self !== 'undefined' ? self : this, ({ Board }) => {
  const TICK_RATE = 10; // timer and cursor updates; swaps are sent the moment they happen
  const MAX_PLAYERS = 4;
  const GAME_SECONDS = 180;
  const READY_SECONDS = 3; // "Ready?" countdown before the board opens
  const CURSOR_RELAY_MS = 50;
  // Turn-based mode: players take turns in player order; a turn is skipped if nobody swaps in time.
  const TURN_SECONDS = 10;
  const TURNS_EACH = 10; // a turn-based game ends once everyone has had this many turns
  const MODES = ['free', 'turns']; // pointer moves are passed on up to 20 times a second
  const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion with 1/0
  // Deep enough that white names and scores on them pass WCAG AA (4.5:1+).
  const PLAYER_COLORS = ['#d6176f', '#0a74b8', '#7c3aed', '#b65300'];
  // Sweet names, 5 letters at most. Kept clear of anything that doubles as slang or an insult
  // (e.g. TART, LEMON, CREAM, FUDGE).
  const PLAYER_NAMES = [
    'GUMMY', 'TAFFY', 'MOCHI', 'JELLY', 'MINTY', 'SUGAR', 'COCOA', 'CANDY', 'BERRY', 'MANGO',
    'PEACH', 'MAPLE', 'HONEY', 'MOCHA', 'WAFER', 'GLAZE', 'SWIRL', 'DONUT', 'BOBA', 'CAKE',
  ];

  const randInt = (n) => Math.floor(Math.random() * n);

  function generateRoomCode(isTaken = () => false) {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < 4; i++) code += ROOM_CODE_ALPHABET[randInt(ROOM_CODE_ALPHABET.length)];
      if (!isTaken(code)) return code;
    }
    throw new Error('Unable to allocate a unique room code');
  }

  function serializePlayer(p) {
    return { id: p.id, number: p.number, name: p.name, color: p.color, score: p.score };
  }

  const validCell = (v, board) => !!v && Number.isInteger(v.x) && Number.isInteger(v.y) && board.inBounds(v.x, v.y);

  class GameRoom {
    /**
     * @param {string} code room code
     * @param {object} hooks broadcast(event, data), send(playerId, event, data), optional
     *   setInterval/clearInterval, random (board randomness) and readySeconds (tests use 0)
     */
    constructor(code, hooks) {
      this.code = code;
      this.broadcast = hooks.broadcast;
      this.send = hooks.send;
      this.setInterval = hooks.setInterval || ((fn, ms) => setInterval(fn, ms));
      this.clearInterval = hooks.clearInterval || ((id) => clearInterval(id));
      this.random = hooks.random || Math.random;
      this.readyTicksAtStart = (hooks.readySeconds ?? READY_SECONDS) * TICK_RATE;
      this.hostId = null;
      this.players = new Map();
      this.started = false;
      this.loop = null;
      this.ticksLeft = 0;
      this.readyTicks = 0;
      this.board = null;
      this.moveId = 0;
      this.now = hooks.now || (() => Date.now());
      this.round = 0;
      this.mode = 'free';
      this.turnId = null; // whose turn it is (turn-based mode)
      this.turnTicks = 0; // games played in this room; players use it to pick that round's music
      this.lastCursorRelay = 0;
    }

    get size() {
      return this.players.size;
    }

    // Adds a player without messaging anyone; call announceJoin() after acknowledging the joiner.
    // preferredName keeps a player's name when they move to a new host after a handover.
    join(id, preferredName) {
      if (this.players.has(id)) return { ok: false, error: 'Already in this room.' };
      if (this.players.size >= MAX_PLAYERS) return { ok: false, error: 'Room is full (max 4 players)!' };
      const taken = new Set([...this.players.values()].map((p) => p.number));
      let number = 1;
      while (taken.has(number)) number++;
      const usedNames = new Set([...this.players.values()].map((p) => p.name));
      const names = PLAYER_NAMES.filter((n) => !usedNames.has(n));
      const name = names.includes(preferredName) ? preferredName : names[randInt(names.length)];
      this.players.set(id, { id, number, name, color: PLAYER_COLORS[number - 1], score: 0, cursor: null, turnsTaken: 0 });
      if (!this.hostId) this.hostId = id;
      return { ok: true, payload: { playerId: id, ...this.lobbyPayload() } };
    }

    announceJoin(id) {
      this.broadcastLobby();
      if (this.started) this.send(id, 'gameStarted', this.gamePayload());
    }

    leave(id) {
      const wasTurn = this.started && this.mode === 'turns' && this.turnId === id;
      const leaver = this.players.get(id);
      if (!this.players.delete(id)) return;
      // Their turn passes to the next player along.
      if (wasTurn && this.players.size) this.nextTurn(null, false, leaver.number);
      if (this.players.size === 0) {
        this.stopLoop();
        this.started = false;
        return;
      }
      if (this.hostId === id) this.hostId = this.players.keys().next().value;
      this.broadcastLobby();
    }

    // Any player in the room can start (or restart) the game.
    // options.mode: 'free' (everyone swaps at once, the default) or 'turns' (take turns).
    start(requesterId, options = {}) {
      if (this.started || !this.players.has(requesterId)) return false;
      this.mode = MODES.includes(options && options.mode) ? options.mode : 'free';
      this.board = new Board({ random: this.random });
      this.ticksLeft = GAME_SECONDS * TICK_RATE;
      this.playTicks = 0; // time played so far (both modes); players' music follows it
      this.readyTicks = this.readyTicksAtStart;
      this.moveId = 0;
      this.round += 1;
      this.started = true;
      this.players.forEach((p) => {
        p.score = 0;
        p.cursor = null;
      });
      this.turnId = null;
      this.players.forEach((p) => { p.turnsTaken = 0; });
      if (this.mode === 'turns') this.nextTurn(requesterId, true);
      this.broadcast('gameStarted', this.gamePayload());
      this.stopLoop();
      this.loop = this.setInterval(() => this.gameTick(), 1000 / TICK_RATE);
      return true;
    }

    /**
     * Player input:
     *   { type: 'cursor', x, y, sel, px, py } where the player is pointing: the cell (x, y), whether
     *     they've picked that candy (sel), and optionally the exact pointer position in board cells
     *     (px, py) so others can watch their pointer move
     *   { type: 'swap', a: {x, y, id}, b: {x, y, id} } swap two neighbouring candies. The ids must
     *     match what's there now, so a swap made on a board that has since changed is refused.
     */
    input(id, msg) {
      const player = this.started && this.players.get(id);
      if (!player || !msg || typeof msg !== 'object') return;
      if (msg.type === 'cursor') {
        if (!validCell(msg, this.board)) {
          player.cursor = null;
        } else {
          const cursor = { x: msg.x, y: msg.y, sel: msg.sel === true };
          const inRange = (v, max) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
          if (inRange(msg.px, this.board.cols) && inRange(msg.py, this.board.rows)) {
            cursor.px = Math.round(msg.px * 100) / 100;
            cursor.py = Math.round(msg.py * 100) / 100;
          }
          player.cursor = cursor;
        }
        // Pass pointer moves on straight away (a few times a second at most), so they look live.
        const now = this.now();
        if (now - this.lastCursorRelay >= CURSOR_RELAY_MS) {
          this.lastCursorRelay = now;
          this.broadcast('cursors', this.serializeCursors());
        }
        return;
      }
      if (msg.type !== 'swap') return;
      const { a, b } = msg;
      if (!validCell(a, this.board) || !validCell(b, this.board)) return;
      const reject = (reason) => this.send(id, 'swapRejected', { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, reason });
      if (this.readyTicks > 0) return reject('ready');
      if (this.mode === 'turns' && id !== this.turnId) return reject('turn');
      if (this.board.at(a.x, a.y).id !== a.id || this.board.at(b.x, b.y).id !== b.id) return reject('stale');
      const result = this.board.swap(a.x, a.y, b.x, b.y);
      if (!result) return reject('nomatch');
      player.score += result.points;
      player.cursor = { x: b.x, y: b.y, sel: false };
      if (this.mode === 'turns') this.nextTurn();
      this.broadcast('swap', {
        move: ++this.moveId,
        by: id,
        a: { x: a.x, y: a.y },
        b: { x: b.x, y: b.y },
        steps: result.steps,
        points: result.points,
        players: this.serializePlayers(),
        turn: this.serializeTurn(),
      });
      if (this.mode === 'turns' && !this.turnId) this.endGame();
    }

    destroy() {
      this.stopLoop();
      this.started = false;
    }

    // ---------- internals ----------

    // Hands the turn to the next player in player order (P1, P2, ... back to P1).
    // first: give it to `startId` (the start of the game). afterNumber: continue after this player
    // number (used when the current player leaves).
    // Players with turns still to take; when nobody has any left, turnId becomes null and the game ends.
    nextTurn(startId = null, first = false, afterNumber = null) {
      const order = [...this.players.values()].filter((p) => (p.turnsTaken || 0) < TURNS_EACH).sort((a, b) => a.number - b.number);
      if (!order.length) {
        this.turnId = null;
        return;
      }
      let next;
      if (first) {
        next = order.find((p) => p.id === startId) || order[0];
      } else {
        const after = afterNumber ?? (this.players.get(this.turnId) || { number: 0 }).number;
        next = order.find((p) => p.number > after) || order[0];
      }
      next.turnsTaken = (next.turnsTaken || 0) + 1;
      this.turnId = next.id;
      this.turnTicks = TURN_SECONDS * TICK_RATE;
    }

    serializeTurn() {
      if (this.mode !== 'turns' || !this.turnId) return null;
      const p = this.players.get(this.turnId);
      return { id: this.turnId, ticksLeft: this.turnTicks, number: p ? p.turnsTaken : 0, of: TURNS_EACH };
    }

    serializeCursors() {
      return [...this.players.values()].map((p) => ({ id: p.id, ...(p.cursor || {}), on: !!p.cursor }));
    }

    serializePlayers() {
      return [...this.players.values()].map(serializePlayer).sort((a, b) => a.number - b.number);
    }

    lobbyPayload() {
      return { roomCode: this.code, hostId: this.hostId, started: this.started, players: this.serializePlayers() };
    }

    gamePayload() {
      return {
        board: { cols: this.board.cols, rows: this.board.rows, grid: this.board.snapshot() },
        move: this.moveId,
        round: this.round,
        tickRate: TICK_RATE,
        gameSeconds: GAME_SECONDS,
        ticksLeft: this.ticksLeft,
        playTicks: this.playTicks,
        readyTicks: this.readyTicks,
        mode: this.mode,
        turn: this.serializeTurn(),
        turnSeconds: TURN_SECONDS,
        ...this.lobbyPayload(),
      };
    }

    broadcastLobby() {
      this.broadcast('lobbyUpdate', this.lobbyPayload());
    }

    stopLoop() {
      if (this.loop !== null) this.clearInterval(this.loop);
      this.loop = null;
    }

    gameTick() {
      if (this.readyTicks > 0) {
        this.readyTicks--;
      } else {
        this.playTicks++;
        if (this.mode !== 'turns') this.ticksLeft--;
        // Out of time for this turn: skip to the next player.
        if (this.mode === 'turns' && this.turnId && --this.turnTicks <= 0) {
          const skipped = this.turnId;
          this.nextTurn();
          this.broadcast('turnSkipped', { id: skipped, turn: this.serializeTurn() });
        }
      }
      this.broadcast('state', {
        ticksLeft: this.ticksLeft,
        playTicks: this.playTicks,
        readyTicks: this.readyTicks,
        cursors: this.serializeCursors(),
        turn: this.serializeTurn(),
      });
      if (this.ticksLeft <= 0 || (this.mode === 'turns' && !this.turnId)) this.endGame();
    }

    endGame() {
      this.stopLoop();
      this.started = false;
      const standings = this.serializePlayers().sort((a, b) => b.score - a.score);
      const top = standings.length ? standings[0].score : 0;
      const winnerIds = standings.filter((p) => p.score === top).map((p) => p.id);
      this.broadcast('gameOver', { standings, winnerIds });
      this.broadcastLobby();
    }
  }

  return {
    GameRoom,
    generateRoomCode,
    TICK_RATE,
    MAX_PLAYERS,
    GAME_SECONDS,
    READY_SECONDS,
    TURN_SECONDS,
    TURNS_EACH,
    PLAYER_COLORS,
  };
});
