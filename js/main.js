import { Chess } from 'chess.js';
import { injectSprite, pieceSVG } from './pieces.js';
import { Board } from './board.js';
import { Engine } from './engine.js';
import { SoundFX } from './sound.js';
import {
  initTelegram, showMainButton, hideMainButton, showBackButton, hideBackButton,
  getUser, haptic, setTgSettings,
} from './tg.js';

const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const $ = (id) => document.getElementById(id);

const state = {
  game: new Chess(),
  mode: 'bot',
  level: 3,
  playerColor: 'w',
  sound: true,
  haptics: true,
  boardTheme: 'neo',
  selected: null,
  legalTargets: [],
  busy: false,
};

const sound = new SoundFX();
const engine = new Engine();

const board = new Board($('squares'), $('pieces-layer'), {
  onSquareClick: handleSquareClick,
  canDrag: (sq) => isHumanTurn() && !!state.game.get(sq) && state.game.get(sq).color === state.game.turn(),
  onDragStart: (sq) => selectSquare(sq),
  onDropMove: (from, to) => attemptMove(from, to),
});

// ================= settings persistence =================
function loadSettings() {
  try {
    const raw = localStorage.getItem('uca-settings');
    if (raw) Object.assign(state, JSON.parse(raw));
  } catch (_) {}
  sound.enabled = state.sound;
  setTgSettings({ sound: state.sound, haptics: state.haptics });
  document.documentElement.dataset.boardTheme = state.boardTheme;
  $('set-sound').checked = state.sound;
  $('set-haptics').checked = state.haptics;
  document.querySelectorAll('#set-level button').forEach((b) =>
    b.classList.toggle('active', +b.dataset.lvl === state.level));
  document.querySelectorAll('#set-board-theme button').forEach((b) =>
    b.classList.toggle('active', b.dataset.theme === state.boardTheme));
  refreshMenuSub();
}
function saveSettings() {
  localStorage.setItem('uca-settings', JSON.stringify({
    level: state.level, sound: state.sound, haptics: state.haptics, boardTheme: state.boardTheme,
  }));
}
function refreshMenuSub() {
  $('menu-bot-sub').textContent = `Stockfish · ур. ${state.level}`;
}

// ================= screens & TG buttons =================
function showScreen(name) {
  ['menu', 'settings', 'game'].forEach((s) => $('screen-' + s).classList.toggle('hidden', s !== name));
  if (name === 'menu') {
    hideBackButton();
    showMainButton('Начать игру', () => startGame(state.mode));
  } else {
    hideMainButton();
    showBackButton(() => showScreen('menu'));
  }
}

// ================= profile =================
function fillProfile() {
  const user = getUser();
  const img = $('profile-avatar');
  const fb = $('profile-avatar-fallback');
  if (user) {
    $('profile-name').textContent = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Игрок';
    $('profile-sub').textContent = user.username ? '@' + user.username : 'Telegram Mini App';
    if (user.photo_url) {
      img.src = user.photo_url;
      img.classList.add('visible');
      fb.classList.add('hidden');
    } else {
      fb.textContent = (user.first_name || '?')[0].toUpperCase();
    }
  }
}

// ================= game lifecycle =================
function startGame(mode) {
  state.mode = mode;
  state.game = new Chess();
  state.selected = null;
  state.legalTargets = [];
  state.busy = false;
  board.setOrientation('w');
  board.fullRender(state.game.board());
  board.clearHighlights();
  $('overlay').classList.add('hidden');
  $('thinking').classList.add('hidden');
  $('game-title').textContent = mode === 'bot' ? `Бот · ур. ${state.level}` : 'Pass & Play';
  renderStrips();
  renderStatus();
  showScreen('game');
  haptic('light');
}

function isHumanTurn() {
  if (state.busy || state.game.isGameOver()) return false;
  if (state.mode === 'local') return true;
  return state.game.turn() === state.playerColor;
}

function handleSquareClick(square) {
  if (!isHumanTurn()) return;
  const piece = state.game.get(square);
  if (state.selected) {
    if (state.legalTargets.some((m) => m.to === square)) { attemptMove(state.selected, square); return; }
    if (piece && piece.color === state.game.turn()) { selectSquare(square); return; }
    clearSelection();
    return;
  }
  if (piece && piece.color === state.game.turn()) selectSquare(square);
}

function selectSquare(square) {
  if (!isHumanTurn()) return;
  const piece = state.game.get(square);
  if (!piece || piece.color !== state.game.turn()) return;
  const moves = state.game.moves({ square, verbose: true });
  if (!moves.length) return;
  state.selected = square;
  state.legalTargets = moves;
  board.clearHighlights();
  board.setSelected(square);
  board.showMoves(moves);
  sound.play('select');
  haptic('light');
}

function clearSelection() {
  state.selected = null;
  state.legalTargets = [];
  board.clearHighlights();
  renderDecor();
}

