// Browser Lab interaction case `frames` (CAN-1570).

const ENTRY_PATH = '/browser-lab/frames';
const SAME_ORIGIN_FORM_PATH = `${ENTRY_PATH}/same-origin-form`;
const CROSS_SITE_FORM_PATH = `${ENTRY_PATH}/cross-site-form`;
const NESTED_ONE_PATH = `${ENTRY_PATH}/nested/1`;
const NESTED_TWO_PATH = `${ENTRY_PATH}/nested/2`;
const NESTED_THREE_PATH = `${ENTRY_PATH}/nested/3`;
const LATE_FRAME_PATH = `${ENTRY_PATH}/late`;
const SUBMIT_PATH = `${ENTRY_PATH}/submit`;

// Synthetic values only. Mirrors remain inside secret controls/ancestors rather
// than unrelated public text, so these exercise the intended B1 propagation.
// The mirror textarea is secret by its autocomplete token (main-frame rules
// apply to textareas in every scope); the note textarea is ordinary page data
// whose `canopy-visible-note-*` value must be readable.
function seededSecretMarkup(prefix, first, card) {
  const password = `canopy-seeded-secret-${first}`;
  const otp = `canopy-seeded-secret-${first + 1}`;
  const selection = `canopy-seeded-secret-${first + 2}`;
  const cardNumber = `canopy-seeded-secret-${card}`;
  return `<section id="${prefix}-ancestor" data-testid="${prefix}-ancestor" tabindex="0" data-browser-lab-secret-ancestor data-browser-lab-state="seeded">
    <label for="${prefix}-revealed">Saved password: ${password}
      <input id="${prefix}-revealed" data-testid="${prefix}-revealed" type="password" autocomplete="off" placeholder="Revealed password" value="${password}" data-browser-lab-seeded-password>
    </label>
    <label for="${prefix}-otp">Verification code</label>
    <input id="${prefix}-otp" data-testid="${prefix}-otp" type="text" autocomplete="one-time-code" placeholder="Verification code" value="${otp}">
    <label for="${prefix}-card">Card number</label>
    <input id="${prefix}-card" data-testid="${prefix}-card" type="text" autocomplete="cc-number" placeholder="Card number" value="${cardNumber}">
    <label for="${prefix}-select">Saved card</label>
    <select id="${prefix}-select" data-testid="${prefix}-select" autocomplete="cc-number">
      <option id="${prefix}-option" data-testid="${prefix}-option" value="${selection}" selected>${selection}</option>
    </select>
    <img id="${prefix}-image" data-testid="${prefix}-image" alt="Page model fixture image" width="32" height="32" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
    <label for="${prefix}-mirror">Password mirror</label>
    <textarea id="${prefix}-mirror" data-testid="${prefix}-mirror" autocomplete="current-password">${password}</textarea>
    <label for="${prefix}-plain">Visible input</label>
    <input id="${prefix}-plain" data-testid="${prefix}-plain" type="text" value="canopy-visible-input-${first}">
    <label for="${prefix}-note">Visible note</label>
    <textarea id="${prefix}-note" data-testid="${prefix}-note">canopy-visible-note-${first}</textarea>
  </section>`;
}

const FRAME_STYLES = `
  .frame-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
  .frame-card { min-width: 0; padding: 12px; border: 1px solid #b7bec7; border-radius: 6px; background: #fff; }
  .frame-card iframe { display: block; width: 100%; height: 190px; border: 1px solid #8993a0; background: #fff; }
  .overlay-wrap { position: relative; height: 190px; }
  .overlay-wrap iframe { height: 100%; }
  .frame-overlay { position: absolute; inset: 0; z-index: 1; display: grid; place-items: center; background: rgb(32 54 79 / 88%); color: #fff; }
  .frame-overlay[hidden] { display: none; }
  .frame-overlay button { margin: 0; }
  output { display: block; margin-top: 8px; }
`;

