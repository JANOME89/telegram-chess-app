// Ultimate Chess — dependency-free WebSocket server (Node >= 18).
// Implements minimal RFC6455 framing so no npm install is required:
//   node index.js                 (PORT env optional, default 8787)
//
// Env:
//   PORT            listen port (default 8787)
//   TG_BOT_TOKEN    bot token from @BotFather — enables real initData validation.
//                   When UNSET the server runs in DEV mode and trusts client-declared
//                   identity (browser testing only — NEVER in production).
//   ADMIN_ID        Telegram user id allowed to use the admin panel (server-enforced).
//   DATA_FILE       persistence path (default ./tournaments.json next to this file)
//
// Protocol (JSON), see onMessage() for the authoritative list.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 8787;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const DEV_MODE = !BOT_TOKEN;
// ⬇️ OWNER: put your Telegram user id here (find it via @userinfobot). Server-enforced.
// The ADMIN_ID env var overrides this constant if present.
const ADMIN_ID_CONST = 0; // e.g. 123456789
const ADMIN_ID = Number(process.env.ADMIN_ID || ADMIN_ID_CONST || 0);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'tournaments.json');
const AUTH_MAX_AGE = 24 * 3600; // seconds

// Pick a writable persistence path. On machines where the app directory is
// protected (e.g. Windows "Controlled Folder Access" on Documents), fall back
// to the OS temp dir so state still survives restarts instead of silently failing.
function resolveDataFile() {
  try { fs.writeFileSync(DATA_FILE, fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE) : ''); return DATA_FILE; }
  catch (_) {
    const alt = path.join(os.tmpdir(), 'ultimate-chess-tournaments.json');
    console.warn(`[chess-ws] ${DATA_FILE} is not writable (folder protection?); persisting to ${alt}`);
    return alt;
  }
}
const dataFile = resolveDataFile();

// ---------- connection registries ----------
const rooms = new Map();     // roomId -> Set<sock>          (plain online + tournament matches)
const roomMeta = new Map();  // roomId -> { tourId, matchRef } (only tournament matches)
const queue = new Set();     // sockets waiting for casual matchmaking
const userSockets = new Map(); // userId -> Set<sock>

// ---------- tournament / payout store ----------
let tournaments = new Map(); // tourId -> tournament
let payouts = [];            // claim records

function rid(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
}
function roomId() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

let persistWarned = false;
function persist() {
  try {
    fs.writeFileSync(dataFile, JSON.stringify({ tournaments: [...tournaments.values()], payouts }, null, 2));
  } catch (e) { if (!persistWarned) { persistWarned = true; console.error('[persist] disabled:', e.message); } }
}
function load() {
  try {
    if (!fs.existsSync(dataFile)) return;
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    tournaments = new Map((data.tournaments || []).map((t) => [t.id, t]));
    payouts = data.payouts || [];
    console.log(`[chess-ws] loaded ${tournaments.size} tournaments, ${payouts.length} payouts`);
  } catch (e) { console.error('[load]', e.message); }
}

