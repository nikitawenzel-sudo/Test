const { WebSocketServer } = require('ws');
const { sha256 } = require('@noble/hashes/sha256');
const { bytesToHex } = require('@noble/hashes/utils');
const secp256k1 = require('@noble/secp256k1');
const EventStore = require('./store');

const PORT = process.env.PORT || 8080;
const store = new EventStore();

const wss = new WebSocketServer({ port: PORT });

// Track connected clients: ws → { subscriptions: Map<subId, filter>, pubkey: string|null }
const clients = new Map();

function broadcast(event, senderWs) {
  for (const [ws, client] of clients.entries()) {
    if (ws.readyState !== 1) continue; // OPEN

    for (const [subId, filter] of client.subscriptions.entries()) {
      if (matchesFilter(event, filter)) {
        ws.send(JSON.stringify(['EVENT', subId, event]));
        break; // Only send once per client even if multiple subs match
      }
    }
  }
}

function sendToTarget(event, targetPubkey) {
  for (const [ws, client] of clients.entries()) {
    if (ws.readyState !== 1) continue;
    if (client.pubkey === targetPubkey) {
      // Send signaling event directly
      for (const [subId, filter] of client.subscriptions.entries()) {
        if (matchesFilter(event, filter)) {
          ws.send(JSON.stringify(['EVENT', subId, event]));
          break;
        }
      }
    }
  }
}

function matchesFilter(event, filter) {
  if (filter.kinds && filter.kinds.length > 0 && !filter.kinds.includes(event.kind)) {
    return false;
  }
  if (filter.authors && filter.authors.length > 0 && !filter.authors.includes(event.pubkey)) {
    return false;
  }
  if (filter.ids && filter.ids.length > 0 && !filter.ids.includes(event.id)) {
    return false;
  }
  if (filter.since && event.created_at < filter.since) {
    return false;
  }
  if (filter.until && event.created_at > filter.until) {
    return false;
  }

  // Tag filters
  if (filter['#channel'] && filter['#channel'].length > 0) {
    const eventChannels = event.tags
      .filter(t => t[0] === 'channel')
      .map(t => t[1]);
    if (!filter['#channel'].some(ch => eventChannels.includes(ch))) {
      return false;
    }
  }

  if (filter['#p'] && filter['#p'].length > 0) {
    const eventPs = event.tags
      .filter(t => t[0] === 'p')
      .map(t => t[1]);
    if (!filter['#p'].some(p => eventPs.includes(p))) {
      return false;
    }
  }

  return true;
}

function computeEventId(event) {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ]);
  return bytesToHex(sha256(new TextEncoder().encode(serialized)));
}

async function verifyEvent(event) {
  // Check required fields
  if (!event.id || !event.pubkey || !event.sig || event.kind === undefined ||
      !event.content === undefined || !event.tags || !event.created_at) {
    return false;
  }

  // Verify event ID
  const expectedId = computeEventId(event);
  if (event.id !== expectedId) {
    console.log('Invalid event ID:', event.id, '!=', expectedId);
    return false;
  }

  // Verify signature
  try {
    const sigBytes = hexToBytes(event.sig);
    const idBytes = hexToBytes(event.id);
    const pubkeyBytes = hexToBytes(event.pubkey);
    const isValid = secp256k1.schnorr.verify(sigBytes, idBytes, pubkeyBytes);
    return isValid;
  } catch (err) {
    console.log('Signature verification error:', err.message);
    return false;
  }
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function getTargetPubkey(event) {
  const pTag = event.tags.find(t => t[0] === 'p');
  return pTag ? pTag[1] : null;
}

wss.on('connection', (ws) => {
  clients.set(ws, { subscriptions: new Map(), pubkey: null });
  console.log(`Client connected (${clients.size} total)`);

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify(['NOTICE', 'Invalid JSON']));
      return;
    }

    if (!Array.isArray(msg) || msg.length < 2) {
      ws.send(JSON.stringify(['NOTICE', 'Invalid message format']));
      return;
    }

    const type = msg[0];

    if (type === 'EVENT') {
      const event = msg[1];

      const valid = await verifyEvent(event);
      if (!valid) {
        ws.send(JSON.stringify(['OK', event.id || '', false, 'invalid: signature verification failed']));
        return;
      }

      // Track client pubkey from events they send
      const client = clients.get(ws);
      if (client && !client.pubkey) {
        client.pubkey = event.pubkey;
      }

      if (event.kind === 25000) {
        // WebRTC signaling: don't store, forward to target
        const target = getTargetPubkey(event);
        if (target) {
          sendToTarget(event, target);
        } else {
          // Broadcast signaling (e.g. voice-join, voice-leave)
          broadcast(event, ws);
        }
      } else {
        // Store and broadcast
        store.saveEvent(event);
        broadcast(event, ws);
      }

      ws.send(JSON.stringify(['OK', event.id, true, '']));

    } else if (type === 'REQ') {
      if (msg.length < 3) {
        ws.send(JSON.stringify(['NOTICE', 'Invalid REQ']));
        return;
      }

      const subId = msg[1];
      const filter = msg[2];

      const client = clients.get(ws);
      if (client) {
        client.subscriptions.set(subId, filter);
      }

      // Send stored events matching the filter
      const events = store.queryEvents(filter);
      for (const event of events) {
        ws.send(JSON.stringify(['EVENT', subId, event]));
      }

      ws.send(JSON.stringify(['EOSE', subId]));

    } else if (type === 'CLOSE') {
      const subId = msg[1];
      const client = clients.get(ws);
      if (client) {
        client.subscriptions.delete(subId);
      }

    } else {
      ws.send(JSON.stringify(['NOTICE', `Unknown message type: ${type}`]));
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`Client disconnected (${clients.size} total)`);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

console.log(`NOSTR-Discord Relay running on ws://localhost:${PORT}`);

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  store.close();
  wss.close();
  process.exit(0);
});
