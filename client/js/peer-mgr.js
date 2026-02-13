// peer-mgr.js - Peer Connection Manager
// Limits direct WebRTC connections, scores peers, handles discovery

const PeerManager = (() => {
  const MAX_PEERS = 5;
  const MIN_PEERS = 3;
  const EVAL_INTERVAL = 30000; // 30 seconds
  const SCORE_DECAY = 0.95;

  // peerId -> { pubkey, nickname, score, lastSeen, messagesRelayed, failedDeliveries, verified, latency }
  let activePeers = new Map();
  // peerId -> { pubkey, lastSeen, hopCount }
  let knownPeers = new Map();

  let evalTimer = null;
  let discoveryCallback = null; // Called when we need more peers
  let disconnectCallback = null; // Called to disconnect a peer

  function start() {
    if (evalTimer) clearInterval(evalTimer);
    evalTimer = setInterval(evaluatePeers, EVAL_INTERVAL);
  }

  function stop() {
    if (evalTimer) { clearInterval(evalTimer); evalTimer = null; }
  }

  // ====== PEER SCORING ======

  function scorePeer(peerId) {
    const peer = activePeers.get(peerId);
    if (!peer) return 0;

    let score = 0;
    // +50 if verified
    if (peer.verified) score += 50;
    // +max(0, 100 - latency) for low latency
    if (peer.latency !== undefined) {
      score += Math.max(0, 100 - peer.latency);
    } else {
      score += 50; // Default if unknown
    }
    // +0.1 per relayed message
    score += (peer.messagesRelayed || 0) * 0.1;
    // -5 per failed delivery
    score -= (peer.failedDeliveries || 0) * 5;
    // Time decay
    score *= SCORE_DECAY;

    peer.score = score;
    return score;
  }

  // ====== PEER ACCEPTANCE ======

  function shouldAcceptPeer(newPeerId) {
    if (activePeers.size < MAX_PEERS) return true;

    // Find weakest peer
    let weakest = null;
    let weakestScore = Infinity;
    for (const [peerId, peer] of activePeers) {
      const s = scorePeer(peerId);
      if (s < weakestScore) {
        weakestScore = s;
        weakest = peerId;
      }
    }

    // Accept new peer if weakest has score < 30
    if (weakest && weakestScore < 30) {
      // Disconnect weakest peer
      if (disconnectCallback) {
        disconnectCallback(weakest);
      }
      activePeers.delete(weakest);
      return true;
    }

    return false;
  }

  // ====== PEER LIFECYCLE ======

  function addPeer(peerId, info) {
    activePeers.set(peerId, {
      pubkey: info.pubkey || null,
      nickname: info.nickname || null,
      score: 50, // Default score
      lastSeen: Date.now(),
      messagesRelayed: 0,
      failedDeliveries: 0,
      verified: info.verified || false,
      latency: undefined
    });
  }

  function removePeer(peerId) {
    const peer = activePeers.get(peerId);
    if (peer && peer.pubkey) {
      // Remember in knownPeers for potential reconnection
      knownPeers.set(peerId, {
        pubkey: peer.pubkey,
        lastSeen: Date.now(),
        hopCount: 0
      });
    }
    activePeers.delete(peerId);
  }

  function updatePeer(peerId, updates) {
    const peer = activePeers.get(peerId);
    if (!peer) return;
    Object.assign(peer, updates);
    peer.lastSeen = Date.now();
  }

  function recordRelay(peerId) {
    const peer = activePeers.get(peerId);
    if (peer) peer.messagesRelayed++;
  }

  function recordFailure(peerId) {
    const peer = activePeers.get(peerId);
    if (peer) peer.failedDeliveries++;
  }

  function updateLatency(peerId, latencyMs) {
    const peer = activePeers.get(peerId);
    if (peer) peer.latency = latencyMs;
  }

  // ====== PEER DISCOVERY ======

  // Returns list of our active peer IDs for exchange
  function getDiscoveryPayload() {
    return {
      type: 'peer-discovery',
      myPeers: Array.from(activePeers.keys())
    };
  }

  function handleDiscoveryResponse(peerIds) {
    for (const peerId of peerIds) {
      if (!activePeers.has(peerId) && !knownPeers.has(peerId)) {
        knownPeers.set(peerId, {
          pubkey: null,
          lastSeen: Date.now(),
          hopCount: 1
        });
      }
    }
  }

  function requestMorePeers() {
    if (discoveryCallback) {
      discoveryCallback(getDiscoveryPayload());
    }
  }

  // ====== PERIODIC EVALUATION ======

  function evaluatePeers() {
    // Score all peers
    for (const peerId of activePeers.keys()) {
      scorePeer(peerId);
    }

    // Need more peers?
    if (activePeers.size < MIN_PEERS) {
      requestMorePeers();
    }

    // Too many peers? Disconnect weakest
    while (activePeers.size > MAX_PEERS) {
      let weakest = null;
      let weakestScore = Infinity;
      for (const [peerId, peer] of activePeers) {
        if (peer.score < weakestScore) {
          weakestScore = peer.score;
          weakest = peerId;
        }
      }
      if (weakest) {
        if (disconnectCallback) disconnectCallback(weakest);
        activePeers.delete(weakest);
      } else {
        break;
      }
    }

    // Clean old known peers (older than 10 minutes)
    const cutoff = Date.now() - 600000;
    for (const [peerId, info] of knownPeers) {
      if (info.lastSeen < cutoff) knownPeers.delete(peerId);
    }
  }

  // ====== CALLBACKS ======

  function onNeedDiscovery(cb) { discoveryCallback = cb; }
  function onDisconnectPeer(cb) { disconnectCallback = cb; }

  // ====== GETTERS ======

  function getActivePeers() { return activePeers; }
  function getKnownPeers() { return knownPeers; }
  function getActiveCount() { return activePeers.size; }
  function getKnownCount() { return knownPeers.size; }

  function getPeerScore(peerId) {
    const peer = activePeers.get(peerId);
    return peer ? peer.score : 0;
  }

  function getStats() {
    return {
      active: activePeers.size,
      known: knownPeers.size,
      maxPeers: MAX_PEERS,
      minPeers: MIN_PEERS
    };
  }

  return {
    start,
    stop,
    scorePeer,
    shouldAcceptPeer,
    addPeer,
    removePeer,
    updatePeer,
    recordRelay,
    recordFailure,
    updateLatency,
    getDiscoveryPayload,
    handleDiscoveryResponse,
    requestMorePeers,
    onNeedDiscovery,
    onDisconnectPeer,
    getActivePeers,
    getKnownPeers,
    getActiveCount,
    getKnownCount,
    getPeerScore,
    getStats,
    MAX_PEERS,
    MIN_PEERS
  };
})();
