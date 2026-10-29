// Browser Lab interaction case `controls` (CAN-1570).

const ENTRY_PATH = '/browser-lab/controls';
const SUBMIT_PATH = '/browser-lab/controls/submit';
const ENTER_SUBMIT_PATH = '/browser-lab/controls/enter-submit';

const PAGE_CONTROLS = [
  'browser-lab-controls-main',
  'browser-lab-header-home',
  'browser-lab-controls-echo-form',
  'browser-lab-controls-checkbox-native',
  'browser-lab-controls-checkbox-native-status',
  'browser-lab-controls-checkbox-styled',
  'browser-lab-controls-checkbox-styled-label',
  'browser-lab-controls-checkbox-styled-status',
  'browser-lab-controls-checkbox-aria',
  'browser-lab-controls-checkbox-aria-value',
  'browser-lab-controls-checkbox-aria-status',
  'browser-lab-controls-switch-aria',
  'browser-lab-controls-switch-value',
  'browser-lab-controls-switch-status',
  'browser-lab-controls-radio-sibling-one',
  'browser-lab-controls-radio-sibling-one-label',
  'browser-lab-controls-radio-sibling-two',
  'browser-lab-controls-radio-sibling-two-label',
  'browser-lab-controls-radio-wrapping-one',
  'browser-lab-controls-radio-wrapping-two',
  'browser-lab-controls-radio-custom-one',
  'browser-lab-controls-radio-custom-one-label',
  'browser-lab-controls-radio-custom-two',
  'browser-lab-controls-radio-custom-two-label',
  'browser-lab-controls-radio-status',
  'browser-lab-controls-select-single',
  'browser-lab-controls-select-single-status',
  'browser-lab-controls-select-multiple',
  'browser-lab-controls-select-multiple-status',
  'browser-lab-controls-select-optgroup',
  'browser-lab-controls-select-optgroup-status',
  'browser-lab-controls-select-disabled',
  'browser-lab-controls-select-disabled-status',
  'browser-lab-controls-select-lazy',
  'browser-lab-controls-select-lazy-status',
  'browser-lab-controls-select-revert',
  'browser-lab-controls-select-revert-status',
  'browser-lab-controls-combobox-input',
  'browser-lab-controls-combobox-list',
  'browser-lab-controls-combobox-status',
  'browser-lab-controls-menu-button',
  'browser-lab-controls-menu',
  'browser-lab-controls-menu-one',
  'browser-lab-controls-menu-two',
  'browser-lab-controls-menu-status',
  'browser-lab-controls-semantic-dropdown',
  'browser-lab-controls-semantic-value',
  'browser-lab-controls-semantic-menu',
  'browser-lab-controls-semantic-one',
  'browser-lab-controls-semantic-two',
  'browser-lab-controls-semantic-status',
  'browser-lab-controls-date',
  'browser-lab-controls-date-status',
  'browser-lab-controls-time',
  'browser-lab-controls-time-status',
  'browser-lab-controls-datetime-local',
  'browser-lab-controls-datetime-local-status',
  'browser-lab-controls-month',
  'browser-lab-controls-month-status',
  'browser-lab-controls-week',
  'browser-lab-controls-week-status',
  'browser-lab-controls-color',
  'browser-lab-controls-color-status',
  'browser-lab-controls-range',
  'browser-lab-controls-range-status',
  'browser-lab-controls-number',
  'browser-lab-controls-number-status',
  'browser-lab-controls-datepicker',
  'browser-lab-controls-datepicker-popup',
  'browser-lab-controls-datepicker-day',
  'browser-lab-controls-datepicker-status',
  'browser-lab-controls-required',
  'browser-lab-controls-invalid-email',
  'browser-lab-controls-validation-message',
  'browser-lab-controls-echo-submit',
  'browser-lab-controls-secret-password',
  'browser-lab-controls-secret-password-status',
  'browser-lab-controls-secret-one-time-code',
  'browser-lab-controls-secret-one-time-code-status',
  'browser-lab-controls-secret-card-number',
  'browser-lab-controls-secret-card-number-status',
  'browser-lab-controls-secret-card-expiry',
  'browser-lab-controls-secret-card-expiry-status',
  'browser-lab-controls-secret-card-cvc',
  'browser-lab-controls-secret-card-cvc-status',
  'browser-lab-controls-secret-card-status',
  'browser-lab-controls-fill-test-card',
  'browser-lab-controls-enter-form',
  'browser-lab-controls-enter-input',
  'browser-lab-controls-enter-submit',
  'browser-lab-controls-enter-result',
  'browser-lab-controls-tab-order',
  'browser-lab-controls-tab-one',
  'browser-lab-controls-tab-two',
  'browser-lab-controls-tab-zero',
  'browser-lab-controls-tab-negative',
  'browser-lab-controls-focus-log',
];

const CLIENT_CONTROLS = [
  'browser-lab-controls-select-lazy-option-one',
  'browser-lab-controls-select-lazy-option-two',
  'browser-lab-controls-combobox-option-alpha',
  'browser-lab-controls-combobox-option-beta',
  'browser-lab-controls-combobox-option-gamma',
];

