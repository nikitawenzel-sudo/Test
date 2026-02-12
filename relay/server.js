const { WebSocketServer } = require('ws');
const EventStore = require('./store');

const PORT = process.env.PORT || 8080;
const MAX_CONNECTIONS = 10;

// Start server with async init (needed for ESM-only @noble/curves)
(async () => {
  // Dynamic imports for ESM-only modules
  const { sha256 } = await import('@noble/hashes/sha256');
  const { bytesToHex, hexToBytes } = await import('@noble/hashes/utils');
  const { schnorr } = await import('@noble/curves/secp256k1.js');

  const store = new EventStore();
  const wss = new WebSocketServer({ port: PORT });

  // Map: WebSocket -> { pubkey, subscriptions: Map<subId, filter> }
  const clients = new Map();

  console.log(`NOSTR-Discord Relay running on ws://localhost:${PORT}`);

  function serializeEventForId(event) {
    return JSON.stringify([
      0,
      event.pubkey,
      event.created_at,
      event.kind,
      event.tags,
      event.content
    ]);
  }

  function computeEventId(event) {
    const serialized = serializeEventForId(event);
    const hash = sha256(new TextEncoder().encode(serialized));
    return bytesToHex(hash);
  }

  function verifySignature(event) {
    try {
      const eventId = computeEventId(event);
      if (eventId !== event.id) {
        console.log('Event ID mismatch:', eventId, '!=', event.id);
        return false;
      }
      // Verify schnorr signature
      const sigBytes = hexToBytes(event.sig);
      const idBytes = hexToBytes(event.id);
      const pubkeyBytes = hexToBytes(event.pubkey);
      return schnorr.verify(sigBytes, idBytes, pubkeyBytes);
    } catch (e) {
      console.error('Signature verification error:', e.message);
      return false;
    }
  }

  function matchesFilter(event, filter) {
    if (filter.ids && !filter.ids.includes(event.id)) return false;
    if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
    if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
    if (filter.since && event.created_at < filter.since) return false;
    if (filter.until && event.created_at > filter.until) return false;

    // Tag filters
    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith('#') && Array.isArray(values)) {
        const tagName = key.slice(1);
        const eventTagValues = event.tags
          .filter(t => t[0] === tagName)
          .map(t => t[1]);
        if (!values.some(v => eventTagValues.includes(v))) return false;
      }
    }

    return true;
  }

  function broadcastEvent(event, senderWs) {
    for (const [ws, client] of clients.entries()) {
      // Für Signaling-Events: nur an den Ziel-Pubkey senden
      if (event.kind === 25000) {
        const targetPubkey = event.tags.find(t => t[0] === 'p')?.[1];
        if (targetPubkey && client.pubkey !== targetPubkey) continue;
      }

      // Prüfe alle Subscriptions des Clients
      for (const [subId, filters] of client.subscriptions.entries()) {
        const filtersArray = Array.isArray(filters) ? filters : [filters];
        for (const filter of filtersArray) {
          if (matchesFilter(event, filter)) {
            try {
              ws.send(JSON.stringify(['EVENT', subId, event]));
            } catch (e) {
              console.error('Send error:', e.message);
            }
            break; // Nur einmal pro Subscription
          }
        }
      }
    }
  }

  function getOnlinePubkeys() {
    const pubkeys = [];
    for (const [ws, client] of clients.entries()) {
      if (client.pubkey && ws.readyState === 1) {
        pubkeys.push(client.pubkey);
      }
    }
    return [...new Set(pubkeys)];
  }

  wss.on('connection', (ws) => {
    if (clients.size >= MAX_CONNECTIONS) {
      ws.send(JSON.stringify(['NOTICE', 'Server full. Max 10 connections.']));
      ws.close();
      return;
    }

    const clientData = { pubkey: null, subscriptions: new Map() };
    clients.set(ws, clientData);
    console.log(`Client connected. Total: ${clients.size}`);

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        ws.send(JSON.stringify(['NOTICE', 'Invalid JSON']));
        return;
      }

      if (!Array.isArray(msg) || msg.length < 2) {
        ws.send(JSON.stringify(['NOTICE', 'Invalid message format']));
        return;
      }

      const type = msg[0];

      switch (type) {
        case 'EVENT': {
          const event = msg[1];

          // Validiere Event-Struktur
          if (!event || !event.id || !event.pubkey || !event.sig ||
              event.kind === undefined || event.content === undefined || !Array.isArray(event.tags)) {
            ws.send(JSON.stringify(['OK', event?.id || '', false, 'invalid: missing fields']));
            return;
          }

          // Validiere Signatur
          if (!verifySignature(event)) {
            ws.send(JSON.stringify(['OK', event.id, false, 'invalid: bad signature']));
            return;
          }

          // Setze Pubkey des Clients
          clientData.pubkey = event.pubkey;

          // Speichere Event (nicht für kind 25000)
          const saved = store.saveEvent(event);

          // Bestätige
          ws.send(JSON.stringify(['OK', event.id, true, '']));

          // Broadcast an alle passenden Subscriber
          broadcastEvent(event, ws);
          break;
        }

        case 'REQ': {
          const subId = msg[1];
          const filters = msg.slice(2); // Kann mehrere Filter haben

          if (!subId || filters.length === 0) {
            ws.send(JSON.stringify(['NOTICE', 'Invalid REQ']));
            return;
          }

          // Speichere Subscription
          clientData.subscriptions.set(subId, filters);

          // Sende gespeicherte Events die zum Filter passen
          for (const filter of filters) {
            const events = store.queryEvents(filter);
            // Events in chronologischer Reihenfolge senden
            events.reverse().forEach(event => {
              ws.send(JSON.stringify(['EVENT', subId, event]));
            });
          }

          // End of stored events
          ws.send(JSON.stringify(['EOSE', subId]));
          break;
        }

        case 'CLOSE': {
          const subId = msg[1];
          clientData.subscriptions.delete(subId);
          break;
        }

        default:
          ws.send(JSON.stringify(['NOTICE', `Unknown message type: ${type}`]));
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`Client disconnected. Total: ${clients.size}`);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
      clients.delete(ws);
    });
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    store.close();
    wss.close();
    process.exit(0);
  });
})();
