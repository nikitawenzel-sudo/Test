// app.js - Main Application Logic

const App = (() => {
  let keyPair = null;
  let relayUrl = 'ws://localhost:8080';

  // Resize avatar image to 96x96 JPEG
  function resizeAvatar(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const size = 96;
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          // Crop to square from center
          const minDim = Math.min(img.width, img.height);
          const sx = (img.width - minDim) / 2;
          const sy = (img.height - minDim) / 2;
          ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size);
          resolve(canvas.toDataURL('image/jpeg', 0.7));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function setupAvatarUpload(uploadEl, inputEl, previewEl) {
    uploadEl.addEventListener('click', () => inputEl.click());
    inputEl.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const dataUrl = await resizeAvatar(file);
      previewEl.innerHTML = `<img src="${dataUrl}">`;
      previewEl.classList.add('has-image');
      previewEl.dataset.avatar = dataUrl;
    });
  }

  function updateServerHeader() {
    const serverName = localStorage.getItem('server_name') || 'NOSTR Discord';
    const serverIcon = localStorage.getItem('server_icon');

    const nameEl = document.getElementById('server-name');
    const iconEl = document.getElementById('server-icon');

    if (nameEl) nameEl.textContent = serverName;
    if (iconEl) {
      iconEl.innerHTML = serverIcon
        ? `<img src="${serverIcon}">`
        : '🌐';
    }

    // Update page title too
    document.title = serverName;
  }

  function updateMyAvatar() {
    const avatarEl = document.getElementById('my-avatar');
    const avatar = NostrCrypto.getAvatar();
    if (avatarEl) {
      if (avatar) {
        avatarEl.innerHTML = `<img class="avatar-img" src="${avatar}">`;
      } else {
        const nick = NostrCrypto.getNickname() || '?';
        avatarEl.textContent = nick.charAt(0).toUpperCase();
      }
    }
  }

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
    const avatarUpload = document.getElementById('setup-avatar-upload');
    const avatarInput = document.getElementById('setup-avatar-input');
    const avatarPreview = document.getElementById('setup-avatar-preview');

    relayInput.value = relayUrl;

    // Setup avatar upload
    setupAvatarUpload(avatarUpload, avatarInput, avatarPreview);

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

      // Save avatar if uploaded
      const avatarData = avatarPreview.dataset.avatar;
      if (avatarData) {
        NostrCrypto.setAvatar(avatarData);
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

    // Show avatar in user panel
    updateMyAvatar();

    // Show server name and icon
    updateServerHeader();

    // Initialize modules
    NostrChat.init(keyPair);
    NostrVoice.init(keyPair);
    NostrScreenShare.init(keyPair);

    // Set local avatar in cache so it's available for rendering
    const myAvatar = NostrCrypto.getAvatar();
    if (myAvatar) {
      NostrChat.setLocalAvatar(keyPair.publicKey, myAvatar);
    }

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

    // Setup server settings
    setupServerSettings();

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
      const settingsAvatarUpload = document.getElementById('settings-avatar-upload');
      const settingsAvatarInput = document.getElementById('settings-avatar-input');
      const settingsAvatarPreview = document.getElementById('settings-avatar-preview');

      // Setup avatar upload for settings
      setupAvatarUpload(settingsAvatarUpload, settingsAvatarInput, settingsAvatarPreview);

      settingsBtn.addEventListener('click', () => {
        document.getElementById('settings-nickname').value = NostrCrypto.getNickname() || '';
        document.getElementById('settings-relay').value = localStorage.getItem('nostr_relay') || relayUrl;
        document.getElementById('settings-pubkey').textContent = keyPair.publicKey;
        document.getElementById('settings-privkey').textContent = '••••••••••••••••';

        // Show current avatar in settings
        const currentAvatar = NostrCrypto.getAvatar();
        if (currentAvatar) {
          settingsAvatarPreview.innerHTML = `<img src="${currentAvatar}">`;
          settingsAvatarPreview.classList.add('has-image');
          settingsAvatarPreview.dataset.avatar = currentAvatar;
        } else {
          const nick = NostrCrypto.getNickname() || '?';
          settingsAvatarPreview.innerHTML = nick.charAt(0).toUpperCase();
          settingsAvatarPreview.classList.remove('has-image');
          delete settingsAvatarPreview.dataset.avatar;
        }

        settingsModal.style.display = 'flex';
      });

      document.getElementById('settings-close')?.addEventListener('click', () => {
        settingsModal.style.display = 'none';
      });

      document.getElementById('settings-save')?.addEventListener('click', async () => {
        const newNick = document.getElementById('settings-nickname').value.trim();
        const newRelay = document.getElementById('settings-relay').value.trim();

        // Save avatar if changed
        const newAvatar = settingsAvatarPreview.dataset.avatar;
        if (newAvatar && newAvatar !== NostrCrypto.getAvatar()) {
          NostrCrypto.setAvatar(newAvatar);
          NostrChat.setLocalAvatar(keyPair.publicKey, newAvatar);
          updateMyAvatar();
        }

        // Publish nickname (will include avatar)
        if (newNick) {
          await NostrChat.publishNickname(newNick);
          document.getElementById('my-nickname').textContent = newNick;
        }

        if (newRelay && newRelay !== relayUrl) {
          localStorage.setItem('nostr_relay', newRelay);
          alert('Relay geaendert. Bitte Seite neu laden.');
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

  function setupServerSettings() {
    const sidebarHeader = document.getElementById('sidebar-header');
    const serverModal = document.getElementById('server-settings-modal');
    if (!sidebarHeader || !serverModal) return;

    const serverIconUpload = document.getElementById('server-icon-upload');
    const serverIconInput = document.getElementById('server-icon-input');
    const serverIconPreview = document.getElementById('server-icon-preview');
    const serverNameInput = document.getElementById('server-name-input');

    // Setup icon upload (reuse existing avatar upload helper)
    setupAvatarUpload(serverIconUpload, serverIconInput, serverIconPreview);

    // Click header to open server settings
    sidebarHeader.addEventListener('click', () => {
      const currentName = localStorage.getItem('server_name') || 'NOSTR Discord';
      const currentIcon = localStorage.getItem('server_icon');

      serverNameInput.value = currentName;

      if (currentIcon) {
        serverIconPreview.innerHTML = `<img src="${currentIcon}">`;
        serverIconPreview.classList.add('has-image');
        serverIconPreview.dataset.avatar = currentIcon;
      } else {
        serverIconPreview.innerHTML = '🌐';
        serverIconPreview.classList.remove('has-image');
        delete serverIconPreview.dataset.avatar;
      }

      serverModal.style.display = 'flex';
    });

    document.getElementById('server-settings-close')?.addEventListener('click', () => {
      serverModal.style.display = 'none';
    });

    document.getElementById('server-settings-save')?.addEventListener('click', () => {
      const newName = serverNameInput.value.trim();
      if (newName) {
        localStorage.setItem('server_name', newName);
      }

      const newIcon = serverIconPreview.dataset.avatar;
      if (newIcon) {
        localStorage.setItem('server_icon', newIcon);
      }

      updateServerHeader();
      serverModal.style.display = 'none';
    });
  }

  return { init };
})();

// Start app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
