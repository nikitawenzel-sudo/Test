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

  // ====== PRIVATE KEY ENCRYPTION (PBKDF2 + AES-256-GCM) ======

  const IDENTITY_PBKDF2_ITERATIONS = 600000;

  // Encrypt private key with password and store in localStorage
  async function encryptPrivateKey(privateKeyHex, password) {
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const keyMaterial = await crypto.subtle.importKey(
      'raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']
    );

    const encryptionKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: IDENTITY_PBKDF2_ITERATIONS, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    );

    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      encryptionKey,
      hexToBytes(privateKeyHex)
    );

    const pubkey = getPublicKey(privateKeyHex);

    const identity = {
      encryptedKey: bytesToHex(new Uint8Array(encrypted)),
      salt: bytesToHex(salt),
      iv: bytesToHex(iv),
      pubkey: pubkey,
      nickname: getNickname() || ''
    };

    localStorage.setItem('nostr_identity', JSON.stringify(identity));
    localStorage.setItem('nostr_pubkey', pubkey);
    // Remove plaintext key if it exists
    localStorage.removeItem('nostr_privkey');

    return identity;
  }

  // Decrypt private key with password (returns hex string or null on wrong password)
  async function decryptPrivateKey(password) {
    const stored = localStorage.getItem('nostr_identity');
    if (!stored) return null;

    const identity = JSON.parse(stored);
    const encoder = new TextEncoder();

    const keyMaterial = await crypto.subtle.importKey(
      'raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']
    );

    const encryptionKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: hexToBytes(identity.salt), iterations: IDENTITY_PBKDF2_ITERATIONS, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );

    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: hexToBytes(identity.iv) },
        encryptionKey,
        hexToBytes(identity.encryptedKey)
      );
      return bytesToHex(new Uint8Array(decrypted));
    } catch (e) {
      return null; // Wrong password
    }
  }

  // Check if an encrypted identity exists in localStorage
  function hasEncryptedIdentity() {
    return !!localStorage.getItem('nostr_identity');
  }

  // Check if a plaintext key exists (needs migration)
  function hasPlaintextKey() {
    return !!localStorage.getItem('nostr_privkey');
  }

  // Get stored pubkey without needing the private key
  function getStoredPubkey() {
    const stored = localStorage.getItem('nostr_identity');
    if (stored) {
      try { return JSON.parse(stored).pubkey; } catch (e) { /* ignore */ }
    }
    return localStorage.getItem('nostr_pubkey') || null;
  }

  // Password strength evaluation
  function getPasswordStrength(password) {
    if (!password || password.length < 8) return 'weak';
    const hasNumbers = /\d/.test(password);
    const hasSpecial = /[^a-zA-Z0-9]/.test(password);
    if (password.length >= 12 && hasSpecial) return 'strong';
    if (password.length >= 8 && hasNumbers) return 'okay';
    return 'weak';
  }

  // Create key pair from a decrypted private key in memory (no localStorage for privkey)
  function createKeyPair(privateKeyHex) {
    const publicKey = getPublicKey(privateKeyHex);
    return { privateKey: privateKeyHex, publicKey };
  }

  // Hash identity password for master key derivation (SHA-256 → hex)
  async function hashPasswordForMasterKey(password) {
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(password));
    return bytesToHex(new Uint8Array(hashBuffer));
  }

  // ====== RECOVERY CODE (Base32 with checksum) ======

  const RECOVERY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  // 31 chars (no 0,O,1,I,L) - used as base-31 encoding

  function generateRecoveryCode(privateKeyHex) {
    const keyBytes = hexToBytes(privateKeyHex);
    // 2-byte SHA-256 checksum
    const hash = getHashes().sha256(keyBytes);
    const checksum = hash.slice(0, 2);

    // Combine: 32 bytes key + 2 bytes checksum = 34 bytes
    const combined = new Uint8Array(34);
    combined.set(keyBytes);
    combined.set(checksum, 32);

    // Encode as big integer in base-31
    const base = BigInt(RECOVERY_ALPHABET.length);
    let num = 0n;
    for (const b of combined) {
      num = num * 256n + BigInt(b);
    }

    let encoded = '';
    while (num > 0n) {
      encoded = RECOVERY_ALPHABET[Number(num % base)] + encoded;
      num = num / base;
    }

    // Pad to 56 chars (14 groups of 4) for consistent length
    while (encoded.length < 56) {
      encoded = RECOVERY_ALPHABET[0] + encoded;
    }

    // Format in 4-char groups with dashes
    return encoded.match(/.{1,4}/g).join('-');
  }

  function recoverFromCode(code) {
    // Remove dashes and whitespace, uppercase
    const clean = code.replace(/[-\s]/g, '').toUpperCase();

    // Validate characters
    for (const c of clean) {
      if (RECOVERY_ALPHABET.indexOf(c) === -1) return null;
    }

    // Decode from base-31 to big integer
    const base = BigInt(RECOVERY_ALPHABET.length);
    let num = 0n;
    for (const c of clean) {
      num = num * base + BigInt(RECOVERY_ALPHABET.indexOf(c));
    }

    // Convert to 34 bytes
    const combined = new Uint8Array(34);
    for (let i = 33; i >= 0; i--) {
      combined[i] = Number(num % 256n);
      num = num / 256n;
    }

    // Extract key (32 bytes) and checksum (2 bytes)
    const keyBytes = combined.slice(0, 32);
    const checksum = combined.slice(32, 34);

    // Verify checksum
    const hash = getHashes().sha256(keyBytes);
    if (hash[0] !== checksum[0] || hash[1] !== checksum[1]) {
      return null; // Checksum mismatch
    }

    return bytesToHex(keyBytes);
  }

  return {
    generatePrivateKey,
    getPublicKey,
    loadOrCreateKeyPair,
    createKeyPair,
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
    // Private Key Encryption
    encryptPrivateKey,
    decryptPrivateKey,
    hasEncryptedIdentity,
    hasPlaintextKey,
    getStoredPubkey,
    getPasswordStrength,
    hashPasswordForMasterKey,
    // Recovery Code
    generateRecoveryCode,
    recoverFromCode,
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
