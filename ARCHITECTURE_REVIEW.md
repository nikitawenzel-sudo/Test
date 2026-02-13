# Campfire Architecture Review - Security Audit Brief

> Dieses Dokument ist fuer die Analyse durch eine externe KI gedacht.
> Es beschreibt die komplette Architektur eines P2P-Chats mit E2E-Encryption.
> Bitte analysiere Schwachstellen, Design-Fehler und Verbesserungsvorschlaege.

---

## 1. Systemueberblick

**Campfire** ist ein serverloser P2P-Chat (wie Discord) im Browser.
Kein Backend. Alles laeuft clientseitig in Vanilla JS (kein Bundler, kein npm).

```
┌─────────────────────────────────────────────────────────┐
│                     BROWSER CLIENT                      │
│                                                         │
│  ┌──────────┐  ┌─────────┐  ┌───────────┐  ┌────────┐ │
│  │ noble-   │  │ crypto  │  │ encrypted │  │ratchet │ │
│  │ loader   │  │ .js     │  │-persist.  │  │.js     │ │
│  │ (secp256 │  │ (NOSTR  │  │ (IndexedDB│  │(Forward│ │
│  │  k1,     │  │  Keys,  │  │  AES-GCM) │  │Secrecy)│ │
│  │  Schnorr,│  │  E2E,   │  │           │  │        │ │
│  │  ECDH)   │  │  Sigs)  │  │           │  │        │ │
│  └────┬─────┘  └────┬────┘  └─────┬─────┘  └───┬────┘ │
│       │             │              │             │      │
│  ┌────┴─────────────┴──────────────┴─────────────┴────┐ │
│  │                    p2p.js                          │ │
│  │  Trystero (WebRTC) + Yjs (CRDT) + Auth            │ │
│  └───────────────────────┬────────────────────────────┘ │
│                          │                              │
│  ┌───────────────────────┴────────────────────────────┐ │
│  │              chat.js / voice.js / app.js           │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
                           │
                    WebRTC DataChannel
                           │
              ┌────────────┴────────────┐
              │    NOSTR Relays         │
              │  (nur Signaling,        │
              │   kein Daten-Relay)     │
              │  - relay.damus.io       │
              │  - nos.lol              │
              │  - relay.nostr.band     │
              └─────────────────────────┘
```

## 2. Kryptographische Primitiven

### 2.1 Implementierung

**ALLES in reinem JavaScript** (kein WASM, keine nativen Module):

| Primitiv | Implementierung | Datei |
|----------|----------------|-------|
| SHA-256 | Pure JS (K-Konstanten, 64-Runden) + Web Crypto async | noble-loader.js |
| secp256k1 | BigInt-basierte Punkt-Arithmetik (add, double, multiply) | noble-loader.js |
| Schnorr BIP-340 | Deterministic Nonce (aux randomness), tagged hashes | noble-loader.js |
| ECDH | Point.multiply(scalar) auf secp256k1 | noble-loader.js |
| AES-256-GCM | Web Crypto API (SubtleCrypto) | crypto.js, ratchet.js, encrypted-persistence.js |
| PBKDF2 | Web Crypto API, 100.000 Iterationen, SHA-256 | crypto.js |
| HKDF | Web Crypto API, SHA-256 | encrypted-persistence.js |
| HMAC-SHA256 | Web Crypto API | ratchet.js |

### 2.2 Kurvenparameter (secp256k1)

```javascript
P  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8
a  = 0, b = 7
```

### 2.3 Bedenken bei der Implementierung

- **Keine constant-time Operationen**: BigInt-Arithmetik in JS ist nicht constant-time.
  Skalare Multiplikation via Double-and-Add ist anfaellig fuer Timing-Seitenkanaele.
- **Kein Side-Channel-Schutz**: Kein blinding, kein Montgomery ladder.
- **SHA-256 Pure JS**: Wird fuer synchrone Operationen genutzt (tagged hashes).
  Die async-Variante nutzt Web Crypto.

---

## 3. Identitaets- und Key-Management

### 3.1 Schluesselgenerierung

```
crypto.getRandomValues(new Uint8Array(32)) → 256-bit Private Key (hex)
Private Key → secp256k1 Point Multiplication → x-only Public Key (32 bytes)
```

