// Runtime config. Override without rebuild via ?ws=... or localStorage 'uca-ws'.
const params = new URLSearchParams(location.search);

export const CONFIG = {
  // WebSocket room server (see /server). Use wss:// after deploying behind TLS.
  wsUrl:
    params.get('ws') ||
    localStorage.getItem('uca-ws') ||
    'ws://localhost:8787',

  // Public link to this Mini App in Telegram, used to build invite links.
  // Replace with your real bot/app: https://t.me/<bot>/<app_short_name>
  botAppLink:
    localStorage.getItem('uca-bot-link') ||
    'https://t.me/UltimateChessBot/app',

  // Owner's Telegram user id. This is only a UI hint — the *server* is the
  // authority and re-checks it against the signed Telegram initData. Set the
  // same value in server/index.js (ADMIN_ID_CONST) or via the ADMIN_ID env var.
  adminId: Number(localStorage.getItem('uca-admin-id') || 0),
};