// ================= Telegram initData validation =================
function validateInitData(initData) {
  if (!initData || typeof initData !== 'string') return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  const pairs = [];
  for (const [k, v] of params.entries()) if (k !== 'hash') pairs.push([k, v]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { user = null; }
  if (!user || !user.id) return null;

  const authDate = Number(params.get('auth_date') || 0);
  if (authDate && (Date.now() / 1000 - authDate) > AUTH_MAX_AGE) return null;

  return { id: Number(user.id), username: user.username || '', first_name: user.first_name || '' };
}

// ================= socket helpers =================
function sendText(sock, str) {
  if (!sock.wsOpen) return;
  const payload = Buffer.from(str, 'utf8');
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  try { sock.write(Buffer.concat([header, payload])); } catch (_) {}
}
function send(sock, obj) { if (sock) sendText(sock, JSON.stringify(obj)); }
function sendClose(sock) { try { sock.write(Buffer.from([0x88, 0x00])); } catch (_) {} }

function parseFrames(sock) {
  let buf = sock.rx;
  while (buf.length >= 2) {
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    let mask = null;
    if (masked) { if (buf.length < off + 4) return; mask = buf.subarray(off, off + 4); off += 4; }
    if (buf.length < off + len) return;
    const payload = Buffer.from(buf.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    buf = buf.subarray(off + len);
    handleFrame(sock, opcode, payload);
  }
  sock.rx = buf;
}

function handleFrame(sock, opcode, payload) {
  if (opcode === 0x8) { sendClose(sock); sock.wsOpen = false; sock.end(); return; }
  if (opcode === 0x9) { try { sock.write(Buffer.from([0x8a, 0x00])); } catch (_) {} return; }
  if (opcode !== 0x1 && opcode !== 0x2) return;
  let msg;
  try { msg = JSON.parse(payload.toString('utf8')); } catch { return; }
  try { onMessage(sock, msg); } catch (e) { console.error('[onMessage]', e); }
}

function registerUser(sock, user) {
  sock.user = user;
  let set = userSockets.get(user.id);
  if (!set) { set = new Set(); userSockets.set(user.id, set); }
  set.add(sock);
}
function unregisterUser(sock) {
  if (!sock.user) return;
  const set = userSockets.get(sock.user.id);
  if (set) { set.delete(sock); if (set.size === 0) userSockets.delete(sock.user.id); }
}
function socketsOf(userId) { return [...(userSockets.get(userId) || [])].filter((s) => s.wsOpen); }
function sendToUser(userId, obj) { socketsOf(userId).forEach((s) => send(s, obj)); }
function isAdmin(sock) { return !!sock.user && ADMIN_ID !== 0 && sock.user.id === ADMIN_ID; }

// ---------- room helpers ----------
function roomOf(sock) { for (const [id, p] of rooms) if (p.has(sock)) return id; return null; }
function peerIn(sock, id) { for (const o of rooms.get(id) || []) if (o !== sock) return o; return null; }
function leaveRooms(sock) {
  for (const [id, players] of rooms) {
    if (players.has(sock)) { players.delete(sock); if (players.size === 0) { rooms.delete(id); roomMeta.delete(id); } }
  }
  queue.delete(sock);
}

// ================= bracket engine =================
const SEATS = [4, 8, 16, 32];
const PRIZE_SHARES = [0.5, 0.3, 0.2];

function sanitizeTour(t) {
  return {
    id: t.id, name: t.name, seats: t.seats, prize: t.prize, status: t.status,
    players: t.players.map((p) => ({ id: p.id, username: p.username, first_name: p.first_name })),
    rounds: t.rounds.map((round) => round.map(sanitizeMatch)),
    thirdPlace: t.thirdPlace ? sanitizeMatch(t.thirdPlace) : null,
    top3: t.top3 || null,
    createdAt: t.createdAt,
  };
}
function sanitizeMatch(m) {
  if (!m) return null;
  return {
    id: m.id, round: m.round, index: m.index, kind: m.kind,
    a: sanitizeSlot(m.a), b: sanitizeSlot(m.b),
    winner: m.winner || null, started: !!m.started, result: m.result || null,
  };
}
function sanitizeSlot(s) {
  if (!s) return null;
  if (s.bye) return { bye: true };
  return { id: s.id, username: s.username, first_name: s.first_name };
}
function publicTours() {
  return [...tournaments.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((t) => ({
      id: t.id, name: t.name, seats: t.seats, prize: t.prize, status: t.status,
      count: t.players.length, createdAt: t.createdAt, top3: t.top3 || null,
    }));
}

function makeMatch(round, index, kind) {
  return { id: rid('m'), round, index, kind, a: null, b: null, winner: null, loser: null, started: false, result: null, roomId: null };
}

function buildBracket(t) {
  const n = t.seats;
  const roundCount = Math.log2(n);
  const slots = t.players.slice();
  while (slots.length < n) slots.push({ bye: true });

  t.rounds = [];
  for (let r = 0; r < roundCount; r++) {
    const matchCount = n / Math.pow(2, r + 1);
    const round = [];
    for (let i = 0; i < matchCount; i++) round.push(makeMatch(r, i, r === roundCount - 1 ? 'final' : 'round'));
    t.rounds.push(round);
  }
  // seed first round
  const first = t.rounds[0];
  for (let i = 0; i < first.length; i++) { first[i].a = slots[i * 2] || { bye: true }; first[i].b = slots[i * 2 + 1] || { bye: true }; }
  // third-place match (only meaningful for >= 4 seats)
  t.thirdPlace = n >= 4 ? makeMatch(roundCount, 0, 'third') : null;
}

// Feed a winner from round r, index i into its parent match.
function parentSlot(t, round, index) {
  if (round >= t.rounds.length - 1) return null; // final has no parent in rounds
  const pMatch = t.rounds[round + 1][Math.floor(index / 2)];
  return { match: pMatch, slot: index % 2 === 0 ? 'a' : 'b' };
}

function startTournament(t) {
  t.status = 'active';
  buildBracket(t);
  // Kick off every first-round match.
  for (const m of t.rounds[0]) tryStartMatch(t, m);
  persist();
  broadcastTourUpdate(t);
}

// A match can begin once both slots are decided.
function tryStartMatch(t, m) {
  if (!m || m.started || m.result) return;
  if (!m.a || !m.b) return;

  const aBye = !!m.a.bye, bBye = !!m.b.bye;
  if (aBye && bBye) { // propagate a bye upward
    m.started = true; m.result = 'bye';
    advanceWinner(t, m, { bye: true }, null);
    return;
  }
  if (aBye || bBye) { // walkover
    const winner = aBye ? m.b : m.a;
    const loser = aBye ? m.a : m.b;
    m.started = true; m.result = 'walkover'; m.winner = winner.id; m.loser = loser.id || null;
    advanceWinner(t, m, winner, loser);
    return;
  }
  // two real players -> create a game room
  m.started = true;
  const room = roomId();
  m.roomId = room;
  rooms.set(room, new Set());
  roomMeta.set(room, { tourId: t.id, matchRef: refOf(t, m) });
  const colors = Math.random() < 0.5 ? { a: 'w', b: 'b' } : { a: 'b', b: 'w' };
  attachAndNotify(t, m, room, m.a, colors.a, m.b);
  attachAndNotify(t, m, room, m.b, colors.b, m.a);
}

function refOf(t, m) {
  if (m.kind === 'third') return { kind: 'third' };
  return { kind: 'round', round: m.round, index: m.index };
}
function matchByRef(t, ref) {
  if (!ref) return null;
  if (ref.kind === 'third') return t.thirdPlace;
  return t.rounds[ref.round]?.[ref.index] || null;
}

function attachAndNotify(t, m, room, self, color, opp) {
  const socks = socketsOf(self.id);
  const primary = socks[0];
  if (primary) rooms.get(room).add(primary);
  sendToUser(self.id, {
    t: 'match-start',
    tourId: t.id, tourName: t.name, matchId: m.id, matchKind: m.kind,
    round: m.round + 1, room, color,
    opponent: { id: opp.id, username: opp.username, first_name: opp.first_name },
  });
}

function advanceWinner(t, m, winnerSlot, loserSlot) {
  // third-place match resolution
  if (m.kind === 'third') { maybeFinish(t); return; }

  if (m.kind === 'final') {
    t.finalWinner = winnerSlot && winnerSlot.id ? winnerSlot.id : null;
    t.finalLoser = loserSlot && loserSlot.id ? loserSlot.id : null;
    maybeFinish(t);
    return;
  }

  // normal round: feed winner up, feed semifinal losers into third-place
  const parent = parentSlot(t, m.round, m.index);
  if (parent) { parent.match[parent.slot] = winnerSlot && winnerSlot.bye ? { bye: true } : winnerSlot; tryStartMatch(t, parent.match); }

  const semiRound = t.rounds.length - 2;
  if (m.round === semiRound && t.thirdPlace && loserSlot && loserSlot.id) {
    if (!t.thirdPlace.a) t.thirdPlace.a = loserSlot;
    else if (!t.thirdPlace.b) t.thirdPlace.b = loserSlot;
    tryStartMatch(t, t.thirdPlace);
  }
}

function maybeFinish(t) {
  const final = t.rounds[t.rounds.length - 1][0];
  if (!final.result) return;
  if (t.status === 'finished') return;

  if (t.thirdPlace && !t.thirdPlace.result) {
    const slots = [t.thirdPlace.a, t.thirdPlace.b];
    const real = slots.filter((s) => s && s.id);
    if (real.length >= 2) {
      // contestable: (re)ensure it started, then wait for its result
      tryStartMatch(t, t.thirdPlace);
      return;
    } else if (real.length === 1) {
      // opponent had a walkover/bye — award 3rd place to the available loser
      t.thirdPlace.result = 'walkover';
      t.thirdPlace.winner = real[0].id;
    } else {
      t.thirdPlace.result = 'none'; // no real semifinal losers
    }
  }

  const top3 = {};
  top3[1] = final.winner;
  top3[2] = final.loser;
  if (t.thirdPlace && t.thirdPlace.result && t.thirdPlace.result !== 'none') top3[3] = t.thirdPlace.winner;

  t.status = 'finished';
  t.top3 = {
    1: playerBrief(t, top3[1]),
    2: playerBrief(t, top3[2]),
    3: top3[3] ? playerBrief(t, top3[3]) : null,
  };
  finishPayouts(t);
  persist();
  broadcastTourUpdate(t);
  notifyTop3(t);
}

function playerBrief(t, id) {
  if (!id) return null;
  const p = t.players.find((x) => x.id === id);
  return p ? { id: p.id, username: p.username, first_name: p.first_name } : { id };
}

function finishPayouts(t) {
  const order = [1, 2, 3];
  for (const place of order) {
    const brief = t.top3[place];
    if (!brief || !brief.id) continue;
    const amount = Math.round(t.prize * (PRIZE_SHARES[place - 1] || 0));
    const exists = payouts.some((c) => c.tourId === t.id && c.userId === brief.id && c.place === place);
    if (exists) continue;
    payouts.push({
      id: rid('c'), tourId: t.id, tourName: t.name, place, amount,
      userId: brief.id, username: brief.username || '', first_name: brief.first_name || '',
      status: 'awaiting', // awaiting -> submitted -> paid
      method: null, requisites: null, submittedAt: null,
    });
  }
}

function claimFor(tourId, userId) {
  return payouts.find((c) => c.tourId === tourId && c.userId === userId && c.status !== 'paid');
}

function notifyTop3(t) {
  for (const place of [1, 2, 3]) {
    const brief = t.top3[place];
    if (!brief || !brief.id) continue;
    const claim = claimFor(t.id, brief.id);
    sendToUser(brief.id, {
      t: 'prize-claim',
      tourId: t.id, tourName: t.name, place,
      amount: claim ? claim.amount : Math.round(t.prize * (PRIZE_SHARES[place - 1] || 0)),
      status: claim ? claim.status : 'awaiting',
    });
  }
}

function broadcastTourUpdate(t) {
  const list = { t: 'tours-list', tours: publicTours() };
  for (const set of userSockets.values()) for (const s of set) if (s.wsOpen && s.toursSubscribed) send(s, list);
}

// ================= message router =================
function onMessage(sock, msg) {
  switch (msg.t) {
    // ---- auth ----
    case 'auth': {
      let user = null;
      if (!DEV_MODE) {
        user = validateInitData(msg.initData);
        if (!user) { send(sock, { t: 'error', msg: 'Ошибка авторизации Telegram' }); return; }
      } else {
        const dev = msg.dev || {};
        if (!dev.id) { send(sock, { t: 'error', msg: 'DEV: укажите id' }); return; }
        user = { id: Number(dev.id), username: dev.username || '', first_name: dev.first_name || ('Player ' + dev.id) };
      }
      registerUser(sock, user);
      send(sock, { t: 'auth-ok', user, admin: isAdmin(sock), dev: DEV_MODE, adminId: ADMIN_ID || null });
      return;
    }

    // ---- tournaments (any authed user) ----
    case 'tours': {
      if (!sock.user) return;
      sock.toursSubscribed = true;
      send(sock, { t: 'tours-list', tours: publicTours() });
      return;
    }
    case 'tour-detail': {
      const t = tournaments.get(msg.tourId);
      if (!t) { send(sock, { t: 'error', msg: 'Турнир не найден' }); return; }
      const myClaim = sock.user ? claimFor(t.id, sock.user.id) : null;
      send(sock, {
        t: 'tour-detail', tour: sanitizeTour(t),
        myClaim: myClaim ? { place: myClaim.place, amount: myClaim.amount, status: myClaim.status } : null,
      });
      return;
    }
    case 'tour-join': {
      if (!sock.user) return;
      const t = tournaments.get(msg.tourId);
      if (!t) { send(sock, { t: 'error', msg: 'Турнир не найден' }); return; }
      if (t.status !== 'registration') { send(sock, { t: 'error', msg: 'Регистрация закрыта' }); return; }
      if (t.players.some((p) => p.id === sock.user.id)) { send(sock, { t: 'error', msg: 'Вы уже зарегистрированы' }); return; }
      if (t.players.length >= t.seats) { send(sock, { t: 'error', msg: 'Мест больше нет' }); return; }
      t.players.push({ id: sock.user.id, username: sock.user.username, first_name: sock.user.first_name });
      persist();
      send(sock, { t: 'tour-joined', tourId: t.id, count: t.players.length });
      broadcastTourUpdate(t);
      return;
    }
    case 'tour-leave': {
      if (!sock.user) return;
      const t = tournaments.get(msg.tourId);
      if (!t || t.status !== 'registration') return;
      t.players = t.players.filter((p) => p.id !== sock.user.id);
      persist(); broadcastTourUpdate(t);
      return;
    }

    // ---- claim (top-3 submits requisites) ----
    case 'claim-submit': {
      if (!sock.user) return;
      const claim = claimFor(msg.tourId, sock.user.id);
      if (!claim) { send(sock, { t: 'error', msg: 'Заявка не найдена' }); return; }
      if (claim.status === 'paid') return;
      const method = ['card', 'sbp', 'wallet'].includes(msg.method) ? msg.method : 'card';
      const req = String(msg.requisites || '').trim().slice(0, 200);
      if (!req) { send(sock, { t: 'error', msg: 'Введите реквизиты' }); return; }
      claim.method = method; claim.requisites = req; claim.status = 'submitted'; claim.submittedAt = Date.now();
      persist();
      send(sock, { t: 'claim-ok', tourId: claim.tourId, place: claim.place, status: 'submitted' });
      notifyAdminsPayouts();
      return;
    }

    // ---- match result ----
    case 'tour-result': {
      const room = roomOf(sock);
      if (!room) return;
      const meta = roomMeta.get(room);
      if (!meta) return;
      const t = tournaments.get(meta.tourId);
      if (!t) return;
      const m = matchByRef(t, meta.matchRef);
      if (!m || m.result === 'win') return;
      // Only accept a result from a participant of this match.
      const uid = sock.user?.id;
      const inMatch = (m.a && m.a.id === uid) || (m.b && m.b.id === uid);
      if (!inMatch) return;

      const winnerId = msg.winner === 'draw' ? 'draw' : Number(msg.winner);
      if (winnerId !== 'draw') {
        const valid = (m.a && m.a.id === winnerId) || (m.b && m.b.id === winnerId);
        if (!valid) return;
      }
      // clean room
      rooms.delete(room); roomMeta.delete(room);
      m.roomId = null;

      if (winnerId === 'draw') {
        // rematch: new room, same players, swap colors
        m.started = true;
        const newRoom = roomId();
        m.roomId = newRoom; rooms.set(newRoom, new Set());
        roomMeta.set(newRoom, { tourId: t.id, matchRef: meta.matchRef });
        attachAndNotify(t, m, newRoom, m.a, 'b', m.b);
        attachAndNotify(t, m, newRoom, m.b, 'w', m.a);
        return;
      }

      const winSlot = m.a && m.a.id === winnerId ? m.a : m.b;
      const loseSlot = winSlot === m.a ? m.b : m.a;
      m.result = 'win'; m.winner = winnerId; m.loser = loseSlot ? loseSlot.id : null;
      advanceWinner(t, m, winSlot, loseSlot);
      persist();
      broadcastTourUpdate(t);
      return;
    }

    // ---- admin ----
    case 'tour-create': {
      if (!isAdmin(sock)) { send(sock, { t: 'error', msg: 'Нет прав' }); return; }
      const seats = SEATS.includes(Number(msg.seats)) ? Number(msg.seats) : 4;
      const prize = Math.max(0, Math.round(Number(msg.prize) || 0));
      const name = String(msg.name || '').trim().slice(0, 60) || 'Турнир';
      const t = {
        id: rid('t'), name, seats, prize, status: 'registration',
        players: [], rounds: [], thirdPlace: null, top3: null, createdAt: Date.now(),
      };
      tournaments.set(t.id, t);
      persist();
      send(sock, { t: 'tour-created', tour: sanitizeTour(t) });
      broadcastTourUpdate(t);
      return;
    }
    case 'tour-start': {
      if (!isAdmin(sock)) { send(sock, { t: 'error', msg: 'Нет прав' }); return; }
      const t = tournaments.get(msg.tourId);
      if (!t) { send(sock, { t: 'error', msg: 'Турнир не найден' }); return; }
      if (t.status !== 'registration') { send(sock, { t: 'error', msg: 'Уже запущен' }); return; }
      if (t.players.length < 2) { send(sock, { t: 'error', msg: 'Нужно минимум 2 игрока' }); return; }
      startTournament(t);
      send(sock, { t: 'tour-started', tourId: t.id });
      return;
    }
    case 'tour-delete': {
      if (!isAdmin(sock)) return;
      const t = tournaments.get(msg.tourId);
      if (!t) return;
      tournaments.delete(msg.tourId);
      persist(); broadcastTourUpdate(t);
      send(sock, { t: 'tours-list', tours: publicTours() });
      return;
    }
    case 'payouts-list': {
      if (!isAdmin(sock)) { send(sock, { t: 'error', msg: 'Нет прав' }); return; }
      sock.payoutsSubscribed = true;
      send(sock, { t: 'payouts-list', claims: payoutsView() });
      return;
    }
    case 'payout-paid': {
      if (!isAdmin(sock)) { send(sock, { t: 'error', msg: 'Нет прав' }); return; }
      const claim = payouts.find((c) => c.id === msg.claimId);
      if (!claim) return;
      claim.status = 'paid';
      claim.requisites = null; // PII purge after payout
      claim.method = null;
      claim.paidAt = Date.now();
      persist();
      send(sock, { t: 'payouts-list', claims: payoutsView() });
      sendToUser(claim.userId, { t: 'claim-paid', tourId: claim.tourId, place: claim.place });
      return;
    }

    // ---- casual online (existing) ----
    case 'queue': {
      leaveRooms(sock);
      let partner = null;
      for (const other of queue) if (other !== sock && other.wsOpen) { partner = other; break; }
      if (partner) {
        queue.delete(partner);
        const id = roomId();
        rooms.set(id, new Set([partner, sock]));
        const colors = Math.random() < 0.5 ? ['w', 'b'] : ['b', 'w'];
        send(partner, { t: 'start', room: id, color: colors[0] });
        send(sock, { t: 'start', room: id, color: colors[1] });
      } else { queue.add(sock); send(sock, { t: 'queued' }); }
      return;
    }
    case 'create': {
      leaveRooms(sock);
      const id = roomId();
      rooms.set(id, new Set([sock]));
      send(sock, { t: 'created', room: id });
      return;
    }
    case 'join': {
      const id = String(msg.room || '').toUpperCase();
      const players = rooms.get(id);
      if (!players) { send(sock, { t: 'error', msg: 'Комната не найдена' }); return; }
      if (roomMeta.has(id)) { send(sock, { t: 'error', msg: 'Это турнирный матч' }); return; }
      if (players.size >= 2) { send(sock, { t: 'error', msg: 'Комната занята' }); return; }
      leaveRooms(sock);
      players.add(sock);
      const [host] = players;
      send(host, { t: 'start', room: id, color: 'w' });
      send(sock, { t: 'start', room: id, color: 'b' });
      return;
    }
    case 'move': case 'resign': {
      const id = roomOf(sock);
      if (!id) return;
      const peer = peerIn(sock, id);
      if (peer) send(peer, msg.t === 'move' ? { t: 'move', move: msg.move } : { t: 'resign' });
      return;
    }
    default: return;
  }
}

function payoutsView() {
  return payouts
    .filter((c) => c.status !== 'paid')
    .map((c) => ({
      id: c.id, tourId: c.tourId, tourName: c.tourName, place: c.place, amount: c.amount,
      userId: c.userId, username: c.username, first_name: c.first_name,
      status: c.status, method: c.method, requisites: c.requisites, submittedAt: c.submittedAt,
    }))
    .sort((a, b) => a.place - b.place || (b.submittedAt || 0) - (a.submittedAt || 0));
}
function notifyAdminsPayouts() {
  if (!ADMIN_ID) return;
  for (const s of socketsOf(ADMIN_ID)) if (s.payoutsSubscribed) send(s, { t: 'payouts-list', claims: payoutsView() });
}

function onDisconnect(sock) {
  unregisterUser(sock);
  queue.delete(sock);
  const id = roomOf(sock);
  if (id) {
    const meta = roomMeta.get(id);
    const players = rooms.get(id);
    if (players) {
      players.delete(sock);
      const peer = [...players][0];
      if (peer && !meta) send(peer, { t: 'opponent-left' });
      // For tournament matches we leave the room open; the present client reports tour-result.
      if (players.size === 0) { rooms.delete(id); roomMeta.delete(id); }
    }
  }
}

// ================= HTTP + upgrade =================
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ultimate-chess-ws' + (DEV_MODE ? ' (dev: initData validation OFF)' : ''));
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.wsOpen = true;
  socket.rx = Buffer.alloc(0);
  socket.user = null;
  socket.toursSubscribed = false;
  socket.payoutsSubscribed = false;
  socket.on('data', (chunk) => { socket.rx = Buffer.concat([socket.rx, chunk]); parseFrames(socket); });
  socket.on('close', () => { socket.wsOpen = false; onDisconnect(socket); });
  socket.on('error', () => { socket.wsOpen = false; onDisconnect(socket); });
});

load();
server.listen(PORT, () => {
  console.log(`[chess-ws] listening on :${PORT}`);
  console.log(`[chess-ws] mode: ${DEV_MODE ? 'DEV (trust client identity — set TG_BOT_TOKEN for prod)' : 'PROD (initData HMAC validation)'}`);
  console.log(`[chess-ws] ADMIN_ID: ${ADMIN_ID || '(not set)'}`);
});
