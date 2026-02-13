// p2p.js - P2P Networking Layer (Trystero + Yjs)
// Replaces relay.js - No server needed!

const P2P = (() => {
  let room = null;
  let ydoc = null;
  let provider = null; // y-indexeddb persistence
  let keyPair = null;
  let roomId = null;
  let peers = new Map(); // peerId -> { pubkey, nickname, avatar }
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

    // IndexedDB persistence
    provider = new window.YIndexeddb.IndexeddbPersistence('nostr-p2p-' + roomId, ydoc);
    await new Promise(resolve => {
      provider.on('synced', () => {
        console.log('IndexedDB synced');
        resolve();
      });
    });

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

    // Handle Yjs sync - when a new peer connects, exchange state
    room._recvYjsSync((data, peerId) => {
      try {
        const remoteVector = new Uint8Array(data);
        const update = window.Yjs.encodeStateAsUpdate(ydoc, remoteVector);
        // Send our state diff back
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

    // Handle metadata exchange (pubkey, nickname, avatar)
    room._recvMeta((data, peerId) => {
      try {
        const meta = typeof data === 'string' ? JSON.parse(data) : data;
        peers.set(peerId, {
          pubkey: meta.pubkey,
          nickname: meta.nickname,
          avatar: meta.avatar || null
        });
        onlineUsers.set(meta.pubkey, {
          nickname: meta.nickname,
          avatar: meta.avatar || null,
          peerId: peerId,
          lastSeen: Date.now()
        });
        metaUpdateCallbacks.forEach(cb => cb(meta.pubkey, meta));
      } catch (e) {
        console.error('Meta parse error:', e);
      }
    });

    // Handle nickname requests (peer asking for our info)
    room._recvNickRequest((data, peerId) => {
      broadcastMeta();
    });

    // Handle peer join
    room.onPeerJoin(peerId => {
      peerCount++;
      console.log('Peer joined:', peerId, '(total:', peerCount, ')');

      if (!isConnected) {
        isConnected = true;
        connectCallbacks.forEach(cb => cb());
      }

      // Send our metadata to the new peer
      const meta = {
        pubkey: keyPair.publicKey,
        nickname: NostrCrypto.getNickname() || NostrCrypto.shortenPubkey(keyPair.publicKey),
        avatar: NostrCrypto.getAvatar()
      };
      sendMeta(JSON.stringify(meta), peerId);

      // Request their metadata
      sendNickRequest('req', peerId);

      // Sync Yjs state with new peer
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

  // Get all online users
  function getOnlineUsers() {
    return onlineUsers;
  }

  // Get peer count
  function getPeerCount() {
    return peerCount;
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
    getOnlineUsers,
    getPeerCount,
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
