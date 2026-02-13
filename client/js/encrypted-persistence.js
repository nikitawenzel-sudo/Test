// encrypted-persistence.js - Encrypted IndexedDB Persistence for Yjs
// Replaces y-indexeddb with AES-256-GCM encrypted storage
// Master key derived from private key via HKDF (label: 'campfire-v1')

const EncryptedPersistence = (() => {
  let masterKey = null;
  let db = null;
  let updateCount = 0;
  const COMPACT_THRESHOLD = 50; // Compact after N updates
  const DB_VERSION = 1;
  const UPDATES_STORE = 'updates';
  const STATE_STORE = 'state';
  const RATCHET_STORE = 'ratchet';

  function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }

  // ====== MASTER KEY DERIVATION (HKDF) ======

  // Derive master key from private key using HKDF
  // privateKey → HKDF(SHA-256, salt='campfire-v1', info='indexeddb-encryption') → AES-256-GCM
  async function deriveMasterKey(privateKeyHex) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      hexToBytes(privateKeyHex),
      'HKDF',
      false,
      ['deriveKey']
    );
    const encoder = new TextEncoder();
    masterKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: encoder.encode('campfire-v1'),
        info: encoder.encode('indexeddb-encryption')
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    return masterKey;
  }

  // ====== ENCRYPT / DECRYPT BLOBS ======

  async function encryptBlob(data) {
    if (!masterKey) throw new Error('No master key');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      masterKey,
      data
    );
    // Store as: 12 bytes IV + ciphertext
    const result = new Uint8Array(12 + encrypted.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(encrypted), 12);
    return result;
  }

  async function decryptBlob(data) {
    if (!masterKey) throw new Error('No master key');
    const iv = data.slice(0, 12);
    const ciphertext = data.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      masterKey,
      ciphertext
    );
    return new Uint8Array(decrypted);
  }

  // ====== INDEXEDDB OPERATIONS ======

  async function openDB(roomId) {
    return new Promise((resolve, reject) => {
      const dbName = 'campfire-encrypted-' + roomId;
      const request = indexedDB.open(dbName, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const database = event.target.result;
        if (!database.objectStoreNames.contains(UPDATES_STORE)) {
          database.createObjectStore(UPDATES_STORE, { keyPath: 'id', autoIncrement: true });
        }
        if (!database.objectStoreNames.contains(STATE_STORE)) {
          database.createObjectStore(STATE_STORE, { keyPath: 'key' });
        }
        if (!database.objectStoreNames.contains(RATCHET_STORE)) {
          database.createObjectStore(RATCHET_STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = (event) => {
        db = event.target.result;
        resolve(db);
      };
      request.onerror = (event) => reject(event.target.error);
    });
  }

  // Store a single encrypted Yjs update
  async function storeUpdate(update) {
    if (!masterKey || !db) return;
    const encrypted = await encryptBlob(update);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(UPDATES_STORE, 'readwrite');
      tx.objectStore(UPDATES_STORE).add({
        data: encrypted,
        ts: Date.now()
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  // Store full encrypted state (for compaction)
  async function storeFullState(stateData) {
    if (!masterKey || !db) return;
    const encrypted = await encryptBlob(stateData);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STATE_STORE, 'readwrite');
      tx.objectStore(STATE_STORE).put({
        key: 'full-state',
        data: encrypted,
        ts: Date.now()
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  // Load full state (if exists)
  async function loadFullState() {
    if (!masterKey || !db) return null;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STATE_STORE, 'readonly');
      const request = tx.objectStore(STATE_STORE).get('full-state');
      request.onsuccess = async () => {
        if (!request.result) { resolve(null); return; }
        try {
          const decrypted = await decryptBlob(new Uint8Array(request.result.data));
          resolve(decrypted);
        } catch (e) {
          console.warn('Failed to decrypt full state:', e);
          resolve(null);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  // Load all incremental updates
  async function loadUpdates() {
    if (!masterKey || !db) return [];
    return new Promise((resolve, reject) => {
      const tx = db.transaction(UPDATES_STORE, 'readonly');
      const request = tx.objectStore(UPDATES_STORE).getAll();
      request.onsuccess = async () => {
        const records = request.result;
        const updates = [];
        for (const record of records) {
          try {
            const decrypted = await decryptBlob(new Uint8Array(record.data));
            updates.push(decrypted);
          } catch (e) {
            console.warn('Failed to decrypt update:', e);
          }
        }
        resolve(updates);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // Clear all incremental updates (after compaction)
  async function clearUpdates() {
    if (!db) return;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(UPDATES_STORE, 'readwrite');
      tx.objectStore(UPDATES_STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  // Compact: store full state, clear incremental updates
  async function compact(ydoc) {
    const state = window.Yjs.encodeStateAsUpdate(ydoc);
    await storeFullState(state);
    await clearUpdates();
    updateCount = 0;
    console.log('Encrypted persistence compacted');
  }

  // ====== RATCHET STATE PERSISTENCE ======

  async function storeRatchetState(state) {
    if (!masterKey || !db) return;
    const encoder = new TextEncoder();
    const plaintext = encoder.encode(JSON.stringify(state));
    const encrypted = await encryptBlob(plaintext);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(RATCHET_STORE, 'readwrite');
      tx.objectStore(RATCHET_STORE).put({
        key: 'ratchet-state',
        data: encrypted,
        ts: Date.now()
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function loadRatchetState() {
    if (!masterKey || !db) return null;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(RATCHET_STORE, 'readonly');
      const request = tx.objectStore(RATCHET_STORE).get('ratchet-state');
      request.onsuccess = async () => {
        if (!request.result) { resolve(null); return; }
        try {
          const decrypted = await decryptBlob(new Uint8Array(request.result.data));
          const text = new TextDecoder().decode(decrypted);
          resolve(JSON.parse(text));
        } catch (e) {
          console.warn('Failed to decrypt ratchet state:', e);
          resolve(null);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  // ====== MAIN BIND FUNCTION ======

  // Bind to a Yjs document: load encrypted state, listen for updates
  async function bind(ydoc, roomId, privateKeyHex) {
    await deriveMasterKey(privateKeyHex);
    await openDB(roomId);

    // Load existing encrypted state
    const fullState = await loadFullState();
    if (fullState) {
      window.Yjs.applyUpdate(ydoc, fullState);
    }

    // Load incremental updates
    const updates = await loadUpdates();
    for (const update of updates) {
      window.Yjs.applyUpdate(ydoc, update);
    }

    console.log('Encrypted persistence loaded (' +
      (fullState ? '1 state' : 'no state') + ' + ' +
      updates.length + ' updates)');

    // Listen for new updates and store them encrypted
    ydoc.on('update', async (update, origin) => {
      if (origin === 'encrypted-persistence') return;
      await storeUpdate(update);
      updateCount++;
      // Periodic compaction
      if (updateCount >= COMPACT_THRESHOLD) {
        await compact(ydoc);
      }
    });

    // Delete old unencrypted y-indexeddb database (migration)
    try {
      indexedDB.deleteDatabase('nostr-p2p-' + roomId);
    } catch (e) { /* ignore */ }

    return {
      destroy: () => { if (db) { db.close(); db = null; } },
      compact: () => compact(ydoc),
      storeRatchetState,
      loadRatchetState
    };
  }

  return {
    bind,
    deriveMasterKey
  };
})();
