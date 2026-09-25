// Telegram Mini App initData validation (HMAC-SHA256), per
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// Ported verbatim from server/index.js so both backends agree on identity.
import crypto from 'node:crypto';
import { CFG, AUTH_MAX_AGE } from './env.js';

export function validateInitData(initData) {
  if (!initData || typeof initData !== 'string') return null;
  if (!CFG.botToken) return null; // no token => DEV mode, caller handles it

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  const pairs = [];
  for (const [k, v] of params.entries()) if (k !== 'hash') pairs.push([k, v]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(CFG.botToken).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const a = Buffer.from(computed, 'hex');
  let b;
  try { b = Buffer.from(hash, 'hex'); } catch { return null; }
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { user = null; }
  if (!user || !user.id) return null;

  const authDate = Number(params.get('auth_date') || 0);
  if (authDate && Date.now() / 1000 - authDate > AUTH_MAX_AGE) return null;

  return {
    id: Number(user.id),
    username: user.username || '',
    first_name: user.first_name || '',
  };
}