### 3.2 Speicherung

| Was | Wo | Verschluesselung |
|-----|----|-----------------|
| Private Key (hex) | localStorage | **KEINE** (Klartext!) |
| Public Key (hex) | localStorage | Keine (oeffentlich) |
| Nickname | localStorage | Keine |
| Avatar (data URL) | localStorage | Keine |
| Room Password | sessionStorage | Keine (aber Tab-gebunden) |
| Yjs State + Updates | IndexedDB | AES-256-GCM (Master Key via HKDF) |
| Ratchet State | IndexedDB | AES-256-GCM (Master Key via HKDF) |

**KRITISCH**: Der Private Key liegt im Klartext in localStorage.
Jeder XSS-Angriff kann den Key extrahieren.

### 3.3 Challenge-Response Authentifizierung

```
Alice                                    Bob
  │                                       │
  │──── peer join ────────────────────────>│
  │                                       │
  │<─── nonce (32 bytes random) ──────────│
  │                                       │
  │  hash = SHA-256(nonce)                │
  │  sig  = Schnorr.sign(hash, privkey)   │
  │                                       │
  │──── { pubkey, sig } ─────────────────>│
  │                                       │
  │      hash' = SHA-256(nonce)           │
  │      valid = Schnorr.verify(sig,      │
  │              hash', pubkey)           │
  │                                       │
  │<─── verified ✓ ───────────────────────│
```

---

## 4. Verschluesselungs-Architektur

### 4.1 Nachrichtenverschluesselung (3 Layer)

```
Plaintext
    │
    ├─── Schnorr-Signatur: sig = sign(SHA256(pubkey||timestamp||channel||content), privkey)
    │
    ├─── Layer 1: Ratchet (Forward Secrecy) ──── wenn Sender Key vorhanden
    │    │
    │    ├── chainKey[n] → HMAC-SHA256(chainKey, "chain") = chainKey[n+1]
    │    ├── chainKey[n] → HMAC-SHA256(chainKey, "msg")   = messageKey[n]
    │    ├── AES-256-GCM(messageKey[n], plaintext) → { iv, ct, ci }
    │    └── chainKey[n] wird GELOESCHT (Forward Secrecy)
    │
    ├─── Layer 2: Room Key (Fallback) ──── wenn kein Ratchet
    │    │
    │    ├── PBKDF2(password, "nostr-discord-e2e-"+roomId, 100k iter) → roomKey
    │    └── AES-256-GCM(roomKey, plaintext) → { iv, ct }
    │
    └─── Layer 3: Klartext (kein Passwort) ──── letzter Fallback
```

### 4.2 Nachrichtenstruktur in Yjs CRDT

```javascript
{
  id: "pubkey8chars-timestamp-random4chars",
  pubkey: "64-hex-pubkey",
  channel: "allgemein",
  created_at: 1707840000,          // Unix timestamp
  sig: "128-hex-schnorr-sig",      // Signatur ueber Klartext

  // Genau EINES davon:
  ratchet:   { iv, ct, ci },       // Forward Secrecy verschluesselt
  encrypted: { iv, ct },           // Room Key verschluesselt
  content:   "plaintext"           // Unverschluesselt
}
```

### 4.3 Entschluesselungs-Reihenfolge

```
msg.ratchet?   → Ratchet.decrypt(pubkey, ratchet) → Plaintext
msg.encrypted? → AES-GCM.decrypt(roomKey, encrypted) → Plaintext
msg.content?   → direkt Plaintext
Dann:          → Schnorr.verify(sig, plaintext) → Signaturcheck
```

---

## 5. Forward Secrecy (Sender Keys + Symmetric Ratchet)

### 5.1 Design

Kein vollstaendiger Double Ratchet (Signal Protocol), sondern **Sender Keys**
(aehnlich wie Signal Group Messages):

```
Jeder Teilnehmer hat:
- Einen eigenen Sender Key (32 bytes random)
- Einen Chain Index (Zaehler)

Chain-KDF (HMAC-SHA256):
  chainKey[n+1] = HMAC(chainKey[n], "chain")
  messageKey[n] = HMAC(chainKey[n], "msg")

Forward Secrecy:
  chainKey[n] wird nach Benutzung geloescht.
  Aus chainKey[n+1] ist chainKey[n] NICHT ableitbar.
```

