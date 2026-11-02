import type { BrowserActionError } from '@canopy/desktop-shared/types/browser';
import { JSDOM } from 'jsdom';
import type { BrowserCdpSend } from '../actionability';
import { ActionLane, type ActionLaneContext } from '../action-lane';
import { FormActionError } from '../form-action';
import type { FocusDispatchResult } from '../input-dispatch';
import { NORMALIZED_INPUT_VALUE_FUNCTION, runFill } from '../fill';
import type { ResolvedActionTarget } from '../../frames/action-targets';

const target: ResolvedActionTarget = {
  identity: {
    frameId: 'frame',
    sessionId: 'session',
    loaderId: 'loader',
    backendNodeId: 1,
  },
  frameRef: 'frame-ref',
  objectId: 'target-object',
  objectGroup: 'object-group',
  outOfProcess: false,
};

function lane(): ActionLaneContext {
  let dispatched = false;
  return {
    signal: new AbortController().signal,
    sequence: 1,
    beginDispatch: jest.fn((): void => {
      dispatched = true;
    }),
    // The real lane refuses to track a command before input is sent.
    trackCommand: <T>(command: Promise<T>): Promise<T> => {
      if (!dispatched)
        throw new Error('Commands cannot be tracked before dispatch.');
      return command;
    },
    registerCleanup: jest.fn(),
  };
}

function response(value: unknown): unknown {
  return { result: { value } };
}

/** The first page-call argument, as `Runtime.callFunctionOn` received it. */
function firstArgument(params: Record<string, unknown>): unknown {
  const args = params.arguments;
  if (!Array.isArray(args)) return undefined;
  const first: unknown = args[0];
  return typeof first === 'object' && first !== null && 'value' in first
    ? first.value
    : undefined;
}

/** Page calls whose function source contains `marker`. */
function pageCalls(
  calls: Array<{ method: string; params: Record<string, unknown> }>,
  marker: string,
): Array<{ method: string; params: Record<string, unknown> }> {
  return calls.filter(
    (call) =>
      call.method === 'Runtime.callFunctionOn' &&
      typeof call.params.functionDeclaration === 'string' &&
      call.params.functionDeclaration.includes(marker),
  );
}

/** The text each trusted key event carries, in order. */
function typedCharacters(
  calls: Array<{ method: string; params: Record<string, unknown> }>,
): unknown[] {
  return calls
    .filter(
      (call) =>
        call.method === 'Input.dispatchKeyEvent' &&
        typeof call.params.text === 'string',
    )
    .map((call) => call.params.text);
}

/**
 * Page reads answer from `values` in order. A focus check answers from
 * `focus` instead, and is true once that queue is empty.
 */
function harness(
  values: unknown[] = [],
  focus: boolean[] = [],
): {
  send: BrowserCdpSend;
  calls: Array<{
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
  }>;
} {
  let index = 0;
  const calls: Array<{
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
  }> = [];
  const send: BrowserCdpSend = (method, params, sessionId) => {
    calls.push({ method, params, ...(sessionId ? { sessionId } : {}) });
    if (method === 'Runtime.callFunctionOn') {
      if (
        params.returnByValue === true &&
        typeof params.functionDeclaration === 'string' &&
        params.functionDeclaration.includes('root.activeElement !== host')
      )
        return Promise.resolve(response(focus.shift() ?? true));
      if (params.returnByValue === true)
        return Promise.resolve(response(values[index++]));
      return Promise.resolve({
        result: { objectId: 'normalized-editor-object' },
      });
    }
    if (method === 'DOM.describeNode')
      return Promise.resolve({ node: { backendNodeId: 2 } });
    return Promise.resolve({});
  };
  return { send, calls };
}

type FillDependencies = Omit<
  Parameters<typeof runFill>[0],
  'text' | 'platform'
>;

function options(
  send: BrowserCdpSend,
  overrides: Partial<FillDependencies> = {},
): FillDependencies {
  return {
    send,
    lane: lane(),
    target,
    secret: false,
    fillDirect: () => Promise.resolve(undefined),
    click: () => Promise.resolve({ completed: true, inputMode: 'trusted' }),
    focus: () =>
      Promise.resolve({
        focused: true,
        completed: true,
        inputMode: 'trusted',
      }),
    ...overrides,
  };
}

function state(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    connected: true,
    tagName: 'input',
    role: '',
    inputType: 'text',
    disabled: false,
    readOnly: false,
    editable: true,
    editor: false,
    kind: 'text',
    autocompleteWarning: false,
    settleMs: 0,
    ...overrides,
  };
}

