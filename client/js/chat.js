// chat.js - Text Chat Logic (P2P / Yjs CRDT + E2E Encryption + Schnorr Signatures)

const NostrChat = (() => {
  let currentChannel = 'allgemein';
  let keyPair = null;
  let renderedMessages = new Set();
  let nicknameCache = {};
  let avatarCache = {};
  let observer = null;

  const DEFAULT_CHANNELS = ['allgemein', 'gaming', 'random', 'musik', 'dev'];

  function init(keys) {
    keyPair = keys;

    P2P.onMetaUpdate((pubkey, meta) => {
      if (meta.nickname) {
        nicknameCache[pubkey] = meta.nickname;
      }
      if (meta.avatar) {
        avatarCache[pubkey] = meta.avatar;
      }
      updateDisplayedUser(pubkey);
      updateOnlineUser(pubkey, meta.verified);
    });

    P2P.onPeerJoin(peerId => {});

    P2P.onPeerLeave((peerId, peerInfo) => {
      if (peerInfo && peerInfo.pubkey) {
        removeOnlineUser(peerInfo.pubkey);
      }
    });
  }

  function updateDisplayedUser(pubkey) {
    const name = getDisplayName(pubkey);
    const avatar = avatarCache[pubkey];

    document.querySelectorAll(`.msg-author[data-pubkey="${pubkey}"]`).forEach(el => {
      el.textContent = name;
    });

    document.querySelectorAll(`.message[data-pubkey="${pubkey}"] .message-avatar`).forEach(el => {
      el.innerHTML = avatar
        ? `<img class="avatar-img" src="${avatar}">`
        : name.charAt(0).toUpperCase();
    });

    document.querySelectorAll(`.user-item[data-pubkey="${pubkey}"] .user-name`).forEach(el => {
      el.textContent = name;
    });
    document.querySelectorAll(`.user-item[data-pubkey="${pubkey}"] .user-avatar-small`).forEach(el => {
      el.innerHTML = avatar
        ? `<img class="avatar-img" src="${avatar}">`
        : name.charAt(0).toUpperCase();
    });

    document.querySelectorAll(`.voice-user[data-pubkey="${pubkey}"] .user-name`).forEach(el => {
      el.textContent = name;
    });
  }

  function updateOnlineUser(pubkey, verified) {
    const onlineList = document.getElementById('online-users');
    if (!onlineList) return;

    const name = getDisplayName(pubkey);
    const avatar = avatarCache[pubkey];
    const isVerified = verified || P2P.isPubkeyVerified(pubkey);

    let userItem = onlineList.querySelector(`.user-item[data-pubkey="${pubkey}"]`);
    if (!userItem) {
      userItem = document.createElement('div');
      userItem.className = 'user-item';
      userItem.dataset.pubkey = pubkey;
      onlineList.appendChild(userItem);
    }

    const avatarContent = avatar
      ? `<img class="avatar-img" src="${avatar}">`
      : name.charAt(0).toUpperCase();

    const verifiedBadge = isVerified
      ? '<span class="verified-badge" title="Identitaet verifiziert">&#10003;</span>'
      : '<span class="unverified-badge" title="Nicht verifiziert">?</span>';

    userItem.innerHTML = `
      <div class="user-avatar-small">${avatarContent}</div>
      <span class="user-name">${name}</span>
      ${verifiedBadge}
    `;
  }

  function removeOnlineUser(pubkey) {
    const onlineList = document.getElementById('online-users');
    if (!onlineList) return;
    const item = onlineList.querySelector(`.user-item[data-pubkey="${pubkey}"]`);
    if (item) item.remove();
  }

  function getDisplayName(pubkey) {
    if (nicknameCache[pubkey]) return nicknameCache[pubkey];
    return NostrCrypto.shortenPubkey(pubkey);
  }

  function getAvatarUrl(pubkey) {
    return avatarCache[pubkey] || null;
  }

  function setLocalAvatar(pubkey, dataUrl) {
    if (dataUrl) {
      avatarCache[pubkey] = dataUrl;
    }
  }

  function publishNickname(nickname) {
    NostrCrypto.setNickname(nickname);
    nicknameCache[keyPair.publicKey] = nickname;

    const avatar = NostrCrypto.getAvatar();
    if (avatar) {
      avatarCache[keyPair.publicKey] = avatar;
    }

    P2P.broadcastMeta();
  }

  function switchChannel(channel) {
    if (observer) {
      const oldMessages = P2P.getMessages(currentChannel);
      if (oldMessages) {
        oldMessages.unobserve(observer);
      }
    }

    currentChannel = channel;
    renderedMessages.clear();

    const messagesEl = document.getElementById('messages');
    if (messagesEl) messagesEl.innerHTML = '';

    document.querySelectorAll('.channel-item').forEach(el => {
      el.classList.toggle('active', el.dataset.channel === channel);
    });

    const channelNameEl = document.getElementById('current-channel-name');
    if (channelNameEl) channelNameEl.textContent = '# ' + channel;

    const yMessages = P2P.getMessages(channel);
    if (!yMessages) return;

    // Render existing messages (async - decrypt + verify)
    const existing = yMessages.toArray();
    for (const msg of existing) {
      if (!renderedMessages.has(msg.id)) {
        renderedMessages.add(msg.id);
        renderMessage(msg);
      }
    }

    if (messagesEl) {
      setTimeout(() => { messagesEl.scrollTop = messagesEl.scrollHeight; }, 50);
    }

    observer = (event) => {
      event.changes.added.forEach(item => {
        item.content.getContent().forEach(msg => {
          if (msg && msg.id && !renderedMessages.has(msg.id)) {
            renderedMessages.add(msg.id);
            renderMessage(msg);
          }
        });
      });
    };
    yMessages.observe(observer);
  }

  async function sendMessage(text) {
    if (!text.trim()) return;

    const content = text.trim();
    const created_at = Math.floor(Date.now() / 1000);

    // Sign the plaintext message with Schnorr
    const sig = await NostrCrypto.signMessagePayload(
      keyPair.publicKey, created_at, currentChannel, content, keyPair.privateKey
    );

    // Encrypt the content with room key (if available)
    const encrypted = await NostrCrypto.encryptText(content);

    const msg = {
      id: keyPair.publicKey.slice(0, 8) + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      pubkey: keyPair.publicKey,
      channel: currentChannel,
      created_at: created_at,
      sig: sig // Schnorr signature over plaintext
    };

    if (encrypted) {
      // E2E encrypted: only ciphertext stored in CRDT
      msg.encrypted = encrypted;
    } else {
      // No room password: plaintext (with signature for authenticity)
      msg.content = content;
    }

    const yMessages = P2P.getMessages(currentChannel);
    if (yMessages) {
      yMessages.push([msg]);
    }
  }

  // Async render: decrypt + verify + display
  async function renderMessage(msg) {
    const messagesEl = document.getElementById('messages');
    if (!messagesEl) return;

    let content = null;
    let isEncrypted = false;
    let decryptFailed = false;
    let sigValid = false;
    let hasSig = !!msg.sig;

    // Step 1: Decrypt if encrypted
    if (msg.encrypted) {
      isEncrypted = true;
      content = await NostrCrypto.decryptText(msg.encrypted);
      if (content === null) {
        decryptFailed = true;
        content = null;
      }
    } else if (msg.content) {
      // Legacy plaintext message
      content = msg.content;
    }

    // Step 2: Verify Schnorr signature
    if (hasSig && content && !decryptFailed) {
      sigValid = await NostrCrypto.verifyMessageSignature(
        msg.pubkey, msg.created_at, msg.channel, content, msg.sig
      );
    }

    const isOwn = msg.pubkey === keyPair.publicKey;
    const time = new Date(msg.created_at * 1000);
    const timeStr = time.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const dateStr = time.toLocaleDateString('de-DE');
    const displayName = getDisplayName(msg.pubkey);

    const avatarUrl = avatarCache[msg.pubkey];
    const avatarContent = avatarUrl
      ? `<img class="avatar-img" src="${avatarUrl}">`
      : displayName.charAt(0).toUpperCase();

    // Security badges
    let badges = '';
    if (isEncrypted && !decryptFailed) {
      badges += '<span class="badge badge-encrypted" title="E2E verschluesselt">&#128274;</span>';
    } else if (isEncrypted && decryptFailed) {
      badges += '<span class="badge badge-decrypt-failed" title="Entschluesselung fehlgeschlagen - falsches Passwort?">&#128275;</span>';
    }
    if (hasSig && sigValid) {
      badges += '<span class="badge badge-verified" title="Signatur verifiziert">&#10003;</span>';
    } else if (hasSig && !sigValid && !decryptFailed) {
      badges += '<span class="badge badge-forged" title="WARNUNG: Signatur ungueltig!">&#9888;</span>';
    } else if (!hasSig) {
      badges += '<span class="badge badge-unsigned" title="Nicht signiert (Legacy)">&#63;</span>';
    }

    // Display content
    let displayContent;
    if (decryptFailed) {
      displayContent = '<span class="encrypted-placeholder">&#128274; Verschluesselte Nachricht (falsches Passwort?)</span>';
    } else if (content) {
      displayContent = formatContent(content);
    } else {
      displayContent = '<span class="encrypted-placeholder">&#128274; Unlesbar</span>';
    }

    const msgEl = document.createElement('div');
    msgEl.className = 'message' + (isOwn ? ' own' : '');
    if (hasSig && !sigValid && !decryptFailed) {
      msgEl.className += ' forged-warning';
    }
    msgEl.dataset.msgId = msg.id;
    msgEl.dataset.pubkey = msg.pubkey;
    msgEl.innerHTML = `
      <div class="message-avatar">${avatarContent}</div>
      <div class="message-body">
        <div class="message-header">
          <span class="msg-author" data-pubkey="${msg.pubkey}">${escapeHtml(displayName)}</span>
          <span class="msg-badges">${badges}</span>
          <span class="msg-time" title="${dateStr}">${timeStr}</span>
        </div>
        <div class="message-content">${displayContent}</div>
      </div>
    `;

    msgEl.dataset.createdAt = String(msg.created_at);

    // Insert in chronological order
    const existingMessages = messagesEl.querySelectorAll('.message');
    let inserted = false;
    for (const existing of existingMessages) {
      const existingTime = parseInt(existing.dataset.createdAt || '0', 10);
      if (msg.created_at < existingTime) {
        messagesEl.insertBefore(msgEl, existing);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      messagesEl.appendChild(msgEl);
    }

    const isNearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;
    if (isNearBottom || isOwn) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function formatContent(text) {
    let formatted = escapeHtml(text);
    formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    formatted = formatted.replace(/\*(.*?)\*/g, '<em>$1</em>');
    formatted = formatted.replace(/`(.*?)`/g, '<code>$1</code>');
    formatted = formatted.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    formatted = formatted.replace(/\n/g, '<br>');
    return formatted;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function getCurrentChannel() {
    return currentChannel;
  }

  function getDefaultChannels() {
    return DEFAULT_CHANNELS;
  }

  function getNicknameCache() {
    return nicknameCache;
  }

  return {
    init,
    switchChannel,
    sendMessage,
    publishNickname,
    getDisplayName,
    getAvatarUrl,
    setLocalAvatar,
    getCurrentChannel,
    getDefaultChannels,
    getNicknameCache,
    renderMessage
  };
})();