export const interactionCase = {
  id: 'controls',
  kind: 'interaction',
  title: 'Form controls',
  entryPath: ENTRY_PATH,
  submitPath: SUBMIT_PATH,
  endpoints: [ENTER_SUBMIT_PATH],
  pages: [
    {
      path: ENTRY_PATH,
      controls: PAGE_CONTROLS,
      clientControls: CLIENT_CONTROLS,
    },
  ],
};

const STYLES = `
.control-group { margin-block: 22px; }
.visually-hidden-control { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); clip-path: inset(50%); white-space: nowrap; border: 0; }
.checkbox-mark, .radio-mark { display: inline-grid; width: 18px; height: 18px; place-items: center; margin-right: 6px; border: 2px solid #536170; border-radius: 4px; vertical-align: middle; }
.radio-mark { border-radius: 50%; }
.visually-hidden-control[type='checkbox']:checked + label .checkbox-mark::after { content: '✓'; }
.visually-hidden-control[type='radio']:checked + label .radio-mark::after { content: '●'; font-size: 12px; }
.aria-checkbox-control, .aria-switch-control { display: inline-flex; align-items: center; gap: 8px; min-height: 32px; padding: 4px 8px; border: 1px solid #7d8794; border-radius: 4px; cursor: pointer; vertical-align: middle; }
.aria-checkbox-control .aria-checkbox-mark { display: inline-block; width: 24px; height: 24px; box-sizing: border-box; border: 2px solid #536170; border-radius: 4px; background: #fff; text-align: center; }
.aria-checkbox-control[aria-checked='true'] .aria-checkbox-mark { background: #2864c5; border-color: #2864c5; color: #fff; }
.aria-checkbox-control[aria-checked='true'] .aria-checkbox-mark::after { content: '✓'; }
.aria-switch-control .aria-switch-track { display: inline-block; width: 44px; height: 24px; box-sizing: border-box; padding: 2px; border-radius: 12px; background: #7d8794; }
.aria-switch-control .aria-switch-track::after { content: ''; display: block; width: 20px; height: 20px; border-radius: 50%; background: #fff; }
.aria-switch-control[aria-checked='true'] .aria-switch-track { background: #2864c5; }
.aria-switch-control[aria-checked='true'] .aria-switch-track::after { transform: translateX(20px); }
.ui.selection.dropdown { position: relative; max-width: 420px; padding: 8px; border: 1px solid #7d8794; cursor: pointer; }
.ui.selection.dropdown .menu { position: absolute; z-index: 2; top: 100%; left: 0; min-width: 100%; background: #fff; border: 1px solid #7d8794; }
.ui.selection.dropdown .item { padding: 7px; cursor: pointer; }
.calendar-popup { padding: 8px; background: #fff; border: 1px solid #7d8794; }
.tab-order button:focus { outline: 3px solid #2864c5; }
output, [role='status'] { display: block; min-height: 1.25em; margin-top: 4px; }
`;

