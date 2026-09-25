// Stateless session tokens: `payload.signature`, both base64url, HMAC-SHA256.
// The token is the only credential the browser holds; it proves the initData was
// validated once, so the bot token never leaves the backend.
import crypto from 'node:crypto';
import { CFG, isAdminId } from './env.js';

function secret() {
  // SESSION_SECRET wins; otherwise derive from the bot token so a deployment with
  // only TG_BOT_TOKEN still gets non-forgeable sessions.
  const base = CFG.sessionSecret || CFG.botToken || 'uca-dev-insecure';
  return crypto.createHash('sha256').update(base).digest();
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

export function signSession(user, ttl = CFG.sessionTtl) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload = { id: user.id, u: user.username || '', f: user.first_name || '', exp };
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', secret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = b64u(crypto.createHmac('sha256', secret()).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p;
  try { p = JSON.parse(unb64u(body).toString('utf8')); } catch { return null; }
  if (!p || !p.id) return null;
  if (Number(p.exp) * 1000 < Date.now()) return null;
  return { id: Number(p.id), username: p.u || '', first_name: p.f || '' };
}

export function adminFlag(user) {
  return !!(user && isAdminId(user.id));
}
