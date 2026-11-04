const test = require('node:test');
const assert = require('node:assert/strict');
const { GameRoom, generateRoomCode, TICK_RATE, GAME_SECONDS, READY_SECONDS, TURN_SECONDS, TURNS_EACH } = require('../public/engine.js');

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
  let clock = 0;
  const room = new GameRoom('TEST', {
    broadcast: (ev, data) => sent.push({ to: '*', ev, data }),
    send: (to, ev, data) => sent.push({ to, ev, data }),
    setInterval: (fn) => { tickFn = fn; return 1; },
    clearInterval: () => { tickFn = null; },
    random: seeded(9),
    readySeconds,
    now: () => clock,
  });
  const advance = (ms) => { clock += ms; };
  const run = (n = 1) => { for (let i = 0; i < n && tickFn; i++) tickFn(); };
  const last = (ev, to) => [...sent].reverse().find((m) => m.ev === ev && (!to || m.to === to));
  return { room, sent, run, last, advance, isRunning: () => tickFn !== null };
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

test('pointer movements are passed on straight away, but not too often', () => {
  const { room, sent, advance } = startedRoom(2);
  const relays = () => sent.filter((m) => m.ev === 'cursors');
  advance(1000);
  room.input('p1', { type: 'cursor', x: 2, y: 3, px: 2.456, py: 3.5 });
  assert.equal(relays().length, 1);
  assert.deepEqual(relays()[0].data.find((c) => c.id === 'p1'), { id: 'p1', x: 2, y: 3, sel: false, px: 2.46, py: 3.5, on: true });
  // A burst of moves within 50ms only goes out once; the latest position is sent next time.
  advance(10);
  room.input('p1', { type: 'cursor', x: 2, y: 3, px: 2.8, py: 3.6 });
  assert.equal(relays().length, 1);
  advance(60);
  room.input('p1', { type: 'cursor', x: 3, y: 3, px: 3.1, py: 3.6 });
  assert.equal(relays().length, 2);
  // Positions off the board are dropped (the cell still counts).
  advance(60);
  room.input('p2', { type: 'cursor', x: 1, y: 1, px: 99, py: -4 });
  const p2 = relays().at(-1).data.find((c) => c.id === 'p2');
  assert.equal(p2.px, undefined);
  assert.equal(p2.x, 1);
});

test('each game in a room is numbered, so everyone plays the same music for that round', () => {
  const { room, run, last } = startedRoom(1);
  assert.equal(last('gameStarted').data.round, 1);
  run(GAME_SECONDS * TICK_RATE);
  room.start('p1');
  assert.equal(last('gameStarted').data.round, 2);
  room.join('late');
  room.announceJoin('late');
  assert.equal(last('gameStarted', 'late').data.round, 2, 'a mid-game joiner gets the same round');
});

test('joining mid-game drops straight in without interrupting anyone', () => {
  const { room, run, last, sent, isRunning } = startedRoom(2);
  room.input('p1', findGoodSwap(room.board));
  run(50);
  const before = { board: room.board.snapshot(), ticksLeft: room.ticksLeft, p1: room.players.get('p1').score, round: room.round };
  const starts = sent.filter((m) => m.ev === 'gameStarted').length;
  assert.ok(room.join('late').ok);
  room.announceJoin('late');
  // Only the newcomer is sent the game; nobody else's game restarts or changes.
  const newStarts = sent.filter((m) => m.ev === 'gameStarted').slice(starts);
  assert.deepEqual(newStarts.map((m) => m.to), ['late']);
  assert.ok(isRunning());
  assert.deepEqual(room.board.snapshot(), before.board);
  assert.equal(room.ticksLeft, before.ticksLeft);
  assert.equal(room.players.get('p1').score, before.p1);
  assert.equal(room.round, before.round);
  assert.equal(last('gameStarted', 'late').data.readyTicks, 0, 'no Ready? countdown for them');
  assert.equal(last('lobbyUpdate').data.players.length, 3, 'everyone hears about the new player');
  // And they can play right away.
  room.input('late', findGoodSwap(room.board));
  assert.equal(last('swap').data.by, 'late');
  assert.ok(room.players.get('late').score > 0);
});

function turnRoom(players = 3) {
  const ctx = makeRoom();
  for (let i = 1; i <= players; i++) ctx.room.join(`p${i}`);
  ctx.room.start('p1', { mode: 'turns' });
  return ctx;
}

test('free for all is the default; turn-based is chosen at the start', () => {
  const free = startedRoom(2);
  assert.equal(free.last('gameStarted').data.mode, 'free');
  assert.equal(free.last('gameStarted').data.turn, null);
  const { last } = turnRoom(2);
  const payload = last('gameStarted').data;
  assert.equal(payload.mode, 'turns');
  assert.deepEqual(payload.turn, { id: 'p1', ticksLeft: TURN_SECONDS * TICK_RATE, number: 1, of: TURNS_EACH });
  const odd = makeRoom();
  odd.room.join('p1');
  odd.room.start('p1', { mode: 'chaos' });
  assert.equal(odd.room.mode, 'free', 'unknown modes fall back to free for all');
});

test('turn-based: only the player whose turn it is can swap, then it passes along in order', () => {
  const { room, last } = turnRoom(3);
  room.input('p2', findGoodSwap(room.board));
  assert.equal(last('swapRejected', 'p2').data.reason, 'turn');
  assert.equal(room.players.get('p2').score, 0);
  room.input('p1', findGoodSwap(room.board));
  assert.equal(last('swap').data.turn.id, 'p2');
  room.input('p2', findGoodSwap(room.board));
  room.input('p3', findGoodSwap(room.board));
  assert.equal(room.turnId, 'p1', 'back to the first player');
  assert.equal(room.players.get('p1').turnsTaken, 2);
});

test('turn-based: a turn is skipped if nobody swaps in time, and the clock does not run', () => {
  const { room, run, last } = turnRoom(2);
  const clock = room.ticksLeft;
  run(TURN_SECONDS * TICK_RATE - 1);
  assert.equal(room.turnId, 'p1');
  run(1);
  assert.equal(room.turnId, 'p2');
  assert.equal(last('turnSkipped').data.id, 'p1');
  assert.equal(room.ticksLeft, clock, 'no 3-minute clock in turn-based games');
});

test('turn-based: the game ends once everyone has had their turns, highest score wins', () => {
  const { room, last, isRunning } = turnRoom(2);
  for (let t = 0; t < TURNS_EACH * 2; t++) {
    assert.ok(room.started, `still going before turn ${t + 1}`);
    room.input(room.turnId, findGoodSwap(room.board));
  }
  assert.equal(room.started, false);
  assert.equal(isRunning(), false);
  assert.equal(room.players.get('p1').turnsTaken, TURNS_EACH);
  assert.equal(room.players.get('p2').turnsTaken, TURNS_EACH);
  const { standings, winnerIds } = last('gameOver').data;
  assert.ok(winnerIds.includes(standings[0].id));
});

test('turn-based: if the player whose turn it is leaves, the next player goes', () => {
  const { room } = turnRoom(3);
  room.input('p1', findGoodSwap(room.board));
  assert.equal(room.turnId, 'p2');
  room.leave('p2');
  assert.equal(room.turnId, 'p3');
});