const SCRIPT = `(() => {
  'use strict';

  const byTestId = (id) =>
    Array.from(document.querySelectorAll('[data-testid]')).find(
      (element) => element.dataset.testid === 'browser-lab-controls-' + id,
    );
  const showValue = (output, value, attribute = 'browserLabValue') => {
    output.dataset[attribute] = value;
    output.textContent = value;
  };
  const valuesOf = (select) => Array.from(select.selectedOptions, (option) => option.value).filter(Boolean);

  const nativeCheckbox = byTestId('checkbox-native');
  const nativeCheckboxStatus = byTestId('checkbox-native-status');
  const styledCheckbox = byTestId('checkbox-styled');
  const styledCheckboxStatus = byTestId('checkbox-styled-status');
  nativeCheckbox.addEventListener('change', () => showValue(nativeCheckboxStatus, nativeCheckbox.checked ? 'checked' : 'unchecked'));
  styledCheckbox.addEventListener('change', () => showValue(styledCheckboxStatus, styledCheckbox.checked ? 'checked' : 'unchecked'));

  const ariaCheckbox = byTestId('checkbox-aria');
  const ariaCheckboxValue = byTestId('checkbox-aria-value');
  const ariaCheckboxStatus = byTestId('checkbox-aria-status');
  const ariaSwitch = byTestId('switch-aria');
  const ariaSwitchValue = byTestId('switch-value');
  const ariaSwitchStatus = byTestId('switch-status');
  const toggleAria = (widget, hiddenValue, status) => {
    const checked = widget.getAttribute('aria-checked') !== 'true';
    widget.setAttribute('aria-checked', String(checked));
    hiddenValue.value = checked ? 'checked' : '';
    showValue(status, checked ? 'checked' : 'unchecked');
  };
  for (const [widget, hiddenValue, status] of [
    [ariaCheckbox, ariaCheckboxValue, ariaCheckboxStatus],
    [ariaSwitch, ariaSwitchValue, ariaSwitchStatus],
  ]) {
    widget.addEventListener('click', () => toggleAria(widget, hiddenValue, status));
    widget.addEventListener('keydown', (event) => {
      if (event.key !== ' ' && event.key !== 'Spacebar') return;
      event.preventDefault();
      toggleAria(widget, hiddenValue, status);
    });
  }

  const radioStatus = byTestId('radio-status');
  const radioNames = ['siblingChoice', 'wrappingChoice', 'customChoice'];
  const updateRadios = () => {
    const selection = radioNames.map((name) => {
      const selected = document.querySelector('input[name="' + name + '"]:checked');
      return selected ? selected.value : '';
    }).join('|');
    showValue(radioStatus, selection);
  };
  document.querySelectorAll('input[type="radio"]').forEach((radio) => radio.addEventListener('change', updateRadios));

  const selectPairs = [
    ['select-single', 'select-single-status'],
    ['select-multiple', 'select-multiple-status'],
    ['select-optgroup', 'select-optgroup-status'],
    ['select-disabled', 'select-disabled-status'],
    ['select-lazy', 'select-lazy-status'],
  ];
  for (const [selectId, statusId] of selectPairs) {
    const select = byTestId(selectId);
    const status = byTestId(statusId);
    const update = () => showValue(status, select.multiple ? valuesOf(select).join(',') : select.value);
    select.addEventListener('input', update);
    select.addEventListener('change', update);
  }

  const lazySelect = byTestId('select-lazy');
  let lazyLoaded = false;
  const loadLazyOptions = () => {
    if (lazyLoaded) return;
    lazyLoaded = true;
    setTimeout(() => {
      for (const [value, label, suffix] of [
        ['lazy-one', 'Loaded option one', 'one'],
        ['lazy-two', 'Loaded option two', 'two'],
      ]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        option.dataset.testid = 'browser-lab-controls-select-lazy-option-' + suffix;
        lazySelect.append(option);
      }
    }, 300);
  };
  lazySelect.addEventListener('focus', loadLazyOptions, { once: true });
  lazySelect.addEventListener('mousedown', loadLazyOptions, { once: true });

  const revertSelect = byTestId('select-revert');
  const revertStatus = byTestId('select-revert-status');
  let controlledSelection = revertSelect.value;
  const reapplyControlledSelection = () => {
    if (revertSelect.value !== controlledSelection) revertSelect.value = controlledSelection;
  };
  const acceptTrustedSelection = (event) => {
    if (event.isTrusted) controlledSelection = revertSelect.value;
    queueMicrotask(reapplyControlledSelection);
    showValue(revertStatus, revertSelect.value);
  };
  revertSelect.addEventListener('input', acceptTrustedSelection);
  revertSelect.addEventListener('change', acceptTrustedSelection);
  const revertFrame = () => {
    reapplyControlledSelection();
    requestAnimationFrame(revertFrame);
  };
  requestAnimationFrame(revertFrame);

  const comboInput = byTestId('combobox-input');
  const comboList = byTestId('combobox-list');
  const comboStatus = byTestId('combobox-status');
  const comboChoices = [
    { value: 'alpha', label: 'Alpha' },
    { value: 'beta', label: 'Beta' },
    { value: 'gamma', label: 'Gamma' },
  ];
  let comboTimer;
  const closeCombo = () => {
    comboList.hidden = true;
    comboInput.setAttribute('aria-expanded', 'false');
  };
  comboInput.addEventListener('input', () => {
    clearTimeout(comboTimer);
    comboList.replaceChildren();
    const query = comboInput.value.trim().toLowerCase();
    comboStatus.dataset.browserLabState = 'loading';
    comboStatus.textContent = 'Filtering suggestions…';
    if (!query) {
      closeCombo();
      comboStatus.dataset.browserLabState = 'idle';
      comboStatus.textContent = 'Type to filter suggestions.';
      return;
    }
    comboTimer = setTimeout(() => {
      const suggestions = comboChoices.filter((choice) => choice.label.toLowerCase().includes(query));
      for (const choice of suggestions) {
        const option = document.createElement('li');
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        option.dataset.value = choice.value;
        option.dataset.testid = 'browser-lab-controls-combobox-option-' + choice.value;
        option.textContent = choice.label;
        option.addEventListener('click', () => {
          comboInput.value = choice.label;
          comboInput.dataset.browserLabValue = choice.label;
          closeCombo();
          comboStatus.dataset.browserLabState = 'selected';
          comboStatus.dataset.browserLabValue = choice.value;
          comboStatus.textContent = 'Selected ' + choice.label;
        });
        comboList.append(option);
      }
      comboList.hidden = suggestions.length === 0;
      comboInput.setAttribute('aria-expanded', String(suggestions.length > 0));
      comboStatus.dataset.browserLabState = suggestions.length ? 'open' : 'empty';
      comboStatus.textContent = suggestions.length ? suggestions.length + ' suggestions available.' : 'No matches.';
    }, 200);
  });
  comboInput.addEventListener('focus', () => {
    comboInput.setAttribute('aria-expanded', String(!comboList.hidden));
  });

  const menuButton = byTestId('menu-button');
  const menu = byTestId('menu');
  const menuStatus = byTestId('menu-status');
  menuButton.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    menuButton.setAttribute('aria-expanded', String(!menu.hidden));
    menuStatus.dataset.browserLabLastAction = menu.hidden ? 'closed' : 'opened-click';
  });
  menu.querySelectorAll('[role="menuitem"]').forEach((item) => item.addEventListener('click', () => {
    menuStatus.dataset.browserLabSelection = item.dataset.value;
    menuStatus.dataset.browserLabLastAction = 'selected-click';
    menuStatus.textContent = 'Selected ' + item.textContent;
    menu.hidden = true;
    menuButton.setAttribute('aria-expanded', 'false');
  }));

  const semanticDropdown = byTestId('semantic-dropdown');
  const semanticMenu = byTestId('semantic-menu');
  const semanticValue = byTestId('semantic-value');
  const semanticStatus = byTestId('semantic-status');
  semanticDropdown.addEventListener('click', (event) => {
    const item = event.target.closest('.item[data-value]');
    if (item && semanticMenu.contains(item)) {
      semanticValue.value = item.dataset.value;
      semanticDropdown.querySelector('.text').textContent = item.textContent;
      semanticMenu.hidden = true;
      semanticStatus.dataset.browserLabSelection = item.dataset.value;
      semanticStatus.dataset.browserLabLastAction = 'selected-click';
      semanticStatus.textContent = 'Selected ' + item.textContent;
      return;
    }
    semanticMenu.hidden = !semanticMenu.hidden;
    semanticDropdown.setAttribute('aria-expanded', String(!semanticMenu.hidden));
    semanticStatus.dataset.browserLabLastAction = semanticMenu.hidden ? 'closed' : 'opened-click';
  });

  for (const [fieldId, statusId] of [
    ['date', 'date-status'],
    ['time', 'time-status'],
    ['datetime-local', 'datetime-local-status'],
    ['month', 'month-status'],
    ['week', 'week-status'],
    ['color', 'color-status'],
    ['range', 'range-status'],
    ['number', 'number-status'],
  ]) {
    const field = byTestId(fieldId);
    const status = byTestId(statusId);
    const update = () => showValue(status, field.value);
    field.addEventListener('input', update);
    field.addEventListener('change', update);
  }

  const datepicker = byTestId('datepicker');
  const datepickerPopup = byTestId('datepicker-popup');
  const datepickerStatus = byTestId('datepicker-status');
  datepicker.addEventListener('focus', () => {
    datepickerPopup.hidden = false;
    datepickerStatus.dataset.browserLabState = 'open';
    datepickerStatus.textContent = 'Calendar open.';
  });
  byTestId('datepicker-day').addEventListener('click', () => {
    datepicker.value = '04/15/2025';
    datepicker.dispatchEvent(new Event('input', { bubbles: true }));
    datepicker.dispatchEvent(new Event('change', { bubbles: true }));
    datepickerPopup.hidden = true;
    datepickerStatus.dataset.browserLabState = 'selected';
    datepickerStatus.dataset.browserLabValue = datepicker.value;
    datepickerStatus.textContent = datepicker.value;
  });

  const requiredField = byTestId('required');
  const emailField = byTestId('invalid-email');
  const validationMessage = byTestId('validation-message');
  const validationTouched = new Set();
  const updateValidation = () => {
    const invalid = [requiredField, emailField].find(
      (field) => validationTouched.has(field) && !field.checkValidity(),
    );
    for (const field of [requiredField, emailField]) {
      field.setAttribute(
        'aria-invalid',
        String(validationTouched.has(field) && !field.checkValidity()),
      );
    }
    validationMessage.dataset.browserLabState = invalid ? 'invalid' : 'valid';
    validationMessage.dataset.browserLabValue = invalid ? invalid.validationMessage : '';
    validationMessage.textContent = invalid ? invalid.validationMessage : 'Fields are valid.';
  };
  for (const field of [requiredField, emailField])
    field.addEventListener('input', () => {
      validationTouched.add(field);
      updateValidation();
    });
  byTestId('echo-form').addEventListener('invalid', (event) => {
    if (event.target === requiredField || event.target === emailField) {
      validationTouched.add(event.target);
      event.target.setAttribute('aria-invalid', 'true');
      validationMessage.dataset.browserLabState = 'invalid';
      validationMessage.dataset.browserLabValue = event.target.validationMessage;
      validationMessage.textContent = event.target.validationMessage;
    }
  }, true);

  const enterForm = byTestId('enter-form');
  const enterInput = byTestId('enter-input');
  const enterResult = byTestId('enter-result');
  let enterSubmitCount = 0;
  enterForm.dataset.browserLabSubmitCount = '0';
  enterForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    enterSubmitCount += 1;
    enterForm.dataset.browserLabSubmitCount = String(enterSubmitCount);
    enterResult.dataset.browserLabSubmitCount = String(enterSubmitCount);
    enterResult.dataset.browserLabState = 'submitting';
    enterResult.textContent = 'Submitting…';
    const body = new URLSearchParams(new FormData(enterForm));
    const response = await fetch('/browser-lab/controls/enter-submit', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const result = await response.json();
    enterResult.dataset.browserLabState = response.ok ? 'received' : 'error';
    enterResult.dataset.browserLabValue = enterInput.value;
    enterResult.textContent = response.ok ? 'Received: ' + JSON.stringify(result.fields) : 'Submit failed.';
  });

  const tabGroup = byTestId('tab-order');
  const focusLog = byTestId('focus-log');
  const focusEntries = [];
  tabGroup.addEventListener('focusin', (event) => {
    const testId = event.target.dataset.testid;
    if (!testId) return;
    focusEntries.push(testId);
    focusLog.dataset.browserLabFocusLog = JSON.stringify(focusEntries);
    focusLog.textContent = focusEntries.join(' → ');
  });

  const secretFields = [
    ['secret-password', 'synthetic-password'],
    ['secret-one-time-code', '654321'],
    ['secret-card-number', '4242424242424242'],
    ['secret-card-expiry', '12/29'],
    ['secret-card-cvc', '123'],
  ];
  const updateSecretLength = (field, status) => {
    status.dataset.browserLabLength = String(field.value.length);
    status.textContent = 'Length: ' + field.value.length;
  };
  const setSecret = (fieldId, value) => {
    const field = byTestId(fieldId);
    const status = byTestId(fieldId + '-status');
    field.value = value;
    updateSecretLength(field, status);
  };
  setSecret(secretFields[0][0], secretFields[0][1]);
  setSecret(secretFields[1][0], secretFields[1][1]);
  for (const [fieldId] of secretFields) {
    const field = byTestId(fieldId);
    const status = byTestId(fieldId + '-status');
    field.addEventListener('input', () => updateSecretLength(field, status));
  }
  byTestId('fill-test-card').addEventListener('click', () => {
    for (const [fieldId, value] of secretFields.slice(2)) setSecret(fieldId, value);
    const cardStatus = byTestId('secret-card-status');
    cardStatus.dataset.browserLabLength = String(byTestId('secret-card-number').value.length);
    cardStatus.textContent = 'Card data filled.';
  });
})();`;