### 5.2 Sender Key Distribution

```
Alice (verified)                     Bob (verified)
  │                                    │
  │  senderKey = random(32 bytes)      │
  │  shared    = ECDH(alice_priv,      │
  │              bob_pub)              │
  │  wrapKey   = SHA-256(shared)       │
  │  wrapped   = AES-GCM(wrapKey,     │
  │              senderKey)            │
  │                                    │
  │──── { pubkey, wrapped,             │
  │       chainIndex } ──────────────>│
  │                                    │
  │       shared' = ECDH(bob_priv,     │
  │                 alice_pub)         │
  │       wrapKey' = SHA-256(shared')  │
  │       senderKey = AES-GCM.decrypt( │
  │                   wrapKey', wrapped)│
  │                                    │
  │       peerChains[alice] = {        │
  │         chainKey: senderKey,       │
  │         chainIndex: ci             │
  │       }                            │
```

### 5.3 Out-of-Order Handling

```
Erwarteter Index: 5, Empfangener Index: 8

→ Ratchet von 5 bis 7 vorwaerts
→ Cache messageKey[5], messageKey[6], messageKey[7]
→ Benutze messageKey[8] fuer Entschluesselung
→ MAX_SKIP = 500 (DoS-Schutz)
→ Max 200 gecachte uebersprungene Keys
```

### 5.4 Einschraenkungen

- **Kein DH-Ratchet**: Nur symmetrischer Ratchet. Wenn der aktuelle Sender Key
  kompromittiert wird, sind ALLE zukuenftigen Nachrichten lesbar (bis Key Rotation).
- **Sender Key Distribution nur nach Challenge-Response**: Wenn Challenge fehlschlaegt,
  kein Forward Secrecy fuer diesen Peer.
- **Keine automatische Key Rotation**: `rotateSenderKey()` existiert, wird aber
  nicht automatisch aufgerufen.
- **Kein Sender Key bei Gruppen-Join**: Neue Peers bekommen den aktuellen Chain Key,
  koennen aber aeltere Nachrichten nicht entschluesseln.

---

## 6. Encryption at Rest (IndexedDB)

### 6.1 Master Key Derivation

```
privateKey (32 bytes hex from localStorage)
    │
    └─── HKDF-SHA-256
         │  salt: "campfire-v1"
         │  info: "indexeddb-encryption"
         │
         └─── AES-256-GCM CryptoKey (non-extractable)
```

### 6.2 Speicherformat

```
IndexedDB: "campfire-encrypted-{roomId}"
├── updates (Store)     ─── Inkrementelle Yjs-Updates
│   └── { id, data: [12 bytes IV || AES-GCM ciphertext], ts }
├── state (Store)       ─── Kompaktierter Vollzustand
│   └── { key: "full-state", data: [IV || ciphertext], ts }
└── ratchet (Store)     ─── Ratchet Chain Keys
    └── { key: "ratchet-state", data: [IV || ciphertext], ts }
```

### 6.3 Compaction

```
Alle 50 Updates:
1. Yjs.encodeStateAsUpdate(ydoc) → fullState
2. AES-GCM(masterKey, fullState) → encrypted → STATE_STORE
3. UPDATES_STORE.clear()
4. updateCount = 0
```

### 6.4 Migration

Beim Start wird die alte unverschluesselte Datenbank geloescht:
```javascript
indexedDB.deleteDatabase('nostr-p2p-' + roomId);
```

---

## 7. Datenfluss (kompletter Nachrichtenweg)

