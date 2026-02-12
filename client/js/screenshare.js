// screenshare.js - WebRTC Screen Sharing

const NostrScreenShare = (() => {
  let screenStream = null;
  let screenPeers = new Map(); // pubkey -> RTCPeerConnection (separate connections for screen)
  let keyPair = null;
  let isSharing = false;
  let currentSharerPubkey = null;

  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
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

    // Listen for screen share signaling
    NostrRelay.subscribe(
      { kinds: [25000], '#p': [keyPair.publicKey] },
      handleScreenSignaling
    );

    // Listen for screen share announcements
    NostrRelay.subscribe(
      { kinds: [25000], '#screen-share-start': ['true'] },
      (event) => {
        if (event.pubkey === keyPair.publicKey) return;
        currentSharerPubkey = event.pubkey;
        updateScreenUI();
      }
    );

    NostrRelay.subscribe(
      { kinds: [25000], '#screen-share-stop': ['true'] },
      (event) => {
        if (event.pubkey === currentSharerPubkey) {
          currentSharerPubkey = null;
          removeScreenView();
          updateScreenUI();
        }
      }
    );
  }

  async function startSharing() {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: true
      });

      isSharing = true;

      // Track when user stops sharing via browser UI
      screenStream.getVideoTracks()[0].onended = () => {
        stopSharing();
      };

      // Announce screen share
      const event = await NostrCrypto.signEvent({
        kind: 25000,
        content: JSON.stringify({ type: 'screen-share-start' }),
        tags: [['screen-share-start', 'true']],
        created_at: Math.floor(Date.now() / 1000)
      }, keyPair.privateKey);
      NostrRelay.publish(event);

      // Create peer connections for all voice users
      const voiceUsers = NostrVoice.getVoiceUsers();
      for (const pubkey of voiceUsers) {
        if (pubkey === keyPair.publicKey) continue;
        await createScreenPeer(pubkey);
      }

      updateScreenUI();
      return true;
    } catch (e) {
      console.error('Screen share error:', e);
      return false;
    }
  }

  async function createScreenPeer(remotePubkey) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    screenPeers.set(remotePubkey, pc);

    if (screenStream) {
      screenStream.getTracks().forEach(track => {
        pc.addTrack(track, screenStream);
      });
    }

    pc.onicecandidate = async (event) => {
      if (event.candidate) {
        const sigEvent = await NostrCrypto.signEvent({
          kind: 25000,
          content: JSON.stringify({
            type: 'screen-ice-candidate',
            candidate: event.candidate
          }),
          tags: [['p', remotePubkey]],
          created_at: Math.floor(Date.now() / 1000)
        }, keyPair.privateKey);
        NostrRelay.publish(sigEvent);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sigEvent = await NostrCrypto.signEvent({
      kind: 25000,
      content: JSON.stringify({
        type: 'screen-offer',
        sdp: pc.localDescription
      }),
      tags: [['p', remotePubkey]],
      created_at: Math.floor(Date.now() / 1000)
    }, keyPair.privateKey);
    NostrRelay.publish(sigEvent);
  }

  async function handleScreenSignaling(event) {
    if (event.pubkey === keyPair.publicKey) return;

    let data;
    try {
      data = JSON.parse(event.content);
    } catch (e) {
      return;
    }

    // Only handle screen-* events here
    if (!data.type || !data.type.startsWith('screen-')) return;

    const remotePubkey = event.pubkey;

    switch (data.type) {
      case 'screen-offer': {
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        screenPeers.set(remotePubkey, pc);

        pc.ontrack = (trackEvent) => {
          showScreenView(trackEvent.streams[0], remotePubkey);
        };

        pc.onicecandidate = async (iceEvent) => {
          if (iceEvent.candidate) {
            const sigEvent = await NostrCrypto.signEvent({
              kind: 25000,
              content: JSON.stringify({
                type: 'screen-ice-candidate',
                candidate: iceEvent.candidate
              }),
              tags: [['p', remotePubkey]],
              created_at: Math.floor(Date.now() / 1000)
            }, keyPair.privateKey);
            NostrRelay.publish(sigEvent);
          }
        };

        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        const sigEvent = await NostrCrypto.signEvent({
          kind: 25000,
          content: JSON.stringify({
            type: 'screen-answer',
            sdp: pc.localDescription
          }),
          tags: [['p', remotePubkey]],
          created_at: Math.floor(Date.now() / 1000)
        }, keyPair.privateKey);
        NostrRelay.publish(sigEvent);
        break;
      }

      case 'screen-answer': {
        const pc = screenPeers.get(remotePubkey);
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        }
        break;
      }

      case 'screen-ice-candidate': {
        const pc = screenPeers.get(remotePubkey);
        if (pc && data.candidate) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          } catch (e) {
            console.error('Screen ICE error:', e);
          }
        }
        break;
      }
    }
  }

  function showScreenView(stream, pubkey) {
    currentSharerPubkey = pubkey;

    let videoContainer = document.getElementById('screen-view');
    if (!videoContainer) return;

    videoContainer.innerHTML = '';
    videoContainer.style.display = 'flex';

    const header = document.createElement('div');
    header.className = 'screen-header';
    const name = NostrChat ? NostrChat.getDisplayName(pubkey) : NostrCrypto.shortenPubkey(pubkey);
    header.innerHTML = `<span>📺 ${name} teilt den Bildschirm</span>`;

    const video = document.createElement('video');
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    video.className = 'screen-video';

    videoContainer.appendChild(header);
    videoContainer.appendChild(video);
  }

  function removeScreenView() {
    const videoContainer = document.getElementById('screen-view');
    if (videoContainer) {
      videoContainer.innerHTML = '';
      videoContainer.style.display = 'none';
    }
  }

  async function stopSharing() {
    if (screenStream) {
      screenStream.getTracks().forEach(track => track.stop());
      screenStream = null;
    }

    // Close all screen peer connections
    for (const [pubkey, pc] of screenPeers.entries()) {
      pc.close();
    }
    screenPeers.clear();

    isSharing = false;

    // Announce stop
    const event = await NostrCrypto.signEvent({
      kind: 25000,
      content: JSON.stringify({ type: 'screen-share-stop' }),
      tags: [['screen-share-stop', 'true']],
      created_at: Math.floor(Date.now() / 1000)
    }, keyPair.privateKey);
    NostrRelay.publish(event);

    if (currentSharerPubkey === keyPair.publicKey) {
      currentSharerPubkey = null;
      removeScreenView();
    }

    updateScreenUI();
  }

  function updateScreenUI() {
    const shareBtn = document.getElementById('btn-screenshare');
    if (shareBtn) {
      shareBtn.textContent = isSharing ? '🖥️ Teilen beenden' : '🖥️ Bildschirm teilen';
      shareBtn.classList.toggle('active', isSharing);
    }
  }

  function getIsSharing() {
    return isSharing;
  }

  return {
    init,
    startSharing,
    stopSharing,
    getIsSharing,
    updateScreenUI
  };
})();
