import { Chess } from 'chess.js';
import { injectSprite, pieceSVG } from './pieces.js';
import { Board } from './board.js';
import { Engine } from './engine.js';
import { SoundFX } from './sound.js';
import { Net } from './net.js';
import { CONFIG } from './config.js';
import {
  tg, inTelegram,
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
  // online
  net: null,
  room: null,
  myColor: 'w',
  // identity / tournaments
  me: null,
  isAdmin: false,
  tourMatch: null,   // { tourId, matchId, oppId, oppName } while in a bracket match
  tours: [],
  currentTour: null,
  myClaim: null,
  adminSeats: 4,
  claimMethod: 'card',
  activeClaim: null, // { tourId, place, amount, status }
};

const SCREENS = ['menu', 'settings', 'game', 'tournaments', 'tour-detail', 'admin'];

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
  SCREENS.forEach((s) => $('screen-' + s).classList.toggle('hidden', s !== name));
  if (name === 'menu') {
    hideBackButton();
    showMainButton('Начать игру', () => startGame(state.mode));
  } else {
    hideMainButton();
    const back = name === 'tour-detail' ? 'tournaments'
      : name === 'admin' ? 'tournaments'
      : 'menu';
    showBackButton(() => showScreen(back));
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
  leaveOnline();
  state.mode = mode;
  state.game = new Chess();
  state.selected = null;
  state.legalTargets = [];
  state.busy = false;
  $('overlay-new').classList.remove('hidden');
  $('btn-undo').disabled = false;
  $('btn-undo').style.opacity = '1';
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
  if (state.mode === 'online') return !!state.net?.open && state.game.turn() === state.myColor;
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

function doMove(obj, origin = 'local') {
  let m;
  try { m = state.game.move(obj); }
  catch (_) { clearSelection(); return null; }
  board.applyMove(m);
  if (state.mode === 'online' && origin === 'local') {
    state.net?.send({ t: 'move', move: { from: m.from, to: m.to, promotion: m.promotion } });
  }
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
    if (state.mode === 'online') {
      const myWin = winnerWhite === (state.myColor === 'w');
      title = myWin ? 'Победа!' : 'Поражение!';
      sub = 'Мат';
      haptic(myWin ? 'success' : 'error');
    } else {
      title = 'Мат!';
      sub = state.mode === 'bot'
        ? (winnerWhite ? 'Вы победили 🎉' : 'Бот победил')
        : (winnerWhite ? 'Белые победили' : 'Чёрные победили');
      haptic(winnerWhite || state.mode === 'local' ? 'success' : 'error');
    }
  } else if (g.isStalemate()) { title = state.mode === 'online' ? 'Ничья' : 'Пат'; sub = 'Ничья'; haptic('warning'); }
  else if (g.isThreefoldRepetition()) { title = 'Ничья'; sub = 'Повторение позиции'; haptic('warning'); }
  else if (g.isInsufficientMaterial()) { title = 'Ничья'; sub = 'Недостаточно материала'; haptic('warning'); }
  else if (g.isDraw()) { title = 'Ничья'; sub = 'Правило 50 ходов'; haptic('warning'); }
  $('overlay-title').textContent = title;
  $('overlay-sub').textContent = sub;
  $('overlay').classList.remove('hidden');
  if (state.tourMatch) {
    if (g.isCheckmate()) {
      const winnerWhite = g.turn() === 'b';
      const iWon = winnerWhite === (state.myColor === 'w');
      reportTourResult(iWon ? state.me?.id : state.tourMatch.oppId);
    } else {
      $('overlay-sub').textContent = sub + ' · переигровка';
      reportTourResult('draw');
    }
  }
  sound.play('end');
  renderStatus();
}

