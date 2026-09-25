// Test harness: boots api/rpc.js against an in-memory Redis and drives it with
// fake req/res objects, so the exact production code path is exercised.
import { createMemKv } from './memkv.js';

let handler = null;

export async function boot({ dev = true } = {}) {
  // env.js reads process.env at import time — set it before importing anything
  // from api/, and import dynamically for the same reason.
  process.env.UPSTASH_REDIS_REST_URL = 'https://mem.local';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'mem-token';
  if (dev) delete process.env.TG_BOT_TOKEN;
  process.env.ADMIN_ID = process.env.ADMIN_ID || '498258870';

  const { useKvBackend } = await import('../api/_lib/kv.js');
  useKvBackend(createMemKv());
  handler = (await import('../api/rpc.js')).default;
  return handler;
}

export async function rpc(msg) {
  const out = { status: 200, body: '' };
  const res = {
    writeHead(status) { out.status = status; },
    end(body) { out.body = body; },
  };
  await handler({ method: 'POST', body: msg }, res);
  let json = {};
  try { json = JSON.parse(out.body || '{}'); } catch (_) {}
  return { status: out.status, ...json };
}

// One "phone": holds its session token and everything the backend told it.
export class Client {
  constructor(id, name) {
    this.id = Number(id);
    this.name = name;
    this.token = null;
    this.box = [];
  }

  async connect() {
    await this.send({ t: 'auth', dev: { id: this.id, username: this.name, first_name: this.name } });
    return this;
  }

  async send(msg) {
    const res = await rpc(this.token ? { ...msg, token: this.token } : msg);
    if (!res.ok) {
      this.box.push({ t: 'rpc-error', msg: res.error, status: res.status, needAuth: res.needAuth });
      return res;
    }
    for (const e of res.events || []) {
      this.box.push(e);
      if (e.t === 'auth-ok') { this.token = e.token; this.user = e.user; this.admin = e.admin; }
    }
    return res;
  }

  poll() { return this.send({ t: 'poll' }); }

  all(t) { return this.box.filter((e) => e.t === t); }
  last(t) { const a = this.all(t); return a.length ? a[a.length - 1] : null; }
  errors() { return this.all('error').map((e) => e.msg).concat(this.all('rpc-error').map((e) => e.msg)); }
}

export function counters() {
  return { pass: 0, fail: 0 };
}
export function ok(c, name, cond, extra) {
  if (cond) { c.pass++; console.log('  \u2713 ' + name); }
  else { c.fail++; console.log('  \u2717 ' + name, extra === undefined ? '' : JSON.stringify(extra)); }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