const FRAME_SCRIPT = `(() => {
  'use strict';

  // This runs in the initial inline script, before any model observation. No
  // timer or user action may be needed to reveal the original password.
  document.querySelectorAll('[data-browser-lab-seeded-password]').forEach((input) => {
    input.value = input.defaultValue;
    input.type = 'text';
    input.closest('[data-browser-lab-secret-ancestor]').setAttribute('data-browser-lab-state', 'revealed');
  });

  const form = document.querySelector('[data-browser-lab-frame-form]');
  if (form) {
    const name = form.querySelector('[name="name"]');
    const delivery = form.querySelector('[name="delivery"]');
    const consent = form.querySelector('[name="consent"]');
    const status = document.querySelector('[data-browser-lab-form-status]');
    const update = () => {
      status.setAttribute('data-browser-lab-state', 'ready');
      status.setAttribute('data-browser-lab-value', name.value);
      status.setAttribute('data-browser-lab-selection', delivery.value);
      status.setAttribute('data-browser-lab-checked', String(consent.checked));
      status.textContent = 'Name: ' + name.value + '; delivery: ' + delivery.value + '; consent: ' + String(consent.checked);
    };
    form.addEventListener('input', update);
    form.addEventListener('change', update);
    update();
  }

  const collisionButton = document.querySelector('[data-browser-lab-collision-button]');
  if (collisionButton) {
    const collisionStatus = document.querySelector('[data-browser-lab-collision-status]');
    collisionButton.addEventListener('click', () => {
      const count = Number(collisionButton.getAttribute('data-browser-lab-click-count')) + 1;
      collisionButton.setAttribute('data-browser-lab-click-count', String(count));
      collisionStatus.setAttribute('data-browser-lab-click-count', String(count));
      collisionStatus.textContent = 'Cross-site frame clicks: ' + String(count);
    });
  }

  const parentCollisionButton = document.querySelector('[data-browser-lab-parent-collision-button]');
  if (parentCollisionButton) {
    const parentStatus = document.querySelector('[data-browser-lab-parent-collision-status]');
    parentCollisionButton.addEventListener('click', () => {
      const count = Number(parentCollisionButton.getAttribute('data-browser-lab-click-count')) + 1;
      parentCollisionButton.setAttribute('data-browser-lab-click-count', String(count));
      parentStatus.setAttribute('data-browser-lab-click-count', String(count));
      parentStatus.textContent = 'Main document clicks: ' + String(count);
    });
  }

  const lateFrameTarget = document.querySelector('[data-browser-lab-late-frame-src]');
  if (lateFrameTarget) {
    window.setTimeout(() => {
      const frame = document.createElement('iframe');
      frame.title = 'Frame added after page load';
      frame.name = 'browser-lab-frames-late-frame';
      frame.setAttribute('data-testid', 'browser-lab-frames-late-frame');
      frame.src = lateFrameTarget.getAttribute('data-browser-lab-late-frame-src');
      lateFrameTarget.appendChild(frame);
    }, 500);
  }

  const overlayButton = document.querySelector('[data-browser-lab-overlay-dismiss]');
  if (overlayButton) {
    const overlay = document.querySelector('[data-browser-lab-overlay]');
    const overlayStatus = document.querySelector('[data-browser-lab-overlay-status]');
    overlayButton.addEventListener('click', () => {
      overlay.hidden = true;
      overlay.setAttribute('data-browser-lab-state', 'dismissed');
      overlayStatus.setAttribute('data-browser-lab-state', 'dismissed');
      overlayStatus.textContent = 'Overlay dismissed';
    });
  }

  const counterButton = document.querySelector('[data-browser-lab-counter-button]');
  if (counterButton) {
    const counter = document.querySelector('[data-browser-lab-counter-status]');
    counterButton.addEventListener('click', () => {
      const count = Number(counterButton.getAttribute('data-browser-lab-click-count')) + 1;
      counterButton.setAttribute('data-browser-lab-click-count', String(count));
      counter.setAttribute('data-browser-lab-click-count', String(count));
      counter.textContent = 'Button clicks: ' + String(count);
    });
  }
})();`;

function renderInteractionPage(
  kit,
  {
    suffix,
    main,
    scripts = [FRAME_SCRIPT],
    styles = FRAME_STYLES,
    csp = {},
    header,
  },
) {
  return kit.renderInteractionPage({
    caseDef: interactionCase,
    ...(suffix ? { suffix } : {}),
    main,
    ...(header === null ? { header: null } : {}),
    scripts,
    styles,
    csp,
  });
}

