// chat.js - Text Chat Logic

const NostrChat = (() => {
  let currentChannel = 'allgemein';
  let currentSubId = null;
  let keyPair = null;
  let messageSet = new Set(); // Track event IDs to avoid duplicates
  let nicknameCache = {}; // pubkey -> nickname

  const DEFAULT_CHANNELS = ['allgemein', 'gaming', 'random', 'musik', 'dev'];

  function init(keys) {
    keyPair = keys;
    // Subscribe to nickname events (kind 0 = metadata)
    NostrRelay.subscribe(
      { kinds: [0] },
      (event) => {
        try {
          const meta = JSON.parse(event.content);
          if (meta.name) {
            nicknameCache[event.pubkey] = meta.name;
            updateDisplayedNames(event.pubkey, meta.name);
          }
        } catch (e) {}
      }
    );
  }

  function updateDisplayedNames(pubkey, name) {
    document.querySelectorAll(`.msg-author[data-pubkey="${pubkey}"]`).forEach(el => {
      el.textContent = name;
    });
    // Update user list too
    document.querySelectorAll(`.user-item[data-pubkey="${pubkey}"] .user-name`).forEach(el => {
      el.textContent = name;
    });
  }

  function getDisplayName(pubkey) {
    if (nicknameCache[pubkey]) return nicknameCache[pubkey];
    return NostrCrypto.shortenPubkey(pubkey);
  }

  async function publishNickname(nickname) {
    NostrCrypto.setNickname(nickname);
    nicknameCache[keyPair.publicKey] = nickname;

    const event = await NostrCrypto.signEvent({
      kind: 0,
      content: JSON.stringify({ name: nickname }),
      tags: [],
      created_at: Math.floor(Date.now() / 1000)
    }, keyPair.privateKey);

    NostrRelay.publish(event);
  }

  function switchChannel(channel) {
    // Unsubscribe from old channel
    if (currentSubId) {
      NostrRelay.unsubscribe(currentSubId);
    }

    currentChannel = channel;
    messageSet.clear();

    // Clear chat
    const messagesEl = document.getElementById('messages');
    if (messagesEl) messagesEl.innerHTML = '';

    // Update UI
    document.querySelectorAll('.channel-item').forEach(el => {
      el.classList.toggle('active', el.dataset.channel === channel);
    });

    const channelNameEl = document.getElementById('current-channel-name');
    if (channelNameEl) channelNameEl.textContent = '# ' + channel;

    // Subscribe to channel messages
    currentSubId = NostrRelay.subscribe(
      { kinds: [1], '#channel': [channel] },
      (event) => {
        if (!messageSet.has(event.id)) {
          messageSet.add(event.id);
          renderMessage(event);
        }
      },
      (subId) => {
        // EOSE - scroll to bottom
        const messagesEl = document.getElementById('messages');
        if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    );
  }

  async function sendMessage(text) {
    if (!text.trim()) return;

    const event = await NostrCrypto.signEvent({
      kind: 1,
      content: text.trim(),
      tags: [['channel', currentChannel]],
      created_at: Math.floor(Date.now() / 1000)
    }, keyPair.privateKey);

    NostrRelay.publish(event);
  }

  function renderMessage(event) {
    const messagesEl = document.getElementById('messages');
    if (!messagesEl) return;

    const isOwn = event.pubkey === keyPair.publicKey;
    const time = new Date(event.created_at * 1000);
    const timeStr = time.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const dateStr = time.toLocaleDateString('de-DE');
    const displayName = getDisplayName(event.pubkey);

    const msgEl = document.createElement('div');
    msgEl.className = 'message' + (isOwn ? ' own' : '');
    msgEl.dataset.eventId = event.id;
    msgEl.innerHTML = `
      <div class="message-avatar">${displayName.charAt(0).toUpperCase()}</div>
      <div class="message-body">
        <div class="message-header">
          <span class="msg-author" data-pubkey="${event.pubkey}">${escapeHtml(displayName)}</span>
          <span class="msg-time" title="${dateStr}">${timeStr}</span>
        </div>
        <div class="message-content">${formatContent(event.content)}</div>
      </div>
    `;

    // Set timestamp BEFORE insertion so it's available for future comparisons
    msgEl.dataset.createdAt = String(event.created_at);

    // Insert in chronological order
    const existingMessages = messagesEl.querySelectorAll('.message');
    let inserted = false;
    for (const existing of existingMessages) {
      const existingTime = parseInt(existing.dataset.createdAt || '0', 10);
      if (event.created_at < existingTime) {
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
    // Escape HTML first
    let formatted = escapeHtml(text);
    // Simple markdown-like formatting
    formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    formatted = formatted.replace(/\*(.*?)\*/g, '<em>$1</em>');
    formatted = formatted.replace(/`(.*?)`/g, '<code>$1</code>');
    // URLs
    formatted = formatted.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    // Newlines
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
    getCurrentChannel,
    getDefaultChannels,
    getNicknameCache,
    renderMessage
  };
})();
