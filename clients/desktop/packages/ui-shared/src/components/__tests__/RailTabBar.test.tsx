/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RailTabBar, type RailTabBarTab } from '../RailTabBar';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

type Id = 'document' | 'diagram';

const DOCUMENT: RailTabBarTab<Id> = {
  id: 'document',
  label: 'Document',
  dataTestId: 'tab-document',
};
const DIAGRAM: RailTabBarTab<Id> = {
  id: 'diagram',
  label: 'Diagram',
  dataTestId: 'tab-diagram',
};

describe('RailTabBar', () => {
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
  });

  function render(tabs: readonly RailTabBarTab<Id>[]): void {
    act(() => {
      root.render(
        <RailTabBar
          tabs={tabs}
          activeTab="document"
          onTabChange={jest.fn()}
          actions={<span data-testid="action">Split</span>}
        />,
      );
    });
  }

  it('shows two or more tabs as a tab list', () => {
    render([DOCUMENT, DIAGRAM]);
    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="tab-document"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="tab-diagram"]'),
    ).not.toBeNull();
  });

  it('draws no control for a single tab but keeps the header height and actions', () => {
    render([DOCUMENT]);
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('[data-testid="tab-document"]')).toBeNull();
    expect(container.querySelector('[data-testid="action"]')).not.toBeNull();
    // The 28px of the control stays reserved, so the header does not shrink.
    const spacer = container.querySelector(
      '[data-testid="rail-tab-bar-spacer"]',
    );
    expect(spacer?.className.split(/\s+/)).toContain('h-7');
  });
});