function renderFormPage(kit, { marker, isCrossSite }) {
  const { html } = kit;
  return renderInteractionPage(kit, {
    suffix: isCrossSite ? 'Cross-site form' : 'Same-origin form',
    header: null,
    main: html`<main
      data-testid="browser-lab-frames-${marker}-form-main"
      data-browser-lab-frame="${marker}"
    >
      <h1>${isCrossSite ? 'Cross-site' : 'Same-origin'} form</h1>
      <form
        method="post"
        action="${SUBMIT_PATH}"
        data-browser-lab-frame-form
        data-testid="browser-lab-frames-${marker}-form"
      >
        <label for="frame-name">Name</label>
        <input
          id="frame-name"
          type="text"
          name="name"
          data-testid="browser-lab-frames-${marker}-name"
        />
        <label for="frame-delivery">Delivery</label>
        <select
          id="frame-delivery"
          name="delivery"
          data-testid="browser-lab-frames-${marker}-delivery"
        >
          <option value="standard">Standard</option>
          <option value="express">Express</option>
        </select>
        <label
          ><input
            type="checkbox"
            name="consent"
            value="yes"
            data-testid="browser-lab-frames-${marker}-consent"
          />
          Accept the frame terms</label
        >
        <button type="submit" data-testid="browser-lab-frames-${marker}-submit">
          Submit form
        </button>
      </form>
      <output
        data-testid="browser-lab-frames-${marker}-status"
        data-browser-lab-form-status
        data-browser-lab-state="ready"
        data-browser-lab-value=""
        data-browser-lab-selection="standard"
        data-browser-lab-checked="false"
        >Form ready</output
      >
      ${kit.trusted(
        seededSecretMarkup(
          `browser-lab-frames-${marker}-secret`,
          isCrossSite ? 4 : 1,
          isCrossSite ? 14 : 13,
        ),
      )}
      ${!isCrossSite
        ? html`<button
              type="button"
              data-testid="browser-lab-frames-same-origin-counter-button"
              data-browser-lab-counter-button
              data-browser-lab-click-count="0"
            >
              Count a same-origin click
            </button>
            <output
              data-testid="browser-lab-frames-same-origin-counter-status"
              data-browser-lab-counter-status
              data-browser-lab-click-count="0"
              >Button clicks: 0</output
            >`
        : ''}
      ${isCrossSite
        ? html`<section aria-label="Process collision control">
            <button
              id="collision-button"
              type="button"
              data-testid="browser-lab-frames-collision-button"
              data-browser-lab-collision-button
              data-browser-lab-click-count="0"
            >
              Cross-site collision button
            </button>
            <output
              data-testid="browser-lab-frames-cross-site-collision-status"
              data-browser-lab-collision-status
              data-browser-lab-state="ready"
              data-browser-lab-click-count="0"
              >Cross-site frame clicks: 0</output
            >
          </section>`
        : ''}
    </main>`,
  });
}

function renderNestedPage(kit, depth) {
  const { html } = kit;
  const childPath = `/browser-lab/frames/nested/${depth + 1}`;
  return renderInteractionPage(kit, {
    suffix: `Nested frame ${depth}`,
    header: null,
    csp: depth < 3 ? { frameSources: ["'self'"] } : {},
    main: html`<main
      data-testid="browser-lab-frames-nested-${depth}-main"
      data-browser-lab-frame="nested-${depth}"
    >
      <h1>Nested frame ${depth}</h1>
      ${depth < 3
        ? html`<iframe
            title="Nested frame ${depth + 1}"
            name="browser-lab-frames-nested-${depth + 1}-frame"
            src="${childPath}"
            data-testid="browser-lab-frames-nested-${depth}-child-frame"
          ></iframe>`
        : html`<button
              type="button"
              data-testid="browser-lab-frames-nested-counter-button"
              data-browser-lab-counter-button
              data-browser-lab-click-count="0"
            >
              Count a click
            </button>
            <output
              data-testid="browser-lab-frames-nested-counter-status"
              data-browser-lab-counter-status
              data-browser-lab-state="ready"
              data-browser-lab-click-count="0"
              >Button clicks: 0</output
            >`}
    </main>`,
  });
}

