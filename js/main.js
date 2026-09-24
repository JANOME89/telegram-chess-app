import { Chess } from 'chess.js';
import { Board, GLYPHS } from './board.js';
import { Engine } from './engine.js';

const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

const $ = (id) => document.getElementById(id);

const els = {
  menuScreen: $('menu-screen'),
  gameScreen: $('game-screen'),
  boardEl: $('board'),
  movesList: $('moves-list'),
  statusText: $('status-text'),
  turnDot: $('turn-dot'),
  modeLabel: $('mode-label'),
  overlay: $('overlay'),
  overlayTitle: $('overlay-title'),
  overlaySub: $('overlay-sub'),
  thinking: $('thinking'),
  promoModal: $('promo-modal'),
  promoChoices: $('promo-choices'),
  capturedTop: $('captured-top'),
  capturedBottom: $('captured-bottom'),
  materialTop: $('material-top'),
  materialBottom: $('material-bottom'),
  playerTop: $('player-top'),
  playerBottom: $('player-bottom'),
  difficulty: $('difficulty'),
};

// ---- application state ----
const state = {
  game: new Chess(),
  mode: 'local',        // 'local' | 'computer'
  playerColor: 'w',     // human color in computer mode
  difficulty: 3,
  selected: null,       // square string
  legalTargets: [],     // verbose moves for selected square
  busy: false,          // engine thinking / locked
  flipped: false,
};

const engine = new Engine();
const board = new Board(els.boardEl, {
  onSquareClick: handleSquareClick,
  canDrag: canDragSquare,
  onDragMove: (from) => selectSquare(from),
  onDropMove: (from, to) => attemptMove(from, to),
});

// ===================== Screen / mode control =====================

function showMenu() {
  els.gameScreen.classList.add('hidden');
  els.menuScreen.classList.remove('hidden');
  engine.stop();
}

function startGame(mode, playerColor = 'w') {
  state.mode = mode;
  state.playerColor = playerColor;
  state.difficulty = parseInt(els.difficulty.value, 10) || 3;
  state.game = new Chess();
  state.selected = null;
  state.legalTargets = [];
  state.busy = false;
  state.flipped = false;

  // orient board: computer mode -> human at bottom; local -> white at bottom
  board.setOrientation(mode === 'computer' ? playerColor : 'w');

  els.menuScreen.classList.add('hidden');
  els.gameScreen.classList.remove('hidden');
  els.overlay.classList.add('hidden');
  els.thinking.classList.add('hidden');

  els.modeLabel.textContent =
    mode === 'computer'
      ? `Против компьютера · ур. ${state.difficulty}`
      : 'Локальная игра';

  renderAll();

  // if human plays black, engine (white) moves first
  if (mode === 'computer' && playerColor === 'b') {
    triggerEngineMove();
  }
}

// ===================== Interaction =====================

function isHumanTurn() {
  if (state.busy) return false;
  if (state.mode === 'local') return true;
  return state.game.turn() === state.playerColor;
}

function canDragSquare(square) {
  if (!isHumanTurn()) return false;
  const piece = state.game.get(square);
  return piece && piece.color === state.game.turn();
}

function handleSquareClick(square) {
  if (state.game.isGameOver() || state.busy) return;
  if (!isHumanTurn()) return;

  const piece = state.game.get(square);

  // If a square is already selected, try to move there first
  if (state.selected) {
    const isTarget = state.legalTargets.some((m) => m.to === square);
    if (isTarget) {
      attemptMove(state.selected, square);
      return;
    }
    // clicking own another piece -> reselect
    if (piece && piece.color === state.game.turn()) {
      selectSquare(square);
      return;
    }
    // otherwise deselect
    clearSelection();
    return;
  }

  // nothing selected: select own piece of side to move
  if (piece && piece.color === state.game.turn()) {
    selectSquare(square);
  }
}

function selectSquare(square) {
  if (!isHumanTurn()) return;
  const piece = state.game.get(square);
  if (!piece || piece.color !== state.game.turn()) return;
  const moves = state.game.moves({ square, verbose: true });
  if (!moves.length) return;
  state.selected = square;
  state.legalTargets = moves;
  board.clearSelection();
  board.clearMoves();
  board.setSelected(square);
  board.showMoves(moves);
}

function clearSelection() {
  state.selected = null;
  state.legalTargets = [];
  board.clearSelection();
  board.clearMoves();
}

function attemptMove(from, to) {
  if (!isHumanTurn()) return;
  const legal = state.game.moves({ square: from, verbose: true }).find((m) => m.to === to);
  if (!legal) {
    clearSelection();
    return;
  }

  // promotion?
  if (legal.promotion) {
    openPromotion(from, to, state.game.turn());
    return;
  }

  doMove({ from, to });
}

