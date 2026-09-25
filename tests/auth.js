// Production auth path: signed Telegram initData, not the DEV backdoor.
// Uses a fake bot token — the algorithm is identical, no real secret is involved.
//   node tests/auth.js
import { createHmac } from 'node:crypto';

const BOT_TOKEN = '123456:TEST-FAKE-TOKEN';
const OWNER = 498258870;
process.env.TG_BOT_TOKEN = BOT_TOKEN;

const { boot, rpc, Client, counters, ok } = await import('./harness.js');
await boot({ dev: false });

const c = counters();
console.log('=== initData signature (prod mode) ===');

function makeInitData(user, { token = BOT_TOKEN, authDate = Math.floor(Date.now() / 1000), extra } = {}) {
  const params = new URLSearchParams();
  if (extra) for (const [k, v] of Object.entries(extra)) params.set(k, v);
  params.set('user', JSON.stringify(user));
  params.set('auth_date', String(authDate));
  const dcs = [...params.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

const owner = { id: OWNER, username: 'owner', first_name: 'Owner' };
const res = await rpc({ t: 'auth', initData: makeInitData(owner) });
const authOk = (res.events || []).find((e) => e.t === 'auth-ok');
ok(c, 'valid initData is accepted', !!authOk, res);
ok(c, 'id comes from the signature, not the client', authOk?.user.id === OWNER, authOk?.user);
ok(c, 'owner is admin', authOk?.admin === true);
ok(c, 'prod mode reported', res.dev === false && authOk?.dev === false);
ok(c, 'session token issued', typeof authOk?.token === 'string' && authOk.token.split('.').length === 2);

// the token replaces initData on every following call
const next = await rpc({ t: 'tours', token: authOk.token });
ok(c, 'session token works without initData', next.ok === true && (next.events || []).some((e) => e.t === 'tours-list'), next);

const stranger = await rpc({ t: 'auth', initData: makeInitData({ id: 42, username: 'x', first_name: 'X' }) });
const sAuth = (stranger.events || []).find((e) => e.t === 'auth-ok');
ok(c, 'another user is not admin', sAuth?.admin === false, sAuth);
ok(c, 'adminId is still announced for the UI', sAuth?.adminId === OWNER);

// --- attacks ---
const forgedUser = makeInitData(owner).replace(
  encodeURIComponent('"id":498258870'), encodeURIComponent('"id":1'));
const forged = await rpc({ t: 'auth', initData: forgedUser });
ok(c, 'rewritten user id breaks the signature',
  !(forged.events || []).some((e) => e.t === 'auth-ok'), forged.events);

const wrongToken = await rpc({ t: 'auth', initData: makeInitData(owner, { token: '999:WRONG' }) });
ok(c, 'initData signed with another bot token is refused',
  !(wrongToken.events || []).some((e) => e.t === 'auth-ok'));

const old = await rpc({
  t: 'auth',
  initData: makeInitData(owner, { authDate: Math.floor(Date.now() / 1000) - 25 * 3600 }),
});
ok(c, 'stale auth_date (>24h) is refused', !(old.events || []).some((e) => e.t === 'auth-ok'));

const noHash = await rpc({ t: 'auth', initData: 'user=%7B%22id%22%3A498258870%7D' });
ok(c, 'initData without a hash is refused', !(noHash.events || []).some((e) => e.t === 'auth-ok'));

// --- the DEV backdoor must be dead in prod ---
const dev = await rpc({ t: 'auth', dev: { id: OWNER, username: 'hacker' } });
ok(c, 'dev identity is refused when a bot token is set',
  !(dev.events || []).some((e) => e.t === 'auth-ok'), dev.events);

const hacker = new Client(OWNER, 'hacker');
await hacker.send({ t: 'auth', dev: { id: OWNER, username: 'hacker' } });
ok(c, 'no session token for a dev identity in prod', !hacker.token, hacker.box);
await hacker.send({ t: 'tour-create', name: 'Хак', seats: 4, prize: 1 });
ok(c, 'admin action without a session is 401', hacker.last('rpc-error')?.status === 401, hacker.box);

console.log(`\n==== ${c.pass} passed, ${c.fail} failed ====`);
process.exit(c.fail ? 1 : 0);
