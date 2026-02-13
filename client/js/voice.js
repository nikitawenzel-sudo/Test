// voice.js - WebRTC Voice Chat (P2P via Trystero)

const NostrVoice = (() => {
  let localStream = null;
  let rawStream = null; // unprocessed mic stream
  let audioContext = null;
  let keyPair = null;
  let currentChannel = null;
  let isMuted = false;
  let isDeafened = false;
  let voiceUsers = new Set(); // pubkeys in voice
  let noiseGateActive = true;
  let peerStreams = new Map(); // peerId -> MediaStream

  function init(keys) {
    keyPair = keys;

    // Handle incoming voice streams from peers
    P2P.onVoiceStream((stream, peerId) => {
      if (!currentChannel) return;
      const pubkey = P2P.getPubkeyForPeer(peerId);
      if (pubkey) {
        voiceUsers.add(pubkey);
        peerStreams.set(peerId, stream);
        playAudioStream(pubkey, stream);
        updateVoiceUI();
      }
    });

    // Handle peer leaving - remove their audio
    P2P.onStreamRemoved(peerId => {
      const pubkey = P2P.getPubkeyForPeer(peerId);
      if (pubkey) {
        removePeer(pubkey, peerId);
      }
    });

    P2P.onPeerLeave((peerId, peerInfo) => {
      if (peerInfo && peerInfo.pubkey) {
        removePeer(peerInfo.pubkey, peerId);
      }
    });
  }

  function createAudioPipeline(rawAudioStream) {
    audioContext = new AudioContext({ sampleRate: 48000 });
    const source = audioContext.createMediaStreamSource(rawAudioStream);

    // High-pass filter: remove low-frequency rumble (< 80Hz)
    const highpass = audioContext.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 80;
    highpass.Q.value = 0.7;

    // Low-pass filter: remove high-frequency hiss (> 14kHz)
    const lowpass = audioContext.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 14000;
    lowpass.Q.value = 0.7;

    // Compressor: even out volume levels
    const compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.value = -30;
    compressor.knee.value = 20;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;

    // Noise gate via gain node
    const gate = audioContext.createGain();
    gate.gain.value = 1;

    // Analyser for noise gate monitoring
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    const analyserData = new Float32Array(analyser.fftSize);

    // Signal chain: source -> highpass -> lowpass -> compressor -> gate -> destination
    const destination = audioContext.createMediaStreamDestination();
    source.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(compressor);
    compressor.connect(analyser);
    compressor.connect(gate);
    gate.connect(destination);

    // Noise gate: smoothly mute when audio level is below threshold
    const GATE_THRESHOLD = 0.008;
    const GATE_OPEN_TIME = 0.01;
    const GATE_CLOSE_TIME = 0.08;

    function monitorNoiseGate() {
      if (!currentChannel || !audioContext) return;

      analyser.getFloatTimeDomainData(analyserData);
      let rms = 0;
      for (let i = 0; i < analyserData.length; i++) {
        rms += analyserData[i] * analyserData[i];
      }
      rms = Math.sqrt(rms / analyserData.length);

      if (noiseGateActive) {
        if (rms > GATE_THRESHOLD) {
          gate.gain.setTargetAtTime(1, audioContext.currentTime, GATE_OPEN_TIME);
        } else {
          gate.gain.setTargetAtTime(0, audioContext.currentTime, GATE_CLOSE_TIME);
        }
      }

      requestAnimationFrame(monitorNoiseGate);
    }
    monitorNoiseGate();

    return destination.stream;
  }

  async function joinVoice(channel) {
    try {
      // Get mic with browser-level noise suppression + echo cancellation
      rawStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 1
        }
      });

      // Process through Web Audio API pipeline
      localStream = createAudioPipeline(rawStream);
      currentChannel = channel;
      voiceUsers.add(keyPair.publicKey);

      // Share our voice stream with all peers via Trystero
      P2P.addStream(localStream, { type: 'voice' });

      updateVoiceUI();
      return true;
    } catch (e) {
      console.error('Failed to join voice:', e);
      return false;
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
    if (rawStream) {
      rawStream.getAudioTracks().forEach(track => {
        track.enabled = !isMuted;
      });
    }
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
    document.querySelectorAll('#audio-container audio').forEach(audio => {
      audio.muted = isDeafened;
    });
    if (isDeafened && !isMuted) {
      isMuted = true;
      if (rawStream) {
        rawStream.getAudioTracks().forEach(track => {
          track.enabled = false;
        });
      }
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
    // Remove our stream from Trystero
    if (localStream) {
      P2P.removeStream(localStream, { type: 'voice' });
    }

    // Stop local stream and audio processing
    if (rawStream) {
      rawStream.getTracks().forEach(track => track.stop());
      rawStream = null;
    }
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = null;
    }
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }

    // Clean up audio elements
    const container = document.getElementById('audio-container');
    if (container) container.innerHTML = '';

    peerStreams.clear();
    voiceUsers.clear();
    currentChannel = null;
    isMuted = false;
    isDeafened = false;

    updateVoiceUI();
  }

  function removePeer(pubkey, peerId) {
    voiceUsers.delete(pubkey);
    if (peerId) peerStreams.delete(peerId);

    const audioEl = document.getElementById('audio-' + pubkey);
    if (audioEl) audioEl.remove();

    updateVoiceUI();
  }

  function updateVoiceUI() {
    const voiceUsersEl = document.getElementById('voice-users');
    if (voiceUsersEl) {
      voiceUsersEl.innerHTML = '';
      for (const pubkey of voiceUsers) {
        const li = document.createElement('div');
        li.className = 'voice-user';
        li.dataset.pubkey = pubkey;
        const isMe = pubkey === keyPair?.publicKey;
        const name = NostrChat ? NostrChat.getDisplayName(pubkey) : NostrCrypto.shortenPubkey(pubkey);
        const avatar = NostrChat ? NostrChat.getAvatarUrl(pubkey) : null;
        const avatarHtml = avatar
          ? `<img class="avatar-img" src="${avatar}" style="width:20px;height:20px;border-radius:50%;">`
          : `<span class="voice-indicator ${isMe && isMuted ? 'muted' : 'speaking'}">🎤</span>`;
        li.innerHTML = `
          ${avatarHtml}
          <span class="user-name" data-pubkey="${pubkey}">${name}</span>
          ${isMe ? '<span class="me-badge">(Du)</span>' : ''}
        `;
        voiceUsersEl.appendChild(li);
      }
    }

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
