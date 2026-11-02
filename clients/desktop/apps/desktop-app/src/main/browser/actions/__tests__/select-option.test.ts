import { JSDOM } from 'jsdom';
import type {
  BrowserActionError,
  BrowserInputOption,
} from '@canopy/desktop-shared/types/browser';
import type { BrowserCdpSend } from '../actionability';
import type { ActionLaneContext } from '../action-lane';
import type { ResolvedActionTarget } from '../../frames/action-targets';
import { FormActionError, type FormActionOptions } from '../form-action';
import { runSelectOption } from '../select-option';

interface Harness {
  dom: JSDOM;
  target: Element;
  options: FormActionOptions;
  send: jest.MockedFunction<BrowserCdpSend>;
  click: jest.MockedFunction<FormActionOptions['click']>;
  focus: jest.MockedFunction<FormActionOptions['focus']>;
  lane: ActionLaneContext;
  readonly dispatched: number;
  clicked: string[];
  events: string[];
  runtimeTimes: number[];
  clickTimes: number[];
}

interface HarnessOverrides {
  secret?: boolean;
  onFocus?: () => void;
  onClick?: (clickedTag: string) => void;
  abortAfterOpenMs?: number;
  optionClickError?: BrowserActionError['code'];
  missingOptionHandle?: boolean;
  /** Puts the markup in an open shadow root instead of the document. */
  inShadowRoot?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isElement(value: unknown): value is Element {
  return (
    typeof value === 'object' &&
    value !== null &&
    'nodeType' in value &&
    value.nodeType === 1 &&
    'tagName' in value &&
    'dispatchEvent' in value
  );
}

function pageArguments(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((item: unknown) =>
    isRecord(item) && 'value' in item ? item.value : undefined,
  );
}

function harness(markup: string, overrides: HarnessOverrides = {}): Harness {
  const dom = new JSDOM(markup, {
    url: 'https://example.test/',
    runScripts: 'outside-only',
  });
  let scope: Document | ShadowRoot = dom.window.document;
  if (overrides.inShadowRoot === true) {
    const host = dom.window.document.createElement('div');
    dom.window.document.body.replaceChildren(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = markup;
    scope = root;
  }
  const target = scope.querySelector('[data-target]');
  if (!target) throw new Error('Test markup needs a [data-target] element.');

  const objects = new Map<string, Element>([['target', target]]);
  const backendNodeIds = new Map<string, number>([['target', 11]]);
  let nextObject = 0;
  let nextBackend = 12;
  let dispatched = 0;
  const clicked: string[] = [];
  const events: string[] = [];
  const runtimeTimes: number[] = [];
  const clickTimes: number[] = [];
  const controller = new AbortController();
  const lane: ActionLaneContext = {
    signal: controller.signal,
    sequence: 1,
    beginDispatch: (): void => {
      dispatched += 1;
    },
    // The real lane refuses to track a command before input is sent.
    trackCommand: <T>(command: Promise<T>): Promise<T> => {
      if (dispatched === 0)
        throw new Error('Commands cannot be tracked before dispatch.');
      return command;
    },
    registerCleanup: (): void => undefined,
  };
  const send = jest.fn<ReturnType<BrowserCdpSend>, Parameters<BrowserCdpSend>>(
    (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'Runtime.callFunctionOn') {
        runtimeTimes.push(Date.now());
        const objectId = readString(params.objectId);
        const declaration = readString(params.functionDeclaration);
        const object = objectId ? objects.get(objectId) : undefined;
        if (!object || !declaration)
          return Promise.resolve({ exceptionDetails: {} });
        if (
          overrides.missingOptionHandle === true &&
          (declaration.includes('return rows[index] || null') ||
            declaration.includes(
              'return el.querySelectorAll(\'[role="option"]\')[index] || null',
            ))
        )
          return Promise.resolve({ result: { value: null } });
        Object.defineProperty(dom.window, '__canopyFormTarget', {
          configurable: true,
          value: object,
        });
        Object.defineProperty(dom.window, '__canopyFormArgs', {
          configurable: true,
          value: pageArguments(params.arguments),
        });
        const value: unknown = dom.window.eval(
          `(${declaration}).apply(window.__canopyFormTarget, window.__canopyFormArgs)`,
        );
        if (params.returnByValue === true)
          return Promise.resolve({ result: { value } });
        if (isElement(value)) {
          const childObjectId = `element-${++nextObject}`;
          objects.set(childObjectId, value);
          backendNodeIds.set(childObjectId, nextBackend++);
          return Promise.resolve({ result: { objectId: childObjectId } });
        }
        return Promise.resolve({ result: { value } });
      }
      if (method === 'DOM.describeNode') {
        const objectId = readString(params.objectId);
        const backendNodeId = objectId
          ? backendNodeIds.get(objectId)
          : undefined;
        return Promise.resolve(
          backendNodeId === undefined ? {} : { node: { backendNodeId } },
        );
      }
      if (method === 'Runtime.releaseObject') return Promise.resolve({});
      if (
        method === 'Input.dispatchKeyEvent' &&
        params.type === 'keyDown' &&
        typeof params.text === 'string'
      ) {
        events.push(`char:${params.text}`);
        const input =
          dom.window.document.querySelector<HTMLInputElement>('[data-target]');
        if (input) {
          input.value += params.text;
          input.dispatchEvent(
            new dom.window.InputEvent('input', { bubbles: true }),
          );
        }
        return Promise.resolve({});
      }
      return Promise.resolve({});
    },
  );
  const click = jest.fn<
    ReturnType<FormActionOptions['click']>,
    Parameters<FormActionOptions['click']>
  >((clickedTarget): Promise<{ completed: true; inputMode: 'trusted' }> => {
    const object = objects.get(clickedTarget.objectId);
    const clickedTag = object?.tagName.toLowerCase() ?? 'missing';
    if (
      clickedTag !== target.tagName.toLowerCase() &&
      overrides.optionClickError
    ) {
      throw new FormActionError({
        code: overrides.optionClickError,
        message: 'The option is no longer actionable.',
        retryable: false,
      });
    }
    lane.beginDispatch();
    clickTimes.push(Date.now());
    clicked.push(clickedTag);
    events.push(`click:${clickedTag}`);
    const input =
      dom.window.document.querySelector<HTMLInputElement>('[data-target]');
    input?.focus();
    object?.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    overrides.onClick?.(clickedTag);
    if (
      clickedTag === target.tagName.toLowerCase() &&
      overrides.abortAfterOpenMs !== undefined
    ) {
      setTimeout(() => controller.abort(), overrides.abortAfterOpenMs);
    }
    return Promise.resolve({ completed: true, inputMode: 'trusted' });
  });
  const focus = jest.fn<
    ReturnType<FormActionOptions['focus']>,
    Parameters<FormActionOptions['focus']>
  >(
    (): Promise<{
      focused: true;
      inputMode: 'trusted';
      completed: true;
    }> => {
      lane.beginDispatch();
      events.push('focus');
      target.dispatchEvent(new dom.window.FocusEvent('focus'));
      overrides.onFocus?.();
      return Promise.resolve({
        focused: true,
        inputMode: 'trusted',
        completed: true,
      });
    },
  );
  const resolvedTarget: ResolvedActionTarget = {
    identity: {
      frameId: 'frame-1',
      sessionId: 'session-1',
      loaderId: 'loader-1',
      backendNodeId: 11,
    },
    frameRef: 'frame-1',
    objectId: 'target',
    objectGroup: 'test-form-action',
    outOfProcess: false,
  };
  const options: FormActionOptions = {
    send,
    cleanupSend: send,
    lane,
    target: resolvedTarget,
    secret: overrides.secret ?? false,
    click,
    focus,
  };
  return {
    dom,
    target,
    options,
    send,
    click,
    focus,
    lane,
    get dispatched(): number {
      return dispatched;
    },
    clicked,
    events,
    runtimeTimes,
    clickTimes,
  };
}

function option(
  value: string,
  label: string,
  selected = false,
): BrowserInputOption {
  return { value, label, selected, disabled: false };
}

afterEach(() => {
  jest.useRealTimers();
});

describe('runSelectOption native select', () => {
  it('matches case-insensitively, deduplicates entries, selects a multiple set, and dispatches events', async () => {
    const h = harness(
      '<select data-target multiple><option value="red">Red</option><option value="blue">Blue</option><option value="green">Green</option></select>',
    );
    const select = h.dom.window.document.querySelector('select');
    const events: string[] = [];
    select?.addEventListener('input', () => events.push('input'));
    select?.addEventListener('change', () => events.push('change'));
    select?.addEventListener('blur', () => events.push('blur'));

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['RED', 'red', 'Blue'] },
    });

    expect(result.inputMode).toBe('direct');
    expect(result.target?.selectedOptions).toEqual([
      { value: 'red', label: 'Red' },
      { value: 'blue', label: 'Blue' },
    ]);
    expect(events).toEqual(['input', 'change', 'blur']);
    expect(h.click).not.toHaveBeenCalled();
  });

  it('matches a value no option has against the labels, as Playwright does', async () => {
    const h = harness(
      '<select data-target><option value="2">March</option><option value="3">April</option><option value="April">May</option></select>',
    );

    const byLabel = await runSelectOption({
      ...h.options,
      choice: { values: ['3'] },
    });
    expect(byLabel.target?.selectedOptions).toEqual([
      { value: '3', label: 'April' },
    ]);
    // A value wins over a label.
    const byValue = await runSelectOption({
      ...h.options,
      choice: { values: ['april'] },
    });
    expect(byValue.target?.selectedOptions).toEqual([
      { value: 'April', label: 'May' },
    ]);
    const fallback = await runSelectOption({
      ...h.options,
      choice: { values: [' march '] },
    });
    expect(fallback.target?.selectedOptions).toEqual([
      { value: '2', label: 'March' },
    ]);
  });

  it('returns without dispatch when the current selection already exactly matches', async () => {
    const h = harness(
      '<select data-target><option value="alpha">Alpha</option><option value="beta" selected>Beta</option></select>',
    );

    const result = await runSelectOption({
      ...h.options,
      choice: { labels: [' beta '] },
    });

    expect(result.inputMode).toBeUndefined();
    expect(result.target?.selectedOptions).toEqual([
      { value: 'beta', label: 'Beta' },
    ]);
    expect(h.dispatched).toBe(0);
  });

  it('refuses multiple distinct entries on a single select before dispatch', async () => {
    const h = harness(
      '<select data-target><option value="a">A</option><option value="b">B</option></select>',
    );

    await expect(
      runSelectOption({ ...h.options, choice: { values: ['a', 'b'] } }),
    ).rejects.toMatchObject({
      error: {
        code: 'unsupported_control',
        message: 'This select takes one option.',
      },
    });
    expect(h.dispatched).toBe(0);
  });

  it('returns up to fifty native candidates for a missing non-secret option', async () => {
    const rows = Array.from(
      { length: 51 },
      (_unused, index) => `<option value="v${index}">Option ${index}</option>`,
    ).join('');
    const h = harness(`<select data-target>${rows}</select>`);

    const missingChoiceError = await runSelectOption({
      ...h.options,
      choice: { values: ['missing'] },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(missingChoiceError).toBeInstanceOf(FormActionError);
    if (!(missingChoiceError instanceof FormActionError))
      throw new Error('Expected a pre-dispatch missing-choice refusal.');
    expect(missingChoiceError.error.code).toBe('option_not_found');
    expect(missingChoiceError.error.options?.[0]).toEqual(
      option('v0', 'Option 0', true),
    );
    expect(h.dispatched).toBe(0);
    const thrown = await runSelectOption({
      ...h.options,
      choice: { values: ['missing'] },
    }).catch((error: unknown) => error);
    expect(
      isRecord(thrown) &&
        isRecord(thrown.error) &&
        Array.isArray(thrown.error.options)
        ? thrown.error.options.length
        : 0,
    ).toBe(50);
  });

  it('refuses an option inside a disabled optgroup before dispatch and names it', async () => {
    const h = harness(
      '<select data-target><optgroup label="Closed" disabled><option value="secret-ish">Unavailable</option></optgroup></select>',
    );

    const disabledChoiceError = await runSelectOption({
      ...h.options,
      choice: { labels: ['unavailable'] },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(disabledChoiceError).toBeInstanceOf(FormActionError);
    if (!(disabledChoiceError instanceof FormActionError))
      throw new Error('Expected a pre-dispatch disabled-choice refusal.');
    expect(disabledChoiceError.error.code).toBe('target_disabled');
    expect(disabledChoiceError.message).toContain('Unavailable');
    expect(h.dispatched).toBe(0);
  });

  it('does not expose secret option values or labels in pre-dispatch errors', async () => {
    const h = harness(
      '<select data-target autocomplete="cc-exp-month"><option value="411-secret">Private Option</option></select>',
      { secret: true },
    );

    await expect(
      runSelectOption({ ...h.options, choice: { values: ['never-match'] } }),
    ).rejects.toMatchObject({
      error: {
        code: 'option_not_found',
        candidatesRedacted: true,
      },
    });
    const thrown = await runSelectOption({
      ...h.options,
      choice: { values: ['never-match'] },
    }).catch((error: unknown) => error);
    const message =
      isRecord(thrown) && isRecord(thrown.error)
        ? (readString(thrown.error.message) ?? '')
        : '';
    const keys =
      isRecord(thrown) && isRecord(thrown.error)
        ? Object.keys(thrown.error)
        : [];
    expect(message).not.toContain('Private Option');
    expect(message).not.toContain('411-secret');
    expect(keys).not.toContain('options');
    expect(h.dispatched).toBe(0);
  });

  it('focuses an empty placeholder select before polling its lazy options', async () => {
    let loaded = false;
    const h = harness(
      '<select data-target><option value="">Choose one</option></select>',
      {
        onFocus: () => {
          if (loaded) return;
          loaded = true;
          const select = h.dom.window.document.querySelector('select');
          const row = h.dom.window.document.createElement('option');
          row.value = 'late';
          row.textContent = 'Late option';
          select?.append(row);
        },
      },
    );

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['late'] },
    });

    expect(h.focus).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      inputMode: 'direct',
      target: { selectedOptions: [{ value: 'late', label: 'Late option' }] },
    });
  });

  it('preserves focus input mode when lazy options become already selected', async () => {
    const h = harness(
      '<select data-target><option value="">Choose one</option></select>',
      {
        onFocus: () => {
          const select = h.dom.window.document.querySelector('select');
          const row = h.dom.window.document.createElement('option');
          row.value = 'late';
          row.textContent = 'Late option';
          row.selected = true;
          select?.append(row);
        },
      },
    );

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['late'] },
    });

    expect(h.focus).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      inputMode: 'trusted',
      target: { selectedOptions: [{ value: 'late', label: 'Late option' }] },
    });
  });

  it('keeps polling after partial options appear until all choices match', async () => {
    jest.useFakeTimers();
    let ready = false;
    const h = harness(
      '<select data-target><option value="">Choose one</option></select>',
      {
        onFocus: () => {
          const select = h.dom.window.document.querySelector('select');
          const partial = h.dom.window.document.createElement('option');
          partial.value = 'partial';
          partial.textContent = 'Partial option';
          select?.append(partial);
          setTimeout(() => {
            if (ready) return;
            ready = true;
            const loaded = h.dom.window.document.querySelector('select');
            const row = h.dom.window.document.createElement('option');
            row.value = 'late';
            row.textContent = 'Late option';
            loaded?.append(row);
          }, 300);
        },
      },
    );
    const pending = runSelectOption({
      ...h.options,
      choice: { values: ['late'] },
    });

    await jest.advanceTimersByTimeAsync(500);
    const result = await pending;

    expect(h.focus).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      inputMode: 'direct',
      target: { selectedOptions: [{ value: 'late', label: 'Late option' }] },
    });
    jest.useRealTimers();
  });

  it.each([false, true])(
    'reports a lazy disabled match after focus as executed readback (secret=%s)',
    async (secret) => {
      const h = harness(
        '<select data-target><option value="">Choose one</option></select>',
        {
          secret,
          onFocus: () => {
            const row = h.dom.window.document.createElement('option');
            row.value = 'private-late';
            row.textContent = 'Private late option';
            row.disabled = true;
            h.target.append(row);
          },
        },
      );
      const result = await runSelectOption({
        ...h.options,
        choice: { values: ['private-late'] },
      });
      expect(result).toMatchObject({
        inputMode: 'trusted',
        readback: { code: 'state_unchanged' },
      });
      expect(h.focus).toHaveBeenCalledTimes(1);
      expect(h.click).not.toHaveBeenCalled();
      if (secret) {
        expect(result.target).toEqual({ optionsRedacted: true });
        expect(JSON.stringify(result)).not.toContain('Private late option');
        expect(JSON.stringify(result)).not.toContain('private-late');
      } else {
        expect(result.target?.options).toMatchObject([
          { value: '' },
          { value: 'private-late', disabled: true },
        ]);
        expect(result.warnings).toEqual([
          "The option 'Private late option' is disabled.",
        ]);
      }
    },
  );

  it('reports a lazy timeout after focus as an executed mismatch with options', async () => {
    jest.useFakeTimers();
    const h = harness(
      '<select data-target><option value="">Choose one</option></select>',
    );
    const pending = runSelectOption({
      ...h.options,
      choice: { values: ['late'] },
    });

    await jest.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(h.focus).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      inputMode: 'trusted',
      readback: { code: 'state_unchanged' },
      target: { options: [option('', 'Choose one', true)] },
      warnings: [expect.stringContaining('did not appear')],
    });
    expect(h.dispatched).toBeGreaterThan(0);
    jest.useRealTimers();
  });

  it('selects the requested option when focusing the select reorders its options', async () => {
    const h = harness(
      '<select data-target><option value="a">A</option><option value="b">B</option></select>',
    );
    const select = h.dom.window.document.querySelector('select');
    let reordered = false;
    select?.addEventListener('focus', () => {
      if (reordered || !select.options[0]) return;
      reordered = true;
      select.append(select.options[0]);
    });

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['b'] },
    });

    expect(reordered).toBe(true);
    expect(select?.value).toBe('b');
    expect(result).toMatchObject({
      target: { selectedOptions: [{ value: 'b', label: 'B' }] },
    });
    expect(result).not.toHaveProperty('readback');
  });

  it('reports a multiple select whose requested option is removed during the action', async () => {
    const h = harness(
      '<select data-target multiple><option value="a">A</option><option value="b">B</option></select>',
    );
    const select = h.dom.window.document.querySelector('select');
    select?.addEventListener('focus', () => {
      select.querySelector('option[value="b"]')?.remove();
    });

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['a', 'b'] },
    });

    expect(result).toMatchObject({ readback: { code: 'state_unchanged' } });
  });

  it('does not run the fallback when the requested option is gone after the first attempt', async () => {
    const h = harness(
      '<select data-target><option value="x">X</option><option value="y">Y</option></select>',
    );
    const select = h.dom.window.document.querySelector('select');
    let changes = 0;
    select?.addEventListener('change', () => {
      changes += 1;
      select.querySelector('option[value="y"]')?.remove();
    });

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['y'] },
    });

    expect(changes).toBe(1);
    expect(select?.value).toBe('x');
    expect(result).toMatchObject({
      inputMode: 'direct',
      readback: { code: 'state_unchanged' },
      warnings: ['The requested option is no longer available.'],
    });
  });

  it('keeps the label of an option out of every message when the select becomes secret on focus', async () => {
    const h = harness(
      '<select data-target><option value="">Choose a card</option></select>',
    );
    const select = h.dom.window.document.querySelector('select');
    select?.addEventListener('focus', () => {
      select.setAttribute('autocomplete', 'cc-number');
      select.insertAdjacentHTML(
        'beforeend',
        '<option value="4111111111111111" disabled>4111 1111 1111 1111</option>',
      );
    });

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['4111111111111111'] },
    });

    expect(result).toMatchObject({
      readback: { code: 'state_unchanged' },
      target: { optionsRedacted: true },
    });
    expect(JSON.stringify(result)).not.toContain('4111 1111 1111 1111');
  });

  it('tells the service when a select is secret only while the action runs', async () => {
    const h = harness(
      '<select data-target><option value="">Choose</option><option value="private-name">Private Person</option></select>',
    );
    const select = h.dom.window.document.querySelector('select');
    // Secret from focus to input: before the action and after it, it is not.
    select?.addEventListener('focus', () =>
      select.setAttribute('autocomplete', 'cc-name'),
    );
    select?.addEventListener('input', () =>
      select.removeAttribute('autocomplete'),
    );
    const markSecret = jest.fn();

    const result = await runSelectOption({
      ...h.options,
      markSecret,
      choice: { values: ['private-name'] },
    });

    expect(select?.value).toBe('private-name');
    expect(select?.hasAttribute('autocomplete')).toBe(false);
    expect(markSecret).toHaveBeenCalled();
    expect(result).toMatchObject({ target: { optionsRedacted: true } });
    expect(JSON.stringify(result)).not.toContain('Private Person');
    expect(JSON.stringify(result)).not.toContain('private-name');
  });

  it('keeps the option an index chose when focusing the select reorders its options', async () => {
    const h = harness(
      '<select data-target><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>',
    );
    const select = h.dom.window.document.querySelector('select');
    let moved = false;
    let changes = 0;
    select?.addEventListener('focus', () => {
      if (moved || !select.options[0]) return;
      moved = true;
      select.append(select.options[0]);
    });
    select?.addEventListener('change', () => {
      changes += 1;
    });

    const result = await runSelectOption({
      ...h.options,
      choice: { indexes: [1] },
    });

    expect(moved).toBe(true);
    expect(select?.value).toBe('b');
    expect(changes).toBe(1);
    expect(result).toMatchObject({
      target: { selectedOptions: [{ value: 'b', label: 'B' }] },
    });
    expect(result).not.toHaveProperty('readback');
  });

  it.each([
    [
      'itself',
      '<select data-target aria-disabled="true"><option value="a" selected>A</option><option value="b">B</option></select>',
    ],
    [
      'an ancestor',
      '<div aria-disabled="true"><select data-target><option value="a" selected>A</option><option value="b">B</option></select></div>',
    ],
  ])(
    'refuses a select marked aria-disabled on %s before any input',
    async (_case, markup) => {
      const h = harness(markup);
      const select = h.dom.window.document.querySelector('select');

      const refused = await runSelectOption({
        ...h.options,
        choice: { values: ['b'] },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(refused).toBeInstanceOf(FormActionError);
      if (!(refused instanceof FormActionError))
        throw new Error('Expected a refusal before input.');
      expect(refused.error.code).toBe('target_disabled');
      expect(h.dispatched).toBe(0);
      expect(select?.value).toBe('a');
    },
  );

  it.each([false, true])(
    'changes nothing when focusing the select removes the requested option (multiple: %s)',
    async (multiple) => {
      const h = harness(
        multiple
          ? '<select data-target multiple><option value="a" selected>A</option><option value="b">B</option></select>'
          : '<select data-target><option value="a" selected>A</option><option value="b">B</option></select>',
      );
      const select = h.dom.window.document.querySelector('select');
      let changes = 0;
      select?.addEventListener('focus', () => {
        select.querySelector('option[value="b"]')?.remove();
      });
      select?.addEventListener('change', () => {
        changes += 1;
      });

      const result = await runSelectOption({
        ...h.options,
        choice: { values: ['b'] },
      });

      expect(changes).toBe(0);
      expect(select?.value).toBe('a');
      expect(select?.options[0]?.selected).toBe(true);
      expect(result).toMatchObject({ readback: { code: 'state_unchanged' } });
    },
  );

  it.each(['select', 'option', 'optgroup'] as const)(
    'changes nothing when focusing the select disables the %s',
    async (disabled) => {
      const h = harness(
        '<select data-target><option value="a" selected>A</option><optgroup label="More"><option value="b">B</option></optgroup></select>',
      );
      const select = h.dom.window.document.querySelector('select');
      let changes = 0;
      select?.addEventListener('focus', () => {
        if (disabled === 'select') select.disabled = true;
        const option = select.querySelector('option[value="b"]');
        if (
          disabled === 'option' &&
          option instanceof h.dom.window.HTMLOptionElement
        )
          option.disabled = true;
        if (disabled === 'optgroup')
          select.querySelector('optgroup')?.setAttribute('disabled', '');
      });
      select?.addEventListener('change', () => {
        changes += 1;
      });

      const result = await runSelectOption({
        ...h.options,
        choice: { values: ['b'] },
      });

      expect(changes).toBe(0);
      expect(select?.value).toBe('a');
      expect(result).toMatchObject({ readback: { code: 'state_unchanged' } });
    },
  );

  it('selects the requested option when the fallback mousedown moves it', async () => {
    const h = harness(
      '<select data-target><option value="a" selected>A</option><option value="b">B</option><option value="c">C</option></select>',
    );
    const select = h.dom.window.document.querySelector('select');
    const changed: string[] = [];
    select?.addEventListener('change', () => {
      changed.push(select.value);
      if (changed.length === 1) select.value = 'a';
    });
    select?.addEventListener('mousedown', () => {
      const b = select.querySelector('option[value="b"]');
      if (b) select.append(b);
    });

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['b'] },
    });

    expect(changed).toEqual(['b', 'b']);
    expect(select?.value).toBe('b');
    expect(result).toMatchObject({
      target: { selectedOptions: [{ value: 'b', label: 'B' }] },
    });
    expect(result).not.toHaveProperty('readback');
  });

  it('changes nothing when the fallback mousedown removes the requested option', async () => {
    const h = harness(
      '<select data-target><option value="a" selected>A</option><option value="b">B</option><option value="c">C</option></select>',
    );
    const select = h.dom.window.document.querySelector('select');
    const changed: string[] = [];
    select?.addEventListener('change', () => {
      changed.push(select.value);
      if (changed.length === 1) select.value = 'a';
    });
    select?.addEventListener('mousedown', () => {
      select.querySelector('option[value="b"]')?.remove();
    });

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['b'] },
    });

    expect(changed).toEqual(['b']);
    expect(select?.value).toBe('a');
    expect(result).toMatchObject({ readback: { code: 'state_unchanged' } });
  });

  it('uses the native single-select fallback after a reverted direct selection', async () => {
    const h = harness(
      '<select data-target><option value="a">A</option><option value="b">B</option></select>',
    );
    const select = h.dom.window.document.querySelector('select');
    let changes = 0;
    const events: string[] = [];
    select?.addEventListener('mousedown', () => events.push('mousedown'));
    select?.addEventListener('mouseup', () => events.push('mouseup'));
    select?.options[1]?.addEventListener('click', () =>
      events.push('option-click'),
    );
    select?.addEventListener('change', () => {
      changes += 1;
      events.push(`change-${changes}`);
      if (changes === 1 && select.options[0]) select.selectedIndex = 0;
    });

    const result = await runSelectOption({
      ...h.options,
      choice: { indexes: [1] },
    });

    expect(result).toMatchObject({
      inputMode: 'direct',
      target: { selectedOptions: [{ value: 'b', label: 'B' }] },
    });
    expect(events).toEqual([
      'change-1',
      'mousedown',
      'option-click',
      'mouseup',
      'change-2',
    ]);
  });

  it('verifies the direct select result after a page reaction before returning success', async () => {
    jest.useFakeTimers();
    const h = harness(
      '<select data-target><option value="a">A</option><option value="b">B</option></select>',
    );
    const select = h.dom.window.document.querySelector('select');
    let reverts = 0;
    select?.addEventListener('change', () => {
      if (select.selectedIndex !== 1) return;
      setTimeout(() => {
        reverts += 1;
        select.selectedIndex = 0;
      }, 16);
    });
    const pending = runSelectOption({
      ...h.options,
      choice: { indexes: [1] },
    });

    await jest.advanceTimersByTimeAsync(200);
    const result = await pending;

    expect(reverts).toBeGreaterThan(0);
    expect(
      h.send.mock.calls.some(
        ([method, params]) =>
          method === 'Runtime.callFunctionOn' &&
          readString(params.functionDeclaration)?.includes(
            'select.selectedIndex = current',
          ),
      ),
    ).toBe(true);
    expect(result).toMatchObject({
      readback: { code: 'state_unchanged' },
      target: { selectedOptions: [{ value: 'a', label: 'A' }] },
      warnings: [expect.any(String)],
    });
    jest.useRealTimers();
  });

  it('checks fresh selection after the single-select fallback reacts asynchronously', async () => {
    jest.useFakeTimers();
    const h = harness(
      '<select data-target><option value="a">A</option><option value="b">B</option></select>',
    );
    const select = h.dom.window.document.querySelector('select');
    let changes = 0;
    select?.addEventListener('change', () => {
      changes += 1;
      if (changes === 1) {
        select.selectedIndex = 0;
      } else if (select.selectedIndex === 1) {
        setTimeout(() => {
          select.selectedIndex = 0;
        }, 16);
      }
    });
    const pending = runSelectOption({
      ...h.options,
      choice: { indexes: [1] },
    });

    await jest.advanceTimersByTimeAsync(200);
    const result = await pending;

    expect(changes).toBe(2);
    expect(result).toMatchObject({
      readback: { code: 'state_unchanged' },
      target: { selectedOptions: [{ value: 'a', label: 'A' }] },
      warnings: [expect.any(String)],
    });
    jest.useRealTimers();
  });

  it('sets userGesture on each native mutation and leaves read calls unfenced', async () => {
    const h = harness(
      '<select data-target><option value="a">A</option><option value="b">B</option></select>',
    );
    const select = h.dom.window.document.querySelector('select');
    let changes = 0;
    select?.addEventListener('change', () => {
      changes += 1;
      if (changes === 1 && select.options[0]) select.selectedIndex = 0;
    });

    await runSelectOption({ ...h.options, choice: { values: ['b'] } });

    const runtimeCalls = h.send.mock.calls.filter(
      ([method]) => method === 'Runtime.callFunctionOn',
    );
    const mutations = runtimeCalls.filter(([, params]) => {
      const declaration = readString(params.functionDeclaration) ?? '';
      return (
        declaration.includes('select.focus()') ||
        declaration.includes('select.selectedIndex = current')
      );
    });
    const reads = runtimeCalls.filter(([, params]) => {
      const declaration = readString(params.functionDeclaration) ?? '';
      return (
        !declaration.includes('select.focus()') &&
        !declaration.includes('select.selectedIndex = current')
      );
    });
    expect(mutations.length).toBeGreaterThan(0);
    expect(mutations.length).toBeGreaterThanOrEqual(2);
    expect(mutations.every(([, params]) => params.userGesture === true)).toBe(
      true,
    );
    expect(reads.every(([, params]) => params.userGesture === undefined)).toBe(
      true,
    );
  });

  it.each([
    [
      'native select',
      '<select data-target disabled><option value="a">A</option></select>',
      { values: ['a'] },
    ],
    [
      'ARIA listbox',
      '<div data-target role="listbox" aria-disabled="true"><div role="option" data-value="a">A</div></div>',
      { values: ['a'] },
    ],
  ])('refuses a disabled %s before dispatch', async (_name, markup, choice) => {
    const h = harness(markup);

    await expect(
      runSelectOption({ ...h.options, choice }),
    ).rejects.toMatchObject({ error: { code: 'target_disabled' } });
    expect(h.dispatched).toBe(0);
  });

  it('uses the per-option multiple-select fallback, never selectedIndex, after a revert', async () => {
    const h = harness(
      '<select data-target multiple><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>',
    );
    const select = h.dom.window.document.querySelector('select');
    let changes = 0;
    const events: string[] = [];
    select?.addEventListener('mousedown', () => events.push('mousedown'));
    select?.addEventListener('change', () => {
      changes += 1;
      events.push(`change-${changes}`);
      if (changes === 1) {
        for (const row of Array.from(select.options)) row.selected = false;
      }
    });

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['a', 'c'] },
    });

    expect(result.target?.selectedOptions).toEqual([
      { value: 'a', label: 'A' },
      { value: 'c', label: 'C' },
    ]);
    expect(events).toEqual(['change-1', 'change-2']);
  });
});

