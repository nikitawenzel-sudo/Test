// chat.js - Text Chat Logic (P2P / Yjs CRDT)

const NostrChat = (() => {
  let currentChannel = 'allgemein';
  let keyPair = null;
  let renderedMessages = new Set(); // Track rendered message IDs to avoid duplicates
  let nicknameCache = {}; // pubkey -> nickname
  let avatarCache = {}; // pubkey -> avatar data URL
  let observer = null; // Current Yjs observer

  const DEFAULT_CHANNELS = ['allgemein', 'gaming', 'random', 'musik', 'dev'];

  function init(keys) {
    keyPair = keys;

    // Listen for metadata updates from P2P peers
    P2P.onMetaUpdate((pubkey, meta) => {
      if (meta.nickname) {
        nicknameCache[pubkey] = meta.nickname;
      }
      if (meta.avatar) {
        avatarCache[pubkey] = meta.avatar;
      }
      updateDisplayedUser(pubkey);
      updateOnlineUser(pubkey);
    });

    // When a peer joins, add them to online list
    P2P.onPeerJoin(peerId => {
      // Metadata will come through onMetaUpdate
    });

    // When a peer leaves, remove from online list
    P2P.onPeerLeave((peerId, peerInfo) => {
      if (peerInfo && peerInfo.pubkey) {
        removeOnlineUser(peerInfo.pubkey);
      }
    });
  }

  function updateDisplayedUser(pubkey) {
    const name = getDisplayName(pubkey);
    const avatar = avatarCache[pubkey];

    // Update author names in chat
    document.querySelectorAll(`.msg-author[data-pubkey="${pubkey}"]`).forEach(el => {
      el.textContent = name;
    });

    // Update avatars in chat messages
    document.querySelectorAll(`.message[data-pubkey="${pubkey}"] .message-avatar`).forEach(el => {
      el.innerHTML = avatar
        ? `<img class="avatar-img" src="${avatar}">`
        : name.charAt(0).toUpperCase();
    });

    // Update user list (right sidebar)
    document.querySelectorAll(`.user-item[data-pubkey="${pubkey}"] .user-name`).forEach(el => {
      el.textContent = name;
    });
    document.querySelectorAll(`.user-item[data-pubkey="${pubkey}"] .user-avatar-small`).forEach(el => {
      el.innerHTML = avatar
        ? `<img class="avatar-img" src="${avatar}">`
        : name.charAt(0).toUpperCase();
    });

    // Update voice user names
    document.querySelectorAll(`.voice-user[data-pubkey="${pubkey}"] .user-name`).forEach(el => {
      el.textContent = name;
    });
  }

  function updateOnlineUser(pubkey) {
    const onlineList = document.getElementById('online-users');
    if (!onlineList) return;

    const name = getDisplayName(pubkey);
    const avatar = avatarCache[pubkey];

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

    userItem.innerHTML = `
      <div class="user-avatar-small">${avatarContent}</div>
      <span class="user-name">${name}</span>
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

    // Broadcast metadata to all P2P peers
    P2P.broadcastMeta();
  }

  function switchChannel(channel) {
    // Remove old Yjs observer
    if (observer) {
      const oldMessages = P2P.getMessages(currentChannel);
      if (oldMessages) {
        oldMessages.unobserve(observer);
      }
    }

    currentChannel = channel;
    renderedMessages.clear();

    // Clear chat
    const messagesEl = document.getElementById('messages');
    if (messagesEl) messagesEl.innerHTML = '';

    // Update UI
    document.querySelectorAll('.channel-item').forEach(el => {
      el.classList.toggle('active', el.dataset.channel === channel);
    });

    const channelNameEl = document.getElementById('current-channel-name');
    if (channelNameEl) channelNameEl.textContent = '# ' + channel;

    // Get Yjs array for this channel
    const yMessages = P2P.getMessages(channel);
    if (!yMessages) return;

    // Render existing messages from Yjs
    const existing = yMessages.toArray();
    for (const msg of existing) {
      if (!renderedMessages.has(msg.id)) {
        renderedMessages.add(msg.id);
        renderMessage(msg);
      }
    }

    // Scroll to bottom after initial render
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;

    // Observe new messages
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

  function sendMessage(text) {
    if (!text.trim()) return;

    const msg = {
      id: keyPair.publicKey.slice(0, 8) + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      pubkey: keyPair.publicKey,
      content: text.trim(),
      channel: currentChannel,
      created_at: Math.floor(Date.now() / 1000)
    };

    // Push to Yjs array - automatically synced to all peers
    const yMessages = P2P.getMessages(currentChannel);
    if (yMessages) {
      yMessages.push([msg]);
    }
  }

  function renderMessage(msg) {
    const messagesEl = document.getElementById('messages');
    if (!messagesEl) return;

    const isOwn = msg.pubkey === keyPair.publicKey;
    const time = new Date(msg.created_at * 1000);
    const timeStr = time.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const dateStr = time.toLocaleDateString('de-DE');
    const displayName = getDisplayName(msg.pubkey);

    const avatarUrl = avatarCache[msg.pubkey];
    const avatarContent = avatarUrl
      ? `<img class="avatar-img" src="${avatarUrl}">`
      : displayName.charAt(0).toUpperCase();

    const msgEl = document.createElement('div');
    msgEl.className = 'message' + (isOwn ? ' own' : '');
    msgEl.dataset.msgId = msg.id;
    msgEl.dataset.pubkey = msg.pubkey;
    msgEl.innerHTML = `
      <div class="message-avatar">${avatarContent}</div>
      <div class="message-body">
        <div class="message-header">
          <span class="msg-author" data-pubkey="${msg.pubkey}">${escapeHtml(displayName)}</span>
          <span class="msg-time" title="${dateStr}">${timeStr}</span>
        </div>
        <div class="message-content">${formatContent(msg.content)}</div>
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

    // Auto-scroll if near bottom
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
