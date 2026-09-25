// The {t: ...} router. Mirrors the protocol of server/index.js so the browser
// client keeps the same handlers, but every read/write goes through Redis and
// every notification is queued into the recipient's inbox (see realtime.js).
import { CFG, DEV_MODE, isAdminId } from './env.js';
import { validateInitData } from './tg.js';
import { signSession, verifySession } from './session.js';
import { kv } from './kv.js';
import { realtimeInfo } from './realtime.js';
import * as S from './store.js';
import * as B from './bracket.js';

// Collects everything one request wants to tell people, then rpc.js delivers it:
// events for the caller ride back in the HTTP response, the rest go to inboxes.
export class Ctx {
  constructor(meId = null) {
    this.meId = meId;
    this.events = [];   // { to: <uid>, msg }
    this.pending = [];  // fire-and-forget KV writes (presence marks)
    this._tours = null;
  }

  notify(uid, msg) { if (uid) this.events.push({ to: Number(uid), msg }); }
  notifyAdmins(msg) { if (CFG.adminId) this.notify(CFG.adminId, msg); }
  // `to: null` means "whoever made this call" — it is answered in the HTTP
  // response even when the caller has no session yet (a failed auth).
  error(text) { this.events.push({ to: this.meId || null, msg: { t: 'error', msg: text } }); }

  async broadcastTours() {
    const tours = await this.publicTours();
    for (const uid of await S.subscribers()) this.notify(uid, { t: 'tours-list', tours });
  }

  async allTours() {
    if (!this._tours) this._tours = await S.loadAllTours();
    return this._tours;
  }
  async publicTours() {
    const list = await this.allTours();
    return list.slice().sort((a, b) => b.createdAt - a.createdAt).map(B.tourBrief);
  }

  // --- engine callbacks ---
  // Writes invalidate the per-request tour cache so a following broadcast is fresh.
  saveTour(t) { this._tours = null; return S.saveTour(t); }
  createRoom(doc) { return S.saveRoom(doc); }
  deleteRoom(id) { return S.deleteRoom(id); }
  deleteTour(id) { this._tours = null; return S.deleteTour(id); }
  // presence is best-effort: a lost mark only delays an "opponent left" notice
  markPresent(room, uid) { this.pending.push(S.markSeen(room, uid)); }
  async claimsForTour(tourId) {
    return (await S.allClaims()).filter((c) => c.tourId === tourId);
  }
  addClaim(c) { return S.saveClaim(c); }
}

// ================= auth =================
// Accepts (in order): a still-valid session token, signed Telegram initData, or —
// only in DEV mode — a client-declared identity for browser testing.
export async function handleAuth(ctx, msg) {
  let user = null;

  const fromToken = verifySession(msg.token);
  if (fromToken) user = fromToken;

  if (!user && msg.initData) {
    user = validateInitData(msg.initData);
    if (!user && !DEV_MODE) { ctx.error('Ошибка авторизации Telegram'); return null; }
  }
  if (!user && DEV_MODE && msg.dev && msg.dev.id) {
    user = {
      id: Number(msg.dev.id),
      username: msg.dev.username || '',
      first_name: msg.dev.first_name || ('Player ' + msg.dev.id),
    };
  }
  if (!user) {
    ctx.error(DEV_MODE ? 'DEV: укажите id' : 'Ошибка авторизации Telegram');
    return null;
  }

  ctx.meId = user.id;
  const token = signSession(user);
  await resumeMatches(user, ctx);
  ctx.notify(user.id, {
    t: 'auth-ok', token, user,
    admin: isAdminId(user.id), dev: DEV_MODE, adminId: CFG.adminId || null,
    realtime: realtimeInfo(user.id),
  });
  return { user, token };
}

// A scheduled tournament can start while a registered player is offline. Without
// this they would never learn their match began and the bracket would stall.
export async function resumeMatches(user, ctx) {
  for (const id of await S.activeTourIds()) {
    const t = await S.loadTour(id);
    if (!t || t.status !== 'active') continue;
    for (const m of B.matchesOf(t)) {
      if (!m.started || m.result || !m.roomId || !m.colors) continue;
      const side = m.a && m.a.id === user.id ? 'a' : m.b && m.b.id === user.id ? 'b' : null;
      if (!side) continue;
      const room = await S.loadRoom(m.roomId);
      if (!room) continue;
      ctx.notify(user.id, {
        t: 'match-start',
        tourId: t.id, tourName: t.name, matchId: m.id, matchKind: m.kind,
        round: m.round + 1, room: m.roomId, color: m.colors[side],
        opponent: B.sanitizeSlot(side === 'a' ? m.b : m.a),
      });
      await S.markSeen(m.roomId, user.id);
    }
  }
}

