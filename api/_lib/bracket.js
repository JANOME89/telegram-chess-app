// Single-elimination bracket engine, ported from server/index.js.
// Pure state transitions over a tournament document: everything that touches the
// outside world goes through `ctx` (see handlers.js), so the logic is testable
// without Redis, HTTP or Telegram.
import { rid, newRoomId } from './store.js';

export const SEATS = [3, 4, 8, 16, 32];
export const PRIZE_SHARES = [0.5, 0.3, 0.2];

export function sanitizeTour(t) {
  return {
    id: t.id, name: t.name, seats: t.seats, prize: t.prize, status: t.status,
    players: t.players.map((p) => ({ id: p.id, username: p.username, first_name: p.first_name })),
    rounds: t.rounds.map((round) => round.map(sanitizeMatch)),
    thirdPlace: t.thirdPlace ? sanitizeMatch(t.thirdPlace) : null,
    top3: t.top3 || null,
    createdAt: t.createdAt,
    startsAt: t.startsAt || null,
    startMissed: !!t.startMissed,
  };
}
export function sanitizeMatch(m) {
  if (!m) return null;
  return {
    id: m.id, round: m.round, index: m.index, kind: m.kind,
    a: sanitizeSlot(m.a), b: sanitizeSlot(m.b),
    winner: m.winner || null, started: !!m.started, result: m.result || null,
  };
}
export function sanitizeSlot(s) {
  if (!s) return null;
  if (s.bye) return { bye: true };
  return { id: s.id, username: s.username, first_name: s.first_name };
}
export function tourBrief(t) {
  return {
    id: t.id, name: t.name, seats: t.seats, prize: t.prize, status: t.status,
    count: t.players.length, createdAt: t.createdAt, top3: t.top3 || null,
    startsAt: t.startsAt || null, startMissed: !!t.startMissed,
  };
}

export function makeMatch(round, index, kind) {
  return {
    id: rid('m'), round, index, kind, a: null, b: null,
    winner: null, loser: null, started: false, result: null, roomId: null, colors: null,
  };
}

export function buildBracket(t) {
  // A bracket is always a power of two; seats like 3 are padded with BYEs up to 4.
  // Size is capped by the number of players who actually registered, so a
  // half-empty tournament does not hand out a phantom 3rd place.
  const n = Math.pow(2, Math.ceil(Math.log2(Math.max(2, Math.min(t.seats, t.players.length)))));
  const roundCount = Math.log2(n);
  const slots = t.players.slice(0, n);
  while (slots.length < n) slots.push({ bye: true });

  t.rounds = [];
  for (let r = 0; r < roundCount; r++) {
    const matchCount = n / Math.pow(2, r + 1);
    const round = [];
    for (let i = 0; i < matchCount; i++) round.push(makeMatch(r, i, r === roundCount - 1 ? 'final' : 'round'));
    t.rounds.push(round);
  }
  const first = t.rounds[0];
  for (let i = 0; i < first.length; i++) {
    first[i].a = slots[i * 2] || { bye: true };
    first[i].b = slots[i * 2 + 1] || { bye: true };
  }
  // third-place match (only when the bracket has at least 4 slots)
  t.thirdPlace = n >= 4 ? makeMatch(roundCount, 0, 'third') : null;
}

function parentSlot(t, round, index) {
  if (round >= t.rounds.length - 1) return null; // final has no parent in rounds
  const pMatch = t.rounds[round + 1][Math.floor(index / 2)];
  return { match: pMatch, slot: index % 2 === 0 ? 'a' : 'b' };
}

export function matchesOf(t) {
  return [...t.rounds.flat(), t.thirdPlace].filter(Boolean);
}

export async function startTournament(t, ctx) {
  t.status = 'active';
  buildBracket(t);
  for (const m of t.rounds[0]) await tryStartMatch(t, m, ctx);
  await ctx.saveTour(t);
  await ctx.broadcastTours();
}

// A match can begin once both slots are decided.
export async function tryStartMatch(t, m, ctx) {
  if (!m || m.started || m.result) return;
  if (!m.a || !m.b) return;

  const aBye = !!m.a.bye, bBye = !!m.b.bye;
  if (aBye && bBye) { // propagate a bye upward
    m.started = true; m.result = 'bye';
    await advanceWinner(t, m, { bye: true }, null, ctx);
    return;
  }
  if (aBye || bBye) { // walkover
    const winner = aBye ? m.b : m.a;
    const loser = aBye ? m.a : m.b;
    m.started = true; m.result = 'walkover'; m.winner = winner.id; m.loser = loser.id || null;
    await advanceWinner(t, m, winner, loser, ctx);
    return;
  }

  // two real players -> create a game room
  m.started = true;
  const room = newRoomId();
  m.roomId = room;
  // colours are stored on the match so an offline player can be re-invited later
  m.colors = Math.random() < 0.5 ? { a: 'w', b: 'b' } : { a: 'b', b: 'w' };
  await ctx.createRoom({
    id: room, kind: 'tour', tourId: t.id, matchId: m.id,
    a: { id: m.a.id, username: m.a.username, color: m.colors.a },
    b: { id: m.b.id, username: m.b.username, color: m.colors.b },
    moves: [], createdAt: Date.now(),
  });
  notifyMatchStart(t, m, m.a, m.colors.a, m.b, ctx);
  notifyMatchStart(t, m, m.b, m.colors.b, m.a, ctx);
}

