import { loadOrCreateKeyPair, saveKeyPair, shortenPubkey, createUnsignedEvent, signEvent } from './crypto.js';
import { RelayConnection } from './relay.js';
import { Chat } from './chat.js';
import { VoiceChat } from './voice.js';
import { ScreenShare } from './screenshare.js';

// State
let keyPair = null;
let nickname = '';
let relay = null;
let chat = null;
let voiceChat = null;
let screenShare = null;
const nicknames = new Map(); // pubkey → nickname
const onlineUsers = new Map(); // pubkey → { nickname, inVoice }

const DEFAULT_TEXT_CHANNELS = ['allgemein', 'gaming', 'random'];
const DEFAULT_VOICE_CHANNELS = ['Lounge', 'Gaming', 'Musik'];
let currentTextChannel = 'allgemein';
let textChannels = [...DEFAULT_TEXT_CHANNELS];
let voiceChannels = [...DEFAULT_VOICE_CHANNELS];

// DOM elements
const setupScreen = document.getElementById('setup-screen');
const appDiv = document.getElementById('app');
const nicknameInput = document.getElementById('nickname-input');
const relayInput = document.getElementById('relay-input');
const pubkeyDisplay = document.getElementById('pubkey-display');
const connectBtn = document.getElementById('connect-btn');
const messagesEl = document.getElementById('messages');
const chatInput = document.getElementById('chat-input');
const currentChannelName = document.getElementById('current-channel-name');
const connectionStatus = document.getElementById('connection-status');
const textChannelsEl = document.getElementById('text-channels');
const voiceChannelsEl = document.getElementById('voice-channels');
const newChannelInput = document.getElementById('new-channel-input');
const voiceControls = document.getElementById('voice-controls');
const voiceChannelNameEl = document.getElementById('voice-channel-name');
const btnMute = document.getElementById('btn-mute');
const btnDeafen = document.getElementById('btn-deafen');
const btnScreen = document.getElementById('btn-screen');
const btnDisconnect = document.getElementById('btn-disconnect');
const userAvatar = document.getElementById('user-avatar');
const userName = document.getElementById('user-name');
const userPubkeyShort = document.getElementById('user-pubkey-short');
const membersListEl = document.getElementById('members-list');
const screenShareContainer = document.getElementById('screen-share-container');
const screenShareVideo = document.getElementById('screen-share-video');
const screenShareLabel = document.getElementById('screen-share-label');

// Init: show pubkey on setup screen
function initSetup() {
  keyPair = loadOrCreateKeyPair();
  pubkeyDisplay.textContent = 'Public Key: ' + keyPair.publicKey;

  const savedNick = localStorage.getItem('nostr-discord-nickname');
  if (savedNick) nicknameInput.value = savedNick;

  const savedRelay = localStorage.getItem('nostr-discord-relay');
  if (savedRelay) relayInput.value = savedRelay;
}

// Connect and start app
connectBtn.addEventListener('click', () => {
  nickname = nicknameInput.value.trim() || 'Anon';
  const relayUrl = relayInput.value.trim();

  if (!relayUrl) {
    alert('Bitte eine Relay-URL eingeben');
    return;
  }

  localStorage.setItem('nostr-discord-nickname', nickname);
  localStorage.setItem('nostr-discord-relay', relayUrl);

  nicknames.set(keyPair.publicKey, nickname);

  startApp(relayUrl);
});

// Allow Enter to connect
nicknameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connectBtn.click();
});

