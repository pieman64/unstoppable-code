// Browser Lab interaction case `typing` (CAN-1570).

const ENTRY_PATH = '/browser-lab/typing';
const SUBMIT_PATH = '/browser-lab/typing/submit';

const PAGE_CONTROLS = [
  'browser-lab-typing-main',
  'browser-lab-header-home',
  'browser-lab-typing-echo-form',
  'browser-lab-typing-prefilled',
  'browser-lab-typing-prefilled-status',
  'browser-lab-typing-sticky',
  'browser-lab-typing-sticky-status',
  'browser-lab-typing-combobox',
  'browser-lab-typing-combobox-list',
  'browser-lab-typing-combobox-status',
  'browser-lab-typing-datalist',
  'browser-lab-typing-datalist-options',
  'browser-lab-typing-datalist-port-lumen',
  'browser-lab-typing-datalist-port-luna',
  'browser-lab-typing-datalist-portland',
  'browser-lab-typing-datalist-status',
  'browser-lab-typing-masked-phone',
  'browser-lab-typing-masked-phone-status',
  'browser-lab-typing-echo-submit',
  'browser-lab-typing-secret-password',
  'browser-lab-typing-secret-password-status',
  'browser-lab-typing-secret-one-time-code',
  'browser-lab-typing-secret-one-time-code-status',
  'browser-lab-typing-secret-card-number',
  'browser-lab-typing-secret-card-number-status',
  'browser-lab-typing-secret-card-expiry',
  'browser-lab-typing-secret-card-expiry-status',
  'browser-lab-typing-secret-card-cvc',
  'browser-lab-typing-secret-card-cvc-status',
  'browser-lab-typing-fill-test-card',
];

const CLIENT_CONTROLS = [
  'browser-lab-typing-combobox-option-port-lumen',
  'browser-lab-typing-combobox-option-port-luna',
  'browser-lab-typing-combobox-option-portland',
];

export const interactionCase = {
  id: 'typing',
  kind: 'interaction',
  title: 'Typing',
  entryPath: ENTRY_PATH,
  submitPath: SUBMIT_PATH,
  pages: [
    {
      path: ENTRY_PATH,
      controls: PAGE_CONTROLS,
      clientControls: CLIENT_CONTROLS,
    },
  ],
};

const STYLES = `
.typing-widget { margin-block: 20px; padding: 12px; border: 1px solid #c8cdd4; border-radius: 6px; }
ul[role='listbox'] { max-width: 420px; padding: 0; list-style: none; border: 1px solid #8d96a3; }
ul[role='listbox'] li { padding: 7px; cursor: pointer; }
ul[role='listbox'] li:hover { background: #e7eefb; }
output { display: block; min-height: 1.25em; margin-top: 4px; }
`;