```
[User tippt Nachricht]
        │
        ▼
    chat.js: sendMessage()
        │
        ├── Schnorr.sign(SHA256(pubkey||ts||channel||content), privkey) → sig
        │
        ├── Ratchet.encrypt(content)
        │   ├── kdfChain(senderChainKey) → [nextChain, msgKey]
        │   ├── AES-GCM(msgKey, content) → {iv, ct}
        │   ├── senderChainKey = nextChain (forward!)
        │   └── return {iv, ct, ci: chainIndex}
        │
        ├── msg = { id, pubkey, channel, created_at, sig, ratchet }
        │
        └── P2P.getMessages(channel).push([msg])
                │
                ▼
            Yjs CRDT Update
                │
        ┌───────┴───────┐
        │               │
        ▼               ▼
    Trystero         EncryptedPersistence
    (WebRTC)            │
    → sendYjsUpdate     ├── encryptBlob(update)
      to all peers      │   ├── IV = random(12)
                        │   ├── AES-GCM(masterKey, update)
                        │   └── store [IV || ciphertext] in IndexedDB
                        │
                        └── if updateCount >= 50 → compact()
```

---

## 8. P2P-Netzwerk

### 8.1 Signaling

- **Trystero** mit NOSTR-Strategie
- NOSTR-Relays NUR fuer WebRTC-Signaling (SDP/ICE)
- Keine Nachrichten gehen ueber Relays
- AppId: `nostr-discord-p2p-{roomId}`

### 8.2 Data Channels (Trystero Actions)

| Action | Zweck | Daten |
|--------|-------|-------|
| `yjs-sync` | Yjs State Vector Exchange | Binary |
| `yjs-update` | Yjs CRDT Updates | Binary |
| `meta` | Nickname, Avatar, Pubkey | JSON |
| `chat-msg` | Real-time Chat Actions | JSON |
| `nick-req` | Nickname Request | String |
| `auth-challenge` | Challenge Nonce | String (hex) |
| `auth-resp` | Challenge Response | JSON { pubkey, sig } |
| `sender-key` | Forward Secrecy Key Exchange | JSON { pubkey, wrappedKey, chainIndex } |

### 8.3 Peer Lifecycle

```
1. room.onPeerJoin(peerId)
   ├── Send metadata (pubkey, nickname, avatar)
   ├── Request their metadata
   ├── Send auth challenge (random nonce)
   └── Sync Yjs state vector

2. Challenge-Response verifies identity

3. After verification:
   └── Send wrapped sender key for forward secrecy

4. room.onPeerLeave(peerId)
   ├── Remove from peers map
   ├── Remove from verified set
   └── Clean up pending challenges
```

---

## 9. Datei-Struktur

```
client/
├── index.html                    # Entry Point, Modals, Layout
├── css/
│   └── style.css                 # Discord-like UI Styles
├── js/
│   ├── noble-loader.js           # Crypto Primitiven (secp256k1, SHA-256, Schnorr, ECDH)
│   ├── crypto.js                 # NOSTR Key Mgmt, E2E (AES-GCM), Signing, PBKDF2
│   ├── encrypted-persistence.js  # IndexedDB Encryption (HKDF Master Key)
│   ├── ratchet.js                # Forward Secrecy (Sender Keys, HMAC Chain)
│   ├── p2p.js                    # P2P Layer (Trystero, Yjs, Auth, Key Exchange)
│   ├── chat.js                   # Chat Logic (Send, Render, Decrypt, Verify)
│   ├── voice.js                  # Voice Chat (WebRTC Audio)
│   ├── screenshare.js            # Screen Sharing (WebRTC Video)
│   └── app.js                    # App Init, UI Setup, Settings
└── tests/
    └── test-security.html        # Security Test Suite (10 Suites, ~30 Tests)
```

### Script-Ladereihenfolge (wichtig!)

```
1. noble-loader.js     → window.nobleSecp256k1, window.nobleHashes
2. crypto.js           → NostrCrypto (IIFE)
3. encrypted-persist.  → EncryptedPersistence (IIFE)
4. ratchet.js          → Ratchet (IIFE)
5. p2p.js              → P2P (IIFE)
6. chat.js             → NostrChat (IIFE)
7. voice.js            → NostrVoice (IIFE)
8. screenshare.js      → NostrScreenShare (IIFE)
9. app.js              → App (IIFE) + DOMContentLoaded trigger
```

CDN-Abhaengigkeiten (ESM, geladen vor App-Scripts):
- `trystero/nostr` → `window.trysteroJoinRoom`
- `yjs` → `window.Yjs`

---

## 10. Bekannte Schwachstellen und Angriffsvektoren

### 10.1 Kritisch

