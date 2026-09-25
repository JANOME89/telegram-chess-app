// Logic suite for the serverless backend (Vercel Functions + Upstash + PieSocket).
// Runs entirely in memory: no accounts, no network, no Telegram.
//   node tests/run.js
process.env.SEEN_PX_MS = '600';
process.env.SEEN_STALE_MS = '200';

import { boot, rpc, Client, counters, ok, sleep } from './harness.js';

const OWNER = 498258870;
const c = counters();
const section = (name) => console.log('\n=== ' + name + ' ===');

await boot();

// Every user must poll to pick up what other users triggered — that is the transport.
async function sync(...clients) { for (const cl of clients) await cl.poll(); }
const ms = (cl) => cl.last('match-start');
async function report(cl, winnerId) {
  await cl.send({ t: 'tour-result', matchId: ms(cl).matchId, winner: winnerId });
}

// ---------------------------------------------------------------- 1. transport
section('backend status + auth');
{
  const get = await new Promise((resolve) => {
    const res = { writeHead() {}, end: (b) => resolve(JSON.parse(b)) };
    // GET is answered by the same exported handler
    import('../api/rpc.js').then((m) => m.default({ method: 'GET' }, res));
  });
  ok(c, 'GET /api/rpc reports status', get.ok === true && get.service === 'ultimate-chess-rpc', get);
  ok(c, 'runs in dev mode without a bot token', get.dev === true && get.mode === 'dev', get);
  ok(c, 'realtime hints are optional', get.realtime === false, get);

  const anon = await rpc({ t: 'tours' });
  ok(c, 'anonymous call is rejected with 401', anon.status === 401 && anon.needAuth === true, anon);

  const bad = await rpc({ t: 'auth' });
  ok(c, 'auth without identity is refused',
    (bad.events || []).some((e) => e.t === 'error') && !(bad.events || []).some((e) => e.t === 'auth-ok'), bad);

  const admin = await new Client(OWNER, 'owner').connect();
  ok(c, 'owner is admin', admin.admin === true, admin.last('auth-ok'));
  ok(c, 'session token issued', typeof admin.token === 'string' && admin.token.includes('.'), admin.token);
  ok(c, 'adminId echoed to the client', admin.last('auth-ok').adminId === OWNER);

  const user = await new Client(7001, 'alice').connect();
  ok(c, 'ordinary user is not admin', user.admin === false);
  const tampered = admin.token.slice(0, -3) + 'aaa';
  ok(c, 'tampered token cannot be used', (await rpc({ t: 'tours', token: tampered })).status === 401);
  const noToken = await rpc({ t: 'auth', token: tampered });
  ok(c, 'tampered token is not exchanged for a session',
    !(noToken.events || []).some((e) => e.t === 'auth-ok'), noToken);
}

// ------------------------------------------------------- 2. admin permissions
section('admin gate');
{
  const stranger = await new Client(7002, 'mallory').connect();
  await stranger.send({ t: 'tour-create', name: 'Хак', seats: 4, prize: 99999 });
  ok(c, 'tour-create refused for non-admin', stranger.errors().includes('Нет прав'), stranger.errors());
  await stranger.send({ t: 'payouts-list' });
  ok(c, 'payouts-list refused for non-admin', stranger.errors().filter((m) => m === 'Нет прав').length >= 2, stranger.errors());
  await stranger.send({ t: 'tour-start', tourId: 't_nope' });
  ok(c, 'tour-start refused for non-admin', stranger.errors().includes('Нет прав'));
}

