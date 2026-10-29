/**
 * @jest-environment jsdom
 */
import {
  DESCRIBE_FUNCTION,
  EDITOR_TEXT_FUNCTION,
  FILL_FUNCTION,
} from '../target-state';

/** Calls a function declaration the way `Runtime.callFunctionOn` does. */
function call(
  declaration: string,
  target: unknown,
  ...args: unknown[]
): unknown {
  const evaluate: unknown = Reflect.get(globalThis, 'eval');
  if (typeof evaluate !== 'function') throw new Error('No eval');
  const fn: unknown = Reflect.apply(evaluate, undefined, [`(${declaration})`]);
  if (typeof fn !== 'function') throw new Error('Not a function');
  return Reflect.apply(fn, target, args);
}

function element(html: string, id: string): Element {
  document.body.innerHTML = html;
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found;
}

describe('the host-world fill (the preload fillElement, moved unchanged)', () => {
  it('sets the value through the prototype setter, focuses, and fires input then change', () => {
    const input = element('<form><input id="field"></form>', 'field');
    const ownSetter = jest.fn();
    // A page override of the element's own value property is bypassed.
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => 'page value',
      set: ownSetter,
    });
    const events: Array<Record<string, unknown>> = [];
    document.body.addEventListener('input', (event) => {
      events.push({
        type: event.type,
        bubbles: event.bubbles,
        inputType: Reflect.get(event, 'inputType'),
        data: Reflect.get(event, 'data'),
        isInputEvent: event instanceof InputEvent,
      });
    });
    document.body.addEventListener('change', (event) => {
      events.push({ type: event.type, bubbles: event.bubbles });
    });
    expect(call(FILL_FUNCTION, input, 'hello')).toBe('filled');
    expect(ownSetter).not.toHaveBeenCalled();
    // The prototype getter, not the page's own property, holds the value.
    expect(Reflect.get(HTMLInputElement.prototype, 'value', input)).toBe(
      'hello',
    );
    expect(document.activeElement).toBe(input);
    expect(events).toEqual([
      {
        type: 'input',
        bubbles: true,
        inputType: 'insertText',
        data: 'hello',
        isInputEvent: true,
      },
      { type: 'change', bubbles: true },
    ]);
  });

  it('fills a textarea and refuses other elements', () => {
    const textarea = element('<textarea id="area"></textarea>', 'area');
    expect(call(FILL_FUNCTION, textarea, 'notes')).toBe('filled');
    expect(Reflect.get(textarea, 'value')).toBe('notes');
    expect(
      call(FILL_FUNCTION, element('<div id="box"></div>', 'box'), 'x'),
    ).toBe('not_fillable');
    const detached = document.createElement('input');
    expect(call(FILL_FUNCTION, detached, 'x')).toBe('target_stale');
  });
});