| # | Schwachstelle | Impact | Bemerkung |
|---|--------------|--------|-----------|
| 1 | Private Key in localStorage (Klartext) | Key Theft via XSS | Jeder XSS-Angriff kann den Key stehlen |
| 2 | Keine constant-time Crypto | Timing Side-Channel | BigInt-Operationen in JS sind variable-time |
| 3 | Room Password in sessionStorage | Password Extraction via XSS | Zumindest Tab-gebunden |

### 10.2 Hoch

| # | Schwachstelle | Impact | Bemerkung |
|---|--------------|--------|-----------|
| 4 | Kein DH-Ratchet (nur symmetrischer) | Begrenzte Forward Secrecy | Kompromittierter Sender Key → alle zukuenftigen Nachrichten |
| 5 | Keine automatische Key Rotation | Langlebige Sender Keys | rotateSenderKey() nie aufgerufen |
| 6 | Master Key deterministisch aus Private Key | Single Point of Failure | Wer Private Key hat, hat auch Master Key |
| 7 | Keine Integrity-Checks auf Yjs CRDT | CRDT Poisoning moeglich | Malicious Peer kann CRDT manipulieren |

### 10.3 Mittel

| # | Schwachstelle | Impact | Bemerkung |
|---|--------------|--------|-----------|
| 8 | PBKDF2 100k Iterationen | Schwaches Passwort knackbar | Argon2id waere besser, aber nicht in Web Crypto |
| 9 | avatarCache/innerHTML mit data URLs | Potenzielle XSS-Vektoren | escapeHtml vorhanden, aber img src=data:... |
| 10 | Kein Certificate Pinning fuer NOSTR Relays | MitM auf Signaling | WebRTC DTLS schuetzt Daten, aber Signaling angreifbar |

---

## 11. Offene Fragen fuer Review

1. **Ist die secp256k1-Implementierung kryptographisch korrekt?**
   - Besonders: liftX(), Schnorr Nonce-Generierung, Point.multiply()

2. **Ist die Sender-Key-Distribution sicher?**
   - ECDH → SHA-256 → AES-GCM Wrap. Reicht SHA-256 als KDF oder sollte HKDF genutzt werden?

3. **Forward Secrecy Bewertung:**
   - Ohne DH-Ratchet: Wie stark ist der Schutz wirklich?
   - Was passiert wenn ein Peer den Sender Key verliert und spaeter Messages ankommen?

4. **IndexedDB Encryption:**
   - Master Key aus Private Key via HKDF. Wenn der Private Key kompromittiert wird,
     ist auch die IndexedDB entschluesselbar. Ist das akzeptabel?

5. **CRDT-Integritaet:**
   - Yjs Updates werden ueber WebRTC synchronisiert. Kann ein boesartiger Peer
     den CRDT-Zustand korrumpieren?

6. **XSS-Haertung:**
   - localStorage-Keys im Klartext. Welche Massnahmen waeren realistisch?

---

## 12. Test Coverage

### test-security.html (10 Suites)

| Suite | Tests | Was wird getestet |
|-------|-------|-------------------|
| Noble Crypto Primitives | 4 | Key Gen, Hex Format, Determinism |
| Schnorr Signatures | 4 | Sign/Verify, Wrong Message, Wrong Key |
| Message Payload Signing | 4 | Sign/Verify, Tampered Content/Timestamp/Channel |
| AES-256-GCM Encryption | 4 | Roundtrip, Random IV, Wrong Key Rejection |
| ECDH Key Exchange | 3 | Shared Secret Match, Different Peers |
| HMAC-SHA256 + KDF Chain | 4 | Output Size, Determinism, Chain Advancement |
| Encrypted Persistence | 3 | HKDF Derivation, Roundtrip, Wrong Key |
| Sender Key Wrapping | 2 | ECDH Wrap/Unwrap, Unauthorized Unwrap |
| Full Ratchet Roundtrip | 4 | 3 Messages + Forward Secrecy Property |
| Key Rotation | 2 | Fresh Key Gen, Chain Reset |

---

*Dokument generiert am 2026-02-13 fuer externe Architektur-Analyse.*
*Quellcode: github.com/nikitawenzel-sudo/Test, Branch: claude/explain-codebase-...*
