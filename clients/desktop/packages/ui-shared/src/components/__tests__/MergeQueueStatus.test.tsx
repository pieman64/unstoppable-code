/** @jest-environment jsdom */

import { act, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  MergeQueueStatus,
  type MergeQueuePopoverEntry,
  type MergeQueuePopoverSection,
} from '../MergeQueueStatus';
import type { MergeQueueLabel } from '../../lib/merge-queue-display';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-10-16T13:30:00.000Z');

function entry(
  position: number,
  overrides: Partial<MergeQueuePopoverEntry> = {},
): MergeQueuePopoverEntry {
  return {
    position,
    number: 5500 + position,
    title: `Change ${position}`,
    url: `https://github.com/acme/api/pull/${5500 + position}`,
    author: 'mara-k',
    phase: position <= 2 ? 'awaiting_checks' : 'queued',
    remainingSeconds: position * 246,
    isCurrent: false,
    ...overrides,
  };
}

function nine(currentPosition: number): MergeQueuePopoverEntry[] {
  return Array.from({ length: 9 }, (_, index) =>
    entry(index + 1, { isCurrent: index + 1 === currentPosition }),
  );
}

function section(
  overrides: Partial<MergeQueuePopoverSection> = {},
): MergeQueuePopoverSection {
  return {
    key: 'repo-1',
    repoName: 'api',
    baseBranch: 'develop',
    phase: 'queued',
    position: 3,
    remainingSeconds: 19 * 60,
    list: { status: 'ready', totalCount: 9, buildCount: 2, entries: nine(3) },
    queueUrl: 'https://github.com/acme/api/queue/develop',
    ...overrides,
  };
}

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
  document.body.innerHTML = '';
});

function Harness({
  label,
  sections,
  initiallyOpen = false,
}: {
  label: MergeQueueLabel;
  sections: MergeQueuePopoverSection[];
  initiallyOpen?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <MergeQueueStatus
      label={label}
      sections={sections}
      open={open}
      onOpenChange={setOpen}
      now={NOW}
      updatedAt={NOW - 20_000}
    />
  );
}

function render(element: JSX.Element): void {
  act(() => root.render(element));
}

function byTestId(testId: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function rows(): string[] {
  return Array.from(
    document.body.querySelectorAll('[data-testid="merge-queue-popover-row"]'),
  ).map((row) => row.getAttribute('data-pr-number') ?? '');
}

describe('MergeQueueStatus label', () => {
  it('reads a waiting pull request with position, estimate and a chevron', () => {
    render(
      <Harness
        label={{ kind: 'queued', position: 3, remainingSeconds: 19 * 60 }}
        sections={[section()]}
      />,
    );
    const trigger = byTestId('merge-queue-status');
    expect(trigger?.textContent).toBe('Queued·#3·~19 min');
    expect(trigger?.getAttribute('aria-label')).toBe(
      'Queued in the merge queue, position 3, about 19 min',
    );
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger?.querySelector('svg:last-child')).not.toBeNull();
  });

  it('leads a waiting pull request with the merge-queue Octicon', () => {
    render(
      <Harness
        label={{ kind: 'queued', position: 3, remainingSeconds: 19 * 60 }}
        sections={[section()]}
      />,
    );
    expect(
      byTestId('merge-queue-status')
        ?.querySelector('svg')
        ?.getAttribute('data-glyph'),
    ).toBe('git-merge-queue');
  });

  it('drops the estimate when GitHub gives none', () => {
    render(
      <Harness
        label={{ kind: 'queued', position: 2, remainingSeconds: null }}
        sections={[section({ remainingSeconds: null })]}
      />,
    );
    expect(byTestId('merge-queue-status')?.textContent).toBe('Queued·#2');
    expect(byTestId('merge-queue-status-eta')).toBeNull();
  });

  it('reads several queued pull requests as a count', () => {
    render(
      <Harness
        label={{ kind: 'several', count: 2, remainingSeconds: 44 * 60 }}
        sections={[section(), section({ key: 'repo-2', repoName: 'web' })]}
      />,
    );
    expect(byTestId('merge-queue-status')?.textContent).toBe(
      '2 queued·~44 min',
    );
  });
});