function resign() {
  if (state.game.isGameOver() || state.busy) return;
  if (state.mode === 'online') {
    state.net?.send({ t: 'resign' });
    $('overlay-title').textContent = 'Поражение!';
    $('overlay-sub').textContent = 'Вы сдались';
    $('overlay').classList.remove('hidden');
    state.busy = true;
    reportTourResult(state.tourMatch?.oppId);
    sound.play('end');
    haptic('error');
    return;
  }
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
  if (state.busy || state.mode === 'online') return;
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
  if (state.mode === 'online') text = turn === state.myColor ? 'Ваш ход' : 'Ход соперника';
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

// ================= online multiplayer =================
function onlineModal(show) { $('online-modal').classList.toggle('hidden', !show); }

function setOnlineStatus(title, sub, spinning) {
  $('online-title').textContent = title;
  $('online-sub').textContent = sub || '';
  $('online-sub').classList.toggle('hidden', !sub);
  $('online-spinner').classList.toggle('hidden', !spinning);
}

function inviteLink(room) { return `${CONFIG.botAppLink}?startapp=${room}`; }

// ---------- identity ----------
function authPayload() {
  if (tg?.initData) return { t: 'auth', initData: tg.initData };
  const p = new URLSearchParams(location.search);
  const as = p.get('as'); // dev: ?as=123@username  (browser testing only)
  if (as) {
    const [id, un] = as.split('@');
    return { t: 'auth', dev: { id: Number(id) || 1, username: un || '', first_name: un || ('Player ' + id) } };
  }
  let gid = localStorage.getItem('uca-guest-id');
  if (!gid) { gid = String(Math.floor(1e8 + Math.random() * 9e8)); localStorage.setItem('uca-guest-id', gid); }
  return { t: 'auth', dev: { id: Number(gid), username: '', first_name: 'Гость' } };
}

let authResolve = null;
let reconnectTimer = null;

function ensureNet() {
  if (state.net) return state.net;
  const net = new Net(CONFIG.wsUrl);
  state.net = net;
  setupNet(net);
  return net;
}

// Resolve once the socket is connected AND authenticated (state.me set).
async function netAuthed() {
  const net = ensureNet();
  if (!net.open) { try { await net.connect(); } catch (_) { return null; } }
  if (state.me) return net;
  return await new Promise((res) => {
    authResolve = res;
    setTimeout(() => { if (authResolve) { authResolve = null; res(state.me ? net : null); } }, 5000);
  });
}

function setupNet(net) {
  net.on('open', () => net.send(authPayload()));

  net.on('auth-ok', ({ user, admin }) => {
    state.me = user; state.isAdmin = !!admin;
    $('btn-admin').classList.toggle('hidden', !admin);
    if (authResolve) { const r = authResolve; authResolve = null; r(net); }
    // re-subscribe if the user is looking at tournaments
    if (!$('screen-tournaments').classList.contains('hidden') ||
        !$('screen-tour-detail').classList.contains('hidden')) net.send({ t: 'tours' });
  });

  // ---- casual online ----
  net.on('start', ({ room, color }) => { onlineModal(false); beginOnline(room, color, null); });
  net.on('created', ({ room }) => {
    state.room = room;
    $('invite-link').value = inviteLink(room);
    $('invite-row').classList.remove('hidden');
    $('invite-friend').classList.add('hidden');
    setOnlineStatus('Ожидание друга…', 'Отправьте ссылку сопернику', true);
  });
  net.on('queued', () => setOnlineStatus('Поиск соперника…', 'Подбираем равного по силе игрока', true));

  // ---- shared game relay ----
  net.on('move', ({ move }) => { if (state.mode === 'online') doMove(move, 'remote'); });
  net.on('resign', () => {
    if (state.mode !== 'online' || state.game.isGameOver()) return;
    showWinOverlay('Победа!', 'Соперник сдался', true);
    reportTourResult(state.me?.id);
  });
  net.on('opponent-left', () => {
    if (state.mode !== 'online' || state.game.isGameOver()) return;
    showWinOverlay('Победа!', 'Соперник отключился', true);
    reportTourResult(state.me?.id);
  });

  // ---- tournaments ----
  net.on('tours-list', ({ tours }) => { state.tours = tours; renderTourList(); refreshOpenAdminList(); });
  net.on('tour-detail', ({ tour, myClaim }) => { state.currentTour = tour; state.myClaim = myClaim; renderTourDetail(); });
  net.on('tour-joined', ({ tourId }) => { if (state.currentTour?.id === tourId) state.net?.send({ t: 'tour-detail', tourId }); haptic('success'); });
  net.on('tour-created', ({ tour }) => { haptic('success'); toast(`Турнир «${tour.name}» создан`); state.net?.send({ t: 'tours' }); });
  net.on('tour-started', ({ tourId }) => { toast('Сетка сгенерирована, турнир начался'); state.net?.send({ t: 'tours' }); if (state.currentTour?.id === tourId) state.net?.send({ t: 'tour-detail', tourId }); });
  net.on('match-start', (p) => enterTournamentMatch(p));
  net.on('prize-claim', (p) => openClaimModal(p));
  net.on('claim-ok', () => { state.activeClaim && (state.activeClaim.status = 'submitted'); showClaimSent(); });
  net.on('claim-paid', () => toast('Выплата получена! 🎉'));
  net.on('payouts-list', ({ claims }) => renderPayouts(claims));

  net.on('error', ({ msg }) => {
    if (!msg) return;
    if (!$('online-modal').classList.contains('hidden')) onlineModal(false);
    toast(msg);
  });
  net.on('close', () => {
    state.me = null;
    if (state.mode === 'online' && !state.game.isGameOver()) {
      $('overlay-title').textContent = 'Связь потеряна';
      $('overlay-sub').textContent = 'Переподключение…';
      $('overlay').classList.remove('hidden');
      state.busy = true;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { net.connect().catch(() => {}); }, 2000);
  });
  return net;
}

function showWinOverlay(title, sub, success) {
  $('overlay-title').textContent = title;
  $('overlay-sub').textContent = sub;
  $('overlay').classList.remove('hidden');
  state.busy = true; sound.play('end'); haptic(success ? 'success' : 'error');
}

function reportTourResult(winner) {
  if (!state.tourMatch || winner == null) return;
  state.net?.send({ t: 'tour-result', matchId: state.tourMatch.matchId, winner });
}

async function openOnlineSearch() {
  onlineModal(true);
  $('invite-row').classList.add('hidden');
  $('invite-friend').classList.remove('hidden');
  setOnlineStatus('Поиск соперника…', 'Подбираем равного по силе игрока', true);
  const net = await netAuthed();
  if (!net) { setOnlineStatus('Нет соединения', 'Сервер недоступен', false); return; }
  net.send({ t: 'queue' });
}

async function inviteFriend() {
  const net = await netAuthed();
  if (!net) { setOnlineStatus('Нет соединения', 'Сервер недоступен', false); return; }
  net.send({ t: 'create' });
}

async function joinRoom(room) {
  onlineModal(true);
  $('invite-row').classList.add('hidden');
  $('invite-friend').classList.add('hidden');
  setOnlineStatus('Подключение к комнате…', room, true);
  const net = await netAuthed();
  if (!net) { onlineModal(false); return; }
  net.send({ t: 'join', room });
}

function beginOnline(room, color, tourInfo) {
  state.mode = 'online';
  state.room = room;
  state.myColor = color;
  state.tourMatch = tourInfo || null;
  state.game = new Chess();
  state.selected = null;
  state.legalTargets = [];
  state.busy = false;
  board.setOrientation(color);
  board.fullRender(state.game.board());
  board.clearHighlights();
  $('overlay').classList.add('hidden');
  $('thinking').classList.add('hidden');
  $('overlay-new').classList.add('hidden'); // rematch is server-driven in brackets; N/A for casual
  $('btn-undo').disabled = true;
  $('btn-undo').style.opacity = '0.4';
  $('game-title').textContent = tourInfo
    ? `Турнир · ${tourInfo.oppName}`
    : `Онлайн · ${room}`;
  renderStrips();
  renderStatus();
  showScreen('game');
  haptic('success');
  if (tourInfo) toast('🔔 Ваш тур начался!');
}

function enterTournamentMatch(p) {
  onlineModal(false);
  beginOnline(p.room, p.color, {
    tourId: p.tourId, matchId: p.matchId,
    oppId: p.opponent.id, oppName: p.opponent.first_name || p.opponent.username || 'Соперник',
  });
}

function leaveOnline() {
  if (state.mode === 'online') { state.room = null; state.tourMatch = null; }
}

// ================= tournaments UI =================
const STATUS_LABEL = { registration: 'Регистрация', active: 'Идёт', finished: 'Завершён' };
const money = (n) => `${Math.round(n || 0).toLocaleString('ru-RU')} ₽`;
function displayName(p) { return p?.first_name || p?.username || ('Игрок ' + (p?.id || '')); }

let toastTimer = null;
function toast(text) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast'; el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

async function openTournaments() {
  showScreen('tournaments');
  $('btn-admin').classList.toggle('hidden', !state.isAdmin);
  renderTourList();
  const net = await netAuthed();
  if (!net) { toast('Нет соединения с сервером'); return; }
  net.send({ t: 'tours' });
}

function renderTourList() {
  const list = $('tour-list');
  list.innerHTML = '';
  $('tour-empty').classList.toggle('hidden', state.tours.length > 0);
  for (const t of state.tours) {
    const card = document.createElement('div');
    card.className = 'tour-card glass';
    card.innerHTML =
      `<div class="tour-card-main">
         <div class="tour-card-title">${escapeHtml(t.name)}</div>
         <div class="tour-card-meta">
           <span class="prize-plaque">💰 Приз: ${money(t.prize)}</span>
           <span>👥 ${t.count}/${t.seats}</span>
           <span class="badge ${t.status}">${STATUS_LABEL[t.status] || t.status}</span>
         </div>
       </div>
       <span style="font-size:20px;color:var(--tg-hint)">›</span>`;
    card.addEventListener('click', () => openTourDetail(t.id));
    list.appendChild(card);
  }
}

async function openTourDetail(id) {
  showScreen('tour-detail');
  const net = await netAuthed();
  if (!net) { toast('Нет соединения'); return; }
  net.send({ t: 'tour-detail', tourId: id });
}

function renderTourDetail() {
  const t = state.currentTour;
  if (!t) return;
  $('detail-name').textContent = t.name;
  $('detail-prize').textContent = money(t.prize);
  $('detail-seats').textContent = `Мест: ${t.players.length}/${t.seats}`;
  const badge = $('detail-status');
  badge.textContent = STATUS_LABEL[t.status] || t.status;
  badge.className = 'badge ' + t.status;

  const joined = t.players.some((p) => p.id === state.me?.id);
  const btn = $('detail-join');
  btn.classList.remove('hidden');
  if (t.status === 'registration') {
    btn.disabled = false;
    btn.textContent = joined ? 'Покинуть турнир' : 'Участвовать';
    btn.onclick = () => state.net?.send({ t: joined ? 'tour-leave' : 'tour-join', tourId: t.id });
  } else if (t.status === 'active') {
    btn.disabled = true; btn.textContent = joined ? 'Турнир идёт' : 'Игра началась';
    btn.onclick = null;
  } else {
    btn.disabled = true; btn.textContent = 'Турнир завершён';
    btn.onclick = null;
  }

  // claim access for winners
  const slot = $('detail-claim-slot');
  slot.innerHTML = '';
  if (state.myClaim && state.myClaim.status !== 'paid') {
    const b = document.createElement('button');
    b.className = 'start-btn';
    b.style.margin = '10px 0 0';
    b.textContent = state.myClaim.status === 'submitted'
      ? 'Заявка отправлена, ожидайте выплаты'
      : `🏆 Заявка на приз (${money(state.myClaim.amount)})`;
    b.disabled = state.myClaim.status === 'submitted';
    b.onclick = () => openClaimModal({
      tourId: t.id, tourName: t.name, place: state.myClaim.place,
      amount: state.myClaim.amount, status: state.myClaim.status,
    });
    slot.appendChild(b);
  }

  renderBracket(t);
}

function renderBracket(t) {
  const wrap = $('bracket');
  wrap.innerHTML = '';
  if (!t.rounds || !t.rounds.length) {
    wrap.innerHTML = '<p class="hint">Сетка появится после старта турнира.</p>';
    return;
  }
  t.rounds.forEach((round, ri) => {
    const col = document.createElement('div');
    col.className = 'bracket-round';
    const isFinal = ri === t.rounds.length - 1;
    col.innerHTML = `<div class="bracket-round-title">${isFinal ? 'Финал' : 'Раунд ' + (ri + 1)}</div>`;
    round.forEach((m) => col.appendChild(matchNode(m)));
    wrap.appendChild(col);
  });
  if (t.thirdPlace) {
    const col = document.createElement('div');
    col.className = 'bracket-round';
    col.innerHTML = '<div class="bracket-round-title">За 3-е место</div>';
    col.appendChild(matchNode(t.thirdPlace));
    wrap.appendChild(col);
  }
}
function matchNode(m) {
  const el = document.createElement('div');
  el.className = 'bracket-match';
  el.appendChild(slotNode(m.a, m.winner));
  el.appendChild(slotNode(m.b, m.winner));
  return el;
}
function slotNode(s, winnerId) {
  const el = document.createElement('div');
  const bye = !s || s.bye;
  const isWin = s && s.id && s.id === winnerId;
  el.className = 'bracket-slot' + (isWin ? ' win' : '') + (bye ? ' bye' : '');
  const name = bye ? (s ? 'BYE' : '—') : displayName(s);
  el.innerHTML = `<span class="nm">${escapeHtml(name)}</span>`;
  return el;
}

// ================= admin panel =================
async function openAdmin() {
  if (!state.isAdmin) return;
  showScreen('admin');
  const net = await netAuthed();
  if (!net) { toast('Нет соединения'); return; }
  net.send({ t: 'tours' });
  net.send({ t: 'payouts-list' });
}

function refreshOpenAdminList() {
  const box = $('adm-open-list');
  if (!box) return;
  box.innerHTML = '';
  const open = state.tours.filter((t) => t.status === 'registration');
  if (!open.length) { box.innerHTML = '<p class="hint">Нет турниров на регистрации.</p>'; return; }
  for (const t of open) {
    const row = document.createElement('div');
    row.className = 'adm-open-row';
    row.innerHTML = `<div class="t">${escapeHtml(t.name)}<small>${t.count}/${t.seats} · ${money(t.prize)}</small></div>`;
    const start = document.createElement('button');
    start.className = 'mini-btn'; start.textContent = 'Начать';
    start.disabled = t.count < 2;
    start.onclick = () => state.net?.send({ t: 'tour-start', tourId: t.id });
    const del = document.createElement('button');
    del.className = 'mini-btn ghost'; del.textContent = '✕';
    del.onclick = () => state.net?.send({ t: 'tour-delete', tourId: t.id });
    row.append(start, del);
    box.appendChild(row);
  }
}

const METHOD_LABEL = { card: 'Карта', sbp: 'СБП', wallet: 'Кошелёк' };
function renderPayouts(claims) {
  const box = $('payouts-table');
  if (!box) return;
  box.innerHTML = '';
  $('payouts-empty').classList.toggle('hidden', claims.length > 0);
  for (const c of claims) {
    const row = document.createElement('div');
    row.className = 'payout-row';
    const un = c.username ? '@' + c.username : (c.first_name || ('id' + c.userId));
    const reqHtml = c.status === 'submitted' && c.requisites
      ? `<div class="payout-req">${METHOD_LABEL[c.method] || ''}: ${escapeHtml(c.requisites)}</div>`
      : `<div class="payout-awaiting">Ожидает реквизиты от игрока…</div>`;
    row.innerHTML =
      `<div class="payout-top">
         <span class="payout-place">${c.place}</span>
         <span class="payout-tour">${escapeHtml(c.tourName)}</span>
         <span class="payout-amt">${money(c.amount)}</span>
       </div>
       <div class="payout-user">${escapeHtml(un)}</div>
       ${reqHtml}`;
    const paid = document.createElement('button');
    paid.className = 'mini-btn';
    paid.textContent = 'Выплачено';
    paid.disabled = c.status !== 'submitted';
    paid.onclick = () => state.net?.send({ t: 'payout-paid', claimId: c.id });
    row.appendChild(paid);
    box.appendChild(row);
  }
}

// ================= prize claim modal =================
function openClaimModal(p) {
  state.activeClaim = { tourId: p.tourId, place: p.place, amount: p.amount, status: p.status };
  $('claim-title').textContent = 'Поздравляем!';
  $('claim-sub').textContent = `Вы заняли ${p.place} место и выиграли приз!`;
  $('claim-amount').textContent = money(p.amount);
  if (p.status === 'submitted' || p.status === 'paid') showClaimSent();
  else {
    $('claim-form').classList.remove('hidden');
    $('claim-sent').classList.add('hidden');
  }
  $('claim-modal').classList.remove('hidden');
  haptic('success');
}
function showClaimSent() {
  $('claim-form').classList.add('hidden');
  $('claim-sent').classList.remove('hidden');
}
function closeClaim() { $('claim-modal').classList.add('hidden'); }

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
$('btn-back-game').addEventListener('click', () => { leaveOnline(); showScreen('menu'); });

// online
$('btn-online').addEventListener('click', openOnlineSearch);
$('online-cancel').addEventListener('click', () => { onlineModal(false); leaveOnline(); });
$('invite-friend').addEventListener('click', inviteFriend);
$('invite-copy').addEventListener('click', () => {
  navigator.clipboard?.writeText($('invite-link').value);
  haptic('light');
});
$('invite-share').addEventListener('click', () => {
  const link = $('invite-link').value;
  if (inTelegram) {
    tg.openTelegramLink('https://t.me/share/url?url=' + encodeURIComponent(link) +
      '&text=' + encodeURIComponent('Погнали в шахматы!'));
  } else if (navigator.share) {
    navigator.share({ url: link });
  } else {
    navigator.clipboard?.writeText(link);
  }
});
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
$('overlay-menu').addEventListener('click', () => {
  const wasTour = !!state.tourMatch;
  leaveOnline();
  showScreen(wasTour ? 'tournaments' : 'menu');
  if (wasTour) openTournaments();
});

// tournaments
$('btn-tournaments').addEventListener('click', openTournaments);
$('btn-back-tours').addEventListener('click', () => showScreen('menu'));
$('btn-back-detail').addEventListener('click', () => openTournaments());
$('btn-admin').addEventListener('click', openAdmin);
$('btn-back-admin').addEventListener('click', () => openTournaments());
document.querySelectorAll('#adm-seats button').forEach((b) => {
  b.addEventListener('click', () => {
    state.adminSeats = +b.dataset.seats;
    document.querySelectorAll('#adm-seats button').forEach((x) => x.classList.toggle('active', x === b));
    haptic('light');
  });
});
$('adm-create').addEventListener('click', async () => {
  const net = await netAuthed();
  if (!net) return toast('Нет соединения');
  net.send({
    t: 'tour-create',
    name: $('adm-name').value.trim() || 'Турнир',
    seats: state.adminSeats,
    prize: Number($('adm-prize').value) || 0,
  });
  $('adm-name').value = ''; $('adm-prize').value = '';
});

// claim modal
document.querySelectorAll('#claim-methods button').forEach((b) => {
  b.addEventListener('click', () => {
    state.claimMethod = b.dataset.method;
    document.querySelectorAll('#claim-methods button').forEach((x) => x.classList.toggle('active', x === b));
  });
});
$('claim-submit').addEventListener('click', async () => {
  const req = $('claim-req').value.trim();
  if (!req) { haptic('error'); return toast('Введите реквизиты'); }
  const net = await netAuthed();
  if (!net || !state.activeClaim) return;
  net.send({ t: 'claim-submit', tourId: state.activeClaim.tourId, method: state.claimMethod, requisites: req });
});
$('claim-close').addEventListener('click', closeClaim);
$('claim-sent-close').addEventListener('click', closeClaim);

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

// deep-link join: Telegram start_param (?startapp=ROOM) or ?room=ROOM for browser tests
const startParam = tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get('room');
if (startParam) joinRoom(startParam);
else { showScreen('menu'); netAuthed().catch(() => {}); }
