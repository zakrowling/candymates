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
  const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion with 1/0
  const PLAYER_COLORS = ['#ff3d9a', '#22b8f0', '#9b5cff', '#ff8a1f'];
  // Sweet names, 5 letters at most.
  const PLAYER_NAMES = [
    'GUMMY', 'TAFFY', 'FUDGE', 'JELLY', 'MINTY', 'SUGAR', 'COCOA', 'CANDY', 'BERRY', 'LEMON',
    'PEACH', 'MAPLE', 'HONEY', 'MOCHA', 'CREAM', 'GLAZE', 'SWIRL', 'DONUT', 'TART', 'CAKE',
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
      this.players.set(id, { id, number, name, color: PLAYER_COLORS[number - 1], score: 0, cursor: null });
      if (!this.hostId) this.hostId = id;
      return { ok: true, payload: { playerId: id, ...this.lobbyPayload() } };
    }

    announceJoin(id) {
      this.broadcastLobby();
      if (this.started) this.send(id, 'gameStarted', this.gamePayload());
    }

    leave(id) {
      if (!this.players.delete(id)) return;
      if (this.players.size === 0) {
        this.stopLoop();
        this.started = false;
        return;
      }
      if (this.hostId === id) this.hostId = this.players.keys().next().value;
      this.broadcastLobby();
    }

    // Any player in the room can start (or restart) the game.
    start(requesterId) {
      if (this.started || !this.players.has(requesterId)) return false;
      this.board = new Board({ random: this.random });
      this.ticksLeft = GAME_SECONDS * TICK_RATE;
      this.readyTicks = this.readyTicksAtStart;
      this.moveId = 0;
      this.started = true;
      this.players.forEach((p) => {
        p.score = 0;
        p.cursor = null;
      });
      this.broadcast('gameStarted', this.gamePayload());
      this.stopLoop();
      this.loop = this.setInterval(() => this.gameTick(), 1000 / TICK_RATE);
      return true;
    }

    /**
     * Player input:
     *   { type: 'cursor', x, y, sel } where the player is pointing (sel: they've picked that candy)
     *   { type: 'swap', a: {x, y, id}, b: {x, y, id} } swap two neighbouring candies. The ids must
     *     match what's there now, so a swap made on a board that has since changed is refused.
     */
    input(id, msg) {
      const player = this.started && this.players.get(id);
      if (!player || !msg || typeof msg !== 'object') return;
      if (msg.type === 'cursor') {
        player.cursor = validCell(msg, this.board) ? { x: msg.x, y: msg.y, sel: msg.sel === true } : null;
        return;
      }
      if (msg.type !== 'swap') return;
      const { a, b } = msg;
      if (!validCell(a, this.board) || !validCell(b, this.board)) return;
      const reject = (reason) => this.send(id, 'swapRejected', { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, reason });
      if (this.readyTicks > 0) return reject('ready');
      if (this.board.at(a.x, a.y).id !== a.id || this.board.at(b.x, b.y).id !== b.id) return reject('stale');
      const result = this.board.swap(a.x, a.y, b.x, b.y);
      if (!result) return reject('nomatch');
      player.score += result.points;
      player.cursor = { x: b.x, y: b.y, sel: false };
      this.broadcast('swap', {
        move: ++this.moveId,
        by: id,
        a: { x: a.x, y: a.y },
        b: { x: b.x, y: b.y },
        steps: result.steps,
        points: result.points,
        players: this.serializePlayers(),
      });
    }

    destroy() {
      this.stopLoop();
      this.started = false;
    }

    // ---------- internals ----------

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
        tickRate: TICK_RATE,
        gameSeconds: GAME_SECONDS,
        ticksLeft: this.ticksLeft,
        readyTicks: this.readyTicks,
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
      if (this.readyTicks > 0) this.readyTicks--;
      else this.ticksLeft--;
      this.broadcast('state', {
        ticksLeft: this.ticksLeft,
        readyTicks: this.readyTicks,
        cursors: [...this.players.values()].map((p) => ({ id: p.id, ...(p.cursor || {}), on: !!p.cursor })),
      });
      if (this.ticksLeft <= 0) this.endGame();
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
    PLAYER_COLORS,
  };
});