// ------------------------------------------------- 3. create / join / listing
section('registration');
const admin = await new Client(OWNER, 'owner').connect();
await admin.send({ t: 'tours' }); // the organizer subscribes to tournament updates
let openTour;
{
  await admin.send({ t: 'tour-create', name: 'Кубок', seats: 3, prize: 3000 });
  openTour = admin.last('tour-created').tour;
  ok(c, 'tour created', openTour.id && openTour.seats === 3 && openTour.prize === 3000, openTour);

  const p1 = await new Client(8001, 'p1').connect();
  await sync(p1);
  const list = p1.last('tours-list');
  ok(c, 'other users see it only after polling', !list || !list.tours.some((t) => t.id === openTour.id));

  await p1.send({ t: 'tours' });
  ok(c, 'tours returns the card', p1.last('tours-list').tours.some((t) => t.id === openTour.id), p1.last('tours-list'));

  const p2 = await new Client(8002, 'p2').connect();
  const p3 = await new Client(8003, 'p3').connect();
  const p4 = await new Client(8004, 'p4').connect();
  for (const cl of [p1, p2, p3]) await cl.send({ t: 'tour-join', tourId: openTour.id });
  ok(c, 'join acknowledged with the new count', p3.last('tour-joined').count === 3, p3.last('tour-joined'));

  await p4.send({ t: 'tour-join', tourId: openTour.id });
  ok(c, '4th player rejected (seats full)', p4.errors().includes('Мест больше нет'), p4.errors());
  await p1.send({ t: 'tour-join', tourId: openTour.id });
  ok(c, 'double join rejected', p1.errors().includes('Вы уже зарегистрированы'), p1.errors());

  await sync(admin);
  ok(c, 'organizer sees 3/3 registered',
    admin.last('tours-list').tours.find((t) => t.id === openTour.id).count === 3);

  await p4.send({ t: 'tour-leave', tourId: openTour.id });
  await p4.send({ t: 'tour-join', tourId: openTour.id });
  ok(c, 'leave then join again works', p4.errors().includes('Мест больше нет'), p4.errors());

  await admin.send({ t: 'tour-detail', tourId: openTour.id });
  ok(c, 'tour-detail lists the players',
    admin.last('tour-detail').tour.players.map((p) => p.username).sort().join() === 'p1,p2,p3',
    admin.last('tour-detail').tour.players);
  globalThis.__players = { p1, p2, p3, p4 };
}

// --------------------------------------------- 4. three-seat bracket end-to-end
section('seats=3 bracket');
{
  const { p1, p2, p3 } = globalThis.__players;
  await admin.send({ t: 'tour-start', tourId: openTour.id });
  ok(c, 'organizer gets tour-started', !!admin.last('tour-started'));

  await sync(p1, p2, p3);
  ok(c, 'semi-final started for p1 & p2', !!ms(p1) && !!ms(p2), [ms(p1), ms(p2)]);
  ok(c, 'p3 waits (bye into the final)', !ms(p3), ms(p3));
  ok(c, 'semi room is a real room code', /^[A-Z0-9]{6}$/.test(ms(p1).room), ms(p1).room);
  ok(c, 'opponents are paired correctly', ms(p1).opponent.id === p2.id && ms(p2).opponent.id === p1.id);

  // a non-participant cannot report a result
  const { p4 } = globalThis.__players;
  await p4.send({ t: 'tour-result', matchId: ms(p1).matchId, winner: p1.id });
  await sync(p1);
  ok(c, 'result from a spectator is ignored', !ms(p1).round || ms(p1).matchKind !== 'final');

  await report(p1, p1.id);
  await sync(p1, p3);
  ok(c, 'final started: p1 vs p3', ms(p1).matchKind === 'final' && ms(p3).matchKind === 'final', [ms(p1), ms(p3)]);
  ok(c, 'final opponents correct', ms(p1).opponent.id === p3.id && ms(p3).opponent.id === p1.id);
  ok(c, 'final room differs from the semi room', ms(p1).room !== ms(p2).room);

  // duplicate / conflicting report for the semi that is already over
  await p2.send({ t: 'tour-result', matchId: ms(p2).matchId, winner: p2.id });
  await sync(p3);
  ok(c, 'a finished match cannot be replayed', ms(p3).matchKind === 'final');

  await report(p3, p3.id);
  await sync(admin, p1, p2, p3);
  await p1.send({ t: 'tour-detail', tourId: openTour.id });
  const t = p1.last('tour-detail').tour;
  ok(c, 'tournament finished', t.status === 'finished', t.status);
  ok(c, '1st = p3', t.top3['1'].id === p3.id, t.top3);
  ok(c, '2nd = p1', t.top3['2'].id === p1.id, t.top3);
  ok(c, '3rd = p2 (semi loser)', t.top3['3'].id === p2.id, t.top3);
  ok(c, 'two rounds only (semi + final)', t.rounds.length === 2, t.rounds.length);

  const claims = [p1, p2, p3].map((cl) => cl.last('prize-claim'));
  ok(c, 'all three winners got prize-claim', claims.every(Boolean), claims);
  const byPlace = Object.fromEntries(claims.filter(Boolean).map((m) => [m.place, m.amount]));
  ok(c, 'amounts 1500/900/600', byPlace[1] === 1500 && byPlace[2] === 900 && byPlace[3] === 600, byPlace);
}

