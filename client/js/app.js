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

  // ====== FRAGMENT URL PARSING ======

  // Parse #room=ROOMID&key=BASE64PASSWORD from URL fragment
  function parseFragmentParams() {
    const hash = window.location.hash;
    if (!hash || hash.length < 2) return null;
    const params = new URLSearchParams(hash.substring(1));
    const room = params.get('room');
    if (!room) return null;
    const key = params.get('key');
    return { room, key: key ? atob(key) : null };
  }

  // Generate share link for current room
  function generateShareLink() {
    const base = window.location.origin + window.location.pathname;
    const roomPassword = NostrCrypto.getRoomPassword();
    let fragment = '#room=' + encodeURIComponent(roomId);
    if (roomPassword) {
      fragment += '&key=' + btoa(roomPassword);
    }
    return base + fragment;
  }

  // ====== MINIMAL QR CODE GENERATOR ======

  // Simple QR Code generator (Mode Byte, Error correction L)
  // Renders to a canvas element
  function renderQRCode(canvas, text) {
    // Use a data URL approach with a simple SVG-based QR rendering
    // We'll use a compact QR code implementation
    const modules = generateQRModules(text);
    if (!modules) return;

    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    const moduleCount = modules.length;
    const cellSize = size / (moduleCount + 8); // 4 cells quiet zone each side
    const offset = cellSize * 4;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = '#000000';
    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        if (modules[row][col]) {
          ctx.fillRect(
            offset + col * cellSize,
            offset + row * cellSize,
            cellSize + 0.5,
            cellSize + 0.5
          );
        }
      }
    }
  }

  // Minimal QR code matrix generator (version 1-10, error correction L, byte mode)
  function generateQRModules(text) {
    // Encode text to byte array
    const data = new TextEncoder().encode(text);
    const dataLen = data.length;

    // Find smallest version that fits (EC level L)
    const capacityL = [0,17,32,53,78,106,134,154,192,230,271,321,367,425,458,520,586,644,718,792,858];
    let version = 0;
    for (let v = 1; v <= 20; v++) {
      if (capacityL[v] >= dataLen) { version = v; break; }
    }
    if (!version) return null; // Too long

    const size = version * 4 + 17;
    // Create module grid (false = white, true = black)
    const grid = Array.from({ length: size }, () => Array(size).fill(false));
    const reserved = Array.from({ length: size }, () => Array(size).fill(false));

    // Helper: set module with bounds check
    function setModule(r, c, val) {
      if (r >= 0 && r < size && c >= 0 && c < size) {
        grid[r][c] = val;
        reserved[r][c] = true;
      }
    }

    // Finder patterns (7x7) at three corners
    function drawFinder(row, col) {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const val = (r >= 0 && r <= 6 && c >= 0 && c <= 6) &&
            (r === 0 || r === 6 || c === 0 || c === 6 ||
             (r >= 2 && r <= 4 && c >= 2 && c <= 4));
          setModule(row + r, col + c, !!val);
        }
      }
    }

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      setModule(6, i, i % 2 === 0);
      setModule(i, 6, i % 2 === 0);
    }

    // Dark module
    setModule(size - 8, 8, true);

    // Alignment patterns (for version >= 2)
    if (version >= 2) {
      const alignPositions = getAlignmentPositions(version);
      for (const r of alignPositions) {
        for (const c of alignPositions) {
          // Skip if overlaps with finder
          if (reserved[r] && reserved[r][c]) continue;
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
              const val = Math.abs(dr) === 2 || Math.abs(dc) === 2 ||
                         (dr === 0 && dc === 0);
              setModule(r + dr, c + dc, val);
            }
          }
        }
      }
    }

    // Reserve format info areas
    for (let i = 0; i < 8; i++) {
      if (!reserved[8]?.[i]) { reserved[8][i] = true; }
      if (!reserved[i]?.[8]) { reserved[i][8] = true; }
      if (!reserved[8]?.[size - 1 - i]) { reserved[8][size - 1 - i] = true; }
      if (!reserved[size - 1 - i]?.[8]) { reserved[size - 1 - i][8] = true; }
    }
    if (!reserved[8]?.[8]) reserved[8][8] = true;

    // Reserve version info areas (version >= 7)
    if (version >= 7) {
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 3; j++) {
          reserved[i][size - 11 + j] = true;
          reserved[size - 11 + j][i] = true;
        }
      }
    }

    // Encode data with error correction
    const ecBlocks = getECInfo(version);
    const totalCodewords = ecBlocks.totalCodewords;
    const ecCodewordsPerBlock = ecBlocks.ecCodewordsPerBlock;
    const blocks = ecBlocks.blocks;

    // Build data codewords (byte mode)
    const bitStream = [];
    function pushBits(val, len) {
      for (let i = len - 1; i >= 0; i--) {
        bitStream.push((val >> i) & 1);
      }
    }

    // Mode indicator: 0100 (byte)
    pushBits(4, 4);
    // Character count (version 1-9: 8 bits, 10+: 16 bits)
    pushBits(dataLen, version <= 9 ? 8 : 16);
    // Data
    for (const b of data) pushBits(b, 8);
    // Terminator
    const dataBits = totalCodewords * 8 - ecCodewordsPerBlock * blocks.reduce((s, b) => s + b.count, 0) * 8;
    const remaining = dataBits - bitStream.length;
    pushBits(0, Math.min(4, remaining));
    // Pad to byte boundary
    while (bitStream.length % 8 !== 0) bitStream.push(0);
    // Pad codewords
    const padBytes = [0xEC, 0x11];
    let padIdx = 0;
    while (bitStream.length < dataBits) {
      pushBits(padBytes[padIdx % 2], 8);
      padIdx++;
    }

    // Convert bit stream to codewords
    const dataCodewords = [];
    for (let i = 0; i < bitStream.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (bitStream[i + j] || 0);
      dataCodewords.push(byte);
    }

    // Split into blocks and calculate EC
    const allDataBlocks = [];
    const allECBlocks = [];
    let offset2 = 0;
    for (const blockGroup of blocks) {
      for (let i = 0; i < blockGroup.count; i++) {
        const blockData = dataCodewords.slice(offset2, offset2 + blockGroup.dataCodewords);
        offset2 += blockGroup.dataCodewords;
        allDataBlocks.push(blockData);
        allECBlocks.push(reedSolomonEncode(blockData, ecCodewordsPerBlock));
      }
    }

    // Interleave data and EC codewords
    const finalCodewords = [];
    const maxDataLen = Math.max(...allDataBlocks.map(b => b.length));
    for (let i = 0; i < maxDataLen; i++) {
      for (const block of allDataBlocks) {
        if (i < block.length) finalCodewords.push(block[i]);
      }
    }
    for (let i = 0; i < ecCodewordsPerBlock; i++) {
      for (const block of allECBlocks) {
        if (i < block.length) finalCodewords.push(block[i]);
      }
    }

    // Place data bits in matrix
    const allBits = [];
    for (const cw of finalCodewords) {
      for (let i = 7; i >= 0; i--) allBits.push((cw >> i) & 1);
    }

    let bitIndex = 0;
    let upward = true;
    for (let col = size - 1; col >= 0; col -= 2) {
      if (col === 6) col = 5; // Skip timing column
      const rows = upward ? Array.from({ length: size }, (_, i) => size - 1 - i) :
                            Array.from({ length: size }, (_, i) => i);
      for (const row of rows) {
        for (let c = 0; c < 2; c++) {
          const actualCol = col - c;
          if (actualCol < 0) continue;
          if (reserved[row][actualCol]) continue;
          if (bitIndex < allBits.length) {
            grid[row][actualCol] = !!allBits[bitIndex];
            bitIndex++;
          }
        }
      }
      upward = !upward;
    }

    // Apply mask pattern 0 (checkerboard) and format info
    applyMaskAndFormat(grid, reserved, size);

    return grid;
  }

  function getAlignmentPositions(version) {
    if (version === 1) return [];
    const table = [
      [], [6,18], [6,22], [6,26], [6,30], [6,34],
      [6,22,38], [6,24,42], [6,26,46], [6,28,50], [6,30,54],
      [6,32,58], [6,34,62], [6,26,46,66], [6,26,48,70], [6,26,50,74],
      [6,30,54,78], [6,30,56,82], [6,30,58,86], [6,34,62,90]
    ];
    return table[version - 1] || [];
  }

  function getECInfo(version) {
    // EC Level L data: [totalCodewords, ecCodewordsPerBlock, [[count, dataCodewords], ...]]
    const ecTable = {
      1:  [26,  7,  [{count:1, dataCodewords:19}]],
      2:  [44,  10, [{count:1, dataCodewords:34}]],
      3:  [70,  15, [{count:1, dataCodewords:55}]],
      4:  [100, 20, [{count:1, dataCodewords:80}]],
      5:  [134, 26, [{count:1, dataCodewords:108}]],
      6:  [172, 18, [{count:2, dataCodewords:68}]],
      7:  [196, 20, [{count:2, dataCodewords:78}]],
      8:  [242, 24, [{count:2, dataCodewords:97}]],
      9:  [292, 30, [{count:2, dataCodewords:116}]],
      10: [346, 18, [{count:2, dataCodewords:68}, {count:2, dataCodewords:69}]],
      11: [404, 20, [{count:4, dataCodewords:81}]],
      12: [466, 24, [{count:2, dataCodewords:92}, {count:2, dataCodewords:93}]],
      13: [532, 26, [{count:4, dataCodewords:107}]],
      14: [581, 30, [{count:3, dataCodewords:115}, {count:1, dataCodewords:116}]],
      15: [655, 22, [{count:5, dataCodewords:87}, {count:1, dataCodewords:88}]],
      16: [733, 24, [{count:5, dataCodewords:98}, {count:1, dataCodewords:99}]],
      17: [815, 28, [{count:1, dataCodewords:107}, {count:5, dataCodewords:108}]],
      18: [901, 30, [{count:5, dataCodewords:120}, {count:1, dataCodewords:121}]],
      19: [991, 28, [{count:3, dataCodewords:113}, {count:4, dataCodewords:114}]],
      20: [1085,28, [{count:3, dataCodewords:107}, {count:5, dataCodewords:108}]],
    };
    const e = ecTable[version];
    return { totalCodewords: e[0], ecCodewordsPerBlock: e[1], blocks: e[2] };
  }

  // GF(256) Reed-Solomon with primitive polynomial 0x11d
  function reedSolomonEncode(data, ecLen) {
    // Build log/exp tables
    const gfExp = new Uint8Array(512);
    const gfLog = new Uint8Array(256);
    let x = 1;
    for (let i = 0; i < 255; i++) {
      gfExp[i] = x;
      gfLog[x] = i;
      x = (x << 1) ^ (x >= 128 ? 0x11d : 0);
    }
    for (let i = 255; i < 512; i++) gfExp[i] = gfExp[i - 255];

    function gfMul(a, b) {
      if (a === 0 || b === 0) return 0;
      return gfExp[gfLog[a] + gfLog[b]];
    }

    // Generator polynomial
    let gen = [1];
    for (let i = 0; i < ecLen; i++) {
      const newGen = new Array(gen.length + 1).fill(0);
      for (let j = 0; j < gen.length; j++) {
        newGen[j] ^= gen[j];
        newGen[j + 1] ^= gfMul(gen[j], gfExp[i]);
      }
      gen = newGen;
    }

    // Polynomial division
    const msg = new Uint8Array(data.length + ecLen);
    msg.set(data);
    for (let i = 0; i < data.length; i++) {
      const coef = msg[i];
      if (coef !== 0) {
        for (let j = 0; j < gen.length; j++) {
          msg[i + j] ^= gfMul(gen[j], coef);
        }
      }
    }
    return Array.from(msg.slice(data.length));
  }

  function applyMaskAndFormat(grid, reserved, size) {
    // Apply mask 0: (row + col) % 2 === 0
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!reserved[r][c] && (r + c) % 2 === 0) {
          grid[r][c] = !grid[r][c];
        }
      }
    }

    // Format info for mask 0, EC level L = 0b01_000_000000000 = 0
    // After BCH encoding: 0x77C4 → bits: 111011111000100
    const formatBits = 0x77C4;
    const formatPositions1 = [
      [0,8],[1,8],[2,8],[3,8],[4,8],[5,8],[7,8],[8,8],
      [8,7],[8,5],[8,4],[8,3],[8,2],[8,1],[8,0]
    ];
    const formatPositions2 = [
      [8,size-1],[8,size-2],[8,size-3],[8,size-4],[8,size-5],[8,size-6],[8,size-7],[8,size-8],
      [size-7,8],[size-6,8],[size-5,8],[size-4,8],[size-3,8],[size-2,8],[size-1,8]
    ];

    for (let i = 0; i < 15; i++) {
      const bit = !!((formatBits >> (14 - i)) & 1);
      const [r1, c1] = formatPositions1[i];
      grid[r1][c1] = bit;
      const [r2, c2] = formatPositions2[i];
      grid[r2][c2] = bit;
    }
  }

  // ====== SHARE MODAL ======

  function showShareModal() {
    const modal = document.getElementById('share-modal');
    if (!modal) return;

    const link = generateShareLink();
    const linkInput = document.getElementById('share-link');
    const copyBtn = document.getElementById('share-copy');
    const qrToggle = document.getElementById('share-qr-toggle');
    const qrContainer = document.getElementById('share-qr-container');
    const qrCanvas = document.getElementById('share-qr-canvas');
    const closeBtn = document.getElementById('share-close');

    linkInput.value = link;

    // Select all on click
    linkInput.addEventListener('click', () => linkInput.select());

    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(link);
      copyBtn.textContent = '\u2705 Kopiert!';
      setTimeout(() => { copyBtn.textContent = '\u{1F4CB} Link kopieren'; }, 2000);
    });

    let qrRendered = false;
    qrToggle.addEventListener('click', () => {
      if (qrContainer.style.display === 'none') {
        qrContainer.style.display = 'flex';
        qrToggle.textContent = 'QR-Code ausblenden';
        if (!qrRendered) {
          renderQRCode(qrCanvas, link);
          qrRendered = true;
        }
      } else {
        qrContainer.style.display = 'none';
        qrToggle.textContent = 'QR-Code anzeigen';
      }
    });

    closeBtn.addEventListener('click', () => {
      modal.style.display = 'none';
    });

    modal.style.display = 'flex';
  }

  // ====== INIT: Determine which flow to use ======

  async function init() {
    // Check for fragment URL (#room=...&key=...)
    const fragmentParams = parseFragmentParams();
    if (fragmentParams) {
      roomId = fragmentParams.room;
      localStorage.setItem('nostr_room', roomId);
      if (fragmentParams.key) {
        NostrCrypto.setRoomPassword(fragmentParams.key);
      }
      // Remove fragment from URL (don't leak to server/history)
      history.replaceState(null, '', window.location.pathname);
    }

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
    setupShareButton();

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

  function setupShareButton() {
    // Add share button to chat header
    const chatHeader = document.querySelector('.chat-header');
    if (chatHeader && !document.getElementById('btn-share')) {
      const shareBtn = document.createElement('button');
      shareBtn.id = 'btn-share';
      shareBtn.className = 'btn-icon';
      shareBtn.title = 'Einladungslink teilen';
      shareBtn.textContent = '\u{1F517}';
      shareBtn.addEventListener('click', showShareModal);
      chatHeader.appendChild(shareBtn);
    }
  }

  return { init };
})();

// Start app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
