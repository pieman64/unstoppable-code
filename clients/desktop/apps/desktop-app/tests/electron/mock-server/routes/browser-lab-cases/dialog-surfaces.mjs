// Browser Lab interaction case `dialog-surfaces` (CAN-1570).

const ENTRY_PATH = '/browser-lab/dialog-surfaces';
const FRAME_PATH = `${ENTRY_PATH}/frame`;

const FRAME_ALERT_MESSAGE = 'Browser Lab frame alert.';
const FRAME_CONFIRM_MESSAGE = 'Browser Lab frame confirmation?';
const CLICK_CONFIRM_MESSAGE = 'Browser Lab synchronous click confirmation?';
const BEFORE_UNLOAD_MESSAGE = 'Browser Lab before-unload confirmation.';

const DIALOG_STYLES = `
  .dialog-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
  .dialog-card { min-width: 0; padding: 12px; border: 1px solid #b7bec7; border-radius: 6px; background: #fff; }
  .dialog-card iframe { display: block; width: 100%; height: 210px; border: 1px solid #8993a0; }
  .dialog-card output { display: block; margin-top: 8px; }
  dialog { max-width: 360px; border: 1px solid #8993a0; border-radius: 8px; }
  dialog::backdrop { background: rgb(0 0 0 / 42%); }
`;

const DIALOG_SCRIPT = `(() => {
  'use strict';

  const frameAlert = document.querySelector('[data-browser-lab-frame-alert]');
  if (frameAlert) {
    const status = document.querySelector('[data-browser-lab-frame-alert-status]');
    frameAlert.addEventListener('click', () => {
      status.setAttribute('data-browser-lab-state', 'waiting');
      window.alert('${FRAME_ALERT_MESSAGE}');
      status.setAttribute('data-browser-lab-state', 'acknowledged');
      status.textContent = 'Alert acknowledged';
    });
  }

  const frameConfirm = document.querySelector('[data-browser-lab-frame-confirm]');
  if (frameConfirm) {
    const status = document.querySelector('[data-browser-lab-frame-confirm-status]');
    frameConfirm.addEventListener('click', () => {
      status.setAttribute('data-browser-lab-state', 'waiting');
      const accepted = window.confirm('${FRAME_CONFIRM_MESSAGE}');
      const answer = accepted ? 'accepted' : 'dismissed';
      status.setAttribute('data-browser-lab-state', answer);
      status.setAttribute('data-browser-lab-answer', answer);
      status.textContent = 'Frame confirm: ' + answer;
    });
  }

  const clickConfirm = document.querySelector('[data-browser-lab-click-confirm]');
  if (clickConfirm) {
    const status = document.querySelector('[data-browser-lab-click-confirm-status]');
    clickConfirm.addEventListener('click', () => {
      status.setAttribute('data-browser-lab-state', 'before-dialog');
      status.setAttribute('data-browser-lab-before-dialog', 'mutated');
      status.textContent = 'State changed before confirm';
      const accepted = window.confirm('${CLICK_CONFIRM_MESSAGE}');
      const answer = accepted ? 'accepted' : 'dismissed';
      status.setAttribute('data-browser-lab-state', answer);
      status.setAttribute('data-browser-lab-answer', answer);
      status.setAttribute('data-browser-lab-transition', 'before-dialog->' + answer);
      status.textContent = 'before-dialog -> ' + answer;
    });
  }

  const openDialogButton = document.querySelector('[data-browser-lab-html-dialog-open]');
  if (openDialogButton) {
    const dialog = document.querySelector('[data-browser-lab-html-dialog]');
    const status = document.querySelector('[data-browser-lab-html-dialog-status]');
    const closeButton = dialog.querySelector('[data-browser-lab-html-dialog-close]');
    openDialogButton.addEventListener('click', () => {
      dialog.showModal();
      status.setAttribute('data-browser-lab-state', 'open');
      status.textContent = 'HTML dialog open';
    });
    closeButton.addEventListener('click', () => dialog.close('close-button'));
    dialog.addEventListener('close', () => {
      status.setAttribute('data-browser-lab-state', 'closed');
      status.setAttribute('data-browser-lab-return-value', dialog.returnValue);
      status.textContent = 'HTML dialog closed';
    });
  }

  const beforeUnload = document.querySelector('[data-browser-lab-beforeunload-checkbox]');
  if (beforeUnload) {
    const status = document.querySelector('[data-browser-lab-beforeunload-status]');
    const update = () => {
      const state = beforeUnload.checked ? 'armed' : 'disarmed';
      status.setAttribute('data-browser-lab-state', state);
      status.setAttribute('data-browser-lab-armed', String(beforeUnload.checked));
      status.textContent = 'beforeunload ' + state;
    };
    beforeUnload.addEventListener('change', update);
    window.addEventListener('beforeunload', (event) => {
      if (!beforeUnload.checked) return;
      event.preventDefault();
      event.returnValue = '${BEFORE_UNLOAD_MESSAGE}';
      return '${BEFORE_UNLOAD_MESSAGE}';
    });
    update();
  }
})();`;