describe('browser fill action', () => {
  it('classifies any data-provide attribute as a compound input per D5', async () => {
    const { send, calls } = harness([state(), { matches: true }]);
    await runFill({
      ...options(send),
      text: 'value',
      platform: 'darwin',
    });

    const declaration = calls.find(
      (call) =>
        call.method === 'Runtime.callFunctionOn' &&
        call.params.returnByValue === true &&
        typeof call.params.functionDeclaration === 'string' &&
        call.params.functionDeclaration.includes('const datepicker'),
    )?.params.functionDeclaration;
    if (typeof declaration !== 'string')
      throw new Error('Fill preflight classifier was not dispatched.');

    const dom = new JSDOM('<input type="text">', {
      url: 'https://example.test/',
      runScripts: 'outside-only',
    });
    const input = dom.window.document.querySelector('input');
    if (!input) throw new Error('Expected a text input test target.');

    for (const [provider, expectedKind] of [
      ['typeahead', 'compound'],
      ['', 'compound'],
      ['datepicker', 'compound'],
      ['datetimepicker', 'compound'],
      ['daterangepicker', 'compound'],
    ]) {
      input.setAttribute('data-provide', provider);
      dom.window.eval(
        `document.body.dataset.kind = (${declaration}).call(document.querySelector('input')).kind`,
      );
      expect(dom.window.document.body.dataset.kind).toBe(expectedKind);
    }
  });

  it.each([
    [
      state({ inputType: 'checkbox', kind: 'checkable' }),
      'browser.set_checked',
    ],
    [state({ tagName: 'select', kind: 'select' }), 'browser.select_option'],
    [
      state({ tagName: 'input', inputType: 'file', kind: 'file' }),
      'browser.upload_files',
    ],
  ])(
    'refuses unsupported targets before input with the appropriate next hint',
    async (snapshot, next) => {
      const { send, calls } = harness([snapshot]);
      const actionLane = lane();
      const fillDirect = jest.fn(() => Promise.resolve(undefined));
      const actionOptions = options(send, { lane: actionLane, fillDirect });

      let thrown: unknown;
      try {
        await runFill({
          ...actionOptions,
          text: 'private text',
          platform: 'darwin',
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(FormActionError);
      const refusal =
        thrown instanceof FormActionError ? thrown.error : undefined;
      expect(refusal).toMatchObject({ code: 'unsupported_control' });
      if (next) expect(refusal).toMatchObject({ next });
      else expect(refusal).not.toHaveProperty('next');
      expect(actionLane.beginDispatch).not.toHaveBeenCalled();
      expect(fillDirect).not.toHaveBeenCalled();
      expect(
        calls.filter((call) => call.method === 'Input.dispatchKeyEvent'),
      ).toHaveLength(0);
    },
  );

  it('uses completion-only direct fill and verifies the value in the page', async () => {
    const { send, calls } = harness([state(), { matches: true }]);
    const fillDirect = jest.fn(() => Promise.resolve('ignored page value'));

    const result = await runFill({
      ...options(send),
      text: 'hello',
      platform: 'darwin',
      fillDirect,
    });

    expect(result).toMatchObject({ completed: true, inputMode: 'direct' });
    expect(fillDirect).toHaveBeenCalledTimes(1);
    expect(
      calls.filter((call) => call.method === 'Input.dispatchKeyEvent'),
    ).toHaveLength(0);
    const verdict = calls.find(
      (call) =>
        call.method === 'Runtime.callFunctionOn' &&
        call.params.returnByValue === true &&
        typeof call.params.functionDeclaration === 'string' &&
        call.params.functionDeclaration.includes('requestAnimationFrame'),
    );
    expect(verdict?.params.awaitPromise).toBe(true);
    expect(verdict?.params.functionDeclaration).toContain(
      'requestAnimationFrame',
    );
    expect(verdict?.params.functionDeclaration).not.toContain(
      'return this.value',
    );
  });

  it('falls back to trusted select-all typing when a direct assignment reverts', async () => {
    const { send, calls } = harness([
      state(),
      { matches: false, retainedAppend: false },
      { matches: true },
    ]);
    const fillDirect = jest.fn(() => Promise.resolve(undefined));

    const result = await runFill({
      ...options(send),
      text: 'new',
      platform: 'darwin',
      fillDirect,
    });

    expect(result).toMatchObject({
      completed: true,
      inputMode: 'trusted',
      warnings: ['The page reverted the value; typed it instead.'],
    });
    const inputEvents = calls.filter(
      (call) => call.method === 'Input.dispatchKeyEvent',
    );
    expect(inputEvents.map((call) => call.params.type)).toEqual([
      'rawKeyDown',
      'rawKeyDown',
      'keyUp',
      'keyUp',
      'keyDown',
      'keyUp',
      'keyDown',
      'keyUp',
      'keyDown',
      'keyUp',
    ]);
    expect(inputEvents[1].params.commands).toEqual(['selectAll']);
    expect(inputEvents.every((call) => call.sessionId === 'session')).toBe(
      true,
    );
  });

  it('uses a real Backspace after select-all when an empty direct fill reverts', async () => {
    const { send, calls } = harness([
      state(),
      { matches: false, retainedAppend: false },
      { matches: true },
    ]);

    const result = await runFill({
      ...options(send),
      text: '',
      platform: 'darwin',
      fillDirect: () => Promise.resolve(undefined),
    });

    expect(result).toMatchObject({ completed: true, inputMode: 'trusted' });
    const inputEvents = calls.filter(
      (call) => call.method === 'Input.dispatchKeyEvent',
    );
    expect(inputEvents.map((call) => call.params.type)).toEqual([
      'rawKeyDown',
      'rawKeyDown',
      'keyUp',
      'keyUp',
      'rawKeyDown',
      'keyUp',
    ]);
    expect(inputEvents[1].params.commands).toEqual(['selectAll']);
    expect(inputEvents[4].params.key).toBe('Backspace');
  });

  it('retries the direct setter once when trusted typing retained the old content', async () => {
    const { send, calls } = harness([
      state(),
      { matches: false, retainedAppend: true },
      { matches: false, retainedAppend: true },
      { matches: true },
    ]);
    const fillDirect = jest.fn(() => Promise.resolve(undefined));

    const result = await runFill({
      ...options(send),
      text: 'new',
      platform: 'darwin',
      fillDirect,
    });

    expect(result).toMatchObject({
      completed: true,
      inputMode: 'trusted',
      warnings: [
        'The page reverted the value; typed it instead.',
        'The value setter was retried after typing.',
      ],
    });
    expect(fillDirect).toHaveBeenCalledTimes(2);
    expect(
      calls.filter((call) => call.method === 'Input.dispatchKeyEvent'),
    ).toHaveLength(10);
  });

  it('reports the final observed value with state_unchanged after trusted fallback fails', async () => {
    const { send, calls } = harness([
      state(),
      { matches: false, retainedAppend: false },
      { matches: false, retainedAppend: false },
      'observed non-secret value',
    ]);

    const result = await runFill({
      ...options(send),
      text: 'new',
      platform: 'darwin',
      fillDirect: () => Promise.resolve(undefined),
    });

    expect(result).toMatchObject({
      completed: true,
      readback: { code: 'state_unchanged' },
      target: { value: 'observed non-secret value' },
      warnings: [
        'The page reverted the value; typed it instead.',
        'The page did not accept the filled value.',
      ],
    });
    expect(
      calls.some(
        (call) =>
          call.params.functionDeclaration ===
          'function() { return this.value; }',
      ),
    ).toBe(true);
  });

  it('does not read back a secret value or expose one on a mismatch', async () => {
    const { send, calls } = harness([
      state({ secret: true }),
      { matches: false, retainedAppend: false },
      { matches: false },
    ]);

    const result = await runFill({
      ...options(send, { secret: true }),
      text: 'redacted-input',
      platform: 'darwin',
      fillDirect: () => Promise.resolve(undefined),
    });

    expect(result).toMatchObject({
      inputMode: 'trusted',
      readback: { code: 'state_unchanged' },
    });
    expect(result.target?.value).toBeUndefined();
    expect(result.target?.validationMessage).toBeUndefined();
    expect(
      calls.some(
        (call) =>
          call.method === 'Runtime.callFunctionOn' &&
          typeof call.params.functionDeclaration === 'string' &&
          call.params.functionDeclaration.includes('return this.value'),
      ),
    ).toBe(false);
  });

  it('uses native focus/input/change/blur events for compound fields and warns on format mismatch', async () => {
    const compound = state({
      inputType: 'date',
      kind: 'compound',
      format: 'YYYY-MM-DD',
    });
    const { send, calls } = harness([compound, true, { matches: false }, '']);

    const result = await runFill({
      ...options(send),
      text: 'not a date',
      platform: 'darwin',
      fillDirect: () => Promise.resolve(undefined),
    });

    expect(result).toMatchObject({
      inputMode: 'direct',
      readback: { code: 'invalid_format', expectedFormat: 'YYYY-MM-DD' },
      warnings: [expect.stringContaining('format')],
      target: { value: '' },
    });
    const dispatch = calls.find(
      (call) =>
        call.method === 'Runtime.callFunctionOn' &&
        typeof call.params.functionDeclaration === 'string' &&
        call.params.functionDeclaration.includes('new Event'),
    );
    const declaration = dispatch?.params.functionDeclaration;
    expect(declaration).toContain("['focus', 'input', 'change', 'blur']");
    expect(declaration).toContain('new Event(type, { bubbles: true })');
    expect(dispatch?.params.userGesture).toBe(true);
  });

  it('does not report a secret compound mismatch as invalid_format', async () => {
    const compound = state({
      inputType: 'date',
      kind: 'compound',
      format: 'YYYY-MM-DD',
    });
    const { send, calls } = harness([compound, true, { matches: false }]);

    const result = await runFill({
      ...options(send, { secret: true }),
      text: 'secret text',
      platform: 'darwin',
      fillDirect: () => Promise.resolve(undefined),
    });

    expect(result).toMatchObject({
      completed: true,
      readback: { code: 'state_unchanged' },
      warnings: ['The control did not accept the value.'],
    });
    expect(result.readback).not.toHaveProperty('expectedFormat');
    expect(result.target?.value).toBeUndefined();
    expect(
      calls.some(
        (call) =>
          call.method === 'Runtime.callFunctionOn' &&
          call.params.functionDeclaration ===
            'function() { return this.value; }',
      ),
    ).toBe(false);
  });

  it('reports an empty compound mismatch as state_unchanged rather than invalid_format', async () => {
    const compound = state({
      inputType: 'date',
      kind: 'compound',
      format: 'YYYY-MM-DD',
    });
    const { send } = harness([compound, true, { matches: false }, '']);

    const result = await runFill({
      ...options(send),
      text: '',
      platform: 'darwin',
      fillDirect: () => Promise.resolve(undefined),
    });

    expect(result).toMatchObject({
      readback: { code: 'state_unchanged' },
      target: { value: '' },
      warnings: ['The control did not accept the empty value.'],
    });
    expect(result.readback).not.toHaveProperty('expectedFormat');
  });

  it('treats contenteditable="inherit" and unknown values as the parent decides', async () => {
    const editor = state({
      tagName: 'div',
      inputType: '',
      editable: true,
      kind: 'editor',
      editor: true,
      editingHost: { backendNodeId: 2 },
    });
    const { send, calls } = harness([editor, false, true, true, true, '']);
    await runFill({
      ...options(send),
      text: '',
      platform: 'darwin',
      fillDirect: () => Promise.resolve(undefined),
      click: jest.fn(() =>
        Promise.resolve({ completed: true, inputMode: 'trusted' as const }),
      ),
    });
    const declaration = (marker: string): string => {
      const found = pageCalls(calls, marker)[0]?.params.functionDeclaration;
      if (typeof found !== 'string')
        throw new Error(`Expected a page call with ${marker}.`);
      return found;
    };
    const dom = new JSDOM(
      '<div contenteditable="false"><span id="inherit" contenteditable="inherit">kept</span><span id="unknown" contenteditable="maybe">kept</span></div>' +
        '<div id="host" contenteditable="true"><span id="nested" contenteditable="inherit">x</span></div>',
      { url: 'https://example.test/', runScripts: 'outside-only' },
    );
    dom.window.eval(`
      const classify = ${declaration('const datepicker')};
      const host = ${declaration('parentEditable')};
      document.body.dataset.results = ['inherit', 'unknown', 'nested']
        .map(id => {
          const element = document.getElementById(id);
          const found = host.call(element);
          return id + ':' + classify.call(element).kind + ':' + (found ? found.id : 'none');
        })
        .join(',');
    `);
    expect(dom.window.document.body.dataset.results).toBe(
      'inherit:other:none,unknown:other:none,nested:editor:host',
    );
  });

  it('normalizes nested contenteditable fills to their host and clears the empty value', async () => {
    const editor = state({
      tagName: 'div',
      inputType: '',
      editable: true,
      kind: 'editor',
      editor: true,
      editingHost: { backendNodeId: 2 },
    });
    const click: FillDependencies['click'] = jest.fn(() =>
      Promise.resolve({
        completed: true,
        inputMode: 'trusted',
      }),
    );
    const { send, calls } = harness([editor, false, true, true, true, '']);

    const result = await runFill({
      ...options(send),
      text: '',
      platform: 'darwin',
      fillDirect: () => Promise.resolve(undefined),
      click,
    });

    expect(result).toMatchObject({
      editor: true,
      inputMode: 'trusted',
      recordingTarget: {
        objectId: 'normalized-editor-object',
        identity: { backendNodeId: 2 },
      },
    });
    expect(click).toHaveBeenCalledWith(
      { objectId: 'normalized-editor-object', backendNodeId: 2 },
      3,
    );
    expect(calls.some((call) => call.method === 'Input.dispatchKeyEvent')).toBe(
      true,
    );
    expect(
      calls.find(
        (call) =>
          call.method === 'Runtime.callFunctionOn' &&
          typeof call.params.functionDeclaration === 'string' &&
          call.params.functionDeclaration.includes('removeChild'),
      )?.params.userGesture,
    ).toBe(true);
  });

  it('tells a model-driven editor that the script clear emptied it, and compares its lines by block', async () => {
    const editor = state({
      tagName: 'div',
      inputType: '',
      editable: true,
      kind: 'editor',
      editor: true,
    });
    const { send, calls } = harness([editor, true, true, true, '']);
    await runFill({ ...options(send), text: '', platform: 'darwin' });
    const declaration = (marker: string): string => {
      const found = calls.find(
        (call) =>
          call.method === 'Runtime.callFunctionOn' &&
          typeof call.params.functionDeclaration === 'string' &&
          call.params.functionDeclaration.includes(marker),
      )?.params.functionDeclaration;
      if (typeof found !== 'string')
        throw new Error(`Expected a page call with ${marker}.`);
      return found;
    };
    const dom = new JSDOM(
      '<div contenteditable="true"><p>old</p><p>text</p></div>',
      { url: 'https://example.test/', runScripts: 'outside-only' },
    );
    dom.window.eval(`
      const editor = document.querySelector('div');
      const events = [];
      editor.addEventListener('input', (event) => {
        events.push(event.type + ':' + event.inputType + ':' + editor.textContent.length);
      });
      document.body.dataset.cleared = String((${declaration('removeChild')}).call(editor));
      document.body.dataset.events = events.join(';');
      editor.innerHTML = '<p>First line</p><p>second line</p>';
      document.body.dataset.matches = String(
        (${declaration('expected')}).call(editor, 'First line\\nsecond line'),
      );
    `);
    expect(dom.window.document.body.dataset).toMatchObject({
      cleared: 'true',
      events: 'input:deleteContent:0',
      matches: 'true',
    });
  });

  it('tries all editor clearing stages in order and stops once the final one is empty', async () => {
    const editor = state({
      tagName: 'div',
      inputType: '',
      kind: 'editor',
      editor: true,
    });
    const { send, calls } = harness([editor, false, false, true, true, '']);
    const editorSteps: string[] = [];
    const onEditor = jest.fn(() => editorSteps.push('editor-window'));
    const click = jest.fn<
      ReturnType<FillDependencies['click']>,
      Parameters<FillDependencies['click']>
    >(() => {
      editorSteps.push('click');
      return Promise.resolve({ completed: true, inputMode: 'trusted' });
    });

    const result = await runFill({
      ...options(send, { click, onEditor }),
      text: '',
      platform: 'darwin',
      fillDirect: () => Promise.resolve(undefined),
    });

    expect(result).toMatchObject({ completed: true, editor: true });
    expect(click).toHaveBeenCalledTimes(1);
    expect(onEditor).toHaveBeenCalledTimes(1);
    expect(editorSteps).toEqual(['editor-window', 'click']);
    expect(click).toHaveBeenCalledWith(
      { objectId: 'normalized-editor-object', backendNodeId: 2 },
      3,
    );
    const clear = calls.findIndex(
      (call) =>
        call.method === 'Runtime.callFunctionOn' &&
        typeof call.params.functionDeclaration === 'string' &&
        call.params.functionDeclaration.includes('removeChild'),
    );
    const deleteKey = calls.findIndex(
      (call) =>
        call.method === 'Input.dispatchKeyEvent' &&
        call.params.key === 'Delete' &&
        call.params.type === 'rawKeyDown',
    );
    const selectAllKey = calls.findIndex(
      (call) =>
        call.method === 'Input.dispatchKeyEvent' &&
        Array.isArray(call.params.commands) &&
        call.params.commands.includes('selectAll'),
    );
    const backspaceKey = calls.findIndex(
      (call) =>
        call.method === 'Input.dispatchKeyEvent' &&
        call.params.key === 'Backspace' &&
        call.params.type === 'rawKeyDown',
    );
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(deleteKey).toBeGreaterThan(clear);
    expect(selectAllKey).toBeGreaterThan(deleteKey);
    expect(backspaceKey).toBeGreaterThan(selectAllKey);
  });

  it.each([false, true])(
    'returns an executed readback when editor fallback click is refused after clearing input (secret=%s)',
    async (secret) => {
      const editor = state({
        tagName: 'div',
        inputType: '',
        kind: 'editor',
        editor: true,
      });
      const { send, calls } = harness([editor, false, 'unchanged editor']);
      const result = await runFill({
        ...options(send, {
          secret,
          click: () =>
            Promise.reject(
              new FormActionError({
                code: 'target_not_visible',
                message: 'The editor is covered.',
                retryable: true,
              }),
            ),
        }),
        text: 'requested text',
        platform: 'darwin',
      });
      expect(result).toMatchObject({
        completed: true,
        editor: true,
        inputMode: 'trusted',
        readback: { code: 'state_unchanged' },
        warnings: ['The editor could not be cleared before filling it.'],
      });
      expect(
        calls.some((call) => call.method === 'Input.dispatchKeyEvent'),
      ).toBe(false);
      if (secret) {
        expect(result.target).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain('unchanged editor');
      } else {
        expect(result.target).toEqual({ value: 'unchanged editor' });
      }
    },
  );

  it('retries a dropped editor block-start character before moving to the next character', async () => {
    const editor = state({
      tagName: 'div',
      inputType: '',
      kind: 'editor',
      editor: true,
    });
    // For each block start: mark the editor's text, type, then ask whether
    // the text changed (false means the editor dropped the character), and
    // check that the editor still has focus before typing it again.
    const { send, calls } = harness([
      editor,
      true,
      true,
      true,
      false,
      true,
      false,
      true,
      'ab\ncd',
    ]);

    const result = await runFill({
      ...options(send),
      text: 'ab\ncd',
      platform: 'darwin',
      fillDirect: () => Promise.resolve(undefined),
    });

    expect(result).toMatchObject({ completed: true, editor: true });
    expect(
      calls
        .filter(
          (call) =>
            call.method === 'Input.dispatchKeyEvent' &&
            typeof call.params.text === 'string',
        )
        .map((call) => call.params.text),
    ).toEqual(['a', 'a', 'b', '\r', 'c', 'c', 'd']);
  });

  it.each([
    ['a\n\nb', ['a', 'b'], ['a', '\r', '\r', 'b']],
    ['\nFirst', ['F'], ['\r', 'F', 'i', 'r', 's', 't']],
  ])(
    'never retypes a newline as a dropped block-start character: %j',
    async (text, checked, typed) => {
      const editor = state({
        tagName: 'div',
        inputType: '',
        kind: 'editor',
        editor: true,
      });
      const { send, calls } = harness([
        editor,
        true,
        true,
        ...checked.flatMap(() => [true, true]),
        true,
        text,
      ]);

      const result = await runFill({
        ...options(send),
        text,
        platform: 'darwin',
      });

      expect(result).toMatchObject({ completed: true, editor: true });
      expect(pageCalls(calls, '__canopyEditorMarks.set')).toHaveLength(
        checked.length,
      );
      expect(typedCharacters(calls)).toEqual(typed);
    },
  );

  it('tells a dropped block-start character by whether the editor text changed, whatever ends the line', async () => {
    const editor = state({
      tagName: 'div',
      inputType: '',
      kind: 'editor',
      editor: true,
    });
    const { send, calls } = harness([
      editor,
      true,
      true,
      true,
      true,
      true,
      'a',
    ]);
    await runFill({ ...options(send), text: 'a', platform: 'darwin' });
    const declaration = (marker: string): string => {
      const found = pageCalls(calls, marker)[0]?.params.functionDeclaration;
      if (typeof found !== 'string')
        throw new Error(`Expected a page call with ${marker}.`);
      return found;
    };
    const dom = new JSDOM(
      '<div contenteditable="true">ab<br></div><div contenteditable="plaintext-only">ab\n</div>',
      { url: 'https://example.test/', runScripts: 'outside-only' },
    );
    dom.window.eval(`
      const mark = ${declaration('__canopyEditorMarks.set')};
      const changed = ${declaration('__canopyEditorMarks?.get')};
      const results = [];
      for (const editor of document.querySelectorAll('[contenteditable]')) {
        mark.call(editor);
        editor.append('c');
        results.push(changed.call(editor));
        mark.call(editor);
        results.push(changed.call(editor));
      }
      document.body.dataset.results = results.join(',');
    `);
    expect(dom.window.document.body.dataset.results).toBe(
      'true,false,true,false',
    );
  });

  it.each([
    ['input', 'ab'],
    ['textarea', 'a\nb'],
  ])(
    'compares and types a %s fill without the line breaks it cannot hold',
    async (tagName, expected) => {
      const { send, calls } = harness([
        state({ tagName }),
        { matches: false, retainedAppend: false },
        { matches: true, retainedAppend: false },
      ]);

      await runFill({ ...options(send), text: 'a\nb', platform: 'darwin' });

      expect(
        pageCalls(calls, 'async function(expected)').map((call) =>
          firstArgument(call.params),
        ),
      ).toEqual([expected, expected]);
      expect(typedCharacters(calls)).toEqual(
        tagName === 'input' ? ['a', 'b'] : ['a', '\r', 'b'],
      );
    },
  );

  it.each([
    ['email', false, '  user@example.com  ', 'user@example.com'],
    ['email', false, '\t\fuser@example.com \n', 'user@example.com'],
    ['url', false, '  https://example.com/  ', 'https://example.com/'],
    [
      'email',
      true,
      ' a@example.com , b@example.com ',
      'a@example.com,b@example.com',
    ],
    // One address keeps its commas; only its ends are stripped.
    ['email', false, ' a@example.com , b ', 'a@example.com , b'],
    // The browser keeps a no-break space, so it is compared as given.
    ['email', false, '\u00a0user@example.com', '\u00a0user@example.com'],
    ['url', false, 'https://example.com/\u00a0', 'https://example.com/\u00a0'],
    // Other single-line inputs only drop line breaks.
    ['text', false, '  padded  ', '  padded  '],
    ['search', false, ' find me ', ' find me '],
    ['tel', false, ' 555 0100 ', ' 555 0100 '],
    ['password', false, ' secret ', ' secret '],
  ])(
    'compares and types a %s fill (multiple: %s) of %j as the browser stores it',
    async (inputType, multiple, text, expected) => {
      const { send, calls } = harness([
        state({ inputType, multiple }),
        { matches: false, retainedAppend: false },
        { matches: true, retainedAppend: false },
      ]);

      await runFill({ ...options(send), text, platform: 'darwin' });

      expect(
        pageCalls(calls, 'async function(expected)').map((call) =>
          firstArgument(call.params),
        ),
      ).toEqual([expected, expected]);
      expect(typedCharacters(calls)).toEqual(expected.split(''));
    },
  );

  it('compares a textarea fill with CRLF line breaks as the LF breaks the textarea stores', async () => {
    const { send, calls } = harness([
      state({ tagName: 'textarea' }),
      { matches: false, retainedAppend: false },
      { matches: true, retainedAppend: false },
    ]);

    await runFill({
      ...options(send),
      text: 'first\r\nsecond',
      platform: 'darwin',
    });

    expect(
      pageCalls(calls, 'async function(expected)').map((call) =>
        firstArgument(call.params),
      ),
    ).toEqual(['first\nsecond', 'first\nsecond']);
    expect(typedCharacters(calls)).toEqual([
      ...'first'.split(''),
      '\r',
      ...'second'.split(''),
    ]);
  });

  it('does not type when the page moved focus away from the field it reverted', async () => {
    const { send, calls } = harness([
      state(),
      { matches: false, retainedAppend: false },
      'reverted',
    ]);
    const focus = jest.fn(() =>
      Promise.resolve({
        focused: false,
        completed: true as const,
        inputMode: 'trusted' as const,
      }),
    );

    const result = await runFill({
      ...options(send),
      text: 'next',
      platform: 'darwin',
      focus,
    });

    expect(focus).toHaveBeenCalledTimes(1);
    expect(calls.some((call) => call.method === 'Input.dispatchKeyEvent')).toBe(
      false,
    );
    expect(result).toMatchObject({
      inputMode: 'direct',
      readback: { code: 'state_unchanged' },
      target: { value: 'reverted' },
    });
    expect(result.warnings).toContain(
      'The field lost focus, so the text was not typed.',
    );
  });

  it.each([
    ['color', '#FF0000', '#ff0000'],
    ['time', '09:30:00', '09:30:00'],
    ['time', '09:00', '09:00'],
    ['time', '09:30:00.000', '09:30:00.000'],
    ['time', '09:30:15.500', '09:30:15.500'],
    ['datetime-local', '2026-10-12T09:30:00', '2026-10-12T09:30'],
    ['datetime-local', '2026-10-12T09:30:00.000', '2026-10-12T09:30'],
    ['datetime-local', '2026-10-12T09:30:15.500', '2026-10-12T09:30:15.5'],
    ['datetime-local', '2026-10-12 09:30', '2026-10-12T09:30'],
    ['time', 'nope', 'nope'],
    ['date', '2026-10-12', '2026-10-12'],
    ['text', 'Hello', 'Hello'],
  ])(
    'compares a %s value %j as the browser stores it',
    (type, text, stored) => {
      const evaluate: unknown = Reflect.get(globalThis, 'eval');
      if (typeof evaluate !== 'function') throw new Error('No eval');
      const normalize: unknown = Reflect.apply(evaluate, undefined, [
        `(${NORMALIZED_INPUT_VALUE_FUNCTION})`,
      ]);
      if (typeof normalize !== 'function') throw new Error('Not a function');
      expect(Reflect.apply(normalize, undefined, [type, text])).toBe(stored);
    },
  );

  it.each([
    ['<input type="range">', '0 to 100 in steps of 1'],
    ['<input type="range" min="1" max="9" step="2">', '1 to 9 in steps of 2'],
  ])('gives %s the format snapshot rows give it', async (markup, format) => {
    const { send, calls } = harness([state(), { matches: true }]);
    await runFill({ ...options(send), text: 'value', platform: 'darwin' });
    const declaration = pageCalls(calls, 'const datepicker')[0]?.params
      .functionDeclaration;
    if (typeof declaration !== 'string')
      throw new Error('Expected the fill target read.');
    const dom = new JSDOM(markup, {
      url: 'https://example.test/',
      runScripts: 'outside-only',
    });
    dom.window.eval(
      `document.body.dataset.format = (${declaration}).call(document.querySelector('input')).format`,
    );
    expect(dom.window.document.body.dataset.format).toBe(format);
  });

  it('types and compares an editor fill with CRLF line breaks as LF', async () => {
    const editor = state({
      tagName: 'div',
      inputType: '',
      kind: 'editor',
      editor: true,
    });
    const { send, calls } = harness([
      editor,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      'ab\ncd',
    ]);

    const result = await runFill({
      ...options(send),
      text: 'ab\r\ncd',
      platform: 'darwin',
    });

    expect(result).toMatchObject({ completed: true, editor: true });
    expect(result).not.toHaveProperty('readback');
    expect(typedCharacters(calls)).toEqual(['a', 'b', '\r', 'c', 'd']);
    expect(
      pageCalls(calls, 'function(expected)').map((call) =>
        firstArgument(call.params),
      ),
    ).toEqual(['ab\ncd']);
  });

  it('stops an editor fill when the editor loses focus after a character', async () => {
    const editor = state({
      tagName: 'div',
      inputType: '',
      kind: 'editor',
      editor: true,
    });
    // Clear, empty, then the first character's mark and change check; the
    // focus check before the second character says the editor lost focus.
    const { send, calls } = harness(
      [editor, true, true, true, true, 'a'],
      [false],
    );

    const result = await runFill({
      ...options(send),
      text: 'abc',
      platform: 'darwin',
    });

    expect(typedCharacters(calls)).toEqual(['a']);
    expect(result).toMatchObject({
      editor: true,
      readback: { code: 'state_unchanged' },
      warnings: [
        'The editor lost focus while typing, so the rest of the text was not typed.',
      ],
    });
  });

  it.each(['X', ''])(
    'sends nothing after select-all once a handler moved focus out of the field (text %j)',
    async (text) => {
      const { send, calls } = harness(
        [state(), { matches: false, retainedAppend: false }, 'reverted'],
        [false],
      );

      const result = await runFill({
        ...options(send),
        text,
        platform: 'darwin',
      });

      const keys = calls
        .filter((call) => call.method === 'Input.dispatchKeyEvent')
        .map((call) => call.params.key);
      // Select-all was sent; neither the text nor Backspace followed it.
      expect(keys).toContain('A');
      expect(keys).not.toContain('X');
      expect(keys).not.toContain('Backspace');
      expect(typedCharacters(calls)).toEqual([]);
      expect(result).toMatchObject({
        readback: { code: 'state_unchanged' },
        warnings: [
          'The field lost focus while typing, so the rest of the text was not typed.',
        ],
      });
    },
  );

  it('stops typing a reverted value when the field loses focus after a character', async () => {
    const { send, calls } = harness(
      [state(), { matches: false, retainedAppend: false }, 'a'],
      // Focus is kept after select-all, then lost after the first character.
      [true, false],
    );

    const result = await runFill({
      ...options(send),
      text: 'abc',
      platform: 'darwin',
    });

    expect(typedCharacters(calls)).toEqual(['a']);
    expect(result).toMatchObject({
      readback: { code: 'state_unchanged' },
      warnings: [
        'The field lost focus while typing, so the rest of the text was not typed.',
      ],
    });
  });

  it('sends no clearing keys once the clearing click moved focus out of the editor', async () => {
    const editor = state({
      tagName: 'div',
      inputType: '',
      kind: 'editor',
      editor: true,
    });
    // The script clear is rejected; after the triple-click the editor no
    // longer has focus.
    const { send, calls } = harness([editor, false, 'old'], [false]);

    const result = await runFill({
      ...options(send),
      text: 'new',
      platform: 'darwin',
    });

    expect(calls.some((call) => call.method === 'Input.dispatchKeyEvent')).toBe(
      false,
    );
    expect(result).toMatchObject({
      editor: true,
      readback: { code: 'state_unchanged' },
      warnings: [
        'The editor lost focus while it was cleared, so the text was not typed.',
      ],
    });
  });

  it("reads the editing host's secrecy before clearing it, and withholds its text when it is secret", async () => {
    const editor = state({
      tagName: 'div',
      inputType: '',
      kind: 'editor',
      editor: true,
    });
    const { send, calls } = harness([editor, true, true, true, true, true]);
    const order: string[] = [];
    const classifyInputTarget = jest.fn((inputTarget: ResolvedActionTarget) => {
      order.push(
        `classify:${inputTarget.objectId}:${String(pageCalls(calls, 'deleteContent').length)}`,
      );
      return Promise.resolve(true);
    });

    const result = await runFill({
      ...options(send, { classifyInputTarget }),
      text: 'a',
      platform: 'darwin',
    });

    // Classified once, on the editing host, before the clearing call.
    expect(order).toEqual(['classify:normalized-editor-object:0']);
    expect(result).toMatchObject({ editor: true });
    expect(result).not.toHaveProperty('target');
  });

  it('compares an editor fill with a no-break space the way the editor text is read', async () => {
    const editor = state({
      tagName: 'div',
      inputType: '',
      kind: 'editor',
      editor: true,
    });
    const { send, calls } = harness([
      editor,
      true,
      true,
      true,
      true,
      true,
      'a b',
    ]);
    await runFill({ ...options(send), text: 'a\u00a0b', platform: 'darwin' });
    const declaration = pageCalls(calls, 'function(expected)')[0]?.params
      .functionDeclaration;
    if (typeof declaration !== 'string')
      throw new Error('Expected the editor comparison call.');
    const dom = new JSDOM('<div contenteditable="true">a\u00a0b</div>', {
      url: 'https://example.test/',
      runScripts: 'outside-only',
    });
    dom.window.eval(
      `document.body.dataset.matches = String((${declaration}).call(document.querySelector('div'), 'a\\u00a0b'))`,
    );
    expect(dom.window.document.body.dataset.matches).toBe('true');
  });

  it('does not type into an editor that lost focus while it was cleared', async () => {
    const editor = state({
      tagName: 'div',
      inputType: '',
      kind: 'editor',
      editor: true,
    });
    const { send, calls } = harness([editor, true, true, '']);
    const focus = jest.fn(() =>
      Promise.resolve({
        focused: false,
        completed: true as const,
        inputMode: 'trusted' as const,
      }),
    );

    const result = await runFill({
      ...options(send),
      text: 'hello',
      platform: 'darwin',
      focus,
    });

    expect(focus).toHaveBeenCalledWith({
      objectId: 'normalized-editor-object',
      backendNodeId: 2,
    });
    expect(typedCharacters(calls)).toEqual([]);
    expect(result).toMatchObject({
      editor: true,
      readback: { code: 'state_unchanged' },
    });
    expect(result.warnings).toContain(
      'The editor lost focus, so the text was not typed.',
    );
  });

  it('does not focus or type again while the user is picking an element', async () => {
    const focusResult: FocusDispatchResult = {
      focused: true,
      completed: true,
      inputMode: 'trusted',
    };
    const focus = jest.fn<Promise<FocusDispatchResult>, []>(() =>
      Promise.resolve(focusResult),
    );
    const { send, calls } = harness([
      state(),
      { matches: false, retainedAppend: false },
      'reverted',
    ]);

    const result = await runFill({
      ...options(send, { focus, pickMode: true }),
      text: 'wanted',
      platform: 'darwin',
    });

    expect(focus).not.toHaveBeenCalled();
    expect(calls.some((call) => call.method === 'Input.dispatchKeyEvent')).toBe(
      false,
    );
    expect(result).toMatchObject({
      inputMode: 'direct',
      readback: { code: 'state_unchanged' },
    });
    expect(result.warnings?.[0]).toBe(
      'The page reverted the value. It was not typed instead, because the user is picking an element and focusing the field can take a click.',
    );
  });

  it('keeps the clearing warning beside an autocomplete hint', async () => {
    const editor = state({
      tagName: 'div',
      inputType: '',
      role: 'combobox',
      kind: 'editor',
      editor: true,
      autocompleteWarning: true,
    });
    const { send } = harness([editor, false, false, false, 'still here']);

    const result = await runFill({
      ...options(send),
      text: 'wanted',
      platform: 'darwin',
      fillDirect: () => Promise.resolve(undefined),
    });

    expect(result.readback).toEqual({ code: 'state_unchanged' });
    expect(result.warnings?.[0]).toBe(
      'The editor could not be cleared before filling it.',
    );
    expect(result.warnings).toHaveLength(2);
  });

  it('returns a readback warning when all editor clearing stages leave text behind', async () => {
    const editor = state({
      tagName: 'div',
      inputType: '',
      kind: 'editor',
      editor: true,
    });
    const { send, calls } = harness([
      editor,
      false,
      false,
      false,
      'still here',
    ]);

    const result = await runFill({
      ...options(send),
      text: 'wanted',
      platform: 'darwin',
      fillDirect: () => Promise.resolve(undefined),
    });

    expect(result).toMatchObject({
      completed: true,
      editor: true,
      readback: { code: 'state_unchanged' },
      target: { value: 'still here' },
      warnings: ['The editor could not be cleared before filling it.'],
    });
    expect(
      calls.filter(
        (call) =>
          call.method === 'Input.dispatchKeyEvent' &&
          typeof call.params.text === 'string',
      ),
    ).toHaveLength(0);
  });

  it('refuses oversized editor text before dispatch and skips oversized text-input fallback', async () => {
    const editorLane = lane();
    const editorSend = harness([
      state({
        tagName: 'div',
        editable: true,
        kind: 'editor',
        editor: true,
        editingHost: { backendNodeId: 2 },
      }),
    ]);
    const longText = 'x'.repeat(4001);
    await expect(
      runFill({
        ...options(editorSend.send, { lane: editorLane }),
        text: longText,
        platform: 'darwin',
        fillDirect: () => Promise.resolve(undefined),
      }),
    ).rejects.toMatchObject({
      error: {
        code: 'unsupported_control',
        message:
          'The text is too long to type into this editor: 4,000 characters at most.',
      } satisfies Partial<BrowserActionError>,
    });
    expect(editorLane.beginDispatch).not.toHaveBeenCalled();

    const input = harness([
      state(),
      { matches: false, retainedAppend: false },
      false,
    ]);
    const result = await runFill({
      ...options(input.send),
      text: longText,
      platform: 'darwin',
      fillDirect: () => Promise.resolve(undefined),
    });
    expect(result).toMatchObject({ readback: { code: 'state_unchanged' } });
    expect(
      input.calls.some((call) => call.method === 'Input.dispatchKeyEvent'),
    ).toBe(false);
  });

  it('refuses an editor while the user is picking an element, and still fills a text field', async () => {
    // Clearing an editor can take a real triple-click, which the pick
    // overlay would take as the user's pick.
    const editorLane = lane();
    const editorSend = harness([
      state({
        tagName: 'div',
        editable: true,
        kind: 'editor',
        editor: true,
        editingHost: { backendNodeId: 2 },
      }),
    ]);
    await expect(
      runFill({
        ...options(editorSend.send, { lane: editorLane }),
        pickMode: true,
        text: 'Hello',
        platform: 'darwin',
        fillDirect: () => Promise.resolve(undefined),
      }),
    ).rejects.toMatchObject({
      error: {
        code: 'execution_failed',
        message: 'The user is picking an element. Try again after they finish.',
      } satisfies Partial<BrowserActionError>,
    });
    expect(editorLane.beginDispatch).not.toHaveBeenCalled();
    expect(
      editorSend.calls.some((call) => call.method.startsWith('Input.')),
    ).toBe(false);

    const input = harness([state(), { matches: true }]);
    await expect(
      runFill({
        ...options(input.send),
        pickMode: true,
        text: 'Hello',
        platform: 'darwin',
        fillDirect: () => Promise.resolve(undefined),
      }),
    ).resolves.toMatchObject({ inputMode: 'direct' });
  });

  it('adds autocomplete guidance and a 400 ms settle only for explicit suggestion targets', async () => {
    const { send } = harness([
      state({ autocompleteWarning: true, settleMs: 400 }),
      { matches: true },
    ]);

    const result = await runFill({
      ...options(send),
      text: 'query',
      platform: 'darwin',
      fillDirect: () => Promise.resolve(undefined),
    });

    expect(result).toMatchObject({
      warnings: [
        'Wait for suggestions and click one instead of pressing Enter.',
      ],
      settleMs: 400,
    });
  });

  it('preflights with a real ActionLane before the first state-changing command', async () => {
    const { send } = harness([state(), { matches: true }]);
    const actionLane = new ActionLane({
      runtimeKey: {},
      generation: 1,
      isCurrent: (): boolean => true,
    });

    const outcome = await actionLane.run((context) =>
      runFill({
        ...options(send, { lane: context }),
        text: 'ready',
        platform: 'darwin',
        fillDirect: () => Promise.resolve(undefined),
      }),
    );

    expect(outcome.status).toBe('executed');
    if (outcome.status === 'executed')
      expect(outcome.value).toMatchObject({
        completed: true,
        inputMode: 'direct',
      });
  });
});
