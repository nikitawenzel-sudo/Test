import { createUnsignedEvent, signEvent } from './crypto.js';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

export class ScreenShare {
  constructor(relay, keyPair, voiceChat) {
    this.relay = relay;
    this.keyPair = keyPair;
    this.voiceChat = voiceChat;
    this.screenStream = null;
    this.screenPeers = new Map(); // pubkey → RTCPeerConnection (separate from voice)
    this.sharing = false;
    this.onScreenStreamReceived = null; // callback(pubkey, stream)
    this.onScreenShareStopped = null;  // callback(pubkey)

    // Link to voice chat for signaling
    this.voiceChat.screenShare = this;
  }

  async startSharing() {
    if (this.sharing) return;

    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      });
    } catch (err) {
      console.log('Screen share cancelled or failed:', err.message);
      return;
    }

    this.sharing = true;

    // Handle user stopping share via browser UI
    this.screenStream.getVideoTracks()[0].onended = () => {
      this.stopSharing();
    };

    // Announce screen share start
    const event = createUnsignedEvent(
      25000,
      JSON.stringify({ type: 'screen-share-start', channel: this.voiceChat.currentChannel }),
      [['screen-share-start', this.voiceChat.currentChannel]],
      this.keyPair.publicKey
    );
    const signed = await signEvent(event, this.keyPair.privateKey);
    this.relay.publish(signed);

    // Create screen share connections to all voice peers
    for (const pubkey of this.voiceChat.voiceUsers) {
      if (pubkey === this.keyPair.publicKey) continue;
      await this._createScreenOffer(pubkey);
    }
  }

  async stopSharing() {
    if (!this.sharing) return;
    this.sharing = false;

    // Stop screen stream tracks
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
    }

    // Close all screen peer connections
    for (const [pubkey, pc] of this.screenPeers.entries()) {
      pc.close();
    }
    this.screenPeers.clear();

    // Announce stop
    const event = createUnsignedEvent(
      25000,
      JSON.stringify({ type: 'screen-share-stop', channel: this.voiceChat.currentChannel }),
      [['screen-share-stop', this.voiceChat.currentChannel]],
      this.keyPair.publicKey
    );
    const signed = await signEvent(event, this.keyPair.privateKey);
    this.relay.publish(signed);

    if (this.onScreenShareStopped) {
      this.onScreenShareStopped(this.keyPair.publicKey);
    }
  }

  async _createScreenOffer(pubkey) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.screenPeers.set(pubkey, pc);

    if (this.screenStream) {
      this.screenStream.getTracks().forEach(track => {
        pc.addTrack(track, this.screenStream);
      });
    }

    pc.onicecandidate = async (e) => {
      if (e.candidate) {
        const event = createUnsignedEvent(
          25000,
          JSON.stringify({
            type: 'screen-ice-candidate',
            candidate: e.candidate.toJSON()
          }),
          [['p', pubkey]],
          this.keyPair.publicKey
        );
        const signed = await signEvent(event, this.keyPair.privateKey);
        this.relay.publish(signed);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const event = createUnsignedEvent(
      25000,
      JSON.stringify({
        type: 'screen-offer',
        sdp: offer.sdp
      }),
      [['p', pubkey]],
      this.keyPair.publicKey
    );
    const signed = await signEvent(event, this.keyPair.privateKey);
    this.relay.publish(signed);
  }

  async handleSignaling(event) {
    if (event.pubkey === this.keyPair.publicKey) return;

    let data;
    try {
      data = JSON.parse(event.content);
    } catch {
      return;
    }

    if (data.type === 'screen-offer') {
      await this._handleScreenOffer(event.pubkey, data);
    } else if (data.type === 'screen-answer') {
      await this._handleScreenAnswer(event.pubkey, data);
    } else if (data.type === 'screen-ice-candidate') {
      await this._handleScreenIceCandidate(event.pubkey, data);
    }
  }

  async _handleScreenOffer(pubkey, data) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.screenPeers.set(pubkey, pc);

    pc.ontrack = (e) => {
      if (e.streams && e.streams[0] && this.onScreenStreamReceived) {
        this.onScreenStreamReceived(pubkey, e.streams[0]);
      }
    };

    pc.onicecandidate = async (e) => {
      if (e.candidate) {
        const event = createUnsignedEvent(
          25000,
          JSON.stringify({
            type: 'screen-ice-candidate',
            candidate: e.candidate.toJSON()
          }),
          [['p', pubkey]],
          this.keyPair.publicKey
        );
        const signed = await signEvent(event, this.keyPair.privateKey);
        this.relay.publish(signed);
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    const event = createUnsignedEvent(
      25000,
      JSON.stringify({
        type: 'screen-answer',
        sdp: answer.sdp
      }),
      [['p', pubkey]],
      this.keyPair.publicKey
    );
    const signed = await signEvent(event, this.keyPair.privateKey);
    this.relay.publish(signed);
  }

  async _handleScreenAnswer(pubkey, data) {
    const pc = this.screenPeers.get(pubkey);
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
  }

  async _handleScreenIceCandidate(pubkey, data) {
    const pc = this.screenPeers.get(pubkey);
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (err) {
      console.warn('Failed to add screen ICE candidate:', err);
    }
  }

  _handleRemoteStart(pubkey) {
    // Remote user started sharing - connection will come via screen-offer
    console.log('Screen share started by:', pubkey);
  }

  _handleRemoteStop(pubkey) {
    const pc = this.screenPeers.get(pubkey);
    if (pc) {
      pc.close();
      this.screenPeers.delete(pubkey);
    }
    if (this.onScreenShareStopped) {
      this.onScreenShareStopped(pubkey);
    }
  }

  cleanup() {
    if (this.sharing) {
      this.stopSharing();
    }
    for (const pc of this.screenPeers.values()) {
      pc.close();
    }
    this.screenPeers.clear();
  }
}