function startApp(relayUrl) {
  setupScreen.style.display = 'none';
  appDiv.style.display = 'block';

  // Set user info
  userAvatar.textContent = nickname.charAt(0).toUpperCase();
  userName.textContent = nickname;
  userPubkeyShort.textContent = shortenPubkey(keyPair.publicKey);

  // Create relay connection
  relay = new RelayConnection();

  relay.onConnect(() => {
    connectionStatus.textContent = 'Verbunden';
    connectionStatus.className = 'connection-status connected';
    setTimeout(() => { connectionStatus.style.display = 'none'; }, 2000);

    // Announce presence
    announcePresence();

    // Subscribe to presence events
    subscribePresence();
  });

  relay.onDisconnect(() => {
    connectionStatus.textContent = 'Verbindung verloren - Reconnecting...';
    connectionStatus.className = 'connection-status disconnected';
    connectionStatus.style.display = 'block';
  });

  // Create chat
  chat = new Chat(relay, keyPair, nicknames);
  chat.setMessageContainer(messagesEl);

  // Create voice chat
  voiceChat = new VoiceChat(relay, keyPair);
  voiceChat.onVoiceUsersChanged = (users) => {
    renderMembers();
    renderVoiceChannels();
  };

  // Create screen share
  screenShare = new ScreenShare(relay, keyPair, voiceChat);
  screenShare.onScreenStreamReceived = (pubkey, stream) => {
    const name = nicknames.get(pubkey) || shortenPubkey(pubkey);
    screenShareLabel.textContent = name + ' teilt den Bildschirm';
    screenShareVideo.srcObject = stream;
    screenShareContainer.classList.add('active');
  };
  screenShare.onScreenShareStopped = (pubkey) => {
    screenShareVideo.srcObject = null;
    screenShareContainer.classList.remove('active');
  };

  // Extended signaling handler for screen share
  const originalHandler = relay.signalingCallback;
  relay.onSignaling((event) => {
    // Voice handles its own signaling
    voiceChat._handleSignaling(event);
    // Screen share handles its own signaling
    screenShare.handleSignaling(event);
  });

  // Render UI
  renderTextChannels();
  renderVoiceChannels();

  // Connect to relay
  relay.connect(relayUrl);

  // Switch to default channel
  switchTextChannel('allgemein');
}

// Presence: kind 0 (profile metadata in NOSTR)
async function announcePresence() {
  const event = createUnsignedEvent(
    0,
    JSON.stringify({ name: nickname }),
    [],
    keyPair.publicKey
  );
  const signed = await signEvent(event, keyPair.privateKey);
  relay.publish(signed);
}

function subscribePresence() {
  relay.subscribe(
    { kinds: [0] },
    (event) => {
      try {
        const meta = JSON.parse(event.content);
        if (meta.name) {
          nicknames.set(event.pubkey, meta.name);
          onlineUsers.set(event.pubkey, {
            nickname: meta.name,
            inVoice: voiceChat ? voiceChat.voiceUsers.has(event.pubkey) : false
          });
          renderMembers();
        }
      } catch {}
    }
  );
}

// Text channels
function renderTextChannels() {
  textChannelsEl.innerHTML = '';
  for (const ch of textChannels) {
    const item = document.createElement('div');
    item.className = 'channel-item' + (ch === currentTextChannel ? ' active' : '');
    item.innerHTML = `<span class="channel-icon">#</span> ${escapeHtml(ch)}`;
    item.addEventListener('click', () => switchTextChannel(ch));
    textChannelsEl.appendChild(item);
  }
}

function switchTextChannel(channel) {
  currentTextChannel = channel;
  currentChannelName.textContent = channel;
  chatInput.placeholder = `Nachricht an #${channel}`;
  renderTextChannels();
  chat.switchChannel(channel);
}

// Voice channels
function renderVoiceChannels() {
  voiceChannelsEl.innerHTML = '';
  for (const ch of voiceChannels) {
    const item = document.createElement('div');
    const isActive = voiceChat && voiceChat.currentChannel === ch;

    // Count voice users in this channel
    const voiceUserCount = voiceChat && voiceChat.currentChannel === ch
      ? voiceChat.voiceUsers.size : 0;

    item.className = 'channel-item' + (isActive ? ' active' : '');
    item.innerHTML = `
      <span class="channel-icon">&#x1F50A;</span> ${escapeHtml(ch)}
      ${voiceUserCount > 0 ? `<span class="voice-count">${voiceUserCount}</span>` : ''}
    `;
    item.addEventListener('click', () => joinVoiceChannel(ch));
    voiceChannelsEl.appendChild(item);
  }
}

