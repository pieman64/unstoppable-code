// Browser Lab interaction case `popups-permissions` (CAN-1570): exercise
// same-origin popups, browser permission prompts, notifications, and the file
// picker using synthetic content only.

const ENTRY_PATH = '/browser-lab/popups-permissions';
const POPUP_PATH = `${ENTRY_PATH}/popup`;

const STYLES = `
  .permission-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
  .permission-card { min-width: 0; padding: 12px; border: 1px solid #b7bec7; border-radius: 6px; background: #fff; }
  .permission-card button { margin: 4px 4px 4px 0; }
  output { display: block; min-height: 1.25em; margin-top: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
`;

const ENTRY_SCRIPT = `(() => {
  'use strict';

  const byTestId = (name) => document.querySelector('[data-testid="browser-lab-popups-permissions-' + name + '"]');
  const record = (status, state, outcome, message) => {
    status.dataset.browserLabState = state;
    status.dataset.browserLabOutcome = outcome;
    status.textContent = message;
  };
  const recordError = (status, error, message) => {
    const name = error && typeof error.name === 'string' ? error.name : 'Error';
    status.dataset.browserLabState = 'error';
    status.dataset.browserLabOutcome = 'error';
    status.dataset.browserLabErrorName = name;
    status.textContent = message + ' (' + name + ')';
  };

  const popupMessageStatus = byTestId('opener-message-status');
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin || event.source === window) return;
    if (typeof event.data !== 'string') return;
    popupMessageStatus.dataset.browserLabState = 'received';
    popupMessageStatus.dataset.browserLabOutcome = 'same-origin-popup-message';
    popupMessageStatus.dataset.browserLabOrigin = event.origin;
    popupMessageStatus.dataset.browserLabMessage = event.data;
    popupMessageStatus.textContent = 'Same-origin popup message: ' + event.data;
  });

  const openButton = byTestId('open-now-button');
  const openStatus = byTestId('open-now-status');
  openButton.addEventListener('click', () => {
    try {
      const handle = window.open('/browser-lab/popups-permissions/popup', 'browser-lab-popup', 'popup,width=480,height=360');
      const returned = Boolean(handle);
      openStatus.dataset.browserLabHandle = returned ? 'returned' : 'null';
      record(openStatus, returned ? 'opened' : 'blocked', returned ? 'handle-returned' : 'no-handle', returned ? 'Popup window handle returned' : 'Popup was blocked; no window handle returned');
    } catch (error) {
      recordError(openStatus, error, 'Popup open failed');
      openStatus.dataset.browserLabHandle = 'error';
    }
  });

  const delayedButton = byTestId('open-delayed-button');
  const delayedStatus = byTestId('open-delayed-status');
  delayedButton.addEventListener('click', () => {
    delayedButton.disabled = true;
    record(delayedStatus, 'waiting', 'scheduled', 'Popup open scheduled for 6 seconds after this click');
    window.setTimeout(() => {
      try {
        const handle = window.open('/browser-lab/popups-permissions/popup', 'browser-lab-delayed-popup', 'popup,width=480,height=360');
        const returned = Boolean(handle);
        delayedStatus.dataset.browserLabHandle = returned ? 'returned' : 'null';
        record(delayedStatus, returned ? 'opened' : 'blocked', returned ? 'handle-returned' : 'no-handle', returned ? 'Delayed popup window handle returned' : 'Delayed popup was blocked; no window handle returned');
      } catch (error) {
        recordError(delayedStatus, error, 'Delayed popup open failed');
        delayedStatus.dataset.browserLabHandle = 'error';
      }
      delayedButton.disabled = false;
    }, 6000);
  });

  const geolocationButton = byTestId('geolocation-button');
  const geolocationStatus = byTestId('geolocation-status');
  geolocationButton.addEventListener('click', () => {
    const geolocation = navigator.geolocation;
    if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') {
      record(geolocationStatus, 'unsupported', 'unsupported', 'Geolocation is unsupported');
      return;
    }
    record(geolocationStatus, 'waiting', 'pending', 'Waiting for geolocation');
    geolocation.getCurrentPosition(
      (position) => {
        const latitude = Number(position.coords.latitude).toFixed(2);
        const longitude = Number(position.coords.longitude).toFixed(2);
        geolocationStatus.dataset.browserLabLatitude = latitude;
        geolocationStatus.dataset.browserLabLongitude = longitude;
        record(geolocationStatus, 'success', 'position', 'Position: ' + latitude + ', ' + longitude);
      },
      (error) => {
        const code = String(error.code);
        const message = typeof error.message === 'string' ? error.message : 'No error message';
        geolocationStatus.dataset.browserLabErrorCode = code;
        geolocationStatus.dataset.browserLabErrorMessage = message;
        geolocationStatus.dataset.browserLabState = 'error';
        geolocationStatus.dataset.browserLabOutcome = 'error';
        geolocationStatus.textContent = 'Geolocation failed (code ' + code + '): ' + message;
      },
      { enableHighAccuracy: false, maximumAge: 0, timeout: 5000 },
    );
  });

  const geolocationPermissionButton = byTestId('geolocation-permission-button');
  const geolocationPermissionStatus = byTestId('geolocation-permission-status');
  geolocationPermissionButton.addEventListener('click', async () => {
    if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
      record(geolocationPermissionStatus, 'unsupported', 'unsupported', 'Geolocation permission query is unsupported');
      return;
    }
    record(geolocationPermissionStatus, 'waiting', 'pending', 'Checking geolocation permission');
    try {
      const permission = await navigator.permissions.query({ name: 'geolocation' });
      geolocationPermissionStatus.dataset.browserLabPermission = permission.state;
      record(geolocationPermissionStatus, 'ready', permission.state, 'Geolocation permission: ' + permission.state);
    } catch (error) {
      recordError(geolocationPermissionStatus, error, 'Geolocation permission query failed');
    }
  });

  const notificationInitialStatus = byTestId('notification-initial-status');
  const notificationPermission = () => {
    if (typeof Notification === 'undefined') {
      record(notificationInitialStatus, 'unsupported', 'unsupported', 'Notifications are unsupported');
      return null;
    }
    const permission = Notification.permission;
    notificationInitialStatus.dataset.browserLabPermission = permission;
    record(notificationInitialStatus, 'ready', permission, 'Initial notification permission: ' + permission);
    return permission;
  };
  notificationPermission();

  const requestNotificationButton = byTestId('notification-permission-button');
  const requestNotificationStatus = byTestId('notification-permission-status');
  requestNotificationButton.addEventListener('click', async () => {
    if (typeof Notification === 'undefined') {
      record(requestNotificationStatus, 'unsupported', 'unsupported', 'Notifications are unsupported');
      return;
    }
    record(requestNotificationStatus, 'waiting', 'pending', 'Waiting for notification permission');
    try {
      const permission = await Notification.requestPermission();
      requestNotificationStatus.dataset.browserLabPermission = permission;
      record(requestNotificationStatus, 'ready', permission, 'Notification permission: ' + permission);
      notificationInitialStatus.dataset.browserLabPermission = Notification.permission;
    } catch (error) {
      recordError(requestNotificationStatus, error, 'Notification permission request failed');
    }
  });

  const createNotificationButton = byTestId('notification-create-button');
  const createNotificationStatus = byTestId('notification-create-status');
  createNotificationButton.addEventListener('click', () => {
    if (typeof Notification === 'undefined') {
      record(createNotificationStatus, 'unsupported', 'unsupported', 'Notifications are unsupported');
      return;
    }
    if (Notification.permission !== 'granted') {
      createNotificationStatus.dataset.browserLabPermission = Notification.permission;
      record(createNotificationStatus, 'blocked', 'permission-not-granted', 'Notification not created; permission is ' + Notification.permission);
      return;
    }
    try {
      new Notification('Browser Lab notification', { body: 'Synthetic notification body.' });
      record(createNotificationStatus, 'created', 'notification-created', 'Synthetic notification created');
    } catch (error) {
      recordError(createNotificationStatus, error, 'Notification creation failed');
    }
  });

  const filePickerButton = byTestId('file-picker-button');
  const filePickerStatus = byTestId('file-picker-status');
  filePickerButton.addEventListener('click', async () => {
    if (typeof window.showOpenFilePicker !== 'function') {
      record(filePickerStatus, 'unsupported', 'unsupported', 'Open file picker is unsupported');
      return;
    }
    record(filePickerStatus, 'waiting', 'pending', 'Waiting for file selection');
    try {
      const handles = await window.showOpenFilePicker({ multiple: false });
      const files = await Promise.all(handles.map(async (handle) => {
        const file = await handle.getFile();
        return { name: file.name, size: file.size };
      }));
      filePickerStatus.dataset.browserLabFiles = JSON.stringify(files);
      filePickerStatus.dataset.browserLabCount = String(files.length);
      const summary = files.map((file) => file.name + ' (' + file.size + ' bytes)').join(', ');
      record(filePickerStatus, 'selected', files.length > 0 ? 'files-selected' : 'empty-selection', files.length > 0 ? 'Selected files: ' + summary : 'No files selected');
    } catch (error) {
      const name = error && typeof error.name === 'string' ? error.name : 'Error';
      filePickerStatus.dataset.browserLabErrorName = name;
      record(filePickerStatus, 'error', name, 'Open file picker failed (' + name + ')');
    }
  });
})();`;

