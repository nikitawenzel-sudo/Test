// noble-loader.js
// Provides window.nobleSecp256k1 and window.nobleHashes
// Since noble libraries are ESM-only, we use a workaround for vanilla JS

// We'll implement the crypto functions we need using Web Crypto API
// and a minimal secp256k1 implementation

(function() {
  'use strict';

  // ====== SHA-256 using Web Crypto API ======
  async function sha256(data) {
    if (typeof data === 'string') {
      data = new TextEncoder().encode(data);
    }
    const hash = await crypto.subtle.digest('SHA-256', data);
    return new Uint8Array(hash);
  }

  // Synchronous SHA-256 for environments that need it
  // We'll use a pure JS implementation for the sync version
  function sha256Sync(data) {
    if (typeof data === 'string') {
      data = new TextEncoder().encode(data);
    }
    return sha256Pure(data);
  }

  // Pure JS SHA-256 implementation
  function sha256Pure(message) {
    const K = new Uint32Array([
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ]);

    let H = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);

    const len = message.length;
    const bitLen = len * 8;

    // Padding
    let padded = new Uint8Array(Math.ceil((len + 9) / 64) * 64);
    padded.set(message);
    padded[len] = 0x80;

    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 4, bitLen, false);

    const W = new Uint32Array(64);

    for (let offset = 0; offset < padded.length; offset += 64) {
      for (let i = 0; i < 16; i++) {
        W[i] = view.getUint32(offset + i * 4, false);
      }
      for (let i = 16; i < 64; i++) {
        const s0 = (rotr(W[i-15], 7) ^ rotr(W[i-15], 18) ^ (W[i-15] >>> 3)) >>> 0;
        const s1 = (rotr(W[i-2], 17) ^ rotr(W[i-2], 19) ^ (W[i-2] >>> 10)) >>> 0;
        W[i] = (W[i-16] + s0 + W[i-7] + s1) >>> 0;
      }

      let [a, b, c, d, e, f, g, h] = H;

      for (let i = 0; i < 64; i++) {
        const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        const ch = ((e & f) ^ (~e & g)) >>> 0;
        const temp1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
        const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        const temp2 = (S0 + maj) >>> 0;

        h = g; g = f; f = e;
        e = (d + temp1) >>> 0;
        d = c; c = b; b = a;
        a = (temp1 + temp2) >>> 0;
      }

      H[0] = (H[0] + a) >>> 0;
      H[1] = (H[1] + b) >>> 0;
      H[2] = (H[2] + c) >>> 0;
      H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0;
      H[5] = (H[5] + f) >>> 0;
      H[6] = (H[6] + g) >>> 0;
      H[7] = (H[7] + h) >>> 0;
    }

    function rotr(x, n) {
      return ((x >>> n) | (x << (32 - n))) >>> 0;
    }

    const result = new Uint8Array(32);
    const resultView = new DataView(result.buffer);
    for (let i = 0; i < 8; i++) {
      resultView.setUint32(i * 4, H[i], false);
    }
    return result;
  }

  window.nobleHashes = {
    sha256: sha256Sync,
    sha256Async: sha256
  };

  // ====== Minimal secp256k1 Schnorr for NOSTR ======
  // We use the Web Crypto API where possible, but Schnorr signatures
  // aren't supported in Web Crypto. We need a minimal implementation.

  // secp256k1 curve parameters
  const CURVE = {
    P: BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F'),
    N: BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141'),
    Gx: BigInt('0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798'),
    Gy: BigInt('0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8'),
    a: 0n,
    b: 7n
  };

  function mod(a, b = CURVE.P) {
    const r = a % b;
    return r >= 0n ? r : b + r;
  }

  function invert(num, md = CURVE.P) {
    if (num === 0n) throw new Error('invert: zero');
    let a = mod(num, md), b = md;
    let x = 0n, y = 1n, u = 1n, v = 0n;
    while (a !== 0n) {
      const q = b / a;
      const r = b % a;
      const m = x - u * q;
      const n = y - v * q;
      b = a; a = r; x = u; y = v; u = m; v = n;
    }
    return mod(x, md);
  }

  function bytesToBigInt(bytes) {
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return BigInt('0x' + (hex || '0'));
  }

  function bigIntToBytes(n, len = 32) {
    let hex = n.toString(16).padStart(len * 2, '0');
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }

  function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function concatBytes(...arrays) {
    const len = arrays.reduce((acc, a) => acc + a.length, 0);
    const result = new Uint8Array(len);
    let offset = 0;
    for (const arr of arrays) {
      result.set(arr, offset);
      offset += arr.length;
    }
    return result;
  }

  // Point operations on secp256k1
  class Point {
    constructor(x, y) {
      this.x = x;
      this.y = y;
    }

    static ZERO = new Point(0n, 0n);

    isZero() {
      return this.x === 0n && this.y === 0n;
    }

    equals(other) {
      return this.x === other.x && this.y === other.y;
    }

    negate() {
      return new Point(this.x, mod(-this.y));
    }

    double() {
      if (this.isZero()) return this;
      const { x, y } = this;
      const s = mod(3n * x * x * invert(2n * y));
      const nx = mod(s * s - 2n * x);
      const ny = mod(s * (x - nx) - y);
      return new Point(nx, ny);
    }

    add(other) {
      if (this.isZero()) return other;
      if (other.isZero()) return this;
      if (this.equals(other)) return this.double();
      if (this.x === other.x) return Point.ZERO;

      const s = mod((other.y - this.y) * invert(other.x - this.x));
      const nx = mod(s * s - this.x - other.x);
      const ny = mod(s * (this.x - nx) - this.y);
      return new Point(nx, ny);
    }

    multiply(scalar) {
      let n = mod(scalar, CURVE.N);
      let p = Point.ZERO;
      let d = this;
      while (n > 0n) {
        if (n & 1n) p = p.add(d);
        d = d.double();
        n >>= 1n;
      }
      return p;
    }

    hasEvenY() {
      return this.y % 2n === 0n;
    }
  }

  const G = new Point(CURVE.Gx, CURVE.Gy);

  function liftX(x) {
    const p = CURVE.P;
    const ysq = mod(mod(x * x * x) + CURVE.b);
    // Tonelli-Shanks for p ≡ 3 (mod 4): y = ysq^((p+1)/4) mod p
    const y = modPow(ysq, (p + 1n) / 4n, p);
    if (mod(y * y) !== ysq) throw new Error('Point not on curve');
    return y % 2n === 0n ? y : p - y;
  }

  function modPow(base, exp, modulus) {
    let result = 1n;
    base = mod(base, modulus);
    while (exp > 0n) {
      if (exp % 2n === 1n) result = mod(result * base, modulus);
      exp = exp / 2n;
      base = mod(base * base, modulus);
    }
    return result;
  }

  // Tagged hash as per BIP-340
  function taggedHash(tag, ...data) {
    const tagHash = sha256Sync(new TextEncoder().encode(tag));
    return sha256Sync(concatBytes(tagHash, tagHash, ...data));
  }

  // Get public key (x-only, 32 bytes)
  function getPublicKey(privateKeyHex) {
    const d = bytesToBigInt(hexToBytes(privateKeyHex));
    if (d === 0n || d >= CURVE.N) throw new Error('Invalid private key');
    const P = G.multiply(d);
    return bigIntToBytes(P.x);
  }

  // Schnorr sign (BIP-340)
  async function schnorrSign(messageBytes, privateKeyHex) {
    const d0 = bytesToBigInt(hexToBytes(privateKeyHex));
    const P = G.multiply(d0);
    const d = P.hasEvenY() ? d0 : CURVE.N - d0;

    const pk = bigIntToBytes(P.x);

    // Deterministic nonce: t = d XOR taggedHash("BIP0340/aux", rand)
    const rand = new Uint8Array(32);
    crypto.getRandomValues(rand);
    const auxHash = taggedHash('BIP0340/aux', rand);

    const dBytes = bigIntToBytes(d);
    const t = new Uint8Array(32);
    for (let i = 0; i < 32; i++) t[i] = dBytes[i] ^ auxHash[i];

    const kHash = taggedHash('BIP0340/nonce', t, pk, messageBytes);
    let k = mod(bytesToBigInt(kHash), CURVE.N);
    if (k === 0n) throw new Error('k is zero');

    const R = G.multiply(k);
    if (!R.hasEvenY()) k = CURVE.N - k;

    const rx = bigIntToBytes(R.x);
    const eHash = taggedHash('BIP0340/challenge', rx, pk, messageBytes);
    const e = mod(bytesToBigInt(eHash), CURVE.N);

    const s = mod(k + e * d, CURVE.N);

    return concatBytes(rx, bigIntToBytes(s));
  }

  // Schnorr verify (BIP-340)
  function schnorrVerify(signatureBytes, messageBytes, publicKeyBytes) {
    try {
      const px = bytesToBigInt(publicKeyBytes);
      const py = liftX(px);
      const P = new Point(px, py);

      const r = bytesToBigInt(signatureBytes.slice(0, 32));
      const s = bytesToBigInt(signatureBytes.slice(32, 64));

      if (r >= CURVE.P || s >= CURVE.N) return false;

      const rx = bigIntToBytes(r);
      const pk = bigIntToBytes(px);
      const eHash = taggedHash('BIP0340/challenge', rx, pk, messageBytes);
      const e = mod(bytesToBigInt(eHash), CURVE.N);

      const R = G.multiply(s).add(P.multiply(CURVE.N - e));

      if (R.isZero()) return false;
      if (!R.hasEvenY()) return false;
      if (R.x !== r) return false;

      return true;
    } catch (e) {
      return false;
    }
  }

  window.nobleSecp256k1 = {
    getPublicKey: (privKey, compressed) => {
      const pubBytes = getPublicKey(typeof privKey === 'string' ? privKey : bytesToHex(privKey));
      if (compressed) {
        // Return 33-byte compressed key (02 prefix for even y)
        return concatBytes(new Uint8Array([2]), pubBytes);
      }
      return pubBytes;
    },
    schnorr: {
      sign: async (message, privateKey) => {
        const msgBytes = typeof message === 'string' ? hexToBytes(message) : message;
        const privHex = typeof privateKey === 'string' ? privateKey : bytesToHex(privateKey);
        return schnorrSign(msgBytes, privHex);
      },
      verify: (signature, message, publicKey) => {
        const sigBytes = typeof signature === 'string' ? hexToBytes(signature) : signature;
        const msgBytes = typeof message === 'string' ? hexToBytes(message) : message;
        const pubBytes = typeof publicKey === 'string' ? hexToBytes(publicKey) : publicKey;
        return schnorrVerify(sigBytes, msgBytes, pubBytes);
      }
    },
    etc: {
      hmacSha256Sync: null,
      concatBytes: concatBytes
    },
    utils: {
      bytesToHex,
      hexToBytes
    }
  };

  console.log('Noble crypto libraries loaded (pure JS implementation)');
})();
