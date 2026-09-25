// Runtime config. Override without rebuild via ?api=... or localStorage 'uca-api'.
const params = new URLSearchParams(location.search);

// The backend lives at the root of the same Vercel deployment as the frontend.
function defaultApiUrl() {
  if (!/^https?:$/.test(location.protocol)) return 'api/rpc'; // file:// — unsupported anyway
  return new URL('/api/rpc', location.href).href;
}

export const CONFIG = {
  // Serverless backend (Vercel Functions + Upstash Redis + PieSocket hints).
  // Point it elsewhere with ?api=https://your-project.vercel.app/api/rpc
  apiUrl: params.get('api') || localStorage.getItem('uca-api') || defaultApiUrl(),

  // Public link to this Mini App in Telegram, used to build invite links.
  // Replace with your real bot/app: https://t.me/<bot>/<app_short_name>
  botAppLink:
    localStorage.getItem('uca-bot-link') ||
    'https://t.me/UltimateChessBot/app',
};
