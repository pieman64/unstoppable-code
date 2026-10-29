/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCapabilities } from '@canopy/app-core';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let mockCaps: Partial<CanopyCapabilities> = { skillSuggestions: true };
jest.mock('@canopy/app-state', () => {
  const real: Record<string, unknown> = jest.requireActual('@canopy/app-state');
  return {
    __esModule: true,
    ...real,
    useCapabilities: (): Partial<CanopyCapabilities> => mockCaps,
  };
});

import {
  SKILL_SUGGESTION_COPY,
  SkillSuggestionBanner,
} from '../SkillSuggestionBanner';
import {
  SkillSuggestionsList,
  type SkillSuggestionListItem,
} from '../SkillSuggestionsList';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mockCaps = { skillSuggestions: true };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function byTestId(id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function click(element: HTMLElement | null): void {
  if (!element) throw new Error('missing element');
  act(() => element.click());
}

const PROMPT: SkillSuggestionListItem = {
  id: 'sug-1',
  kind: 'prompt',
  title: 'Summarize PR review comments',
  summary: 'Collects open review threads and drafts replies.',
  occurrenceCount: 4,
  chainSkills: [],
  examples: ['summarize the review comments on <url>'],
  ownerLabel: 'Personal',
  lastSeenAt: Date.now() - 60_000,
};

const CHAIN: SkillSuggestionListItem = {
  id: 'sug-2',
  kind: 'chain',
  title: 'Review and ship',
  summary: 'Reviews, pushes and opens a PR.',
  occurrenceCount: 3,
  chainSkills: ['review', 'push-branch', 'open-pr'],
  examples: [],
  ownerLabel: 'Acme',
  lastSeenAt: Date.now() - 3_600_000,
};

describe('SkillSuggestionBanner (CAN-385)', () => {
  it('renders the prompt copy and routes both actions', () => {
    const onCreate = jest.fn();
    const onDismiss = jest.fn();
    act(() =>
      root.render(
        <SkillSuggestionBanner
          count={4}
          kind="prompt"
          onCreate={onCreate}
          onDismiss={onDismiss}
        />,
      ),
    );
    const banner = byTestId('skill-suggestion-banner');
    expect(banner?.textContent).toContain(SKILL_SUGGESTION_COPY.title(4));
    expect(banner?.textContent).toContain(SKILL_SUGGESTION_COPY.promptMessage);
    expect(
      byTestId('skill-suggestion-banner-dismiss')?.getAttribute('aria-label'),
    ).toBe('Dismiss skill suggestion');
    click(byTestId('skill-suggestion-banner-create'));
    click(byTestId('skill-suggestion-banner-dismiss'));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('counts the skills in a chain', () => {
    act(() =>
      root.render(
        <SkillSuggestionBanner
          count={3}
          kind="chain"
          chainSkills={['review', 'push-branch']}
          onCreate={jest.fn()}
          onDismiss={jest.fn()}
        />,
      ),
    );
    expect(byTestId('skill-suggestion-banner')?.textContent).toContain(
      'Turn these 2 skills into one skill.',
    );
  });

  it('disables both actions while busy', () => {
    act(() =>
      root.render(
        <SkillSuggestionBanner
          count={4}
          kind="prompt"
          busy
          onCreate={jest.fn()}
          onDismiss={jest.fn()}
        />,
      ),
    );
    expect(
      byTestId('skill-suggestion-banner-create')?.hasAttribute('disabled'),
    ).toBe(true);
    expect(
      byTestId('skill-suggestion-banner-dismiss')?.hasAttribute('disabled'),
    ).toBe(true);
  });

  it('renders nothing without the capability', () => {
    mockCaps = {};
    act(() =>
      root.render(
        <SkillSuggestionBanner
          count={4}
          kind="prompt"
          onCreate={jest.fn()}
          onDismiss={jest.fn()}
        />,
      ),
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('SkillSuggestionsList (CAN-385)', () => {
  it('shows the empty state', () => {
    act(() =>
      root.render(
        <SkillSuggestionsList
          suggestions={[]}
          onCreate={jest.fn()}
          onDismiss={jest.fn()}
        />,
      ),
    );
    expect(byTestId('skill-suggestions-empty')?.textContent).toBe(
      SKILL_SUGGESTION_COPY.empty,
    );
  });

  it('renders prompt and chain rows and routes row actions by id', () => {
    const onCreate = jest.fn();
    const onDismiss = jest.fn();
    act(() =>
      root.render(
        <SkillSuggestionsList
          suggestions={[PROMPT, CHAIN]}
          onCreate={onCreate}
          onDismiss={onDismiss}
        />,
      ),
    );
    const rows = container.querySelectorAll<HTMLElement>(
      '[data-testid="skill-suggestions-row"]',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Asked 4 times');
    expect(rows[0].textContent).toContain('Personal');
    expect(rows[1].textContent).toContain('reviewpush-branchopen-pr');
    expect(rows[1].textContent).not.toContain('Asked');
    click(
      rows[1].querySelector<HTMLElement>(
        '[data-testid="skill-suggestions-row-create"]',
      ),
    );
    click(
      rows[0].querySelector<HTMLElement>(
        '[data-testid="skill-suggestions-row-dismiss"]',
      ),
    );
    expect(onCreate).toHaveBeenCalledWith('sug-2');
    expect(onDismiss).toHaveBeenCalledWith('sug-1');
  });

  it('keeps the masked title out of the dismiss button attributes', () => {
    act(() =>
      root.render(
        <SkillSuggestionsList
          suggestions={[PROMPT]}
          onCreate={jest.fn()}
          onDismiss={jest.fn()}
        />,
      ),
    );
    const dismiss = container.querySelector<HTMLElement>(
      '[data-testid="skill-suggestions-row-dismiss"]',
    );
    expect(dismiss?.getAttribute('aria-label')).toBeNull();
    // The accessible name still reads "Dismiss <title>" from the elements.
    const name = (dismiss?.getAttribute('aria-labelledby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join(' ');
    expect(name).toBe(`Dismiss ${PROMPT.title}`);
  });

  it('keeps examples behind the expander in a replay-blocked block', () => {
    act(() =>
      root.render(
        <SkillSuggestionsList
          suggestions={[PROMPT, CHAIN]}
          onCreate={jest.fn()}
          onDismiss={jest.fn()}
        />,
      ),
    );
    expect(byTestId('skill-suggestions-row-examples')).toBeNull();
    expect(
      container.querySelectorAll(
        '[data-testid="skill-suggestions-row-examples-toggle"]',
      ),
    ).toHaveLength(1);
    click(byTestId('skill-suggestions-row-examples-toggle'));
    const examples = byTestId('skill-suggestions-row-examples');
    expect(examples?.classList.contains('ph-no-capture')).toBe(true);
    expect(examples?.textContent).toContain('summarize the review comments');
  });

  it('disables only the busy row', () => {
    act(() =>
      root.render(
        <SkillSuggestionsList
          suggestions={[PROMPT, CHAIN]}
          busyIds={new Set(['sug-1'])}
          onCreate={jest.fn()}
          onDismiss={jest.fn()}
        />,
      ),
    );
    const creates = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="skill-suggestions-row-create"]',
    );
    expect(creates[0].disabled).toBe(true);
    expect(creates[1].disabled).toBe(false);
  });

  it('renders nothing without the capability', () => {
    mockCaps = { skillSuggestions: false };
    act(() =>
      root.render(
        <SkillSuggestionsList
          suggestions={[PROMPT]}
          onCreate={jest.fn()}
          onDismiss={jest.fn()}
        />,
      ),
    );
    expect(container.innerHTML).toBe('');
  });
});