export const interactionCase = {
  id: 'dialog-surfaces',
  kind: 'interaction',
  title: 'Dialog surfaces',
  entryPath: ENTRY_PATH,
  dialogs: [
    {
      trigger: 'browser-lab-dialog-surfaces-frame-alert',
      type: 'alert',
      message: FRAME_ALERT_MESSAGE,
    },
    {
      trigger: 'browser-lab-dialog-surfaces-frame-confirm',
      type: 'confirm',
      message: FRAME_CONFIRM_MESSAGE,
    },
    {
      trigger: 'browser-lab-dialog-surfaces-click-confirm',
      type: 'confirm',
      message: CLICK_CONFIRM_MESSAGE,
    },
    {
      trigger: 'browser-lab-dialog-surfaces-beforeunload-checkbox',
      type: 'beforeunload',
      message: BEFORE_UNLOAD_MESSAGE,
    },
  ],
  pages: [
    {
      path: ENTRY_PATH,
      controls: [
        'browser-lab-dialog-surfaces-main',
        'browser-lab-header-home',
        'browser-lab-dialog-surfaces-same-origin-frame',
        'browser-lab-dialog-surfaces-cross-site-frame',
        'browser-lab-dialog-surfaces-click-confirm',
        'browser-lab-dialog-surfaces-click-confirm-status',
        'browser-lab-dialog-surfaces-html-dialog-open',
        'browser-lab-dialog-surfaces-html-dialog',
        'browser-lab-dialog-surfaces-html-dialog-close',
        'browser-lab-dialog-surfaces-html-dialog-status',
        'browser-lab-dialog-surfaces-beforeunload-checkbox',
        'browser-lab-dialog-surfaces-beforeunload-status',
      ],
    },
    {
      path: FRAME_PATH,
      controls: [
        'browser-lab-dialog-surfaces-frame-main',
        'browser-lab-dialog-surfaces-frame-alert',
        'browser-lab-dialog-surfaces-frame-alert-status',
        'browser-lab-dialog-surfaces-frame-confirm',
        'browser-lab-dialog-surfaces-frame-confirm-status',
      ],
    },
  ],
};

function renderFramePage(kit) {
  const { html } = kit;
  return kit.renderInteractionPage({
    caseDef: interactionCase,
    suffix: 'Frame dialogs',
    header: null,
    scripts: [DIALOG_SCRIPT],
    styles: DIALOG_STYLES,
    main: html`<main
      data-testid="browser-lab-dialog-surfaces-frame-main"
      data-browser-lab-frame="dialog"
    >
      <h1>Frame dialogs</h1>
      <button
        type="button"
        data-testid="browser-lab-dialog-surfaces-frame-alert"
        data-browser-lab-frame-alert
      >
        Open frame alert
      </button>
      <output
        data-testid="browser-lab-dialog-surfaces-frame-alert-status"
        data-browser-lab-frame-alert-status
        data-browser-lab-state="ready"
        >Alert ready</output
      >
      <button
        type="button"
        data-testid="browser-lab-dialog-surfaces-frame-confirm"
        data-browser-lab-frame-confirm
      >
        Open frame confirm
      </button>
      <output
        data-testid="browser-lab-dialog-surfaces-frame-confirm-status"
        data-browser-lab-frame-confirm-status
        data-browser-lab-state="ready"
        data-browser-lab-answer=""
        >Confirm ready</output
      >
    </main>`,
  });
}

