/**
 * @jest-environment jsdom
 */
import { runInNewContext } from 'node:vm';
import {
  decodeTrackerWitness,
  encodeTrackerWitness,
  mainWorldTrackerSource,
  TRACKER_WITNESS_RESOLVER_KEY,
} from '@canopy/desktop-shared/browser/page-trackers';
type CommandHandler = (_event: unknown, command: unknown) => void;
type IpcOnCall = [string, CommandHandler];
type IpcSendCall = [string, unknown];
const mockIpcOn = jest.fn<void, IpcOnCall>();
const mockIpcSend = jest.fn<void, IpcSendCall>();

function privateResolver(key: string): (...arguments_: unknown[]) => unknown {
  const value: unknown = Reflect.get(globalThis, key);
  if (typeof value !== 'function') {
    throw new Error(`Missing private resolver ${key}`);
  }
  return (...arguments_: unknown[]): unknown =>
    Reflect.apply(value, globalThis, arguments_);
}

function inspectionFields(value: unknown): Record<string, unknown> {
  let snapshot: unknown = value;
  if (
    typeof snapshot === 'object' &&
    snapshot !== null &&
    'result' in snapshot
  ) {
    snapshot = snapshot.result;
  }
  if (
    typeof snapshot !== 'object' ||
    snapshot === null ||
    !('locatorCandidates' in snapshot) ||
    !('preferredLocator' in snapshot) ||
    !('domPath' in snapshot) ||
    !('outerHtml' in snapshot)
  ) {
    throw new Error('Missing inspection snapshot fields');
  }
  return {
    locatorCandidates: snapshot.locatorCandidates,
    preferredLocator: snapshot.preferredLocator,
    domPath: snapshot.domPath,
    outerHtml: snapshot.outerHtml,
  };
}

const mockExecuteJavaScript = jest.fn<Promise<unknown>, [string]>();

jest.mock('electron', () => ({
  ipcRenderer: {
    on: mockIpcOn,
    send: mockIpcSend,
  },
  webFrame: {
    executeJavaScript: (source: string): Promise<unknown> =>
      mockExecuteJavaScript(source),
  },
}));

