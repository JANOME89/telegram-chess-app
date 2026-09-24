// Stockfish.js in a same-origin blob worker (UCI protocol).
const STOCKFISH_URL = 'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js';

const LEVELS = {
  1: { skill: 0, depth: 1, movetime: 200 },
  2: { skill: 3, depth: 3, movetime: 500 },
  3: { skill: 8, depth: 6, movetime: 1000 },
  4: { skill: 14, depth: 10, movetime: 2000 },
  5: { skill: 20, depth: 14, movetime: 3500 },
};

export class Engine {
  constructor() {
    this.worker = null;
    this.ready = false;
    this._pending = null;
    this._initWaiter = null;
  }

  async start() {
    if (this.ready) return;
    const blob = new Blob([`importScripts(${JSON.stringify(STOCKFISH_URL)});`], {
      type: 'application/javascript',
    });
    this.worker = new Worker(URL.createObjectURL(blob));
    this.worker.onmessage = (e) => this._onMessage(String(e.data).trim());
    this.worker.postMessage('uci');
    await this._waitFor((l) => l === 'uciok');
    this.worker.postMessage('isready');
    await this._waitFor((l) => l === 'readyok');
    this.ready = true;
  }

  _waitFor(predicate) {
    return new Promise((resolve) => { this._initWaiter = { predicate, resolve }; });
  }

  _onMessage(line) {
    if (this._initWaiter && this._initWaiter.predicate(line)) {
      this._initWaiter.resolve();
      this._initWaiter = null;
      return;
    }
    if (this._pending && line.startsWith('bestmove')) {
      const best = line.split(/\s+/)[1];
      const resolve = this._pending;
      this._pending = null;
      resolve(best && best !== '(none)' ? best : null);
    }
  }

  async getBestMove(fen, level) {
    await this.start();
    const cfg = LEVELS[level] || LEVELS[3];
    return new Promise((resolve) => {
      this._pending = resolve;
      const w = this.worker;
      w.postMessage('ucinewgame');
      w.postMessage('isready');
      w.postMessage(`setoption name Skill Level value ${cfg.skill}`);
      w.postMessage(`position fen ${fen}`);
      w.postMessage(`go depth ${cfg.depth} movetime ${cfg.movetime}`);
    });
  }

  stop() { this.worker?.postMessage('stop'); }
}