// ================= scheduled starts =================
// Serverless has no background timer, so the sweep rides along with every request
// (the client also sends {t:'tick'} while the tournament screen is open).
export async function sweepDue(ctx) {
  for (const id of await S.dueTourIds()) {
    const t = await S.loadTour(id);
    if (!t || t.status !== 'registration' || !t.startsAt || t.startsAt > Date.now()) continue;
    if (t.players.length >= 2) {
      // Two concurrent sweeps must not build the bracket twice.
      if (!(await kv.setNx(`lock:start:${id}`, '1', 15000))) continue;
      await B.startTournament(t, ctx);
    } else if (!t.startMissed) {
      t.startMissed = true;
      await ctx.saveTour(t);
      // Out of the schedule set: a late second joiner starts it from `tour-join`.
      await kv.zrem('sched', t.id);
      await ctx.broadcastTours();
      ctx.notifyAdmins({ t: 'schedule-missed', tourId: t.id, name: t.name, count: t.players.length });
    }
  }
}

// ================= router =================
export async function dispatch(ctx, me, msg) {
  await sweepDue(ctx);
  const t = msg.t;

  switch (t) {
    case 'poll':
    case 'tick':
      return; // the sweep above is the whole point of these calls

    // ---- tournaments ----
    case 'tours': {
      await S.subscribe(me.id);
      ctx.notify(me.id, { t: 'tours-list', tours: await ctx.publicTours() });
      return;
    }
    case 'tour-detail': {
      const tour = await S.loadTour(msg.tourId);
      if (!tour) return ctx.error('Турнир не найден');
      const claims = await ctx.claimsForTour(tour.id);
      const mine = claims.find((c) => c.userId === me.id && c.status !== 'paid');
      ctx.notify(me.id, {
        t: 'tour-detail', tour: B.sanitizeTour(tour),
        myClaim: mine ? { place: mine.place, amount: mine.amount, status: mine.status } : null,
      });
      return;
    }
    case 'tour-join': {
      const tour = await S.loadTour(msg.tourId);
      if (!tour) return ctx.error('Турнир не найден');
      if (tour.status !== 'registration') return ctx.error('Регистрация закрыта');
      if (tour.players.some((p) => p.id === me.id)) return ctx.error('Вы уже зарегистрированы');
      if (tour.players.length >= tour.seats) return ctx.error('Мест больше нет');
      // Two phones can grab the last seat at once: serialize with a short mutex,
      // re-read the document under it, and release as soon as the write is done.
      const lockKey = `lock:join:${tour.id}`;
      if (!(await kv.setNx(lockKey, '1', 8000))) return ctx.error('Секунду, идёт регистрация…');
      try {
        const fresh = await S.loadTour(tour.id);
        if (fresh.status !== 'registration') return ctx.error('Регистрация закрыта');
        if (fresh.players.some((p) => p.id === me.id)) return ctx.error('Вы уже зарегистрированы');
        if (fresh.players.length >= fresh.seats) return ctx.error('Мест больше нет');
        fresh.players.push({ id: me.id, username: me.username, first_name: me.first_name });
        ctx.notify(me.id, { t: 'tour-joined', tourId: fresh.id, count: fresh.players.length });
        // a scheduled tournament whose time has passed starts as soon as a pair exists
        if (fresh.startsAt && fresh.startsAt <= Date.now() && fresh.players.length >= 2) {
          await B.startTournament(fresh, ctx);
          return;
        }
        await ctx.saveTour(fresh);
        await ctx.broadcastTours();
      } finally {
        await kv.del(lockKey);
      }
      return;
    }
    case 'tour-leave': {
      const tour = await S.loadTour(msg.tourId);
      if (!tour || tour.status !== 'registration') return;
      tour.players = tour.players.filter((p) => p.id !== me.id);
      await ctx.saveTour(tour);
      await ctx.broadcastTours();
      return;
    }

    // ---- prize claim (top-3 submits requisites) ----
    // Requisites are written to Redis only. They are never published to a channel
    // and are erased the moment the owner marks the claim as paid.
    case 'claim-submit': {
      const claims = await ctx.claimsForTour(msg.tourId);
      const claim = claims.find((c) => c.userId === me.id && c.status !== 'paid');
      if (!claim) return ctx.error('Заявка не найдена');
      const method = ['card', 'sbp', 'wallet'].includes(msg.method) ? msg.method : 'card';
      const req = String(msg.requisites || '').trim().slice(0, 200);
      if (!req) return ctx.error('Введите реквизиты');
      claim.method = method; claim.requisites = req;
      claim.status = 'submitted'; claim.submittedAt = Date.now();
      await S.saveClaim(claim);
      ctx.notify(me.id, { t: 'claim-ok', tourId: claim.tourId, place: claim.place, status: 'submitted' });
      ctx.notifyAdmins({ t: 'payouts-dirty', tourId: claim.tourId });
      return;
    }

    // ---- match result ----
    case 'tour-result': {
      const tour = msg.tourId ? await S.loadTour(msg.tourId) : await tourByMatch(msg.matchId);
      if (!tour || tour.status !== 'active') return;
      const m = B.matchesOf(tour).find((x) => x.id === msg.matchId);
      if (!m || m.result === 'win') return;
      if (!((m.a && m.a.id === me.id) || (m.b && m.b.id === me.id))) return;

      const winnerId = msg.winner === 'draw' ? 'draw' : Number(msg.winner);
      if (winnerId !== 'draw' && !((m.a && m.a.id === winnerId) || (m.b && m.b.id === winnerId))) return;
      // Both players may report at once. The mutex only serializes them: the
      // durable guard against a duplicate result is `m.result` itself, so the
      // lock is released right away — otherwise a draw would block the rematch.
      const lockKey = `lock:result:${m.id}`;
      if (!(await kv.setNx(lockKey, '1', 20000))) return;
      try {
        await resolveResult(ctx, tour, m, winnerId);
      } finally {
        await kv.del(lockKey);
      }
      return;
    }

    // ---- admin ----
    case 'tour-create': {
      if (!isAdminId(me.id)) return ctx.error('Нет прав');
      const seats = B.SEATS.includes(Number(msg.seats)) ? Number(msg.seats) : 4;
      const prize = Math.max(0, Math.round(Number(msg.prize) || 0));
      const name = String(msg.name || '').trim().slice(0, 60) || 'Турнир';
      const startsAt = B.parseStartsAt(msg.startsAt);
      if (msg.startsAt && startsAt === null) return ctx.error('Неверное время начала');
      const tour = {
        id: S.rid('t'), name, seats, prize, status: 'registration',
        players: [], rounds: [], thirdPlace: null, top3: null,
        createdAt: Date.now(), startsAt, startMissed: false,
      };
      await ctx.saveTour(tour);
      ctx.notify(me.id, { t: 'tour-created', tour: B.sanitizeTour(tour) });
      await ctx.broadcastTours();
      return;
    }
    case 'tour-set-time': {
      if (!isAdminId(me.id)) return ctx.error('Нет прав');
      const tour = await S.loadTour(msg.tourId);
      if (!tour) return ctx.error('Турнир не найден');
      if (tour.status !== 'registration') return ctx.error('Турнир уже идёт');
      if (msg.startsAt === null || msg.startsAt === '') {
        tour.startsAt = null; tour.startMissed = false;
      } else {
        const at = B.parseStartsAt(msg.startsAt);
        if (at === null) return ctx.error('Неверное время начала');
        tour.startsAt = at; tour.startMissed = false;
      }
      await ctx.saveTour(tour);
      ctx.notify(me.id, { t: 'tour-time-set', tourId: tour.id, startsAt: tour.startsAt });
      await ctx.broadcastTours();
      return;
    }
    case 'tour-start': {
      if (!isAdminId(me.id)) return ctx.error('Нет прав');
      const tour = await S.loadTour(msg.tourId);
      if (!tour) return ctx.error('Турнир не найден');
      if (tour.status !== 'registration') return ctx.error('Уже запущен');
      if (tour.players.length < 2) return ctx.error('Нужно минимум 2 игрока');
      if (!(await kv.setNx(`lock:start:${tour.id}`, '1', 15000))) return ctx.error('Уже запущен');
      await B.startTournament(tour, ctx);
      ctx.notify(me.id, { t: 'tour-started', tourId: tour.id });
      return;
    }
    case 'tour-delete': {
      if (!isAdminId(me.id)) return ctx.error('Нет прав');
      const tour = await S.loadTour(msg.tourId);
      if (!tour) return;
      await ctx.deleteTour(tour.id);
      await ctx.broadcastTours();
      return;
    }
    case 'payouts-list': {
      if (!isAdminId(me.id)) return ctx.error('Нет прав');
      ctx.notify(me.id, { t: 'payouts-list', claims: await payoutsView() });
      return;
    }
    case 'payout-paid': {
      if (!isAdminId(me.id)) return ctx.error('Нет прав');
      const claims = await S.allClaims();
      const claim = claims.find((c) => c.id === msg.claimId);
      if (!claim) return;
      // PII purge: the record is archived for the audit trail, the requisites are
      // destroyed the moment the payout is marked as done.
      claim.status = 'paid';
      claim.requisites = null;
      claim.method = null;
      claim.paidAt = Date.now();
      await S.saveClaim(claim);
      ctx.notify(me.id, { t: 'payouts-list', claims: await payoutsView() });
      ctx.notify(claim.userId, { t: 'claim-paid', tourId: claim.tourId, place: claim.place });
      return;
    }

    // ---- casual online ----
    case 'queue': {
      for (let i = 0; i < 5; i++) {
        const entry = await S.queuePop();
        if (!entry) break;
        if (Date.now() - Number(entry.at || 0) >= 120000) continue; // stale, try the next
        if (Number(entry.uid) === me.id) continue;                  // our own leftover entry
        startBoth(ctx, await openCasualRoom(entry, me));
        return;
      }
      await S.queuePush({ uid: me.id, username: me.username, first_name: me.first_name, at: Date.now() });
      ctx.notify(me.id, { t: 'queued' });
      return;
    }
    case 'create': {
      const room = {
        id: S.newRoomId(), kind: 'casual', tourId: null, matchId: null,
        a: { id: me.id, username: me.username, color: 'w' }, b: null,
        moves: [], createdAt: Date.now(),
      };
      await ctx.createRoom(room);
      await S.markSeen(room.id, me.id);
      ctx.notify(me.id, { t: 'created', room: room.id });
      return;
    }
    case 'join': {
      const id = String(msg.room || '').toUpperCase();
      const room = await S.loadRoom(id);
      if (!room) return ctx.error('Комната не найдена');
      if (room.kind === 'tour') return ctx.error('Это турнирный матч');
      if (room.b && room.b.id !== me.id) return ctx.error('Комната занята');
      if (room.a.id === me.id) return startBoth(ctx, room); // host reopened the app
      room.b = { id: me.id, username: me.username, color: 'b' };
      await ctx.createRoom(room);
      startBoth(ctx, room);
      return;
    }
    case 'move': case 'resign': {
      const room = await S.loadRoom(msg.room);
      if (!room) return;
      const mine = sideOf(room, me.id);
      if (!mine) return;
      await S.markSeen(room.id, me.id);
      const peer = room[mine === 'a' ? 'b' : 'a'];
      if (!peer) return;
      if (t === 'move') {
        if (!msg.move || !msg.move.from || !msg.move.to) return;
        room.moves = (room.moves || []).concat([{ n: room.moves?.length || 0, by: me.id, move: msg.move }]);
        await ctx.createRoom(room);
        ctx.notify(peer.id, { t: 'move', move: msg.move, n: room.moves.length - 1 });
      } else {
        ctx.notify(peer.id, { t: 'resign' });
      }
      return;
    }
    case 'ping': {
      const room = await S.loadRoom(msg.room);
      if (!room) return ctx.notify(me.id, { t: 'room-gone', room: msg.room });
      await S.markSeen(room.id, me.id);
      const peer = room[sideOf(room, me.id) === 'a' ? 'b' : 'a'];
      if (!peer || room.leftReported) return;
      // do not declare a disconnect before the opponent ever had a chance to ping
      if (Date.now() - room.createdAt < S.SEEN_STALE_MS) return;
      if (await S.isSeen(room.id, peer.id)) return;
      room.leftReported = true;
      await ctx.createRoom(room);
      ctx.notify(me.id, { t: 'opponent-left' });
      ctx.notify(peer.id, { t: 'opponent-left' });
      return;
    }
    case 'room-state': {
      const room = await S.loadRoom(msg.room);
      if (!room) return ctx.notify(me.id, { t: 'room-gone', room: msg.room });
      if (!sideOf(room, me.id)) return;
      await S.markSeen(room.id, me.id);
      ctx.notify(me.id, {
        t: 'room-state', room: room.id,
        moves: (room.moves || []).map((m) => m.move),
        leftReported: !!room.leftReported,
      });
      return;
    }
    default:
      return;
  }
}