describe('the host-world description (the preload preparedTargetState reads)', () => {
  it('reads tag, role inputs, checked, disabled, geometry and focus', () => {
    const box = element(
      '<fieldset disabled><label><input id="box" type="checkbox" role="switch" aria-checked="mixed" checked></label></fieldset>',
      'box',
    );
    expect(call(DESCRIBE_FUNCTION, box)).toEqual({
      connected: true,
      tagName: 'input',
      attributes: { role: 'switch', type: 'checkbox', 'aria-checked': 'mixed' },
      checked: true,
      disabled: true,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      focused: false,
      invalid: false,
    });
    const link = element(
      '<div aria-disabled="TRUE"><a id="link" href="/x">Go</a></div>',
      'link',
    );
    expect(call(DESCRIBE_FUNCTION, link)).toMatchObject({
      tagName: 'a',
      attributes: { href: '/x' },
      disabled: true,
    });
  });

  it('counts focus inside shadow roots through each host', () => {
    const host = element('<div id="host"></div><input id="other">', 'host');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<input id="inner">';
    const inner = root.getElementById('inner');
    if (!(inner instanceof HTMLElement)) throw new Error('Missing input');
    inner.focus();
    expect(call(DESCRIBE_FUNCTION, inner)).toMatchObject({ focused: true });
    // The host is its document's active element, as the preload reports.
    expect(call(DESCRIBE_FUNCTION, host)).toMatchObject({ focused: true });
    const other = document.getElementById('other');
    expect(call(DESCRIBE_FUNCTION, other)).toMatchObject({ focused: false });
  });

  it('reports a detached element', () => {
    expect(call(DESCRIBE_FUNCTION, document.createElement('button'))).toEqual({
      connected: false,
    });
  });

  it('reads live values, contenteditable text, indeterminate state, validity, and selected options', () => {
    document.body.innerHTML = `
      <input id="text" value="live text">
      <input id="invalid" required aria-invalid="true">
      <input id="mixed" type="checkbox">
      <input id="unchecked" type="checkbox" aria-checked="true">
      <input id="aria-native-valid" value="valid" aria-invalid="grammar">
      <div id="aria-invalid" aria-invalid="grammar"></div>
      <select id="native" multiple>
        <option value="a" selected>Alpha option</option>
        <option value="b" selected>Beta option</option>
      </select>
      <div id="editor" contenteditable="true">line <strong>two</strong></div>
      <div id="list" role="listbox">
        <div role="option" data-value="" aria-selected="true">Chosen   label</div>
      </div>
      <input id="combo" role="combobox" aria-controls="list" value="typed query">
    `;
    const byId = (id: string): Element => {
      const found = document.getElementById(id);
      if (!found) throw new Error(`Missing #${id}`);
      return found;
    };
    Reflect.set(byId('mixed'), 'indeterminate', true);

    expect(call(DESCRIBE_FUNCTION, byId('text'), false)).toMatchObject({
      value: 'live text',
    });
    const invalid = call(DESCRIBE_FUNCTION, byId('invalid'), false);
    expect(invalid).toMatchObject({ invalid: true });
    expect(invalid).toHaveProperty('validationMessage');
    expect(call(DESCRIBE_FUNCTION, byId('mixed'), false)).toMatchObject({
      checked: 'mixed',
    });
    expect(call(DESCRIBE_FUNCTION, byId('unchecked'), false)).toMatchObject({
      checked: false,
    });
    expect(call(DESCRIBE_FUNCTION, byId('aria-invalid'), false)).toMatchObject({
      invalid: true,
    });
    expect(
      call(DESCRIBE_FUNCTION, byId('aria-native-valid'), false),
    ).toMatchObject({ invalid: true });
    expect(call(DESCRIBE_FUNCTION, byId('native'), false)).toMatchObject({
      selectedOptions: [
        { value: 'a', label: 'Alpha option' },
        { value: 'b', label: 'Beta option' },
      ],
    });
    expect(call(DESCRIBE_FUNCTION, byId('editor'), false)).toMatchObject({
      value: 'line two',
    });
    expect(call(DESCRIBE_FUNCTION, byId('list'), false)).toMatchObject({
      selectedOptions: [{ value: '', label: 'Chosen label' }],
    });
    expect(call(DESCRIBE_FUNCTION, byId('combo'), false)).toMatchObject({
      value: 'typed query',
      selectedOptions: [{ value: '', label: 'Chosen label' }],
    });
  });

  it('reads an editor with a line break between blocks and at each br, as Enter makes them', () => {
    const cases: Array<[string, string]> = [
      ['<p>First line</p><p>second line</p>', 'First line\nsecond line'],
      ['<div>A</div><div><br></div><div>B</div>', 'A\n\nB'],
      ['A<br>B<br>', 'A\nB'],
      ['<p><span>The </span><span>model</span></p>', 'The model'],
      ['ends with&nbsp;', 'ends with '],
      ['<pre>kept\nbreak</pre>', 'kept\nbreak'],
      // A trailing line the user typed is kept; the <br> that holds an empty
      // block open is not a line of its own.
      ['A<div><br></div>', 'A\n'],
      ['A<div><br></div><div><br></div>', 'A\n\n'],
      ['A<br><br>', 'A\n'],
      ['A<br><br><br>', 'A\n\n'],
      ['<p>a</p><p></p><p>b</p>', 'a\n\nb'],
      ['<div><p>a</p></div>', 'a'],
      ['<div>A</div><div>B</div>', 'A\nB'],
    ];
    for (const [html, text] of cases) {
      const editor = element(
        `<div id="editor" contenteditable="true">${html}</div>`,
        'editor',
      );
      expect(call(EDITOR_TEXT_FUNCTION, editor)).toBe(text);
      expect(call(DESCRIBE_FUNCTION, editor, false)).toMatchObject({
        value: text,
      });
    }
  });

  it('reads the selection of a list that a combobox names inside its own shadow root', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host');
    if (!host) throw new Error('Missing #host');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<input id="combo" role="combobox" aria-controls="list"><div id="list" role="listbox"><div role="option" aria-selected="true">Lisbon</div></div>';
    const combo = root.getElementById('combo');
    if (!combo) throw new Error('Missing #combo');
    expect(call(DESCRIBE_FUNCTION, combo, false)).toMatchObject({
      selectedOptions: [{ value: 'Lisbon', label: 'Lisbon' }],
    });
  });

  it('reads the selection of an option that a combobox names directly', () => {
    document.body.innerHTML =
      '<div id="combo" role="combobox" aria-controls="only">Pick a city</div>' +
      '<div id="only" role="option" data-value="city" aria-selected="true">New York</div>';
    const combo = document.getElementById('combo');
    if (!combo) throw new Error('Missing #combo');
    expect(call(DESCRIBE_FUNCTION, combo, false)).toMatchObject({
      selectedOptions: [{ value: 'city', label: 'New York' }],
    });
  });

  it('does not read or return secret values, validation messages, or controlled-list options', () => {
    const secretInput = element(
      '<input id="secret" required aria-invalid="true">',
      'secret',
    );
    const readValue = jest.fn(() => 'private-value');
    const readMessage = jest.fn(() => 'private validation message');
    Object.defineProperty(secretInput, 'value', {
      configurable: true,
      get: readValue,
    });
    Object.defineProperty(secretInput, 'validationMessage', {
      configurable: true,
      get: readMessage,
    });
    const secretDescription = call(DESCRIBE_FUNCTION, secretInput, true);
    expect(secretDescription).toMatchObject({
      valueRedacted: true,
      invalid: true,
    });
    expect(secretDescription).not.toHaveProperty('value');
    expect(secretDescription).not.toHaveProperty('validationMessage');
    expect(readValue).not.toHaveBeenCalled();
    expect(readMessage).not.toHaveBeenCalled();

    const secretSelect = element(
      '<select id="secret-select"><option selected value="private-option">Private label</option></select>',
      'secret-select',
    );
    const readSelectedOptions = jest.fn(() => []);
    Object.defineProperty(secretSelect, 'selectedOptions', {
      configurable: true,
      get: readSelectedOptions,
    });
    const secretOption = secretSelect.querySelector('option');
    if (!secretOption) throw new Error('Missing secret option');
    const readOptionValue = jest.fn(() => 'private-option');
    const readOptionLabel = jest.fn(() => 'Private label');
    Object.defineProperty(secretOption, 'value', {
      configurable: true,
      get: readOptionValue,
    });
    Object.defineProperty(secretOption, 'label', {
      configurable: true,
      get: readOptionLabel,
    });
    const selectDescription = call(DESCRIBE_FUNCTION, secretSelect, true);
    expect(selectDescription).toMatchObject({
      valueRedacted: true,
      optionsRedacted: true,
    });
    expect(selectDescription).not.toHaveProperty('selectedOptions');
    expect(JSON.stringify(selectDescription)).not.toContain('private-option');
    expect(JSON.stringify(selectDescription)).not.toContain('Private label');
    expect(readSelectedOptions).not.toHaveBeenCalled();
    expect(readOptionValue).not.toHaveBeenCalled();
    expect(readOptionLabel).not.toHaveBeenCalled();

    const controlledCombo = element(
      '<div id="combo" role="combobox" aria-controls="secret-list">query</div><div id="secret-list" role="listbox"><div role="option" aria-selected="true" data-value="private-choice">Private choice</div></div>',
      'combo',
    );
    const controlledList = document.getElementById('secret-list');
    if (!controlledList) throw new Error('Missing secret list');
    const readListOptions = jest.spyOn(controlledList, 'querySelectorAll');
    const controlledDescription = call(
      DESCRIBE_FUNCTION,
      controlledCombo,
      true,
    );
    expect(controlledDescription).toMatchObject({
      valueRedacted: true,
      optionsRedacted: true,
    });
    expect(controlledDescription).not.toHaveProperty('selectedOptions');
    expect(JSON.stringify(controlledDescription)).not.toContain(
      'private-choice',
    );
    expect(JSON.stringify(controlledDescription)).not.toContain(
      'Private choice',
    );
    expect(readListOptions).not.toHaveBeenCalled();
  });
});