const SCRIPT = `(() => {
  'use strict';

  const byTestId = (id) =>
    Array.from(document.querySelectorAll('[data-testid]')).find(
      (element) => element.dataset.testid === 'browser-lab-typing-' + id,
    );
  const mirrorValue = (field, output) => {
    output.dataset.browserLabValue = field.value;
    output.textContent = field.value;
  };

  const prefilled = byTestId('prefilled');
  const prefilledStatus = byTestId('prefilled-status');
  prefilled.addEventListener('input', () => mirrorValue(prefilled, prefilledStatus));

  const sticky = byTestId('sticky');
  const stickyStatus = byTestId('sticky-status');
  let stickyValue = sticky.value;
  const restoreStickyValue = () => {
    if (sticky.value !== stickyValue) {
      sticky.value = stickyValue;
      sticky.setSelectionRange(stickyValue.length, stickyValue.length);
    }
    stickyStatus.dataset.browserLabValue = stickyValue;
    stickyStatus.textContent = stickyValue;
  };
  sticky.addEventListener('input', (event) => {
    if (event.isTrusted) {
      stickyValue = sticky.value;
    } else {
      restoreStickyValue();
    }
    stickyStatus.dataset.browserLabValue = stickyValue;
    stickyStatus.textContent = stickyValue;
  });
  const enforceStickyValue = () => {
    restoreStickyValue();
    requestAnimationFrame(enforceStickyValue);
  };
  requestAnimationFrame(enforceStickyValue);

  const combo = byTestId('combobox');
  const comboList = byTestId('combobox-list');
  const comboStatus = byTestId('combobox-status');
  const comboChoices = [
    { value: 'PLM', label: 'Port Lumen (PLM)', testId: 'port-lumen' },
    { value: 'PLN', label: 'Port Luna (PLN)', testId: 'port-luna' },
    { value: 'PDX', label: 'Portland (PDX)', testId: 'portland' },
  ];
  let comboTimer;
  let comboGeneration = 0;
  const closeSuggestions = () => {
    comboList.hidden = true;
    combo.setAttribute('aria-expanded', 'false');
  };
  combo.addEventListener('input', () => {
    clearTimeout(comboTimer);
    const generation = ++comboGeneration;
    const query = combo.value.trim().toLowerCase();
    comboStatus.dataset.browserLabValue = combo.value;
    comboStatus.dataset.browserLabState = 'loading';
    comboStatus.textContent = 'Waiting for suggestions…';
    comboList.replaceChildren();
    if (query.length < 2) {
      closeSuggestions();
      comboStatus.dataset.browserLabState = 'idle';
      comboStatus.textContent = 'Type at least two letters to search.';
      return;
    }
    comboTimer = setTimeout(() => {
      if (generation !== comboGeneration) return;
      const suggestions = comboChoices.filter((choice) => choice.label.toLowerCase().includes(query));
      for (const choice of suggestions) {
        const option = document.createElement('li');
        option.setAttribute('role', 'option');
        option.dataset.value = choice.value;
        option.dataset.testid = 'browser-lab-typing-combobox-option-' + choice.testId;
        option.textContent = choice.label;
        option.addEventListener('click', () => {
          combo.value = choice.label;
          closeSuggestions();
          comboStatus.dataset.browserLabState = 'selected';
          comboStatus.dataset.browserLabValue = choice.label;
          comboStatus.dataset.browserLabSelection = choice.value;
          comboStatus.textContent = 'Selected ' + choice.label;
        });
        comboList.append(option);
      }
      comboList.hidden = suggestions.length === 0;
      combo.setAttribute('aria-expanded', String(suggestions.length > 0));
      comboStatus.dataset.browserLabState = suggestions.length ? 'open' : 'empty';
      comboStatus.textContent = suggestions.length ? suggestions.length + ' suggestions available.' : 'No destinations match.';
    }, 200);
  });
  combo.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSuggestions();
  });

  const datalist = byTestId('datalist');
  const datalistStatus = byTestId('datalist-status');
  datalist.addEventListener('input', () => mirrorValue(datalist, datalistStatus));

  const phone = byTestId('masked-phone');
  const phoneStatus = byTestId('masked-phone-status');
  let phoneDigits = '';
  const formatPhone = (digits) => {
    const clipped = digits.slice(0, 10);
    if (clipped.length === 0) return '';
    if (clipped.length < 3) return '(' + clipped;
    if (clipped.length === 3) return '(' + clipped + ')';
    if (clipped.length < 7) return '(' + clipped.slice(0, 3) + ') ' + clipped.slice(3);
    return '(' + clipped.slice(0, 3) + ') ' + clipped.slice(3, 6) + '-' + clipped.slice(6);
  };
  const applyPhoneModel = () => {
    phone.value = formatPhone(phoneDigits);
    phone.setSelectionRange(phone.value.length, phone.value.length);
    phoneStatus.dataset.browserLabValue = phone.value;
    phoneStatus.textContent = phone.value;
  };
  phone.addEventListener('beforeinput', (event) => {
    if (!event.isTrusted) return;
    if (event.inputType === 'insertText' && event.data && /^\\d+$/.test(event.data)) {
      event.preventDefault();
      phoneDigits = (phoneDigits + event.data).slice(0, 10);
      applyPhoneModel();
    } else if (event.inputType === 'deleteContentBackward') {
      event.preventDefault();
      phoneDigits = phoneDigits.slice(0, -1);
      applyPhoneModel();
    } else if (event.inputType.startsWith('insert')) {
      event.preventDefault();
      applyPhoneModel();
    }
  });
  phone.addEventListener('input', (event) => {
    if (!event.isTrusted) applyPhoneModel();
  });
  const enforcePhoneModel = () => {
    if (phone.value !== formatPhone(phoneDigits)) applyPhoneModel();
    requestAnimationFrame(enforcePhoneModel);
  };
  requestAnimationFrame(enforcePhoneModel);

  const secretFields = [
    ['secret-password', 'synthetic-password'],
    ['secret-one-time-code', '246810'],
    ['secret-card-number', '4242424242424242'],
    ['secret-card-expiry', '12/29'],
    ['secret-card-cvc', '123'],
  ];
  const updateSecretLength = (field, output) => {
    output.dataset.browserLabLength = String(field.value.length);
    output.textContent = 'Length: ' + field.value.length;
  };
  const fillSecret = (fieldId, value) => {
    const field = byTestId(fieldId);
    const output = byTestId(fieldId + '-status');
    field.value = value;
    updateSecretLength(field, output);
  };
  fillSecret(secretFields[0][0], secretFields[0][1]);
  fillSecret(secretFields[1][0], secretFields[1][1]);
  for (const [fieldId] of secretFields) {
    const field = byTestId(fieldId);
    const output = byTestId(fieldId + '-status');
    field.addEventListener('input', () => updateSecretLength(field, output));
  }
  byTestId('fill-test-card').addEventListener('click', () => {
    for (const [fieldId, value] of secretFields.slice(2)) fillSecret(fieldId, value);
  });
})();`;

