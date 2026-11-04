const test = require('node:test');
const assert = require('node:assert/strict');
const { Board, POINTS_PER_CANDY } = require('../public/board.js');

// Small deterministic random generator so refills are repeatable.
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

// A 5x5 board with no matches. Swapping (2,1) up into (2,0) lines up three 0s along the top row.
const BASE = ['00123', '45032', '12345', '23451', '34512'];
const make = (rows, seed = 1) => Board.fromRows(rows, { random: seeded(seed) });
const ids = (board) => board.grid.flat().map((c) => c.id);

function assertSettled(board) {
  assert.ok(board.grid.flat().every(Boolean), 'no holes');
  assert.equal(board.findRuns().length, 0, 'no matches left on the board');
  assert.equal(new Set(ids(board)).size, board.cols * board.rows, 'every candy has its own id');
}

test('a new board is full, has no matches and has a move', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const board = new Board({ random: seeded(seed) });
    assert.equal(board.cols, 16);
    assert.equal(board.rows, 10);
    assertSettled(board);
    assert.ok(board.hasMoves());
  }
});

test('a swap that lines up three clears them, scores and refills from the top', () => {
  const board = make(BASE);
  const below = board.at(0, 1).id;
  const result = board.swap(2, 1, 2, 0);
  assert.ok(result);
  const [first] = result.steps;
  assert.equal(first.level, 1);
  assert.deepEqual(first.cleared.map(({ x, y }) => [x, y]).sort(), [[0, 0], [1, 0], [2, 0]]);
  assert.equal(first.points, 3 * POINTS_PER_CANDY);
  assert.equal(board.at(0, 1).id, below, 'candies below the match stay put');
  assert.ok(!first.cleared.some((c) => c.id === board.at(0, 0).id), 'a new candy dropped into the gap');
  assertSettled(board);
});

test('swaps that do nothing, or aren\'t neighbours, are refused and change nothing', () => {
  const board = make(BASE);
  const before = ids(board);
  assert.equal(board.swap(0, 2, 1, 2), null, 'no match');
  assert.equal(board.swap(2, 1, 2, 3), null, 'not neighbours');
  assert.equal(board.swap(2, 1, 3, 0), null, 'diagonal');
  assert.equal(board.swap(4, 4, 5, 4), null, 'off the board');
  assert.deepEqual(ids(board), before);
});

test('four in a row makes a striped candy where you swapped', () => {
  const board = make(['00103', '45032', '12345', '23451', '34512']);
  const { steps } = board.swap(2, 1, 2, 0);
  assert.equal(steps[0].created.length, 1);
  const made = steps[0].created[0];
  assert.deepEqual([made.x, made.y, made.s], [2, 0, 'v'], 'a horizontal four makes a candy that clears a column');
  assert.equal(steps[0].cleared.length, 4, 'the four candies are used up');
  assert.ok(board.grid.flat().some((c) => c.id === made.id && c.s === 'v'));
});

test('five in a row makes a colour bomb', () => {
  const board = make(['00100', '45032', '12345', '23451', '34512']);
  const { steps } = board.swap(2, 1, 2, 0);
  const made = steps[0].created[0];
  assert.equal(made.s, 'bomb');
  assert.deepEqual([made.x, made.y], [2, 0]);
});

test('an L or T shape makes a wrapped candy', () => {
  const board = make(['00104', '45032', '12045', '23451', '34512']);
  const { steps } = board.swap(3, 0, 2, 0);
  const made = steps[0].created[0];
  assert.equal(made.s, 'w');
  assert.deepEqual([made.x, made.y], [2, 0]);
  assert.equal(steps[0].cleared.length, 5);
});

test('a striped candy in a match clears its whole column', () => {
  const board = make(BASE);
  board.grid[0][0].s = 'v';
  const { steps } = board.swap(2, 1, 2, 0);
  const cleared = steps[0].cleared.map(({ x, y }) => `${x},${y}`);
  for (let y = 0; y < 5; y++) assert.ok(cleared.includes(`0,${y}`), `column 0 row ${y}`);
  assert.equal(cleared.length, 7);
  assertSettled(board);
});

test('a wrapped candy in a match blasts the 3x3 around it', () => {
  const board = make(BASE);
  board.grid[0][1].s = 'w';
  const { steps } = board.swap(2, 1, 2, 0);
  const cleared = new Set(steps[0].cleared.map(({ x, y }) => `${x},${y}`));
  ['0,0', '1,0', '2,0', '0,1', '1,1', '2,1'].forEach((k) => assert.ok(cleared.has(k), k));
});

test('swapping a colour bomb clears every candy of that colour', () => {
  const board = make(['00123', '45B32', '12345', '23451', '34512']);
  const ones = board.grid.flat().filter((c) => c.c === 1).length;
  const { steps } = board.swap(2, 1, 2, 0);
  assert.equal(steps[0].cleared.length, ones + 1, 'all the 1s plus the bomb');
  assert.ok(steps[0].cleared.some((c) => c.s === 'bomb'));
  assertSettled(board);
});

test('two colour bombs together clear the whole board', () => {
  const board = make(['0B123', '4B032', '12345', '23451', '34512']);
  const { steps } = board.swap(1, 0, 1, 1);
  assert.equal(steps[0].cleared.length, 25);
  assertSettled(board);
});

test('two striped candies together clear a row and a column', () => {
  const board = make(BASE);
  board.grid[2][2].s = 'h';
  board.grid[3][2].s = 'v';
  const { steps } = board.swap(2, 3, 2, 2);
  const cleared = new Set(steps[0].cleared.map(({ x, y }) => `${x},${y}`));
  for (let i = 0; i < 5; i++) {
    assert.ok(cleared.has(`${i},2`), `row at ${i}`);
    assert.ok(cleared.has(`2,${i}`), `column at ${i}`);
  }
});

test('cascades score more at each level', () => {
  // Play lots of random moves; whenever a swap cascades, later steps are worth more per candy.
  const board = new Board({ random: seeded(42) });
  let cascades = 0;
  for (let move = 0; move < 200; move++) {
    let result = null;
    for (let y = 0; y < board.rows && !result; y++) {
      for (let x = 0; x < board.cols && !result; x++) {
        result = (x + 1 < board.cols && board.swap(x, y, x + 1, y)) || (y + 1 < board.rows && board.swap(x, y, x, y + 1)) || null;
      }
    }
    assert.ok(result, 'there is always a move');
    result.steps.filter((s) => !s.shuffle).forEach((s, i) => {
      assert.equal(s.level, i + 1);
      assert.ok(s.points >= s.cleared.length * POINTS_PER_CANDY * s.level);
    });
    if (result.steps.length > 1) cascades++;
    assert.equal(result.points, result.steps.reduce((t, s) => t + s.points, 0));
    assertSettled(board);
  }
  assert.ok(cascades > 0, 'some moves cascaded');
});

test('a board with no moves left is reshuffled into one that has some', () => {
  const board = new Board({ random: seeded(3) });
  board.shuffle();
  assertSettled(board);
  assert.ok(board.hasMoves());
});