function doMove(moveObj) {
  let result;
  try {
    result = state.game.move(moveObj);
  } catch (e) {
    clearSelection();
    return null;
  }
  clearSelection();
  renderAll();
  afterMove();
  return result;
}

function openPromotion(from, to, color) {
  els.promoChoices.innerHTML = '';
  ['q', 'r', 'b', 'n'].forEach((type) => {
    const btn = document.createElement('button');
    btn.className = 'promo-choice';
    const span = document.createElement('span');
    span.className = 'piece ' + (color === 'w' ? 'white' : 'black');
    span.style.fontSize = '46px';
    span.textContent = GLYPHS[color][type];
    btn.appendChild(span);
    btn.addEventListener('click', () => {
      els.promoModal.classList.add('hidden');
      doMove({ from, to, promotion: type });
    });
    els.promoChoices.appendChild(btn);
  });
  els.promoModal.classList.remove('hidden');
}

// ===================== Post-move / game flow =====================

function afterMove() {
  if (state.game.isGameOver()) {
    showGameOver();
    return;
  }
  if (state.mode === 'computer' && state.game.turn() !== state.playerColor) {
    triggerEngineMove();
  }
}

async function triggerEngineMove() {
  state.busy = true;
  els.thinking.classList.remove('hidden');
  updateControls();
  let uci;
  try {
    uci = await engine.getBestMove(state.game.fen(), state.difficulty);
  } catch (e) {
    console.error('Engine error', e);
  }
  els.thinking.classList.add('hidden');
  state.busy = false;

  if (!uci || state.game.isGameOver()) {
    renderAll();
    return;
  }

  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci[4] : undefined;
  doMove({ from, to, promotion });
}

function showGameOver() {
  const g = state.game;
  let title = 'Игра окончена';
  let sub = '';
  if (g.isCheckmate()) {
    const winner = g.turn() === 'w' ? 'Чёрные' : 'Белые';
    title = 'Мат!';
    sub = `${winner} победили`;
  } else if (g.isStalemate()) {
    title = 'Пат';
    sub = 'Ничья';
  } else if (g.isThreefoldRepetition()) {
    title = 'Ничья';
    sub = 'Троекратное повторение позиции';
  } else if (g.isInsufficientMaterial()) {
    title = 'Ничья';
    sub = 'Недостаточно материала';
  } else if (g.isDraw()) {
    title = 'Ничья';
    sub = 'Правило 50 ходов';
  }
  els.overlayTitle.textContent = title;
  els.overlaySub.textContent = sub;
  els.overlay.classList.remove('hidden');
}

function resign() {
  if (state.game.isGameOver()) return;
  const loser = state.game.turn();
  const winner = loser === 'w' ? 'Чёрные' : 'Белые';
  els.overlayTitle.textContent = 'Сдался';
  els.overlaySub.textContent = `${winner} победили`;
  els.overlay.classList.remove('hidden');
  state.busy = true; // lock board
  updateControls();
}

function undo() {
  if (state.busy) return;
  // in computer mode undo both engine + human move
  state.game.undo();
  if (state.mode === 'computer' && state.game.turn() !== state.playerColor && state.game.history().length) {
    state.game.undo();
  }
  clearSelection();
  els.overlay.classList.add('hidden');
  renderAll();
}

// ===================== Rendering =====================

function renderAll() {
  board.render(state.game.board());
  renderLastMove();
  renderCheck();
  renderStatus();
  renderMoves();
  renderCaptured();
  updateControls();
}

function renderLastMove() {
  const hist = state.game.history({ verbose: true });
  if (!hist.length) return;
  const last = hist[hist.length - 1];
  board.markLastMove(last.from, last.to);
}

function renderCheck() {
  if (!state.game.inCheck()) return;
  const turn = state.game.turn();
  const bd = state.game.board();
  for (const row of bd) {
    for (const cell of row) {
      if (cell && cell.type === 'k' && cell.color === turn) {
        board.markCheck(cell.square);
        return;
      }
    }
  }
}

function renderStatus() {
  const turn = state.game.turn();
  els.turnDot.className = 'turn-dot' + (turn === 'b' ? ' black' : '');
  let text = turn === 'w' ? 'Ход белых' : 'Ход чёрных';
  if (state.game.inCheck() && !state.game.isGameOver()) text += ' · Шах!';
  if (state.game.isGameOver()) text = 'Игра окончена';
  els.statusText.textContent = text;

  // active player bar
  const bottomIsWhite = board.orientation === 'w';
  els.playerBottom.classList.toggle('active', turn === (bottomIsWhite ? 'w' : 'b'));
  els.playerTop.classList.toggle('active', turn === (bottomIsWhite ? 'b' : 'w'));
}

