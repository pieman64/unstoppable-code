/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { AgentActivitySection } from '../AgentActivitySection';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const artifactItem = <div key="artifact" data-testid="artifact-card" />;

describe('AgentActivitySection', () => {
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

  it('renders expanded active activity with count and collapses accessibly', () => {
    act(() =>
      root.render(
        <AgentActivitySection
          artifactItems={[artifactItem]}
          variant="active"
        />,
      ),
    );
    expect(container.textContent).toContain('Agent activity');
    expect(container.textContent).toContain('1 item');
    expect(
      container.querySelector('[data-testid="agent-activity-artifact-items"]')
        ?.className,
    ).toContain('@[880px]:grid-cols-4');
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse agent activity"]',
    );
    if (!toggle) throw new Error('Expected collapse toggle');
    act(() => toggle.click());
    expect(
      container.querySelector('[data-testid="agent-activity-items"]'),
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="Expand agent activity"]'),
    ).not.toBeNull();
  });

  it.each(['active', 'completed'] as const)(
    'records the %s section header and blocks its items from session replay',
    (variant) => {
      act(() =>
        root.render(
          <AgentActivitySection
            artifactItems={[artifactItem]}
            variant={variant}
          />,
        ),
      );
      const section = container.querySelector(
        `[data-testid="agent-activity-${variant}"]`,
      );
      expect(section?.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
      const items = container.querySelector(
        '[data-testid="agent-activity-items"]',
      );
      expect(items?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
      expect(
        container
          .querySelector('[data-testid="artifact-card"]')
          ?.closest(`.${REPLAY_BLOCK_CLASS}`),
      ).toBe(items);
      const heading = Array.from(section?.querySelectorAll('span') ?? []).find(
        (span) => span.textContent === 'Agent activity',
      );
      expect(heading).toBeDefined();
      expect(heading?.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
    },
  );

  it('keeps historical sections collapsed when requested', () => {
    act(() =>
      root.render(
        <AgentActivitySection
          artifactItems={[artifactItem]}
          variant="completed"
          defaultExpanded={false}
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="agent-activity-items"]'),
    ).toBeNull();
  });

  it('collapses an existing completed section when a newer turn starts', () => {
    act(() =>
      root.render(
        <AgentActivitySection
          artifactItems={[artifactItem]}
          variant="completed"
          defaultExpanded
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="agent-activity-items"]'),
    ).not.toBeNull();

    act(() =>
      root.render(
        <AgentActivitySection
          artifactItems={[artifactItem]}
          variant="completed"
          defaultExpanded={false}
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="agent-activity-items"]'),
    ).toBeNull();
  });

  it('renders nothing without tiles or runs', () => {
    act(() => root.render(<AgentActivitySection variant="completed" />));
    expect(container.innerHTML).toBe('');
  });
});
