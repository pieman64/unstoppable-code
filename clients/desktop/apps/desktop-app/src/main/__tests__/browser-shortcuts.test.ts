import {
  resolveBrowserShortcutAction,
  type BrowserShortcutInput,
} from '../browser/browser-shortcuts';

function input(overrides: Partial<BrowserShortcutInput>): BrowserShortcutInput {
  return {
    type: 'keyDown',
    code: 'KeyT',
    alt: false,
    control: false,
    meta: false,
    shift: false,
    ...overrides,
  };
}

describe('resolveBrowserShortcutAction (ECW-7984)', () => {
  describe('macOS', () => {
    it('maps Cmd+T to new-tab', () => {
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyT', meta: true }),
          'darwin',
        ),
      ).toBe('new-tab');
    });

    it('maps Cmd+L to focus-address-bar', () => {
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyL', meta: true }),
          'darwin',
        ),
      ).toBe('focus-address-bar');
    });

    it('maps Cmd+B to toggle-sidebar', () => {
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyB', meta: true }),
          'darwin',
        ),
      ).toBe('toggle-sidebar');
    });

    it('maps Cmd+F to find-in-page (CAN-3048)', () => {
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyF', meta: true }),
          'darwin',
        ),
      ).toBe('find-in-page');
    });

    it('leaves Shift+Cmd+F, Alt+Cmd+F, and Ctrl+F unhandled on macOS', () => {
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyF', meta: true, shift: true }),
          'darwin',
        ),
      ).toBeNull();
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyF', meta: true, alt: true }),
          'darwin',
        ),
      ).toBeNull();
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyF', control: true }),
          'darwin',
        ),
      ).toBeNull();
    });

    it('maps Cmd+W to close-tab', () => {
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyW', meta: true }),
          'darwin',
        ),
      ).toBe('close-tab');
    });

    it('leaves Shift+Cmd+W, Alt+Cmd+W, and Ctrl+W unhandled on macOS', () => {
      // Shift+Cmd+W is close-window on macOS; the page must keep receiving it.
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyW', meta: true, shift: true }),
          'darwin',
        ),
      ).toBeNull();
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyW', meta: true, alt: true }),
          'darwin',
        ),
      ).toBeNull();
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyW', control: true }),
          'darwin',
        ),
      ).toBeNull();
    });

    it('maps Cmd+Left / Cmd+Right to back / forward', () => {
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'ArrowLeft', meta: true }),
          'darwin',
        ),
      ).toBe('back');
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'ArrowRight', meta: true }),
          'darwin',
        ),
      ).toBe('forward');
    });

    it('ignores Ctrl-based chords on macOS', () => {
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyT', control: true }),
          'darwin',
        ),
      ).toBeNull();
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'ArrowLeft', alt: true }),
          'darwin',
        ),
      ).toBeNull();
    });

    it('ignores extra modifiers (Shift/Alt/Ctrl on top of Cmd)', () => {
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyT', meta: true, shift: true }),
          'darwin',
        ),
      ).toBeNull();
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'ArrowLeft', meta: true, alt: true }),
          'darwin',
        ),
      ).toBeNull();
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyT', meta: true, control: true }),
          'darwin',
        ),
      ).toBeNull();
    });
  });

  describe.each(['win32', 'linux'] as const)('%s', (platform) => {
    it('maps Ctrl+T, Ctrl+L, and Ctrl+B to renderer actions', () => {
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyT', control: true }),
          platform,
        ),
      ).toBe('new-tab');
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyL', control: true }),
          platform,
        ),
      ).toBe('focus-address-bar');
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyB', control: true }),
          platform,
        ),
      ).toBe('toggle-sidebar');
    });

    it('maps Ctrl+F to find-in-page (CAN-3048)', () => {
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyF', control: true }),
          platform,
        ),
      ).toBe('find-in-page');
    });

    it('leaves Shift+Ctrl+F, Alt+Ctrl+F, Alt+F, and Meta+F unhandled', () => {
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyF', control: true, shift: true }),
          platform,
        ),
      ).toBeNull();
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyF', control: true, alt: true }),
          platform,
        ),
      ).toBeNull();
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyF', alt: true }),
          platform,
        ),
      ).toBeNull();
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyF', meta: true }),
          platform,
        ),
      ).toBeNull();
    });

    it('maps Ctrl+W to close-tab', () => {
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyW', control: true }),
          platform,
        ),
      ).toBe('close-tab');
    });

    it('leaves Shift+Ctrl+W, Alt+Ctrl+W, Alt+W, and Meta+W unhandled', () => {
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyW', control: true, shift: true }),
          platform,
        ),
      ).toBeNull();
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyW', control: true, alt: true }),
          platform,
        ),
      ).toBeNull();
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyW', alt: true }),
          platform,
        ),
      ).toBeNull();
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyW', meta: true }),
          platform,
        ),
      ).toBeNull();
    });

    it('maps the platform history convention Alt+Left / Alt+Right', () => {
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'ArrowLeft', alt: true }),
          platform,
        ),
      ).toBe('back');
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'ArrowRight', alt: true }),
          platform,
        ),
      ).toBe('forward');
    });

    it('ignores Meta chords and mixed modifiers', () => {
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyT', meta: true }),
          platform,
        ),
      ).toBeNull();
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'ArrowLeft', alt: true, control: true }),
          platform,
        ),
      ).toBeNull();
      expect(
        resolveBrowserShortcutAction(
          input({ code: 'KeyT', control: true, shift: true }),
          platform,
        ),
      ).toBeNull();
    });
  });

  it('only handles keyDown inputs', () => {
    expect(
      resolveBrowserShortcutAction(
        input({ type: 'keyUp', code: 'KeyT', meta: true }),
        'darwin',
      ),
    ).toBeNull();
  });

  it('never claims plain unmodified keys', () => {
    expect(
      resolveBrowserShortcutAction(input({ code: 'KeyT' }), 'darwin'),
    ).toBeNull();
    expect(
      resolveBrowserShortcutAction(input({ code: 'ArrowLeft' }), 'win32'),
    ).toBeNull();
  });
});
