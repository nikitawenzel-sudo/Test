export class RelayConnection {
  constructor() {
    this.ws = null;
    this.url = null;
    this.subscriptions = new Map(); // subId → callback
    this.subCounter = 0;
    this.reconnectTimeout = null;
    this.onConnectCallback = null;
    this.onDisconnectCallback = null;
    this.signalingCallback = null;
  }

  connect(url) {
    this.url = url;
    this._connect();
  }

  _connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('Connected to relay:', this.url);
      if (this.onConnectCallback) this.onConnectCallback();

      // Re-subscribe existing subscriptions
      for (const [subId, { filter }] of this.subscriptions.entries()) {
        this.ws.send(JSON.stringify(['REQ', subId, filter]));
      }
    };

    this.ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }

      if (!Array.isArray(msg)) return;

      const type = msg[0];

      if (type === 'EVENT') {
        const subId = msg[1];
        const event = msg[2];

        // Route signaling events
        if (event.kind === 25000 && this.signalingCallback) {
          this.signalingCallback(event);
        }

        const sub = this.subscriptions.get(subId);
        if (sub && sub.callback) {
          sub.callback(event);
        }
      } else if (type === 'EOSE') {
        const subId = msg[1];
        const sub = this.subscriptions.get(subId);
        if (sub && sub.eoseCallback) {
          sub.eoseCallback();
        }
      } else if (type === 'OK') {
        // Event accepted/rejected
        const eventId = msg[1];
        const accepted = msg[2];
        if (!accepted) {
          console.warn('Event rejected:', eventId, msg[3]);
        }
      } else if (type === 'NOTICE') {
        console.warn('Relay notice:', msg[1]);
      }
    };

    this.ws.onclose = () => {
      console.log('Disconnected from relay');
      if (this.onDisconnectCallback) this.onDisconnectCallback();
      this._scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  _scheduleReconnect() {
    if (this.reconnectTimeout) return;
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      console.log('Reconnecting...');
      this._connect();
    }, 3000);
  }

  subscribe(filter, callback, eoseCallback = null) {
    const subId = 'sub_' + (++this.subCounter);
    this.subscriptions.set(subId, { filter, callback, eoseCallback });

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(['REQ', subId, filter]));
    }

    return subId;
  }

  unsubscribe(subId) {
    this.subscriptions.delete(subId);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(['CLOSE', subId]));
    }
  }

  publish(event) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(['EVENT', event]));
    } else {
      console.warn('Not connected to relay');
    }
  }

  onSignaling(callback) {
    this.signalingCallback = callback;
  }

  onConnect(callback) {
    this.onConnectCallback = callback;
  }

  onDisconnect(callback) {
    this.onDisconnectCallback = callback;
  }

  disconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get connected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}
