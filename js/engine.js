// Stockfish.js wrapper running in a Web Worker via UCI protocol.
// The worker is same-origin (blob) and importScripts the CDN engine,
// which avoids cross-origin worker restrictions.

const STOCKFISH_URL = 'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js';

// Map difficulty level (1-5) -> UCI Skill Level + depth + move time (ms)
const LEVELS = {
  1: { skill: 0,  depth: 1,  movetime: 200 },
  2: { skill: 3,  depth: 3,  movetime: 500 },
  3: { skill: 8,  depth: 6,  movetime: 1000 },
  4: { skill: 14, depth: 10, movetime: 2000 },
  5: { skill: 20, depth: 14, movetime: 3500 },
};

export class Engine {
  constructor() {
    this.worker = null;
    this.ready = false;
    this._pending = null; // resolver for current search
    this.level = 3;
  }

  /** Lazily create the worker. Resolves when uciok/isready received. */
  async start() {
    if (this.ready) return;
    const blob = new Blob([`importScripts(${JSON.stringify(STOCKFISH_URL)});`], {
      type: 'application/javascript',
    });
    this.worker = new Worker(URL.createObjectURL(blob));
    this.worker.onmessage = (e) => this._onMessage(e.data);

    this.worker.postMessage('uci');
    await this._waitFor((line) => line === 'uciok');
    this.worker.postMessage('isready');
    await this._waitFor((line) => line === 'readyok');
    this.ready = true;
  }

  _waitFor(predicate) {
    return new Promise((resolve) => {
      this._initWaiter = { predicate, resolve };
    });
  }

  _onMessage(data) {
    const line = String(data).trim();

    if (this._initWaiter && this._initWaiter.predicate(line)) {
      this._initWaiter.resolve();
      this._initWaiter = null;
      return;
    }

    if (this._pending && line.startsWith('bestmove')) {
      const parts = line.split(/\s+/);
      const best = parts[1];
      const resolve = this._pending;
      this._pending = null;
      resolve(best && best !== '(none)' ? best : null);
    }
  }

  /**
   * Find best move for a position.
   * @param {string} fen
   * @param {number} level 1-5
   * @returns {Promise<string|null>} move in UCI format, e.g. "e2e4" or "e7e8q"
   */
  async getBestMove(fen, level = this.level) {
    await this.start();
    this.level = level;
    const cfg = LEVELS[level] || LEVELS[3];

    return new Promise((resolve) => {
      this._pending = resolve;
      const w = this.worker;
      w.postMessage('ucinewgame');
      w.postMessage('isready');
      // set skill level
      w.postMessage(`setoption name Skill Level value ${cfg.skill}`);
      w.postMessage(`position fen ${fen}`);
      w.postMessage(`go depth ${cfg.depth} movetime ${cfg.movetime}`);
    });
  }

  stop() {
    if (this.worker) {
      this.worker.postMessage('stop');
    }
  }

  destroy() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.ready = false;
    }
  }
}
