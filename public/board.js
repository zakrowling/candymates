// Candymates board rules: a shared match-3 board. Pure logic with no networking or drawing, used by
// the host's engine (window.CandymatesBoard) and by Node tests (require).
//
// A cell holds a candy { id, c, s }:
//   c: colour 0-5 (null for a colour bomb)
//   s: special: null, 'h' (striped, clears its row), 'v' (striped, clears its column),
//      'w' (wrapped, blasts the 3x3 around it) or 'bomb' (colour bomb).
// Every candy has a unique id so clients can animate it as it moves.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CandymatesBoard = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const COLS = 16;
  const ROWS = 10;
  const COLOURS = 6;
  const POINTS_PER_CANDY = 10;
  // Bonus for making a special candy.
  const SPECIAL_BONUS = { h: 60, v: 60, w: 80, bomb: 120 };

  const isSpecial = (cell) => !!(cell && cell.s);

  class Board {
    /**
     * @param {object} [opts]
     * @param {() => number} [opts.random] random number source (seedable for tests)
     * @param {number} [opts.cols]
     * @param {number} [opts.rows]
     */
    constructor({ random = Math.random, cols = COLS, rows = ROWS } = {}) {
      this.random = random;
      this.cols = cols;
      this.rows = rows;
      this.nextId = 1;
      this.grid = [];
      this.fill();
    }

    // ---------- Setup ----------

    candy(c, s = null) {
      return { id: this.nextId++, c, s };
    }

    randomColour() {
      return Math.floor(this.random() * COLOURS);
    }

    // A fresh board with no ready-made matches and at least one move available.
    fill() {
      do {
        this.grid = [];
        for (let y = 0; y < this.rows; y++) {
          const row = [];
          for (let x = 0; x < this.cols; x++) {
            let c;
            do c = this.randomColour();
            while ((x >= 2 && row[x - 1].c === c && row[x - 2].c === c)
              || (y >= 2 && this.grid[y - 1][x].c === c && this.grid[y - 2][x].c === c));
            row.push(this.candy(c));
          }
          this.grid.push(row);
        }
      } while (!this.hasMoves());
    }

    // Loads a layout for tests: one string per row, digits 0-5 for colours and 'B' for a colour bomb.
    // (Striped and wrapped candies are set afterwards with board.grid[y][x].s.)
    static fromRows(rows, opts = {}) {
      const b = new Board({ ...opts, cols: rows[0].length, rows: rows.length });
      b.grid = rows.map((r) => [...r].map((ch) => (ch === 'B' ? b.candy(null, 'bomb') : b.candy(Number(ch)))));
      return b;
    }

    inBounds(x, y) {
      return x >= 0 && y >= 0 && x < this.cols && y < this.rows;
    }

    at(x, y) {
      return this.inBounds(x, y) ? this.grid[y][x] : null;
    }

    snapshot() {
      return this.grid.map((row) => row.map((cell) => (cell ? { id: cell.id, c: cell.c, s: cell.s } : null)));
    }

    // ---------- Matching ----------

    // Runs of 3+ same-coloured candies, horizontally and vertically.
    findRuns() {
      const runs = [];
      const scan = (len, other, get, dir) => {
        for (let o = 0; o < other; o++) {
          let start = 0;
          for (let i = 1; i <= len; i++) {
            const a = get(start, o);
            const b = i < len ? get(i, o) : null;
            if (b && a && a.c !== null && b.c === a.c) continue;
            if (i - start >= 3 && a && a.c !== null) {
              const cells = [];
              for (let k = start; k < i; k++) cells.push(dir === 'h' ? [k, o] : [o, k]);
              runs.push({ dir, cells, c: a.c });
            }
            start = i;
          }
        }
      };
      scan(this.cols, this.rows, (i, o) => this.grid[o][i], 'h');
      scan(this.rows, this.cols, (i, o) => this.grid[i][o], 'v');
      return runs;
    }

    // Runs that share a cell (L and T shapes) are joined into one group.
    findGroups() {
      const runs = this.findRuns();
      const groups = [];
      const key = ([x, y]) => `${x},${y}`;
      for (const run of runs) {
        const touching = groups.filter((g) => run.cells.some((c) => g.keys.has(key(c))));
        const merged = { runs: [run], keys: new Set(run.cells.map(key)) };
        touching.forEach((g) => {
          merged.runs.push(...g.runs);
          g.keys.forEach((k) => merged.keys.add(k));
          groups.splice(groups.indexOf(g), 1);
        });
        groups.push(merged);
      }
      return groups.map((g) => ({
        runs: g.runs,
        cells: [...g.keys].map((k) => k.split(',').map(Number)),
        c: g.runs[0].c,
      }));
    }

    // Which special (if any) a matched group makes, and where it goes.
    // prefer: cells the player just swapped, so the special appears where they moved.
    specialFor(group, prefer = []) {
      const longest = group.runs.reduce((a, b) => (b.cells.length > a.cells.length ? b : a));
      const hasH = group.runs.some((r) => r.dir === 'h');
      const hasV = group.runs.some((r) => r.dir === 'v');
      let s = null;
      if (longest.cells.length >= 5) s = 'bomb';
      else if (hasH && hasV) s = 'w';
      else if (longest.cells.length === 4) s = longest.dir === 'h' ? 'v' : 'h';
      if (!s) return null;
      const inGroup = (p) => group.cells.some(([x, y]) => x === p[0] && y === p[1]);
      let at = prefer.find(inGroup);
      if (!at && s === 'w') {
        // Where the row and column cross.
        const hCells = group.runs.filter((r) => r.dir === 'h').flatMap((r) => r.cells);
        at = group.runs.filter((r) => r.dir === 'v').flatMap((r) => r.cells).find(([x, y]) => hCells.some(([hx, hy]) => hx === x && hy === y));
      }
      if (!at) at = longest.cells[Math.floor(longest.cells.length / 2)];
      return { s, at, c: s === 'bomb' ? null : group.c };
    }

    // ---------- Specials going off ----------

    // Adds the cells a special clears to the set (as "x,y" keys), and chains other specials it hits.
    detonate(x, y, cleared, queue) {
      const cell = this.at(x, y);
      if (!cell || cell.spent) return; // already used up by a special swap
      const add = (cx, cy) => {
        if (!this.inBounds(cx, cy)) return;
        const k = `${cx},${cy}`;
        if (cleared.has(k)) return;
        cleared.add(k);
        if (isSpecial(this.grid[cy][cx])) queue.push([cx, cy]);
      };
      if (cell.s === 'h') for (let cx = 0; cx < this.cols; cx++) add(cx, y);
      else if (cell.s === 'v') for (let cy = 0; cy < this.rows; cy++) add(x, cy);
      else if (cell.s === 'w') {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) add(x + dx, y + dy);
      } else if (cell.s === 'bomb') {
        // Caught in a blast: takes out the most common colour.
        const c = this.mostCommonColour();
        this.forEachCell((cx, cy, other) => { if (other.c === c) add(cx, cy); });
      }
    }

    // Expands a set of cleared cells by everything their specials set off, in a chain.
    expand(cleared) {
      const queue = [...cleared].map((k) => k.split(',').map(Number)).filter(([x, y]) => isSpecial(this.at(x, y)));
      const done = new Set();
      while (queue.length) {
        const [x, y] = queue.shift();
        const k = `${x},${y}`;
        if (done.has(k)) continue;
        done.add(k);
        this.detonate(x, y, cleared, queue);
      }
      return done.size; // how many specials went off
    }

    mostCommonColour() {
      const counts = new Array(COLOURS).fill(0);
      this.forEachCell((x, y, cell) => { if (cell.c !== null) counts[cell.c]++; });
      return counts.indexOf(Math.max(...counts));
    }

    forEachCell(fn) {
      for (let y = 0; y < this.rows; y++) {
        for (let x = 0; x < this.cols; x++) if (this.grid[y][x]) fn(x, y, this.grid[y][x]);
      }
    }

    // ---------- Gravity ----------

    // Candies fall into gaps and new ones drop in from the top.
    collapse() {
      for (let x = 0; x < this.cols; x++) {
        let write = this.rows - 1;
        for (let y = this.rows - 1; y >= 0; y--) {
          const cell = this.grid[y][x];
          if (cell) {
            this.grid[y][x] = null;
            this.grid[write][x] = cell;
            write--;
          }
        }
        for (let y = write; y >= 0; y--) this.grid[y][x] = this.candy(this.randomColour());
      }
    }

    // ---------- Moves ----------

    // Would swapping these two cells do anything?
    swapWorks(ax, ay, bx, by) {
      const a = this.at(ax, ay);
      const b = this.at(bx, by);
      if (!a || !b) return false;
      if (a.s === 'bomb' || b.s === 'bomb' || (isSpecial(a) && isSpecial(b))) return true;
      this.grid[ay][ax] = b;
      this.grid[by][bx] = a;
      const works = this.findRuns().some((r) => r.cells.some(([x, y]) => (x === ax && y === ay) || (x === bx && y === by)));
      this.grid[ay][ax] = a;
      this.grid[by][bx] = b;
      return works;
    }

    hasMoves() {
      for (let y = 0; y < this.rows; y++) {
        for (let x = 0; x < this.cols; x++) {
          if (x + 1 < this.cols && this.swapWorks(x, y, x + 1, y)) return true;
          if (y + 1 < this.rows && this.swapWorks(x, y, x, y + 1)) return true;
        }
      }
      return false;
    }

    // Rearranges the candies already on the board until there are no matches and a move exists.
    shuffle() {
      const candies = this.grid.flat();
      for (let attempt = 0; attempt < 200; attempt++) {
        for (let i = candies.length - 1; i > 0; i--) {
          const j = Math.floor(this.random() * (i + 1));
          [candies[i], candies[j]] = [candies[j], candies[i]];
        }
        for (let y = 0; y < this.rows; y++) {
          for (let x = 0; x < this.cols; x++) this.grid[y][x] = candies[y * this.cols + x];
        }
        if (!this.findRuns().length && this.hasMoves()) return;
      }
      this.fill(); // very unlikely: fall back to a brand new board
    }

    /**
     * Swaps two neighbouring candies and resolves everything that follows.
     * @returns {null | {steps: object[], points: number}} null if the swap doesn't do anything
     *   (the board is left as it was). Each step: { cleared: [{id, x, y, c, s}], created: [{id, x, y, s}],
     *   board: snapshot, points, level }. A final { shuffle: true, board } step appears if the board
     *   ran out of moves and was reshuffled.
     */
    swap(ax, ay, bx, by) {
      if (!this.inBounds(ax, ay) || !this.inBounds(bx, by)) return null;
      if (Math.abs(ax - bx) + Math.abs(ay - by) !== 1) return null;
      if (!this.swapWorks(ax, ay, bx, by)) return null;
      const a = this.grid[ay][ax];
      const b = this.grid[by][bx];
      this.grid[ay][ax] = b;
      this.grid[by][bx] = a;

      const steps = [];
      let level = 1;
      // Special swaps (a colour bomb, or two specials) go off straight away.
      const combo = this.comboClear(bx, by, ax, ay);
      if (combo) {
        steps.push(this.clearStep(combo, [], level));
        level++;
      }
      const prefer = [[bx, by], [ax, ay]];
      for (;;) {
        const groups = this.findGroups();
        if (!groups.length) break;
        const cleared = new Set();
        const makes = [];
        groups.forEach((g) => {
          g.cells.forEach(([x, y]) => cleared.add(`${x},${y}`));
          const sp = this.specialFor(g, level === 1 ? prefer : []);
          if (sp) makes.push(sp);
        });
        steps.push(this.clearStep(cleared, makes, level));
        level++;
      }
      if (!this.hasMoves()) {
        this.shuffle();
        steps.push({ shuffle: true, board: this.snapshot(), cleared: [], created: [], points: 0, level });
      }
      return { steps, points: steps.reduce((t, s) => t + s.points, 0) };
    }

    // The cells a special swap clears (after the swap: (x, y) holds what was moved, (ox, oy) the other).
    comboClear(x, y, ox, oy) {
      const a = this.at(x, y);
      const b = this.at(ox, oy);
      const cleared = new Set();
      const add = (cx, cy) => { if (this.inBounds(cx, cy)) cleared.add(`${cx},${cy}`); };
      const bomb = a.s === 'bomb' ? a : b.s === 'bomb' ? b : null;
      if (bomb) {
        const partner = bomb === a ? b : a;
        bomb.spent = true; // used up here, so it doesn't go off again when it's cleared
        if (partner.s === 'bomb') {
          partner.spent = true;
          this.forEachCell((cx, cy) => add(cx, cy)); // two bombs: the whole board
          return cleared;
        }
        add(x, y);
        add(ox, oy);
        // Every candy of the partner's colour goes; if the partner was striped or wrapped, they all
        // turn into that special first and go off too.
        this.forEachCell((cx, cy, cell) => {
          if (cell.c !== partner.c) return;
          if (partner.s && cell !== partner) cell.s = partner.s === 'w' ? 'w' : (this.random() < 0.5 ? 'h' : 'v');
          add(cx, cy);
        });
        return cleared;
      }
      if (!isSpecial(a) || !isSpecial(b)) return null;
      const striped = (s) => s === 'h' || s === 'v';
      if (striped(a.s) && striped(b.s)) {
        for (let i = 0; i < this.cols; i++) add(i, y);
        for (let i = 0; i < this.rows; i++) add(x, i);
      } else if (a.s === 'w' && b.s === 'w') {
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) add(x + dx, y + dy);
      } else {
        // Striped + wrapped: three rows and three columns.
        for (let d = -1; d <= 1; d++) {
          for (let i = 0; i < this.cols; i++) add(i, y + d);
          for (let i = 0; i < this.rows; i++) add(x + d, i);
        }
      }
      // The two swapped specials are used up by the combo itself.
      a.spent = true;
      b.spent = true;
      return cleared;
    }

    // Clears cells (plus anything their specials set off), creates new specials, then gravity.
    clearStep(cleared, makes, level) {
      const created = [];
      const keep = new Set();
      // A new special takes the place of one of the matched candies.
      makes.forEach(({ s, at: [x, y], c }) => {
        const k = `${x},${y}`;
        if (keep.has(k)) return;
        keep.add(k);
      });
      // Specials in the match go off (but not a cell that's about to become a new special).
      keep.forEach((k) => cleared.delete(k));
      const fired = this.expand(cleared);
      // A blast may reach a cell that's becoming a new special; it still becomes the special.
      keep.forEach((k) => cleared.delete(k));
      const removed = [];
      cleared.forEach((k) => {
        const [x, y] = k.split(',').map(Number);
        const cell = this.grid[y][x];
        if (!cell) return;
        removed.push({ id: cell.id, x, y, c: cell.c, s: cell.s });
        this.grid[y][x] = null;
      });
      let bonus = 0;
      makes.forEach(({ s, at: [x, y], c }) => {
        const old = this.grid[y][x];
        if (old) removed.push({ id: old.id, x, y, c: old.c, s: old.s });
        const made = this.candy(c, s);
        this.grid[y][x] = made;
        created.push({ id: made.id, x, y, s });
        bonus += SPECIAL_BONUS[s];
      });
      const points = (removed.length * POINTS_PER_CANDY + fired * 20) * level + bonus;
      this.collapse();
      return { cleared: removed, created, board: this.snapshot(), points, level };
    }
  }

  return { Board, COLS, ROWS, COLOURS, POINTS_PER_CANDY, SPECIAL_BONUS };
});
