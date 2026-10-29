/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  GlobalFocusShortcutStatus,
  GlobalFocusShortcutUpdateResponse,
} from '@canopy/desktop-shared/types';
import { COMMAND_DEFINITIONS, isMacPlatform } from '@/lib/keyboardShortcuts';
import { formatAcceleratorForDisplay } from '@canopy/desktop-shared/lib/global-shortcut-accelerator';
import { useGlobalFocusShortcutStore } from '@/stores/globalFocusShortcutStore';
import { GlobalFocusShortcutSection } from '../GlobalFocusShortcutSection';

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

const platform = isMacPlatform() ? 'darwin' : 'win32';
const DEFAULT = 'CommandOrControl+Shift+O';
const OTHER = 'CommandOrControl+Shift+P';
const display = (accelerator: string): string =>
  formatAcceleratorForDisplay(accelerator, platform);
/** Modifier flags for the platform's primary chord key. */
const primary = isMacPlatform() ? { metaKey: true } : { ctrlKey: true };

function status(
  overrides: Partial<GlobalFocusShortcutStatus> = {},
): GlobalFocusShortcutStatus {
  return {
    enabled: false,
    accelerator: DEFAULT,
    registered: false,
    platform,
    ...overrides,
  };
}

const mockGetStatus = jest.fn<Promise<GlobalFocusShortcutStatus>, []>();
const mockUpdate = jest.fn<
  Promise<GlobalFocusShortcutUpdateResponse>,
  [unknown]
>();
let pushStatus: ((next: GlobalFocusShortcutStatus) => void) | null = null;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  jest.clearAllMocks();
  pushStatus = null;
  useGlobalFocusShortcutStore.setState({
    status: null,
    hydrated: false,
    busy: false,
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      globalFocusShortcut: {
        getStatus: mockGetStatus,
        update: mockUpdate,
        onStatusChanged: (cb: (next: GlobalFocusShortcutStatus) => void) => {
          pushStatus = cb;
          return (): void => {
            pushStatus = null;
          };
        },
      },
    },
  });
  mockGetStatus.mockResolvedValue(status());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(GlobalFocusShortcutSection));
    await Promise.resolve();
  });
}

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function text(testId: string): string {
  return query(testId)?.textContent ?? '';
}

