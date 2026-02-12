// app.js - Main Application Logic

const App = (() => {
  let keyPair = null;
  let relayUrl = 'ws://localhost:8080';

  async function init() {
    // Show setup modal if first time
    const hasKey = localStorage.getItem('nostr_privkey');
    const hasNick = localStorage.getItem('nostr_nickname');
    const savedRelay = localStorage.getItem('nostr_relay');

    if (savedRelay) relayUrl = savedRelay;

    if (!hasKey || !hasNick) {
      showSetupModal();
    } else {
      await startApp();
    }
  }

  function showSetupModal() {
    const modal = document.getElementById('setup-modal');
    modal.style.display = 'flex';

    const relayInput = document.getElementById('setup-relay');
    const nickInput = document.getElementById('setup-nickname');
    const startBtn = document.getElementById('setup-start');
    const importKeyInput = document.getElementById('setup-import-key');

    relayInput.value = relayUrl;

    startBtn.addEventListener('click', async () => {
      const nickname = nickInput.value.trim();
      if (!nickname) {
        nickInput.classList.add('error');
        return;
      }

      relayUrl = relayInput.value.trim() || relayUrl;
      localStorage.setItem('nostr_relay', relayUrl);

      // Import or generate key
      const importKey = importKeyInput.value.trim();
      if (importKey && importKey.length === 64) {
        localStorage.setItem('nostr_privkey', importKey);
      }

      NostrCrypto.setNickname(nickname);
      modal.style.display = 'none';
      await startApp();
    });

    // Enter key support
    nickInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') startBtn.click();
    });
  }

  async function startApp() {
    // Load keys
    keyPair = NostrCrypto.loadOrCreateKeyPair();
    console.log('Public Key:', keyPair.publicKey);

    // Update UI with pubkey
    const pubkeyEl = document.getElementById('my-pubkey');
    if (pubkeyEl) pubkeyEl.textContent = NostrCrypto.shortenPubkey(keyPair.publicKey);

    const nicknameEl = document.getElementById('my-nickname');
    if (nicknameEl) nicknameEl.textContent = NostrCrypto.getNickname();

    // Initialize modules
    NostrChat.init(keyPair);
    NostrVoice.init(keyPair);
    NostrScreenShare.init(keyPair);

    // Connect to relay
    updateConnectionStatus('connecting');
    try {
      await NostrRelay.connect(relayUrl);
      updateConnectionStatus('connected');

      // Publish nickname
      await NostrChat.publishNickname(NostrCrypto.getNickname());
    } catch (e) {
      console.error('Connection failed:', e);
      updateConnectionStatus('disconnected');
    }

    NostrRelay.onConnect(async () => {
      updateConnectionStatus('connected');
      // Re-publish nickname on reconnect so other users see us
      try {
        const nick = NostrCrypto.getNickname();
        if (nick) await NostrChat.publishNickname(nick);
      } catch (e) {
        console.error('Failed to republish nickname:', e);
      }
    });
    NostrRelay.onDisconnect(() => updateConnectionStatus('disconnected'));

    // Setup channels
    setupChannels();

    // Setup chat input
    setupChatInput();

    // Setup voice controls
    setupVoiceControls();

    // Setup settings
    setupSettings();

    // Switch to default channel
    NostrChat.switchChannel('allgemein');
  }

  function updateConnectionStatus(status) {
    const statusEl = document.getElementById('connection-status');
    if (!statusEl) return;

    statusEl.className = 'status-indicator ' + status;
    const labels = {
      connected: '🟢 Verbunden',
      connecting: '🟡 Verbinde...',
      disconnected: '🔴 Getrennt'
    };
    statusEl.textContent = labels[status] || status;
  }

  function setupChannels() {
    const channelList = document.getElementById('channel-list');
    if (!channelList) return;

    const channels = NostrChat.getDefaultChannels();
    channelList.innerHTML = '';

    // Text channels section
    const textHeader = document.createElement('div');
    textHeader.className = 'channel-section-header';
    textHeader.textContent = 'TEXT CHANNELS';
    channelList.appendChild(textHeader);

    channels.forEach(channel => {
      const item = document.createElement('div');
      item.className = 'channel-item';
      item.dataset.channel = channel;
      item.innerHTML = `<span class="channel-hash">#</span> ${channel}`;
      item.addEventListener('click', () => NostrChat.switchChannel(channel));
      channelList.appendChild(item);
    });

    // Voice channel section
    const voiceHeader = document.createElement('div');
    voiceHeader.className = 'channel-section-header';
    voiceHeader.textContent = 'VOICE CHANNELS';
    channelList.appendChild(voiceHeader);

    const voiceItem = document.createElement('div');
    voiceItem.className = 'channel-item voice-channel';
    voiceItem.dataset.channel = 'voice-general';
    voiceItem.innerHTML = `<span class="channel-icon">🔊</span> Allgemein`;
    voiceItem.addEventListener('click', async () => {
      if (NostrVoice.isInVoice()) {
        await NostrVoice.leaveVoice();
      } else {
        await NostrVoice.joinVoice('voice-general');
      }
    });
    channelList.appendChild(voiceItem);

    // Voice users container
    const voiceUsers = document.createElement('div');
    voiceUsers.id = 'voice-users';
    voiceUsers.className = 'voice-users-list';
    channelList.appendChild(voiceUsers);

    // New channel input
    const newChannelDiv = document.createElement('div');
    newChannelDiv.className = 'new-channel';
    newChannelDiv.innerHTML = `
      <input type="text" id="new-channel-input" placeholder="+ Neuer Channel" />
    `;
    channelList.appendChild(newChannelDiv);

    document.getElementById('new-channel-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const name = e.target.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (name) {
          // Add new channel to list
          const item = document.createElement('div');
          item.className = 'channel-item';
          item.dataset.channel = name;
          item.innerHTML = `<span class="channel-hash">#</span> ${name}`;
          item.addEventListener('click', () => NostrChat.switchChannel(name));
          // Insert before voice header
          channelList.insertBefore(item, voiceHeader);

          NostrChat.switchChannel(name);
          e.target.value = '';
        }
      }
    });
  }

  function setupChatInput() {
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('btn-send');

    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
    }

    if (sendBtn) {
      sendBtn.addEventListener('click', sendMessage);
    }
  }

  function sendMessage() {
    const input = document.getElementById('chat-input');
    if (!input) return;

    const text = input.value.trim();
    if (text) {
      NostrChat.sendMessage(text);
      input.value = '';
      input.focus();
    }
  }

  function setupVoiceControls() {
    const muteBtn = document.getElementById('btn-mute');
    const deafenBtn = document.getElementById('btn-deafen');
    const shareBtn = document.getElementById('btn-screenshare');
    const disconnectBtn = document.getElementById('btn-voice-leave');

    if (muteBtn) {
      muteBtn.addEventListener('click', () => NostrVoice.toggleMute());
    }
    if (deafenBtn) {
      deafenBtn.addEventListener('click', () => NostrVoice.toggleDeafen());
    }
    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
        if (NostrScreenShare.getIsSharing()) {
          await NostrScreenShare.stopSharing();
        } else {
          await NostrScreenShare.startSharing();
        }
      });
    }
    if (disconnectBtn) {
      disconnectBtn.addEventListener('click', async () => {
        await NostrVoice.leaveVoice();
        await NostrScreenShare.stopSharing();
      });
    }
  }

  function setupSettings() {
    const settingsBtn = document.getElementById('btn-settings');
    const settingsModal = document.getElementById('settings-modal');

    if (settingsBtn && settingsModal) {
      settingsBtn.addEventListener('click', () => {
        document.getElementById('settings-nickname').value = NostrCrypto.getNickname() || '';
        document.getElementById('settings-relay').value = localStorage.getItem('nostr_relay') || relayUrl;
        document.getElementById('settings-pubkey').textContent = keyPair.publicKey;
        document.getElementById('settings-privkey').textContent = '••••••••••••••••';
        settingsModal.style.display = 'flex';
      });

      document.getElementById('settings-close')?.addEventListener('click', () => {
        settingsModal.style.display = 'none';
      });

      document.getElementById('settings-save')?.addEventListener('click', async () => {
        const newNick = document.getElementById('settings-nickname').value.trim();
        const newRelay = document.getElementById('settings-relay').value.trim();

        if (newNick && newNick !== NostrCrypto.getNickname()) {
          await NostrChat.publishNickname(newNick);
        }

        if (newRelay && newRelay !== relayUrl) {
          localStorage.setItem('nostr_relay', newRelay);
          // Would need to reconnect - simplified here
          alert('Relay geändert. Bitte Seite neu laden.');
        }

        settingsModal.style.display = 'none';
      });

      document.getElementById('settings-show-privkey')?.addEventListener('click', () => {
        const el = document.getElementById('settings-privkey');
        if (el.textContent.includes('•')) {
          el.textContent = keyPair.privateKey;
        } else {
          el.textContent = '••••••••••••••••';
        }
      });

      document.getElementById('settings-copy-pubkey')?.addEventListener('click', () => {
        navigator.clipboard.writeText(keyPair.publicKey);
      });
    }

    // Close modals on backdrop click
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.style.display = 'none';
      });
    });
  }

  return { init };
})();

// Start app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
