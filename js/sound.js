// Synthesized sound FX via WebAudio — no external assets needed.
export class SoundFX {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }
  _ac() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
  _tone(freq, dur, type = 'sine', gain = 0.2, when = 0, slideTo = null) {
    const ac = this._ac();
    if (!ac) return;
    const t0 = ac.currentTime + when;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }
  _noise(dur, gain = 0.25) {
    const ac = this._ac();
    if (!ac) return;
    const len = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ac.createBufferSource();
    src.buffer = buf;
    const g = ac.createGain();
    g.gain.value = gain;
    const filt = ac.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 900;
    src.connect(filt).connect(g).connect(ac.destination);
    src.start();
  }

  play(kind) {
    if (!this.enabled) return;
    switch (kind) {
      case 'select':
        this._tone(520, 0.06, 'triangle', 0.08);
        break;
      case 'move':
        this._tone(300, 0.09, 'triangle', 0.18, 0, 220);
        break;
      case 'capture':
        this._noise(0.14, 0.3);
        this._tone(160, 0.14, 'square', 0.14, 0, 90);
        break;
      case 'check':
        this._tone(660, 0.1, 'sine', 0.2);
        this._tone(880, 0.14, 'sine', 0.2, 0.1);
        break;
      case 'castle':
        this._tone(300, 0.08, 'triangle', 0.16, 0, 240);
        this._tone(300, 0.08, 'triangle', 0.16, 0.1, 240);
        break;
      case 'end':
        this._tone(523, 0.16, 'sine', 0.2);
        this._tone(659, 0.16, 'sine', 0.2, 0.12);
        this._tone(784, 0.3, 'sine', 0.2, 0.24);
        break;
      case 'illegal':
        this._tone(140, 0.12, 'sawtooth', 0.12);
        break;
    }
  }
}