export function createRoutes(kit) {
  const { html } = kit;
  const render = () =>
    kit.renderInteractionPage({
      caseDef: interactionCase,
      scripts: [SCRIPT],
      styles: STYLES,
      main: html`<main data-testid="browser-lab-controls-main">
        <h1>${interactionCase.title}</h1>
        <form
          method="post"
          action="${SUBMIT_PATH}"
          data-testid="browser-lab-controls-echo-form"
        >
          <fieldset class="control-group">
            <legend>Checkboxes and switch</legend>
            <label
              ><input
                type="checkbox"
                name="nativeCheckbox"
                value="checked"
                data-testid="browser-lab-controls-checkbox-native"
              />
              Native checkbox</label
            >
            <output
              data-browser-lab-value="unchecked"
              data-testid="browser-lab-controls-checkbox-native-status"
              >unchecked</output
            >
            <input
              class="visually-hidden-control"
              type="checkbox"
              id="styled-checkbox"
              name="styledCheckbox"
              value="checked"
              data-testid="browser-lab-controls-checkbox-styled"
            />
            <label
              class="inline"
              for="styled-checkbox"
              data-testid="browser-lab-controls-checkbox-styled-label"
              ><span class="checkbox-mark" aria-hidden="true"></span>Visually
              hidden checkbox</label
            >
            <output
              data-browser-lab-value="unchecked"
              data-testid="browser-lab-controls-checkbox-styled-status"
              >unchecked</output
            >
            <div
              class="aria-checkbox-control"
              role="checkbox"
              tabindex="0"
              aria-checked="false"
              aria-label="ARIA checkbox"
              data-testid="browser-lab-controls-checkbox-aria"
            >
              <span class="aria-checkbox-mark" aria-hidden="true"></span>ARIA
              checkbox
            </div>
            <input
              type="hidden"
              name="ariaCheckbox"
              value=""
              data-testid="browser-lab-controls-checkbox-aria-value"
            />
            <output
              data-browser-lab-value="unchecked"
              data-testid="browser-lab-controls-checkbox-aria-status"
              >unchecked</output
            >
            <div
              class="aria-switch-control"
              role="switch"
              tabindex="0"
              aria-checked="false"
              aria-label="ARIA switch"
              data-testid="browser-lab-controls-switch-aria"
            >
              <span class="aria-switch-track" aria-hidden="true"></span>ARIA
              switch
            </div>
            <input
              type="hidden"
              name="ariaSwitch"
              value=""
              data-testid="browser-lab-controls-switch-value"
            />
            <output
              data-browser-lab-value="unchecked"
              data-testid="browser-lab-controls-switch-status"
              >unchecked</output
            >
          </fieldset>

          <fieldset class="control-group">
            <legend>Radio labels</legend>
            <input
              id="sibling-one"
              type="radio"
              name="siblingChoice"
              value="one"
              data-testid="browser-lab-controls-radio-sibling-one"
            />
            <label
              class="inline"
              for="sibling-one"
              data-testid="browser-lab-controls-radio-sibling-one-label"
              >Sibling label one</label
            >
            <input
              id="sibling-two"
              type="radio"
              name="siblingChoice"
              value="two"
              data-testid="browser-lab-controls-radio-sibling-two"
            />
            <label
              class="inline"
              for="sibling-two"
              data-testid="browser-lab-controls-radio-sibling-two-label"
              >Sibling label two</label
            >
            <label class="inline"
              >Wrapping label one
              <input
                type="radio"
                name="wrappingChoice"
                value="one"
                data-testid="browser-lab-controls-radio-wrapping-one"
            /></label>
            <label class="inline"
              >Wrapping label two
              <input
                type="radio"
                name="wrappingChoice"
                value="two"
                data-testid="browser-lab-controls-radio-wrapping-two"
            /></label>
            <input
              class="visually-hidden-control"
              id="custom-one"
              type="radio"
              name="customChoice"
              value="one"
              data-testid="browser-lab-controls-radio-custom-one"
            />
            <label
              class="inline"
              for="custom-one"
              data-testid="browser-lab-controls-radio-custom-one-label"
              ><span class="radio-mark" aria-hidden="true"></span>Custom radio
              one</label
            >
            <input
              class="visually-hidden-control"
              id="custom-two"
              type="radio"
              name="customChoice"
              value="two"
              data-testid="browser-lab-controls-radio-custom-two"
            />
            <label
              class="inline"
              for="custom-two"
              data-testid="browser-lab-controls-radio-custom-two-label"
              ><span class="radio-mark" aria-hidden="true"></span>Custom radio
              two</label
            >
            <output
              data-browser-lab-value="||"
              data-testid="browser-lab-controls-radio-status"
              >||</output
            >
          </fieldset>

          <fieldset class="control-group">
            <legend>Native selects</legend>
            <label for="single-select">Single select</label>
            <select
              id="single-select"
              name="singleSelect"
              data-testid="browser-lab-controls-select-single"
            >
              <option value="">Choose one</option>
              <option value="amber">Amber</option>
              <option value="violet">Violet</option>
            </select>
            <output
              data-browser-lab-value=""
              data-testid="browser-lab-controls-select-single-status"
            ></output>
            <label for="multiple-select">Multiple select</label>
            <select
              id="multiple-select"
              name="multipleSelect"
              multiple
              size="3"
              data-testid="browser-lab-controls-select-multiple"
            >
              <option value="red">Red</option>
              <option value="green">Green</option>
              <option value="blue">Blue</option>
            </select>
            <output
              data-browser-lab-value=""
              data-testid="browser-lab-controls-select-multiple-status"
            ></output>
            <label for="optgroup-select">Optgroup select</label>
            <select
              id="optgroup-select"
              name="optgroupChoice"
              data-testid="browser-lab-controls-select-optgroup"
            >
              <option value="">Choose a region</option>
              <optgroup label="North">
                <option value="north-one">North one</option>
                <option value="north-two">North two</option>
              </optgroup>
              <optgroup label="South">
                <option value="south-one">South one</option>
              </optgroup>
            </select>
            <output
              data-browser-lab-value=""
              data-testid="browser-lab-controls-select-optgroup-status"
            ></output>
            <label for="disabled-select">Disabled options</label>
            <select
              id="disabled-select"
              name="enabledChoice"
              data-testid="browser-lab-controls-select-disabled"
            >
              <option value="">Choose an enabled option</option>
              <option value="disabled" disabled>Unavailable</option>
              <option value="available">Available</option>
            </select>
            <output
              data-browser-lab-value=""
              data-testid="browser-lab-controls-select-disabled-status"
              >Choose an enabled option</output
            >
            <label for="lazy-select">Lazy options (load after focus)</label>
            <select
              id="lazy-select"
              name="lazyChoice"
              data-testid="browser-lab-controls-select-lazy"
            >
              <option value="">Focus to load options</option>
            </select>
            <output
              data-browser-lab-value=""
              data-testid="browser-lab-controls-select-lazy-status"
            ></output>
            <label for="revert-select">Framework-controlled select</label>
            <select
              id="revert-select"
              name="controlledChoice"
              data-testid="browser-lab-controls-select-revert"
            >
              <option value="stable">Stable selection</option>
              <option value="alternate">Alternate selection</option>
            </select>
            <output
              data-browser-lab-value="stable"
              data-testid="browser-lab-controls-select-revert-status"
              >stable</output
            >
          </fieldset>

          <fieldset class="control-group">
            <legend>ARIA and custom menus</legend>
            <label for="filter-combobox">Async-filtered combobox</label>
            <input
              id="filter-combobox"
              type="text"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="false"
              aria-controls="combo-list"
              autocomplete="off"
              data-testid="browser-lab-controls-combobox-input"
            />
            <ul
              id="combo-list"
              role="listbox"
              hidden
              data-testid="browser-lab-controls-combobox-list"
            ></ul>
            <output
              role="status"
              data-browser-lab-state="idle"
              data-browser-lab-value=""
              data-testid="browser-lab-controls-combobox-status"
              >Type to filter suggestions.</output
            >
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded="false"
              data-testid="browser-lab-controls-menu-button"
            >
              Open ARIA menu
            </button>
            <div role="menu" hidden data-testid="browser-lab-controls-menu">
              <button
                type="button"
                role="menuitem"
                data-value="menu-one"
                data-testid="browser-lab-controls-menu-one"
              >
                Menu item one
              </button>
              <button
                type="button"
                role="menuitem"
                data-value="menu-two"
                data-testid="browser-lab-controls-menu-two"
              >
                Menu item two
              </button>
            </div>
            <output
              role="status"
              data-browser-lab-selection=""
              data-browser-lab-last-action="idle"
              data-testid="browser-lab-controls-menu-status"
              >idle</output
            >
            <div
              class="ui selection dropdown"
              tabindex="0"
              role="combobox"
              aria-haspopup="listbox"
              aria-expanded="false"
              data-testid="browser-lab-controls-semantic-dropdown"
            >
              <span class="text">Choose a framework value</span>
              <div
                class="menu"
                role="listbox"
                hidden
                data-testid="browser-lab-controls-semantic-menu"
              >
                <div
                  class="item"
                  role="option"
                  data-value="semantic-one"
                  data-testid="browser-lab-controls-semantic-one"
                >
                  Semantic one
                </div>
                <div
                  class="item"
                  role="option"
                  data-value="semantic-two"
                  data-testid="browser-lab-controls-semantic-two"
                >
                  Semantic two
                </div>
              </div>
            </div>
            <input
              type="hidden"
              name="semanticChoice"
              value=""
              data-testid="browser-lab-controls-semantic-value"
            />
            <output
              data-browser-lab-selection=""
              data-browser-lab-last-action="idle"
              data-testid="browser-lab-controls-semantic-status"
              >idle</output
            >
          </fieldset>

          <fieldset class="control-group">
            <legend>Compound inputs</legend>
            <label for="date-field">Date</label
            ><input
              id="date-field"
              name="dateValue"
              type="date"
              min="2024-01-01"
              max="2026-12-31"
              step="1"
              value="2025-04-15"
              data-testid="browser-lab-controls-date"
            />
            <output
              data-browser-lab-value="2025-04-15"
              data-testid="browser-lab-controls-date-status"
              >2025-04-15</output
            >
            <label for="time-field">Time</label
            ><input
              id="time-field"
              name="timeValue"
              type="time"
              min="09:00"
              max="17:00"
              step="900"
              value="10:30"
              data-testid="browser-lab-controls-time"
            />
            <output
              data-browser-lab-value="10:30"
              data-testid="browser-lab-controls-time-status"
              >10:30</output
            >
            <label for="datetime-field">Date and time</label
            ><input
              id="datetime-field"
              name="datetimeValue"
              type="datetime-local"
              min="2024-01-01T00:00"
              max="2026-12-31T23:59"
              step="60"
              value="2025-04-15T10:30"
              data-testid="browser-lab-controls-datetime-local"
            />
            <output
              data-browser-lab-value="2025-04-15T10:30"
              data-testid="browser-lab-controls-datetime-local-status"
              >2025-04-15T10:30</output
            >
            <label for="month-field">Month</label
            ><input
              id="month-field"
              name="monthValue"
              type="month"
              min="2024-01"
              max="2027-12"
              step="1"
              value="2025-04"
              data-testid="browser-lab-controls-month"
            />
            <output
              data-browser-lab-value="2025-04"
              data-testid="browser-lab-controls-month-status"
              >2025-04</output
            >
            <label for="week-field">Week</label
            ><input
              id="week-field"
              name="weekValue"
              type="week"
              min="2024-W01"
              max="2027-W52"
              step="1"
              value="2025-W15"
              data-testid="browser-lab-controls-week"
            />
            <output
              data-browser-lab-value="2025-W15"
              data-testid="browser-lab-controls-week-status"
              >2025-W15</output
            >
            <label for="color-field">Color</label
            ><input
              id="color-field"
              name="colorValue"
              type="color"
              min="0"
              max="1"
              step="0.1"
              value="#336699"
              data-testid="browser-lab-controls-color"
            />
            <output
              data-browser-lab-value="#336699"
              data-testid="browser-lab-controls-color-status"
              >#336699</output
            >
            <label for="range-field">Range</label
            ><input
              id="range-field"
              name="rangeValue"
              type="range"
              min="0"
              max="100"
              step="5"
              value="35"
              data-testid="browser-lab-controls-range"
            />
            <output
              data-browser-lab-value="35"
              data-testid="browser-lab-controls-range-status"
              >35</output
            >
            <label for="number-field">Number</label
            ><input
              id="number-field"
              name="numberValue"
              type="number"
              min="1"
              max="20"
              step="2"
              value="5"
              data-testid="browser-lab-controls-number"
            />
            <output
              data-browser-lab-value="5"
              data-testid="browser-lab-controls-number-status"
              >5</output
            >
          </fieldset>

          <fieldset class="control-group">
            <legend>Datepicker and validation</legend>
            <label for="datepicker-field">jQuery-style datepicker</label>
            <input
              id="datepicker-field"
              class="datepicker hasDatepicker"
              type="text"
              name="datepickerValue"
              autocomplete="off"
              data-testid="browser-lab-controls-datepicker"
            />
            <div
              class="calendar-popup"
              hidden
              data-testid="browser-lab-controls-datepicker-popup"
            >
              <button
                type="button"
                data-testid="browser-lab-controls-datepicker-day"
              >
                April 15, 2025
              </button>
            </div>
            <output
              role="status"
              data-browser-lab-state="idle"
              data-browser-lab-value=""
              data-testid="browser-lab-controls-datepicker-status"
              >Focus to open the calendar.</output
            >
            <label for="required-field">Required text</label
            ><input
              id="required-field"
              name="requiredText"
              type="text"
              required
              aria-invalid="false"
              data-testid="browser-lab-controls-required"
            />
            <label for="invalid-email-field">Email for example.test</label
            ><input
              id="invalid-email-field"
              name="email"
              type="email"
              pattern="[^@\\s]+@example\\.test"
              required
              aria-invalid="false"
              data-testid="browser-lab-controls-invalid-email"
            />
            <output
              role="status"
              aria-live="polite"
              data-browser-lab-state="idle"
              data-browser-lab-value=""
              data-testid="browser-lab-controls-validation-message"
              >Fields are valid.</output
            >
          </fieldset>
          <button type="submit" data-testid="browser-lab-controls-echo-submit">
            Echo form
          </button>
        </form>

        <section class="control-group" aria-labelledby="secret-heading">
          <h2 id="secret-heading">Sensitive fields</h2>
          <label for="secret-password-field">Password</label
          ><input
            id="secret-password-field"
            type="password"
            autocomplete="current-password"
            data-testid="browser-lab-controls-secret-password"
          />
          <output
            data-browser-lab-length="0"
            data-testid="browser-lab-controls-secret-password-status"
            >Length: 0</output
          >
          <label for="one-time-code-field">One-time code</label
          ><input
            id="one-time-code-field"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            data-testid="browser-lab-controls-secret-one-time-code"
          />
          <output
            data-browser-lab-length="0"
            data-testid="browser-lab-controls-secret-one-time-code-status"
            >Length: 0</output
          >
          <label for="card-number-field">Card number</label
          ><input
            id="card-number-field"
            type="text"
            autocomplete="cc-number"
            data-testid="browser-lab-controls-secret-card-number"
          />
          <output
            data-browser-lab-length="0"
            data-testid="browser-lab-controls-secret-card-number-status"
            >Length: 0</output
          >
          <label for="card-expiry-field">Card expiry</label
          ><input
            id="card-expiry-field"
            type="text"
            autocomplete="cc-exp"
            data-testid="browser-lab-controls-secret-card-expiry"
          />
          <output
            data-browser-lab-length="0"
            data-testid="browser-lab-controls-secret-card-expiry-status"
            >Length: 0</output
          >
          <label for="card-cvc-field">Card security code</label
          ><input
            id="card-cvc-field"
            type="password"
            autocomplete="cc-csc"
            data-testid="browser-lab-controls-secret-card-cvc"
          />
          <output
            data-browser-lab-length="0"
            data-testid="browser-lab-controls-secret-card-cvc-status"
            >Length: 0</output
          >
          <output
            data-browser-lab-length="0"
            data-testid="browser-lab-controls-secret-card-status"
            >Card data not filled.</output
          >
          <button
            type="button"
            data-testid="browser-lab-controls-fill-test-card"
          >
            Fill test card
          </button>
        </section>

        <form
          method="post"
          action="${ENTER_SUBMIT_PATH}"
          data-testid="browser-lab-controls-enter-form"
        >
          <label for="enter-input-field">Enter-to-submit text</label>
          <input
            id="enter-input-field"
            type="text"
            name="value"
            data-testid="browser-lab-controls-enter-input"
          />
          <button type="submit" data-testid="browser-lab-controls-enter-submit">
            Submit with Enter
          </button>
          <output
            role="status"
            data-browser-lab-state="idle"
            data-browser-lab-value=""
            data-browser-lab-submit-count="0"
            data-testid="browser-lab-controls-enter-result"
            >Not submitted.</output
          >
        </form>

        <fieldset
          class="control-group tab-order"
          data-testid="browser-lab-controls-tab-order"
        >
          <legend>Tab order</legend>
          <button
            type="button"
            tabindex="2"
            data-testid="browser-lab-controls-tab-two"
          >
            Positive tabindex 2
          </button>
          <button
            type="button"
            tabindex="0"
            data-testid="browser-lab-controls-tab-zero"
          >
            Tabindex 0
          </button>
          <button
            type="button"
            tabindex="-1"
            data-testid="browser-lab-controls-tab-negative"
          >
            Tabindex -1
          </button>
          <button
            type="button"
            tabindex="1"
            data-testid="browser-lab-controls-tab-one"
          >
            Positive tabindex 1
          </button>
          <output
            data-browser-lab-focus-log="[]"
            data-testid="browser-lab-controls-focus-log"
            >[]</output
          >
        </fieldset>
      </main>`,
    });

  return [
    [ENTRY_PATH, kit.pageRoute(render)],
    [SUBMIT_PATH, kit.echoSubmitRoute(interactionCase)],
    [
      ENTER_SUBMIT_PATH,
      kit.echoSubmitRoute(interactionCase, { format: 'json' }),
    ],
  ];
}
