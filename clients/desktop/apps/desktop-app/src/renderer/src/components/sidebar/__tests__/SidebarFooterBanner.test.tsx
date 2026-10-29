/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SidebarFooterBanner } from '../SidebarFooterBanner';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

describe('SidebarFooterBanner height', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setTestEarlyAccessFeatures({ enabled: false });
  });

  function renderBanners(): { plain: Element | null; split: Element | null } {
    act(() => {
      root.render(
        <>
          <SidebarFooterBanner
            surface="status"
            testId="plain"
            onClick={() => {}}
          >
            Update
          </SidebarFooterBanner>
          <SidebarFooterBanner
            surface="status"
            testId="split"
            onClick={() => {}}
            trailingAction={{
              ariaLabel: 'Dismiss',
              icon: null,
              onClick: () => {},
              testId: 'split-dismiss',
            }}
          >
            Resume
          </SidebarFooterBanner>
        </>,
      );
    });
    return {
      plain: container.querySelector('[data-testid="plain"]'),
      split: container.querySelector('[data-testid="split-row"]'),
    };
  }

  it('matches the 32px sidebar rows under early access', () => {
    setTestEarlyAccessFeatures({ enabled: true });
    const { plain, split } = renderBanners();
    expect(plain?.classList).toContain('h-8');
    expect(split?.classList).toContain('h-8');
    expect(plain?.classList).toContain('rounded-row');
    // 28px trailing button in the 32px banner: 2px above, below, and right.
    const dismiss = container.querySelector('[data-testid="split-dismiss"]');
    expect(dismiss?.classList).toContain('h-7');
    expect(dismiss?.classList).toContain('w-7');
  });

  it('keeps its 28px card without early access', () => {
    const { plain, split } = renderBanners();
    expect(plain?.classList).toContain('h-7');
    expect(split?.classList).toContain('h-7');
    const dismiss = container.querySelector('[data-testid="split-dismiss"]');
    expect(dismiss?.classList).toContain('h-6');
  });
});
