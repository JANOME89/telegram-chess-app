// Cloud transport for the Telegram Mini App.
//
// There is no socket to hold open: every action is a POST to /api/rpc and the
// response carries everything the backend queued for us. A PieSocket channel is
// opened as well, but it only says "something arrived — poll now"; its payload is
// never read, so a forged or overheard hint can at most cause one extra poll.
//
// The public surface (connect / send / on / close) is unchanged, so main.js does
// not know or care which transport is underneath.
import { CONFIG } from './config.js';

const POLL_HINTED = 6000;   // realtime socket alive: poll only as a safety net
const POLL_PLAIN = 2500;    // no realtime socket: polling *is* the transport
const POLL_IN_GAME = 1500;  // a live game wants a tighter loop
const PING_EVERY = 3;       // every Nth in-game tick fetches the authoritative log
const MAX_EVENTS = 100;
const FAILS_BEFORE_CLOSE = 3;
const HEARTBEATS = new Set(['poll', 'ping', 'room-state']);

export class Net {
  constructor(cfg = CONFIG) {
    this.cfg = cfg || CONFIG;
    this.handlers = {};
    this.open = false;
    this.fails = 0;
    this.inflight = false;
    this.q = [];
    this.room = null;      // active game room, drives presence pings
    this.ws = null;
    this.rt = null;
    this.hintFails = 0;
    this.hintTimer = null;
    this.timer = null;
    this.tickN = 0;
    this.token = localStorage.getItem('uca-token') || null;
    this.uid = Number(localStorage.getItem('uca-uid') || 0) || null;
    this.authed = false;
  }

  on(type, fn) {
    (this.handlers[type] ||= []).push(fn);
    return this;
  }
  _emit(type, payload) {
    (this.handlers[type] || []).forEach((fn) => {
      try { fn(payload); } catch (e) { console.error(`[net:${type}]`, e); }
    });
  }

  // Resolves as soon as the transport is usable. Unlike a WebSocket there is no
  // handshake to wait for: 'open' means "we will POST", and auth follows.
  connect() {
    this.fails = 0;
    if (!this.open) { this.open = true; this._emit('open'); }
    this._retimer();
    return Promise.resolve();
  }

  send(obj) {
    if (!this.open || !obj || !obj.t) return false;
    this._enqueue(this.token ? { ...obj, token: this.token } : { ...obj });
    return true;
  }

  close() {
    this.handlers = {};
    this.open = false;
    this.authed = false;
    this.room = null;
    this.q = [];
    clearInterval(this.timer); this.timer = null;
    clearTimeout(this.hintTimer); this.hintTimer = null;
    const ws = this.ws; this.ws = null; this.rt = null;
    try { ws?.close(); } catch (_) {}
  }

  // Called by main.js when a game starts/ends so we can keep presence alive and
  // resync from the server-side move log.
  setRoom(room) {
    this.room = room || null;
    this.tickN = 0;
    this._retimer();
  }

  // ---------- internals ----------
  _retimer() {
    clearInterval(this.timer);
    if (!this.open || !this.authed) { this.timer = null; return; }
    const delay = this.room
      ? POLL_IN_GAME
      : (this.ws ? POLL_HINTED : POLL_PLAIN);
    this.timer = setInterval(() => this._tick(), delay);
  }

  _tick() {
    if (!this.authed || this.inflight) return;
    this.tickN++;
    if (!this.room) return this._enqueue({ t: 'poll', token: this.token });
    // In a game: heartbeat, and every PING_EVERY-th beat re-read the move log so a
    // missed or forged hint can never leave two boards permanently out of sync.
    const t = this.tickN % PING_EVERY === 0
      ? { t: 'room-state', room: this.room }
      : { t: 'ping', room: this.room };
    this._enqueue({ ...t, token: this.token });
  }

  poll() {
    if (!this.authed || this.inflight) return;
    this._enqueue({ t: 'poll', token: this.token });
  }

  // Heartbeats are coalesced (one queued is enough); player actions never are —
  // dropping a move would silently desync the two boards.
  _enqueue(msg) {
    if (HEARTBEATS.has(msg.t)) {
      if (this.q.some((m) => HEARTBEATS.has(m.t))) return;
    }
    this.q.push(msg);
    this._drain();
  }

  async _drain() {
    if (this.inflight) return;
    const msg = this.q.shift();
    if (!msg) return;
    this.inflight = true;
    try {
      await this._post(msg);
    } finally {
      this.inflight = false;
      if (this.q.length) this._drain();
    }
  }

  async _post(msg) {
    try {
      const res = await fetch(this.cfg.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
      });
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      this._onSuccess();

      if (res.status === 401 && data?.needAuth) { this._reauth(); return; }
      if (!res.ok) {
        this._emit('error', { msg: data?.error || `Сервер ответил ${res.status}` });
        return;
      }
      this._receive(data?.events || []);
    } catch (_) {
      this.fails++;
      // One dropped request on a mobile network is normal; only a sustained
      // outage is worth tearing the session down and showing the overlay.
      if (this.fails >= FAILS_BEFORE_CLOSE && this.open) {
        this.open = false;
        this.authed = false;
        this.q = [];
        clearInterval(this.timer); this.timer = null;
        this._emit('close');
      }
    }
  }

  _onSuccess() {
    this.fails = 0;
    if (!this.open) { this.open = true; this._emit('open'); }
  }

  _reauth() {
    // The stored session expired or was never valid: drop it and let main.js send
    // a fresh `auth` with Telegram initData (its 'open' handler does exactly that).
    this.token = null;
    this.authed = false;
    localStorage.removeItem('uca-token');
    clearInterval(this.timer); this.timer = null;
    this._emit('open');
  }

  _receive(events) {
    for (const e of (Array.isArray(events) ? events : []).slice(-MAX_EVENTS)) {
      if (!e || typeof e.t !== 'string') continue;
      if (e.t === 'auth-ok') this._onAuth(e);
      this._emit(e.t, e);
    }
  }

  _onAuth(e) {
    this.authed = true;
    this.fails = 0;
    if (e.token && e.token !== this.token) {
      this.token = e.token;
      localStorage.setItem('uca-token', e.token);
    }
    if (e.user?.id) {
      this.uid = Number(e.user.id);
      localStorage.setItem('uca-uid', String(this.uid));
    }
    if (e.realtime) this._openHintSocket(e.realtime);
    this._retimer();
  }

  // ---------- realtime hint socket (optional) ----------
  _openHintSocket(rt) {
    if (!rt?.cluster || !rt?.key || !rt?.channel) return;
    this.rt = rt;
    const url = `wss://${rt.cluster}.piesocket.com/v3/${encodeURIComponent(rt.channel)}`
      + `?api_key=${encodeURIComponent(rt.key)}&notify_self=0&source=jssdk`;
    let ws;
    try { ws = new WebSocket(url); } catch (_) { this._retryHint(); return; }
    this.ws = ws;
    ws.onopen = () => { this.hintFails = 0; this._retimer(); this.poll(); };
    // The payload is deliberately meaningless: any traffic means "drain your inbox".
    ws.onmessage = () => this.poll();
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this._retimer();
      this._retryHint();
    };
  }

  _retryHint() {
    if (!this.rt || !this.open || this.hintTimer) return;
    this.hintFails = Math.min(6, this.hintFails + 1);
    const delay = 1000 * Math.pow(2, this.hintFails); // 2s … 64s, then steady
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      this._openHintSocket(this.rt);
    }, delay);
  }
}
