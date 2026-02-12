import { createUnsignedEvent, signEvent } from './crypto.js';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

export class VoiceChat {
  constructor(relay, keyPair) {
    this.relay = relay;
    this.keyPair = keyPair;
    this.peers = new Map(); // pubkey → RTCPeerConnection
    this.localStream = null;
    this.currentChannel = null;
    this.muted = false;
    this.deafened = false;
    this.voiceUsers = new Set(); // pubkeys in voice
    this.onVoiceUsersChanged = null;
    this.onRemoteStream = null;
    this.screenShare = null; // reference to ScreenShare instance

    this._setupSignalingHandler();
  }

  _setupSignalingHandler() {
    this.relay.onSignaling((event) => this._handleSignaling(event));
  }

  async joinChannel(channel) {
    if (this.currentChannel) {
      await this.leaveChannel();
    }

    this.currentChannel = channel;

    // Get microphone
    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    this.voiceUsers.add(this.keyPair.publicKey);
    this._notifyVoiceUsersChanged();

    // Announce join
    const event = createUnsignedEvent(
      25000,
      JSON.stringify({ type: 'voice-join', channel }),
      [['voice-join', channel]],
      this.keyPair.publicKey
    );
    const signed = await signEvent(event, this.keyPair.privateKey);
    this.relay.publish(signed);
  }

  async leaveChannel() {
    if (!this.currentChannel) return;

    // Announce leave
    const event = createUnsignedEvent(
      25000,
      JSON.stringify({ type: 'voice-leave', channel: this.currentChannel }),
      [['voice-leave', this.currentChannel]],
      this.keyPair.publicKey
    );
    const signed = await signEvent(event, this.keyPair.privateKey);
    this.relay.publish(signed);

    // Close all peer connections
    for (const [pubkey, pc] of this.peers.entries()) {
      pc.close();
    }
    this.peers.clear();

    // Stop local stream
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    this.voiceUsers.clear();
    this.currentChannel = null;
    this._notifyVoiceUsersChanged();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(t => {
        t.enabled = !this.muted;
      });
    }
    return this.muted;
  }

  toggleDeafen() {
    this.deafened = !this.deafened;
    // Mute all remote audio
    const audioElements = document.querySelectorAll('audio[data-voice-peer]');
    audioElements.forEach(el => {
      el.muted = this.deafened;
    });
    return this.deafened;
  }

  async _handleSignaling(event) {
    if (event.pubkey === this.keyPair.publicKey) return;

    let data;
    try {
      data = JSON.parse(event.content);
    } catch {
      return;
    }

    if (data.type === 'voice-join' && data.channel === this.currentChannel) {
      this.voiceUsers.add(event.pubkey);
      this._notifyVoiceUsersChanged();
      // Initiate connection to new user
      if (this.currentChannel) {
        await this._createOffer(event.pubkey);
      }
    } else if (data.type === 'voice-leave') {
      this.voiceUsers.delete(event.pubkey);
      this._closePeer(event.pubkey);
      this._notifyVoiceUsersChanged();
    } else if (data.type === 'offer') {
      await this._handleOffer(event.pubkey, data);
    } else if (data.type === 'answer') {
      await this._handleAnswer(event.pubkey, data);
    } else if (data.type === 'ice-candidate') {
      await this._handleIceCandidate(event.pubkey, data);
    } else if (data.type === 'screen-share-start') {
      if (this.screenShare) {
        this.screenShare._handleRemoteStart(event.pubkey);
      }
    } else if (data.type === 'screen-share-stop') {
      if (this.screenShare) {
        this.screenShare._handleRemoteStop(event.pubkey);
      }
    }
  }

  _getOrCreatePeer(pubkey) {
    if (this.peers.has(pubkey)) {
      return this.peers.get(pubkey);
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Add local audio stream
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // Handle remote stream
    pc.ontrack = (e) => {
      if (e.streams && e.streams[0]) {
        this._attachRemoteStream(pubkey, e.streams[0]);
      }
    };

    // Handle ICE candidates
    pc.onicecandidate = async (e) => {
      if (e.candidate) {
        const event = createUnsignedEvent(
          25000,
          JSON.stringify({
            type: 'ice-candidate',
            candidate: e.candidate.toJSON(),
            channel: this.currentChannel
          }),
          [['p', pubkey]],
          this.keyPair.publicKey
        );
        const signed = await signEvent(event, this.keyPair.privateKey);
        this.relay.publish(signed);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this._closePeer(pubkey);
      }
    };

    this.peers.set(pubkey, pc);
    return pc;
  }

  async _createOffer(pubkey) {
    const pc = this._getOrCreatePeer(pubkey);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const event = createUnsignedEvent(
      25000,
      JSON.stringify({
        type: 'offer',
        sdp: offer.sdp,
        channel: this.currentChannel
      }),
      [['p', pubkey]],
      this.keyPair.publicKey
    );
    const signed = await signEvent(event, this.keyPair.privateKey);
    this.relay.publish(signed);
  }

  async _handleOffer(pubkey, data) {
    if (!this.currentChannel) return;

    const pc = this._getOrCreatePeer(pubkey);
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    const event = createUnsignedEvent(
      25000,
      JSON.stringify({
        type: 'answer',
        sdp: answer.sdp,
        channel: this.currentChannel
      }),
      [['p', pubkey]],
      this.keyPair.publicKey
    );
    const signed = await signEvent(event, this.keyPair.privateKey);
    this.relay.publish(signed);

    this.voiceUsers.add(pubkey);
    this._notifyVoiceUsersChanged();
  }

  async _handleAnswer(pubkey, data) {
    const pc = this.peers.get(pubkey);
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
  }

  async _handleIceCandidate(pubkey, data) {
    const pc = this.peers.get(pubkey);
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (err) {
      console.warn('Failed to add ICE candidate:', err);
    }
  }

  _attachRemoteStream(pubkey, stream) {
    // Remove existing audio element
    const existing = document.querySelector(`audio[data-voice-peer="${pubkey}"]`);
    if (existing) existing.remove();

    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.dataset.voicePeer = pubkey;
    audio.srcObject = stream;
    audio.muted = this.deafened;
    document.body.appendChild(audio);

    if (this.onRemoteStream) {
      this.onRemoteStream(pubkey, stream);
    }
  }

  _closePeer(pubkey) {
    const pc = this.peers.get(pubkey);
    if (pc) {
      pc.close();
      this.peers.delete(pubkey);
    }
    const audio = document.querySelector(`audio[data-voice-peer="${pubkey}"]`);
    if (audio) audio.remove();
  }

  _notifyVoiceUsersChanged() {
    if (this.onVoiceUsersChanged) {
      this.onVoiceUsersChanged(Array.from(this.voiceUsers));
    }
  }

  get isInVoice() {
    return this.currentChannel !== null;
  }
}
