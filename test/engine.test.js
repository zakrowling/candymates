const test = require('node:test');
const assert = require('node:assert/strict');
const { GameRoom, generateRoomCode, TICK_RATE, GAME_SECONDS, READY_SECONDS } = require('../public/engine.js');

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Builds a room with a manual clock and records every message it sends.
function makeRoom({ readySeconds = 0 } = {}) {
  const sent = [];
  let tickFn = null;
  const room = new GameRoom('TEST', {
    broadcast: (ev, data) => sent.push({ to: '*', ev, data }),
    send: (to, ev, data) => sent.push({ to, ev, data }),
    setInterval: (fn) => { tickFn = fn; return 1; },
    clearInterval: () => { tickFn = null; },
    random: seeded(9),
    readySeconds,
  });
  const run = (n = 1) => { for (let i = 0; i < n && tickFn; i++) tickFn(); };
  const last = (ev, to) => [...sent].reverse().find((m) => m.ev === ev && (!to || m.to === to));
  return { room, sent, run, last, isRunning: () => tickFn !== null };
}

function startedRoom(players = 2, opts) {
  const ctx = makeRoom(opts);
  for (let i = 1; i <= players; i++) ctx.room.join(`p${i}`);
  ctx.room.start('p1');
  return ctx;
}

// The first swap on the board that makes a match.
function findGoodSwap(board) {
  for (let y = 0; y < board.rows; y++) {
    for (let x = 0; x < board.cols; x++) {
      for (const [bx, by] of [[x + 1, y], [x, y + 1]]) {
        if (board.inBounds(bx, by) && board.swapWorks(x, y, bx, by)) {
          return { type: 'swap', a: { x, y, id: board.at(x, y).id }, b: { x: bx, y: by, id: board.at(bx, by).id } };
        }
      }
    }
  }
  throw new Error('no move');
}

function findBadSwap(board) {
  for (let y = 0; y < board.rows; y++) {
    for (let x = 0; x + 1 < board.cols; x++) {
      if (!board.swapWorks(x, y, x + 1, y)) {
        return { type: 'swap', a: { x, y, id: board.at(x, y).id }, b: { x: x + 1, y, id: board.at(x + 1, y).id } };
      }
    }
  }
  throw new Error('every swap works');
}

test('room codes are 4 letters without I or O', () => {
  for (let i = 0; i < 50; i++) assert.match(generateRoomCode(), /^[A-HJ-NP-Z]{4}$/);
});

test('up to 4 players join with their own number, name and colour', () => {
  const { room } = makeRoom();
  [1, 2, 3, 4].forEach((i) => assert.ok(room.join(`p${i}`).ok));
  const players = [...room.players.values()];
  assert.deepEqual(players.map((p) => p.number), [1, 2, 3, 4]);
  assert.equal(new Set(players.map((p) => p.name)).size, 4);
  assert.equal(new Set(players.map((p) => p.color)).size, 4);
  assert.match(room.join('p5').error, /full/);
  room.leave('p2');
  assert.equal(room.join('p6').payload.players.find((p) => p.id === 'p6').number, 2, 'a free number is reused');
});

test('starting deals one shared board and a 3 minute clock after a Ready? countdown', () => {
  const { room, last, run } = startedRoom(2, { readySeconds: READY_SECONDS });
  const payload = last('gameStarted').data;
  assert.equal(payload.board.grid.length, 10);
  assert.equal(payload.board.grid[0].length, 16);
  assert.equal(payload.ticksLeft, GAME_SECONDS * TICK_RATE);
  assert.equal(payload.readyTicks, READY_SECONDS * TICK_RATE);
  // Swaps are refused until the countdown is over, and the clock waits too.
  room.input('p1', findGoodSwap(room.board));
  assert.equal(last('swapRejected', 'p1').data.reason, 'ready');
  run(READY_SECONDS * TICK_RATE);
  assert.equal(room.ticksLeft, GAME_SECONDS * TICK_RATE);
  run(1);
  assert.equal(room.ticksLeft, GAME_SECONDS * TICK_RATE - 1);
});

