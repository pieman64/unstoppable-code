/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import {
  DELEGATION_CAPABILITY_LIMITS,
  type DelegationCapabilitySummary,
} from '@canopy/protocol/delegation';
import { DelegatedAgentCapabilities } from '../DelegatedAgentCapabilities';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const capabilitySummary: DelegationCapabilitySummary = {
  inherit: true,
  discovery: true,
  items: [
    { kind: 'skill', name: 'code-review', source: 'inherited' },
    { kind: 'plugin', name: 'api-guidelines', source: 'inherited' },
    { kind: 'mcp', name: 'github', source: 'explicit' },
    { kind: 'mcp', name: 'filesystem', source: 'loaded' },
  ],
  skipped: [
    { kind: 'plugin', name: 'legacy-plugin', reason: 'unsupported_hooks' },
    { kind: 'mcp', name: 'missing-server', reason: 'missing_selection' },
  ],
};

interface MountedCapabilities {
  container: HTMLDivElement;
  unmount: () => void;
}

function mountCapabilities(
  summary: DelegationCapabilitySummary,
): MountedCapabilities {
  const container = document.createElement('div');
  const root = createRoot(container);
  act((): void => {
    root.render(
      <dl>
        <DelegatedAgentCapabilities summary={summary} />
      </dl>,
    );
  });
  return {
    container,
    unmount: (): void => {
      act((): void => root.unmount());
    },
  };
}

it('memoizes the delegated-agent capabilities row', (): void => {
  expect(DelegatedAgentCapabilities).toHaveProperty(
    '$$typeof',
    Symbol.for('react.memo'),
  );
});

it('renders the capabilities row inside a definition list', (): void => {
  const html = renderToString(
    <dl>
      <DelegatedAgentCapabilities summary={capabilitySummary} />
    </dl>,
  );
  expect(html).toMatch(/<dt[^>]*>Capabilities<\/dt>/);
  expect(html).toMatch(/<dd[^>]*data-testid="delegated-agent-capabilities"/);
});

it('shows collapsed counts and toggles the capabilities details', (): void => {
  const { container, unmount } = mountCapabilities(capabilitySummary);
  const toggle = container.querySelector<HTMLButtonElement>(
    '[data-testid="delegated-agent-capabilities-toggle"]',
  );

  expect(container.textContent).toContain(
    'Inherited 2 · Assigned 1 · Loaded 1 · 2 skipped',
  );
  expect(
    container.querySelectorAll('[data-testid^="delegated-agent-capability-"]'),
  ).toHaveLength(0);
  expect(toggle).not.toBeNull();
  expect(toggle?.textContent).toBe('Show');
  expect(toggle?.getAttribute('aria-label')).toBe('Show capabilities');
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  expect(toggle?.getAttribute('aria-controls')).not.toBeNull();

  act((): void => {
    toggle?.click();
  });

  expect(toggle?.getAttribute('aria-label')).toBe('Hide capabilities');
  expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  expect(toggle?.textContent).toBe('Hide');
  const controlsId = toggle?.getAttribute('aria-controls') ?? '';
  expect(
    container.querySelector(`[id="${controlsId}"]`)?.textContent,
  ).toContain('Inherited');
  unmount();
});