describe('MergeQueueStatus popover', () => {
  it('opens on click with the estimate, the phase, and the collapsed list', () => {
    render(
      <Harness
        label={{ kind: 'queued', position: 3, remainingSeconds: 19 * 60 }}
        sections={[section()]}
      />,
    );
    const trigger = byTestId('merge-queue-status');
    act(() => trigger?.click());
    const popover = byTestId('merge-queue-status-popover');
    expect(popover?.getAttribute('role')).toBe('dialog');
    expect(popover?.getAttribute('aria-label')).toBe('Merge queue');
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(trigger?.getAttribute('aria-controls')).toBe(popover?.id);
    expect(popover?.textContent).toContain('9 pull requests');
    expect(byTestId('merge-queue-popover-eta')?.textContent).toBe(
      'About 19 min',
    );
    expect(popover?.textContent).toContain('2 at a time');
    expect(popover?.querySelector('[aria-current="step"]')?.textContent).toBe(
      'Queued, #3',
    );
    // Testing rows, then waiting rows through two past this pull request.
    expect(rows()).toEqual(['5501', '5502', '5503', '5504', '5505']);
    const current = popover?.querySelector('[aria-current="true"]');
    expect(current?.textContent).toContain('This pull request');
    expect(current?.getAttribute('href')).toBe(
      'https://github.com/acme/api/pull/5503',
    );
    expect(current?.getAttribute('target')).toBe('_blank');
    // People's logins stay out of session replays.
    expect(popover?.querySelector(`.${REPLAY_BLOCK_CLASS}`)?.textContent).toBe(
      'mara-k',
    );
    expect(byTestId('merge-queue-popover-github')?.getAttribute('href')).toBe(
      'https://github.com/acme/api/queue/develop',
    );
    expect(byTestId('merge-queue-status-updated')?.textContent).toBe(
      'Updated 20s ago',
    );

    act(() => byTestId('merge-queue-popover-show-more')?.click());
    expect(rows()).toHaveLength(9);
    expect(byTestId('merge-queue-popover-show-more')).toBeNull();
  });

  it('names the pull requests tested with this one, and the one that can push it back', () => {
    const entries = nine(2);
    render(
      <Harness
        initiallyOpen
        label={{ kind: 'testing', remainingSeconds: 11 * 60 }}
        sections={[
          section({
            phase: 'awaiting_checks',
            position: 2,
            list: { status: 'ready', totalCount: 9, buildCount: 2, entries },
          }),
        ]}
      />,
    );
    expect(byTestId('merge-queue-popover-testing-note')?.textContent).toBe(
      'Checks are running with #5501. If #5501 fails, this pull request is tested again.',
    );
  });

  it('says only who it runs with when nothing ahead can push it back', () => {
    render(
      <Harness
        initiallyOpen
        label={{ kind: 'testing', remainingSeconds: 11 * 60 }}
        sections={[
          section({
            phase: 'awaiting_checks',
            position: 1,
            list: {
              status: 'ready',
              totalCount: 9,
              buildCount: 2,
              entries: nine(1),
            },
          }),
        ]}
      />,
    );
    expect(byTestId('merge-queue-popover-testing-note')?.textContent).toBe(
      'Checks are running with #5502.',
    );
  });

  it('keeps the header while the list loads, and the GitHub link after an error', () => {
    render(
      <Harness
        initiallyOpen
        label={{ kind: 'queued', position: 3, remainingSeconds: 19 * 60 }}
        sections={[section({ list: { status: 'loading' }, queueUrl: null })]}
      />,
    );
    expect(byTestId('merge-queue-popover-eta')?.textContent).toBe(
      'About 19 min',
    );
    expect(byTestId('merge-queue-popover-loading')).not.toBeNull();

    render(
      <Harness
        initiallyOpen
        label={{ kind: 'queued', position: 3, remainingSeconds: 19 * 60 }}
        sections={[section({ list: { status: 'error' } })]}
      />,
    );
    expect(byTestId('merge-queue-popover-error')?.textContent).toBe(
      "Couldn't load the queue.",
    );
    expect(byTestId('merge-queue-popover-github')).not.toBeNull();
  });

  it('gives each repository a section and leads with when all of them land', () => {
    render(
      <Harness
        initiallyOpen
        label={{ kind: 'several', count: 2, remainingSeconds: 44 * 60 }}
        sections={[
          section({
            key: 'repo-1',
            repoName: 'agentic-core',
            baseBranch: 'main',
            phase: 'awaiting_checks',
            position: 1,
            remainingSeconds: 7 * 60,
            list: {
              status: 'ready',
              totalCount: 2,
              buildCount: 2,
              entries: [entry(1, { isCurrent: true }), entry(2)],
            },
          }),
          section({
            key: 'repo-2',
            repoName: 'canopy',
            remainingSeconds: 44 * 60,
          }),
        ]}
      />,
    );
    const popover = byTestId('merge-queue-status-popover');
    expect(popover?.textContent).toContain('2 pull requests in merge queues');
    expect(byTestId('merge-queue-popover-eta')?.textContent).toBe(
      'All merged in about 44 min',
    );
    expect(popover?.textContent).toContain(
      'when the canopy pull request lands',
    );
    const sections = popover?.querySelectorAll(
      '[data-testid="merge-queue-popover-section"]',
    );
    expect(sections).toHaveLength(2);
    expect(sections?.[0]?.getAttribute('aria-label')).toBe(
      'agentic-core merge queue',
    );
    expect(sections?.[1]?.textContent).toContain('Queued, #3');
    expect(
      sections?.[1]?.querySelector(
        'a[aria-label="Open the canopy queue on GitHub"]',
      ),
    ).not.toBeNull();
  });

  it('closes on Escape and returns focus to the label', () => {
    render(
      <Harness
        label={{ kind: 'queued', position: 3, remainingSeconds: 19 * 60 }}
        sections={[section()]}
      />,
    );
    const trigger = byTestId('merge-queue-status');
    act(() => trigger?.click());
    expect(byTestId('merge-queue-status-popover')).not.toBeNull();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(byTestId('merge-queue-status-popover')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
