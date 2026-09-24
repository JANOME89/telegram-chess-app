// Animated board: static square grid (highlights + clicks) plus an absolute
// piece layer whose elements slide via CSS transform transitions.
import { pieceSVG } from './pieces.js';

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

export class Board {
  constructor(squaresEl, piecesEl, handlers) {
    this.squaresEl = squaresEl;
    this.piecesEl = piecesEl;
    this.handlers = handlers; // {onSquareClick, canDrag, onDropMove}
    this.orientation = 'w';
    this.pieces = new Map(); // id -> {el, square, color, type}
    this.nextId = 1;
    this._buildSquares();
  }

  // ---------- squares grid ----------
  _buildSquares() {
    this.squaresEl.innerHTML = '';
    this.squareEls = new Map();
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const fileIdx = this.orientation === 'w' ? col : 7 - col;
        const rankIdx = this.orientation === 'w' ? 7 - row : row;
        const name = FILES[fileIdx] + (rankIdx + 1);
        const sq = document.createElement('div');
        sq.className = 'square ' + ((fileIdx + rankIdx) % 2 === 0 ? 'light' : 'dark');
        sq.dataset.square = name;
        sq.addEventListener('click', () => this.handlers.onSquareClick(name));
        this.squaresEl.appendChild(sq);
        this.squareEls.set(name, sq);
      }
    }
  }

  setOrientation(color) {
    if (this.orientation === color) return;
    this.orientation = color;
    this._buildSquares();
  }
  flip() { this.setOrientation(this.orientation === 'w' ? 'b' : 'w'); }

  // ---------- geometry ----------
  _rc(square) {
    const fileIdx = FILES.indexOf(square[0]);
    const rank = parseInt(square[1], 10);
    const col = this.orientation === 'w' ? fileIdx : 7 - fileIdx;
    const row = this.orientation === 'w' ? 8 - rank : rank - 1;
    return { row, col };
  }
  squareFromPoint(clientX, clientY) {
    const rect = this.squaresEl.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    const fx = (clientX - rect.left) / rect.width;
    const fy = (clientY - rect.top) / rect.height;
    let col = Math.floor(fx * 8);
    let row = Math.floor(fy * 8);
    col = Math.min(7, Math.max(0, col));
    row = Math.min(7, Math.max(0, row));
    const fileIdx = this.orientation === 'w' ? col : 7 - col;
    const rank = this.orientation === 'w' ? 8 - row : row + 1;
    return FILES[fileIdx] + rank;
  }

  _place(el, square, animate) {
    const { row, col } = this._rc(square);
    if (!animate) {
      el.style.transition = 'none';
      el.style.transform = `translate(${col * 100}%, ${row * 100}%)`;
      void el.offsetWidth;
      el.style.transition = '';
    } else {
      el.style.transform = `translate(${col * 100}%, ${row * 100}%)`;
    }
  }

  // ---------- piece registry ----------
  fullRender(boardArr) {
    this.piecesEl.innerHTML = '';
    this.pieces.clear();
    for (const row of boardArr) {
      for (const cell of row) {
        if (!cell) continue;
        this._addPiece(cell.color, cell.type, cell.square, false);
      }
    }
  }

  _addPiece(color, type, square, animate) {
    const el = document.createElement('div');
    el.className = 'piece ' + (color === 'w' ? 'white' : 'black');
    el.appendChild(pieceSVG(type));
    this.piecesEl.appendChild(el);
    const rec = { el, square, color, type, id: this.nextId++ };
    el.dataset.id = rec.id;
    this._place(el, square, animate);
    this.pieces.set(rec.id, rec);
    this._bindDrag(el, rec);
    return rec;
  }

  pieceAt(square) {
    for (const rec of this.pieces.values()) if (rec.square === square) return rec;
    return null;
  }

  /** Apply a verbose chess.js move with animation. */
  applyMove(m) {
    const mover = this.pieceAt(m.from);
    // capture (incl. en passant target square)
    if (m.captured) {
      const capSquare = m.flags.includes('e')
        ? m.to[0] + m.from[1]
        : m.to;
      const victim = this.pieceAt(capSquare);
      if (victim) this._remove(victim);
    }
    if (mover) {
      mover.square = m.to;
      this._place(mover.el, m.to, true);
      if (m.promotion) {
        const rec = mover;
        setTimeout(() => {
          rec.type = m.promotion;
          rec.el.innerHTML = '';
          rec.el.appendChild(pieceSVG(m.promotion));
        }, 170);
      }
    }
    // castling rook
    if (m.flags.includes('k') || m.flags.includes('q')) {
      const rank = m.from[1];
      const [rookFrom, rookTo] = m.flags.includes('k')
        ? ['h' + rank, 'f' + rank]
        : ['a' + rank, 'd' + rank];
      const rook = this.pieceAt(rookFrom);
      if (rook) {
        rook.square = rookTo;
        this._place(rook.el, rookTo, true);
      }
    }
  }

  _remove(rec) {
    this.pieces.delete(rec.id);
    rec.el.classList.add('captured');
    setTimeout(() => rec.el.remove(), 220);
  }

  // ---------- highlights ----------
  clearHighlights() {
    for (const [, sq] of this.squareEls) {
      sq.classList.remove('selected', 'last-move', 'check', 'drag-over');
      sq.querySelectorAll('.dot, .ring').forEach((n) => n.remove());
    }
  }
  setSelected(square) { this.squareEls.get(square)?.classList.add('selected'); }
  showMoves(moves) {
    for (const m of moves) {
      const sq = this.squareEls.get(m.to);
      if (!sq) continue;
      const mark = document.createElement('div');
      mark.className = m.captured || m.flags.includes('e') ? 'ring' : 'dot';
      sq.appendChild(mark);
    }
  }
  markLastMove(from, to) {
    this.squareEls.get(from)?.classList.add('last-move');
    this.squareEls.get(to)?.classList.add('last-move');
  }
  markCheck(square) { this.squareEls.get(square)?.classList.add('check'); }

  // ---------- drag & drop ----------
  _bindDrag(el, rec) {
    let startSquare = null;
    let moved = false;

    el.addEventListener('pointerdown', (e) => {
      if (!this.handlers.canDrag(rec.square)) return;
      startSquare = rec.square;
      moved = false;
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    el.addEventListener('pointermove', (e) => {
      if (startSquare === null) return;
      if (!moved) {
        moved = true;
        el.classList.add('dragging');
        this.handlers.onDragStart?.(startSquare);
      }
      const rect = this.piecesEl.getBoundingClientRect();
      const x = e.clientX - rect.left - rect.width / 16;
      const y = e.clientY - rect.top - rect.height / 16;
      el.style.transform = `translate(${x}px, ${y}px)`;
      const over = this.squareFromPoint(e.clientX, e.clientY);
      for (const [, sq] of this.squareEls) sq.classList.remove('drag-over');
      if (over && over !== startSquare) this.squareEls.get(over)?.classList.add('drag-over');
    });

    const finish = (e) => {
      if (startSquare === null) return;
      const from = startSquare;
      startSquare = null;
      for (const [, sq] of this.squareEls) sq.classList.remove('drag-over');
      if (!moved) {
        // treat as click-select
        this.handlers.onSquareClick(from);
        return;
      }
      el.classList.remove('dragging');
      const target = this.squareFromPoint(e.clientX, e.clientY);
      if (target && target !== from) {
        this.handlers.onDropMove(from, target);
      } else {
        this._place(el, rec.square, true); // snap back
      }
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
  }
}