const POPUP_SCRIPT = `(() => {
  'use strict';

  const byTestId = (name) => document.querySelector('[data-testid="browser-lab-popups-permissions-' + name + '"]');
  const messageButton = byTestId('popup-message-button');
  const messageStatus = byTestId('popup-message-status');
  messageButton.addEventListener('click', () => {
    try {
      const opener = window.opener;
      if (!opener || opener.closed) {
        messageStatus.dataset.browserLabState = 'unavailable';
        messageStatus.dataset.browserLabOutcome = 'no-opener';
        messageStatus.textContent = 'No opener window is available';
        return;
      }
      opener.postMessage('Browser Lab popup message', window.location.origin);
      messageStatus.dataset.browserLabState = 'sent';
      messageStatus.dataset.browserLabOutcome = 'same-origin-message-sent';
      messageStatus.textContent = 'Message sent to opener';
    } catch (error) {
      const name = error && typeof error.name === 'string' ? error.name : 'Error';
      messageStatus.dataset.browserLabState = 'error';
      messageStatus.dataset.browserLabOutcome = 'error';
      messageStatus.dataset.browserLabErrorName = name;
      messageStatus.textContent = 'Message send failed (' + name + ')';
    }
  });

  const closeButton = byTestId('popup-close-button');
  const closeStatus = byTestId('popup-close-status');
  closeButton.addEventListener('click', () => {
    closeStatus.dataset.browserLabState = 'closing';
    closeStatus.dataset.browserLabOutcome = 'close-called';
    closeStatus.textContent = 'Close requested';
    window.close();
  });
})();`;