function attemptMove(from, to) {
  if (!isHumanTurn()) return;
  const legal = state.game.moves({ square: from, verbose: true }).find((m) => m.to === to);
  if (!legal) {
    sound.play('illegal');
    haptic('error');
    board.fullRender(state.game.board()); // snap dragged piece back
    clearSelection();
    return;
  }
  if (legal.promotion) { openPromotion(from, to, state.game.turn()); return; }
  doMove({ from, to });
}

function doMove(obj) {
  let m;
  try { m = state.game.move(obj); }
  catch (_) { clearSelection(); return null; }
  board.applyMove(m);
  if (m.captured) { sound.play('capture'); haptic('medium'); }
  else if (m.flags.includes('k') || m.flags.includes('q')) { sound.play('castle'); haptic('light'); }
  else { sound.play('move'); haptic('light'); }
  if (state.game.inCheck() && !state.game.isGameOver()) { sound.play('check'); haptic('warning'); }
  state.selected = null;
  state.legalTargets = [];
  renderDecor();
  renderStrips();
  renderStatus();
  afterMove();
  return m;
}

function afterMove() {
  if (state.game.isGameOver()) { endGame(); return; }
  if (state.mode === 'bot' && state.game.turn() !== state.playerColor) engineMove();
}

async function engineMove() {
  state.busy = true;
  $('thinking').classList.remove('hidden');
  let uci = null;
  try { uci = await engine.getBestMove(state.game.fen(), state.level); }
  catch (e) { console.error(e); }
  $('thinking').classList.add('hidden');
  state.busy = false;
  if (!uci || state.game.isGameOver()) { renderStatus(); return; }
  doMove({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
}

function endGame() {
  const g = state.game;
  let title = 'Игра окончена', sub = '';
  if (g.isCheckmate()) {
    const winnerWhite = g.turn() === 'b';
    title = 'Мат!';
    sub = state.mode === 'bot'
      ? (winnerWhite ? 'Вы победили 🎉' : 'Бот победил')
      : (winnerWhite ? 'Белые победили' : 'Чёрные победили');
    haptic(winnerWhite || state.mode === 'local' ? 'success' : 'error');
  } else if (g.isStalemate()) { title = 'Пат'; sub = 'Ничья'; haptic('warning'); }
  else if (g.isThreefoldRepetition()) { title = 'Ничья'; sub = 'Повторение позиции'; haptic('warning'); }
  else if (g.isInsufficientMaterial()) { title = 'Ничья'; sub = 'Недостаточно материала'; haptic('warning'); }
  else if (g.isDraw()) { title = 'Ничья'; sub = 'Правило 50 ходов'; haptic('warning'); }
  $('overlay-title').textContent = title;
  $('overlay-sub').textContent = sub;
  $('overlay').classList.remove('hidden');
  sound.play('end');
  renderStatus();
}

function resign() {
  if (state.game.isGameOver() || state.busy) return;
  const loserWhite = state.game.turn() === 'w';
  $('overlay-title').textContent = 'Сдался';
  $('overlay-sub').textContent = state.mode === 'bot'
    ? (loserWhite ? 'Бот победил' : 'Вы победили')
    : (loserWhite ? 'Чёрные победили' : 'Белые победили');
  $('overlay').classList.remove('hidden');
  state.busy = true;
  sound.play('end');
  haptic('error');
}

function undo() {
  if (state.busy) return;
  state.game.undo();
  if (state.mode === 'bot' && state.game.turn() !== state.playerColor && state.game.history().length) {
    state.game.undo();
  }
  state.selected = null;
  state.legalTargets = [];
  state.busy = false;
  board.fullRender(state.game.board());
  $('overlay').classList.add('hidden');
  renderDecor();
  renderStrips();
  renderStatus();
}

// ================= rendering =================
function renderDecor() {
  board.clearHighlights();
  const hist = state.game.history({ verbose: true });
  if (hist.length) {
    const last = hist[hist.length - 1];
    board.markLastMove(last.from, last.to);
  }
  if (state.game.inCheck()) {
    const turn = state.game.turn();
    for (const row of state.game.board()) {
      for (const c of row) {
        if (c && c.type === 'k' && c.color === turn) { board.markCheck(c.square); return; }
      }
    }
  }
}

function renderStrips() {
  const startCounts = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const cur = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const row of state.game.board()) for (const c of row) if (c && c.type !== 'k') cur[c.color][c.type]++;
  const capByWhite = [], capByBlack = [];
  let wMat = 0, bMat = 0;
  for (const t of ['q', 'r', 'b', 'n', 'p']) {
    const missB = (startCounts[t] || 0) - cur.b[t];
    const missW = (startCounts[t] || 0) - cur.w[t];
    for (let i = 0; i < missB; i++) capByWhite.push({ t, c: 'b' });
    for (let i = 0; i < missW; i++) capByBlack.push({ t, c: 'w' });
    wMat += missB * PIECE_VALUE[t];
    bMat += missW * PIECE_VALUE[t];
  }
  const bottomIsWhite = board.orientation === 'w';
  const bottomCap = bottomIsWhite ? capByWhite : capByBlack;
  const topCap = bottomIsWhite ? capByBlack : capByWhite;
  const bottomAdv = bottomIsWhite ? wMat - bMat : bMat - wMat;

  fillCap($('cap-bottom'), bottomCap);
  fillCap($('cap-top'), topCap);
  $('mat-bottom').textContent = bottomAdv > 0 ? '+' + bottomAdv : '';
  $('mat-top').textContent = bottomAdv < 0 ? '+' + (-bottomAdv) : '';

  if (state.mode === 'bot') {
    $('name-bottom').textContent = 'Вы';
    $('name-top').textContent = `Бот · ур. ${state.level}`;
  } else {
    $('name-bottom').textContent = bottomIsWhite ? 'Белые' : 'Чёрные';
    $('name-top').textContent = bottomIsWhite ? 'Чёрные' : 'Белые';
  }
}
function fillCap(el, list) {
  el.innerHTML = '';
  for (const p of list) {
    const wrap = document.createElement('span');
    wrap.className = 'piece ' + (p.c === 'w' ? 'white' : 'black');
    wrap.style.position = 'static';
    wrap.style.width = '16px';
    wrap.style.height = '16px';
    wrap.appendChild(pieceSVG(p.t));
    el.appendChild(wrap);
  }
}

function renderStatus() {
  const turn = state.game.turn();
  let text = turn === 'w' ? 'Ход белых' : 'Ход чёрных';
  if (state.mode === 'bot') text = turn === state.playerColor ? 'Ваш ход' : 'Ход бота';
  if (state.game.inCheck() && !state.game.isGameOver()) text += ' · шах!';
  if (state.game.isGameOver()) text = 'Партия окончена';
  $('status-pill').textContent = text;
  const bottomIsWhite = board.orientation === 'w';
  $('strip-bottom').classList.toggle('active', turn === (bottomIsWhite ? 'w' : 'b'));
  $('strip-top').classList.toggle('active', turn === (bottomIsWhite ? 'b' : 'w'));
}

// ================= promotion =================
function openPromotion(from, to, color) {
  const box = $('promo-choices');
  box.innerHTML = '';
  ['q', 'r', 'b', 'n'].forEach((t) => {
    const btn = document.createElement('button');
    btn.className = 'promo-choice';
    const wrap = document.createElement('span');
    wrap.className = 'piece ' + (color === 'w' ? 'white' : 'black');
    wrap.style.position = 'static';
    wrap.style.width = '46px';
    wrap.style.height = '46px';
    wrap.appendChild(pieceSVG(t));
    btn.appendChild(wrap);
    btn.addEventListener('click', () => {
      $('promo-modal').classList.add('hidden');
      doMove({ from, to, promotion: t });
    });
    box.appendChild(btn);
  });
  $('promo-modal').classList.remove('hidden');
}

// ================= UI wiring =================
document.querySelectorAll('.mode-card').forEach((card) => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.mode-card').forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected');
    state.mode = card.dataset.mode;
    haptic('light');
  });
});
$('btn-start').addEventListener('click', () => startGame(state.mode));
$('btn-open-settings').addEventListener('click', () => showScreen('settings'));
$('btn-back-settings').addEventListener('click', () => showScreen('menu'));
$('btn-back-game').addEventListener('click', () => showScreen('menu'));
$('btn-flip').addEventListener('click', () => {
  board.flip();
  board.fullRender(state.game.board());
  renderDecor();
  renderStrips();
  haptic('light');
});
$('btn-undo').addEventListener('click', undo);
$('btn-resign').addEventListener('click', resign);
$('overlay-new').addEventListener('click', () => startGame(state.mode));
$('overlay-menu').addEventListener('click', () => showScreen('menu'));

$('set-sound').addEventListener('change', (e) => {
  state.sound = e.target.checked; sound.enabled = state.sound; saveSettings();
});
$('set-haptics').addEventListener('change', (e) => {
  state.haptics = e.target.checked; setTgSettings({ sound: state.sound, haptics: state.haptics }); saveSettings();
});
document.querySelectorAll('#set-level button').forEach((b) => {
  b.addEventListener('click', () => {
    state.level = +b.dataset.lvl;
    document.querySelectorAll('#set-level button').forEach((x) => x.classList.toggle('active', x === b));
    refreshMenuSub(); saveSettings(); haptic('light');
  });
});
document.querySelectorAll('#set-board-theme button').forEach((b) => {
  b.addEventListener('click', () => {
    state.boardTheme = b.dataset.theme;
    document.documentElement.dataset.boardTheme = state.boardTheme;
    document.querySelectorAll('#set-board-theme button').forEach((x) => x.classList.toggle('active', x === b));
    saveSettings(); haptic('light');
  });
});

// ================= boot =================
injectSprite();
initTelegram();
loadSettings();
fillProfile();
showScreen('menu');
