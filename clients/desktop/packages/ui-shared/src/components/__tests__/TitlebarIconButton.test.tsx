/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlusMediumIcon, SettingsIcon } from '../../icons/AppIcons';
import { resetInputModality } from '../../lib/input-modality';
import { TitlebarIconButton } from '../TitlebarIconButton';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('TitlebarIconButton foreground', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function buttonClasses(): string[] {
    return (container.querySelector('button')?.className ?? '').split(/\s+/);
  }

  it('takes the top-bar ink by default', () => {
    act(() => {
      root.render(<TitlebarIconButton icon={SettingsIcon} aria-label="Open" />);
    });

    const tokens = buttonClasses();
    expect(tokens).toContain('fg-secondary');
    expect(tokens).toContain('enabled:hover:fg-primary');
    expect(tokens).not.toContain('titlebar-control-fg');
  });

  it('reads the app-window control token for the titlebar corner', () => {
    act(() => {
      root.render(
        <TitlebarIconButton
          icon={SettingsIcon}
          aria-label="Hide sidebar"
          foreground="titlebar"
        />,
      );
    });

    const tokens = buttonClasses();
    expect(tokens).toContain('titlebar-control-fg');
    expect(tokens).not.toContain('fg-secondary');
    expect(tokens).not.toContain('enabled:hover:fg-primary');
    // The shared 28px frame and hover surface are the same in both inks.
    expect(tokens).toContain('h-7');
    expect(tokens).toContain('w-7');
    expect(tokens).toContain('enabled:hover:bg-subtle');
  });
});

function buttonClassTokens(html: string): string[] {
  const tag = /<button[^>]*>/.exec(html)?.[0] ?? '';
  return (/class="([^"]*)"/.exec(tag)?.[1] ?? '').split(/\s+/);
}

describe('TitlebarIconButton surface', () => {
  it('renders the bare 28px titlebar control by default', () => {
    const tokens = buttonClassTokens(
      renderToStaticMarkup(
        <TitlebarIconButton icon={PlusMediumIcon} aria-label="Add" />,
      ),
    );

    expect(tokens).toEqual(
      expect.arrayContaining(['h-7', 'w-7', 'electron-no-drag']),
    );
    expect(tokens).not.toContain('canopy-panel-chrome-button');
    expect(tokens).not.toContain('canopy-panel-add-tab');
  });

  it("names the panel chrome cluster and the tab strip's add control for the panels stylesheet", () => {
    const chrome = buttonClassTokens(
      renderToStaticMarkup(
        <TitlebarIconButton
          icon={PlusMediumIcon}
          aria-label="Close all"
          surface="panelChrome"
        />,
      ),
    );
    const strip = buttonClassTokens(
      renderToStaticMarkup(
        <TitlebarIconButton
          icon={PlusMediumIcon}
          aria-label="New tab"
          surface="panelTabStrip"
        />,
      ),
    );

    expect(chrome).toContain('canopy-panel-chrome-button');
    expect(chrome).not.toContain('canopy-panel-add-tab');
    expect(strip).toContain('canopy-panel-add-tab');
    expect(strip).not.toContain('canopy-panel-chrome-button');
    // Both keep the shared titlebar geometry.
    expect(chrome).toContain('h-7');
    expect(strip).toContain('h-7');
  });

  it('keeps the hover look while expanded only when asked', () => {
    const plain = renderToStaticMarkup(
      <TitlebarIconButton icon={SettingsIcon} aria-label="Activity" />,
    );
    const held = renderToStaticMarkup(
      <TitlebarIconButton
        icon={SettingsIcon}
        aria-label="Activity"
        holdHoverWhenExpanded
        aria-expanded
      />,
    );
    expect(plain).not.toContain('aria-expanded:bg-subtle');
    expect(held).toContain('aria-expanded:bg-subtle');
    expect(held).toContain('aria-expanded:fg-primary');
    expect(held).toContain('aria-expanded="true"');
  });
});

describe('TitlebarIconButton tooltip shortcut', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    resetInputModality(document);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('names the keys after the label as one cap per key', () => {
    act(() => {
      root.render(
        <TitlebarIconButton
          icon={SettingsIcon}
          aria-label="Search"
          tooltipShortcut="⌘K"
        />,
      );
    });
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
      container.querySelector('button')?.focus();
    });

    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe('Search⌘K');
    expect(
      Array.from(tooltip?.querySelectorAll('kbd') ?? []).map(
        (cap) => cap.textContent,
      ),
    ).toEqual(['⌘', 'K']);
    // The button's name stays its label.
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Search',
    );
  });
});