describe('runSelectOption ARIA controls', () => {
  it('performs listbox no-match and disabled checks before the dispatch boundary', async () => {
    const h = harness(
      '<div data-target role="listbox"><div role="option" aria-selected="false">One</div><div role="option" aria-disabled="true">Unavailable</div></div>',
    );

    const missingChoiceError = await runSelectOption({
      ...h.options,
      choice: { labels: ['missing'] },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(missingChoiceError).toBeInstanceOf(FormActionError);
    if (!(missingChoiceError instanceof FormActionError))
      throw new Error('Expected a pre-dispatch missing-choice refusal.');
    expect(missingChoiceError.error.code).toBe('option_not_found');
    // An option without a value attribute is known by its label.
    expect(missingChoiceError.error.options?.[0]).toEqual(option('One', 'One'));
    expect(h.dispatched).toBe(0);
    const disabledChoiceError = await runSelectOption({
      ...h.options,
      choice: { labels: ['unavailable'] },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(disabledChoiceError).toBeInstanceOf(FormActionError);
    if (!(disabledChoiceError instanceof FormActionError))
      throw new Error('Expected a pre-dispatch disabled-choice refusal.');
    expect(disabledChoiceError.error.code).toBe('target_disabled');
    expect(disabledChoiceError.message).toContain('Unavailable');
    expect(h.dispatched).toBe(0);
  });

  it('returns without input when a listbox option is already selected', async () => {
    const h = harness(
      '<div data-target role="listbox"><div role="option" data-value="item" aria-selected="true">Item</div></div>',
    );

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['item'] },
    });

    expect(result.inputMode).toBeUndefined();
    expect(result.target?.selectedOptions).toEqual([
      { value: 'item', label: 'Item' },
    ]);
    expect(h.click).not.toHaveBeenCalled();
    expect(h.dispatched).toBe(0);
  });

  it('does not click an already-selected requested option in a multi-selectable listbox', async () => {
    const h = harness(
      '<div data-target role="listbox" aria-multiselectable="true"><div role="option" data-value="item" aria-selected="true">Item</div><div role="option" data-value="other" aria-selected="true">Other</div></div>',
    );

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['item'] },
    });

    expect(result.inputMode).toBeUndefined();
    expect(result.target?.selectedOptions).toEqual([
      { value: 'item', label: 'Item' },
      { value: 'other', label: 'Other' },
    ]);
    expect(h.click).not.toHaveBeenCalled();
    expect(h.dispatched).toBe(0);
  });

  it('clicks a listbox option and verifies selection without writing ARIA state', async () => {
    const h = harness(
      '<div data-target role="listbox"><div role="option" data-value="item" aria-selected="false">Item</div></div>',
    );
    const row = h.dom.window.document.querySelector('[role="option"]');
    row?.addEventListener('click', () => {
      row.setAttribute('aria-selected', 'true');
    });

    const result = await runSelectOption({
      ...h.options,
      choice: { labels: ['item'] },
    });

    expect(h.clicked).toEqual(['div']);
    expect(result).toMatchObject({
      inputMode: 'trusted',
      target: { selectedOptions: [{ value: 'item', label: 'Item' }] },
    });
  });

  it('reports a post-click mismatch as executed with readback and live options', async () => {
    const h = harness(
      '<div data-target role="listbox"><div role="option" data-value="item" aria-selected="false">Item</div></div>',
    );
    h.click.mockImplementationOnce(
      (): Promise<{
        completed: true;
        inputMode: 'trusted';
      }> => {
        h.lane.beginDispatch();
        return Promise.resolve({ completed: true, inputMode: 'trusted' });
      },
    );

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['item'] },
    });

    expect(result).toMatchObject({
      inputMode: 'trusted',
      readback: { code: 'state_unchanged' },
      target: { options: [option('item', 'Item', false)] },
      warnings: [expect.any(String)],
    });
  });

  it('opens a combobox, types searchText, clicks the option, and verifies selection', async () => {
    const h = harness(
      '<input data-target role="combobox" aria-controls="choices"><div id="choices" role="listbox"><div role="option" data-value="city" aria-selected="false">New York</div></div>',
    );
    const row = h.dom.window.document.querySelector('[role="option"]');
    row?.addEventListener('click', () => {
      row.setAttribute('aria-selected', 'true');
    });

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['city'] },
      searchText: 'New',
    });

    expect(h.events).toEqual([
      'click:input',
      'char:N',
      'char:e',
      'char:w',
      'click:div',
    ]);
    expect(result).toMatchObject({
      inputMode: 'trusted',
      target: { selectedOptions: [{ value: 'city', label: 'New York' }] },
    });
  });

  it('verifies a combobox choice by its value after the popup unmounts on select', async () => {
    const h = harness(
      '<input data-target role="combobox" aria-controls="choices"><div id="choices" role="listbox"><div role="option" data-value="city" aria-selected="false">New York</div></div>',
    );
    const document = h.dom.window.document;
    document.querySelector('[role="option"]')?.addEventListener('click', () => {
      const input = document.querySelector<HTMLInputElement>('[data-target]');
      if (input) input.value = 'New York';
      document.getElementById('choices')?.remove();
    });

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['city'] },
    });

    expect(h.clicked).toEqual(['input', 'div']);
    expect(result).toMatchObject({ inputMode: 'trusted' });
    expect(result).not.toHaveProperty('readback');
    expect(result).not.toHaveProperty('warnings');
  });

  it('still reports a combobox whose popup unmounted without taking the choice', async () => {
    const h = harness(
      '<input data-target role="combobox" aria-controls="choices"><div id="choices" role="listbox"><div role="option" data-value="city" aria-selected="false">New York</div></div>',
    );
    const document = h.dom.window.document;
    document.querySelector('[role="option"]')?.addEventListener('click', () => {
      document.getElementById('choices')?.remove();
    });

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['city'] },
    });

    expect(result).toMatchObject({
      inputMode: 'trusted',
      readback: { code: 'state_unchanged' },
    });
  });

  it('finds the list a combobox names inside its own shadow root', async () => {
    const h = harness(
      '<input data-target role="combobox" aria-controls="choices"><div id="choices" role="listbox"><div role="option" data-value="city" aria-selected="false">New York</div></div>',
      { inShadowRoot: true },
    );
    const root = h.target.getRootNode();
    const row =
      root instanceof h.dom.window.ShadowRoot
        ? root.querySelector('[role="option"]')
        : null;
    row?.addEventListener('click', () => {
      row.setAttribute('aria-selected', 'true');
      h.target.setAttribute('value', 'New York');
    });

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['city'] },
    });

    expect(h.clicked).toEqual(['input', 'div']);
    expect(result).toMatchObject({
      inputMode: 'trusted',
      target: { selectedOptions: [{ value: 'city', label: 'New York' }] },
    });
    expect(result).not.toHaveProperty('readback');
  });

  it('matches an ARIA option with no value attribute by the label the snapshot gives as its value', async () => {
    const h = harness(
      '<div data-target role="listbox"><div role="option" aria-selected="false">Portugal</div></div>',
    );
    const row = h.dom.window.document.querySelector('[role="option"]');
    row?.addEventListener('click', () => {
      row.setAttribute('aria-selected', 'true');
    });

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['Portugal'] },
    });

    expect(h.clicked).toEqual(['div']);
    expect(result).toMatchObject({
      inputMode: 'trusted',
      target: { selectedOptions: [{ value: 'Portugal', label: 'Portugal' }] },
    });
  });

  it.each([
    [
      'a popup that is not a listbox',
      '<input data-target role="combobox" aria-controls="popup"><div id="popup"><div role="option" data-value="city" aria-selected="false">New York</div></div>',
    ],
    [
      'an option outside the inner listbox',
      '<input data-target role="combobox" aria-controls="popup"><div id="popup"><div role="option" data-value="first" aria-selected="false">First</div><div role="listbox"><div role="option" data-value="city" aria-selected="false">New York</div></div></div>',
    ],
  ])('clicks the option it matched in %s', async (_case, markup) => {
    const h = harness(markup);
    const row = h.dom.window.document.querySelector('[data-value="city"]');
    row?.addEventListener('click', () => {
      row.setAttribute('aria-selected', 'true');
      h.target.setAttribute('value', 'New York');
    });

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['city'] },
    });

    expect(h.clicked).toEqual(['input', 'div']);
    expect(row?.getAttribute('aria-selected')).toBe('true');
    expect(result).toMatchObject({
      inputMode: 'trusted',
      target: { selectedOptions: [{ value: 'city', label: 'New York' }] },
    });
    expect(result).not.toHaveProperty('readback');
  });

  it('chooses in an already open combobox without clicking it closed', async () => {
    const h = harness(
      '<input data-target role="combobox" aria-controls="choices" aria-expanded="true"><div id="choices" role="listbox"><div role="option" data-value="city" aria-selected="false">New York</div></div>',
    );
    const document = h.dom.window.document;
    const list = document.getElementById('choices');
    h.target.addEventListener('click', () => {
      const open = h.target.getAttribute('aria-expanded') === 'true';
      h.target.setAttribute('aria-expanded', open ? 'false' : 'true');
      if (list) list.hidden = open;
    });
    const row = document.querySelector('[role="option"]');
    row?.addEventListener('click', () => {
      row.setAttribute('aria-selected', 'true');
      h.target.setAttribute('value', 'New York');
    });

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['city'] },
    });

    expect(h.clicked).toEqual(['div']);
    expect(result).toMatchObject({
      inputMode: 'trusted',
      target: { selectedOptions: [{ value: 'city', label: 'New York' }] },
    });
    expect(result).not.toHaveProperty('readback');
  });

  describe('a combobox that marks its highlighted option with aria-selected', () => {
    /**
     * The top match is highlighted when the list opens and after each
     * search change, unless the field already shows an option. A click on
     * an option puts its label in the field and closes the list.
     */
    function highlighting(
      shown = '',
      accepts = true,
    ): {
      h: Harness;
      input: HTMLInputElement;
      clicks: () => number;
      open: () => void;
    } {
      const h = harness(
        `<input data-target role="combobox" aria-controls="states" aria-expanded="false" value="${shown}"><div id="states" role="listbox" hidden></div>`,
      );
      const document = h.dom.window.document;
      const list = document.getElementById('states');
      const input = h.target;
      if (!list || !(input instanceof h.dom.window.HTMLInputElement))
        throw new Error('Missing combobox');
      const states = ['Alabama', 'Alaska', 'Arizona'];
      let clicks = 0;
      const open = (): void => {
        const text = input.value.toLowerCase();
        const committed = states.find((state) => state.toLowerCase() === text);
        const matches = committed
          ? states
          : states.filter((state) => state.toLowerCase().startsWith(text));
        list.replaceChildren(
          ...matches.map((state, index) => {
            const row = document.createElement('div');
            row.setAttribute('role', 'option');
            row.setAttribute(
              'aria-selected',
              String(committed ? state === committed : index === 0),
            );
            row.textContent = state;
            row.addEventListener('click', () => {
              clicks += 1;
              // A page that does not accept the click leaves the list open
              // and the option highlighted.
              if (!accepts) return;
              input.value = state;
              list.hidden = true;
              list.replaceChildren();
              input.setAttribute('aria-expanded', 'false');
            });
            return row;
          }),
        );
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
      };
      input.addEventListener('click', open);
      input.addEventListener('input', open);
      return { h, input, clicks: () => clicks, open };
    }

    it('clicks the highlighted top match after the search text is typed', async () => {
      const { h, input, clicks } = highlighting();

      const result = await runSelectOption({
        ...h.options,
        choice: { labels: ['Alabama'] },
        searchText: 'Ala',
      });

      expect(clicks()).toBe(1);
      expect(input.value).toBe('Alabama');
      expect(result).not.toHaveProperty('readback');
    });

    it('clicks the option highlighted when the list opens', async () => {
      const { h, input, clicks } = highlighting();

      const result = await runSelectOption({
        ...h.options,
        choice: { labels: ['Alabama'] },
      });

      expect(clicks()).toBe(1);
      expect(input.value).toBe('Alabama');
      expect(result).not.toHaveProperty('readback');
    });

    it('clicks the highlighted option of a combobox that starts open', async () => {
      const { h, input, clicks, open } = highlighting();
      open();

      const result = await runSelectOption({
        ...h.options,
        choice: { labels: ['Alabama'] },
      });

      expect(h.clicked).toEqual(['div']);
      expect(clicks()).toBe(1);
      expect(input.value).toBe('Alabama');
      expect(result).not.toHaveProperty('readback');
    });

    it('does not take search text it typed as the shown value', async () => {
      const { h, input, clicks } = highlighting();

      const result = await runSelectOption({
        ...h.options,
        choice: { labels: ['Alabama'] },
        searchText: 'Alabama',
      });

      expect(clicks()).toBe(1);
      expect(input.value).toBe('Alabama');
      expect(result).not.toHaveProperty('readback');
    });

    it.each([
      ['a search for part of the label', 'Ala'],
      ['a search for the whole label', 'Alabama'],
      ['no search', undefined],
    ])(
      'reports the choice unchanged when the page does not accept the click, after %s',
      async (_name, searchText) => {
        const { h, input, clicks } = highlighting('', false);

        const result = await runSelectOption({
          ...h.options,
          choice: { labels: ['Alabama'] },
          ...(searchText === undefined ? {} : { searchText }),
        });

        expect(clicks()).toBe(1);
        expect(input.value).toBe(searchText ?? '');
        expect(result).toMatchObject({
          readback: { code: 'state_unchanged' },
        });
      },
    );

    it('does not click an option the combobox already shows as its value', async () => {
      const { h, input, clicks } = highlighting('Alaska');

      const result = await runSelectOption({
        ...h.options,
        choice: { labels: ['Alaska'] },
      });

      expect(clicks()).toBe(0);
      expect(input.value).toBe('Alaska');
      expect(result).toMatchObject({
        target: { selectedOptions: [{ label: 'Alaska' }] },
      });
      expect(result).not.toHaveProperty('readback');
    });
  });

  it('confirms a combobox choice by aria-selected once the list has closed, when two options share a label', async () => {
    const h = harness(
      '<input data-target role="combobox" aria-controls="people" aria-expanded="true"><div id="people" role="listbox"><div role="option" data-value="a" aria-selected="false">Alex</div><div role="option" data-value="b" aria-selected="false">Alex</div></div>',
    );
    const document = h.dom.window.document;
    const list = document.getElementById('people');
    for (const row of Array.from(document.querySelectorAll('[role="option"]')))
      row.addEventListener('click', () => {
        row.setAttribute('aria-selected', 'true');
        if (list) list.hidden = true;
        h.target.setAttribute('aria-expanded', 'false');
      });

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['b'] },
    });

    expect(h.clicked).toEqual(['div']);
    expect(result).toMatchObject({
      target: { selectedOptions: [{ value: 'b', label: 'Alex' }] },
    });
    expect(result).not.toHaveProperty('readback');
  });

  it('confirms a clicked option by aria-selected in a combobox whose list takes several options', async () => {
    const h = harness(
      '<input data-target role="combobox" aria-controls="tags" aria-expanded="true"><div id="tags" role="listbox" aria-multiselectable="true"><div role="option" aria-selected="true">Red</div><div role="option" aria-selected="false">Blue</div></div>',
    );
    const rows = Array.from(
      h.dom.window.document.querySelectorAll('[role="option"]'),
    );
    for (const row of rows)
      row.addEventListener('click', () =>
        row.setAttribute('aria-selected', 'true'),
      );

    const result = await runSelectOption({
      ...h.options,
      choice: { labels: ['Blue'] },
    });

    expect(h.clicked).toEqual(['div']);
    expect(result).not.toHaveProperty('readback');
  });

  it('does not click a chosen option in a combobox whose list takes several options', async () => {
    const h = harness(
      '<input data-target role="combobox" aria-controls="tags" aria-expanded="true"><div id="tags" role="listbox" aria-multiselectable="true"><div role="option" aria-selected="true">Red</div><div role="option" aria-selected="false">Blue</div></div>',
    );
    const rows = Array.from(
      h.dom.window.document.querySelectorAll('[role="option"]'),
    );
    // A click toggles the option, so a click on a chosen one would clear it.
    for (const row of rows)
      row.addEventListener('click', () =>
        row.setAttribute(
          'aria-selected',
          String(row.getAttribute('aria-selected') !== 'true'),
        ),
      );

    const result = await runSelectOption({
      ...h.options,
      choice: { labels: ['Red'] },
    });

    expect(h.clicked).toEqual([]);
    expect(rows[0]?.getAttribute('aria-selected')).toBe('true');
    expect(result).toMatchObject({
      target: { selectedOptions: [{ label: 'Red' }] },
    });
    expect(result).not.toHaveProperty('readback');
  });

  it('refuses a missing option in an already open combobox before any input', async () => {
    const h = harness(
      '<input data-target role="combobox" aria-controls="choices" aria-expanded="true"><div id="choices" role="listbox"><div role="option" data-value="city" aria-selected="false">New York</div></div>',
    );

    const refused = await runSelectOption({
      ...h.options,
      choice: { values: ['missing'] },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(FormActionError);
    if (!(refused instanceof FormActionError))
      throw new Error('Expected a refusal before input.');
    expect(refused.error.code).toBe('option_not_found');
    expect(h.dispatched).toBe(0);
    expect(h.clicked).toEqual([]);
  });

  it.each([
    [
      'the list itself',
      '<input data-target role="combobox" aria-controls="cards"><div id="slot"></div>',
      'slot',
      '<div id="cards" role="listbox" autocomplete="cc-number"><div role="option" aria-disabled="true">4111 1111 1111 1111</div></div>',
    ],
    [
      'a listbox inside the named container',
      '<input data-target role="combobox" aria-controls="cards"><div id="cards"></div>',
      'cards',
      '<div role="listbox" autocomplete="cc-number"><div role="option" aria-disabled="true">4111 1111 1111 1111</div></div>',
    ],
  ])(
    'keeps the labels of a secret list that appears when the combobox opens out of every message: %s',
    async (_case, markup, slotId, opened) => {
      const h = harness(markup);
      const document = h.dom.window.document;
      h.target.addEventListener('click', () => {
        const slot = document.getElementById(slotId);
        if (slot) slot.innerHTML = opened;
      });

      const result = await runSelectOption({
        ...h.options,
        choice: { indexes: [0] },
      });

      expect(result).toMatchObject({
        inputMode: 'trusted',
        readback: { code: 'state_unchanged' },
        target: { optionsRedacted: true },
      });
      expect(JSON.stringify(result)).not.toContain('4111 1111 1111 1111');
    },
  );

  it('types no search text when opening the combobox moved focus elsewhere', async () => {
    const h = harness(
      '<input data-target role="combobox" aria-controls="choices"><div id="choices" role="listbox"><div role="option" data-value="city" aria-selected="false">New York</div></div><input id="other" value="original">',
    );
    const other = h.dom.window.document.getElementById('other');
    h.target.addEventListener('click', () => other?.focus());

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['city'] },
      searchText: 'query',
    });

    expect(h.events.filter((event) => event.startsWith('char:'))).toEqual([]);
    expect(result).toMatchObject({
      inputMode: 'trusted',
      readback: { code: 'state_unchanged' },
      warnings: [
        'The combobox did not keep focus, so the search text was not typed.',
      ],
    });
  });

  it('keeps the labels of a list that a separate secret control names out of every message', async () => {
    const h = harness(
      '<input autocomplete="cc-number" aria-controls="cards"><input data-target role="combobox" aria-controls="cards"><div id="cards"></div>',
    );
    const document = h.dom.window.document;
    h.target.addEventListener('click', () => {
      const cards = document.getElementById('cards');
      if (cards)
        cards.innerHTML =
          '<div role="option" aria-disabled="true">4111 1111 1111 1111</div>';
    });

    const result = await runSelectOption({
      ...h.options,
      choice: { indexes: [0] },
    });

    expect(result).toMatchObject({
      readback: { code: 'state_unchanged' },
      target: { optionsRedacted: true },
    });
    expect(JSON.stringify(result)).not.toContain('4111 1111 1111 1111');
  });

  it('tells the service when the list a combobox opens is secret on the page', async () => {
    const h = harness(
      '<input autocomplete="cc-number" aria-controls="cards"><input data-target role="combobox" aria-controls="cards"><div id="cards"></div>',
    );
    const document = h.dom.window.document;
    h.target.addEventListener('click', () => {
      const cards = document.getElementById('cards');
      if (!cards) return;
      cards.innerHTML = '<div role="option">4111 1111 1111 1111</div>';
      const row = cards.querySelector('[role="option"]');
      row?.addEventListener('click', () =>
        row.setAttribute('aria-selected', 'true'),
      );
    });
    const markSecret = jest.fn();

    const result = await runSelectOption({
      ...h.options,
      markSecret,
      choice: { indexes: [0] },
    });

    expect(markSecret).toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('4111 1111 1111 1111');
  });

  it('asks the page model again once the combobox is open, and keeps its labels out of every message when it says secret', async () => {
    const h = harness(
      '<input data-target role="combobox" aria-controls="choices"><div id="choices"></div>',
    );
    const document = h.dom.window.document;
    h.target.addEventListener('click', () => {
      const choices = document.getElementById('choices');
      if (choices)
        choices.innerHTML =
          '<div role="listbox"><div role="option" aria-disabled="true">SEED-HISTORY-LABEL</div></div>';
    });
    const refreshSecret = jest.fn(() => Promise.resolve(true));

    const result = await runSelectOption({
      ...h.options,
      refreshSecret,
      choice: { indexes: [0] },
    });

    expect(refreshSecret).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      readback: { code: 'state_unchanged' },
      target: { optionsRedacted: true },
    });
    expect(JSON.stringify(result)).not.toContain('SEED-HISTORY-LABEL');
  });

  it('does not trust the shown text when another option has the same label', async () => {
    const h = harness(
      '<input data-target role="combobox" aria-controls="cities" value="Lisbon"><div id="cities" role="listbox"><div role="option" data-value="lis-1" aria-selected="true">Lisbon</div><div role="option" data-value="lis-2" aria-selected="false">Lisbon</div></div>',
    );

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['lis-2'] },
    });

    expect(h.clicked).toEqual(['input', 'div']);
    expect(result).toMatchObject({
      inputMode: 'trusted',
      readback: { code: 'state_unchanged' },
    });
  });

  it('stops typing search text when the combobox loses focus after a character', async () => {
    const h = harness(
      '<input data-target role="combobox" aria-controls="cities"><input id="other"><div id="cities" role="listbox"><div role="option">Lisbon</div></div>',
    );
    const document = h.dom.window.document;
    h.target.addEventListener('input', () => {
      document.getElementById('other')?.focus();
    });

    const result = await runSelectOption({
      ...h.options,
      choice: { labels: ['Lisbon'] },
      searchText: 'Lis',
    });

    expect(h.events.filter((event) => event.startsWith('char:'))).toEqual([
      'char:L',
    ]);
    expect(result).toMatchObject({
      readback: { code: 'state_unchanged' },
      warnings: [
        'The combobox lost focus while typing, so the rest of the search text was not typed.',
      ],
    });
  });

  it('does not report success when a click handler reorders the list and selects another option at the requested index', async () => {
    const h = harness(
      '<div data-target role="listbox"><div role="option" aria-selected="false">A</div><div role="option" aria-selected="false">B</div></div>',
    );
    const document = h.dom.window.document;
    const [a, b] = Array.from(document.querySelectorAll('[role="option"]'));
    b?.addEventListener('click', () => {
      if (a && b) {
        h.target.prepend(b);
        a.setAttribute('aria-selected', 'true');
      }
    });

    const result = await runSelectOption({
      ...h.options,
      choice: { indexes: [1] },
    });

    expect(a?.getAttribute('aria-selected')).toBe('true');
    expect(result).toMatchObject({ readback: { code: 'state_unchanged' } });
  });

  it('keeps option labels out of every message when the named container is inside a secret listbox', async () => {
    const h = harness(
      '<div data-target role="combobox" tabindex="0" aria-controls="cards-wrap">Choose</div>' +
        '<div role="listbox" autocomplete="cc-number"><div id="cards-wrap"><div role="option">4111 1111 1111 1111</div></div></div>',
    );

    const result = await runSelectOption({
      ...h.options,
      choice: { labels: ['missing card'] },
    });

    expect(result).toMatchObject({ readback: { code: 'state_unchanged' } });
    expect(JSON.stringify(result)).not.toContain('4111');
  });

  it('confirms a choice on a button combobox whose popup unmounts on select', async () => {
    const h = harness(
      '<button data-target type="button" role="combobox" aria-controls="sizes">Choose a size</button><div id="sizes" role="listbox"><div role="option" data-value="s">Small</div><div role="option" data-value="l">Large</div></div>',
    );
    const document = h.dom.window.document;
    for (const option of Array.from(
      document.querySelectorAll('[role="option"]'),
    ))
      option.addEventListener('click', () => {
        h.target.textContent = option.textContent;
        document.getElementById('sizes')?.remove();
      });

    const result = await runSelectOption({
      ...h.options,
      choice: { labels: ['Large'] },
    });

    expect(h.target.textContent).toBe('Large');
    expect(result).toMatchObject({ inputMode: 'trusted' });
    expect(result).not.toHaveProperty('readback');
  });

  it('waits fifty milliseconds after opening before reading a combobox option list', async () => {
    jest.useFakeTimers();
    try {
      const h = harness(
        '<input data-target role="combobox" aria-controls="choices"><div id="choices" role="listbox"><div role="option" data-value="city" aria-selected="false">New York</div></div>',
      );
      const row = h.dom.window.document.querySelector('[role="option"]');
      row?.addEventListener('click', () =>
        row.setAttribute('aria-selected', 'true'),
      );
      const pending = runSelectOption({
        ...h.options,
        choice: { values: ['city'] },
      });

      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(49);
      expect(h.runtimeTimes).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(1);
      expect(h.runtimeTimes[2]).toBeGreaterThanOrEqual(
        (h.clickTimes[0] ?? 0) + 50,
      );
      await jest.advanceTimersByTimeAsync(50);
      const result = await pending;

      expect(result.target?.selectedOptions).toEqual([
        { value: 'city', label: 'New York' },
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits about 450 milliseconds after typing combobox search before reading options', async () => {
    jest.useFakeTimers();
    try {
      const h = harness(
        '<input data-target role="combobox" aria-controls="choices"><div id="choices" role="listbox"><div role="option" data-value="city" aria-selected="false">New York</div></div>',
      );
      const row = h.dom.window.document.querySelector('[role="option"]');
      row?.addEventListener('click', () =>
        row.setAttribute('aria-selected', 'true'),
      );
      const pending = runSelectOption({
        ...h.options,
        choice: { values: ['city'] },
        searchText: 'New',
      });

      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(449);
      // The first read, the check that the combobox kept focus, and the
      // same check before each character after the first.
      expect(h.runtimeTimes).toHaveLength(5);
      await jest.advanceTimersByTimeAsync(1);
      expect(h.runtimeTimes[5]).toBeGreaterThanOrEqual(
        (h.clickTimes[0] ?? 0) + 450,
      );
      await jest.advanceTimersByTimeAsync(50);
      const result = await pending;

      expect(result.settleMs).toBe(450);
    } finally {
      jest.useRealTimers();
    }
  });

  it('checks cancellation after combobox settling before reading options', async () => {
    jest.useFakeTimers();
    try {
      const h = harness(
        '<input data-target role="combobox" aria-controls="choices"><div id="choices" role="listbox"><div role="option" data-value="city" aria-selected="false">New York</div></div>',
        { abortAfterOpenMs: 25 },
      );
      const pending = runSelectOption({
        ...h.options,
        choice: { values: ['city'] },
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );

      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(50);
      const settled = await pending;
      if (!('error' in settled))
        throw new Error('Expected option retrieval to fail before dispatch.');
      expect(settled.error).toBeDefined();
      expect(h.runtimeTimes).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps listbox option retrieval failures pre-dispatch', async () => {
    const h = harness(
      '<div data-target role="listbox"><div role="option" data-value="item">Item</div></div>',
      { missingOptionHandle: true },
    );

    await expect(
      runSelectOption({ ...h.options, choice: { values: ['item'] } }),
    ).rejects.toMatchObject({ error: { code: 'target_not_found' } });
    expect(h.dispatched).toBe(0);
  });

  it('returns a combobox option actionability refusal as executed readback', async () => {
    const h = harness(
      '<input data-target role="combobox" aria-controls="choices"><div id="choices" role="listbox"><div role="option" data-value="item" aria-selected="false">Item</div></div>',
      { optionClickError: 'target_not_visible' },
    );

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['item'] },
    });

    expect(result).toMatchObject({
      inputMode: 'trusted',
      readback: { code: 'state_unchanged' },
      target: { options: [option('item', 'Item', false)] },
      warnings: [expect.any(String)],
    });
    expect(h.dispatched).toBe(1);
  });

  it.each(['removed', 'hidden', 'disabled'] as const)(
    'reports a %s combobox option after opening as executed readback',
    async (state) => {
      const h = harness(
        '<input data-target role="combobox" aria-controls="choices"><div id="choices" role="listbox"><div role="option" data-value="item" aria-selected="false">Item</div></div>',
        {
          onClick: (clickedTag) => {
            if (clickedTag !== 'input') return;
            const row = h.dom.window.document.querySelector('[role="option"]');
            if (state === 'removed') row?.remove();
            else if (state === 'hidden') row?.setAttribute('hidden', '');
            else row?.setAttribute('aria-disabled', 'true');
          },
        },
      );

      const result = await runSelectOption({
        ...h.options,
        choice: { values: ['item'] },
      });

      expect(result).toMatchObject({
        inputMode: 'trusted',
        readback: { code: 'state_unchanged' },
        warnings: [expect.any(String)],
      });
      expect(result.target?.options).toBeDefined();
      if (state === 'removed') {
        expect(result.target?.options).toEqual([]);
      } else if (state === 'disabled') {
        expect(result.target?.options).toMatchObject([{ disabled: true }]);
      }
      expect(h.dispatched).toBe(1);
    },
  );

  it('does not expose secret option details in a post-open actionability readback', async () => {
    const h = harness(
      '<input data-target role="combobox" autocomplete="cc-exp-month" aria-controls="choices"><div id="choices" role="listbox"><div role="option" data-value="411-secret" aria-selected="false">Private month</div></div>',
      { secret: true, optionClickError: 'target_not_visible' },
    );

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['411-secret'] },
    });

    expect(result.readback).toEqual({ code: 'state_unchanged' });
    expect(result.warnings?.join(' ')).not.toContain('Private month');
    expect(result.warnings?.join(' ')).not.toContain('411-secret');
    expect(result.target?.options).toBeUndefined();
    expect(result.target?.selectedOptions).toBeUndefined();
    expect(result.target?.optionsRedacted).toBe(true);
  });

  it('refuses a hidden listbox option before dispatch', async () => {
    const h = harness(
      '<div data-target role="listbox"><div role="option" data-value="item" style="display:none">Item</div></div>',
    );

    await expect(
      runSelectOption({ ...h.options, choice: { values: ['item'] } }),
    ).rejects.toMatchObject({ error: { code: 'target_not_visible' } });
    expect(h.dispatched).toBe(0);
  });

  it('refuses several distinct entries for a multiselectable ARIA list before dispatch', async () => {
    const h = harness(
      '<div data-target role="listbox" aria-multiselectable="true"><div role="option" data-value="a">A</div><div role="option" data-value="b">B</div></div>',
    );

    await expect(
      runSelectOption({ ...h.options, choice: { values: ['a', 'b'] } }),
    ).rejects.toMatchObject({
      error: {
        code: 'unsupported_control',
        message: 'This list takes one option.',
      },
    });
    expect(h.dispatched).toBe(0);
  });

  it('does not return secret ARIA option data in post-open failures', async () => {
    const h = harness(
      '<input data-target role="combobox" autocomplete="cc-exp-month" aria-controls="choices"><div id="choices" role="listbox"><div role="option" data-value="411-secret" aria-selected="false">Private month</div></div>',
      { secret: true },
    );

    const result = await runSelectOption({
      ...h.options,
      choice: { values: ['never-match'] },
    });

    expect(result.readback).toEqual({ code: 'state_unchanged' });
    expect(result.warnings?.join(' ')).not.toContain('Private month');
    expect(result.warnings?.join(' ')).not.toContain('411-secret');
    expect(result.target?.options).toBeUndefined();
    expect(result.target?.selectedOptions).toBeUndefined();
    expect(result.target?.optionsRedacted).toBe(true);
  });
});
