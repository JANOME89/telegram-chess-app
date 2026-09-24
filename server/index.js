// Ultimate Chess — dependency-free WebSocket room server (Node >= 18).
// Implements minimal RFC6455 server framing so no npm install is required:
//   node index.js            (PORT env optional, default 8787)
// Protocol (JSON):
//   client -> server: queue | create | join{room} | move{move} | resign
//   server -> client: queued | created{room} | start{room,color} | error{msg}
//                       | move{move} | resign | opponent-left
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const rooms = new Map(); // roomId -> Set<sock>
const queue = new Set(); // sockets waiting for matchmaking

function roomId() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }
function roomOf(sock) { for (const [id, p] of rooms) if (p.has(sock)) return id; return null; }
function peerIn(sock, id) { for (const o of rooms.get(id) || []) if (o !== sock) return o; return null; }

// ---------- WebSocket framing ----------
function sendText(sock, str) {
  if (!sock.wsOpen) return;
  const payload = Buffer.from(str, 'utf8');
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  try { sock.write(Buffer.concat([header, payload])); } catch (_) {}
}
function send(sock, obj) { sendText(sock, JSON.stringify(obj)); }
function sendClose(sock) { try { sock.write(Buffer.from([0x88, 0x00])); } catch (_) {} }

function parseFrames(sock) {
  let buf = sock.rx;
  while (buf.length >= 2) {
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    let mask = null;
    if (masked) { if (buf.length < off + 4) return; mask = buf.subarray(off, off + 4); off += 4; }
    if (buf.length < off + len) return;
    let payload = Buffer.from(buf.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    buf = buf.subarray(off + len);
    handleFrame(sock, opcode, payload);
  }
  sock.rx = buf;
}

function handleFrame(sock, opcode, payload) {
  if (opcode === 0x8) { sendClose(sock); sock.wsOpen = false; sock.end(); return; }   // close
  if (opcode === 0x9) { try { sock.write(Buffer.from([0x8a, 0x00])); } catch (_) {} return; } // ping->pong
  if (opcode !== 0x1 && opcode !== 0x2) return;
  let msg;
  try { msg = JSON.parse(payload.toString('utf8')); } catch { return; }
  onMessage(sock, msg);
}

// ---------- game logic ----------
function leaveRooms(sock) {
  for (const [id, players] of rooms) {
    if (players.has(sock)) {
      players.delete(sock);
      if (players.size === 0) rooms.delete(id);
    }
  }
  queue.delete(sock);
}

function onMessage(sock, msg) {
  if (msg.t === 'queue') {
    leaveRooms(sock);
    let partner = null;
    for (const other of queue) if (other !== sock && other.wsOpen) { partner = other; break; }
    if (partner) {
      queue.delete(partner);
      const id = roomId();
      rooms.set(id, new Set([partner, sock]));
      const colors = Math.random() < 0.5 ? ['w', 'b'] : ['b', 'w'];
      send(partner, { t: 'start', room: id, color: colors[0] });
      send(sock, { t: 'start', room: id, color: colors[1] });
    } else {
      queue.add(sock);
      send(sock, { t: 'queued' });
    }
    return;
  }
  if (msg.t === 'create') {
    leaveRooms(sock);
    const id = roomId();
    rooms.set(id, new Set([sock]));
    send(sock, { t: 'created', room: id });
    return;
  }
  if (msg.t === 'join') {
    const id = String(msg.room || '').toUpperCase();
    const players = rooms.get(id);
    if (!players) { send(sock, { t: 'error', msg: 'Комната не найдена' }); return; }
    if (players.size >= 2) { send(sock, { t: 'error', msg: 'Комната занята' }); return; }
    leaveRooms(sock);
    players.add(sock);
    const [host] = players;
    send(host, { t: 'start', room: id, color: 'w' });
    send(sock, { t: 'start', room: id, color: 'b' });
    return;
  }
  if (msg.t === 'move' || msg.t === 'resign') {
    const id = roomOf(sock);
    if (!id) return;
    const peer = peerIn(sock, id);
    if (peer) send(peer, msg.t === 'move' ? { t: 'move', move: msg.move } : { t: 'resign' });
  }
}

function onDisconnect(sock) {
  queue.delete(sock);
  const id = roomOf(sock);
  if (id) {
    const peer = peerIn(sock, id);
    if (peer) send(peer, { t: 'opponent-left' });
    rooms.get(id).delete(sock);
    if (rooms.get(id).size === 0) rooms.delete(id);
  }
}

// ---------- HTTP upgrade ----------
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ultimate-chess-ws');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.wsOpen = true;
  socket.rx = Buffer.alloc(0);
  socket.on('data', (chunk) => { socket.rx = Buffer.concat([socket.rx, chunk]); parseFrames(socket); });
  socket.on('close', () => { socket.wsOpen = false; onDisconnect(socket); });
  socket.on('error', () => { socket.wsOpen = false; onDisconnect(socket); });
});

server.listen(PORT, () => console.log(`[chess-ws] listening on :${PORT}`));
