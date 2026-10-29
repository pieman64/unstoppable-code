// Browser Lab interaction case `shadow` (CAN-1570).

const ENTRY_PATH = '/browser-lab/shadow';

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

const SHADOW_STYLES = `
  .shadow-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
  .shadow-card { min-width: 0; padding: 12px; border: 1px solid #b7bec7; border-radius: 6px; background: #fff; }
  .shadow-card output { display: block; margin-top: 8px; }
  [data-testid="browser-lab-shadow-open-host"] { display: block; }
`;

const SHADOW_SCRIPT = `(() => {
  'use strict';

  const revealSeededPasswords = (root) => {
    // This runs in the initial inline script, before any model observation. No
    // timer or user action may be needed to reveal the original password.
    root.querySelectorAll('[data-browser-lab-seeded-password]').forEach((input) => {
      input.value = input.defaultValue;
      input.type = 'text';
      input.closest('[data-browser-lab-secret-ancestor]').setAttribute('data-browser-lab-state', 'revealed');
    });
  };

  const openHost = document.querySelector('[data-testid="browser-lab-shadow-open-host"]');
  const openRoot = openHost.shadowRoot;
  const openButton = openRoot.querySelector('[data-browser-lab-open-button]');
  const clickStatus = openRoot.querySelector('[data-browser-lab-click-status]');
  openButton.addEventListener('click', () => {
    const count = Number(clickStatus.getAttribute('data-browser-lab-click-count')) + 1;
    clickStatus.setAttribute('data-browser-lab-state', 'clicked');
    clickStatus.setAttribute('data-browser-lab-click-count', String(count));
    clickStatus.textContent = 'Open-root clicks: ' + String(count);
  });

  const textInput = openRoot.querySelector('[data-browser-lab-open-input]');
  const textStatus = openRoot.querySelector('[data-browser-lab-input-status]');
  textInput.addEventListener('input', () => {
    textStatus.setAttribute('data-browser-lab-state', 'edited');
    textStatus.setAttribute('data-browser-lab-value', textInput.value);
    textStatus.textContent = 'Input value: ' + textInput.value;
  });

  const selectTrigger = openRoot.querySelector('[data-browser-lab-select-trigger]');
  const listbox = openRoot.querySelector('[data-browser-lab-listbox]');
  const selectionStatus = openRoot.querySelector('[data-browser-lab-selection-status]');
  selectTrigger.addEventListener('click', () => {
    const expanded = selectTrigger.getAttribute('aria-expanded') === 'true';
    selectTrigger.setAttribute('aria-expanded', String(!expanded));
    listbox.hidden = expanded;
    listbox.setAttribute('data-browser-lab-state', expanded ? 'closed' : 'open');
  });
  listbox.querySelectorAll('[role="option"]').forEach((option) => {
    option.addEventListener('click', () => {
      listbox.querySelectorAll('[role="option"]').forEach((candidate) => {
        candidate.setAttribute('aria-selected', String(candidate === option));
      });
      const value = option.getAttribute('data-browser-lab-value');
      selectTrigger.textContent = option.textContent;
      selectTrigger.setAttribute('aria-expanded', 'false');
      listbox.hidden = true;
      listbox.setAttribute('data-browser-lab-state', 'closed');
      selectionStatus.setAttribute('data-browser-lab-state', 'selected');
      selectionStatus.setAttribute('data-browser-lab-selection', value);
      selectionStatus.textContent = 'Selected: ' + option.textContent;
    });
  });

  const nestedOuterRoot = document.querySelector('[data-testid="browser-lab-shadow-nested-host"]').shadowRoot;
  const nestedInnerRoot = nestedOuterRoot.querySelector('[data-browser-lab-nested-inner-host]').shadowRoot;
  const nestedButton = nestedInnerRoot.querySelector('[data-browser-lab-nested-button]');
  const nestedStatus = nestedInnerRoot.querySelector('[data-browser-lab-nested-status]');
  nestedButton.addEventListener('click', () => {
    const count = Number(nestedStatus.getAttribute('data-browser-lab-click-count')) + 1;
    nestedStatus.setAttribute('data-browser-lab-state', 'clicked');
    nestedStatus.setAttribute('data-browser-lab-click-count', String(count));
    nestedStatus.textContent = 'Nested-root clicks: ' + String(count);
  });

  const slotHost = document.querySelector('[data-testid="browser-lab-shadow-slot-host"]');
  const slottedButton = slotHost.querySelector('[data-testid="browser-lab-shadow-slotted-button"]');
  const slottedStatus = slotHost.shadowRoot.querySelector('[data-browser-lab-slotted-status]');
  slottedButton.addEventListener('click', () => {
    const count = Number(slottedStatus.getAttribute('data-browser-lab-click-count')) + 1;
    slottedStatus.setAttribute('data-browser-lab-state', 'clicked');
    slottedStatus.setAttribute('data-browser-lab-click-count', String(count));
    slottedStatus.textContent = 'Slotted clicks: ' + String(count);
  });

  const closedHost = document.querySelector('[data-testid="browser-lab-shadow-closed-host"]');
  const closedRoot = closedHost.attachShadow({ mode: 'closed' });
  closedRoot.innerHTML = '<section><button type="button">Closed-root action</button><label>Private input <input type="text"></label></section>' + ${JSON.stringify(seededSecretMarkup('browser-lab-shadow-closed-secret', 10, 16))};
  closedRoot.querySelector('button').addEventListener('click', () => {
    const count = Number(closedHost.getAttribute('data-browser-lab-click-count')) + 1;
    closedHost.setAttribute('data-browser-lab-click-count', String(count));
  });

  const scriptedHost = document.querySelector('[data-testid="browser-lab-shadow-scripted-host"]');
  const scriptedRoot = scriptedHost.attachShadow({ mode: 'open' });
  scriptedRoot.innerHTML = '<button type="button" data-testid="browser-lab-shadow-scripted-button">Scripted-root action</button><output data-testid="browser-lab-shadow-scripted-click-status" data-browser-lab-click-count="0">Scripted clicks: 0</output><label for="scripted-note">Scripted note</label><input id="scripted-note" type="text" data-testid="browser-lab-shadow-scripted-input"><output data-testid="browser-lab-shadow-scripted-input-status" data-browser-lab-value="">Input is empty</output>' + ${JSON.stringify(seededSecretMarkup('browser-lab-shadow-scripted-secret', 17, 20))};
  const scriptedButton = scriptedRoot.querySelector('[data-testid="browser-lab-shadow-scripted-button"]');
  const scriptedClickStatus = scriptedRoot.querySelector('[data-testid="browser-lab-shadow-scripted-click-status"]');
  scriptedButton.addEventListener('click', () => {
    const count = Number(scriptedClickStatus.getAttribute('data-browser-lab-click-count')) + 1;
    scriptedClickStatus.setAttribute('data-browser-lab-click-count', String(count));
    scriptedClickStatus.textContent = 'Scripted clicks: ' + String(count);
  });
  const scriptedInput = scriptedRoot.querySelector('[data-testid="browser-lab-shadow-scripted-input"]');
  const scriptedInputStatus = scriptedRoot.querySelector('[data-testid="browser-lab-shadow-scripted-input-status"]');
  scriptedInput.addEventListener('input', () => {
    scriptedInputStatus.setAttribute('data-browser-lab-value', scriptedInput.value);
    scriptedInputStatus.textContent = 'Input value: ' + scriptedInput.value;
  });
  revealSeededPasswords(scriptedRoot);
  revealSeededPasswords(openRoot);
  revealSeededPasswords(closedRoot);

  const labelledRoot = document.querySelector('[data-testid="browser-lab-shadow-labelled-host"]').shadowRoot;
  const labelledInput = labelledRoot.querySelector('[data-browser-lab-labelled-input]');
  const labelledStatus = labelledRoot.querySelector('[data-browser-lab-labelled-status]');
  labelledInput.addEventListener('input', () => {
    labelledStatus.setAttribute('data-browser-lab-state', 'edited');
    labelledStatus.setAttribute('data-browser-lab-value', labelledInput.value);
    labelledStatus.textContent = 'Labelled value: ' + labelledInput.value;
  });
})();`;

