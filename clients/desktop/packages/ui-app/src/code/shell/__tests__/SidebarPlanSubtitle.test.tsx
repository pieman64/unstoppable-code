/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SidebarPlanSubtitle } from '../SidebarPlanSubtitle';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The desktop sidebar's plan line, extracted so the web portal's shared account
// row paints the same thing: muted text, a trial pill only for trials, a
// skeleton while loading — never the billing pill (CAN-2829, Sergii: the
// green badge looks totally different from the desktop app).
describe('SidebarPlanSubtitle', () => {
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

  it('renders the plan as muted text with the desktop test ids and accessible name', () => {
    act(() => {
      root.render(<SidebarPlanSubtitle label="Enterprise" />);
    });
    const subtitle = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-subscription-plan-subtitle"]',
    );
    expect(subtitle?.getAttribute('aria-label')).toBe('Enterprise plan');
    expect(subtitle?.getAttribute('aria-busy')).toBe('false');
    expect(subtitle?.className).toContain('fg-tertiary');
    expect(subtitle?.className).toContain('text-2xs');
    const tier = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-subscription-plan-tier"]',
    );
    expect(tier?.textContent).toBe('Enterprise');
    expect(tier?.getAttribute('title')).toBe('Enterprise');
    expect(
      container.querySelector(
        '[data-testid="sidebar-subscription-trial-pill"]',
      ),
    ).toBeNull();
  });

  it('draws the trial pill as the shared warning badge, never the accent', () => {
    act(() => {
      root.render(<SidebarPlanSubtitle label="Business" trial />);
    });
    const pill = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-subscription-trial-pill"]',
    );
    expect(pill?.className).toContain('h-4.5');
    expect(pill?.className).toContain('rounded-full');
    expect(pill?.className).toContain('bg-warning-subtle fg-warning-strong');
    expect(pill?.className).not.toMatch(/accent|ring-/);
  });

  it('adds the trial pill and says so in the accessible name', () => {
    act(() => {
      root.render(<SidebarPlanSubtitle label="Business" trial />);
    });
    expect(
      container
        .querySelector('[data-testid="sidebar-subscription-plan-subtitle"]')
        ?.getAttribute('aria-label'),
    ).toBe('Business plan, trial active');
    expect(
      container.querySelector('[data-testid="sidebar-subscription-trial-pill"]')
        ?.textContent,
    ).toBe('Trial');
  });

  it('reserves the line with a reduced-motion-safe skeleton while loading', () => {
    act(() => {
      root.render(<SidebarPlanSubtitle label={null} loading />);
    });
    const subtitle = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-subscription-plan-subtitle"]',
    );
    expect(subtitle?.getAttribute('aria-busy')).toBe('true');
    expect(subtitle?.getAttribute('aria-label')).toBe('Loading account plan');
    expect(
      container.querySelector(
        '[data-testid="sidebar-subscription-plan-skeleton"]',
      )?.className,
    ).toContain('sidebar-icon-skeleton');
  });

  it('renders nothing without a plan when not loading', () => {
    act(() => {
      root.render(<SidebarPlanSubtitle label={null} />);
    });
    expect(container.innerHTML).toBe('');
  });
});
