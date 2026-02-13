// gossip.js - Gossip Protocol for Scalable Message Distribution
// Messages are forwarded to FANOUT random peers, with TTL and duplicate detection

const Gossip = (() => {
  const FANOUT = 3;
  const MAX_TTL = 10;
  const SEEN_CACHE_SIZE = 10000;
  const SEEN_TTL = 300000; // 5 minutes

  // msgId -> timestamp
  let seenMessages = new Map();
  let sendGossipFn = null; // Set by p2p.js integration
  let messageHandlers = {}; // type -> handler function

  // ====== SEEN CACHE (Duplicate Detection) ======

  function markSeen(msgId) {
    seenMessages.set(msgId, Date.now());
    // Cleanup old entries
    if (seenMessages.size > SEEN_CACHE_SIZE) {
      const cutoff = Date.now() - SEEN_TTL;
      for (const [id, ts] of seenMessages) {
        if (ts < cutoff) seenMessages.delete(id);
      }
    }
  }

  function hasSeen(msgId) {
    return seenMessages.has(msgId);
  }

  // ====== MESSAGE WRAPPING ======

  function wrapMessage(payload, originPeerId) {
    return {
      gossip: {
        msgId: crypto.randomUUID(),
        origin: originPeerId,
        ttl: MAX_TTL,
        hops: 0,
        timestamp: Date.now()
      },
      payload: payload
    };
  }

  // ====== RECEIVE + FORWARD ======

  function handleIncoming(gossipMsg, fromPeerId) {
    if (!gossipMsg || !gossipMsg.gossip) return null;

    const { msgId, ttl } = gossipMsg.gossip;

    // Duplicate check
    if (hasSeen(msgId)) return null;

    // TTL check
    if (ttl <= 0) return null;

    markSeen(msgId);

    // Record relay for PeerManager scoring
    PeerManager.recordRelay(fromPeerId);

    // Forward to other peers
    forward(gossipMsg, fromPeerId);

    // Return payload for local processing
    return gossipMsg.payload;
  }

  // ====== FORWARDING ======

  function forward(gossipMsg, excludePeerId) {
    if (!sendGossipFn) return;

    const activePeers = PeerManager.getActivePeers();
    const origin = gossipMsg.gossip.origin;

    // Build candidate list (exclude sender and origin)
    const candidates = [];
    for (const [peerId] of activePeers) {
      if (peerId !== excludePeerId && peerId !== origin) {
        candidates.push(peerId);
      }
    }

    // Shuffle and pick FANOUT targets
    shuffleArray(candidates);
    const targets = candidates.slice(0, FANOUT);

    // Forward with decremented TTL
    const forwarded = {
      gossip: {
        ...gossipMsg.gossip,
        ttl: gossipMsg.gossip.ttl - 1,
        hops: gossipMsg.gossip.hops + 1
      },
      payload: gossipMsg.payload
    };

    const data = JSON.stringify(forwarded);
    for (const targetPeerId of targets) {
      try {
        sendGossipFn(data, targetPeerId);
      } catch (e) {
        PeerManager.recordFailure(targetPeerId);
      }
    }
  }

  // ====== BROADCAST (own messages) ======

  function broadcast(payload, myPeerId) {
    const msg = wrapMessage(payload, myPeerId);
    markSeen(msg.gossip.msgId);

    if (!sendGossipFn) return;

    // First hop: send to ALL active peers (full coverage)
    const data = JSON.stringify(msg);
    const activePeers = PeerManager.getActivePeers();
    for (const [peerId] of activePeers) {
      try {
        sendGossipFn(data, peerId);
      } catch (e) {
        PeerManager.recordFailure(peerId);
      }
    }
  }

  // ====== HANDLER REGISTRATION ======

  function onMessage(type, handler) {
    messageHandlers[type] = handler;
  }

  function getHandler(type) {
    return messageHandlers[type] || null;
  }

  // ====== SETUP ======

  function setSendFunction(fn) {
    sendGossipFn = fn;
  }

  // ====== UTILS ======

  function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function getStats() {
    return {
      seenCacheSize: seenMessages.size,
      fanout: FANOUT,
      maxTTL: MAX_TTL,
      handlers: Object.keys(messageHandlers)
    };
  }

  return {
    broadcast,
    handleIncoming,
    onMessage,
    getHandler,
    setSendFunction,
    getStats,
    FANOUT,
    MAX_TTL
  };
})();
