import { JSDOM } from 'jsdom';
import { ActionLane, type ActionLaneContext } from '../action-lane';
import { dispatchTyping, HAS_FOCUS_FUNCTION, runType } from '../type';
import type { FormActionOptions } from '../form-action';
import type { ResolvedActionTarget } from '../../frames/action-targets';

function lane(): ActionLane {
  return new ActionLane({
    runtimeKey: {},
    generation: 1,
    isCurrent: () => true,
  });
}

const target: ResolvedActionTarget = {
  identity: {
    frameId: 'frame',
    sessionId: 'session',
    loaderId: 'loader',
    backendNodeId: 1,
  },
  frameRef: 'frame-ref',
  objectId: 'host-object',
  objectGroup: 'object-group',
  outOfProcess: false,
};

describe('browser type action', () => {
  it('dispatches a real keyDown carrying the text, then keyUp, and Enter carriage return', async () => {
    const calls: Array<{
      params: Record<string, unknown>;
      sessionId?: string;
    }> = [];
    const result = await lane().run((context) =>
      dispatchTyping({
        send: (_method, params, sessionId) => {
          calls.push({ params, ...(sessionId ? { sessionId } : {}) });
          return Promise.resolve({});
        },
        lane: context,
        sessionId: 'frame-session',
        text: 'a\n',
      }),
    );

    expect(result.status).toBe('executed');
    expect(result.value).toMatchObject({
      completed: true,
      inputMode: 'trusted',
    });
    // Text rides on the keyDown, so a page that cancels the keydown (an
    // editor handling Enter itself) gets no second insertion.
    expect(calls.map(({ params }) => params.type)).toEqual([
      'keyDown',
      'keyUp',
      'keyDown',
      'keyUp',
    ]);
    expect(calls[0].params).toMatchObject({ key: 'a', text: 'a' });
    expect(calls[1].params).not.toHaveProperty('text');
    expect(calls[2].params).toMatchObject({ key: 'Enter', text: '\r' });
    for (const { params } of calls)
      expect(params).not.toHaveProperty('nativeVirtualKeyCode');
    expect(calls.every(({ sessionId }) => sessionId === 'frame-session')).toBe(
      true,
    );
  });

  it.each(['a\r\nb', 'a\rb', 'a\nb'])(
    'types %j with one Enter for its line break',
    async (text) => {
      const chars: unknown[] = [];
      await lane().run((context) =>
        dispatchTyping({
          send: (_method, params) => {
            if (typeof params.text === 'string') chars.push(params.key);
            return Promise.resolve({});
          },
          lane: context,
          sessionId: 'frame-session',
          text,
        }),
      );

      expect(chars).toEqual(['a', 'Enter', 'b']);
    },
  );

  it('asks before each character after the first whether the target kept focus, and stops when it did not', async () => {
    const chars: unknown[] = [];
    const keepsFocus = jest
      .fn<Promise<boolean>, []>()
      .mockResolvedValueOnce(false);
    const result = await lane().run((context) =>
      dispatchTyping({
        send: (_method, params) => {
          if (typeof params.text === 'string') chars.push(params.text);
          return Promise.resolve({});
        },
        lane: context,
        sessionId: 'frame-session',
        text: 'abc',
        keepsFocus,
      }),
    );

    expect(result.status).toBe('executed');
    expect(result.value).toMatchObject({ completed: true, focusLost: true });
    expect(chars).toEqual(['a']);
    expect(keepsFocus).toHaveBeenCalledTimes(1);
  });

  it('stops a targeted type when the target loses focus after a character', async () => {
    const chars: unknown[] = [];
    const send: FormActionOptions['send'] = (method, params) => {
      if (
        method === 'Input.dispatchKeyEvent' &&
        typeof params.text === 'string'
      )
        chars.push(params.text);
      if (method === 'Runtime.callFunctionOn' && params.returnByValue === true)
        return Promise.resolve({
          result: {
            value:
              typeof params.functionDeclaration === 'string' &&
              params.functionDeclaration.includes('root.activeElement !== host')
                ? false
                : {
                    connected: true,
                    tagName: 'input',
                    role: '',
                    inputType: 'text',
                    disabled: false,
                    readOnly: false,
                    editable: true,
                    editor: false,
                    autocompleteWarning: false,
                    settleMs: 0,
                  },
          },
        });
      return Promise.resolve({});
    };
    const outcome = await lane().run((context) =>
      runType({
        send,
        lane: context,
        target,
        secret: false,
        click: () => Promise.resolve({ completed: true, inputMode: 'trusted' }),
        focus: () =>
          Promise.resolve({
            focused: true,
            completed: true,
            inputMode: 'trusted',
          }),
        targeted: true,
        text: 'abc',
      }),
    );

    expect(outcome).toMatchObject({
      status: 'executed',
      value: {
        completed: true,
        readback: { code: 'state_unchanged' },
        warnings: [
          'The target lost focus while typing, so the rest of the text was not typed.',
        ],
      },
    });
    expect(chars).toEqual(['a']);
  });

  it('finds focus on an input inside a closed shadow root, and on an element inside the target', () => {
    const dom = new JSDOM(
      '<div id="host"></div><div id="wrap"><input id="inner"></div><input id="other">',
      {
        url: 'https://example.test/',
        runScripts: 'outside-only',
      },
    );
    dom.window.eval(`
      const hasFocus = ${HAS_FOCUS_FUNCTION};
      const root = document.getElementById('host').attachShadow({ mode: 'closed' });
      root.innerHTML = '<input id="closed">';
      const closed = root.getElementById('closed');
      const results = [];
      closed.focus();
      results.push(hasFocus.call(closed));
      results.push(hasFocus.call(document.getElementById('host')));
      document.getElementById('inner').focus();
      results.push(hasFocus.call(document.getElementById('wrap')));
      results.push(hasFocus.call(closed));
      document.getElementById('other').focus();
      results.push(hasFocus.call(document.getElementById('wrap')));
      document.body.dataset.results = results.join(',');
    `);
    expect(dom.window.document.body.dataset.results).toBe(
      'true,true,true,false,false',
    );
  });

  it('waits delayMs between characters without delaying the first character', async () => {
    jest.useFakeTimers();
    try {
      const calls: Array<Record<string, unknown>> = [];
      const pending = lane().run((context) =>
        dispatchTyping({
          send: (_method, params) => {
            calls.push(params);
            return Promise.resolve({});
          },
          lane: context,
          text: 'ab',
          delayMs: 100,
        }),
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(
        calls
          .filter((params) => typeof params.text === 'string')
          .map((params) => params.text),
      ).toEqual(['a']);
      await jest.advanceTimersByTimeAsync(99);
      expect(
        calls.filter((params) => typeof params.text === 'string'),
      ).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(1);
      expect((await pending).status).toBe('executed');
      expect(
        calls
          .filter((params) => typeof params.text === 'string')
          .map((params) => params.text),
      ).toEqual(['a', 'b']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('checks cancellation between characters and does not dispatch the next one', async () => {
    const controller = new AbortController();
    const calls: Array<Record<string, unknown>> = [];
    const context: ActionLaneContext = {
      signal: controller.signal,
      sequence: 1,
      beginDispatch: jest.fn(),
      trackCommand: <T>(command: Promise<T>): Promise<T> => command,
      registerCleanup: jest.fn(),
    };

    await expect(
      dispatchTyping({
        send: (_method, params) => {
          calls.push(params);
          if (params.type === 'keyUp' && params.key === 'a') controller.abort();
          return Promise.resolve({});
        },
        lane: context,
        text: 'ab',
      }),
    ).rejects.toThrow();

    expect(calls.map((params) => params.type)).toEqual(['keyDown', 'keyUp']);
  });

  it('keeps the public type action algorithm available to service integration', () => {
    expect(typeof runType).toBe('function');
  });

  it('refuses a disabled target before focus or key input', async () => {
    const send = jest.fn(() =>
      Promise.resolve({
        result: {
          value: {
            connected: true,
            tagName: 'input',
            role: '',
            inputType: 'text',
            disabled: true,
            readOnly: false,
            editable: true,
            editor: false,
            kind: 'text',
            autocompleteWarning: false,
            settleMs: 0,
          },
        },
      }),
    );
    const focus = jest.fn<ReturnType<FormActionOptions['focus']>, []>(() =>
      Promise.resolve({
        focused: true,
        inputMode: 'trusted',
        completed: true,
      }),
    );
    const click: FormActionOptions['click'] = () =>
      Promise.resolve({ completed: true, inputMode: 'trusted' });
    const outcome = await lane().run((context) =>
      runType({
        send,
        lane: context,
        target,
        secret: false,
        click,
        focus,
        targeted: true,
        text: 'x',
      }),
    );

    expect(outcome).toMatchObject({ status: 'not_executed' });
    expect(focus).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('treats contenteditable="inherit" and unknown values as the parent decides', async () => {
    const declarations: string[] = [];
    const send: FormActionOptions['send'] = (method, params) => {
      if (
        method === 'Runtime.callFunctionOn' &&
        typeof params.functionDeclaration === 'string'
      )
        declarations.push(params.functionDeclaration);
      if (method === 'Runtime.callFunctionOn' && params.returnByValue === true)
        return Promise.resolve({
          result: {
            value: {
              connected: true,
              tagName: 'span',
              role: '',
              inputType: '',
              disabled: false,
              editable: true,
              editor: true,
              kind: 'editor',
              autocompleteWarning: false,
              settleMs: 0,
            },
          },
        });
      if (method === 'Runtime.callFunctionOn')
        return Promise.resolve({
          result: { objectId: 'editing-host-object' },
        });
      if (method === 'DOM.describeNode')
        return Promise.resolve({ node: { backendNodeId: 2 } });
      return Promise.resolve({});
    };
    await lane().run((context) =>
      runType({
        send,
        lane: context,
        target,
        secret: false,
        click: () => Promise.resolve({ completed: true, inputMode: 'trusted' }),
        focus: () =>
          Promise.resolve({
            focused: true,
            completed: true,
            inputMode: 'trusted',
          }),
        targeted: true,
        text: 'a',
      }),
    );
    const declaration = (marker: string): string => {
      const found = declarations.find((source) => source.includes(marker));
      if (found === undefined)
        throw new Error(`Expected a page call with ${marker}.`);
      return found;
    };
    const dom = new JSDOM(
      '<div contenteditable="false"><span id="inherit" contenteditable="inherit">kept</span><span id="unknown" contenteditable="maybe">kept</span></div>' +
        '<div id="host" contenteditable="true"><span id="nested" contenteditable="inherit">x</span></div>',
      { url: 'https://example.test/', runScripts: 'outside-only' },
    );
    dom.window.eval(`
      const classify = ${declaration('ariaReadOnly')};
      const host = ${declaration('parentEditable')};
      document.body.dataset.results = ['inherit', 'unknown', 'nested']
        .map(id => {
          const element = document.getElementById(id);
          const found = host.call(element);
          return id + ':' + classify.call(element).editor + ':' + (found ? found.id : 'none');
        })
        .join(',');
    `);
    expect(dom.window.document.body.dataset.results).toBe(
      'inherit:false:none,unknown:false:none,nested:true:host',
    );
  });

  it("reads the editing host's secrecy before focusing it", async () => {
    const order: string[] = [];
    const send: FormActionOptions['send'] = (method, params) => {
      if (method === 'Runtime.callFunctionOn' && params.returnByValue === true)
        return Promise.resolve({
          result: {
            value:
              typeof params.functionDeclaration === 'string' &&
              params.functionDeclaration.includes('root.activeElement !== host')
                ? true
                : {
                    connected: true,
                    tagName: 'span',
                    role: '',
                    inputType: '',
                    disabled: false,
                    editable: true,
                    editor: true,
                    kind: 'editor',
                    autocompleteWarning: false,
                    settleMs: 0,
                  },
          },
        });
      if (method === 'Runtime.callFunctionOn')
        return Promise.resolve({ result: { objectId: 'editing-host-object' } });
      if (method === 'DOM.describeNode')
        return Promise.resolve({ node: { backendNodeId: 2 } });
      return Promise.resolve({});
    };
    await lane().run((context) =>
      runType({
        send,
        lane: context,
        target,
        secret: false,
        click: () => Promise.resolve({ completed: true, inputMode: 'trusted' }),
        focus: () => {
          order.push('focus');
          return Promise.resolve({
            focused: true,
            completed: true,
            inputMode: 'trusted',
          });
        },
        classifyInputTarget: (inputTarget) => {
          order.push(`classify:${inputTarget.objectId}`);
          return Promise.resolve(false);
        },
        targeted: true,
        text: 'a',
      }),
    );
    expect(order).toEqual(['classify:editing-host-object', 'focus']);
  });

  it('returns the normalized editing host and marks contenteditable typing as editor input', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> =
      [];
    const dispatchSteps: string[] = [];
    const onEditor = jest.fn(() => dispatchSteps.push('editor-window'));
    let focusedTarget: { objectId: string; backendNodeId: number } | undefined;
    const focus: FormActionOptions['focus'] = (relatedTarget) => {
      dispatchSteps.push('focus');
      focusedTarget = relatedTarget;
      return Promise.resolve({
        focused: true,
        completed: true,
        inputMode: 'trusted',
      });
    };
    const send: FormActionOptions['send'] = (method, params) => {
      calls.push({ method, params });
      if (method === 'Input.dispatchKeyEvent') dispatchSteps.push('key');
      if (method === 'Runtime.callFunctionOn' && params.returnByValue === true)
        return Promise.resolve({
          result: {
            value: {
              connected: true,
              tagName: 'span',
              role: '',
              inputType: '',
              disabled: false,
              editable: true,
              editor: true,
              kind: 'editor',
              autocompleteWarning: false,
              settleMs: 0,
            },
          },
        });
      if (method === 'Runtime.callFunctionOn')
        return Promise.resolve({
          result: { objectId: 'editing-host-object' },
        });
      if (method === 'DOM.describeNode')
        return Promise.resolve({ node: { backendNodeId: 2 } });
      return Promise.resolve({});
    };
    const outcome = await lane().run((context) =>
      runType({
        send,
        lane: context,
        target,
        secret: false,
        click: () => Promise.resolve({ completed: true, inputMode: 'trusted' }),
        focus,
        onEditor,
        targeted: true,
        text: 'a',
      }),
    );

    if (outcome.status === 'not_executed')
      throw new Error(`Type action did not execute: ${outcome.message}`);
    expect(outcome).toMatchObject({
      status: 'executed',
      value: {
        completed: true,
        inputMode: 'trusted',
        editor: true,
        recordingTarget: {
          objectId: 'editing-host-object',
          identity: { backendNodeId: 2 },
        },
      },
    });
    expect(
      calls.filter((call) => call.method === 'Input.dispatchKeyEvent'),
    ).toHaveLength(2);
    expect(onEditor).toHaveBeenCalledTimes(1);
    expect(dispatchSteps[0]).toBe('editor-window');
    expect(dispatchSteps.indexOf('key')).toBeGreaterThan(
      dispatchSteps.indexOf('editor-window'),
    );
    expect(focusedTarget).toEqual({
      objectId: 'editing-host-object',
      backendNodeId: 2,
    });
  });

  it('reports focus failure as unchanged and merges the autocomplete warning', async () => {
    const send = jest.fn(() =>
      Promise.resolve({
        result: {
          value: {
            connected: true,
            tagName: 'input',
            role: 'combobox',
            inputType: 'text',
            disabled: false,
            readOnly: false,
            editable: true,
            editor: false,
            kind: 'text',
            autocompleteWarning: true,
            settleMs: 400,
          },
        },
      }),
    );
    const outcome = await lane().run((context) => {
      const focus: FormActionOptions['focus'] = () => {
        context.beginDispatch();
        return Promise.resolve({
          focused: false,
          completed: true,
          inputMode: 'trusted',
          warning: 'Focus could not be confirmed.',
        });
      };
      return runType({
        send,
        lane: context,
        target,
        secret: false,
        click: () => Promise.resolve({ completed: true, inputMode: 'trusted' }),
        focus,
        targeted: true,
        text: 'x',
      });
    });

    expect(outcome).toMatchObject({
      status: 'executed',
      value: {
        completed: true,
        inputMode: 'trusted',
        readback: { code: 'state_unchanged' },
        warnings: [
          'Focus could not be confirmed.',
          'Wait for suggestions and click one instead of pressing Enter.',
        ],
        settleMs: 400,
      },
    });
    expect(send.mock.calls).toHaveLength(1);
  });
});
