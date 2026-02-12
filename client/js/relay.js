// relay.js - WebSocket connection to NOSTR relay

const NostrRelay = (() => {
  let ws = null;
  let url = '';
  let subscriptions = new Map(); // subId -> { filters, callback }
  let eventCallbacks = []; // for raw event handling
  let connectCallbacks = [];
  let disconnectCallbacks = [];
  let reconnectTimer = null;
  let isConnected = false;
  let subCounter = 0;

  function connect(relayUrl) {
    url = relayUrl;
    return _doConnect();
  }

  function _doConnect() {
    return new Promise((resolve, reject) => {
      let settled = false;

      try {
        ws = new WebSocket(url);
      } catch (e) {
        reject(e);
        return;
      }

      ws.onopen = () => {
        console.log('Connected to relay:', url);
        isConnected = true;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        // Re-subscribe all active subscriptions
        for (const [subId, sub] of subscriptions.entries()) {
          const msg = ['REQ', subId, ...sub.filters];
          ws.send(JSON.stringify(msg));
        }
        connectCallbacks.forEach(cb => cb());
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      ws.onmessage = (msg) => {
        let data;
        try {
          data = JSON.parse(msg.data);
        } catch (e) {
          console.error('Invalid JSON from relay:', msg.data);
          return;
        }

        if (!Array.isArray(data)) return;

        const type = data[0];

        switch (type) {
          case 'EVENT': {
            const subId = data[1];
            const event = data[2];

            // Notify subscription callback
            const sub = subscriptions.get(subId);
            if (sub && sub.callback) {
              sub.callback(event, subId);
            }

            // Notify raw event listeners
            eventCallbacks.forEach(cb => cb(event));
            break;
          }
          case 'EOSE': {
            const subId = data[1];
            const sub = subscriptions.get(subId);
            if (sub && sub.eoseCallback) {
              sub.eoseCallback(subId);
            }
            break;
          }
          case 'OK': {
            const eventId = data[1];
            const success = data[2];
            const message = data[3] || '';
            if (!success) {
              console.warn(`Event ${eventId} rejected: ${message}`);
            }
            break;
          }
          case 'NOTICE': {
            console.log('Relay notice:', data[1]);
            break;
          }
        }
      };

      ws.onclose = () => {
        console.log('Disconnected from relay');
        isConnected = false;
        disconnectCallbacks.forEach(cb => cb());
        // Auto-reconnect after 3 seconds
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            console.log('Reconnecting...');
            _doConnect().catch(e => console.error('Reconnect failed:', e));
          }, 3000);
        }
      };

      ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
    });
  }

  function subscribe(filters, callback, eoseCallback = null) {
    const subId = 'sub_' + (++subCounter);
    const filtersArray = Array.isArray(filters) ? filters : [filters];

    subscriptions.set(subId, { filters: filtersArray, callback, eoseCallback });

    if (isConnected && ws) {
      const msg = ['REQ', subId, ...filtersArray];
      ws.send(JSON.stringify(msg));
    }

    return subId;
  }

  function unsubscribe(subId) {
    subscriptions.delete(subId);
    if (isConnected && ws) {
      ws.send(JSON.stringify(['CLOSE', subId]));
    }
  }

  function publish(event) {
    if (!isConnected || !ws) {
      console.error('Not connected to relay');
      return false;
    }
    ws.send(JSON.stringify(['EVENT', event]));
    return true;
  }

  function onConnect(callback) {
    connectCallbacks.push(callback);
  }

  function onDisconnect(callback) {
    disconnectCallbacks.push(callback);
  }

  function onEvent(callback) {
    eventCallbacks.push(callback);
  }

  function getStatus() {
    return isConnected;
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.close();
    }
    isConnected = false;
  }

  return {
    connect,
    subscribe,
    unsubscribe,
    publish,
    onConnect,
    onDisconnect,
    onEvent,
    getStatus,
    disconnect
  };
})();