export const interactionCase = {
  id: 'popups-permissions',
  kind: 'interaction',
  title: 'Popups and permissions',
  entryPath: ENTRY_PATH,
  pages: [
    {
      path: ENTRY_PATH,
      controls: [
        'browser-lab-popups-permissions-main',
        'browser-lab-header-home',
        'browser-lab-popups-permissions-open-now-button',
        'browser-lab-popups-permissions-open-now-status',
        'browser-lab-popups-permissions-open-delayed-button',
        'browser-lab-popups-permissions-open-delayed-status',
        'browser-lab-popups-permissions-popup-link',
        'browser-lab-popups-permissions-opener-message-status',
        'browser-lab-popups-permissions-geolocation-button',
        'browser-lab-popups-permissions-geolocation-status',
        'browser-lab-popups-permissions-geolocation-permission-button',
        'browser-lab-popups-permissions-geolocation-permission-status',
        'browser-lab-popups-permissions-notification-initial-status',
        'browser-lab-popups-permissions-notification-permission-button',
        'browser-lab-popups-permissions-notification-permission-status',
        'browser-lab-popups-permissions-notification-create-button',
        'browser-lab-popups-permissions-notification-create-status',
        'browser-lab-popups-permissions-file-picker-button',
        'browser-lab-popups-permissions-file-picker-status',
      ],
    },
    {
      path: POPUP_PATH,
      controls: [
        'browser-lab-popups-permissions-popup-main',
        'browser-lab-popups-permissions-popup-message-button',
        'browser-lab-popups-permissions-popup-message-status',
        'browser-lab-popups-permissions-popup-close-button',
        'browser-lab-popups-permissions-popup-close-status',
      ],
    },
  ],
};