export const interactionCase = {
  id: 'shadow',
  kind: 'interaction',
  title: 'Shadow DOM',
  entryPath: ENTRY_PATH,
  pages: [
    {
      path: ENTRY_PATH,
      controls: [
        'browser-lab-shadow-main',
        'browser-lab-header-home',
        'browser-lab-shadow-open-host',
        'browser-lab-shadow-open-secret-ancestor',
        'browser-lab-shadow-open-secret-revealed',
        'browser-lab-shadow-open-secret-otp',
        'browser-lab-shadow-open-secret-card',
        'browser-lab-shadow-open-secret-select',
        'browser-lab-shadow-open-secret-option',
        'browser-lab-shadow-open-secret-mirror',
        'browser-lab-shadow-open-secret-image',
        'browser-lab-shadow-open-secret-plain',
        'browser-lab-shadow-open-secret-note',
        'browser-lab-shadow-scripted-host',
        'browser-lab-shadow-open-button',
        'browser-lab-shadow-open-click-status',
        'browser-lab-shadow-open-input',
        'browser-lab-shadow-input-status',
        'browser-lab-shadow-select-trigger',
        'browser-lab-shadow-listbox',
        'browser-lab-shadow-option-amber',
        'browser-lab-shadow-option-blue',
        'browser-lab-shadow-option-violet',
        'browser-lab-shadow-selection-status',
        'browser-lab-shadow-nested-host',
        'browser-lab-shadow-nested-inner-host',
        'browser-lab-shadow-nested-button',
        'browser-lab-shadow-nested-status',
        'browser-lab-shadow-slot-host',
        'browser-lab-shadow-slotted-button',
        'browser-lab-shadow-slotted-status',
        'browser-lab-shadow-closed-host',
        'browser-lab-shadow-labelled-host',
        'browser-lab-shadow-labelled-input',
        'browser-lab-shadow-labelled-status',
      ],
      clientControls: [
        'browser-lab-shadow-closed-secret-ancestor',
        'browser-lab-shadow-closed-secret-revealed',
        'browser-lab-shadow-closed-secret-otp',
        'browser-lab-shadow-closed-secret-card',
        'browser-lab-shadow-closed-secret-select',
        'browser-lab-shadow-closed-secret-option',
        'browser-lab-shadow-closed-secret-mirror',
        'browser-lab-shadow-closed-secret-image',
        'browser-lab-shadow-closed-secret-plain',
        'browser-lab-shadow-closed-secret-note',
        'browser-lab-shadow-scripted-button',
        'browser-lab-shadow-scripted-click-status',
        'browser-lab-shadow-scripted-input',
        'browser-lab-shadow-scripted-input-status',
        'browser-lab-shadow-scripted-secret-ancestor',
        'browser-lab-shadow-scripted-secret-revealed',
        'browser-lab-shadow-scripted-secret-otp',
        'browser-lab-shadow-scripted-secret-card',
        'browser-lab-shadow-scripted-secret-select',
        'browser-lab-shadow-scripted-secret-option',
        'browser-lab-shadow-scripted-secret-mirror',
        'browser-lab-shadow-scripted-secret-image',
        'browser-lab-shadow-scripted-secret-plain',
        'browser-lab-shadow-scripted-secret-note',
      ],
    },
  ],
};

