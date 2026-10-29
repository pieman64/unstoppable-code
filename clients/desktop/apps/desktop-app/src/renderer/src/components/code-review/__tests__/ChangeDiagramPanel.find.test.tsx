/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSurfaceFindStore } from '@canopy/ui-app/find';

import type { CodeReviewDiagramsPanelProps } from '../CodeReviewDiagramsPanel';
import { ChangeDiagramPanel } from '../ChangeDiagramPanel';

const mockDiagramsProps: CodeReviewDiagramsPanelProps[] = [];

jest.mock('../useWorktreeReview', () => ({
  useWorktreeReview: (): Record<string, never> => ({}),
}));
jest.mock('../useReviewComments', () => ({
  useReviewComments: (): Record<string, unknown> => ({
    threads: [],
    stagedCount: 0,
  }),
}));
jest.mock('../CodeReviewDiagramsPanel', () => ({
  CodeReviewDiagramsPanel: (
    props: CodeReviewDiagramsPanelProps,
  ): JSX.Element => {
    mockDiagramsProps.push(props);
    return <div data-testid="code-review-diagrams-panel" />;
  },
}));
jest.mock('../../chat/FileCommentsDrawer', () => ({
  FileCommentsDrawer: (): null => null,
}));
jest.mock('../../chat/submitWorkspaceComments', () => ({
  submitWorkspaceComments: jest.fn(),
}));
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => {},
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const SCOPE = 'project-1/worktree-1';

let host: HTMLDivElement;
let root: Root;

function render(active: boolean): void {
  act(() => {
    root.render(
      <ChangeDiagramPanel
        projectId="project-1"
        worktreeId="worktree-1"
        active={active}
      />,
    );
  });
}

function registered(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(useSurfaceFindStore.getState().controllers).map(
      ([key, entry]) => [key, entry.title],
    ),
  );
}

beforeEach(() => {
  mockDiagramsProps.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setTestEarlyAccessFeatures({ enabled: false });
});

describe('ChangeDiagramPanel find', () => {
  it('registers its diagram with the find bar only while active', () => {
    render(true);
    const panel = host.querySelector<HTMLElement>(
      '[data-testid="change-diagram-panel"]',
    );
    expect(panel?.dataset.findSurface).toBe('diagram');
    expect(panel?.dataset.findScope).toBe(SCOPE);
    expect(panel?.tabIndex).toBe(-1);
    expect(registered()).toEqual({ [`diagram:${SCOPE}`]: 'Change diagram' });

    render(false);
    expect(panel?.dataset.findSurface).toBeUndefined();
    expect(registered()).toEqual({});
  });

  it('titles its find surface as its tab is titled under early access', () => {
    act(() => {
      setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    });
    render(true);
    expect(registered()).toEqual({ [`diagram:${SCOPE}`]: 'Change diagram' });
  });

  it('passes a stable search refresh to the diagrams panel', () => {
    render(true);
    render(true);
    const refreshes = mockDiagramsProps.map(
      (props) => props.onSearchContextChange,
    );
    expect(refreshes.length).toBeGreaterThan(1);
    expect(refreshes[0]).toEqual(expect.any(Function));
    expect(new Set(refreshes).size).toBe(1);
  });
});