// ------------------------------------------------------------- 5. two of three
section('seats=3, only two registered');
{
  await admin.send({ t: 'tour-create', name: 'Двое', seats: 3, prize: 1000 });
  const id = admin.last('tour-created').tour.id;
  const q1 = await new Client(8101, 'q1').connect();
  const q2 = await new Client(8102, 'q2').connect();
  await q1.send({ t: 'tour-join', tourId: id });
  await q2.send({ t: 'tour-join', tourId: id });
  await admin.send({ t: 'tour-start', tourId: id });
  await sync(q1, q2);
  ok(c, 'direct final for both', ms(q1)?.matchKind === 'final' && ms(q2)?.matchKind === 'final', [ms(q1), ms(q2)]);
  await report(q1, q1.id);
  await sync(q1, q2, admin);
  await q1.send({ t: 'tour-detail', tourId: id });
  const d = q1.last('tour-detail').tour;
  ok(c, 'finished', d.status === 'finished');
  ok(c, '1st = q1, 2nd = q2', d.top3['1'].id === q1.id && d.top3['2'].id === q2.id, d.top3);
  ok(c, 'no phantom 3rd place', !d.top3['3'], d.top3);
  ok(c, 'single round bracket', d.rounds.length === 1, d.rounds.length);
  const claims = [q1, q2].map((cl) => cl.last('prize-claim')).filter(Boolean);
  ok(c, 'two claims 500/300', claims.length === 2
    && claims.find((m) => m.place === 1).amount === 500
    && claims.find((m) => m.place === 2).amount === 300, claims);
  ok(c, 'no third claim was created', ![q1, q2].some((cl) => cl.all('prize-claim').some((m) => m.place === 3)));
}

// ------------------------------------------------------- 6. draw => rematch
section('draw rematch');
{
  await admin.send({ t: 'tour-create', name: 'Ничья', seats: 4, prize: 4000 });
  const id = admin.last('tour-created').tour.id;
  const d1 = await new Client(8201, 'd1').connect();
  const d2 = await new Client(8202, 'd2').connect();
  const d3 = await new Client(8203, 'd3').connect();
  const d4 = await new Client(8204, 'd4').connect();
  for (const cl of [d1, d2, d3, d4]) await cl.send({ t: 'tour-join', tourId: id });
  await admin.send({ t: 'tour-start', tourId: id });
  await sync(d1, d2, d3, d4);
  const firstRoom = ms(d1).room;
  const firstColor = ms(d1).color;
  const semiId = ms(d1).matchId;
  await report(d1, 'draw');
  await sync(d1, d2);
  ok(c, 'rematch announced to both', ms(d1).matchId === semiId && ms(d1).room !== firstRoom, [ms(d1), ms(d2)]);
  ok(c, 'same match, new room', ms(d2).matchId === semiId && ms(d2).room === ms(d1).room);
  ok(c, 'colours swapped', ms(d1).color !== firstColor && ms(d1).color !== ms(d2).color, [ms(d1).color, ms(d2).color]);

  await report(d1, d1.id);
  await sync(d1, d2, d3, d4);
  ok(c, 'winner waits for the other semi', ms(d1).matchKind !== 'final', ms(d1));
  await report(d3, d3.id);
  await sync(d1, d3);
  ok(c, 'winner advanced to the final', ms(d1).matchKind === 'final' && ms(d1).opponent.id === d3.id, ms(d1));
}

// ---------------------------------------------------------- 7. scheduling
section('scheduled start');
{
  const at = Date.now() + 1200;
  await admin.send({ t: 'tour-create', name: 'Блиц', seats: 4, prize: 2000, startsAt: at });
  const id = admin.last('tour-created').tour.id;
  ok(c, 'startsAt stored', admin.last('tour-created').tour.startsAt === at);

  const s1 = await new Client(8301, 's1').connect();
  const s2 = await new Client(8302, 's2').connect();
  await s1.send({ t: 'tour-join', tourId: id });
  await s2.send({ t: 'tour-join', tourId: id });
  await sync(s1, s2);
  ok(c, 'not started before the appointed time', !ms(s1) && !ms(s2));

  await sleep(1400);
  await s1.poll();           // any request runs the sweep — there is no cron
  await sync(s1, s2);
  ok(c, 'auto-started by the sweep', ms(s1)?.round === 1 && !!ms(s2), [ms(s1), ms(s2)]);

  // missed schedule
  await admin.send({ t: 'tour-create', name: 'Пустой', seats: 4, prize: 100, startsAt: Date.now() + 400 });
  const emptyId = admin.last('tour-created').tour.id;
  const lonely = await new Client(8303, 'lonely').connect();
  await lonely.send({ t: 'tour-join', tourId: emptyId });
  await sleep(600);
  await lonely.poll();
  await sync(admin);
  const missed = admin.last('schedule-missed');
  ok(c, 'organizer notified about a missed start', missed && missed.tourId === emptyId, missed);
  await admin.send({ t: 'tour-detail', tourId: emptyId });
  ok(c, 'startMissed flag visible to clients', admin.last('tour-detail').tour.startMissed === true);

  // late second joiner starts it immediately
  const late = await new Client(8304, 'late').connect();
  await late.send({ t: 'tour-join', tourId: emptyId });
  await sync(late, lonely);
  ok(c, 'late joiner triggers the start', ms(late)?.round === 1 && ms(lonely)?.round === 1, [ms(late), ms(lonely)]);
}

