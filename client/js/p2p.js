// p2p.js - P2P Networking Layer (Trystero + Yjs + Challenge-Response Auth)
// Replaces relay.js - No server needed!

const P2P = (() => {
  let room = null;
  let ydoc = null;
  let provider = null; // EncryptedPersistence provider
  let keyPair = null;
  let roomId = null;
  let peers = new Map(); // peerId -> { pubkey, nickname, avatar, verified }
  let connectCallbacks = [];
  let disconnectCallbacks = [];
  let peerJoinCallbacks = [];
  let peerLeaveCallbacks = [];
  let metaUpdateCallbacks = [];

  // Trystero actions
  let sendYjsSync = null;
  let sendYjsUpdate = null;
  let sendMeta = null;
  let sendChat = null;
  let sendNickRequest = null;

  // Challenge-Response actions
  let sendChallenge = null;
  let sendChallengeResp = null;
  let pendingChallenges = new Map(); // peerId -> nonce (hex)
  let verifiedPeers = new Set(); // Set of verified peerIds

  // Sender Key Exchange actions
  let sendSenderKey = null;

  // Stream handling
  let voiceStreamCallbacks = [];
  let screenStreamCallbacks = [];
  let streamRemovedCallbacks = [];

  // Track connected peer count
  let peerCount = 0;
  let isConnected = false;

  // Yjs awareness-like: track who's online
  let onlineUsers = new Map(); // pubkey -> { nickname, avatar, lastSeen }

  function init(keys) {
    keyPair = keys;
  }

  async function connect(id) {
    roomId = id;

    // Initialize Yjs document
    ydoc = new window.Yjs.Doc();

    // Encrypted IndexedDB persistence (replaces y-indexeddb)
    provider = await EncryptedPersistence.bind(ydoc, roomId, keyPair.privateKey);
    console.log('Encrypted persistence bound');

    // Initialize Ratchet for forward secrecy
    Ratchet.init(keyPair, provider);
    await Ratchet.restoreState();

    // Join Trystero room via NOSTR relays for signaling
    const config = {
      appId: 'nostr-discord-p2p-' + roomId,
      relayUrls: [
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.nostr.band'
      ]
    };

    room = window.trysteroJoinRoom(config, roomId);

    // Setup data channels for Yjs sync
    [sendYjsSync, room._recvYjsSync] = room.makeAction('yjs-sync');
    [sendYjsUpdate, room._recvYjsUpdate] = room.makeAction('yjs-update');
    [sendMeta, room._recvMeta] = room.makeAction('meta');
    [sendChat, room._recvChat] = room.makeAction('chat-msg');
    [sendNickRequest, room._recvNickRequest] = room.makeAction('nick-req');

    // Setup challenge-response actions
    [sendChallenge, room._recvChallenge] = room.makeAction('auth-challenge');
    [sendChallengeResp, room._recvChallengeResp] = room.makeAction('auth-resp');

    // Setup sender key exchange action
    let recvSenderKey;
    [sendSenderKey, recvSenderKey] = room.makeAction('sender-key');

    // Handle incoming sender keys (for forward secrecy)
    recvSenderKey(async (data, peerId) => {
      try {
        const msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(new Uint8Array(data)));
        await Ratchet.receiveSenderKey(msg.pubkey, msg.wrappedKey, msg.chainIndex);
      } catch (e) {
        console.error('Sender key receive error:', e);
      }
    });

    // ====== CHALLENGE-RESPONSE PROTOCOL ======

    // When we receive a challenge: sign it and send back proof
    room._recvChallenge(async (data, peerId) => {
      try {
        const nonce = typeof data === 'string' ? data : new TextDecoder().decode(new Uint8Array(data));
        // Hash the nonce (Schnorr needs 32-byte message)
        const nonceHash = await NostrCrypto.hashNonce(nonce);
        // Sign with our private key
        const sig = await NostrCrypto.schnorrSign(nonceHash, keyPair.privateKey);
        // Send back our pubkey + signature as proof
        sendChallengeResp(JSON.stringify({
          pubkey: keyPair.publicKey,
          sig: sig
        }), peerId);
      } catch (e) {
        console.error('Challenge response error:', e);
      }
    });

    // When we receive a challenge response: verify the proof
    room._recvChallengeResp(async (data, peerId) => {
      try {
        const resp = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(new Uint8Array(data)));
        const nonce = pendingChallenges.get(peerId);
        if (!nonce) return;

        // Hash the nonce the same way
        const nonceHash = await NostrCrypto.hashNonce(nonce);
        // Verify: does the signature match the claimed pubkey?
        const valid = await NostrCrypto.schnorrVerify(resp.sig, nonceHash, resp.pubkey);

        if (valid) {
          verifiedPeers.add(peerId);
          // Update peer info with VERIFIED pubkey
          const peerInfo = peers.get(peerId);
          if (peerInfo) {
            peerInfo.pubkey = resp.pubkey;
            peerInfo.verified = true;
          }
          console.log('Peer VERIFIED:', peerId, resp.pubkey.slice(0, 8) + '...');
          metaUpdateCallbacks.forEach(cb => cb(resp.pubkey, {
            pubkey: resp.pubkey,
            nickname: peerInfo?.nickname,
            avatar: peerInfo?.avatar,
            verified: true
          }));

          // Send our sender key to verified peer (forward secrecy)
          try {
            const senderKeyMsg = await Ratchet.getSenderKeyForPeer(resp.pubkey);
            sendSenderKey(JSON.stringify(senderKeyMsg), peerId);
          } catch (e) {
            console.error('Sender key send error:', e);
          }
        } else {
          console.warn('Peer FAILED verification:', peerId);
          const peerInfo = peers.get(peerId);
          if (peerInfo) {
            peerInfo.verified = false;
          }
        }
        pendingChallenges.delete(peerId);
      } catch (e) {
        console.error('Challenge verify error:', e);
      }
    });

    // ====== YJS SYNC ======

    // Handle Yjs sync - when a new peer connects, exchange state
    room._recvYjsSync((data, peerId) => {
      try {
        const remoteVector = new Uint8Array(data);
        const update = window.Yjs.encodeStateAsUpdate(ydoc, remoteVector);
        sendYjsUpdate(update, peerId);
      } catch (e) {
        console.error('Yjs sync error:', e);
      }
    });

    // Apply incoming Yjs updates
    room._recvYjsUpdate((data, peerId) => {
      try {
        const update = new Uint8Array(data);
        window.Yjs.applyUpdate(ydoc, update);
      } catch (e) {
        console.error('Yjs update error:', e);
      }
    });

    // Broadcast local Yjs changes to all peers
    ydoc.on('update', (update, origin) => {
      if (origin !== 'remote' && room && peerCount > 0) {
        sendYjsUpdate(update);
      }
    });

    // ====== METADATA EXCHANGE ======

    // Handle metadata exchange (pubkey, nickname, avatar)
    room._recvMeta((data, peerId) => {
      try {
        const meta = typeof data === 'string' ? JSON.parse(data) : data;
        const existing = peers.get(peerId);
        peers.set(peerId, {
          pubkey: meta.pubkey,
          nickname: meta.nickname,
          avatar: meta.avatar || null,
          verified: existing?.verified || false // Keep verified state
        });
        onlineUsers.set(meta.pubkey, {
          nickname: meta.nickname,
          avatar: meta.avatar || null,
          peerId: peerId,
          verified: existing?.verified || false,
          lastSeen: Date.now()
        });
        metaUpdateCallbacks.forEach(cb => cb(meta.pubkey, {
          ...meta,
          verified: existing?.verified || false
        }));
      } catch (e) {
        console.error('Meta parse error:', e);
      }
    });

    // Handle nickname requests
    room._recvNickRequest((data, peerId) => {
      broadcastMeta();
    });

    // ====== PEER MANAGEMENT ======

    // Handle peer join
    room.onPeerJoin(peerId => {
      peerCount++;
      console.log('Peer joined:', peerId, '(total:', peerCount, ')');

      if (!isConnected) {
        isConnected = true;
        connectCallbacks.forEach(cb => cb());
      }

      // Send our metadata
      const meta = {
        pubkey: keyPair.publicKey,
        nickname: NostrCrypto.getNickname() || NostrCrypto.shortenPubkey(keyPair.publicKey),
        avatar: NostrCrypto.getAvatar()
      };
      sendMeta(JSON.stringify(meta), peerId);

      // Request their metadata
      sendNickRequest('req', peerId);

      // CHALLENGE: Send a random nonce for identity verification
      const nonce = NostrCrypto.randomNonce();
      pendingChallenges.set(peerId, nonce);
      sendChallenge(nonce, peerId);

      // Sync Yjs state
      const sv = window.Yjs.encodeStateVector(ydoc);
      sendYjsSync(sv, peerId);

      peerJoinCallbacks.forEach(cb => cb(peerId));
      _updateStatus();
    });

    // Handle peer leave
    room.onPeerLeave(peerId => {
      peerCount = Math.max(0, peerCount - 1);
      console.log('Peer left:', peerId, '(total:', peerCount, ')');

      const peerInfo = peers.get(peerId);
      if (peerInfo) {
        onlineUsers.delete(peerInfo.pubkey);
      }
      peers.delete(peerId);
      verifiedPeers.delete(peerId);
      pendingChallenges.delete(peerId);

      if (peerCount === 0) {
        isConnected = false;
        disconnectCallbacks.forEach(cb => cb());
      }

      peerLeaveCallbacks.forEach(cb => cb(peerId, peerInfo));
      streamRemovedCallbacks.forEach(cb => cb(peerId));
      _updateStatus();
    });

    // Handle incoming streams (voice + screen)
    room.onPeerStream((stream, peerId, metadata) => {
      const type = metadata?.type || 'voice';
      console.log('Received stream from', peerId, 'type:', type);

      if (type === 'voice') {
        voiceStreamCallbacks.forEach(cb => cb(stream, peerId));
      } else if (type === 'screen') {
        screenStreamCallbacks.forEach(cb => cb(stream, peerId));
      }
    });

    // Mark as "connected" (we're in the room, waiting for peers)
    isConnected = true;
    _updateStatus();
    connectCallbacks.forEach(cb => cb());

    console.log('P2P room joined:', roomId);
    return true;
  }

  function _updateStatus() {
    // Trigger UI update through callbacks
  }

  // Broadcast our metadata to all peers
  function broadcastMeta() {
    if (!room) return;
    const meta = {
      pubkey: keyPair.publicKey,
      nickname: NostrCrypto.getNickname() || NostrCrypto.shortenPubkey(keyPair.publicKey),
      avatar: NostrCrypto.getAvatar()
    };
    sendMeta(JSON.stringify(meta));
  }

  // Get the Yjs document
  function getDoc() {
    return ydoc;
  }

  // Get messages array for a channel
  function getMessages(channel) {
    if (!ydoc) return null;
    return ydoc.getArray('messages-' + channel);
  }

  // Add a stream (voice or screen) to share with peers
  function addStream(stream, metadata) {
    if (!room) return;
    room.addStream(stream, metadata);
  }

  // Remove a stream
  function removeStream(stream, metadata) {
    if (!room) return;
    room.removeStream(stream, metadata);
  }

  // Send a chat action (for real-time typing, etc.)
  function sendChatAction(data) {
    if (!room || !sendChat) return;
    sendChat(JSON.stringify(data));
  }

  // Resolve peerId to pubkey
  function getPubkeyForPeer(peerId) {
    const info = peers.get(peerId);
    return info ? info.pubkey : null;
  }

  // Resolve pubkey to peerId
  function getPeerIdForPubkey(pubkey) {
    for (const [peerId, info] of peers.entries()) {
      if (info.pubkey === pubkey) return peerId;
    }
    return null;
  }

  // Get peer info by peerId
  function getPeerInfo(peerId) {
    return peers.get(peerId) || null;
  }

  // Check if a peer's identity is verified via challenge-response
  function isPeerVerified(peerId) {
    return verifiedPeers.has(peerId);
  }

  // Check if a pubkey belongs to a verified peer
  function isPubkeyVerified(pubkey) {
    for (const [peerId, info] of peers.entries()) {
      if (info.pubkey === pubkey && info.verified) return true;
    }
    return false;
  }

  // Get all online users
  function getOnlineUsers() {
    return onlineUsers;
  }

  // Get peer count
  function getPeerCount() {
    return peerCount;
  }

  // Get verified peer count
  function getVerifiedCount() {
    return verifiedPeers.size;
  }

  // Connection status
  function getStatus() {
    return isConnected;
  }

  // Event callbacks
  function onConnect(cb) { connectCallbacks.push(cb); }
  function onDisconnect(cb) { disconnectCallbacks.push(cb); }
  function onPeerJoin(cb) { peerJoinCallbacks.push(cb); }
  function onPeerLeave(cb) { peerLeaveCallbacks.push(cb); }
  function onMetaUpdate(cb) { metaUpdateCallbacks.push(cb); }
  function onVoiceStream(cb) { voiceStreamCallbacks.push(cb); }
  function onScreenStream(cb) { screenStreamCallbacks.push(cb); }
  function onStreamRemoved(cb) { streamRemovedCallbacks.push(cb); }
  function onChatAction(cb) {
    if (room && room._recvChat) {
      room._recvChat((data, peerId) => {
        try {
          cb(JSON.parse(data), peerId);
        } catch (e) {}
      });
    }
  }

  function disconnect() {
    if (room) {
      room.leave();
      room = null;
    }
    if (provider) {
      provider.destroy();
      provider = null;
    }
    if (ydoc) {
      ydoc.destroy();
      ydoc = null;
    }
    peers.clear();
    onlineUsers.clear();
    verifiedPeers.clear();
    pendingChallenges.clear();
    peerCount = 0;
    isConnected = false;
  }

  return {
    init,
    connect,
    disconnect,
    broadcastMeta,
    getDoc,
    getMessages,
    addStream,
    removeStream,
    sendChatAction,
    getPubkeyForPeer,
    getPeerIdForPubkey,
    getPeerInfo,
    isPeerVerified,
    isPubkeyVerified,
    getOnlineUsers,
    getPeerCount,
    getVerifiedCount,
    getStatus,
    onConnect,
    onDisconnect,
    onPeerJoin,
    onPeerLeave,
    onMetaUpdate,
    onVoiceStream,
    onScreenStream,
    onStreamRemoved,
    onChatAction
  };
})();