it('shows ordered capability groups, skipped reasons, and omitted entries', (): void => {
  const summary: DelegationCapabilitySummary = {
    ...capabilitySummary,
    items: [
      ...capabilitySummary.items,
      { kind: 'skill', name: 'additional-skill', source: 'explicit' },
    ],
    omittedItems: 3,
    omittedSkipped: 4,
  };
  const { container, unmount } = mountCapabilities(summary);
  const toggle = container.querySelector<HTMLButtonElement>(
    '[data-testid="delegated-agent-capabilities-toggle"]',
  );

  act((): void => {
    toggle?.click();
  });

  expect(
    container.querySelector(
      '[data-testid="delegated-agent-capability-inherited"]',
    ),
  ).not.toBeNull();
  const assigned = container.querySelector(
    '[data-testid="delegated-agent-capability-explicit"]',
  );
  expect(assigned).not.toBeNull();
  expect(assigned?.textContent).toContain('Assigned');
  expect(assigned?.textContent).toContain('github · MCP server');
  expect(
    container.querySelector(
      '[data-testid="delegated-agent-capability-loaded"]',
    ),
  ).not.toBeNull();
  expect(container.textContent).toContain('code-review · skill');
  expect(container.textContent).toContain('filesystem · MCP server');
  expect(
    container.querySelector('[data-testid="delegated-agent-capability-agent"]'),
  ).toBeNull();
  expect(
    Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid^="delegated-agent-capability-"]',
      ),
      (group): string | null => group.getAttribute('data-testid'),
    ),
  ).toEqual([
    'delegated-agent-capability-inherited',
    'delegated-agent-capability-explicit',
    'delegated-agent-capability-loaded',
    'delegated-agent-capability-skipped',
  ]);

  const skipped = container.querySelector(
    '[data-testid="delegated-agent-capability-skipped"]',
  );
  expect(skipped).not.toBeNull();
  expect(skipped?.textContent).toContain(
    "Uses hooks, which delegated tasks can't run",
  );
  expect(skipped?.textContent).toContain('Not installed or turned off');
  expect(container.textContent).toContain('and 3 more');
  expect(skipped?.textContent).toContain('and 4 more');
  unmount();
});

it('renders untrusted capability names as literal text', (): void => {
  const summary: DelegationCapabilitySummary = {
    ...capabilitySummary,
    items: [
      ...capabilitySummary.items,
      { kind: 'skill', name: '<a href="x">evil</a>', source: 'explicit' },
    ],
  };
  const { container, unmount } = mountCapabilities(summary);
  const toggle = container.querySelector<HTMLButtonElement>(
    '[data-testid="delegated-agent-capabilities-toggle"]',
  );

  act((): void => {
    toggle?.click();
  });

  expect(container.textContent).toContain('<a href="x">evil</a>');
  expect(container.querySelector('a')).toBeNull();
  unmount();
});

it('bounds capability items and displayed names defensively', (): void => {
  const oversizedName = 'x'.repeat(
    DELEGATION_CAPABILITY_LIMITS.nameCharacters + 20,
  );
  const items = Array.from(
    { length: DELEGATION_CAPABILITY_LIMITS.summaryItems + 1 },
    (_, index) => ({
      kind: 'skill' as const,
      name: index === 0 ? oversizedName : `capability-${index}`,
      source: 'inherited' as const,
    }),
  );
  const summary: DelegationCapabilitySummary = {
    ...capabilitySummary,
    items,
  };
  const { container, unmount } = mountCapabilities(summary);
  const toggle = container.querySelector<HTMLButtonElement>(
    '[data-testid="delegated-agent-capabilities-toggle"]',
  );

  act((): void => {
    toggle?.click();
  });

  const inherited = container.querySelector(
    '[data-testid="delegated-agent-capability-inherited"]',
  );
  expect(inherited?.querySelectorAll('li')).toHaveLength(
    DELEGATION_CAPABILITY_LIMITS.summaryItems,
  );
  expect(inherited?.textContent).toContain(
    'x'.repeat(DELEGATION_CAPABILITY_LIMITS.nameCharacters),
  );
  expect(inherited?.textContent).not.toContain(
    'x'.repeat(DELEGATION_CAPABILITY_LIMITS.nameCharacters + 1),
  );
  expect(inherited?.textContent).toContain('capability-127');
  expect(inherited?.textContent).not.toContain('capability-128');
  unmount();
});

it('keeps the omitted count when every item was trimmed to fit', (): void => {
  const summary: DelegationCapabilitySummary = {
    ...capabilitySummary,
    items: [],
    skipped: [],
    omittedItems: 5,
  };
  const { container, unmount } = mountCapabilities(summary);
  act((): void => {
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="delegated-agent-capabilities-toggle"]',
      )
      ?.click();
  });
  expect(
    container.querySelector(
      '[data-testid="delegated-agent-capability-omitted"]',
    )?.textContent,
  ).toContain('and 5 more');
  unmount();
});