async function click(testId: string): Promise<void> {
  const element = query(testId);
  if (!(element instanceof HTMLElement)) throw new Error(`missing ${testId}`);
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

async function pressInRecorder(init: KeyboardEventInit): Promise<void> {
  const recorder = query('global-focus-shortcut-recorder');
  if (!(recorder instanceof HTMLElement)) throw new Error('missing recorder');
  await act(async () => {
    recorder.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
    await Promise.resolve();
  });
}

describe('GlobalFocusShortcutSection', () => {
  it('shows the saved chord and an off toggle before the user opts in', async () => {
    await render();

    expect(
      query('global-focus-shortcut-toggle')?.getAttribute('aria-checked'),
    ).toBe('false');
    expect(text('global-focus-shortcut-chord')).toBe(
      display(DEFAULT).replace(/\s/g, ''),
    );
    expect(text('global-focus-shortcut-status')).toMatch(/off/i);
  });

  it('turns the shortcut on through the bridge and reports it active', async () => {
    mockUpdate.mockResolvedValue({
      ok: true,
      status: status({ enabled: true, registered: true }),
    });
    await render();

    await click('global-focus-shortcut-toggle');

    expect(mockUpdate).toHaveBeenCalledWith({ enabled: true });
    expect(
      query('global-focus-shortcut-toggle')?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(text('global-focus-shortcut-status')).toMatch(/active/i);
    // Registration is not proof another app does not own the chord.
    expect(text('global-focus-shortcut-status')).toMatch(/press it now/i);
  });

  it('shows a refused toggle as on-but-blocked with the reason, without opening the recorder', async () => {
    mockUpdate.mockResolvedValue({
      ok: false,
      reason: 'in-use',
      accelerator: DEFAULT,
      status: status({ enabled: true, registered: false, failure: 'in-use' }),
    });
    await render();

    await click('global-focus-shortcut-toggle');

    expect(
      query('global-focus-shortcut-toggle')?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(text('global-focus-shortcut-status')).toMatch(
      /another app is using/i,
    );
    expect(text('global-focus-shortcut-error')).toMatch(/couldn't use/i);
    expect(
      query('global-focus-shortcut-error')?.classList.contains(
        'fg-destructive',
      ),
    ).toBe(true);
    expect(query('global-focus-shortcut-recorder')).toBeNull();
    expect(query('global-focus-shortcut-change')).not.toBeNull();
  });

  it('reports a working chord once the OS has delivered it', async () => {
    mockGetStatus.mockResolvedValue(
      status({
        enabled: true,
        registered: true,
        lastTriggeredAt: '2026-09-10T12:00:00.000Z',
      }),
    );
    await render();

    expect(text('global-focus-shortcut-status')).toMatch(/working/i);
  });

  it('explains a chord the OS refused and offers to change it', async () => {
    mockGetStatus.mockResolvedValue(
      status({ enabled: true, registered: false, failure: 'in-use' }),
    );
    await render();

    expect(text('global-focus-shortcut-status')).toMatch(
      /another app is using/i,
    );
    expect(query('global-focus-shortcut-change')).not.toBeNull();
  });

  it('records a new chord, saves it, and shows the saved result', async () => {
    mockUpdate.mockResolvedValue({
      ok: true,
      status: status({ enabled: true, accelerator: OTHER, registered: true }),
    });
    await render();

    await click('global-focus-shortcut-change');
    expect(query('global-focus-shortcut-save')?.hasAttribute('disabled')).toBe(
      true,
    );

    await pressInRecorder({
      key: 'P',
      code: 'KeyP',
      shiftKey: true,
      ...primary,
    });
    expect(text('global-focus-shortcut-preview')).toBe(
      display(OTHER).replace(/\s/g, ''),
    );
    expect(query('global-focus-shortcut-save')?.hasAttribute('disabled')).toBe(
      false,
    );

    await click('global-focus-shortcut-save');

    expect(mockUpdate).toHaveBeenCalledWith({ accelerator: OTHER });
    expect(query('global-focus-shortcut-recorder')).toBeNull();
    expect(text('global-focus-shortcut-chord')).toBe(
      display(OTHER).replace(/\s/g, ''),
    );
  });

  it('keeps the previous chord and explains when the OS refuses the new one', async () => {
    mockGetStatus.mockResolvedValue(
      status({ enabled: true, registered: true }),
    );
    mockUpdate.mockResolvedValue({
      ok: false,
      reason: 'in-use',
      accelerator: OTHER,
      status: status({ enabled: true, registered: true }),
    });
    await render();

    await click('global-focus-shortcut-change');
    await pressInRecorder({
      key: 'P',
      code: 'KeyP',
      shiftKey: true,
      ...primary,
    });
    await click('global-focus-shortcut-save');

    expect(text('global-focus-shortcut-error')).toMatch(/couldn't use/i);
    expect(text('global-focus-shortcut-error')).toMatch(
      /another app is using it/i,
    );
    // The recorder stays open with the refused chord so the user can try
    // another without starting over; the saved chord is unchanged.
    expect(text('global-focus-shortcut-preview')).toBe(
      display(OTHER).replace(/\s/g, ''),
    );
    expect(text('global-focus-shortcut-chord')).toBe(
      display(DEFAULT).replace(/\s/g, ''),
    );
  });

  it('refuses a View-menu zoom chord as already used', async () => {
    await render();
    await click('global-focus-shortcut-change');

    await pressInRecorder({ key: '0', code: 'Digit0', ...primary });

    // The zoom items are main-process menu accelerators that are always
    // bound, so the OS would hand the chord to the global shortcut first
    // and silently break Actual Size.
    expect(text('global-focus-shortcut-validation')).toContain(
      'Already used by Actual Size',
    );
    expect(text('global-focus-shortcut-validation')).not.toContain(
      'keyboard resizing',
    );
    expect(query('global-focus-shortcut-save')?.hasAttribute('disabled')).toBe(
      true,
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('refuses a chord an in-app command already uses', async () => {
    await render();
    await click('global-focus-shortcut-change');

    await pressInRecorder({ key: 'k', code: 'KeyK', ...primary });

    const palette = COMMAND_DEFINITIONS.find(
      (c) => c.id === 'open-command-palette',
    );
    expect(text('global-focus-shortcut-validation')).toContain(
      `Already used by ${palette?.title ?? ''}`,
    );
    expect(query('global-focus-shortcut-save')?.hasAttribute('disabled')).toBe(
      true,
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('explains an unusable saved chord with copy that matches the reason', async () => {
    mockGetStatus.mockResolvedValue(
      status({ enabled: true, registered: false, failure: 'invalid' }),
    );
    await render();

    expect(text('global-focus-shortcut-status')).toBe(
      'Not active. Choose another shortcut.',
    );
  });

  it('reports an enabled chord that is not registered even without a reason', async () => {
    mockGetStatus.mockResolvedValue(
      status({ enabled: true, registered: false }),
    );
    await render();

    expect(text('global-focus-shortcut-status')).toBe('Not active.');
  });

  it('asks for a modifier and ignores modifier-only presses', async () => {
    await render();
    await click('global-focus-shortcut-change');

    await pressInRecorder({ key: 'Shift', code: 'ShiftLeft', shiftKey: true });
    expect(text('global-focus-shortcut-preview')).toBe('');

    await pressInRecorder({ key: 'o', code: 'KeyO' });
    expect(text('global-focus-shortcut-validation')).toMatch(/modifier/i);
    // ⌥ alone is the macOS special-character layer, so the hint must not
    // suggest it there.
    expect(text('global-focus-shortcut-validation')).not.toMatch(/⌥/);
    expect(query('global-focus-shortcut-save')?.hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('refuses a bare ⌥ chord on macOS and offers only ⌘ in the hint', async () => {
    // ⌥+key is the macOS special-character layer (⌥o→ø); the section reads
    // the platform from the status payload, so this is deterministic.
    mockGetStatus.mockResolvedValue(status({ platform: 'darwin' }));
    await render();
    await click('global-focus-shortcut-change');

    await pressInRecorder({ key: 'ø', code: 'KeyO', altKey: true });
    expect(text('global-focus-shortcut-validation')).toBe(
      'Add a modifier key such as ⌘',
    );
    expect(query('global-focus-shortcut-save')?.hasAttribute('disabled')).toBe(
      true,
    );

    await pressInRecorder({
      key: 'ø',
      code: 'KeyO',
      altKey: true,
      metaKey: true,
    });
    expect(text('global-focus-shortcut-preview')).toBe(
      formatAcceleratorForDisplay('CommandOrControl+Alt+O', 'darwin'),
    );
    expect(query('global-focus-shortcut-validation')).toBeNull();
    expect(query('global-focus-shortcut-save')?.hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('resets to the default chord through the bridge', async () => {
    mockGetStatus.mockResolvedValue(
      status({ enabled: true, accelerator: OTHER, registered: true }),
    );
    mockUpdate.mockResolvedValue({
      ok: true,
      status: status({ enabled: true, registered: true }),
    });
    await render();

    await click('global-focus-shortcut-reset');

    expect(mockUpdate).toHaveBeenCalledWith({ accelerator: DEFAULT });
    expect(text('global-focus-shortcut-chord')).toBe(
      display(DEFAULT).replace(/\s/g, ''),
    );
  });

  it('reports a failed save instead of snapping the toggle back silently', async () => {
    // Main re-throws after restoring the registration when the preference
    // write fails; the renderer must say so rather than leak the rejection.
    mockUpdate.mockRejectedValue(new Error('disk full'));
    await render();

    await click('global-focus-shortcut-toggle');

    expect(text('global-focus-shortcut-error')).toMatch(/couldn't save/i);
    expect(
      query('global-focus-shortcut-toggle')?.getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('lets a bare Tab leave the recorder and names Escape as the way out', async () => {
    await render();
    await click('global-focus-shortcut-change');

    const recorder = query('global-focus-shortcut-recorder');
    let defaultPrevented = true;
    await act(async () => {
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Tab',
        code: 'Tab',
      });
      recorder?.dispatchEvent(event);
      defaultPrevented = event.defaultPrevented;
      await Promise.resolve();
    });

    expect(defaultPrevented).toBe(false);
    expect(text('global-focus-shortcut-preview')).toBe('');
    expect(text('global-focus-shortcut-recorder-panel')).toMatch(/esc/i);
  });

  it('lets Shift+Tab leave the recorder backwards too', async () => {
    await render();
    await click('global-focus-shortcut-change');

    const recorder = query('global-focus-shortcut-recorder');
    let defaultPrevented = true;
    await act(async () => {
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Tab',
        code: 'Tab',
        shiftKey: true,
      });
      recorder?.dispatchEvent(event);
      defaultPrevented = event.defaultPrevented;
      await Promise.resolve();
    });

    expect(defaultPrevented).toBe(false);
    expect(text('global-focus-shortcut-preview')).toBe('');
  });

  it('announces the captured chord to assistive technology', async () => {
    await render();
    await click('global-focus-shortcut-change');

    expect(
      query('global-focus-shortcut-preview')?.getAttribute('aria-live'),
    ).toBe('polite');
  });

  it('follows status pushes from the main process', async () => {
    await render();

    await act(async () => {
      pushStatus?.(
        status({
          enabled: true,
          registered: true,
          lastTriggeredAt: '2026-09-10T12:00:00.000Z',
        }),
      );
      await Promise.resolve();
    });

    expect(text('global-focus-shortcut-status')).toMatch(/working/i);
  });
});