describe('browser-view preload bridges, pick mode and recording', () => {
  let commandHandler: CommandHandler | undefined;
  let picks = 0;

  function commandResult(requestId: string): unknown {
    return mockIpcSend.mock.calls.find(
      ([channel, value]) =>
        channel === 'canopy-browser-view:result' &&
        typeof value === 'object' &&
        value !== null &&
        'requestId' in value &&
        value.requestId === requestId,
    )?.[1];
  }

  /**
   * The snapshot pick mode sends for an element the user clicks: the
   * preload's own element snapshot (`snapshotFor`), with its redaction.
   */
  function pick(target: Element | null): Record<string, unknown> {
    if (!target) throw new Error('Missing pick target');
    picks += 1;
    commandHandler?.(null, {
      requestId: `pick-mode-${picks}`,
      type: 'setPickMode',
      payload: { browserId: 'browser-1', enabled: true },
    });
    const before = mockIpcSend.mock.calls.length;
    target.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    const event = mockIpcSend.mock.calls
      .slice(before)
      .find(
        ([channel, value]) =>
          channel === 'canopy-browser-view:event' &&
          typeof value === 'object' &&
          value !== null &&
          'type' in value &&
          value.type === 'element-picked',
      )?.[1];
    if (
      typeof event !== 'object' ||
      event === null ||
      !('snapshot' in event) ||
      typeof event.snapshot !== 'object' ||
      event.snapshot === null
    )
      throw new Error('Pick mode sent no element snapshot');
    return { ...event.snapshot };
  }

  beforeEach(async () => {
    jest.resetModules();
    mockIpcOn.mockReset();
    mockIpcSend.mockReset();
    document.body.innerHTML = '';
    await import('../browser-view');
    const calls: IpcOnCall[] = mockIpcOn.mock.calls;
    commandHandler = calls.find(
      ([channel]) => channel === 'canopy-browser-view:command',
    )?.[1];
  });

  it('registers the isolated-world bridges as nonenumerable, nonwritable globals', () => {
    for (const key of [
      '__canopyBrowserPasswordHistoryResolver_v1',
      '__canopyBrowserInspectResolver_v1',
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
      expect(descriptor).toMatchObject({
        configurable: true,
        enumerable: false,
        writable: false,
      });
      expect(typeof descriptor?.value).toBe('function');
    }
  });

  it('classifies current and synchronously revealed passwords fail-closed', () => {
    document.body.innerHTML = `
      <input id="password" type="password" />
      <input id="ordinary" type="text" />
      <textarea id="ordinary-textarea"></textarea>
      <button id="ordinary-button">Continue</button>
    `;
    const password = document.getElementById('password');
    const ordinary = document.getElementById('ordinary');
    const ordinaryTextarea = document.getElementById('ordinary-textarea');
    const ordinaryButton = document.getElementById('ordinary-button');
    if (
      !(password instanceof HTMLInputElement) ||
      !(ordinary instanceof HTMLInputElement) ||
      !(ordinaryTextarea instanceof HTMLTextAreaElement) ||
      !(ordinaryButton instanceof HTMLButtonElement)
    ) {
      throw new Error('Missing private resolver test elements');
    }

    const resolvePasswords = privateResolver(
      '__canopyBrowserPasswordHistoryResolver_v1',
    );
    expect(
      resolvePasswords(
        password,
        ordinary,
        ordinaryTextarea,
        ordinaryButton,
        null,
        { not: 'an element' },
      ),
    ).toEqual([true, false, false, false, true, true]);

    password.type = 'text';
    expect(resolvePasswords(password)).toEqual([true]);
  });

  it('drains a synchronous password reveal before the first resolver call', () => {
    const input = document.createElement('input');
    input.type = 'password';
    document.body.append(input);
    input.type = 'text';

    expect(
      privateResolver('__canopyBrowserPasswordHistoryResolver_v1')(input),
    ).toEqual([true]);
  });

  it.each(['input', 'container'] as const)(
    'remembers a removed password %s before a later-task detached reveal through the bridge (S7)',
    async (removedKind) => {
      const input = document.createElement('input');
      input.type = 'password';
      input.value = 'detached-credential-7291';
      const container = document.createElement('section');
      const nested = document.createElement('div');
      container.append(nested);
      nested.append(input);
      const removed = removedKind === 'input' ? input : container;
      document.body.append(removed);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      removed.remove();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      input.type = 'text';
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      document.body.append(removed);
      expect(
        privateResolver('__canopyBrowserPasswordHistoryResolver_v1')(input),
      ).toEqual([true]);
    },
  );

  it('returns the inspection snapshot fields and rejects foreign or non-elements', async () => {
    document.body.innerHTML =
      '<form><input id="target" aria-label="Email" /></form>';
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn(() => ({ matches: false })),
    });
    const target = document.getElementById('target');
    if (!(target instanceof HTMLInputElement))
      throw new Error('Missing private resolver inspection target');
    const { generateLocatorCandidates } = await import('../browser-view');
    const candidates = generateLocatorCandidates(target);
    const inspect = privateResolver('__canopyBrowserInspectResolver_v1');
    const result = inspect(target);
    expect(result).toEqual({
      locatorCandidates: candidates,
      preferredLocator: candidates[0],
      domPath: ['html', 'body', 'form', 'input'],
      outerHtml: target.outerHTML,
    });
    if (typeof result !== 'object' || result === null) {
      throw new Error('Missing private inspection result');
    }
    expect(Object.keys(result).sort()).toEqual([
      'domPath',
      'locatorCandidates',
      'outerHtml',
      'preferredLocator',
    ]);

    // The same fields pick mode reports for the element.
    expect(inspectionFields(pick(target))).toEqual(inspectionFields(result));

    const foreignDocument = document.implementation.createHTMLDocument('other');
    const foreignElement = foreignDocument.createElement('input');
    expect(inspect(foreignElement)).toBeNull();
    expect(inspect(null)).toBeNull();
    expect(inspect('input')).toBeNull();
    expect(inspect({ tagName: 'input' })).toBeNull();
  });

  it('redacts secret select subtrees through the private inspection bridge without changing live DOM', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn(() => ({ matches: false })),
    });
    document.body.innerHTML = `
      <select id="secret-select" autocomplete="cc-exp-month" aria-label="Expiration">
        <optgroup id="secret-group" label="private-group">
          <option id="secret-option" value="private-value" label="private-label" selected>
            private-month
          </option>
        </optgroup>
      </select>
    `;
    const select = document.getElementById('secret-select');
    const group = document.getElementById('secret-group');
    const option = document.getElementById('secret-option');
    if (
      !(select instanceof HTMLSelectElement) ||
      !(group instanceof HTMLOptGroupElement) ||
      !(option instanceof HTMLOptionElement)
    ) {
      throw new Error('Missing secret select test elements');
    }
    const inspect = privateResolver('__canopyBrowserInspectResolver_v1');
    const inspectedSelect = inspect(select);
    const inspectedGroup = inspect(group);
    const inspectedOption = inspect(option);
    const serialized = JSON.stringify([
      inspectedSelect,
      inspectedGroup,
      inspectedOption,
    ]);
    expect(serialized).not.toContain('private-group');
    expect(serialized).not.toContain('private-value');
    expect(serialized).not.toContain('private-label');
    expect(serialized).not.toContain('private-month');
    if (
      typeof inspectedSelect !== 'object' ||
      inspectedSelect === null ||
      !('outerHtml' in inspectedSelect)
    ) {
      throw new Error('Missing private secret select markup');
    }
    expect(inspectedSelect.outerHtml).not.toContain('selected');
    expect(option.value).toBe('private-value');
    expect(option.label).toBe('private-label');
    expect(option.textContent?.trim()).toBe('private-month');
    expect(option.selected).toBe(true);
    expect(option.hasAttribute('selected')).toBe(true);

    expect(inspectionFields(pick(select))).toEqual(
      inspectionFields(inspectedSelect),
    );
  });

  it('keeps controls the host classified as secret redacted after the page drops their marker', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn(() => ({ matches: false })),
    });
    document.body.innerHTML = `
      <form id="form">
        <input id="otp" autocomplete="one-time-code" value="host-secret-5522" />
        <textarea id="note" autocomplete="one-time-code">host-secret-3390</textarea>
        <input id="plain" value="plain-value-1188" />
      </form>
    `;
    const form = document.getElementById('form');
    const otp = document.getElementById('otp');
    const note = document.getElementById('note');
    const plain = document.getElementById('plain');
    if (
      !(form instanceof HTMLFormElement) ||
      !(otp instanceof HTMLInputElement) ||
      !(note instanceof HTMLTextAreaElement) ||
      !(plain instanceof HTMLInputElement)
    ) {
      throw new Error('Missing host-secret test elements');
    }
    otp.value = 'host-secret-5522';
    const inspect = privateResolver('__canopyBrowserInspectResolver_v1');
    // The page removes the marker after the host's capture saw it.
    otp.removeAttribute('autocomplete');
    note.removeAttribute('autocomplete');
    // Without the host's decision the live preload would expose the values.
    expect(JSON.stringify(inspect(form))).toContain('host-secret-5522');

    const withHostSecrets = JSON.stringify([
      inspect(form, otp, note, null, 'not an element'),
      inspect(otp, otp),
    ]);
    expect(withHostSecrets).not.toMatch(/host-secret-\d/);
    expect(withHostSecrets).toContain('plain-value-1188');

    // The decision holds for the element's lifetime, like password history,
    // and for the preload's own reads (pick mode).
    expect(JSON.stringify(inspect(form))).not.toMatch(/host-secret-\d/);
    const pickedOtp = pick(otp);
    const later = JSON.stringify([pickedOtp, pick(form)]);
    expect(later).not.toMatch(/host-secret-\d/);
    expect(pickedOtp).toMatchObject({ valueRedacted: true });
    expect(later).toContain('plain-value-1188');
  });

  it('ignores extra bridge arguments from a foreign document', () => {
    document.body.innerHTML = '<input id="plain" value="plain-value-2299" />';
    const plain = document.getElementById('plain');
    if (!(plain instanceof HTMLInputElement)) throw new Error('Missing input');
    const foreign = document.implementation
      .createHTMLDocument('other')
      .createElement('input');
    const inspect = privateResolver('__canopyBrowserInspectResolver_v1');
    expect(JSON.stringify(inspect(plain, foreign))).toContain(
      'plain-value-2299',
    );
  });

  it('caps inspected markup at ten thousand characters', () => {
    const element = document.createElement('div');
    element.innerHTML = `<span>${'x'.repeat(12_000)}</span>`;
    document.body.append(element);
    const result = privateResolver('__canopyBrowserInspectResolver_v1')(
      element,
    );
    if (
      typeof result !== 'object' ||
      result === null ||
      !('outerHtml' in result)
    ) {
      throw new Error('Missing private inspection markup');
    }
    expect(result.outerHtml).toHaveLength(10_000);
  });

  it('preserves the HTML instanceof secret classification for other namespaces', async () => {
    const element = document.createElementNS('urn:example', 'input');
    element.setAttribute('id', 'namespace-input');
    element.setAttribute('autocomplete', 'current-password');
    element.setAttribute('aria-label', 'Namespace field');
    document.body.append(element);
    expect(element.tagName.toLowerCase()).toBe('input');
    expect(element).not.toBeInstanceOf(HTMLInputElement);

    const { generateLocatorCandidates } = await import('../browser-view');
    const candidates = generateLocatorCandidates(element);
    expect(candidates.map((candidate) => candidate.kind)).toContain('role');
    expect(candidates.map((candidate) => candidate.kind)).toContain('domPath');
  });

  it('rejects malformed private command envelopes without running a handler', () => {
    document.body.innerHTML = '<input id="target" />';
    const input = document.querySelector('input');
    mockIpcSend.mockClear();
    commandHandler?.(null, {
      requestId: 'bad-type',
      type: 'unsupported',
      payload: {},
    });
    commandHandler?.(null, {
      requestId: ' ',
      type: 'setRecording',
      payload: { enabled: true },
    });
    commandHandler?.(null, null);
    expect(commandResult('bad-type')).toMatchObject({ ok: false });
    expect(
      mockIpcSend.mock.calls.filter(
        ([channel]) => channel === 'canopy-browser-view:result',
      ),
    ).toHaveLength(1);
    expect(input?.value).toBe('');
  });

  it('refuses the snapshot, inspect, wait and action commands the page model replaced (phase 04b S4)', () => {
    document.body.innerHTML = '<input id="target" />';
    const input = document.querySelector('input');
    const removed = [
      'inspect',
      'inputSnapshot',
      'click',
      'fill',
      'press',
      'prepare-target',
      'fill-prepared',
      'describe-prepared',
      'release-prepared',
      'wait-for-probe',
    ];
    for (const type of removed)
      commandHandler?.(null, {
        requestId: `removed-${type}`,
        type,
        payload: {
          browserId: 'browser-1',
          locator: '#target',
          text: 'filled',
          handleId: 'handle',
        },
      });
    for (const type of removed)
      expect(commandResult(`removed-${type}`)).toEqual({
        requestId: `removed-${type}`,
        ok: false,
        error: 'Invalid browser view command.',
      });
    expect(input?.value).toBe('');
    for (const key of [
      '__canopyBrowserTrustedActionTargetResolver_v1',
      '__canopyBrowserPreparedActionTargetResolver_v1',
    ])
      expect(Reflect.get(globalThis, key)).toBeUndefined();
  });

  it('keeps legacy omitted-payload command behavior', () => {
    commandHandler?.(null, {
      requestId: 'legacy-recording',
      type: 'setRecording',
    });
    expect(commandResult('legacy-recording')).toMatchObject({
      ok: true,
      result: { recording: false },
    });
  });

  describe('form recording steps', () => {
    function setRecording(enabled: boolean): void {
      commandHandler?.(null, {
        requestId: `recording-${enabled ? 'start' : 'stop'}`,
        type: 'setRecording',
        payload: { browserId: 'browser-1', enabled },
      });
    }

    function recordedSteps(): unknown[] {
      return mockIpcSend.mock.calls
        .filter(
          ([channel, value]) =>
            channel === 'canopy-browser-view:event' &&
            typeof value === 'object' &&
            value !== null &&
            'type' in value &&
            value.type === 'recording-step',
        )
        .map(([, value]) => value);
    }

    afterEach(() => {
      setRecording(false);
    });

    it('tells the host which recorded steps are for an element the recorder holds secret', () => {
      document.body.innerHTML =
        '<div id="wrap">Password <input id="password" type="password" /></div>' +
        '<button id="go" type="button">Go</button>';
      const password = document.querySelector('#password');
      const wrap = document.querySelector('#wrap');
      const go = document.querySelector('#go');
      if (!password || !wrap || !go) throw new Error('Missing elements');

      setRecording(true);
      mockIpcSend.mockClear();
      password.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      wrap.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      go.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      const steps = recordedSteps();
      expect(steps).toHaveLength(3);
      // The field, and an element that contains it, get a locator with no text.
      expect(steps[0]).toMatchObject({ secretElement: true });
      expect(steps[1]).toMatchObject({ secretElement: true });
      expect(steps[2]).not.toHaveProperty('secretElement');
    });

    it('records nothing for a file input’s change, which the host records as an upload by name', () => {
      document.body.innerHTML =
        '<input id="attachment" type="file" aria-label="Attachment" />';
      const input = document.querySelector('input');
      if (!(input instanceof HTMLInputElement))
        throw new Error('Missing input');

      setRecording(true);
      mockIpcSend.mockClear();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));

      expect(recordedSteps()).toEqual([]);
    });

    it('records a checked checkbox change as check without a value', () => {
      document.body.innerHTML =
        '<input id="consent" type="checkbox" aria-label="Consent" />';
      const checkbox = document.querySelector('input');
      if (!(checkbox instanceof HTMLInputElement))
        throw new Error('Missing checkbox');
      checkbox.checked = true;

      setRecording(true);
      mockIpcSend.mockClear();
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));

      const steps = recordedSteps();
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        type: 'recording-step',
        step: {
          action: 'check',
          playwright:
            "await page.getByRole('checkbox', { name: 'Consent' }).check();",
        },
      });
      expect(steps[0]).not.toHaveProperty('step.value');
      setRecording(false);
    });

    it('records an unchecked checkbox change as uncheck without a value', () => {
      document.body.innerHTML =
        '<input id="consent" type="checkbox" aria-label="Consent" checked />';
      const checkbox = document.querySelector('input');
      if (!(checkbox instanceof HTMLInputElement))
        throw new Error('Missing checkbox');
      checkbox.checked = false;

      setRecording(true);
      mockIpcSend.mockClear();
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));

      const steps = recordedSteps();
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        type: 'recording-step',
        step: {
          action: 'uncheck',
          playwright:
            "await page.getByRole('checkbox', { name: 'Consent' }).uncheck();",
        },
      });
      expect(steps[0]).not.toHaveProperty('step.value');
      setRecording(false);
    });

    it('records a radio change as check without a value', () => {
      document.body.innerHTML =
        '<input id="choice" type="radio" aria-label="Choice" />';
      const radio = document.querySelector('input');
      if (!(radio instanceof HTMLInputElement))
        throw new Error('Missing radio');
      radio.checked = true;

      setRecording(true);
      mockIpcSend.mockClear();
      radio.dispatchEvent(new Event('change', { bubbles: true }));

      const steps = recordedSteps();
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        type: 'recording-step',
        step: {
          action: 'check',
          playwright:
            "await page.getByRole('radio', { name: 'Choice' }).check();",
        },
      });
      expect(steps[0]).not.toHaveProperty('step.value');
      setRecording(false);
    });

    it('records the next direct click after a label click the page cancelled', async () => {
      // A styled checkbox can cancel its label's click, so the browser never
      // forwards it to the control and no change follows.
      document.body.innerHTML =
        '<label for="consent">Consent</label><input id="consent" type="checkbox" />';
      const label = document.querySelector('label');
      const checkbox = document.querySelector('input');
      if (!(label instanceof HTMLLabelElement))
        throw new Error('Missing label');
      if (!(checkbox instanceof HTMLInputElement))
        throw new Error('Missing checkbox');
      label.addEventListener('click', (event) => event.preventDefault());

      setRecording(true);
      label.click();
      expect(checkbox.checked).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      mockIpcSend.mockClear();
      checkbox.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(checkbox.checked).toBe(true);
      const steps = recordedSteps();
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({ step: { action: 'check' } });
      setRecording(false);
    });

    it.each([
      'first\nsecond',
      'first\r\nsecond',
      "it's a \\ path\u2028and more",
    ])(
      'records a textarea fill of %j as a script that gives the text back',
      async (text) => {
        document.body.innerHTML = '<textarea aria-label="Notes"></textarea>';
        const textarea = document.querySelector('textarea');
        if (!(textarea instanceof HTMLTextAreaElement))
          throw new Error('Missing textarea');
        setRecording(true);
        mockIpcSend.mockClear();
        textarea.value = text;
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        let playwright = '';
        for (const event of recordedSteps()) {
          if (typeof event !== 'object' || event === null) continue;
          const step: unknown = 'step' in event ? event.step : undefined;
          if (
            typeof step === 'object' &&
            step !== null &&
            'action' in step &&
            step.action === 'fill' &&
            'playwright' in step &&
            typeof step.playwright === 'string'
          )
            playwright = step.playwright;
        }
        const received: unknown[] = [];
        const locator = {
          fill: (value: unknown): void => {
            received.push(value);
          },
        };
        const page = new Proxy(
          {},
          { get: (): (() => typeof locator) => () => locator },
        );
        await runInNewContext(`(async () => { ${playwright} })()`, { page });
        // A textarea's value holds each line break as LF.
        expect(received).toEqual([text.replace(/\r\n?/g, '\n')]);
        setRecording(false);
      },
    );

    it('records a checkbox click once as check', async () => {
      document.body.innerHTML =
        '<input id="consent" type="checkbox" aria-label="Consent" />';
      const checkbox = document.querySelector('input');
      if (!(checkbox instanceof HTMLInputElement))
        throw new Error('Missing checkbox');

      setRecording(true);
      mockIpcSend.mockClear();
      checkbox.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const steps = recordedSteps();
      expect(checkbox.checked).toBe(true);
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        type: 'recording-step',
        step: {
          action: 'check',
          playwright:
            "await page.getByRole('checkbox', { name: 'Consent' }).check();",
        },
      });
      setRecording(false);
    });

    it('records a checked checkbox click once as uncheck', async () => {
      document.body.innerHTML =
        '<input id="consent" type="checkbox" aria-label="Consent" checked />';
      const checkbox = document.querySelector('input');
      if (!(checkbox instanceof HTMLInputElement))
        throw new Error('Missing checkbox');

      setRecording(true);
      mockIpcSend.mockClear();
      checkbox.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const steps = recordedSteps();
      expect(checkbox.checked).toBe(false);
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        type: 'recording-step',
        step: {
          action: 'uncheck',
          playwright:
            "await page.getByRole('checkbox', { name: 'Consent' }).uncheck();",
        },
      });
      setRecording(false);
    });

    it('records a click on a label[for] once as check', async () => {
      document.body.innerHTML =
        '<label for="updates">Email updates</label><input id="updates" type="checkbox" />';
      const label = document.querySelector('label');
      const checkbox = document.querySelector('input');
      if (
        !(label instanceof HTMLLabelElement) ||
        !(checkbox instanceof HTMLInputElement)
      )
        throw new Error('Missing labelled checkbox');

      setRecording(true);
      mockIpcSend.mockClear();
      label.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const steps = recordedSteps();
      expect(checkbox.checked).toBe(true);
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        type: 'recording-step',
        step: {
          action: 'check',
          playwright:
            "await page.getByRole('checkbox', { name: 'Email updates' }).check();",
        },
      });
      setRecording(false);
    });

    it('records a click on a wrapping label once as check', async () => {
      document.body.innerHTML =
        '<label>Email updates <input id="updates" type="checkbox" /></label>';
      const label = document.querySelector('label');
      const checkbox = document.querySelector('input');
      if (
        !(label instanceof HTMLLabelElement) ||
        !(checkbox instanceof HTMLInputElement)
      )
        throw new Error('Missing wrapped checkbox');

      setRecording(true);
      mockIpcSend.mockClear();
      label.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const steps = recordedSteps();
      expect(checkbox.checked).toBe(true);
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        type: 'recording-step',
        step: {
          action: 'check',
          playwright:
            "await page.getByRole('checkbox', { name: 'Email updates' }).check();",
        },
      });
      setRecording(false);
    });

    it.each(['checkbox', 'label'] as const)(
      'records a click the page cancelled on the %s as a click, and leaves the checkbox as it was',
      async (clicked) => {
        document.body.innerHTML =
          '<label for="updates">Email updates</label><input id="updates" type="checkbox" />';
        const label = document.querySelector('label');
        const checkbox = document.querySelector('input');
        if (
          !(label instanceof HTMLLabelElement) ||
          !(checkbox instanceof HTMLInputElement)
        )
          throw new Error('Missing labelled checkbox');
        const element = clicked === 'checkbox' ? checkbox : label;
        element.addEventListener('click', (event) => event.preventDefault());

        setRecording(true);
        mockIpcSend.mockClear();
        element.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const steps = recordedSteps();
        expect(checkbox.checked).toBe(false);
        expect(steps).toHaveLength(1);
        expect(steps[0]).toMatchObject({
          type: 'recording-step',
          step: { action: 'click' },
        });
        setRecording(false);
      },
    );

    it('records a click on a link inside a checkbox label as a click, not a check', () => {
      document.body.innerHTML =
        '<label>I agree to the <a href="#terms" id="terms">terms</a> <input id="agree" type="checkbox" /></label>';
      const link = document.getElementById('terms');
      const checkbox = document.getElementById('agree');
      if (
        !(link instanceof HTMLAnchorElement) ||
        !(checkbox instanceof HTMLInputElement)
      )
        throw new Error('Missing label link');

      setRecording(true);
      mockIpcSend.mockClear();
      link.click();

      const steps = recordedSteps();
      expect(checkbox.checked).toBe(false);
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        type: 'recording-step',
        step: { action: 'click' },
      });
      setRecording(false);
    });

    it('records an ordinary click as click', () => {
      document.body.innerHTML = '<button id="continue">Continue</button>';
      const button = document.querySelector('button');
      if (!(button instanceof HTMLButtonElement))
        throw new Error('Missing button');

      setRecording(true);
      mockIpcSend.mockClear();
      button.click();

      const steps = recordedSteps();
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        type: 'recording-step',
        step: {
          action: 'click',
          playwright:
            "await page.getByRole('button', { name: 'Continue' }).click();",
        },
      });
      setRecording(false);
    });

    it('records every selected multiple-select option in document order', () => {
      document.body.innerHTML = `
        <select id="colors" multiple aria-label="Colors">
          <option value="red">Red</option>
          <option value="green">Green</option>
          <option value="blue">Blue</option>
        </select>
      `;
      const select = document.querySelector('select');
      if (!(select instanceof HTMLSelectElement))
        throw new Error('Missing multiple select');
      select.options[2].selected = true;
      select.options[0].selected = true;

      setRecording(true);
      mockIpcSend.mockClear();
      select.dispatchEvent(new Event('change', { bubbles: true }));

      expect(recordedSteps()).toMatchObject([
        {
          type: 'recording-step',
          step: {
            action: 'select',
            value: 'red',
            values: ['red', 'blue'],
            playwright:
              "await page.getByRole('combobox', { name: 'Colors' }).selectOption(['red', 'blue']);",
          },
        },
      ]);
      setRecording(false);
    });

    it('keeps a one-option multiple-select change in the single-value form', () => {
      document.body.innerHTML = `
        <select id="colors" multiple aria-label="Colors">
          <option value="red">Red</option>
          <option value="green" selected>Green</option>
        </select>
      `;
      const select = document.querySelector('select');
      if (!(select instanceof HTMLSelectElement))
        throw new Error('Missing multiple select');

      setRecording(true);
      mockIpcSend.mockClear();
      select.dispatchEvent(new Event('change', { bubbles: true }));

      const steps = recordedSteps();
      expect(steps).toMatchObject([
        {
          type: 'recording-step',
          step: {
            action: 'select',
            value: 'green',
            playwright:
              "await page.getByRole('combobox', { name: 'Colors' }).selectOption('green');",
          },
        },
      ]);
      expect(steps[0]).not.toHaveProperty('step.values');
      setRecording(false);
    });

    it('keeps a single-select change in the existing single-value form', () => {
      document.body.innerHTML = `
        <select id="colors" aria-label="Colors">
          <option value="red">Red</option>
          <option value="green" selected>Green</option>
        </select>
      `;
      const select = document.querySelector('select');
      if (!(select instanceof HTMLSelectElement))
        throw new Error('Missing select');

      setRecording(true);
      mockIpcSend.mockClear();
      select.dispatchEvent(new Event('change', { bubbles: true }));

      const steps = recordedSteps();
      expect(steps).toMatchObject([
        {
          type: 'recording-step',
          step: {
            action: 'select',
            value: 'green',
            playwright:
              "await page.getByRole('combobox', { name: 'Colors' }).selectOption('green');",
          },
        },
      ]);
      expect(steps[0]).not.toHaveProperty('step.values');
      setRecording(false);
    });

    it('withholds multiple selections in a secret select and retains its comment', () => {
      document.body.innerHTML = `
        <select id="expiry" multiple autocomplete="cc-exp-month" aria-label="Expiry">
          <option value="private-month-01">January</option>
          <option value="private-month-02">February</option>
        </select>
      `;
      const select = document.querySelector('select');
      if (!(select instanceof HTMLSelectElement))
        throw new Error('Missing secret select');
      select.options[0].selected = true;
      select.options[1].selected = true;

      setRecording(true);
      mockIpcSend.mockClear();
      select.options[1].dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      select.dispatchEvent(new Event('change', { bubbles: true }));

      const steps = recordedSteps();
      expect(JSON.stringify(steps)).not.toContain('private-month-');
      expect(steps).toMatchObject([
        {
          type: 'recording-step',
          step: {
            action: 'click',
            playwright: '// Secret option interaction omitted from recording.',
          },
        },
        {
          type: 'recording-step',
          step: {
            action: 'select',
            valueRedacted: true,
          },
        },
      ]);
      expect(steps[0]).toHaveProperty('step.value', undefined);
      expect(steps[0]).not.toHaveProperty('step.values');
      expect(steps[1]).toHaveProperty('step.value', undefined);
      expect(steps[1]).not.toHaveProperty('step.values');
      setRecording(false);
    });
  });

  it('does not report synthetic automation input as user interaction', () => {
    mockIpcSend.mockClear();

    document.body.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true }),
    );
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }),
    );

    expect(mockIpcSend).not.toHaveBeenCalledWith('canopy-browser-view:event', {
      type: 'user-interaction',
    });
  });

  it('reports trusted pointer and key details with epoch timestamps', async () => {
    jest.resetModules();
    const addListener = jest.spyOn(window, 'addEventListener');
    await import('../browser-view');
    const pointerListener = addListener.mock.calls.find(
      ([type]) => type === 'pointerdown',
    )?.[1];
    const keyListener = addListener.mock.calls.find(
      ([type]) => type === 'keydown',
    )?.[1];
    addListener.mockRestore();
    const now = jest.spyOn(Date, 'now').mockReturnValue(123456789);
    const pointer: unknown = Object.create(MouseEvent.prototype);
    if (!(pointer instanceof MouseEvent))
      throw new Error('Missing pointer prototype');
    Object.defineProperties(pointer, {
      isTrusted: { value: true },
      type: { value: 'pointerdown' },
      button: { value: 2 },
      clientX: { value: 17 },
      clientY: { value: 29 },
    });
    const key: unknown = Object.create(KeyboardEvent.prototype);
    if (!(key instanceof KeyboardEvent))
      throw new Error('Missing keyboard prototype');
    Object.defineProperties(key, {
      isTrusted: { value: true },
      type: { value: 'keydown' },
      key: { value: 'Enter' },
    });
    if (
      typeof pointerListener !== 'function' ||
      typeof keyListener !== 'function'
    ) {
      throw new Error('Missing trusted interaction listeners');
    }
    pointerListener(pointer);
    keyListener(key);
    expect(mockIpcSend).toHaveBeenCalledWith('canopy-browser-view:event', {
      type: 'user-interaction',
      interaction: {
        type: 'pointerdown',
        button: 2,
        clientX: 17,
        clientY: 29,
        timestamp: 123456789,
      },
    });
    expect(mockIpcSend).toHaveBeenCalledWith('canopy-browser-view:event', {
      type: 'user-interaction',
      interaction: { type: 'keydown', key: 'Enter', timestamp: 123456789 },
    });
    now.mockRestore();
  });

  it('generates locator candidates in the planned fallback order', async () => {
    const { generateLocatorCandidates } = await import('../browser-view');
    document.body.innerHTML = `
      <form>
        <label for="email">Email label</label>
        <input
          data-testid="email-field"
          id="email"
          aria-label="Email name"
          placeholder="Email placeholder"
          alt="Email alt"
          title="Email title"
        />
      </form>
    `;

    const input = document.getElementById('email');
    expect(input).not.toBeNull();

    const candidates = generateLocatorCandidates(input as Element);

    expect(candidates.map((candidate) => candidate.kind)).toEqual([
      'testId',
      'role',
      'label',
      'placeholder',
      'alt',
      'title',
      'css',
      'css',
      'domPath',
    ]);
    expect(candidates[candidates.length - 1]).toMatchObject({
      kind: 'domPath',
      value: 'html > body > form > input',
      unique: true,
      confidence: 'low',
      playwright: "page.locator('html > body > form > input')",
    });
  });

  it('only emits short text candidates after proving the text is unique', async () => {
    const { generateLocatorCandidates } = await import('../browser-view');
    document.body.innerHTML = `
      <button>Launch Preview</button>
      <button>Duplicate</button>
      <a href="#duplicate">Duplicate</a>
    `;

    const [uniqueButton, duplicateButton] = Array.from(
      document.querySelectorAll('button'),
    );
    expect(uniqueButton).not.toBeNull();
    expect(duplicateButton).not.toBeNull();

    const uniqueCandidates = generateLocatorCandidates(uniqueButton as Element);
    const uniqueText = uniqueCandidates.find(
      (candidate) => candidate.kind === 'text',
    );
    expect(uniqueText).toMatchObject({
      value: 'Launch Preview',
      unique: true,
      confidence: 'high',
      playwright: "page.getByText('Launch Preview')",
    });
    expect(
      uniqueCandidates.findIndex((candidate) => candidate.kind === 'text'),
    ).toBeLessThan(
      uniqueCandidates.findIndex((candidate) => candidate.kind === 'css'),
    );

    const duplicateCandidates = generateLocatorCandidates(
      duplicateButton as Element,
    );
    expect(
      duplicateCandidates.some((candidate) => candidate.kind === 'text'),
    ).toBe(false);
  });

  describe('secret form values', () => {
    const SECRETS = {
      password: 'hunter2-password-secret',
      shown: 'shown-password-secret',
      otp: '424242',
      card: '4111111111111111',
      cvc: 'cvc-987-secret',
      expiry: 'expiry-11-secret',
    };

    function expectNoSecrets(
      value: unknown,
      publicKeys: ReadonlyArray<keyof typeof SECRETS> = [],
    ): void {
      const serialized = JSON.stringify(value);
      for (const [key, secret] of Object.entries(SECRETS)) {
        if (publicKeys.some((publicKey) => publicKey === key)) continue;
        expect(serialized).not.toContain(secret);
      }
    }

    beforeEach(() => {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: jest.fn(() => ({ matches: false })),
      });
      document.body.innerHTML = `
        <form id="sign-in">
          <input id="user" aria-label="Username" />
          <input id="password" type="password" aria-label="Password" />
          <input id="shown" type="text" autocomplete="current-password" aria-label="Shown password" />
          <input id="otp" autocomplete="one-time-code" aria-label="Code" />
          <input id="card" autocomplete="cc-number" aria-label="Card number" />
          <input id="cvc" autocomplete="cc-csc" aria-label="Security code" />
          <select id="expiry" autocomplete="cc-exp-month" aria-label="Expiry month">
            <option value="">Month</option>
            <option value="expiry-11-secret">November</option>
          </select>
        </form>
      `;
      const setValue = (id: string, value: string): void => {
        const element = document.getElementById(id);
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLSelectElement
        ) {
          element.value = value;
        }
      };
      setValue('user', 'ada');
      setValue('password', SECRETS.password);
      setValue('shown', SECRETS.shown);
      setValue('otp', SECRETS.otp);
      setValue('card', SECRETS.card);
      setValue('cvc', SECRETS.cvc);
      setValue('expiry', SECRETS.expiry);
      // Frameworks such as React mirror the live value into the attribute.
      document
        .getElementById('password')
        ?.setAttribute('value', SECRETS.password);
    });

    it('keeps a password secret after a show-password toggle removes its password type', () => {
      const input = document.createElement('input');
      input.id = 'revealed-password';
      input.type = 'password';
      input.setAttribute('aria-label', 'Revealed password');
      document.getElementById('sign-in')?.append(input);
      input.type = 'text';
      input.value = 'revealed-password-value-7284';
      input.setAttribute('value', input.value);

      const pickedPassword = pick(input);
      const pickedForm = pick(document.getElementById('sign-in'));
      for (const picked of [pickedPassword, pickedForm]) {
        expect(JSON.stringify(picked)).not.toContain(
          'revealed-password-value-7284',
        );
      }
      expect(pickedPassword).toMatchObject({
        valueRedacted: true,
        attributes: { value: '[redacted]' },
      });

      commandHandler?.(null, {
        requestId: 'record-revealed-password',
        type: 'setRecording',
        payload: { browserId: 'browser-1', enabled: true },
      });
      mockIpcSend.mockClear();
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const events = mockIpcSend.mock.calls
        .filter(([channel]) => channel === 'canopy-browser-view:event')
        .map(([, event]) => event);
      expect(JSON.stringify(events)).not.toContain(
        'revealed-password-value-7284',
      );
      expect(events).toMatchObject([
        {
          type: 'recording-step',
          step: { action: 'fill', valueRedacted: true },
        },
      ]);
      commandHandler?.(null, {
        requestId: 'stop-record-revealed-password',
        type: 'setRecording',
        payload: { browserId: 'browser-1', enabled: false },
      });
    });

    it('omits secret values from inspected elements, attributes, and markup', () => {
      const password = pick(document.getElementById('password'));
      const form = pick(document.getElementById('sign-in'));
      expectNoSecrets(password);
      expectNoSecrets(form);
      expect(password).toMatchObject({
        tagName: 'input',
        valueRedacted: true,
        attributes: { type: 'password', value: '[redacted]' },
      });
      expect(password.value).toBeUndefined();
      expect(form).toMatchObject({ tagName: 'form' });
      expect(String(form.outerHtml)).toContain('id="password"');
      // Inspection never rewrites the live page.
      expect(document.getElementById('password')?.getAttribute('value')).toBe(
        SECRETS.password,
      );
    });

    it('redacts a selected option beneath a secret select', () => {
      const selectedOption = document.querySelector('#expiry option:checked');
      if (selectedOption) selectedOption.textContent = SECRETS.expiry;
      const option = pick(document.querySelector('#expiry option:checked'));
      expectNoSecrets(option);
      expect(option).toMatchObject({
        tagName: 'option',
        valueRedacted: true,
        attributes: { value: '[redacted]' },
      });
      expect(String(option.outerHtml)).not.toContain(SECRETS.expiry);
      expect(option.text).toBeUndefined();
      expect(option.accessibleName).toBeUndefined();
      expect(
        document.querySelector('#expiry option:checked')?.getAttribute('value'),
      ).toBe(SECRETS.expiry);
    });

    it('does not project secret textarea content through text or names', () => {
      const textarea = document.createElement('textarea');
      textarea.id = 'secret-message';
      textarea.setAttribute('autocomplete', 'one-time-code');
      textarea.textContent = 'textarea-otp-secret-9284';
      document.getElementById('sign-in')?.append(textarea);

      const inspected = pick(textarea);
      expect(JSON.stringify(inspected)).not.toContain(
        'textarea-otp-secret-9284',
      );
      expect(inspected.text).toBeUndefined();
      expect(inspected.accessibleName).toBeUndefined();
    });

    it.each([
      [
        'aria-labelledby',
        '<div id="otp-label">Code <textarea id="labelled-otp" autocomplete="one-time-code" aria-labelledby="otp-label">labelled-otp-secret-7319</textarea></div>',
        'labelled-otp',
      ],
      [
        'wrapping label',
        '<label>Code <textarea id="wrapped-otp" autocomplete="one-time-code">wrapped-otp-secret-8426</textarea></label>',
        'wrapped-otp',
      ],
    ])(
      'keeps secret content out of %s names and locators',
      (_case, markup, id) => {
        document
          .getElementById('sign-in')
          ?.insertAdjacentHTML('beforeend', markup);
        const secret = `${id}-secret-${id === 'labelled-otp' ? '7319' : '8426'}`;
        const inspected = pick(document.getElementById(id));
        expect(JSON.stringify(inspected)).not.toContain(secret);
        expect(inspected.accessibleName).toBe('Code');
        expect(inspected.valueRedacted).toBe(true);
      },
    );

    it('redacts every option and removes selection-derived metadata in a secret select', () => {
      const select = document.getElementById('expiry');
      if (!(select instanceof HTMLSelectElement))
        throw new Error('Missing select');
      select.replaceChildren();
      for (let month = 1; month <= 12; month += 1) {
        const option = document.createElement('option');
        const value = `private-month-${String(month).padStart(2, '0')}`;
        option.value = value;
        option.label = value;
        option.textContent = value;
        select.append(option);
      }
      select.selectedIndex = 10;

      const picked = new Map<string, Record<string, unknown>>();
      for (const locator of [
        '#expiry',
        '#expiry option:checked',
        '#expiry option:first-child',
        '#sign-in',
      ]) {
        const inspected = pick(document.querySelector(locator));
        picked.set(locator, inspected);
        for (let month = 1; month <= 12; month += 1) {
          expect(JSON.stringify(inspected)).not.toContain(
            `private-month-${String(month).padStart(2, '0')}`,
          );
        }
        expect(JSON.stringify(inspected)).not.toContain('nth-of-type(11)');
        expect(inspected.text).toBeUndefined();
      }
      expect(picked.get('#expiry option:checked')?.attributes).toMatchObject({
        value: '[redacted]',
        label: '[redacted]',
      });
      expect(String(picked.get('#expiry')?.outerHtml)).not.toContain(
        'selected',
      );

      commandHandler?.(null, {
        requestId: 'record-month-option',
        type: 'setRecording',
        payload: { browserId: 'browser-1', enabled: true },
      });
      mockIpcSend.mockClear();
      select.options[10].dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      const recorded = mockIpcSend.mock.calls
        .filter(([channel]) => channel === 'canopy-browser-view:event')
        .map(([, event]) => event);
      commandHandler?.(null, {
        requestId: 'stop-record-month-option',
        type: 'setRecording',
        payload: { browserId: 'browser-1', enabled: false },
      });
      expect(JSON.stringify(recorded)).not.toContain('nth-of-type(11)');
    });

    it('redacts an inspected optgroup inside a secret select', () => {
      const select = document.getElementById('expiry');
      if (!(select instanceof HTMLSelectElement))
        throw new Error('Missing select');
      select.innerHTML = `
        <optgroup label="private-range-a" id="first-years">
          <option value="private-year-2031" label="private-year-2031">private-year-2031</option>
          <option value="private-year-2032" label="private-year-2032">private-year-2032</option>
        </optgroup>
        <optgroup label="private-range-b" id="selected-years">
          <option value="private-year-2033" label="private-year-2033">private-year-2033</option>
          <option value="private-year-2034" label="private-year-2034" selected>private-year-2034</option>
        </optgroup>
      `;
      const inspected = pick(document.getElementById('selected-years'));
      const groupedSelect = pick(select);
      expect(inspected.valueRedacted).toBe(true);
      expect(inspected.text).toBeUndefined();
      expect(inspected.accessibleName).toBeUndefined();
      expect(inspected.attributes).toMatchObject({ label: '[redacted]' });
      expect(JSON.stringify(inspected)).not.toMatch(/private-(year|range)-/);
      expect(JSON.stringify(groupedSelect)).not.toMatch(
        /private-(year|range)-/,
      );
      expect(JSON.stringify(inspected)).not.toContain('nth-of-type(2)');
      expect(String(inspected.outerHtml)).not.toMatch(/\sselected(?:\s|>)/);
      expect(select.options[3].value).toBe('private-year-2034');
    });

    it('redacts nested selected-option content and selectedcontent mirrors', () => {
      const select = document.getElementById('expiry');
      if (!(select instanceof HTMLSelectElement))
        throw new Error('Missing select');
      select.replaceChildren();
      const button = document.createElement('button');
      const mirror = document.createElement('selectedcontent');
      mirror.id = 'expiry-mirror';
      mirror.textContent = 'private-month-11';
      button.append(mirror);
      select.append(button);
      for (const [value, selected] of [
        ['private-month-01', false],
        ['private-month-11', true],
      ] as const) {
        const option = document.createElement('option');
        option.value = value;
        option.selected = selected;
        const span = document.createElement('span');
        span.textContent = value;
        if (selected) span.id = 'selected-month';
        option.append(span);
        select.append(option);
      }

      const picked = new Map<string, Record<string, unknown>>();
      for (const id of ['selected-month', 'expiry-mirror', 'sign-in']) {
        const inspected = pick(document.getElementById(id));
        picked.set(id, inspected);
        expect(JSON.stringify(inspected)).not.toContain('private-month-11');
        expect(JSON.stringify(inspected)).not.toContain('nth-of-type(2)');
      }
      expect(picked.get('selected-month')?.valueRedacted).toBe(true);
      expect(picked.get('expiry-mirror')?.valueRedacted).toBe(true);

      commandHandler?.(null, {
        requestId: 'record-nested-option',
        type: 'setRecording',
        payload: { browserId: 'browser-1', enabled: true },
      });
      mockIpcSend.mockClear();
      document
        .getElementById('selected-month')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const events = mockIpcSend.mock.calls
        .filter(([channel]) => channel === 'canopy-browser-view:event')
        .map(([, event]) => event);
      expect(JSON.stringify(events)).not.toContain('private-month-11');
      expect(JSON.stringify(events)).not.toContain('nth-of-type(2)');
      commandHandler?.(null, {
        requestId: 'stop-record-nested-option',
        type: 'setRecording',
        payload: { browserId: 'browser-1', enabled: false },
      });
    });

    it.each(['cc-name', 'cc-given-name', 'cc-family-name'])(
      'redacts %s values in picked elements and recordings',
      (autocomplete) => {
        const input = document.createElement('input');
        input.id = 'cardholder';
        input.autocomplete = autocomplete;
        input.value = 'private-cardholder-9284';
        input.setAttribute('value', input.value);
        document.getElementById('sign-in')?.append(input);

        const picked = pick(input);
        expect(JSON.stringify(picked)).not.toContain('private-cardholder-9284');
        expect(picked.valueRedacted).toBe(true);

        commandHandler?.(null, {
          requestId: 'record-cardholder',
          type: 'setRecording',
          payload: { browserId: 'browser-1', enabled: true },
        });
        mockIpcSend.mockClear();
        input.dispatchEvent(new Event('change', { bubbles: true }));
        const events = mockIpcSend.mock.calls
          .filter(([channel]) => channel === 'canopy-browser-view:event')
          .map(([, event]) => event);
        expect(JSON.stringify(events)).not.toContain('private-cardholder-9284');
        expect(events).toMatchObject([
          {
            type: 'recording-step',
            step: { action: 'fill', valueRedacted: true },
          },
        ]);
        commandHandler?.(null, {
          requestId: 'stop-record-cardholder',
          type: 'setRecording',
          payload: { browserId: 'browser-1', enabled: false },
        });
      },
    );

    it('records secret field changes without their values', () => {
      commandHandler?.(null, {
        requestId: 'start-recording',
        type: 'setRecording',
        payload: { browserId: 'browser-1', enabled: true },
      });
      mockIpcSend.mockClear();

      for (const id of ['user', 'password', 'card', 'expiry']) {
        document
          .getElementById(id)
          ?.dispatchEvent(new Event('change', { bubbles: true }));
      }

      const steps = mockIpcSend.mock.calls
        .filter(([channel]) => channel === 'canopy-browser-view:event')
        .map(([, event]) => event);
      expectNoSecrets(steps);
      expect(steps).toMatchObject([
        { type: 'recording-step', step: { action: 'fill', value: 'ada' } },
        {
          type: 'recording-step',
          step: { action: 'fill', valueRedacted: true },
        },
        {
          type: 'recording-step',
          step: { action: 'fill', valueRedacted: true },
        },
        {
          type: 'recording-step',
          step: { action: 'select', valueRedacted: true },
        },
      ]);
    });
  });
});