// ================= helpers =================
// Applies a reported result: a draw means "same pair, new room, colours swapped",
// anything else advances the winner up the bracket.
async function resolveResult(ctx, tour, m, winnerId) {
  if (m.roomId) await ctx.deleteRoom(m.roomId);
  m.roomId = null;

  if (winnerId === 'draw') {
    const room = S.newRoomId();
    m.roomId = room;
    const flip = (c) => (c === 'w' ? 'b' : 'w');
    m.colors = { a: flip(m.colors?.a || 'w'), b: flip(m.colors?.b || 'b') };
    await ctx.createRoom({
      id: room, kind: 'tour', tourId: tour.id, matchId: m.id,
      a: { id: m.a.id, username: m.a.username, color: m.colors.a },
      b: { id: m.b.id, username: m.b.username, color: m.colors.b },
      moves: [], createdAt: Date.now(),
    });
    for (const side of ['a', 'b']) {
      const self = m[side], opp = side === 'a' ? m.b : m.a;
      ctx.notify(self.id, {
        t: 'match-start', tourId: tour.id, tourName: tour.name, matchId: m.id,
        matchKind: m.kind, round: m.round + 1, room, color: m.colors[side],
        opponent: { id: opp.id, username: opp.username, first_name: opp.first_name },
      });
      await ctx.markPresent(room, self.id);
    }
    await ctx.saveTour(tour);
    return;
  }

  const winSlot = m.a && m.a.id === winnerId ? m.a : m.b;
  const loseSlot = winSlot === m.a ? m.b : m.a;
  m.result = 'win'; m.winner = winnerId; m.loser = loseSlot ? loseSlot.id : null;
  await B.advanceWinner(tour, m, winSlot, loseSlot, ctx);
  await ctx.saveTour(tour);
  await ctx.broadcastTours();
}