export function createRoutes(kit) {
  const { html } = kit;
  const renderEntry = (context) => {
    const paired = kit.pairedOriginFor(context);
    if (paired.error) {
      kit.sendRouteError(context, 500, paired.error);
      return null;
    }
    return kit.renderInteractionPage({
      caseDef: interactionCase,
      scripts: [DIALOG_SCRIPT],
      styles: DIALOG_STYLES,
      csp: { frameSources: ["'self'", paired.origin] },
      main: html`<main data-testid="browser-lab-dialog-surfaces-main">
        <h1>Dialog surfaces</h1>
        <p>
          Compare JavaScript dialogs from same-origin and out-of-process frames
          with other dialog surfaces.
        </p>
        <div class="dialog-grid">
          <section class="dialog-card">
            <h2>Same-origin frame</h2>
            <iframe
              title="Same-origin dialog frame"
              name="browser-lab-dialog-surfaces-same-origin-frame"
              src="${FRAME_PATH}"
              data-testid="browser-lab-dialog-surfaces-same-origin-frame"
            ></iframe>
          </section>
          <section class="dialog-card">
            <h2>Cross-site frame</h2>
            <iframe
              title="Cross-site dialog frame"
              name="browser-lab-dialog-surfaces-cross-site-frame"
              src="${paired.origin}${FRAME_PATH}"
              data-testid="browser-lab-dialog-surfaces-cross-site-frame"
            ></iframe>
          </section>
          <section class="dialog-card">
            <h2>Synchronous click dialog</h2>
            <button
              type="button"
              data-testid="browser-lab-dialog-surfaces-click-confirm"
              data-browser-lab-click-confirm
            >
              Change state, then confirm
            </button>
            <output
              data-testid="browser-lab-dialog-surfaces-click-confirm-status"
              data-browser-lab-click-confirm-status
              data-browser-lab-state="ready"
              data-browser-lab-before-dialog="not-run"
              data-browser-lab-answer=""
              >Ready</output
            >
          </section>
          <section class="dialog-card">
            <h2>HTML dialog element</h2>
            <button
              type="button"
              data-testid="browser-lab-dialog-surfaces-html-dialog-open"
              data-browser-lab-html-dialog-open
            >
              Open HTML dialog
            </button>
            <output
              data-testid="browser-lab-dialog-surfaces-html-dialog-status"
              data-browser-lab-html-dialog-status
              data-browser-lab-state="closed"
              >HTML dialog closed</output
            >
            <dialog
              data-testid="browser-lab-dialog-surfaces-html-dialog"
              data-browser-lab-html-dialog
            >
              <p>This is an HTML dialog.</p>
              <button
                type="button"
                data-testid="browser-lab-dialog-surfaces-html-dialog-close"
                data-browser-lab-html-dialog-close
              >
                Close HTML dialog
              </button>
            </dialog>
          </section>
          <section class="dialog-card">
            <h2>Before unload</h2>
            <label
              ><input
                type="checkbox"
                data-testid="browser-lab-dialog-surfaces-beforeunload-checkbox"
                data-browser-lab-beforeunload-checkbox
              />
              Arm the beforeunload prompt</label
            >
            <output
              data-testid="browser-lab-dialog-surfaces-beforeunload-status"
              data-browser-lab-beforeunload-status
              data-browser-lab-state="disarmed"
              data-browser-lab-armed="false"
              >beforeunload disarmed</output
            >
          </section>
        </div>
      </main>`,
    });
  };

  return [
    [
      ENTRY_PATH,
      {
        kind: 'html',
        methods: {
          GET: (context) => {
            const page = renderEntry(context);
            if (page) kit.sendPage(context.response, 200, page);
          },
        },
      },
    ],
    [FRAME_PATH, kit.pageRoute(() => renderFramePage(kit))],
  ];
}