async function joinVoiceChannel(channel) {
  if (voiceChat.currentChannel === channel) return;

  try {
    await voiceChat.joinChannel(channel);
    voiceControls.classList.add('active');
    voiceChannelNameEl.textContent = channel;
    renderVoiceChannels();
    renderMembers();
  } catch (err) {
    console.error('Voice join failed:', err);
    alert('Mikrofon-Zugriff fehlgeschlagen: ' + err.message);
  }
}

// New channel
newChannelInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const name = newChannelInput.value.trim().toLowerCase().replace(/\s+/g, '-');
    if (name && !textChannels.includes(name)) {
      textChannels.push(name);
      renderTextChannels();
      switchTextChannel(name);
    }
    newChannelInput.value = '';
  }
});

// Chat input
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const text = chatInput.value;
    if (text.trim()) {
      chat.sendMessage(text);
      chatInput.value = '';
    }
  }
});

// Voice control buttons
btnMute.addEventListener('click', () => {
  const muted = voiceChat.toggleMute();
  btnMute.classList.toggle('active', muted);
  btnMute.title = muted ? 'Unmute' : 'Mute';
});

btnDeafen.addEventListener('click', () => {
  const deafened = voiceChat.toggleDeafen();
  btnDeafen.classList.toggle('active', deafened);
  btnDeafen.title = deafened ? 'Undeafen' : 'Deafen';
});

btnScreen.addEventListener('click', async () => {
  if (screenShare.sharing) {
    screenShare.stopSharing();
    btnScreen.classList.remove('active');
  } else {
    await screenShare.startSharing();
    if (screenShare.sharing) {
      btnScreen.classList.add('active');
    }
  }
});

btnDisconnect.addEventListener('click', async () => {
  await voiceChat.leaveChannel();
  screenShare.cleanup();
  voiceControls.classList.remove('active');
  btnMute.classList.remove('active');
  btnDeafen.classList.remove('active');
  btnScreen.classList.remove('active');
  screenShareVideo.srcObject = null;
  screenShareContainer.classList.remove('active');
  renderVoiceChannels();
  renderMembers();
});

// Members list
function renderMembers() {
  membersListEl.innerHTML = '';

  // Online users
  const online = new Map(onlineUsers);
  // Always include self
  if (!online.has(keyPair.publicKey)) {
    online.set(keyPair.publicKey, { nickname, inVoice: false });
  }

  // Update voice status
  if (voiceChat) {
    for (const [pk, info] of online) {
      info.inVoice = voiceChat.voiceUsers.has(pk);
    }
  }

  // Voice users section
  const voiceUsers = Array.from(online.entries()).filter(([, info]) => info.inVoice);
  if (voiceUsers.length > 0) {
    const cat = document.createElement('div');
    cat.className = 'member-category';
    cat.textContent = `Im Voice - ${voiceUsers.length}`;
    membersListEl.appendChild(cat);

    for (const [pk, info] of voiceUsers) {
      membersListEl.appendChild(createMemberItem(pk, info.nickname, true));
    }
  }

  // Online users section
  const cat = document.createElement('div');
  cat.className = 'member-category';
  cat.textContent = `Online - ${online.size}`;
  membersListEl.appendChild(cat);

  for (const [pk, info] of online) {
    membersListEl.appendChild(createMemberItem(pk, info.nickname, info.inVoice));
  }
}

function createMemberItem(pubkey, name, inVoice) {
  const div = document.createElement('div');
  div.className = 'member-item';
  div.innerHTML = `
    <div class="member-avatar ${inVoice ? 'in-voice' : ''}">${escapeHtml(name.charAt(0).toUpperCase())}</div>
    <span class="member-name">${escapeHtml(name)}</span>
    ${inVoice ? '<span class="member-voice-indicator">&#x1F50A;</span>' : ''}
  `;
  div.title = pubkey;
  return div;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Boot
initSetup();