function renderLatePage(kit) {
  const { html } = kit;
  return renderInteractionPage(kit, {
    suffix: 'Late frame',
    header: null,
    main: html`<main
      data-testid="browser-lab-frames-late-main"
      data-browser-lab-frame="late"
    >
      <h1>Late frame</h1>
      <p data-testid="browser-lab-frames-late-note">
        Late-frame-only ready text
      </p>
      <button
        type="button"
        data-testid="browser-lab-frames-late-button"
        data-browser-lab-counter-button
        data-browser-lab-click-count="0"
      >
        Count a click
      </button>
      <output
        data-testid="browser-lab-frames-late-status"
        data-browser-lab-counter-status
        data-browser-lab-state="ready"
        data-browser-lab-click-count="0"
        >Button clicks: 0</output
      >
    </main>`,
  });
}

export const interactionCase = {
  id: 'frames',
  kind: 'interaction',
  title: 'Frames',
  entryPath: ENTRY_PATH,
  submitPath: SUBMIT_PATH,
  endpoints: [SUBMIT_PATH],
  pages: [
    {
      path: ENTRY_PATH,
      controls: [
        'browser-lab-frames-main',
        'browser-lab-header-home',
        'browser-lab-frames-same-origin-frame',
        'browser-lab-frames-cross-site-frame',
        'browser-lab-frames-nested-frame',
        'browser-lab-frames-overlay-frame',
        'browser-lab-frames-overlay',
        'browser-lab-frames-overlay-dismiss',
        'browser-lab-frames-overlay-status',
        'browser-lab-frames-collision-button',
        'browser-lab-frames-main-collision-status',
      ],
      clientControls: ['browser-lab-frames-late-frame'],
    },
    {
      path: SAME_ORIGIN_FORM_PATH,
      controls: [
        'browser-lab-frames-same-origin-form-main',
        'browser-lab-frames-same-origin-form',
        'browser-lab-frames-same-origin-name',
        'browser-lab-frames-same-origin-delivery',
        'browser-lab-frames-same-origin-consent',
        'browser-lab-frames-same-origin-submit',
        'browser-lab-frames-same-origin-status',
        'browser-lab-frames-same-origin-counter-button',
        'browser-lab-frames-same-origin-counter-status',
        'browser-lab-frames-same-origin-secret-ancestor',
        'browser-lab-frames-same-origin-secret-revealed',
        'browser-lab-frames-same-origin-secret-otp',
        'browser-lab-frames-same-origin-secret-card',
        'browser-lab-frames-same-origin-secret-select',
        'browser-lab-frames-same-origin-secret-option',
        'browser-lab-frames-same-origin-secret-mirror',
        'browser-lab-frames-same-origin-secret-image',
        'browser-lab-frames-same-origin-secret-plain',
        'browser-lab-frames-same-origin-secret-note',
      ],
    },
    {
      path: CROSS_SITE_FORM_PATH,
      controls: [
        'browser-lab-frames-cross-site-form-main',
        'browser-lab-frames-cross-site-form',
        'browser-lab-frames-cross-site-name',
        'browser-lab-frames-cross-site-delivery',
        'browser-lab-frames-cross-site-consent',
        'browser-lab-frames-cross-site-submit',
        'browser-lab-frames-cross-site-status',
        'browser-lab-frames-cross-site-secret-ancestor',
        'browser-lab-frames-cross-site-secret-revealed',
        'browser-lab-frames-cross-site-secret-otp',
        'browser-lab-frames-cross-site-secret-card',
        'browser-lab-frames-cross-site-secret-select',
        'browser-lab-frames-cross-site-secret-option',
        'browser-lab-frames-cross-site-secret-mirror',
        'browser-lab-frames-cross-site-secret-image',
        'browser-lab-frames-cross-site-secret-plain',
        'browser-lab-frames-cross-site-secret-note',
        'browser-lab-frames-collision-button',
        'browser-lab-frames-cross-site-collision-status',
      ],
    },
    {
      path: NESTED_ONE_PATH,
      controls: [
        'browser-lab-frames-nested-1-main',
        'browser-lab-frames-nested-1-child-frame',
      ],
    },
    {
      path: NESTED_TWO_PATH,
      controls: [
        'browser-lab-frames-nested-2-main',
        'browser-lab-frames-nested-2-child-frame',
      ],
    },
    {
      path: NESTED_THREE_PATH,
      controls: [
        'browser-lab-frames-nested-3-main',
        'browser-lab-frames-nested-counter-button',
        'browser-lab-frames-nested-counter-status',
      ],
    },
    {
      path: LATE_FRAME_PATH,
      controls: [
        'browser-lab-frames-late-main',
        'browser-lab-frames-late-note',
        'browser-lab-frames-late-button',
        'browser-lab-frames-late-status',
      ],
    },
  ],
};

