// Thin WebSocket client with typed event handlers.
export class Net {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.handlers = {};
    this.open = false;
  }

  on(type, fn) {
    (this.handlers[type] ||= []).push(fn);
    return this;
  }
  _emit(type, payload) {
    (this.handlers[type] || []).forEach((fn) => fn(payload));
  }

  connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
      } catch (e) {
        reject(e);
        return;
      }
      this.ws.onopen = () => { this.open = true; this._emit('open'); resolve(); };
      this.ws.onerror = () => { this._emit('error'); };
      this.ws.onclose = () => { this.open = false; this._emit('close'); };
      this.ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        this._emit(msg.t, msg);
      };
    });
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  close() {
    this.handlers = {};
    this.open = false;
    try { this.ws?.close(); } catch (_) {}
    this.ws = null;
  }
}