export function createRoutes(kit) {
  const { html } = kit;
  const render = () =>
    kit.renderInteractionPage({
      caseDef: interactionCase,
      scripts: [SCRIPT],
      styles: STYLES,
      main: html`<main data-testid="browser-lab-typing-main">
        <h1>${interactionCase.title}</h1>
        <form
          method="post"
          action="${SUBMIT_PATH}"
          data-testid="browser-lab-typing-echo-form"
        >
          <fieldset class="typing-widget">
            <legend>Prefilled value</legend>
            <label for="prefilled-field">Text input</label>
            <input
              id="prefilled-field"
              type="text"
              name="prefilled"
              value="Prefilled value"
              data-testid="browser-lab-typing-prefilled"
            />
            <output
              data-browser-lab-value="Prefilled value"
              data-testid="browser-lab-typing-prefilled-status"
              >Prefilled value</output
            >
          </fieldset>
          <fieldset class="typing-widget">
            <legend>Sticky concatenating input</legend>
            <label for="sticky-field"
              >This field restores its previous value after direct
              assignment</label
            >
            <input
              id="sticky-field"
              type="text"
              name="sticky"
              value="Keep this text: "
              data-testid="browser-lab-typing-sticky"
            />
            <output
              data-browser-lab-value="Keep this text: "
              data-testid="browser-lab-typing-sticky-status"
              >Keep this text:
            </output>
          </fieldset>
          <fieldset class="typing-widget">
            <legend>Combobox suggestions</legend>
            <label for="typing-combobox">Destination</label>
            <input
              id="typing-combobox"
              type="text"
              name="destination"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="false"
              aria-controls="typing-suggestions"
              autocomplete="off"
              data-testid="browser-lab-typing-combobox"
            />
            <ul
              id="typing-suggestions"
              role="listbox"
              hidden
              data-testid="browser-lab-typing-combobox-list"
            ></ul>
            <output
              role="status"
              data-browser-lab-state="idle"
              data-browser-lab-value=""
              data-testid="browser-lab-typing-combobox-status"
              >Type at least two letters to search.</output
            >
          </fieldset>
          <fieldset class="typing-widget">
            <legend>Datalist</legend>
            <label for="typing-datalist">Choose a city</label>
            <input
              id="typing-datalist"
              type="text"
              name="city"
              list="typing-city-options"
              data-testid="browser-lab-typing-datalist"
            />
            <datalist
              id="typing-city-options"
              data-testid="browser-lab-typing-datalist-options"
            >
              <option
                value="Port Lumen"
                data-testid="browser-lab-typing-datalist-port-lumen"
              ></option>
              <option
                value="Port Luna"
                data-testid="browser-lab-typing-datalist-port-luna"
              ></option>
              <option
                value="Portland"
                data-testid="browser-lab-typing-datalist-portland"
              ></option>
            </datalist>
            <output
              data-browser-lab-value=""
              data-testid="browser-lab-typing-datalist-status"
            ></output>
          </fieldset>
          <fieldset class="typing-widget">
            <legend>Masked phone</legend>
            <label for="masked-phone-field">Phone number</label>
            <input
              id="masked-phone-field"
              type="text"
              name="phone"
              inputmode="tel"
              autocomplete="tel-national"
              placeholder="(999) 999-9999"
              data-testid="browser-lab-typing-masked-phone"
            />
            <output
              data-browser-lab-value=""
              data-testid="browser-lab-typing-masked-phone-status"
            ></output>
          </fieldset>
          <button type="submit" data-testid="browser-lab-typing-echo-submit">
            Echo typed values
          </button>
        </form>

        <section class="typing-widget" aria-labelledby="typing-secret-heading">
          <h2 id="typing-secret-heading">Sensitive values</h2>
          <label for="secret-password-field">Password (filled on load)</label>
          <input
            id="secret-password-field"
            type="password"
            autocomplete="current-password"
            data-testid="browser-lab-typing-secret-password"
          />
          <output
            data-browser-lab-length="0"
            data-testid="browser-lab-typing-secret-password-status"
            >Length: 0</output
          >
          <label for="secret-code-field">One-time code</label>
          <input
            id="secret-code-field"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            data-testid="browser-lab-typing-secret-one-time-code"
          />
          <output
            data-browser-lab-length="0"
            data-testid="browser-lab-typing-secret-one-time-code-status"
            >Length: 0</output
          >
          <label for="secret-card-number-field">Card number</label>
          <input
            id="secret-card-number-field"
            type="text"
            autocomplete="cc-number"
            data-testid="browser-lab-typing-secret-card-number"
          />
          <output
            data-browser-lab-length="0"
            data-testid="browser-lab-typing-secret-card-number-status"
            >Length: 0</output
          >
          <label for="secret-card-expiry-field">Card expiry</label>
          <input
            id="secret-card-expiry-field"
            type="text"
            autocomplete="cc-exp"
            data-testid="browser-lab-typing-secret-card-expiry"
          />
          <output
            data-browser-lab-length="0"
            data-testid="browser-lab-typing-secret-card-expiry-status"
            >Length: 0</output
          >
          <label for="secret-card-cvc-field">Card security code</label>
          <input
            id="secret-card-cvc-field"
            type="password"
            autocomplete="cc-csc"
            data-testid="browser-lab-typing-secret-card-cvc"
          />
          <output
            data-browser-lab-length="0"
            data-testid="browser-lab-typing-secret-card-cvc-status"
            >Length: 0</output
          >
          <button type="button" data-testid="browser-lab-typing-fill-test-card">
            Fill test card
          </button>
        </section>
      </main>`,
    });

  return [
    [ENTRY_PATH, kit.pageRoute(render)],
    [SUBMIT_PATH, kit.echoSubmitRoute(interactionCase)],
  ];
}
