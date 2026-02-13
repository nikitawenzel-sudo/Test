// bootstrap.mjs - CDN Loader + App Script Bootstrapper
// Extracted from inline <script type="module"> for CSP compliance (no 'unsafe-inline')

// Import Trystero (NOSTR strategy for peer discovery)
import { joinRoom } from 'https://esm.sh/trystero/nostr';
window.trysteroJoinRoom = joinRoom;

// Import Yjs (CRDT for conflict-free data sync)
import * as Y from 'https://esm.sh/yjs';
window.Yjs = Y;

// y-indexeddb replaced by EncryptedPersistence (encrypted at rest)

// Once CDN libs are loaded, load app scripts in sequence
async function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.body.appendChild(script);
  });
}

try {
  await loadScript('js/noble-loader.js');
  await loadScript('js/crypto.js');
  await loadScript('js/encrypted-persistence.js');
  await loadScript('js/ratchet.js');
  await loadScript('js/p2p.js');
  await loadScript('js/chat.js');
  await loadScript('js/voice.js');
  await loadScript('js/screenshare.js');
  await loadScript('js/app.js');
  console.log('All P2P modules loaded successfully');
} catch (e) {
  console.error('Failed to load modules:', e);
  document.body.innerHTML = '<div style="color:white;padding:40px;text-align:center;">' +
    '<h2>Fehler beim Laden</h2>' +
    '<p>CDN-Bibliotheken konnten nicht geladen werden. Bitte Internetverbindung pruefen.</p>' +
    '<p style="color:#888;font-size:12px;">' + e.message + '</p>' +
    '</div>';
}
