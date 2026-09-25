// Vercel serverless entry point.
//
//   GET  /api/rpc   -> backend status (is the KV/realtime configured, dev or prod)
//   POST /api/rpc   -> { t: 'auth' | 'tours' | 'move' | ..., token?, ...payload }
//                      <- { ok: true, events: [ ...everything queued for me... ] }
//
// One endpoint, one dispatch table: the browser keeps the {t: ...} protocol it
// already speaks to server/index.js, only the transport changes.
import { backendStatus, DEV_MODE, KV_READY } from './_lib/env.js';
import { verifySession } from './_lib/session.js';
import { Ctx, handleAuth, dispatch } from './_lib/handlers.js';
import { KvError } from './_lib/kv.js';
import { pushEvents, drainInbox, publishHint } from './_lib/realtime.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET') return send(res, 200, backendStatus());
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method Not Allowed' });

  const msg = await readBody(req);
  if (!msg || typeof msg.t !== 'string') return send(res, 400, { ok: false, error: 'Ожидался JSON с полем "t"' });

  const me = verifySession(msg.token) || null;
  const ctx = new Ctx(me ? me.id : null);

  try {
    if (msg.t === 'auth') {
      await handleAuth(ctx, msg);
    } else if (!me) {
      // No valid session: tell the client to re-auth instead of failing silently.
      return send(res, 401, { ok: false, needAuth: true, error: 'Сессия истекла, подключитесь заново' });
    } else {
      await dispatch(ctx, me, msg);
    }
  } catch (e) {
    if (e instanceof KvError) return send(res, 503, { ok: false, error: e.message });
    console.error('[rpc]', msg.t, e);
    return send(res, 500, { ok: false, error: 'Внутренняя ошибка сервера' });
  }

  await Promise.allSettled(ctx.pending);

  // Split the notifications: mine ride back in this response, everybody else's go
  // to their inbox queue and a PieSocket hint nudges them to poll right away.
  // ctx.meId is set by a successful `auth`, which has no session token yet.
  const callerId = ctx.meId;
  const mine = [];
  const byUid = new Map();
  for (const { to, msg: m } of ctx.events) {
    if (to == null || (callerId && to === callerId)) mine.push(m);
    else {
      if (!byUid.has(to)) byUid.set(to, []);
      byUid.get(to).push(m);
    }
  }
  try {
    for (const [uid, msgs] of byUid) await pushEvents(uid, msgs);
    if (byUid.size) await publishHint([...byUid.keys()]);
    // Anything other requests queued for me since my last call comes along too.
    const queued = callerId && KV_READY ? await drainInbox(callerId) : [];
    return send(res, 200, { ok: true, dev: DEV_MODE, events: [...queued, ...mine] });
  } catch (e) {
    if (e instanceof KvError) return send(res, 503, { ok: false, error: e.message });
    console.error('[rpc:deliver]', e);
    return send(res, 200, { ok: true, events: mine });
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body; // Vercel pre-parses JSON
  try {
    const raw = await new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > 1e6) { reject(new Error('too large')); req.destroy(); } });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(JSON.stringify(obj));
}
