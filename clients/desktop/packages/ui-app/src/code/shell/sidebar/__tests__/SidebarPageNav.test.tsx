/** @jest-environment jsdom */
import { act, createRef, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SidebarPageNav, SidebarPageNavGroup } from '../SidebarPageNav';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('SidebarPageNav', () => {
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

  function nav(testId: string, onBack: () => void = jest.fn()): JSX.Element {
    return (
      <SidebarPageNav
        ariaLabel="Settings"
        sidebarTestId={testId}
        backTestId={`${testId}-back`}
        scrollViewportTestId={`${testId}-scroll`}
        onBack={onBack}
        surface="sidebar"
      >
        <SidebarPageNavGroup label="Account" testId={`${testId}-group`}>
          <span>row</span>
        </SidebarPageNavGroup>
      </SidebarPageNav>
    );
  }

  it('gives each mounted copy its own heading ID while keeping stable test IDs', () => {
    act(() =>
      root.render(
        <>
          {nav('rail')}
          {nav('drawer')}
        </>,
      ),
    );
    const sections: HTMLElement[] = Array.from(
      container.querySelectorAll<HTMLElement>('section'),
    );
    expect(sections).toHaveLength(2);
    const headingIds: (string | null)[] = sections.map((section) =>
      section.getAttribute('aria-labelledby'),
    );
    expect(new Set(headingIds).size).toBe(2);
    sections.forEach((section: HTMLElement, index: number) => {
      const heading = document.getElementById(headingIds[index] ?? '');
      expect(heading?.textContent).toBe('Account');
      expect(section.contains(heading)).toBe(true);
      expect(heading?.id).not.toBe(section.getAttribute('data-testid'));
    });
    expect(
      container.querySelector('[data-testid="rail-group"]'),
    ).not.toBeNull();
  });

  it('labels the landmark, runs Back, and forwards the Back ref', () => {
    const onBack = jest.fn();
    const ref = createRef<HTMLButtonElement>();
    act(() =>
      root.render(
        <SidebarPageNav
          ariaLabel="Settings"
          sidebarTestId="nav"
          backTestId="nav-back"
          scrollViewportTestId="nav-scroll"
          onBack={onBack}
          backButtonRef={ref}
          surface="sidebar"
        >
          <span />
        </SidebarPageNav>,
      ),
    );
    const back = container.querySelector<HTMLButtonElement>(
      '[data-testid="nav-back"]',
    );
    expect(back).toBe(ref.current);
    expect(back?.type).toBe('button');
    expect(back?.textContent).toBe('Back');
    act(() => back?.click());
    expect(onBack).toHaveBeenCalledTimes(1);
    // Back keeps the arrow cursor like the rail rows, even where the host
    // gives every button a hand.
    expect(back?.classList.contains('cursor-default')).toBe(true);
    expect(
      container
        .querySelector('[data-testid="nav"]')
        ?.getAttribute('aria-label'),
    ).toBe('Settings');
    expect(
      container.querySelector('[data-testid="nav-scroll"]'),
    ).not.toBeNull();
  });

  it('fills a host-owned width unless given a fixed one, and places host slots', () => {
    act(() => root.render(nav('fill')));
    const fill = container.querySelector<HTMLElement>('[data-testid="fill"]');
    expect(fill?.className).toBe(
      'bg-sidebar relative h-full shrink-0 select-none font-normal w-full',
    );
    expect(fill?.style.width).toBe('');

    act(() =>
      root.render(
        <SidebarPageNav
          ariaLabel="Settings"
          sidebarTestId="fixed"
          backTestId="fixed-back"
          scrollViewportTestId="fixed-scroll"
          onBack={jest.fn()}
          width={240}
          surface="app-material"
          controlsInDragRegion
          topInset={<div data-testid="inset" />}
          trailing={<div data-testid="trailing" />}
        >
          <span />
        </SidebarPageNav>,
      ),
    );
    const fixed = container.querySelector<HTMLElement>('[data-testid="fixed"]');
    expect(fixed?.style.width).toBe('240px');
    expect(fixed?.className).toBe(
      'app-sidebar-material sidebar-resizable-surface sidebar-instant-interactions relative h-full shrink-0 select-none font-normal',
    );
    const content = fixed?.firstElementChild;
    expect(content?.className).toBe(
      'settings-sidebar-content absolute inset-0 flex flex-col',
    );
    expect(content?.firstElementChild?.getAttribute('data-testid')).toBe(
      'inset',
    );
    const back = container.querySelector<HTMLElement>(
      '[data-testid="fixed-back"]',
    );
    expect(back?.parentElement?.className).toBe(
      'electron-no-drag shrink-0 px-2 pt-2',
    );
    expect(back?.className).toContain('fg-secondary hover:bg-subtle');
    expect(fixed?.lastElementChild?.getAttribute('data-testid')).toBe(
      'trailing',
    );
  });
});
