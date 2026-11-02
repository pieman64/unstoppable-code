/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE } from '@/lib/browserNativeOverlay';
import { DialogModal, useOverlayEscape } from '@canopy/ui-shared/components';
import { SettingsOverlay } from '../SettingsOverlay';
import { useSidebarStore } from '@/stores/sidebarStore';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';

jest.mock('../SettingsNav', () => ({
  SettingsNav: ({
    width,
    onResize,
  }: {
    width: number;
    onResize: (widthPx: number) => void;
  }): JSX.Element => (
    <nav data-testid="settings-nav" style={{ width }}>
      <button
        type="button"
        data-testid="settings-nav-resize-probe"
        onClick={() => onResize(412)}
      />
    </nav>
  ),
}));

jest.mock('../CanopyTab', () => ({
  CanopyTab: (): JSX.Element => <div data-testid="canopy-settings" />,
}));

jest.mock('../PerformanceTab', () => ({
  PerformanceTab: (): JSX.Element => <div />,
}));
jest.mock('../KeyboardShortcutsTab', () => ({
  KeyboardShortcutsTab: (): JSX.Element => <div />,
}));
jest.mock('../DisplayTab', () => ({
  DisplayTab: (): JSX.Element => <div />,
}));
jest.mock('../NotificationsTab', () => ({
  NotificationsTab: (): JSX.Element => <div />,
}));
jest.mock('../AccountTab', () => ({
  AccountTab: (): JSX.Element => <div />,
}));
jest.mock('../PrivacyTab', () => ({
  PrivacyTab: (): JSX.Element => <div />,
}));
jest.mock('../ChatTab', () => ({
  ChatTab: (): JSX.Element => <div />,
}));
jest.mock('../InstructionsTab', () => ({
  InstructionsTab: (): JSX.Element => <div />,
}));
jest.mock('../AppAdvisorTab', () => ({
  AppAdvisorTab: (): JSX.Element => <div />,
}));
jest.mock('../FilesTab', () => ({
  FilesTab: (): JSX.Element => <div />,
}));
jest.mock('../BrowserTab', () => ({
  BrowserTab: (): JSX.Element => <div />,
}));
jest.mock('../PlanDetectionTab', () => ({
  PlanDetectionTab: (): JSX.Element => <div />,
}));
jest.mock('../DictationTab', () => ({
  DictationTab: (): JSX.Element => <div />,
}));
jest.mock('../CodexTab', () => ({
  CodexTab: (): JSX.Element => <div />,
}));
jest.mock('../ClaudeTab', () => ({
  ClaudeTab: (): JSX.Element => <div />,
}));
jest.mock('../OllamaTab', () => ({
  OllamaTab: (): JSX.Element => <div />,
}));
jest.mock('../GitTab', () => ({
  GitTab: (): JSX.Element => <div />,
}));
jest.mock('../ApplicationsTab', () => ({
  ApplicationsTab: (): JSX.Element => <div />,
}));
jest.mock('../McpTab', () => ({
  McpTab: (): JSX.Element => <div />,
}));
jest.mock('../LegalTab', () => ({
  LegalTab: (): JSX.Element => <div />,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('SettingsOverlay', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    jest.useFakeTimers();
    window.localStorage.clear();
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    useSidebarStore.setState({ width: 364 });
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
      root.render(<SettingsOverlay onClose={jest.fn()} />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('marks itself as blocking native browser content', () => {
    const overlay = container.querySelector('[data-testid="settings-overlay"]');

    expect(overlay?.getAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE)).toBe(
      'true',
    );
    expect(overlay?.getAttribute('data-open')).toBe('true');
    expect(
      container.querySelector('[data-testid="settings-sidebar-page"]'),
    ).not.toBeNull();
  });

  it('reserves the scrollbar width so pages never shift when one appears', () => {
    const scroller = container.querySelector(
      '[data-testid="settings-content"] > .overflow-auto',
    );
    expect(scroller?.classList.contains('page-scroll-gutter')).toBe(true);
  });

  it('keeps the drag row outside the inset Settings card', () => {
    const content = container.querySelector('[data-testid="settings-content"]');
    const dragStrip = content?.querySelector('.electron-drag');
    const scroller = content?.querySelector('.overflow-auto');

    // The drag strip floats over the page instead of taking a row above it,
    // so scrolled content is never cut off by an empty band.
    expect(content?.firstElementChild).toBe(scroller);
    expect(dragStrip).toBeNull();
    expect(scroller?.classList.contains('settings-content-scroll-mask')).toBe(
      false,
    );
  });

  it('is a card inset like the main window under early access', () => {
    act(() => {
      setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    });
    try {
      const overlay = container.querySelector(
        '[data-testid="settings-overlay"]',
      );
      const content = container.querySelector(
        '[data-testid="settings-content"]',
      );
      const scroller = content?.querySelector('.overflow-auto');
      // The globals.css card rules key off this flag.
      expect(overlay?.getAttribute('data-settings-layout')).toBe('inset');
      // The window's empty top row (which drags the window) sits above the
      // card, so the card holds no drag strip and no fade for one.
      const topRow = content?.previousElementSibling;
      expect(topRow?.classList.contains('electron-drag')).toBe(true);
      expect(topRow?.classList.contains('h-11.5')).toBe(true);
      expect(content?.querySelector('.electron-drag')).toBeNull();
      expect(scroller?.classList.contains('settings-content-scroll-mask')).toBe(
        false,
      );
      expect(scroller?.classList.contains('pt-10')).toBe(false);
      expect(scroller?.classList.contains('page-scroll-gutter')).toBe(true);
    } finally {
      act(() => {
        resetExperimentalFeaturesStoreForTest();
      });
    }
  });

  it('uses the inset Settings card without a Labs opt-in', () => {
    const overlay = container.querySelector('[data-testid="settings-overlay"]');
    const content = container.querySelector('[data-testid="settings-content"]');
    expect(overlay?.getAttribute('data-settings-layout')).toBe('inset');
    // No top row: the page runs the window's full height, its drag strip
    // floating over it.
    expect(content?.previousElementSibling?.classList.contains('hidden')).toBe(
      false,
    );
    expect(content?.querySelector('.electron-drag')).toBeNull();
    // It fills its column without growing past it, so its page scrolls.
    expect(content?.classList.contains('min-h-0')).toBe(true);
  });

  it('keeps the open page mounted when early access turns on or off', () => {
    const before = container.querySelector('[data-testid="canopy-settings"]');
    expect(before).not.toBeNull();
    act(() => {
      setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    });
    try {
      // The same page element: its unsaved state (a pending save, an error)
      // survives the switch.
      expect(container.querySelector('[data-testid="canopy-settings"]')).toBe(
        before,
      );
    } finally {
      act(() => {
        resetExperimentalFeaturesStoreForTest();
      });
    }
    expect(container.querySelector('[data-testid="canopy-settings"]')).toBe(
      before,
    );
  });

  it('reveals the app beneath it while the settings sidebar exits', () => {
    act(() => {
      root.render(<SettingsOverlay open={false} onClose={jest.fn()} />);
    });

    const overlay = container.querySelector('[data-testid="settings-overlay"]');
    const content = container.querySelector('[data-testid="settings-content"]');
    expect(overlay?.getAttribute('data-open')).toBe('false');
    expect(overlay?.hasAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE)).toBe(
      false,
    );
    expect(overlay?.hasAttribute('inert')).toBe(true);
    expect(overlay?.getAttribute('aria-hidden')).toBe('true');
    expect(overlay?.className).toContain('pointer-events-none');
    expect(overlay?.className).not.toContain('invisible');
    expect(content?.className).toContain('invisible');

    act(() => {
      jest.advanceTimersByTime(250);
    });
    expect(overlay?.className).toContain('invisible');
  });

  it('mounts Settings content immediately when reduced motion is enabled', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn().mockReturnValue({
        matches: true,
        media: '(prefers-reduced-motion: reduce)',
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      }),
    });

    act(() => {
      root.render(<SettingsOverlay open={false} onClose={jest.fn()} />);
    });
    expect(
      container.querySelector('[data-testid="canopy-settings"]'),
    ).toBeNull();

    act(() => {
      root.render(<SettingsOverlay open onClose={jest.fn()} />);
    });
    expect(
      container.querySelector('[data-testid="canopy-settings"]'),
    ).not.toBeNull();
  });

  it('matches the current main sidebar width', () => {
    const nav = container.querySelector<HTMLElement>(
      '[data-testid="settings-nav"]',
    );

    expect(nav?.style.width).toBe('364px');
  });

  it('writes settings sidebar resizing to the shared sidebar width', () => {
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="settings-nav-resize-probe"]',
        )
        ?.click();
    });

    expect(useSidebarStore.getState().width).toBe(412);
    expect(
      container.querySelector<HTMLElement>('[data-testid="settings-nav"]')
        ?.style.width,
    ).toBe('412px');
  });

  it('closes on Escape when nothing above it owns Escape', () => {
    const onClose = jest.fn();
    act(() => root.render(<SettingsOverlay onClose={onClose} />));
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape from a plain expanded disclosure', () => {
    const onClose = jest.fn();
    act(() => root.render(<SettingsOverlay onClose={onClose} />));
    const disclosure = document.createElement('button');
    disclosure.setAttribute('aria-expanded', 'true');
    const overlay = container.querySelector('[data-testid="settings-overlay"]');
    if (!overlay) throw new Error('Expected Settings overlay');
    overlay.append(disclosure);
    act(() => {
      disclosure.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape to a dialog opened above it', () => {
    const onClose = jest.fn();
    const onDialogClose = jest.fn();
    act(() => root.render(<SettingsOverlay onClose={onClose} />));
    // Opened after Settings, so its listener registers after Settings' own.
    act(() =>
      root.render(
        <>
          <SettingsOverlay onClose={onClose} />
          <DialogModal title="Above settings" onClose={onDialogClose}>
            body
          </DialogModal>
        </>,
      ),
    );
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onDialogClose).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape over an overlay that was registered before it opened', () => {
    // The main shell stays mounted (hidden) under Settings, so a page-level
    // overlay such as a Plugins detail sub-page can already own Escape when
    // Settings opens. Settings is the newer overlay and must win.
    const onClose = jest.fn();
    const onEarlierClose = jest.fn();
    function EarlierOverlay(): JSX.Element {
      useOverlayEscape(true, onEarlierClose);
      return <div data-testid="earlier-overlay" />;
    }
    act(() => root.render(<EarlierOverlay />));
    act(() =>
      root.render(
        <>
          <EarlierOverlay />
          <SettingsOverlay onClose={onClose} />
        </>,
      ),
    );
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onEarlierClose).not.toHaveBeenCalled();
  });
});