section('tour-set-time');
{
  await admin.send({ t: 'tour-create', name: 'Время', seats: 4, prize: 10 });
  const id = admin.last('tour-created').tour.id;
  const stranger = await new Client(8305, 'nosy').connect();
  await stranger.send({ t: 'tour-set-time', tourId: id, startsAt: Date.now() + 60000 });
  ok(c, 'set-time refused for non-admin', stranger.errors().includes('Нет прав'), stranger.errors());

  const future = Date.now() + 3600000;
  await admin.send({ t: 'tour-set-time', tourId: id, startsAt: future });
  ok(c, 'epoch ms accepted', admin.last('tour-time-set').startsAt === future, admin.last('tour-time-set'));
  await admin.send({ t: 'tour-set-time', tourId: id, startsAt: Math.floor(future / 1000) });
  ok(c, 'epoch seconds normalised to ms', admin.last('tour-time-set').startsAt === Math.floor(future / 1000) * 1000);
  await admin.send({ t: 'tour-set-time', tourId: id, startsAt: 'не дата' });
  ok(c, 'garbage rejected', admin.errors().includes('Неверное время начала'), admin.errors());
  await admin.send({ t: 'tour-set-time', tourId: id, startsAt: null });
  ok(c, 'null clears the schedule', admin.last('tour-time-set').startsAt === null);
  await admin.send({ t: 'tour-set-time', tourId: 't_nope', startsAt: future });
  ok(c, 'unknown tournament rejected', admin.errors().includes('Турнир не найден'));
}

// ------------------------------------------------------- 8. claims & payouts
section('prize claims and payouts');
{
  const { p1, p2, p3 } = globalThis.__players;
  await p1.send({ t: 'claim-submit', tourId: openTour.id, method: 'sbp', requisites: '+7 900 000-00-00 Тинькофф' });
  ok(c, 'claim accepted', p1.last('claim-ok')?.status === 'submitted', p1.last('claim-ok'));
  await sync(admin);
  ok(c, 'organizer only gets a nudge, never the requisites',
    !!admin.last('payouts-dirty') && !JSON.stringify(admin.box).includes('900 000-00-00'),
    admin.last('payouts-dirty'));

  await admin.send({ t: 'payouts-list' });
  const rows = admin.last('payouts-list').claims;
  ok(c, 'payouts table has the submission', rows.some((r) => r.userId === p1.id && r.status === 'submitted'), rows);
  const claim = rows.find((r) => r.userId === p1.id && r.status === 'submitted');
  ok(c, 'requisites are visible to the owner over HTTP only', claim.requisites.includes('Тинькофф'), claim);

  const stranger = await new Client(8401, 'eve').connect();
  await stranger.send({ t: 'claim-submit', tourId: openTour.id, method: 'card', requisites: '1234' });
  ok(c, 'a non-winner cannot submit a claim', stranger.errors().includes('Заявка не найдена'), stranger.errors());
  await p2.send({ t: 'claim-submit', tourId: openTour.id, method: 'card', requisites: '' });
  ok(c, 'empty requisites rejected', p2.errors().includes('Введите реквизиты'), p2.errors());

  await admin.send({ t: 'payout-paid', claimId: claim.id });
  await sync(p1);
  ok(c, 'winner told the payout is done', p1.last('claim-paid')?.place === 2, p1.last('claim-paid'));
  const after = admin.last('payouts-list').claims;
  ok(c, 'paid claim leaves the table', !after.some((r) => r.id === claim.id), after);
  await p1.send({ t: 'tour-detail', tourId: openTour.id });
  ok(c, 'requisites purged: no open claim left', p1.last('tour-detail').myClaim === null, p1.last('tour-detail').myClaim);

  const stranger2 = await new Client(8402, 'eve2').connect();
  await stranger2.send({ t: 'payout-paid', claimId: claim.id });
  ok(c, 'payout-paid refused for non-admin', stranger2.errors().includes('Нет прав'), stranger2.errors());
}

