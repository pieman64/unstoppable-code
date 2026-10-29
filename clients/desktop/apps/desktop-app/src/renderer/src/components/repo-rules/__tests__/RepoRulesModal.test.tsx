/**
 * @jest-environment jsdom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RepoRulesModal } from '../RepoRulesModal';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const reviewProps: Array<{
  workspaces: Array<{ id: string; name: string }>;
  initialWorkspaceId?: string;
}> = [];
jest.mock('@canopy/ui-app/repo-rules', () => ({
  RepoRulesReview: (props: {
    workspaces: Array<{ id: string; name: string }>;
    initialWorkspaceId?: string;
  }): null => {
    reviewProps.push(props);
    return null;
  },
}));
jest.mock('@/components/shared/DialogModal', () => ({
  DialogModal: ({ children }: { children: ReactNode }): ReactNode => children,
}));
jest.mock('@/components/home/onboarding-suggestions/completionWriter', () => ({
  completeOnboardingSuggestionDurably: jest.fn(),
}));
const projects = [
  { id: 'code-a', name: 'Alpha', type: 'single-repo' },
  { id: 'code-b', name: 'Beta', type: 'single-repo' },
  { id: 'code-c', name: 'Gamma', type: 'multi-repo' },
  { id: 'notes', name: 'Notes', type: 'cowork' },
];
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: <T,>(
    selector: (state: { projects: typeof projects }) => T,
  ): T => selector({ projects }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  reviewProps.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function lastWorkspaceIds(): string[] {
  const props = reviewProps.at(-1);
  if (!props) throw new Error('RepoRulesReview was not rendered');
  return props.workspaces.map((workspace) => workspace.id);
}

it('offers every Code project when the entry point names none', () => {
  act(() => {
    root.render(
      <RepoRulesModal target={{ source: 'settings' }} onClose={jest.fn()} />,
    );
  });
  expect(lastWorkspaceIds()).toEqual(['code-a', 'code-b', 'code-c']);
});

it('narrows the chooser to the projects an offer found rules in', () => {
  act(() => {
    root.render(
      <RepoRulesModal
        target={{
          source: 'first-run-import',
          workspaceIds: ['code-c', 'code-a'],
        }}
        onClose={jest.fn()}
      />,
    );
  });
  expect(lastWorkspaceIds()).toEqual(['code-a', 'code-c']);
  expect(reviewProps.at(-1)?.initialWorkspaceId).toBeUndefined();
});

it('ignores the narrowed list when the entry point names a project', () => {
  act(() => {
    root.render(
      <RepoRulesModal
        target={{
          source: 'add-project',
          workspaceId: 'code-b',
          workspaceIds: ['code-a'],
        }}
        onClose={jest.fn()}
      />,
    );
  });
  expect(reviewProps.at(-1)?.initialWorkspaceId).toBe('code-b');
  expect(lastWorkspaceIds()).toEqual(['code-a', 'code-b', 'code-c']);
});

it('offers every Code project when the narrowed projects were removed', () => {
  act(() => {
    root.render(
      <RepoRulesModal
        target={{ source: 'first-run-import', workspaceIds: ['removed'] }}
        onClose={jest.fn()}
      />,
    );
  });
  // An empty chooser would say to add a code project, which is wrong here.
  expect(lastWorkspaceIds()).toEqual(['code-a', 'code-b', 'code-c']);
});
