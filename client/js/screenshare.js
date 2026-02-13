// screenshare.js - Screen Sharing (P2P via Trystero)

const NostrScreenShare = (() => {
  let screenStream = null;
  let keyPair = null;
  let isSharing = false;
  let currentSharerPubkey = null;

  function init(keys) {
    keyPair = keys;

    // Handle incoming screen streams from peers
    P2P.onScreenStream((stream, peerId) => {
      const pubkey = P2P.getPubkeyForPeer(peerId);
      if (pubkey) {
        showScreenView(stream, pubkey);
      }
    });

    // Handle peer leaving - remove screen share
    P2P.onPeerLeave((peerId, peerInfo) => {
      if (peerInfo && peerInfo.pubkey === currentSharerPubkey) {
        currentSharerPubkey = null;
        removeScreenView();
        updateScreenUI();
      }
    });

    P2P.onStreamRemoved(peerId => {
      const pubkey = P2P.getPubkeyForPeer(peerId);
      if (pubkey === currentSharerPubkey) {
        currentSharerPubkey = null;
        removeScreenView();
        updateScreenUI();
      }
    });
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

      // Share screen stream with all peers via Trystero
      P2P.addStream(screenStream, { type: 'screen' });

      updateScreenUI();
      return true;
    } catch (e) {
      console.error('Screen share error:', e);
      return false;
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
    // Remove stream from Trystero
    if (screenStream) {
      P2P.removeStream(screenStream, { type: 'screen' });
      screenStream.getTracks().forEach(track => track.stop());
      screenStream = null;
    }

    isSharing = false;

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