export function createRoutes(kit) {
  const { html } = kit;
  const renderEntry = () =>
    kit.renderInteractionPage({
      caseDef: interactionCase,
      scripts: [ENTRY_SCRIPT],
      styles: STYLES,
      main: html`<main data-testid="browser-lab-popups-permissions-main">
        <h1>${interactionCase.title}</h1>
        <p>
          Exercise browser popups, permission surfaces, and a synthetic file
          selection. No page action sends data outside this origin.
        </p>
        <div class="permission-grid">
          <section class="permission-card" aria-labelledby="popup-heading">
            <h2 id="popup-heading">Popups</h2>
            <button
              type="button"
              data-testid="browser-lab-popups-permissions-open-now-button"
            >
              Open popup now
            </button>
            <output
              data-testid="browser-lab-popups-permissions-open-now-status"
              data-browser-lab-state="ready"
              data-browser-lab-outcome="not-run"
              data-browser-lab-handle="not-attempted"
              >Popup open ready</output
            >
            <button
              type="button"
              data-testid="browser-lab-popups-permissions-open-delayed-button"
            >
              Open popup after delay
            </button>
            <output
              data-testid="browser-lab-popups-permissions-open-delayed-status"
              data-browser-lab-state="ready"
              data-browser-lab-outcome="not-run"
              data-browser-lab-handle="not-attempted"
              >Delayed popup open ready</output
            >
            <p>
              <a
                href="${POPUP_PATH}"
                target="_blank"
                rel="opener"
                data-testid="browser-lab-popups-permissions-popup-link"
                >Open popup page in a new tab</a
              >
            </p>
            <output
              data-testid="browser-lab-popups-permissions-opener-message-status"
              data-browser-lab-state="ready"
              data-browser-lab-outcome="not-run"
              data-browser-lab-message=""
              >No popup message received</output
            >
          </section>

          <section
            class="permission-card"
            aria-labelledby="geolocation-heading"
          >
            <h2 id="geolocation-heading">Geolocation</h2>
            <button
              type="button"
              data-testid="browser-lab-popups-permissions-geolocation-button"
            >
              Get current position
            </button>
            <output
              data-testid="browser-lab-popups-permissions-geolocation-status"
              data-browser-lab-state="ready"
              data-browser-lab-outcome="not-run"
              data-browser-lab-error-code=""
              data-browser-lab-error-message=""
              >Geolocation ready</output
            >
            <button
              type="button"
              data-testid="browser-lab-popups-permissions-geolocation-permission-button"
            >
              Query geolocation permission
            </button>
            <output
              data-testid="browser-lab-popups-permissions-geolocation-permission-status"
              data-browser-lab-state="ready"
              data-browser-lab-outcome="not-run"
              data-browser-lab-permission=""
              >Geolocation permission not queried</output
            >
          </section>

          <section
            class="permission-card"
            aria-labelledby="notifications-heading"
          >
            <h2 id="notifications-heading">Notifications</h2>
            <output
              data-testid="browser-lab-popups-permissions-notification-initial-status"
              data-browser-lab-state="pending"
              data-browser-lab-outcome="not-checked"
              data-browser-lab-permission=""
              >Initial notification permission not checked</output
            >
            <button
              type="button"
              data-testid="browser-lab-popups-permissions-notification-permission-button"
            >
              Request notification permission
            </button>
            <output
              data-testid="browser-lab-popups-permissions-notification-permission-status"
              data-browser-lab-state="ready"
              data-browser-lab-outcome="not-run"
              data-browser-lab-permission=""
              >Notification permission request ready</output
            >
            <button
              type="button"
              data-testid="browser-lab-popups-permissions-notification-create-button"
            >
              Create notification if permitted
            </button>
            <output
              data-testid="browser-lab-popups-permissions-notification-create-status"
              data-browser-lab-state="ready"
              data-browser-lab-outcome="not-run"
              data-browser-lab-permission=""
              data-browser-lab-error-name=""
              >Notification creation ready</output
            >
          </section>

          <section
            class="permission-card"
            aria-labelledby="file-picker-heading"
          >
            <h2 id="file-picker-heading">Open file picker</h2>
            <p>Only selected file names and sizes are recorded.</p>
            <button
              type="button"
              data-testid="browser-lab-popups-permissions-file-picker-button"
            >
              Choose one file
            </button>
            <output
              data-testid="browser-lab-popups-permissions-file-picker-status"
              data-browser-lab-state="ready"
              data-browser-lab-outcome="not-run"
              data-browser-lab-files="[]"
              data-browser-lab-error-name=""
              >File picker ready</output
            >
          </section>
        </div>
      </main>`,
    });
  const renderPopup = () =>
    kit.renderInteractionPage({
      caseDef: interactionCase,
      suffix: 'Popup',
      header: null,
      scripts: [POPUP_SCRIPT],
      styles: STYLES,
      main: html`<main data-testid="browser-lab-popups-permissions-popup-main">
        <h1>Browser Lab popup</h1>
        <p>This same-origin popup sends a synthetic message to its opener.</p>
        <button
          type="button"
          data-testid="browser-lab-popups-permissions-popup-message-button"
        >
          Post message to opener
        </button>
        <output
          data-testid="browser-lab-popups-permissions-popup-message-status"
          data-browser-lab-state="ready"
          data-browser-lab-outcome="not-run"
          data-browser-lab-error-name=""
          >Popup message ready</output
        >
        <button
          type="button"
          data-testid="browser-lab-popups-permissions-popup-close-button"
        >
          Close popup
        </button>
        <output
          data-testid="browser-lab-popups-permissions-popup-close-status"
          data-browser-lab-state="ready"
          data-browser-lab-outcome="not-run"
          >Popup close ready</output
        >
      </main>`,
    });

  return [
    [ENTRY_PATH, kit.pageRoute(renderEntry)],
    [POPUP_PATH, kit.pageRoute(renderPopup)],
  ];
}
