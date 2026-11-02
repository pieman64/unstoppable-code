/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SidebarNavRow } from '../SidebarNavRow';
import { SidebarPageNav } from '../SidebarPageNav';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('SidebarNavRow label', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, 'localPlatform');
    Reflect.deleteProperty(window, 'platform');
  });

  function render(element: JSX.Element): void {
    act(() => root.render(element));
  }

  function button(testId: string): HTMLButtonElement {
    const element = container.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
    if (!element) throw new Error(`${testId} not rendered`);
    return element;
  }

  it('renders the label on the button with the caller classes', () => {
    render(
      <SidebarNavRow
        data-testid="row"
        icon={<svg aria-hidden="true" />}
        className="text-left"
      >
        Pipelines
      </SidebarNavRow>,
    );
    const row = button('row');
    expect(row.classList.contains('text-left')).toBe(true);
    expect(row.textContent).toBe('Pipelines');
  });

  it('renders the Back row of a sidebar page', () => {
    render(
      <SidebarPageNav
        ariaLabel="Settings"
        sidebarTestId="page-nav"
        backTestId="page-nav-back"
        resizeHandleTestId="page-nav-resize"
        scrollViewportTestId="page-nav-scroll"
        onBack={jest.fn()}
      >
        <p>Page nav body</p>
      </SidebarPageNav>,
    );
    const back = button('page-nav-back');
    expect(back.textContent).toBe('Back');
  });

  it.each<NodeJS.Platform>(['linux', 'darwin', 'win32'])(
    'reserves an empty titlebar strip only without the local %s native frame',
    (platform) => {
      Object.defineProperty(window, 'localPlatform', {
        configurable: true,
        value: platform,
      });
      Object.defineProperty(window, 'platform', {
        configurable: true,
        value: platform === 'linux' ? 'darwin' : 'linux',
      });
      render(
        <SidebarPageNav
          ariaLabel="Settings"
          sidebarTestId="page-nav"
          backTestId="page-nav-back"
          resizeHandleTestId="page-nav-resize"
          scrollViewportTestId="page-nav-scroll"
          onBack={jest.fn()}
        >
          <p>Page nav body</p>
        </SidebarPageNav>,
      );
      const emptyStrip = Array.from(container.querySelectorAll('div')).find(
        (element) => element.className === 'electron-drag h-10 shrink-0',
      );
      expect(Boolean(emptyStrip)).toBe(platform !== 'linux');
      expect(button('page-nav-back').textContent).toBe('Back');
      expect(container.textContent).toContain('Page nav body');
    },
  );
});
