// toast.js - Toast Notification System
// Types: info (blau), warning (gelb), error (rot), success (gruen)

const Toast = (() => {
  let container = null;

  const ERROR_MAP = {
    'webrtc-failed': {
      type: 'error',
      title: 'Verbindung fehlgeschlagen',
      message: 'Pruefe deine Internetverbindung.'
    },
    'decrypt-failed': {
      type: 'info',
      title: 'Verschluesselte Nachricht',
      message: 'Du warst offline als diese Nachricht gesendet wurde.'
    },
    'signature-invalid': {
      type: 'warning',
      title: 'Nachricht nicht verifiziert',
      message: 'Diese Nachricht koennte manipuliert worden sein.'
    },
    'no-peers': {
      type: 'info',
      title: 'Niemand da',
      message: 'Deine Nachricht wird gesendet sobald jemand online kommt.'
    },
    'auth-failed': {
      type: 'warning',
      title: 'Verifizierung fehlgeschlagen',
      message: 'Ein Teilnehmer konnte nicht verifiziert werden.'
    },
    'wrong-password': {
      type: 'error',
      title: 'Falsches Passwort',
      message: 'Nachrichten koennen nicht entschluesselt werden. Pruefe das Raum-Passwort.'
    },
    'connection-lost': {
      type: 'warning',
      title: 'Verbindung verloren',
      message: 'Versuche erneut zu verbinden...'
    },
    'peer-joined': {
      type: 'info',
      title: 'Neuer Teilnehmer',
      message: 'Ein neuer Peer ist dem Raum beigetreten.'
    },
    'peer-left': {
      type: 'info',
      title: 'Teilnehmer gegangen',
      message: 'Ein Peer hat den Raum verlassen.'
    },
    'key-rotated': {
      type: 'success',
      title: 'Schluessel rotiert',
      message: 'Forward Secrecy: Neuer Sender Key aktiv.'
    }
  };

  function init() {
    container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }
  }

  function show(type, title, message, action) {
    if (!container) init();

    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;

    const icons = { info: '\u2139\uFE0F', warning: '\u26A0\uFE0F', error: '\u274C', success: '\u2705' };

    let html = `
      <div class="toast-icon">${icons[type] || ''}</div>
      <div class="toast-body">
        <div class="toast-title">${title}</div>
        <div class="toast-message">${message}</div>
      </div>
      <button class="toast-close">&times;</button>
    `;

    toast.innerHTML = html;

    // Action button
    if (action && action.label && action.fn) {
      const actionBtn = document.createElement('button');
      actionBtn.className = 'toast-action';
      actionBtn.textContent = action.label;
      actionBtn.addEventListener('click', () => {
        action.fn();
        removeToast(toast);
      });
      toast.querySelector('.toast-body').appendChild(actionBtn);
    }

    // Close button
    toast.querySelector('.toast-close').addEventListener('click', () => removeToast(toast));

    container.appendChild(toast);

    // Auto-remove after 6 seconds
    setTimeout(() => removeToast(toast), 6000);

    return toast;
  }

  function showByCode(code, overrides) {
    const entry = ERROR_MAP[code];
    if (!entry) {
      show('info', code, overrides?.message || '', overrides?.action);
      return;
    }
    show(
      overrides?.type || entry.type,
      overrides?.title || entry.title,
      overrides?.message || entry.message,
      overrides?.action || entry.action
    );
  }

  function removeToast(toast) {
    if (!toast || !toast.parentNode) return;
    toast.classList.add('toast-exit');
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  }

  return { show, showByCode, init };
})();