function notifyMatchStart(t, m, self, color, opp, ctx) {
  ctx.notify(self.id, {
    t: 'match-start',
    tourId: t.id, tourName: t.name, matchId: m.id, matchKind: m.kind,
    round: m.round + 1, room: m.roomId, color,
    opponent: { id: opp.id, username: opp.username, first_name: opp.first_name },
  });
  ctx.markPresent(m.roomId, self.id);
}

export async function advanceWinner(t, m, winnerSlot, loserSlot, ctx) {
  if (m.kind === 'third') { await maybeFinish(t, ctx); return; }

  if (m.kind === 'final') {
    t.finalWinner = winnerSlot && winnerSlot.id ? winnerSlot.id : null;
    t.finalLoser = loserSlot && loserSlot.id ? loserSlot.id : null;
    await maybeFinish(t, ctx);
    return;
  }

  const parent = parentSlot(t, m.round, m.index);
  if (parent) {
    parent.match[parent.slot] = winnerSlot && winnerSlot.bye ? { bye: true } : winnerSlot;
    await tryStartMatch(t, parent.match, ctx);
  }

  const semiRound = t.rounds.length - 2;
  if (m.round === semiRound && t.thirdPlace && loserSlot && loserSlot.id) {
    if (!t.thirdPlace.a) t.thirdPlace.a = loserSlot;
    else if (!t.thirdPlace.b) t.thirdPlace.b = loserSlot;
    await tryStartMatch(t, t.thirdPlace, ctx);
  }
}

export async function maybeFinish(t, ctx) {
  const final = t.rounds[t.rounds.length - 1][0];
  if (!final.result) return;
  if (t.status === 'finished') return;

  if (t.thirdPlace && !t.thirdPlace.result) {
    const slots = [t.thirdPlace.a, t.thirdPlace.b];
    const real = slots.filter((s) => s && s.id);
    if (real.length >= 2) {
      await tryStartMatch(t, t.thirdPlace, ctx); // contestable: wait for its result
      return;
    } else if (real.length === 1) {
      t.thirdPlace.result = 'walkover';
      t.thirdPlace.winner = real[0].id;
    } else {
      t.thirdPlace.result = 'none';
    }
  }

  const top3 = { 1: final.winner, 2: final.loser };
  if (t.thirdPlace && t.thirdPlace.result && t.thirdPlace.result !== 'none') top3[3] = t.thirdPlace.winner;

  t.status = 'finished';
  t.top3 = {
    1: playerBrief(t, top3[1]),
    2: playerBrief(t, top3[2]),
    3: top3[3] ? playerBrief(t, top3[3]) : null,
  };
  await finishPayouts(t, ctx);
  await ctx.saveTour(t);
  await ctx.broadcastTours();
  await notifyTop3(t, ctx);
}

export function playerBrief(t, id) {
  if (!id) return null;
  const p = t.players.find((x) => x.id === id);
  return p ? { id: p.id, username: p.username, first_name: p.first_name } : { id };
}

export function prizeFor(t, place) {
  return Math.round(t.prize * (PRIZE_SHARES[place - 1] || 0));
}

async function finishPayouts(t, ctx) {
  const existing = await ctx.claimsForTour(t.id);
  for (const place of [1, 2, 3]) {
    const brief = t.top3[place];
    if (!brief || !brief.id) continue;
    if (existing.some((c) => c.userId === brief.id && c.place === place)) continue;
    await ctx.addClaim({
      id: rid('c'), tourId: t.id, tourName: t.name, place, amount: prizeFor(t, place),
      userId: brief.id, username: brief.username || '', first_name: brief.first_name || '',
      status: 'awaiting', // awaiting -> submitted -> paid
      method: null, requisites: null, submittedAt: null,
    });
    existing.push({ userId: brief.id, place });
  }
}

export async function notifyTop3(t, ctx) {
  const claims = await ctx.claimsForTour(t.id);
  for (const place of [1, 2, 3]) {
    const brief = t.top3[place];
    if (!brief || !brief.id) continue;
    const claim = claims.find((c) => c.userId === brief.id && c.place === place && c.status !== 'paid');
    ctx.notify(brief.id, {
      t: 'prize-claim',
      tourId: t.id, tourName: t.name, place,
      amount: claim ? claim.amount : prizeFor(t, place),
      status: claim ? claim.status : 'awaiting',
    });
  }
}

// Scheduled start time. Accepts epoch ms, epoch seconds or a datetime string
// ("2026-09-25T18:30" is read as the client/server local time). Null if unusable.
export function parseStartsAt(v) {
  if (v === undefined || v === null || v === '') return null;
  let ms;
  if (typeof v === 'number') ms = v;
  else {
    const s = String(v).trim();
    ms = /^\d+$/.test(s) ? Number(s) : new Date(s).getTime();
  }
  if (!Number.isFinite(ms)) return null;
  if (ms < 1e11) ms *= 1000; // seconds -> ms
  if (ms > Date.now() + 366 * 24 * 3600 * 1000) return null;
  return Math.round(ms);
}
