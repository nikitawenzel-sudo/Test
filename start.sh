#!/bin/bash
# NOSTR-Discord Startscript

echo "========================================"
echo "  NOSTR-Discord - Startscript"
echo "========================================"
echo ""

# Relay starten
echo "[1/2] Relay-Server wird gestartet..."
cd relay

if [ ! -d "node_modules" ]; then
  echo "  -> Installiere Abhaengigkeiten..."
  npm install
fi

echo "  -> Relay laeuft auf ws://localhost:8080"
node server.js &
RELAY_PID=$!
cd ..

echo ""
echo "[2/2] Client bereit!"
echo ""
echo "========================================"
echo "  So geht's weiter:"
echo "========================================"
echo ""
echo "  1. Oeffne client/index.html im Browser"
echo "     oder starte einen lokalen Server:"
echo "     cd client && npx serve -l 3000"
echo ""
echo "  2. Fuer Internet-Zugang (mit Kumpel):"
echo "     ngrok http 8080"
echo "     -> Die wss:// URL als Relay eintragen"
echo ""
echo "  Relay PID: $RELAY_PID"
echo "  Zum Beenden: kill $RELAY_PID oder Ctrl+C"
echo "========================================"

# Warte auf Ctrl+C
trap "echo ''; echo 'Relay wird beendet...'; kill $RELAY_PID 2>/dev/null; exit 0" INT
wait $RELAY_PID
