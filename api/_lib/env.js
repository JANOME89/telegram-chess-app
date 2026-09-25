// Runtime configuration for the serverless backend.
// Every value comes from Vercel environment variables — nothing here is a secret
// by itself, but this module must only ever be imported from `api/` (never from `js/`).
export const CFG = {
  // @BotFather token. When empty the backend runs in DEV mode and trusts the
  // client-declared identity (`?as=<id>@<username>`) — browser testing only.
  botToken: (process.env.TG_BOT_TOKEN || '').trim(),

  // Signs the session cookie-less token handed to the client after initData validation.
  // Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  sessionSecret: (process.env.SESSION_SECRET || '').trim(),

  // ⬇️ OWNER: your Telegram user id. Server-enforced — every admin operation is
  // rejected unless the verified session carries exactly this id. The ADMIN_ID env
  // var overrides this constant. Must match ADMIN_ID in js/main.js.
  adminId: Number(process.env.ADMIN_ID || 498258870),

  // Upstash Redis (REST). State of tournaments, rooms and prize claims.
  kvUrl: (process.env.UPSTASH_REDIS_REST_URL || '').trim(),
  kvToken: (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim(),

  // PieSocket. Used ONLY as a wake-up hint ("you have new events, poll now").
  // No game data, no personal data and no requisites ever travel over it.
  pieCluster: (process.env.PIESOCKET_CLUSTER || '').trim(),
  pieKey: (process.env.PIESOCKET_KEY || '').trim(),
  pieSecret: (process.env.PIESOCKET_SECRET || '').trim(),
  piePrefix: (process.env.PIESOCKET_PREFIX || 'uca').trim(),

  // How long a session token stays valid (seconds). Telegram initData itself is
  // only accepted within AUTH_MAX_AGE of its auth_date.
  sessionTtl: Number(process.env.SESSION_TTL || 24 * 3600),
};

export const AUTH_MAX_AGE = 24 * 3600; // seconds
export const DEV_MODE = !CFG.botToken;
export const KV_READY = !!(CFG.kvUrl && CFG.kvToken);
export const PIE_READY = !!(CFG.pieCluster && CFG.pieKey && CFG.pieSecret);

export function isAdminId(id) {
  return CFG.adminId !== 0 && Number(id) === CFG.adminId;
}

// One-line status used by `GET /api/rpc` so a deployment can be verified in a browser.
export function backendStatus() {
  return {
    ok: true,
    service: 'ultimate-chess-rpc',
    mode: DEV_MODE ? 'dev' : 'prod',
    adminId: CFG.adminId || null,
    kv: KV_READY,
    realtime: PIE_READY,
    dev: DEV_MODE,
  };
}