export function createRoutes(kit) {
  const { html } = kit;
  const renderEntry = (context) => {
    const paired = kit.pairedOriginFor(context);
    if (paired.error) {
      kit.sendRouteError(context, 500, paired.error);
      return null;
    }
    return renderInteractionPage(kit, {
      csp: { frameSources: ["'self'", paired.origin] },
      main: html`<main
        data-testid="browser-lab-frames-main"
        data-browser-lab-frame="main"
      >
        <h1>Frames</h1>
        <p>
          Interact with same-origin, cross-site, nested, late, and covered
          frames.
        </p>
        <div class="frame-grid">
          <section class="frame-card">
            <h2>Same-origin form</h2>
            <iframe
              title="Same-origin form"
              name="browser-lab-frames-same-origin-frame"
              src="${SAME_ORIGIN_FORM_PATH}"
              data-testid="browser-lab-frames-same-origin-frame"
            ></iframe>
          </section>
          <section class="frame-card">
            <h2>Cross-site form</h2>
            <iframe
              title="Cross-site form"
              name="browser-lab-frames-cross-site-frame"
              src="${paired.origin}${CROSS_SITE_FORM_PATH}"
              data-testid="browser-lab-frames-cross-site-frame"
            ></iframe>
          </section>
          <section class="frame-card">
            <h2>Three levels deep</h2>
            <iframe
              title="Nested frame 1"
              name="browser-lab-frames-nested-frame"
              src="${NESTED_ONE_PATH}"
              data-testid="browser-lab-frames-nested-frame"
            ></iframe>
          </section>
          <section class="frame-card">
            <h2>Covered frame</h2>
            <div class="overlay-wrap">
              <iframe
                title="Frame covered by an overlay"
                name="browser-lab-frames-overlay-frame"
                src="${SAME_ORIGIN_FORM_PATH}"
                data-testid="browser-lab-frames-overlay-frame"
              ></iframe>
              <div
                class="frame-overlay"
                data-testid="browser-lab-frames-overlay"
                data-browser-lab-state="covered"
                data-browser-lab-overlay
              >
                <div>
                  <p>This overlay covers the entire frame.</p>
                  <button
                    type="button"
                    data-testid="browser-lab-frames-overlay-dismiss"
                    data-browser-lab-overlay-dismiss
                  >
                    Dismiss overlay
                  </button>
                </div>
              </div>
            </div>
            <output
              data-testid="browser-lab-frames-overlay-status"
              data-browser-lab-state="covered"
              data-browser-lab-overlay-status
              >Frame covered</output
            >
          </section>
          <section class="frame-card">
            <h2>Parent-process ID collision</h2>
            <button
              id="collision-button"
              type="button"
              data-testid="browser-lab-frames-collision-button"
              data-browser-lab-parent-collision-button
              data-browser-lab-click-count="0"
            >
              Main document collision button
            </button>
            <output
              data-testid="browser-lab-frames-main-collision-status"
              data-browser-lab-state="ready"
              data-browser-lab-click-count="0"
              data-browser-lab-parent-collision-status
              >Main document clicks: 0</output
            >
          </section>
          <section
            class="frame-card"
            data-browser-lab-late-frame-src="${LATE_FRAME_PATH}"
          >
            <h2>Late frame</h2>
            <p>The frame is inserted about 500 ms after page load.</p>
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
    [
      SAME_ORIGIN_FORM_PATH,
      kit.pageRoute(() =>
        renderFormPage(kit, { marker: 'same-origin', isCrossSite: false }),
      ),
    ],
    [
      CROSS_SITE_FORM_PATH,
      kit.pageRoute(() =>
        renderFormPage(kit, { marker: 'cross-site', isCrossSite: true }),
      ),
    ],
    [NESTED_ONE_PATH, kit.pageRoute(() => renderNestedPage(kit, 1))],
    [NESTED_TWO_PATH, kit.pageRoute(() => renderNestedPage(kit, 2))],
    [NESTED_THREE_PATH, kit.pageRoute(() => renderNestedPage(kit, 3))],
    [LATE_FRAME_PATH, kit.pageRoute(() => renderLatePage(kit))],
    [SUBMIT_PATH, kit.echoSubmitRoute(interactionCase)],
  ];
}
