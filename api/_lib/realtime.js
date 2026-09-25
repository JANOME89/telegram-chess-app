// Event delivery.
//
// The authoritative queue is a Redis list per user (`inbox:<uid>`): a serverless
// function cannot hold a socket open, so every notification is appended there and
// the client drains it with `{t:'poll'}` (or with the response of any other call).
//
// PieSocket is used only to say "something arrived, poll now". The hint carries no
// payload at all, so a public/guessable channel name leaks nothing and cannot be
// used to forge a tournament, a move or a prize claim.
import { CFG, PIE_READY } from './env.js';
import { kv } from './kv.js';

const INBOX_TTL_SEC = 3 * 3600;
const INBOX_MAX = 100;

export const hints = []; // test hook: every published channel is recorded here

export function channelFor(uid) { return `${CFG.piePrefix}-u-${uid}`; }

// Handed to the client after a successful auth so no frontend file has to be
// edited when the PieSocket cluster changes. `key` is the public client key —
// the publishing `secret` never leaves the backend. The channel carries no data,
// only "poll now" hints, so it is safe to subscribe to from a browser.
export function realtimeInfo(uid) {
  if (!PIE_READY) return null;
  return { cluster: CFG.pieCluster, key: CFG.pieKey, channel: channelFor(uid) };
}

export async function publishHint(uids) {
  const list = [...new Set(uids.map(Number).filter(Boolean))];
  if (!PIE_READY || !list.length) return;
  await Promise.all(list.map((uid) => publish(channelFor(uid), 'uca', {})));
}

export async function publish(channel, event, data) {
  hints.push({ channel, event });
  const url = `https://${CFG.pieCluster}.piesocket.com/api/publish?src=piesocket-nodejs&v=3`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: CFG.pieKey,
        secret: CFG.pieSecret,
        channelId: channel,
        message: { event, data },
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    // A failed hint only costs latency: the client still polls on its own timer.
    console.warn('[realtime] hint publish failed:', e.message);
  }
}

export async function pushEvents(uid, msgs) {
  if (!msgs.length) return;
  const key = `inbox:${Number(uid)}`;
  const cmds = msgs.map((m) => ['RPUSH', key, JSON.stringify(m)]);
  cmds.push(['LTRIM', key, -INBOX_MAX, -1], ['EXPIRE', key, INBOX_TTL_SEC]);
  await kv.run(cmds);
}

export async function drainInbox(uid, count = 50) {
  const out = await kv.lpop(`inbox:${Number(uid)}`, count);
  return (Array.isArray(out) ? out : [out]).filter(Boolean).map((s) => {
    try { return JSON.parse(s); } catch { return null; }
  }).filter(Boolean);
}