describe('browser-view preload main-world tracker (E4)', () => {
  const attachShadow = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'attachShadow',
  );
  const installedKeys: string[] = [];

  /** The main world is this jsdom window: run the source in it. */
  function runInMainWorld(source: string): Promise<unknown> {
    const evaluate: unknown = Reflect.get(window, 'eval');
    if (typeof evaluate !== 'function') throw new Error('No eval');
    return Promise.resolve(Reflect.apply(evaluate, window, [source]));
  }

  /** The current `attachShadow`, for identity comparisons only. */
  function currentAttachShadow(): unknown {
    const current: unknown = Reflect.get(Element.prototype, 'attachShadow');
    return current;
  }

  function witness(): unknown {
    const read: unknown = Reflect.get(globalThis, TRACKER_WITNESS_RESOLVER_KEY);
    return typeof read === 'function'
      ? Reflect.apply(read, globalThis, [])
      : undefined;
  }

  /** Loads the preload as the document starts: no element yet. */
  async function loadAtDocumentStart(): Promise<void> {
    jest.resetModules();
    const root = document.documentElement;
    root.remove();
    try {
      await import('../browser-view');
    } finally {
      document.append(root);
    }
  }

  beforeEach(() => {
    mockExecuteJavaScript.mockReset();
    mockExecuteJavaScript.mockImplementation(runInMainWorld);
  });

  afterEach(() => {
    if (attachShadow)
      Object.defineProperty(Element.prototype, 'attachShadow', attachShadow);
    for (const key of installedKeys.splice(0))
      Reflect.deleteProperty(globalThis, key);
  });

  it('installs the tracker at document start under a fresh key, and witnesses it', async () => {
    const native = currentAttachShadow();
    await loadAtDocumentStart();
    const decoded = decodeTrackerWitness(witness());
    if (!decoded?.early) throw new Error(`Not early: ${String(witness())}`);
    installedKeys.push(decoded.key);
    expect(mockExecuteJavaScript).toHaveBeenCalledTimes(1);
    expect(mockExecuteJavaScript).toHaveBeenCalledWith(
      mainWorldTrackerSource(decoded.key, { documents: 'top' }),
    );
    expect(currentAttachShadow()).not.toBe(native);
    // The resolver under the witnessed key tracks roots made through it.
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<input id="field" type="password">';
    const field = root.querySelector('input');
    if (!field) throw new Error('No field');
    field.type = 'text';
    const resolve: unknown = Reflect.get(globalThis, decoded.key);
    if (typeof resolve !== 'function') throw new Error('No resolver');
    expect(Reflect.apply(resolve, undefined, [field])).toBe('E1');
    host.remove();
    // Each document gets its own key.
    await loadAtDocumentStart();
    const next = decodeTrackerWitness(witness());
    if (!next?.early) throw new Error('Not early');
    installedKeys.push(next.key);
    expect(next.key).not.toBe(decoded.key);
  });

  it('witnesses a late preload and installs nothing', async () => {
    const native = currentAttachShadow();
    jest.resetModules();
    await import('../browser-view');
    expect(witness()).toBe(encodeTrackerWitness({ early: false }));
    expect(mockExecuteJavaScript).not.toHaveBeenCalled();
    expect(currentAttachShadow()).toBe(native);
  });

  it('witnesses a failed install request as late', async () => {
    mockExecuteJavaScript.mockImplementation(() => {
      throw new Error('Script failed to execute');
    });
    await loadAtDocumentStart();
    expect(witness()).toBe('L');
  });

  it("keeps one attachShadow wrapper in its document: the host's child-document tracker does not install", async () => {
    await loadAtDocumentStart();
    const decoded = decodeTrackerWitness(witness());
    if (!decoded?.early) throw new Error('Not early');
    installedKeys.push(decoded.key);
    const wrapper = currentAttachShadow();
    const hostKey = `__canopyPageModelTracker_${'c'.repeat(32)}`;
    // As a CDP-registered script would, in the same top document.
    document.documentElement.remove();
    try {
      await runInMainWorld(
        mainWorldTrackerSource(hostKey, { documents: 'child' }),
      );
    } finally {
      document.append(document.createElement('html'));
    }
    expect(currentAttachShadow()).toBe(wrapper);
    expect(Reflect.get(globalThis, hostKey)).toBeUndefined();
  });
});