test('a good swap scores for whoever made it and is sent to everyone', () => {
  const { room, last } = startedRoom(2);
  const swap = findGoodSwap(room.board);
  room.input('p2', swap);
  const msg = last('swap').data;
  assert.equal(msg.by, 'p2');
  assert.ok(msg.points > 0);
  assert.equal(room.players.get('p2').score, msg.points);
  assert.equal(room.players.get('p1').score, 0);
  assert.equal(msg.players.find((p) => p.id === 'p2').score, msg.points);
  assert.ok(msg.steps.length >= 1);
  assert.deepEqual(msg.steps.at(-1).board, room.board.snapshot(), 'the last step is the board as it is now');
  assert.equal(msg.move, 1);
});

test('a swap that makes no match is refused for that player only', () => {
  const { room, last, sent } = startedRoom(2);
  const before = room.board.snapshot();
  room.input('p1', findBadSwap(room.board));
  assert.equal(last('swapRejected', 'p1').data.reason, 'nomatch');
  assert.ok(!sent.some((m) => m.ev === 'swap'));
  assert.deepEqual(room.board.snapshot(), before);
  assert.equal(room.players.get('p1').score, 0);
});

test('a swap made on a board that has since changed is refused', () => {
  const { room, last } = startedRoom(2);
  const first = findGoodSwap(room.board);
  room.input('p1', first);
  // p2 tries the same swap a moment later: those candies are gone now.
  room.input('p2', first);
  assert.equal(last('swapRejected', 'p2').data.reason, 'stale');
});

test('nonsense input is ignored', () => {
  const { room, sent } = startedRoom(1);
  const count = sent.length;
  [null, 'swap', 42, { type: 'swap' }, { type: 'swap', a: { x: -1, y: 0 }, b: { x: 0, y: 0 } },
    { type: 'swap', a: { x: 0.5, y: 0 }, b: { x: 1, y: 0 } }, { type: 'teleport' }].forEach((msg) => room.input('p1', msg));
  room.input('stranger', findGoodSwap(room.board));
  assert.equal(sent.length, count);
});

test('everyone sees where everyone else is pointing', () => {
  const { room, run, last } = startedRoom(2);
  room.input('p1', { type: 'cursor', x: 3, y: 4, sel: true });
  room.input('p2', { type: 'cursor', x: 99, y: 4 });
  run(1);
  const { cursors } = last('state').data;
  assert.deepEqual(cursors.find((c) => c.id === 'p1'), { id: 'p1', x: 3, y: 4, sel: true, on: true });
  assert.deepEqual(cursors.find((c) => c.id === 'p2'), { id: 'p2', on: false });
});

test('the game ends when time is up, with the highest score winning', () => {
  const { room, run, last, isRunning } = startedRoom(3);
  room.input('p3', findGoodSwap(room.board));
  run(GAME_SECONDS * TICK_RATE);
  assert.equal(isRunning(), false);
  assert.equal(room.started, false);
  const { standings, winnerIds } = last('gameOver').data;
  assert.equal(standings[0].id, 'p3');
  assert.deepEqual(winnerIds, ['p3']);
  assert.ok(standings[0].score >= standings[1].score);
});

test('a tied top score is a draw', () => {
  const { run, last } = startedRoom(2);
  run(GAME_SECONDS * TICK_RATE);
  assert.deepEqual(last('gameOver').data.winnerIds.sort(), ['p1', 'p2']);
});

test('someone joining mid-game gets the board as it is now', () => {
  const { room, last } = startedRoom(1);
  room.input('p1', findGoodSwap(room.board));
  room.join('late');
  room.announceJoin('late');
  const payload = last('gameStarted', 'late').data;
  assert.deepEqual(payload.board.grid, room.board.snapshot());
  assert.equal(payload.move, 1);
});

test('playing again starts a fresh board and resets scores', () => {
  const { room, run } = startedRoom(2);
  room.input('p1', findGoodSwap(room.board));
  run(GAME_SECONDS * TICK_RATE);
  const oldBoard = room.board;
  assert.ok(room.start('p2'));
  assert.notEqual(room.board, oldBoard);
  assert.equal(room.players.get('p1').score, 0);
});
