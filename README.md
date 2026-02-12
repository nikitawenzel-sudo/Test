# NOSTR-Discord

Dezentraler Chat mit Voice & Screen Share für max. 10 Personen.
Architektur nach NOSTR-Prinzipien: Schlüsselpaare, signierte Events, Relays.

## Features

- **Text-Chat** mit Channels (wie Discord)
- **Voice-Chat** via WebRTC Mesh-Netzwerk
- **Screen Share** via WebRTC
- **Kryptographische Identität** (secp256k1 Schlüsselpaare)
- **Signierte Events** (NIP-01 kompatibel)
- **Dark Theme** UI

## Projektstruktur

```
nostr-discord/
├── relay/                  # Backend (Node.js)
│   ├── package.json
│   ├── server.js           # WebSocket-Server + Signaling
│   ├── store.js            # Event-Speicher (SQLite)
│   └── Dockerfile
├── client/                 # Frontend (Web-App)
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── app.js          # Hauptlogik
│       ├── crypto.js       # Schlüsselpaar & Signierung
│       ├── relay.js        # WebSocket-Verbindung
│       ├── chat.js         # Text-Chat
│       ├── voice.js        # WebRTC Voice
│       └── screenshare.js  # WebRTC Screen Share
├── docker-compose.yml
└── README.md
```

## Schnellstart

### Relay starten

```bash
cd relay
npm install
node server.js
```

Der Relay-Server läuft auf `ws://localhost:8080`.

### Client öffnen

Öffne `client/index.html` im Browser (oder hoste die Dateien mit einem beliebigen HTTP-Server).

```bash
# Option: mit Python
cd client
python3 -m http.server 3000
# Dann http://localhost:3000 öffnen
```

### Mit Docker

```bash
docker-compose up -d
```

## Event-Kinds

| Kind  | Beschreibung |
|-------|-------------|
| 0     | Profil-Metadaten (Nickname) |
| 1     | Chat-Nachricht |
| 7     | Reaction |
| 25000 | WebRTC Signaling (wird nicht gespeichert) |

## Protokoll

Das Protokoll folgt NIP-01:

- Client → Relay: `["EVENT", event]`, `["REQ", subId, filter]`, `["CLOSE", subId]`
- Relay → Client: `["EVENT", subId, event]`, `["EOSE", subId]`, `["OK", eventId, bool, message]`

## STUN/TURN

WebRTC nutzt öffentliche STUN-Server:
- `stun:stun.l.google.com:19302`
- `stun:stun1.l.google.com:19302`

Für Nutzer hinter strikten NATs wird ein TURN-Server benötigt (z.B. coturn).
