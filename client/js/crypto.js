// crypto.js - NOSTR Key Management & Event Signing
// Depends on: noble-secp256k1 and noble-hashes loaded globally

const NostrCrypto = (() => {
  // Use noble libraries from global scope
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
    // For NOSTR, we use x-only pubkey (32 bytes, no prefix)
    return bytesToHex(pubkeyBytes.slice(1));
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

  // Nickname management
  function setNickname(name) {
    localStorage.setItem('nostr_nickname', name);
  }

  function getNickname() {
    return localStorage.getItem('nostr_nickname') || null;
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
    setNickname,
    getNickname,
    shortenPubkey,
    bytesToHex,
    hexToBytes
  };
})();
