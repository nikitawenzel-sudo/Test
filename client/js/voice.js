// voice.js - WebRTC Voice Chat (Mesh Network)

const NostrVoice = (() => {
  let localStream = null;
  let peers = new Map(); // pubkey -> { pc: RTCPeerConnection, stream: MediaStream }
  let keyPair = null;
  let currentChannel = null;
  let isMuted = false;
  let isDeafened = false;
  let voiceSubId = null;
  let voiceJoinSubId = null;
  let voiceLeaveSubId = null;
  let voiceUsers = new Set(); // pubkeys in voice

  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    {
      urls: 'turn:a.relay.metered.ca:80',
      username: 'e8dd65b92f73a3e0bfa4d522',
      credential: '5VoqBuvMSgKN0BIU'
    },
    {
      urls: 'turn:a.relay.metered.ca:80?transport=tcp',
      username: 'e8dd65b92f73a3e0bfa4d522',
      credential: '5VoqBuvMSgKN0BIU'
    },
    {
      urls: 'turn:a.relay.metered.ca:443',
      username: 'e8dd65b92f73a3e0bfa4d522',
      credential: '5VoqBuvMSgKN0BIU'
    },
    {
      urls: 'turns:a.relay.metered.ca:443',
      username: 'e8dd65b92f73a3e0bfa4d522',
      credential: '5VoqBuvMSgKN0BIU'
    }
  ];

  function init(keys) {
    keyPair = keys;
  }

  async function joinVoice(channel) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      currentChannel = channel;
      voiceUsers.add(keyPair.publicKey);

      // Subscribe to signaling events
      voiceSubId = NostrRelay.subscribe(
        { kinds: [25000], '#p': [keyPair.publicKey] },
        handleSignalingEvent
      );

      // Announce voice join
      const event = await NostrCrypto.signEvent({
        kind: 25000,
        content: JSON.stringify({ type: 'voice-join', channel }),
        tags: [['voice-join', channel]],
        created_at: Math.floor(Date.now() / 1000)
      }, keyPair.privateKey);

      // Send to all - we broadcast voice-join to everyone
      // We need a general subscription for voice-join events
      voiceJoinSubId = NostrRelay.subscribe(
        { kinds: [25000], '#voice-join': [channel] },
        async (sigEvent) => {
          if (sigEvent.pubkey === keyPair.publicKey) return;
          // Guard: ignore if we already left voice
          if (!currentChannel) return;
          // Guard: prevent duplicate peer connections
          if (peers.has(sigEvent.pubkey)) return;

          voiceUsers.add(sigEvent.pubkey);
          updateVoiceUI();

          // Initiate connection to new peer
          await createPeerConnection(sigEvent.pubkey, true);
        }
      );

      // Also subscribe to voice-leave
      voiceLeaveSubId = NostrRelay.subscribe(
        { kinds: [25000], '#voice-leave': [channel] },
        (sigEvent) => {
          if (sigEvent.pubkey === keyPair.publicKey) return;
          removePeer(sigEvent.pubkey);
        }
      );

      NostrRelay.publish(event);
      updateVoiceUI();

      return true;
    } catch (e) {
      console.error('Failed to join voice:', e);
      return false;
    }
  }

  async function createPeerConnection(remotePubkey, isInitiator) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    peers.set(remotePubkey, { pc, stream: null });

    // Add local audio tracks
    if (localStream) {
      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });
    }

    // Handle incoming tracks
    pc.ontrack = (event) => {
      const peerData = peers.get(remotePubkey);
      if (peerData) {
        peerData.stream = event.streams[0];
        playAudioStream(remotePubkey, event.streams[0]);
      }
    };

    // ICE candidates
    pc.onicecandidate = async (event) => {
      if (event.candidate) {
        const sigEvent = await NostrCrypto.signEvent({
          kind: 25000,
          content: JSON.stringify({
            type: 'ice-candidate',
            candidate: event.candidate
          }),
          tags: [['p', remotePubkey]],
          created_at: Math.floor(Date.now() / 1000)
        }, keyPair.privateKey);
        NostrRelay.publish(sigEvent);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`Peer ${remotePubkey.slice(0,8)}: ${pc.connectionState}`);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        removePeer(remotePubkey);
      }
    };

    // If we're the initiator, create and send offer
    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sigEvent = await NostrCrypto.signEvent({
        kind: 25000,
        content: JSON.stringify({
          type: 'offer',
          sdp: pc.localDescription
        }),
        tags: [['p', remotePubkey]],
        created_at: Math.floor(Date.now() / 1000)
      }, keyPair.privateKey);
      NostrRelay.publish(sigEvent);
    }

    return pc;
  }

  async function handleSignalingEvent(event) {
    if (event.pubkey === keyPair.publicKey) return;

    let data;
    try {
      data = JSON.parse(event.content);
    } catch (e) {
      return;
    }

    // Skip screen-share signaling events (handled by screenshare.js)
    if (data.type && data.type.startsWith('screen-')) return;

    // Skip voice-join/voice-leave (handled by separate subscriptions)
    if (data.type === 'voice-join' || data.type === 'voice-leave') return;

    const remotePubkey = event.pubkey;

    switch (data.type) {
      case 'offer': {
        let peerData = peers.get(remotePubkey);
        if (!peerData) {
          await createPeerConnection(remotePubkey, false);
          peerData = peers.get(remotePubkey);
        }

        const pc = peerData.pc;
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        const sigEvent = await NostrCrypto.signEvent({
          kind: 25000,
          content: JSON.stringify({
            type: 'answer',
            sdp: pc.localDescription
          }),
          tags: [['p', remotePubkey]],
          created_at: Math.floor(Date.now() / 1000)
        }, keyPair.privateKey);
        NostrRelay.publish(sigEvent);

        voiceUsers.add(remotePubkey);
        updateVoiceUI();
        break;
      }

      case 'answer': {
        const peerData = peers.get(remotePubkey);
        if (peerData) {
          await peerData.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        }
        break;
      }

      case 'ice-candidate': {
        const peerData = peers.get(remotePubkey);
        if (peerData && data.candidate) {
          try {
            await peerData.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          } catch (e) {
            console.error('ICE candidate error:', e);
          }
        }
        break;
      }
    }
  }

  function playAudioStream(pubkey, stream) {
    // Remove existing audio element
    const existingEl = document.getElementById('audio-' + pubkey);
    if (existingEl) existingEl.remove();

    const audio = document.createElement('audio');
    audio.id = 'audio-' + pubkey;
    audio.srcObject = stream;
    audio.autoplay = true;
    audio.muted = isDeafened;

    // Hidden audio elements container
    let container = document.getElementById('audio-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'audio-container';
      container.style.display = 'none';
      document.body.appendChild(container);
    }
    container.appendChild(audio);
  }

  function toggleMute() {
    isMuted = !isMuted;
    if (localStream) {
      localStream.getAudioTracks().forEach(track => {
        track.enabled = !isMuted;
      });
    }
    updateVoiceUI();
    return isMuted;
  }

  function toggleDeafen() {
    isDeafened = !isDeafened;
    // Mute/unmute all remote audio
    document.querySelectorAll('#audio-container audio').forEach(audio => {
      audio.muted = isDeafened;
    });
    // Also mute self when deafened
    if (isDeafened && !isMuted) {
      isMuted = true;
      if (localStream) {
        localStream.getAudioTracks().forEach(track => {
          track.enabled = false;
        });
      }
    }
    updateVoiceUI();
    return isDeafened;
  }

  async function leaveVoice() {
    // Send leave event
    if (currentChannel) {
      const event = await NostrCrypto.signEvent({
        kind: 25000,
        content: JSON.stringify({ type: 'voice-leave', channel: currentChannel }),
        tags: [['voice-leave', currentChannel]],
        created_at: Math.floor(Date.now() / 1000)
      }, keyPair.privateKey);
      NostrRelay.publish(event);
    }

    // Close all peer connections
    for (const [pubkey, peerData] of peers.entries()) {
      peerData.pc.close();
    }
    peers.clear();

    // Stop local stream
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = null;
    }

    // Clean up audio elements
    const container = document.getElementById('audio-container');
    if (container) container.innerHTML = '';

    // Unsubscribe all voice-related subscriptions
    if (voiceSubId) {
      NostrRelay.unsubscribe(voiceSubId);
      voiceSubId = null;
    }
    if (voiceJoinSubId) {
      NostrRelay.unsubscribe(voiceJoinSubId);
      voiceJoinSubId = null;
    }
    if (voiceLeaveSubId) {
      NostrRelay.unsubscribe(voiceLeaveSubId);
      voiceLeaveSubId = null;
    }

    voiceUsers.clear();
    currentChannel = null;
    isMuted = false;
    isDeafened = false;

    updateVoiceUI();
  }

  function removePeer(pubkey) {
    const peerData = peers.get(pubkey);
    if (peerData) {
      peerData.pc.close();
      peers.delete(pubkey);
    }
    voiceUsers.delete(pubkey);

    const audioEl = document.getElementById('audio-' + pubkey);
    if (audioEl) audioEl.remove();

    updateVoiceUI();
  }

  function updateVoiceUI() {
    // Update voice user list
    const voiceUsersEl = document.getElementById('voice-users');
    if (voiceUsersEl) {
      voiceUsersEl.innerHTML = '';
      for (const pubkey of voiceUsers) {
        const li = document.createElement('div');
        li.className = 'voice-user';
        li.dataset.pubkey = pubkey;
        const isMe = pubkey === keyPair?.publicKey;
        const name = NostrChat ? NostrChat.getDisplayName(pubkey) : NostrCrypto.shortenPubkey(pubkey);
        li.innerHTML = `
          <span class="voice-indicator ${isMe && isMuted ? 'muted' : 'speaking'}">🎤</span>
          <span class="user-name" data-pubkey="${pubkey}">${name}</span>
          ${isMe ? '<span class="me-badge">(Du)</span>' : ''}
        `;
        voiceUsersEl.appendChild(li);
      }
    }

    // Update controls
    const muteBtn = document.getElementById('btn-mute');
    const deafenBtn = document.getElementById('btn-deafen');
    const voiceControls = document.getElementById('voice-controls');

    if (muteBtn) {
      muteBtn.textContent = isMuted ? '🔇 Unmute' : '🎤 Mute';
      muteBtn.classList.toggle('active', isMuted);
    }
    if (deafenBtn) {
      deafenBtn.textContent = isDeafened ? '🔇 Undeafen' : '🔊 Deafen';
      deafenBtn.classList.toggle('active', isDeafened);
    }
    if (voiceControls) {
      voiceControls.style.display = currentChannel ? 'flex' : 'none';
    }
  }

  function isInVoice() {
    return currentChannel !== null;
  }

  function getVoiceChannel() {
    return currentChannel;
  }

  function getVoiceUsers() {
    return voiceUsers;
  }

  function isMutedState() {
    return isMuted;
  }

  return {
    init,
    joinVoice,
    leaveVoice,
    toggleMute,
    toggleDeafen,
    isInVoice,
    getVoiceChannel,
    getVoiceUsers,
    isMutedState,
    updateVoiceUI
  };
})();
