import * as secp256k1 from 'https://esm.sh/@noble/secp256k1@2.1.0';
import { sha256 } from 'https://esm.sh/@noble/hashes@1.4.0/sha256';
import { bytesToHex, hexToBytes } from 'https://esm.sh/@noble/hashes@1.4.0/utils';

const STORAGE_KEY = 'nostr-discord-keypair';

function generatePrivateKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function getPublicKeyHex(privateKey) {
  const pubkeyBytes = secp256k1.schnorr.getPublicKey(privateKey);
  return bytesToHex(pubkeyBytes);
}

export function generateKeyPair() {
  const privateKey = generatePrivateKey();
  const publicKey = getPublicKeyHex(privateKey);
  return { privateKey, publicKey };
}

export function loadOrCreateKeyPair() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const kp = JSON.parse(stored);
      if (kp.privateKey && kp.publicKey) {
        return kp;
      }
    } catch {
      // corrupt data, regenerate
    }
  }

  const kp = generateKeyPair();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(kp));
  return kp;
}

export function saveKeyPair(keyPair) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keyPair));
}

export function computeEventId(event) {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ]);
  const hash = sha256(new TextEncoder().encode(serialized));
  return bytesToHex(hash);
}

export async function signEvent(event, privateKey) {
  const id = computeEventId(event);
  const sig = bytesToHex(secp256k1.schnorr.sign(hexToBytes(id), privateKey));
  return {
    ...event,
    id,
    sig
  };
}

export async function verifyEvent(event) {
  try {
    const expectedId = computeEventId(event);
    if (event.id !== expectedId) return false;

    return secp256k1.schnorr.verify(
      hexToBytes(event.sig),
      hexToBytes(event.id),
      hexToBytes(event.pubkey)
    );
  } catch {
    return false;
  }
}

export function createUnsignedEvent(kind, content, tags, pubkey) {
  return {
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind,
    tags,
    content
  };
}

export function shortenPubkey(pubkey) {
  return pubkey.substring(0, 8) + '...' + pubkey.substring(pubkey.length - 4);
}