export function createRoutes(kit) {
  const { html } = kit;
  const page = kit.renderInteractionPage({
    caseDef: interactionCase,
    scripts: [SHADOW_SCRIPT],
    styles: SHADOW_STYLES,
    main: html`<main data-testid="browser-lab-shadow-main">
      <h1>Shadow DOM interactions</h1>
      <p>
        Open and closed roots, a nested root, slotted content, and an accessible
        field.
      </p>
      <div class="shadow-grid">
        <section class="shadow-card">
          <h2>Open root</h2>
          <section data-testid="browser-lab-shadow-open-host">
            <template shadowrootmode="open">
              <button
                type="button"
                data-testid="browser-lab-shadow-open-button"
                data-browser-lab-open-button
              >
                Open-root action
              </button>
              <output
                data-testid="browser-lab-shadow-open-click-status"
                data-browser-lab-click-status
                data-browser-lab-state="ready"
                data-browser-lab-click-count="0"
                >Open-root clicks: 0</output
              >
              <label for="open-note">Note</label>
              <input
                id="open-note"
                type="text"
                data-testid="browser-lab-shadow-open-input"
                data-browser-lab-open-input
              />
              <output
                data-testid="browser-lab-shadow-input-status"
                data-browser-lab-input-status
                data-browser-lab-state="ready"
                data-browser-lab-value=""
                >Input is empty</output
              >
              <button
                type="button"
                role="combobox"
                aria-haspopup="listbox"
                aria-expanded="false"
                data-testid="browser-lab-shadow-select-trigger"
                data-browser-lab-select-trigger
              >
                Choose a color
              </button>
              <div
                role="listbox"
                hidden
                data-testid="browser-lab-shadow-listbox"
                data-browser-lab-listbox
                data-browser-lab-state="closed"
              >
                <button
                  type="button"
                  role="option"
                  aria-selected="false"
                  data-testid="browser-lab-shadow-option-amber"
                  data-browser-lab-value="amber"
                >
                  Amber
                </button>
                <button
                  type="button"
                  role="option"
                  aria-selected="false"
                  data-testid="browser-lab-shadow-option-blue"
                  data-browser-lab-value="blue"
                >
                  Blue
                </button>
                <button
                  type="button"
                  role="option"
                  aria-selected="false"
                  data-testid="browser-lab-shadow-option-violet"
                  data-browser-lab-value="violet"
                >
                  Violet
                </button>
              </div>
              <output
                data-testid="browser-lab-shadow-selection-status"
                data-browser-lab-selection-status
                data-browser-lab-state="ready"
                data-browser-lab-selection=""
                >No color selected</output
              >
              ${kit.trusted(
                seededSecretMarkup('browser-lab-shadow-open-secret', 7, 15),
              )}
            </template>
          </section>
        </section>
        <section class="shadow-card">
          <h2>Nested open roots</h2>
          <section data-testid="browser-lab-shadow-nested-host">
            <template shadowrootmode="open">
              <p>Outer open root</p>
              <section
                data-browser-lab-nested-inner-host
                data-testid="browser-lab-shadow-nested-inner-host"
              >
                <template shadowrootmode="open">
                  <button
                    type="button"
                    data-testid="browser-lab-shadow-nested-button"
                    data-browser-lab-nested-button
                  >
                    Two levels deep
                  </button>
                  <output
                    data-testid="browser-lab-shadow-nested-status"
                    data-browser-lab-nested-status
                    data-browser-lab-state="ready"
                    data-browser-lab-click-count="0"
                    >Nested-root clicks: 0</output
                  >
                </template>
              </section>
            </template>
          </section>
        </section>
        <section class="shadow-card">
          <h2>Slotted button</h2>
          <section data-testid="browser-lab-shadow-slot-host">
            <template shadowrootmode="open">
              <p>Button below is supplied by the host.</p>
              <slot name="action"></slot>
              <output
                data-testid="browser-lab-shadow-slotted-status"
                data-browser-lab-slotted-status
                data-browser-lab-state="ready"
                data-browser-lab-click-count="0"
                >Slotted clicks: 0</output
              >
            </template>
            <button
              type="button"
              slot="action"
              data-testid="browser-lab-shadow-slotted-button"
            >
              Slotted action
            </button>
          </section>
        </section>
        <section class="shadow-card">
          <h2>Closed root</h2>
          <p>
            Only the host and its click count are observable outside this
            component.
          </p>
          <div
            data-testid="browser-lab-shadow-closed-host"
            data-browser-lab-click-count="0"
          ></div>
        </section>
        <section class="shadow-card">
          <h2>Script-created open root</h2>
          <div data-testid="browser-lab-shadow-scripted-host"></div>
        </section>
        <section class="shadow-card">
          <h2>Labelled field</h2>
          <section data-testid="browser-lab-shadow-labelled-host">
            <template shadowrootmode="open">
              <label id="account-label" for="account-input"
                >Account reference</label
              >
              <input
                id="account-input"
                type="text"
                aria-labelledby="account-label"
                data-testid="browser-lab-shadow-labelled-input"
                data-browser-lab-labelled-input
              />
              <output
                data-testid="browser-lab-shadow-labelled-status"
                data-browser-lab-labelled-status
                data-browser-lab-state="ready"
                data-browser-lab-value=""
                >Enter an account reference</output
              >
            </template>
          </section>
        </section>
      </div>
    </main>`,
  });

  return [[ENTRY_PATH, kit.pageRoute(() => page)]];
}
