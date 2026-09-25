// Local all-in-one server: the same api/rpc.js that runs on Vercel, mounted next
// to the static frontend, with Redis replaced by an in-memory shim.
//   node tests/serve.js [port]        -> http://localhost:8801/?as=498258870@owner
// Data lives in RAM and resets on restart. For a real deployment see README.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from './harness.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 8801);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const rpcHandler = await boot(); // DEV mode + in-memory Redis

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/rpc') return rpcHandler(req, res);

  const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const buf = await readFile(join(ROOT, rel));
    res.writeHead(200, { 'Content-Type': MIME[extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}).listen(PORT, () => {
  console.log(`[uca-dev] http://localhost:${PORT}/`);
  console.log(`[uca-dev] backend: DEV mode (identity from ?as=<id>@<name>), in-memory Redis`);
  console.log(`[uca-dev] owner:    http://localhost:${PORT}/?as=498258870@owner`);
});