function sideOf(room, uid) {
  if (room.a && room.a.id === uid) return 'a';
  if (room.b && room.b.id === uid) return 'b';
  return null;
}

async function tourByMatch(matchId) {
  if (!matchId) return null;
  for (const id of await S.activeTourIds()) {
    const t = await S.loadTour(id);
    if (t && B.matchesOf(t).some((m) => m.id === matchId)) return t;
  }
  return null;
}

async function openCasualRoom(host, guest) {
  const room = {
    id: S.newRoomId(), kind: 'casual', tourId: null, matchId: null,
    a: { id: Number(host.uid), username: host.username || '', color: 'w' },
    b: { id: guest.id, username: guest.username, color: 'b' },
    moves: [], createdAt: Date.now(),
  };
  await S.saveRoom(room);
  await S.markSeen(room.id, guest.id);
  return room;
}

function startBoth(ctx, room) {
  ctx.notify(room.a.id, { t: 'start', room: room.id, color: room.a.color });
  if (room.b) ctx.notify(room.b.id, { t: 'start', room: room.id, color: room.b.color });
  ctx.markPresent(room.id, room.a.id);
  if (room.b) ctx.markPresent(room.id, room.b.id);
}

async function payoutsView() {
  return (await S.allClaims())
    .filter((c) => c.status !== 'paid')
    .map((c) => ({
      id: c.id, tourId: c.tourId, tourName: c.tourName, place: c.place, amount: c.amount,
      userId: c.userId, username: c.username, first_name: c.first_name,
      status: c.status, method: c.method, requisites: c.requisites, submittedAt: c.submittedAt,
    }))
    .sort((a, b) => a.place - b.place || (b.submittedAt || 0) - (a.submittedAt || 0));
}
