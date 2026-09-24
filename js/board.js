// Board rendering & interaction. Pure view — delegates game rules to controller.

const GLYPHS = {
  w: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
  b: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' },
};

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

export class Board {
  /**
   * @param {HTMLElement} el container for the 8x8 grid
   * @param {{onSquareClick:Function, onDragMove:Function}} handlers
   */
  constructor(el, handlers) {
    this.el = el;
    this.handlers = handlers;
    this.orientation = 'w'; // 'w' => white at bottom
    this.squares = new Map(); // "e4" -> div
    this._build();
    this._initDrag();
  }

  _build() {
    this.el.innerHTML = '';
    this.squares.clear();
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const fileIdx = this.orientation === 'w' ? col : 7 - col;
        const rankIdx = this.orientation === 'w' ? 7 - row : row;
        const name = FILES[fileIdx] + (rankIdx + 1);
        const sq = document.createElement('div');
        sq.className = 'square ' + ((fileIdx + rankIdx) % 2 === 0 ? 'light' : 'dark');
        sq.dataset.square = name;

        // coordinates on edge squares
        if (col === 0) {
          const r = document.createElement('span');
          r.className = 'coord rank';
          r.textContent = rankIdx + 1;
          sq.appendChild(r);
        }
        if (row === 7) {
          const f = document.createElement('span');
          f.className = 'coord file';
          f.textContent = FILES[fileIdx];
          sq.appendChild(f);
        }

        sq.addEventListener('click', () => this.handlers.onSquareClick(name));
        this.el.appendChild(sq);
        this.squares.set(name, sq);
      }
    }
  }

  setOrientation(color) {
    if (this.orientation === color) return;
    this.orientation = color;
    this._build();
  }

  flip() {
    this.setOrientation(this.orientation === 'w' ? 'b' : 'w');
  }

  /**
   * Render position from chess.js board array.
   * @param {Array} boardArr chess.board()
   */
  render(boardArr) {
    // clear pieces & transient markers
    for (const [, sq] of this.squares) {
      const p = sq.querySelector('.piece');
      if (p) p.remove();
      sq.classList.remove('selected', 'last-move', 'check', 'drag-over');
      const dot = sq.querySelector('.move-dot, .capture-ring');
      if (dot) dot.remove();
    }
    for (const row of boardArr) {
      for (const cell of row) {
        if (!cell) continue;
        const sq = this.squares.get(cell.square);
        const piece = document.createElement('span');
        piece.className = 'piece ' + (cell.color === 'w' ? 'white' : 'black');
        piece.textContent = GLYPHS[cell.color][cell.type];
        piece.dataset.square = cell.square;
        sq.appendChild(piece);
      }
    }
  }

  setSelected(square) {
    this.clearSelection();
    const sq = this.squares.get(square);
    if (sq) sq.classList.add('selected');
  }

  clearSelection() {
    for (const [, sq] of this.squares) sq.classList.remove('selected');
  }

  /** Show legal-move markers. moves: verbose chess.js move objects from a square. */
  showMoves(moves) {
    for (const m of moves) {
      const sq = this.squares.get(m.to);
      if (!sq) continue;
      const marker = document.createElement('div');
      if (m.captured || m.flags.includes('e')) {
        marker.className = 'capture-ring';
      } else {
        marker.className = 'move-dot';
      }
      sq.appendChild(marker);
    }
  }

  clearMoves() {
    for (const [, sq] of this.squares) {
      sq.querySelectorAll('.move-dot, .capture-ring').forEach((n) => n.remove());
    }
  }

  markLastMove(from, to) {
    this.squares.get(from)?.classList.add('last-move');
    this.squares.get(to)?.classList.add('last-move');
  }

  markCheck(square) {
    this.squares.get(square)?.classList.add('check');
  }

  // ----- drag & drop -----
  _initDrag() {
    let dragging = null;
    let startSquare = null;

    this.el.addEventListener('pointerdown', (e) => {
      const pieceEl = e.target.closest('.piece');
      if (!pieceEl) return;
      const sq = pieceEl.dataset.square;
      if (!this.handlers.canDrag(sq)) return;
      dragging = pieceEl;
      startSquare = sq;
      pieceEl.classList.add('dragging');
      pieceEl.setPointerCapture(e.pointerId);
      this.handlers.onDragMove(startSquare, startSquare);
      e.preventDefault();
    });

    this.el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.square');
      for (const [, sq] of this.squares) sq.classList.remove('drag-over');
      if (over && over.dataset.square !== startSquare) over.classList.add('drag-over');
    });

    const finish = (e) => {
      if (!dragging) return;
      dragging.classList.remove('dragging');
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.square');
      for (const [, sq] of this.squares) sq.classList.remove('drag-over');
      const target = over?.dataset.square;
      dragging = null;
      if (target && target !== startSquare) {
        this.handlers.onDropMove(startSquare, target);
      }
      startSquare = null;
    };
    this.el.addEventListener('pointerup', finish);
    this.el.addEventListener('pointercancel', finish);
  }
}

export { GLYPHS };
