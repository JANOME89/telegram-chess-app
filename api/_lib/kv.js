// Upstash Redis over its REST API — no npm dependency, plain fetch.
// Every call goes through `run(cmds)` so tests can swap in an in-memory backend
// via `useKvBackend()`.
import { CFG, KV_READY } from './env.js';

let backend = null; // test shim: (cmds: string[][]) => Promise<any[]>
export function useKvBackend(fn) { backend = fn; }

export class KvError extends Error {}

async function run(cmds) {
  if (backend) return backend(cmds);
  if (!KV_READY) {
    throw new KvError('KV не настроен: задайте UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN');
  }
  const path = cmds.length === 1 ? '' : '/pipeline';
  const body = cmds.length === 1 ? cmds[0] : cmds;
  let res;
  try {
    res = await fetch(CFG.kvUrl + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CFG.kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Serverless functions must not hang on a stalled Redis connection.
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    throw new KvError(`KV недоступен: ${e.message}`);
  }
  if (!res.ok) throw new KvError(`KV HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new KvError(`KV: ${json.error}`);
  return cmds.length === 1 ? [json.result] : json.result.map((r) => r.result);
}

export const kv = {
  run,
  get: async (k) => (await run([['GET', k]]))[0],
  set: async (k, v, px) => (await run([px ? ['SET', k, v, 'PX', px] : ['SET', k, v]]))[0],
  // SET key val NX PX -> "OK" only if the key did not exist. Used as a mutex.
  setNx: async (k, v, px) => (await run([['SET', k, v, 'NX', 'PX', px]]))[0] === 'OK',
  del: async (...ks) => (await run([['DEL', ...ks]]))[0],
  exists: async (k) => (await run([['EXISTS', k]]))[0],
  expire: async (k, sec) => (await run([['EXPIRE', k, sec]]))[0],
  incr: async (k) => (await run([['INCR', k]]))[0],

  zadd: async (k, score, member) => (await run([['ZADD', k, score, member]]))[0],
  zrem: async (k, member) => (await run([['ZREM', k, member]]))[0],
  zrangeScore: async (k, min, max) => (await run([['ZRANGEBYSCORE', k, min, max]]))[0] || [],
  zrangeAll: async (k) => (await run([['ZREVRANGE', k, 0, -1]]))[0] || [],

  hset: async (k, field, val) => (await run([['HSET', k, field, val]]))[0],
  hget: async (k, field) => (await run([['HGET', k, field]]))[0],
  hdel: async (k, field) => (await run([['HDEL', k, field]]))[0],
  hvals: async (k) => (await run([['HVALS', k]]))[0] || [],

  rpush: async (k, ...vals) => (await run([['RPUSH', k, ...vals]]))[0],
  lpop: async (k, count) => (await run([['LPOP', k, count]]))[0] || [],
  ltrim: async (k, a, b) => (await run([['LTRIM', k, a, b]]))[0],

  // One round trip for several independent reads.
  mget: async (ks) => (ks.length ? run(ks.map((k) => ['GET', k])) : []),
};

// JSON convenience wrappers — the whole app state is JSON documents.
export const jget = async (k) => { const s = await kv.get(k); return s ? JSON.parse(s) : null; };
export const jset = (k, v, px) => kv.set(k, JSON.stringify(v), px);
export const jpush = (k, v) => kv.rpush(k, JSON.stringify(v));