function renderMoves() {
  const hist = state.game.history();
  els.movesList.innerHTML = '';
  for (let i = 0; i < hist.length; i += 2) {
    const num = document.createElement('li');
    num.className = 'move-num';
    num.textContent = i / 2 + 1 + '.';
    const white = document.createElement('li');
    white.className = 'move-cell' + (i === hist.length - 1 ? ' latest' : '');
    white.textContent = hist[i];
    const black = document.createElement('li');
    black.className = 'move-cell' + (i + 1 === hist.length - 1 ? ' latest' : '');
    black.textContent = hist[i + 1] || '';
    els.movesList.append(num, white, black);
  }
  els.movesList.parentElement.scrollTop = els.movesList.parentElement.scrollHeight;
}

function renderCaptured() {
  // count remaining pieces vs full set
  const startCounts = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };
  const current = { w: {}, b: {} };
  for (const color of ['w', 'b']) {
    for (const t of Object.keys(startCounts)) current[color][t] = 0;
  }
  for (const row of state.game.board()) {
    for (const cell of row) {
      if (cell && cell.type !== 'k') current[cell.color][cell.type]++;
    }
  }

  // captured by white = black pieces missing; captured by black = white pieces missing
  const capturedByWhite = []; // black pieces taken
  const capturedByBlack = []; // white pieces taken
  let whiteMat = 0, blackMat = 0;
  for (const t of ['q', 'r', 'b', 'n', 'p']) {
    const missingBlack = startCounts[t] - current.b[t];
    const missingWhite = startCounts[t] - current.w[t];
    for (let i = 0; i < missingBlack; i++) capturedByWhite.push({ type: t, color: 'b' });
    for (let i = 0; i < missingWhite; i++) capturedByBlack.push({ type: t, color: 'w' });
    whiteMat += missingBlack * PIECE_VALUE[t];
    blackMat += missingWhite * PIECE_VALUE[t];
  }

  // bottom player = board.orientation color
  const bottomColor = board.orientation; // 'w' => white at bottom
  const bottomCaptured = bottomColor === 'w' ? capturedByWhite : capturedByBlack;
  const topCaptured = bottomColor === 'w' ? capturedByBlack : capturedByWhite;
  const bottomAdv = bottomColor === 'w' ? whiteMat - blackMat : blackMat - whiteMat;

  renderCapturedRow(els.capturedBottom, bottomCaptured);
  renderCapturedRow(els.capturedTop, topCaptured);
  els.materialBottom.textContent = bottomAdv > 0 ? '+' + bottomAdv : '';
  els.materialTop.textContent = bottomAdv < 0 ? '+' + (-bottomAdv) : '';
}

function renderCapturedRow(container, pieces) {
  container.innerHTML = '';
  for (const p of pieces) {
    const span = document.createElement('span');
    span.className = p.color === 'w' ? 'cap-w' : 'cap-b';
    span.textContent = GLYPHS[p.color][p.type];
    container.appendChild(span);
  }
}

function updateControls() {
  const lockable = state.busy || state.game.isGameOver();
  $('btn-undo').disabled = lockable;
  $('btn-resign').disabled = state.game.isGameOver();
  $('btn-undo').style.opacity = lockable ? '0.4' : '1';
  $('btn-resign').style.opacity = state.game.isGameOver() ? '0.4' : '1';
}

// ===================== Event wiring =====================

document.querySelectorAll('[data-start]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const val = btn.dataset.start;
    if (val === 'local') startGame('local');
    else if (val === 'computer-white') startGame('computer', 'w');
    else if (val === 'computer-black') startGame('computer', 'b');
  });
});

document.querySelectorAll('[data-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const m = btn.dataset.mode;
    if (m === 'menu') showMenu();
    else if (m === 'local') startGame('local');
    else if (m === 'computer') startGame('computer', 'w');
  });
});

$('btn-flip').addEventListener('click', () => {
  board.flip();
  state.flipped = !state.flipped;
  renderAll();
});
$('btn-undo').addEventListener('click', undo);
$('btn-resign').addEventListener('click', resign);
$('btn-new').addEventListener('click', () => {
  if (state.mode === 'computer') startGame('computer', state.playerColor);
  else startGame('local');
});
$('overlay-new').addEventListener('click', () => {
  if (state.mode === 'computer') startGame('computer', state.playerColor);
  else startGame('local');
});
$('overlay-menu').addEventListener('click', showMenu);

// initial menu view
showMenu();
