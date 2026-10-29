/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SidebarGuestProjectsCard } from '../SidebarGuestProjectsCard';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('SidebarGuestProjectsCard', () => {
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

  function render(
    props: Partial<Parameters<typeof SidebarGuestProjectsCard>[0]> = {},
  ): void {
    act(() => {
      root.render(
        <SidebarGuestProjectsCard
          signInHref="/login?callbackURL=%2Fchat"
          {...props}
        />,
      );
    });
  }

  function action(testId = 'portal-sidebar-guest-projects-card'): HTMLElement {
    const element = container.querySelector<HTMLElement>(
      `[data-testid="${testId}-action"]`,
    );
    if (element === null) throw new Error('action anchor missing');
    return element;
  }

  function dispatch(type: string, init: MouseEventInit = {}): MouseEvent {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    act(() => {
      action().dispatchEvent(event);
    });
    return event;
  }

  it('renders the copy and one real anchor to the account href', () => {
    render();
    const card = container.querySelector(
      '[data-testid="portal-sidebar-guest-projects-card"]',
    );
    expect(card?.textContent).toContain(
      'Run agents on your own repos and keep every chat across your devices.',
    );
    const anchors = container.querySelectorAll('a');
    expect(anchors).toHaveLength(1);
    expect(action().tagName).toBe('A');
    expect(action().textContent).toBe('Create a free account');
    expect(action().getAttribute('href')).toBe('/login?callbackURL=%2Fchat');
  });

  it('honors a custom test id', () => {
    render({ testId: 'custom-card' });
    expect(
      container.querySelector('[data-testid="custom-card"]'),
    ).not.toBeNull();
    expect(action('custom-card').tagName).toBe('A');
  });

  it('activates once on a click without blocking the navigation', () => {
    const onActivate = jest.fn();
    render({ onActivate });
    const event = dispatch('click', { button: 0 });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it('activates on a modified click and leaves it to the browser', () => {
    const onActivate = jest.fn();
    render({ onActivate });
    const event = dispatch('click', { button: 0, metaKey: true });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it('activates once on a middle click', () => {
    const onActivate = jest.fn();
    render({ onActivate });
    dispatch('auxclick', { button: 1 });
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('does not activate on a right click', () => {
    const onActivate = jest.fn();
    render({ onActivate });
    dispatch('auxclick', { button: 2 });
    dispatch('contextmenu', { button: 2 });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('works without a callback', () => {
    render();
    expect(() => {
      dispatch('click', { button: 0 });
      dispatch('auxclick', { button: 1 });
    }).not.toThrow();
  });
});
