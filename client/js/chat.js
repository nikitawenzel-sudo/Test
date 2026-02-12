import { createUnsignedEvent, signEvent, shortenPubkey } from './crypto.js';

export class Chat {
  constructor(relay, keyPair, nicknames) {
    this.relay = relay;
    this.keyPair = keyPair;
    this.nicknames = nicknames; // Map<pubkey, nickname>
    this.currentChannel = null;
    this.currentSubId = null;
    this.messageContainer = null;
    this.seenEventIds = new Set();
    this.onMessageCallback = null;
  }

  setMessageContainer(element) {
    this.messageContainer = element;
  }

  onMessage(callback) {
    this.onMessageCallback = callback;
  }

  switchChannel(channel) {
    // Unsubscribe from previous channel
    if (this.currentSubId) {
      this.relay.unsubscribe(this.currentSubId);
    }

    this.currentChannel = channel;
    this.seenEventIds.clear();

    if (this.messageContainer) {
      this.messageContainer.innerHTML = '';
    }

    // Subscribe to new channel
    this.currentSubId = this.relay.subscribe(
      { kinds: [1], '#channel': [channel] },
      (event) => this._handleEvent(event)
    );
  }

  async sendMessage(text) {
    if (!this.currentChannel || !text.trim()) return;

    const event = createUnsignedEvent(
      1,
      text.trim(),
      [['channel', this.currentChannel]],
      this.keyPair.publicKey
    );

    const signed = await signEvent(event, this.keyPair.privateKey);
    this.relay.publish(signed);
  }

  _handleEvent(event) {
    if (event.kind !== 1) return;
    if (this.seenEventIds.has(event.id)) return;
    this.seenEventIds.add(event.id);

    this.renderMessage(event);

    if (this.onMessageCallback) {
      this.onMessageCallback(event);
    }
  }

  renderMessage(event) {
    if (!this.messageContainer) return;

    const div = document.createElement('div');
    div.className = 'message';
    div.dataset.eventId = event.id;

    const name = this.nicknames.get(event.pubkey) || shortenPubkey(event.pubkey);
    const time = new Date(event.created_at * 1000);
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    div.innerHTML = `
      <span class="message-time">${this._escapeHtml(timeStr)}</span>
      <span class="message-author" title="${event.pubkey}">${this._escapeHtml(name)}</span>
      <span class="message-content">${this._escapeHtml(event.content)}</span>
    `;

    this.messageContainer.appendChild(div);
    this.messageContainer.scrollTop = this.messageContainer.scrollHeight;
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
