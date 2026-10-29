/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ScriptAction } from '@canopy/protocol/script-actions';
import {
  buildScriptActionShortcutBindings,
  isScriptActionDispatchChord,
  reservedScriptActionChords,
  scriptActionChordKey,
} from '../script-action-shortcuts';
import {
  useScriptActionShortcutDispatcher,
  type UseScriptActionShortcutDispatcherOptions,
} from '../use-script-action-shortcuts';
import { scriptAction } from './fixtures';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('script action chords', () => {
  it('resolves CommandOrControl per platform', () => {
    expect(scriptActionChordKey('CommandOrControl+Shift+Y', 'darwin')).toBe(
      'Command+Shift+Y',
    );
    expect(scriptActionChordKey('CommandOrControl+Shift+Y', 'win32')).toBe(
      'Control+Shift+Y',
    );
    expect(scriptActionChordKey('Super+D', 'darwin')).toBe('Command+D');
    expect(scriptActionChordKey('Bogus+D', 'darwin')).toBeNull();
  });

  it('requires Command, Control or Alt', () => {
    expect(isScriptActionDispatchChord('Shift+D', 'darwin')).toBe(false);
    expect(isScriptActionDispatchChord('D', 'linux')).toBe(false);
    expect(isScriptActionDispatchChord('Alt+D', 'darwin')).toBe(true);
    expect(isScriptActionDispatchChord('Control+Alt+D', 'linux')).toBe(true);
    // Command does not exist off macOS.
    expect(isScriptActionDispatchChord('Command+D', 'win32')).toBe(false);
  });

  it('reserves desktop command bindings and host extras on the executing platform', () => {
    const mac = reservedScriptActionChords('darwin', [
      { accelerator: 'CommandOrControl+Shift+O', title: 'Focus app' },
    ]);
    expect(mac.get('Command+K')).toBe('Open Command Palette');
    expect(mac.get('Command+Shift+O')).toBe('Focus app');
    expect(mac.has('Control+K')).toBe(false);
    const windows = reservedScriptActionChords('win32');
    expect(windows.get('Control+K')).toBe('Open Command Palette');
    expect(windows.get('Alt+Left')).toBeDefined();
  });

  it('binds only approved, available, conflict-free, unique chords', () => {
    const bindings = buildScriptActionShortcutBindings(
      [
        scriptAction({ id: 'ok', shortcut: 'CommandOrControl+Shift+1' }),
        scriptAction({ id: 'pending', status: 'pending', shortcut: 'Alt+2' }),
        scriptAction({
          id: 'dismissed',
          status: 'dismissed',
          shortcut: 'Alt+3',
        }),
        scriptAction({
          id: 'gone',
          unavailableReason: 'Missing',
          shortcut: 'Alt+4',
        }),
        scriptAction({
          id: 'conflict',
          shortcutConflict: 'Already used by lint',
          shortcut: 'Alt+5',
        }),
        scriptAction({ id: 'reserved', shortcut: 'CommandOrControl+K' }),
        scriptAction({ id: 'weak', shortcut: 'Shift+6' }),
        scriptAction({ id: 'dup-a', shortcut: 'Alt+7' }),
        scriptAction({ id: 'dup-b', shortcut: 'Alt+7' }),
        scriptAction({ id: 'none', shortcut: null }),
      ],
      'darwin',
    );
    expect(Array.from(bindings.values()).map((action) => action.id)).toEqual([
      'ok',
    ]);
  });
});

describe('useScriptActionShortcutDispatcher', () => {
  let container: HTMLDivElement;
  let root: Root;
  let runs: string[];
  const bound = (overrides: Partial<ScriptAction> = {}): ScriptAction =>
    scriptAction({ shortcut: 'CommandOrControl+Shift+Y', ...overrides });

  function Dispatcher(
    props: Partial<UseScriptActionShortcutDispatcherOptions>,
  ): null {
    useScriptActionShortcutDispatcher({
      enabled: true,
      actions: [bound()],
      platform: 'darwin',
      onRun: (action) => runs.push(action.id),
      ...props,
    });
    return null;
  }

  function render(
    props: Partial<UseScriptActionShortcutDispatcherOptions> = {},
  ): void {
    act(() => root.render(<Dispatcher {...props} />));
  }

  function press(
    target: EventTarget,
    init: KeyboardEventInit = {},
  ): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      code: 'KeyY',
      key: 'Y',
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  function element(html: string, selector: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    const found = host.querySelector(selector);
    if (!(found instanceof HTMLElement)) throw new Error(`missing ${selector}`);
    return found;
  }

  beforeEach(() => {
    runs = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  it('runs the bound action once and claims the chord', () => {
    render();
    const event = press(document.body);
    expect(runs).toEqual(['dev']);
    expect(event.defaultPrevented).toBe(true);
  });

  it('allows intended modifier chords from the composer', () => {
    render();
    press(
      element(
        '<div contenteditable="true" data-testid="composer"></div>',
        '[data-testid="composer"]',
      ),
    );
    press(element('<textarea></textarea>', 'textarea'));
    expect(runs).toEqual(['dev', 'dev']);
  });

  it('ignores key repeats, IME composition and handled events', () => {
    render();
    press(document.body, { repeat: true });
    press(document.body, { isComposing: true });
    const handled = element('<button>x</button>', 'button');
    handled.addEventListener('keydown', (event) => event.preventDefault());
    press(handled);
    expect(runs).toEqual([]);
  });

  it('leaves terminals, dialogs and opted-out surfaces alone', () => {
    render();
    press(
      element('<div class="xterm"><textarea></textarea></div>', 'textarea'),
    );
    press(element('<div role="dialog"><input /></div>', 'input'));
    press(
      element(
        '<div data-testid="command-palette" role="dialog"><input data-testid="q" /></div>',
        '[data-testid="q"]',
      ),
    );
    press(
      element(
        '<div data-script-action-shortcuts="off"><input /></div>',
        'input',
      ),
    );
    expect(runs).toEqual([]);
  });

  it('does not dispatch while inactive or for ineligible bindings', () => {
    render({ enabled: false });
    press(document.body);
    render({ actions: [bound({ status: 'pending' })] });
    press(document.body);
    render({ actions: [bound({ shortcutConflict: 'Already used by lint' })] });
    press(document.body);
    render({ actions: [bound({ unavailableReason: 'Missing' })] });
    press(document.body);
    render({
      actions: [bound({ id: 'a' }), bound({ id: 'b' })],
    });
    const shared = press(document.body);
    expect(shared.defaultPrevented).toBe(false);
    render({
      reserved: [
        { accelerator: 'CommandOrControl+Shift+Y', title: 'Focus app' },
      ],
    });
    press(document.body);
    expect(runs).toEqual([]);
  });

  it('matches the platform chord, not a lookalike', () => {
    render();
    press(document.body, { metaKey: false, ctrlKey: true });
    expect(runs).toEqual([]);
    render({ platform: 'win32' });
    press(document.body, { metaKey: false, ctrlKey: true });
    expect(runs).toEqual(['dev']);
  });
});