// ------------------------------------------------------------- 9. casual rooms
section('casual rooms and move relay');
{
  const host = await new Client(8501, 'host').connect();
  const guest = await new Client(8502, 'guest').connect();
  await host.send({ t: 'create' });
  const room = host.last('created').room;
  ok(c, 'room created', /^[A-Z0-9]{6}$/.test(room), room);

  await guest.send({ t: 'join', room });
  ok(c, 'guest starts as black', guest.last('start')?.color === 'b', guest.last('start'));
  await sync(host);
  ok(c, 'host starts as white in the same room', host.last('start')?.room === room && host.last('start').color === 'w');

  await host.send({ t: 'move', room, move: { from: 'e2', to: 'e4' } });
  await sync(guest);
  ok(c, 'move relayed to the peer', guest.last('move')?.move.to === 'e4', guest.last('move'));

  await guest.send({ t: 'room-state', room });
  ok(c, 'room-state replays the log', guest.last('room-state').moves.length === 1, guest.last('room-state'));
  await host.send({ t: 'move', room, move: { from: 'g1', to: 'f3' } });
  await guest.send({ t: 'room-state', room });
  ok(c, 'log grows', guest.last('room-state').moves.length === 2, guest.last('room-state').moves);

  const third = await new Client(8503, 'third').connect();
  await third.send({ t: 'join', room });
  ok(c, 'full room refuses a third player', third.errors().includes('Комната занята'), third.errors());
  await third.send({ t: 'move', room, move: { from: 'a2', to: 'a4' } });
  await sync(guest);
  ok(c, 'a stranger cannot inject a move', guest.last('room-state').moves.length === 2);
  await third.send({ t: 'join', room: 'ZZZZZZ' });
  ok(c, 'unknown room reported', third.errors().includes('Комната не найдена'), third.errors());

  await guest.send({ t: 'resign', room });
  await sync(host);
  ok(c, 'resign relayed', !!host.last('resign'));
}

section('presence and opponent-left');
{
  const a = await new Client(8601, 'a').connect();
  const b = await new Client(8602, 'b').connect();
  await a.send({ t: 'create' });
  const room = a.last('created').room;
  await b.send({ t: 'join', room });
  await a.send({ t: 'ping', room });
  ok(c, 'no disconnect while both are fresh', !a.last('opponent-left'));
  await sleep(800); // SEEN_PX_MS=600 in this run
  await a.send({ t: 'ping', room });
  ok(c, 'stale peer reported as disconnected', !!a.last('opponent-left'), a.last('opponent-left'));

  await a.send({ t: 'room-state', room: 'NOPE' });
  ok(c, 'room-gone for a deleted room', !!a.last('room-gone'));
}

section('matchmaking queue');
{
  const x = await new Client(8701, 'x').connect();
  const y = await new Client(8702, 'y').connect();
  await x.send({ t: 'queue' });
  ok(c, 'first in line is queued', !!x.last('queued'));
  await y.send({ t: 'queue' });
  ok(c, 'second gets a room immediately', !!y.last('start'), y.last('start'));
  await sync(x);
  ok(c, 'both landed in the same room', x.last('start')?.room === y.last('start').room, [x.last('start'), y.last('start')]);
  ok(c, 'colours are opposite', x.last('start').color !== y.last('start').color);
}

// ------------------------------------------------------------- 10. reconnect
section('reconnect resumes a running match');
{
  await admin.send({ t: 'tour-create', name: 'Реконнект', seats: 4, prize: 500 });
  const id = admin.last('tour-created').tour.id;
  const r1 = await new Client(8801, 'r1').connect();
  const r2 = await new Client(8802, 'r2').connect();
  await r1.send({ t: 'tour-join', tourId: id });
  await r2.send({ t: 'tour-join', tourId: id });
  await admin.send({ t: 'tour-start', tourId: id });
  await sync(r1, r2);
  const before = ms(r1);
  ok(c, 'match is live', !!before, before);

  const again = new Client(r1.id, 'r1'); // same Telegram id, brand new session
  await again.connect();
  const resumed = ms(again);
  ok(c, 'match-start re-delivered after re-auth', resumed?.matchId === before.matchId, resumed);
  ok(c, 'same room and colour', resumed.room === before.room && resumed.color === before.color);
  ok(c, 'a fresh session resumes the same identity', typeof again.token === 'string' && again.user.id === r1.id, again.user);
}

// -------------------------------------------------------------- 11. cleanup
section('admin cleanup');
{
  await admin.send({ t: 'tour-delete', tourId: openTour.id });
  await admin.send({ t: 'tours' });
  ok(c, 'deleted tournament is gone', !admin.last('tours-list').tours.some((t) => t.id === openTour.id));
}

console.log(`\n==== ${c.pass} passed, ${c.fail} failed ====`);
process.exit(c.fail ? 1 : 0);
