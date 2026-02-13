// ratchet.js - Forward Secrecy via Sender Keys + Symmetric Ratchet
// Each sender has their own chain key that ratchets forward with each message.
// Chain keys are distributed via ECDH-wrapped key exchange.
// Old chain keys are deleted → forward secrecy.

const Ratchet = (() => {
  let myKeyPair = null;
  let mySenderKey = null;      // Our current sender chain key (Uint8Array, 32 bytes)
  let myChainIndex = 0;        // Our current chain position
  let peerChains = new Map();  // pubkey → { chainKey: Uint8Array, chainIndex: number }
  let skippedKeys = new Map(); // "pubkey:index" → messageKey (Uint8Array)
  let persistence = null;      // EncryptedPersistence provider for saving state
  const MAX_SKIP = 500;        // Max messages to skip ahead (DoS protection)

  // Auto-rotation state
  const ROTATION_MSG_THRESHOLD = 100;
  const ROTATION_TIME_MS = 3600000; // 1 hour
  let messagesSinceRotation = 0;
  let rotationTimer = null;
  let rotationCount = 0;
  let rotationCallbacks = [];

  function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }

  // ====== HMAC-SHA256 via Web Crypto ======

  async function hmacSha256(key, data) {
    const cryptoKey = await crypto.subtle.importKey(
      'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, data);
    return new Uint8Array(sig);
  }

  // ====== KDF CHAIN ======
  // Derives next chain key + message key from current chain key
  // chainKey → HMAC(chainKey, "chain") = nextChainKey
  // chainKey → HMAC(chainKey, "msg")   = messageKey

  async function kdfChain(chainKey) {
    const encoder = new TextEncoder();
    const nextChainKey = await hmacSha256(chainKey, encoder.encode('chain'));
    const messageKey = await hmacSha256(chainKey, encoder.encode('msg'));
    return [nextChainKey, messageKey];
  }

  // ====== AES-256-GCM ENCRYPT/DECRYPT ======

  async function aesEncrypt(plaintext, messageKey) {
    const key = await crypto.subtle.importKey(
      'raw', messageKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoder.encode(plaintext)
    );
    return {
      iv: bytesToHex(iv),
      ct: bytesToHex(new Uint8Array(encrypted))
    };
  }

  async function aesDecrypt(encObj, messageKey) {
    const key = await crypto.subtle.importKey(
      'raw', messageKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(encObj.iv) },
      key,
      hexToBytes(encObj.ct)
    );
    return new TextDecoder().decode(decrypted);
  }

  // ====== ECDH KEY WRAPPING ======
  // Wrap sender key for a specific peer using ECDH shared secret

  async function wrapKeyForPeer(senderKey, myPrivateKey, peerPubkey) {
    // ECDH: shared_point.x = peer_pub * my_priv
    const secp = window.nobleSecp256k1;
    const sharedBytes = secp.ecdh(myPrivateKey, peerPubkey);

    // Derive wrapping key from shared secret via SHA-256
    const hashBuffer = await crypto.subtle.digest('SHA-256', sharedBytes);
    const wrappingKey = await crypto.subtle.importKey(
      'raw',
      hashBuffer,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    );

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      wrappingKey,
      senderKey
    );

    return {
      iv: bytesToHex(iv),
      ct: bytesToHex(new Uint8Array(encrypted))
    };
  }

  // Unwrap sender key from a peer
  async function unwrapKeyFromPeer(wrappedKey, myPrivateKey, senderPubkey) {
    const secp = window.nobleSecp256k1;
    const sharedBytes = secp.ecdh(myPrivateKey, senderPubkey);

    const hashBuffer = await crypto.subtle.digest('SHA-256', sharedBytes);
    const wrappingKey = await crypto.subtle.importKey(
      'raw',
      hashBuffer,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(wrappedKey.iv) },
      wrappingKey,
      hexToBytes(wrappedKey.ct)
    );

    return new Uint8Array(decrypted);
  }

  // ====== RATCHET OPERATIONS ======

  function init(keyPair, persistenceProvider) {
    myKeyPair = keyPair;
    persistence = persistenceProvider;
    // Generate fresh sender key for this session
    mySenderKey = crypto.getRandomValues(new Uint8Array(32));
    myChainIndex = 0;
  }

  // Restore ratchet state from encrypted persistence
  async function restoreState() {
    if (!persistence) return false;
    try {
      const state = await persistence.loadRatchetState();
      if (!state) return false;

      if (state.mySenderKey) {
        mySenderKey = hexToBytes(state.mySenderKey);
        myChainIndex = state.myChainIndex || 0;
      }
      if (state.peerChains) {
        for (const [pubkey, chain] of Object.entries(state.peerChains)) {
          peerChains.set(pubkey, {
            chainKey: hexToBytes(chain.chainKey),
            chainIndex: chain.chainIndex
          });
        }
      }
      console.log('Ratchet state restored (' + peerChains.size + ' peer chains)');
      return true;
    } catch (e) {
      console.warn('Failed to restore ratchet state:', e);
      return false;
    }
  }

  // Save ratchet state to encrypted persistence
  async function saveState() {
    if (!persistence) return;
    const state = {
      mySenderKey: bytesToHex(mySenderKey),
      myChainIndex: myChainIndex,
      peerChains: {}
    };
    for (const [pubkey, chain] of peerChains.entries()) {
      state.peerChains[pubkey] = {
        chainKey: bytesToHex(chain.chainKey),
        chainIndex: chain.chainIndex
      };
    }
    try {
      await persistence.storeRatchetState(state);
    } catch (e) {
      console.warn('Failed to save ratchet state:', e);
    }
  }

  // Get our wrapped sender key for a specific peer
  async function getSenderKeyForPeer(peerPubkey) {
    const wrapped = await wrapKeyForPeer(mySenderKey, myKeyPair.privateKey, peerPubkey);
    return {
      pubkey: myKeyPair.publicKey,
      wrappedKey: wrapped,
      chainIndex: myChainIndex
    };
  }

  // Receive and store a peer's sender key
  async function receiveSenderKey(senderPubkey, wrappedKey, chainIndex) {
    try {
      const senderKey = await unwrapKeyFromPeer(wrappedKey, myKeyPair.privateKey, senderPubkey);
      peerChains.set(senderPubkey, {
        chainKey: senderKey,
        chainIndex: chainIndex
      });
      console.log('Received sender key from', senderPubkey.slice(0, 8) + '...', 'at index', chainIndex);
      await saveState();
      return true;
    } catch (e) {
      console.error('Failed to unwrap sender key:', e);
      return false;
    }
  }

  // Encrypt a message with our sender chain (ratcheting forward)
  async function encrypt(plaintext) {
    // Derive message key and advance chain
    const [nextChainKey, messageKey] = await kdfChain(mySenderKey);
    const currentIndex = myChainIndex;

    // Encrypt content
    const encrypted = await aesEncrypt(plaintext, messageKey);

    // Ratchet forward: delete old key, store new
    mySenderKey = nextChainKey;
    myChainIndex++;
    messagesSinceRotation++;

    // Persist state periodically
    if (myChainIndex % 10 === 0) {
      saveState(); // fire-and-forget
    }

    // Auto-rotate after message threshold
    if (messagesSinceRotation >= ROTATION_MSG_THRESHOLD) {
      triggerRotation('message-count');
    }

    return {
      ...encrypted,
      ci: currentIndex // chain index for receiver to sync
    };
  }

  // Decrypt a message from a peer
  async function decrypt(senderPubkey, encObj) {
    const chain = peerChains.get(senderPubkey);
    if (!chain) {
      return null; // No sender key for this peer
    }

    const targetIndex = encObj.ci;

    // Check for skipped key
    const skipKey = senderPubkey + ':' + targetIndex;
    if (skippedKeys.has(skipKey)) {
      const messageKey = skippedKeys.get(skipKey);
      skippedKeys.delete(skipKey);
      try {
        return await aesDecrypt(encObj, messageKey);
      } catch (e) {
        return null;
      }
    }

    // Target is before our chain position → can't go back (forward secrecy!)
    if (targetIndex < chain.chainIndex) {
      return null; // Message key already deleted
    }

    // Ratchet forward to target index, caching skipped keys
    const skip = targetIndex - chain.chainIndex;
    if (skip > MAX_SKIP) {
      console.warn('Too many skipped messages from', senderPubkey.slice(0, 8));
      return null;
    }

    let currentKey = chain.chainKey;
    for (let i = chain.chainIndex; i < targetIndex; i++) {
      const [nextKey, msgKey] = await kdfChain(currentKey);
      // Cache skipped message key
      skippedKeys.set(senderPubkey + ':' + i, msgKey);
      currentKey = nextKey;
    }

    // Derive the target message key
    const [nextChainKey, messageKey] = await kdfChain(currentKey);

    // Update chain state (ratcheted past the target)
    chain.chainKey = nextChainKey;
    chain.chainIndex = targetIndex + 1;

    // Persist state
    if (targetIndex % 10 === 0) {
      saveState(); // fire-and-forget
    }

    // Prune old skipped keys (keep max 200)
    if (skippedKeys.size > 200) {
      const entries = [...skippedKeys.entries()];
      entries.slice(0, entries.length - 200).forEach(([k]) => skippedKeys.delete(k));
    }

    try {
      return await aesDecrypt(encObj, messageKey);
    } catch (e) {
      return null;
    }
  }

  // Check if we have a sender key for a given pubkey
  function hasSenderKey(pubkey) {
    return peerChains.has(pubkey);
  }

  // Get our current chain index (for message headers)
  function getChainIndex() {
    return myChainIndex;
  }

  // Rotate our sender key (periodic or on peer change)
  async function rotateSenderKey() {
    mySenderKey = crypto.getRandomValues(new Uint8Array(32));
    myChainIndex = 0;
    messagesSinceRotation = 0;
    await saveState();
    console.log('Sender key rotated (total rotations:', rotationCount, ')');
    return true;
  }

  // Trigger rotation and notify listeners (p2p.js distributes new keys)
  async function triggerRotation(reason) {
    await rotateSenderKey();
    rotationCount++;
    resetRotationTimer();
    console.log('Key rotation triggered:', reason);
    rotationCallbacks.forEach(cb => cb(reason));
  }

  // Start the 1-hour rotation timer
  function startRotationTimer() {
    clearTimeout(rotationTimer);
    rotationTimer = setTimeout(() => {
      triggerRotation('time');
    }, ROTATION_TIME_MS);
  }

  // Reset the timer (called after rotation)
  function resetRotationTimer() {
    messagesSinceRotation = 0;
    startRotationTimer();
  }

  // Register callback for rotation events
  function onRotation(cb) {
    rotationCallbacks.push(cb);
  }

  // Get total rotation count (for expert mode UI)
  function getRotationCount() {
    return rotationCount;
  }

  return {
    init,
    restoreState,
    saveState,
    getSenderKeyForPeer,
    receiveSenderKey,
    encrypt,
    decrypt,
    hasSenderKey,
    getChainIndex,
    rotateSenderKey,
    triggerRotation,
    startRotationTimer,
    onRotation,
    getRotationCount
  };
})();
