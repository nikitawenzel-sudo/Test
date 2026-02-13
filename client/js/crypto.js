// crypto.js - NOSTR Key Management, Event Signing, E2E Encryption
// Depends on: noble-secp256k1 and noble-hashes loaded globally

const NostrCrypto = (() => {
  let roomCryptoKey = null; // AES-256-GCM key derived from room password

  function getSecp() {
    return window.nobleSecp256k1;
  }

  function getHashes() {
    return window.nobleHashes;
  }

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

  function generatePrivateKey() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
  }

  function getPublicKey(privateKey) {
    const secp = getSecp();
    const pubkeyBytes = secp.getPublicKey(privateKey, true); // compressed
    return bytesToHex(pubkeyBytes.slice(1)); // x-only 32 bytes
  }

  function loadOrCreateKeyPair() {
    let privateKey = localStorage.getItem('nostr_privkey');
    if (!privateKey) {
      privateKey = generatePrivateKey();
      localStorage.setItem('nostr_privkey', privateKey);
    }
    const publicKey = getPublicKey(privateKey);
    localStorage.setItem('nostr_pubkey', publicKey);
    return { privateKey, publicKey };
  }

  function serializeEvent(event) {
    return JSON.stringify([
      0,
      event.pubkey,
      event.created_at,
      event.kind,
      event.tags,
      event.content
    ]);
  }

  async function computeEventId(event) {
    const serialized = serializeEvent(event);
    const encoder = new TextEncoder();
    const data = encoder.encode(serialized);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return bytesToHex(new Uint8Array(hashBuffer));
  }

  async function signEvent(eventTemplate, privateKey) {
    const pubkey = getPublicKey(privateKey);
    const event = {
      ...eventTemplate,
      pubkey: pubkey,
      created_at: eventTemplate.created_at || Math.floor(Date.now() / 1000),
    };

    event.id = await computeEventId(event);

    const secp = getSecp();
    const sigBytes = await secp.schnorr.sign(hexToBytes(event.id), privateKey);
    event.sig = bytesToHex(sigBytes);

    return event;
  }

  async function verifyEvent(event) {
    try {
      const id = await computeEventId(event);
      if (id !== event.id) return false;

      const secp = getSecp();
      return await secp.schnorr.verify(
        hexToBytes(event.sig),
        hexToBytes(event.id),
        hexToBytes(event.pubkey)
      );
    } catch (e) {
      console.error('Verify error:', e);
      return false;
    }
  }

  // ====== E2E ENCRYPTION (AES-256-GCM) ======

  // Derive room encryption key from password + roomId using PBKDF2
  async function deriveRoomKey(roomId, password) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    const salt = encoder.encode('nostr-discord-e2e-' + roomId);
    roomCryptoKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    return roomCryptoKey;
  }

  function hasRoomKey() {
    return roomCryptoKey !== null;
  }

  // Encrypt plaintext with room key → { iv (hex), ct (hex) }
  async function encryptText(plaintext) {
    if (!roomCryptoKey) return null;
    const encoder = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      roomCryptoKey,
      encoder.encode(plaintext)
    );
    return {
      iv: bytesToHex(iv),
      ct: bytesToHex(new Uint8Array(encrypted))
    };
  }

  // Decrypt { iv, ct } with room key → plaintext or null
  async function decryptText(encObj) {
    if (!roomCryptoKey) return null;
    try {
      const iv = hexToBytes(encObj.iv);
      const ct = hexToBytes(encObj.ct);
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        roomCryptoKey,
        ct
      );
      return new TextDecoder().decode(decrypted);
    } catch (e) {
      return null; // Wrong key or corrupted data
    }
  }

  // ====== MESSAGE SIGNING (Schnorr BIP-340) ======

  // Sign a chat message payload: SHA-256(pubkey || created_at || channel || content) → Schnorr sig
  async function signMessagePayload(pubkey, createdAt, channel, content, privateKey) {
    const payload = JSON.stringify([pubkey, createdAt, channel, content]);
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(payload));
    const hash = new Uint8Array(hashBuffer);

    const secp = getSecp();
    const sigBytes = await secp.schnorr.sign(hash, privateKey);
    return bytesToHex(sigBytes);
  }

  // Verify a chat message signature
  async function verifyMessageSignature(pubkey, createdAt, channel, content, sig) {
    try {
      const payload = JSON.stringify([pubkey, createdAt, channel, content]);
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(payload));
      const hash = new Uint8Array(hashBuffer);

      const secp = getSecp();
      return await secp.schnorr.verify(hexToBytes(sig), hash, hexToBytes(pubkey));
    } catch (e) {
      return false;
    }
  }

  // ====== CHALLENGE-RESPONSE (raw Schnorr) ======

  // Sign arbitrary 32-byte hash (for challenge-response identity proof)
  async function schnorrSign(msgHex, privateKeyHex) {
    const secp = getSecp();
    const sigBytes = await secp.schnorr.sign(hexToBytes(msgHex), privateKeyHex);
    return bytesToHex(sigBytes);
  }

  // Verify arbitrary Schnorr signature
  async function schnorrVerify(sigHex, msgHex, pubkeyHex) {
    try {
      const secp = getSecp();
      return await secp.schnorr.verify(hexToBytes(sigHex), hexToBytes(msgHex), hexToBytes(pubkeyHex));
    } catch (e) {
      return false;
    }
  }

  // Generate random 32-byte hex nonce for challenges
  function randomNonce() {
    return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  }

  // Hash a nonce for signing (Schnorr needs 32-byte message)
  async function hashNonce(nonce) {
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(nonce));
    return bytesToHex(new Uint8Array(hashBuffer));
  }

  // ====== NICKNAME / AVATAR / PASSWORD MANAGEMENT ======

  function setNickname(name) {
    localStorage.setItem('nostr_nickname', name);
  }

  function getNickname() {
    return localStorage.getItem('nostr_nickname') || null;
  }

  function setAvatar(dataUrl) {
    if (dataUrl) {
      localStorage.setItem('nostr_avatar', dataUrl);
    } else {
      localStorage.removeItem('nostr_avatar');
    }
  }

  function getAvatar() {
    return localStorage.getItem('nostr_avatar') || null;
  }

  function setRoomPassword(password) {
    if (password) {
      sessionStorage.setItem('nostr_room_password', password);
    } else {
      sessionStorage.removeItem('nostr_room_password');
    }
  }

  function getRoomPassword() {
    return sessionStorage.getItem('nostr_room_password') || null;
  }

  function shortenPubkey(pubkey) {
    return pubkey.slice(0, 8) + '...' + pubkey.slice(-4);
  }

  return {
    generatePrivateKey,
    getPublicKey,
    loadOrCreateKeyPair,
    signEvent,
    verifyEvent,
    // E2E Encryption
    deriveRoomKey,
    hasRoomKey,
    encryptText,
    decryptText,
    // Message Signing
    signMessagePayload,
    verifyMessageSignature,
    // Challenge-Response
    schnorrSign,
    schnorrVerify,
    randomNonce,
    hashNonce,
    // Management
    setNickname,
    getNickname,
    setAvatar,
    getAvatar,
    setRoomPassword,
    getRoomPassword,
    shortenPubkey,
    bytesToHex,
    hexToBytes
  };
})();
