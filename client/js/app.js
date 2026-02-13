// app.js - Main Application Logic (P2P Version)
// Task 1.1: Private Key is now encrypted with user password (PBKDF2 + AES-256-GCM)
// Key is only held in memory after login, never stored in plaintext

const App = (() => {
  let keyPair = null;
  let passwordHash = null; // SHA-256(identity password) hex, for master key derivation
  let roomId = 'nostr-discord-default';

  // Resize avatar/icon image to 96x96 JPEG
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

  // ====== PASSWORD STRENGTH UI HELPER ======

  function updatePasswordStrength(password, strengthEl) {
    if (!strengthEl) return;
    const strength = NostrCrypto.getPasswordStrength(password);
    const labels = { weak: 'Schwach', okay: 'Okay', strong: 'Stark' };
    strengthEl.className = 'password-strength ' + strength;

    // Find or create the label element
    let labelEl = strengthEl.nextElementSibling;
    if (!labelEl || !labelEl.classList.contains('password-strength-label')) {
      labelEl = document.createElement('div');
      labelEl.className = 'password-strength-label';
      strengthEl.parentNode.insertBefore(labelEl, strengthEl.nextSibling);
    }
    labelEl.className = 'password-strength-label ' + strength;
    labelEl.textContent = password ? labels[strength] : '';
  }

  // ====== INIT: Determine which flow to use ======

  async function init() {
    const savedRoom = localStorage.getItem('nostr_room');
    if (savedRoom) roomId = savedRoom;

    if (NostrCrypto.hasEncryptedIdentity()) {
      // Encrypted identity exists → show login modal
      showLoginModal();
    } else if (NostrCrypto.hasPlaintextKey()) {
      // Plaintext key found → needs migration to encrypted storage
      showMigrationModal();
    } else {
      // Fresh setup → create new identity
      showSetupModal();
    }
  }

  // ====== LOGIN MODAL (decrypt existing encrypted identity) ======

  function showLoginModal() {
    const modal = document.getElementById('login-modal');
    if (!modal) {
      // Fallback if modal element missing
      showSetupModal();
      return;
    }
    modal.style.display = 'flex';

    // Show welcome message with nickname
    const nickname = NostrCrypto.getNickname();
    const welcomeEl = document.getElementById('login-welcome');
    if (welcomeEl && nickname) {
      welcomeEl.textContent = 'Willkommen zurueck, ' + nickname + '!';
    }

    const passwordInput = document.getElementById('login-password');
    const unlockBtn = document.getElementById('login-unlock');
    const errorEl = document.getElementById('login-error');

    const doUnlock = async () => {
      const password = passwordInput.value;
      if (!password) {
        passwordInput.classList.add('error');
        return;
      }

      unlockBtn.disabled = true;
      unlockBtn.textContent = 'Entschluessele...';

      const privateKey = await NostrCrypto.decryptPrivateKey(password);
      if (!privateKey) {
        errorEl.style.display = 'block';
        passwordInput.classList.add('error');
        unlockBtn.disabled = false;
        unlockBtn.textContent = '\u{1F513} Entsperren';
        return;
      }

      keyPair = NostrCrypto.createKeyPair(privateKey);
      passwordHash = await NostrCrypto.hashPasswordForMasterKey(password);
      modal.style.display = 'none';
      checkRoomPassword();
    };

    unlockBtn.addEventListener('click', doUnlock);
    passwordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doUnlock();
      errorEl.style.display = 'none';
      passwordInput.classList.remove('error');
    });

    // Recovery button on login screen
    const recoverBtn = document.getElementById('login-recover');
    if (recoverBtn) {
      recoverBtn.addEventListener('click', () => showRestoreModal());
    }
  }

  // ====== MIGRATION MODAL (encrypt existing plaintext key) ======

  function showMigrationModal() {
    const modal = document.getElementById('migration-modal');
    if (!modal) {
      // Fallback: start with legacy flow
      keyPair = NostrCrypto.loadOrCreateKeyPair();
      checkRoomPassword();
      return;
    }
    modal.style.display = 'flex';

    const passwordInput = document.getElementById('migration-password');
    const saveBtn = document.getElementById('migration-save');
    const strengthEl = document.getElementById('migration-strength');

    passwordInput.addEventListener('input', () => {
      updatePasswordStrength(passwordInput.value, strengthEl);
    });

    const doMigrate = async () => {
      const password = passwordInput.value;
      if (!password) {
        passwordInput.classList.add('error');
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Verschluessele...';

      // Read existing plaintext key before it gets deleted
      const existingKey = localStorage.getItem('nostr_privkey');
      // Encrypt and store (also removes plaintext key from localStorage)
      await NostrCrypto.encryptPrivateKey(existingKey, password);

      keyPair = NostrCrypto.createKeyPair(existingKey);
      passwordHash = await NostrCrypto.hashPasswordForMasterKey(password);
      modal.style.display = 'none';

      // Show recovery code after migration
      showRecoveryCode(existingKey, () => checkRoomPassword());
    };

    saveBtn.addEventListener('click', doMigrate);
    passwordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doMigrate();
    });
  }

  // ====== ROOM PASSWORD CHECK (after identity is unlocked) ======

  function checkRoomPassword() {
    if (NostrCrypto.getRoomPassword()) {
      // Room password already in sessionStorage
      startApp();
    } else {
      // Ask for room password (E2E encryption)
      showRoomPasswordPrompt();
    }
  }

  function showRoomPasswordPrompt() {
    const modal = document.getElementById('password-modal');
    if (!modal) {
      startApp();
      return;
    }
    modal.style.display = 'flex';

    const passwordInput = document.getElementById('prompt-password');
    const unlockBtn = document.getElementById('prompt-unlock');
    const skipBtn = document.getElementById('prompt-skip');

    unlockBtn.addEventListener('click', async () => {
      const password = passwordInput.value.trim();
      if (password) {
        NostrCrypto.setRoomPassword(password);
      }
      modal.style.display = 'none';
      await startApp();
    });

    skipBtn.addEventListener('click', async () => {
      modal.style.display = 'none';
      await startApp();
    });

    passwordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') unlockBtn.click();
    });
  }

  // ====== SETUP MODAL (new identity with encrypted key) ======

  function showSetupModal() {
    const modal = document.getElementById('setup-modal');
    modal.style.display = 'flex';

    const roomInput = document.getElementById('setup-room');
    const roomPasswordInput = document.getElementById('setup-password');
    const nickInput = document.getElementById('setup-nickname');
    const identityPasswordInput = document.getElementById('setup-identity-password');
    const strengthEl = document.getElementById('setup-password-strength');
    const startBtn = document.getElementById('setup-start');
    const importKeyInput = document.getElementById('setup-import-key');
    const avatarUpload = document.getElementById('setup-avatar-upload');
    const avatarInput = document.getElementById('setup-avatar-input');
    const avatarPreview = document.getElementById('setup-avatar-preview');

    roomInput.value = roomId;

    setupAvatarUpload(avatarUpload, avatarInput, avatarPreview);

    // Password strength indicator
    if (identityPasswordInput && strengthEl) {
      identityPasswordInput.addEventListener('input', () => {
        updatePasswordStrength(identityPasswordInput.value, strengthEl);
      });
    }

    startBtn.addEventListener('click', async () => {
      const nickname = nickInput.value.trim();
      if (!nickname) {
        nickInput.classList.add('error');
        return;
      }

      const identityPassword = identityPasswordInput ? identityPasswordInput.value : '';
      if (!identityPassword) {
        if (identityPasswordInput) identityPasswordInput.classList.add('error');
        return;
      }

      roomId = roomInput.value.trim() || roomId;
      localStorage.setItem('nostr_room', roomId);

      // Save room password in sessionStorage (cleared on tab close)
      const roomPassword = roomPasswordInput.value.trim();
      if (roomPassword) {
        NostrCrypto.setRoomPassword(roomPassword);
      }

      // Generate or import private key
      let privateKey;
      const importKey = importKeyInput.value.trim();
      if (importKey && importKey.length === 64) {
        privateKey = importKey;
      } else {
        privateKey = NostrCrypto.generatePrivateKey();
      }

      // Save nickname first (needed by encryptPrivateKey)
      NostrCrypto.setNickname(nickname);

      // Avatar
      const avatarData = avatarPreview.dataset.avatar;
      if (avatarData) {
        NostrCrypto.setAvatar(avatarData);
      }

      // Encrypt and store private key (removes any plaintext key)
      startBtn.disabled = true;
      startBtn.textContent = 'Verschluessele...';
      await NostrCrypto.encryptPrivateKey(privateKey, identityPassword);

      keyPair = NostrCrypto.createKeyPair(privateKey);
      passwordHash = await NostrCrypto.hashPasswordForMasterKey(identityPassword);
      modal.style.display = 'none';

      // Show recovery code before starting app
      showRecoveryCode(privateKey, () => startApp());
    });

    nickInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') startBtn.click();
    });
  }

  // ====== RECOVERY CODE DISPLAY (after setup) ======

  function showRecoveryCode(privateKeyHex, onContinue) {
    const modal = document.getElementById('recovery-modal');
    if (!modal) {
      // No modal element, skip recovery display
      if (onContinue) onContinue();
      return;
    }

    const code = NostrCrypto.generateRecoveryCode(privateKeyHex);
    const codeDisplay = document.getElementById('recovery-code-display');
    const copyBtn = document.getElementById('recovery-copy');
    const confirmCb = document.getElementById('recovery-confirm');
    const continueBtn = document.getElementById('recovery-continue');

    codeDisplay.textContent = code;
    confirmCb.checked = false;
    continueBtn.disabled = true;

    modal.style.display = 'flex';

    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(code);
      copyBtn.textContent = '\u2705 Kopiert!';
      setTimeout(() => { copyBtn.textContent = '\u{1F4CB} Kopieren'; }, 2000);
    });

    confirmCb.addEventListener('change', () => {
      continueBtn.disabled = !confirmCb.checked;
    });

    continueBtn.addEventListener('click', () => {
      modal.style.display = 'none';
      if (onContinue) onContinue();
    });
  }

  // ====== RESTORE ACCOUNT (from recovery code) ======

  function showRestoreModal() {
    const modal = document.getElementById('restore-modal');
    if (!modal) return;

    // Close login modal if open
    const loginModal = document.getElementById('login-modal');
    if (loginModal) loginModal.style.display = 'none';

    modal.style.display = 'flex';

    const codeInput = document.getElementById('restore-code');
    const passwordInput = document.getElementById('restore-password');
    const strengthEl = document.getElementById('restore-strength');
    const submitBtn = document.getElementById('restore-submit');
    const cancelBtn = document.getElementById('restore-cancel');
    const errorEl = document.getElementById('restore-error');

    // Auto-format recovery code input with dashes
    codeInput.addEventListener('input', () => {
      const cursor = codeInput.selectionStart;
      const raw = codeInput.value.replace(/[^23456789A-HJ-NP-Za-hj-np-z]/g, '').toUpperCase();
      const formatted = raw.match(/.{1,4}/g)?.join('-') || '';
      codeInput.value = formatted;
      // Try to maintain cursor position
      const dashesBeforeCursor = (formatted.slice(0, cursor).match(/-/g) || []).length;
      const rawBeforeCursor = (codeInput.value.slice(0, cursor).replace(/-/g, '') || '').length;
      const newCursor = rawBeforeCursor + Math.floor(rawBeforeCursor / 4);
      codeInput.setSelectionRange(Math.min(newCursor + dashesBeforeCursor, formatted.length), Math.min(newCursor + dashesBeforeCursor, formatted.length));
      errorEl.style.display = 'none';
    });

    passwordInput.addEventListener('input', () => {
      updatePasswordStrength(passwordInput.value, strengthEl);
    });

    const doRestore = async () => {
      const code = codeInput.value;
      const password = passwordInput.value;

      if (!code) {
        codeInput.classList.add('error');
        return;
      }
      if (!password) {
        passwordInput.classList.add('error');
        return;
      }

      // Decode and validate recovery code
      const privateKey = NostrCrypto.recoverFromCode(code);
      if (!privateKey) {
        errorEl.style.display = 'block';
        codeInput.classList.add('error');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Verschluessele...';

      // Encrypt with new password
      await NostrCrypto.encryptPrivateKey(privateKey, password);

      keyPair = NostrCrypto.createKeyPair(privateKey);
      passwordHash = await NostrCrypto.hashPasswordForMasterKey(password);
      modal.style.display = 'none';
      checkRoomPassword();
    };

    submitBtn.addEventListener('click', doRestore);
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') passwordInput.focus();
    });
    passwordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doRestore();
    });

    cancelBtn.addEventListener('click', () => {
      modal.style.display = 'none';
      // Re-show login modal
      showLoginModal();
    });
  }

  // ====== RECOVERY VIEW (from settings, password required) ======

  function showRecoveryView() {
    const modal = document.getElementById('recovery-view-modal');
    if (!modal) return;

    const authSection = document.getElementById('recovery-view-auth');
    const codeDisplay = document.getElementById('recovery-view-code');
    const passwordInput = document.getElementById('recovery-view-password');
    const unlockBtn = document.getElementById('recovery-view-unlock');
    const errorEl = document.getElementById('recovery-view-error');
    const closeBtn = document.getElementById('recovery-view-close');

    // Reset state
    authSection.style.display = 'block';
    codeDisplay.style.display = 'none';
    codeDisplay.textContent = '';
    passwordInput.value = '';
    errorEl.style.display = 'none';

    modal.style.display = 'flex';

    const doUnlock = async () => {
      const password = passwordInput.value;
      if (!password) {
        passwordInput.classList.add('error');
        return;
      }

      unlockBtn.disabled = true;
      unlockBtn.textContent = 'Entschluessele...';

      const privateKey = await NostrCrypto.decryptPrivateKey(password);
      if (!privateKey) {
        errorEl.style.display = 'block';
        passwordInput.classList.add('error');
        unlockBtn.disabled = false;
        unlockBtn.textContent = 'Anzeigen';
        return;
      }

      const code = NostrCrypto.generateRecoveryCode(privateKey);
      authSection.style.display = 'none';
      codeDisplay.textContent = code;
      codeDisplay.style.display = 'block';
      unlockBtn.disabled = false;
      unlockBtn.textContent = 'Anzeigen';
    };

    unlockBtn.addEventListener('click', doUnlock);
    passwordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doUnlock();
      errorEl.style.display = 'none';
      passwordInput.classList.remove('error');
    });

    closeBtn.addEventListener('click', () => {
      codeDisplay.textContent = '';
      modal.style.display = 'none';
    });
  }

  // ====== START APP (keyPair must be set before calling) ======

  async function startApp() {
    // keyPair should already be set from login/setup/migration
    if (!keyPair) {
      console.error('startApp called without keyPair');
      return;
    }
    console.log('Public Key:', keyPair.publicKey);

    // Update UI with pubkey
    const pubkeyEl = document.getElementById('my-pubkey');
    if (pubkeyEl) pubkeyEl.textContent = NostrCrypto.shortenPubkey(keyPair.publicKey);

    const nicknameEl = document.getElementById('my-nickname');
    if (nicknameEl) nicknameEl.textContent = NostrCrypto.getNickname();

    updateMyAvatar();
    updateServerHeader();

    // Derive E2E encryption key from room password (if set)
    const roomPassword = NostrCrypto.getRoomPassword();
    if (roomPassword) {
      await NostrCrypto.deriveRoomKey(roomId, roomPassword);
      console.log('E2E encryption enabled (AES-256-GCM)');
      updateEncryptionStatus(true);
    } else {
      console.warn('No room password - messages will NOT be encrypted');
      updateEncryptionStatus(false);
    }

    // Initialize P2P layer
    P2P.init(keyPair);

    // Initialize modules (they register P2P callbacks)
    NostrChat.init(keyPair);
    NostrVoice.init(keyPair);
    NostrScreenShare.init(keyPair);

    // Set local avatar in cache
    const myAvatar = NostrCrypto.getAvatar();
    if (myAvatar) {
      NostrChat.setLocalAvatar(keyPair.publicKey, myAvatar);
    }

    // Connect to P2P room (passwordHash strengthens IndexedDB master key)
    updateConnectionStatus('connecting');
    try {
      await P2P.connect(roomId, passwordHash);
      updateConnectionStatus('connected');

      // Broadcast our nickname/avatar to peers
      NostrChat.publishNickname(NostrCrypto.getNickname());

      // Add ourselves to online list
      NostrChat.setLocalAvatar(keyPair.publicKey, myAvatar);
    } catch (e) {
      console.error('P2P connection failed:', e);
      updateConnectionStatus('disconnected');
    }

    // Update status on peer changes
    P2P.onPeerJoin(() => {
      updateConnectionStatus('connected');
      // Re-broadcast meta when new peer joins
      NostrChat.publishNickname(NostrCrypto.getNickname());
    });

    P2P.onPeerLeave(() => {
      if (P2P.getPeerCount() === 0) {
        updateConnectionStatus('waiting');
      }
    });

    // Setup UI
    setupChannels();
    setupChatInput();
    setupVoiceControls();
    setupSettings();
    setupServerSettings();

    // Switch to default channel
    NostrChat.switchChannel('allgemein');
  }

  function updateConnectionStatus(status) {
    const statusEl = document.getElementById('connection-status');
    if (!statusEl) return;

    const peerCount = P2P.getPeerCount();
    const verifiedCount = P2P.getVerifiedCount();

    statusEl.className = 'status-indicator ' + status;
    const labels = {
      connected: `🟢 P2P (${peerCount} Peer${peerCount !== 1 ? 's' : ''}, ${verifiedCount} verifiziert)`,
      connecting: '🟡 Verbinde...',
      disconnected: '🔴 Getrennt',
      waiting: '🟡 Warte auf Peers...'
    };
    statusEl.textContent = labels[status] || status;
  }

  function updateEncryptionStatus(encrypted) {
    const el = document.getElementById('encryption-status');
    if (!el) return;
    if (encrypted) {
      el.className = 'encryption-indicator encrypted';
      el.textContent = '🔒 E2E';
      el.title = 'Ende-zu-Ende verschluesselt (AES-256-GCM)';
    } else {
      el.className = 'encryption-indicator unencrypted';
      el.textContent = '🔓 Klartext';
      el.title = 'WARNUNG: Kein Room-Passwort gesetzt - Nachrichten sind nicht verschluesselt!';
    }
  }

  function setupChannels() {
    const channelList = document.getElementById('channel-list');
    if (!channelList) return;

    const channels = NostrChat.getDefaultChannels();
    channelList.innerHTML = '';

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

    const voiceUsers = document.createElement('div');
    voiceUsers.id = 'voice-users';
    voiceUsers.className = 'voice-users-list';
    channelList.appendChild(voiceUsers);

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
          const item = document.createElement('div');
          item.className = 'channel-item';
          item.dataset.channel = name;
          item.innerHTML = `<span class="channel-hash">#</span> ${name}`;
          item.addEventListener('click', () => NostrChat.switchChannel(name));
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

      setupAvatarUpload(settingsAvatarUpload, settingsAvatarInput, settingsAvatarPreview);

      settingsBtn.addEventListener('click', () => {
        document.getElementById('settings-nickname').value = NostrCrypto.getNickname() || '';
        document.getElementById('settings-room').value = localStorage.getItem('nostr_room') || roomId;
        document.getElementById('settings-password').value = NostrCrypto.getRoomPassword() || '';
        document.getElementById('settings-pubkey').textContent = keyPair.publicKey;
        document.getElementById('settings-privkey').textContent = '••••••••••••••••';

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
        const newRoom = document.getElementById('settings-room').value.trim();
        const newPassword = document.getElementById('settings-password').value.trim();

        const newAvatar = settingsAvatarPreview.dataset.avatar;
        if (newAvatar && newAvatar !== NostrCrypto.getAvatar()) {
          NostrCrypto.setAvatar(newAvatar);
          NostrChat.setLocalAvatar(keyPair.publicKey, newAvatar);
          updateMyAvatar();
        }

        if (newNick) {
          NostrChat.publishNickname(newNick);
          document.getElementById('my-nickname').textContent = newNick;
        }

        // Update room password
        const oldPassword = NostrCrypto.getRoomPassword();
        if (newPassword !== (oldPassword || '')) {
          if (newPassword) {
            NostrCrypto.setRoomPassword(newPassword);
            await NostrCrypto.deriveRoomKey(roomId, newPassword);
            updateEncryptionStatus(true);
          } else {
            NostrCrypto.setRoomPassword(null);
            updateEncryptionStatus(false);
          }
        }

        if (newRoom && newRoom !== roomId) {
          localStorage.setItem('nostr_room', newRoom);
          alert('Room-ID geaendert. Bitte Seite neu laden.');
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

      document.getElementById('settings-show-recovery')?.addEventListener('click', () => {
        settingsModal.style.display = 'none';
        showRecoveryView();
      });
    }

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

    setupAvatarUpload(serverIconUpload, serverIconInput, serverIconPreview);

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
