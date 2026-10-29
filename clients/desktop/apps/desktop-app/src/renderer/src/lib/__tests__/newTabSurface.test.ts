import { resolveNewTabSurface } from '../newTabSurface';

/**
 * Duck-typed event target whose `.closest(selector)` matches when any of the
 * configured fragments is a substring of the probed selector — the same
 * approach the `useGlobalShortcuts` tests use to exercise the
 * `isTerminalTarget` / `isBrowserSurfaceTarget` selector probes without a DOM.
 */
class ShortcutTarget extends EventTarget {
  constructor(private readonly matchedSelectorFragments: string[]) {
    super();
  }

  closest(selector: string): object | null {
    return this.matchedSelectorFragments.some((fragment) =>
      selector.includes(fragment),
    )
      ? this
      : null;
  }
}

function makeTarget(matchedSelectorFragments: string[]): EventTarget {
  return new ShortcutTarget(matchedSelectorFragments);
}

const terminalTarget = makeTarget(['.xterm']);
const browserTarget = makeTarget(['data-browser-surface']);
const plainTarget = makeTarget([]);

describe('resolveNewTabSurface (ECW-7984)', () => {
  it('routes a focused terminal to a terminal tab regardless of active panel', () => {
    expect(
      resolveNewTabSurface({ target: terminalTarget, activePanelKind: 'chat' }),
    ).toBe('terminal');
    expect(
      resolveNewTabSurface({
        target: terminalTarget,
        activePanelKind: 'browser',
      }),
    ).toBe('terminal');
  });

  it('routes focused browser chrome to a browser tab regardless of active panel', () => {
    expect(
      resolveNewTabSurface({ target: browserTarget, activePanelKind: 'chat' }),
    ).toBe('browser');
    expect(
      resolveNewTabSurface({
        target: browserTarget,
        activePanelKind: 'terminal',
      }),
    ).toBe('browser');
  });

  it('falls back to the active panel group kind when focus is unscoped', () => {
    expect(
      resolveNewTabSurface({
        target: plainTarget,
        activePanelKind: 'terminal',
      }),
    ).toBe('terminal');
    expect(
      resolveNewTabSurface({ target: plainTarget, activePanelKind: 'browser' }),
    ).toBe('browser');
    expect(
      resolveNewTabSurface({ target: plainTarget, activePanelKind: 'chat' }),
    ).toBe('chat');
  });

  it('treats non-tabbed panel kinds and missing layouts as the chat fallback', () => {
    for (const kind of [
      'activity-section',
      'activity-card',
      'file-explorer',
      'file-diff',
      'usage',
      null,
    ]) {
      expect(
        resolveNewTabSurface({ target: plainTarget, activePanelKind: kind }),
      ).toBe('chat');
    }
  });

  it('handles null targets (window-level keydowns)', () => {
    expect(resolveNewTabSurface({ target: null, activePanelKind: null })).toBe(
      'chat',
    );
    expect(
      resolveNewTabSurface({ target: null, activePanelKind: 'browser' }),
    ).toBe('browser');
  });
});
