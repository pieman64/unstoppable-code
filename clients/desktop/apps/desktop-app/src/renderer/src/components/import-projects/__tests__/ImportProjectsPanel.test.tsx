/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ExternalProjectCandidate,
  ExternalProjectDiscoverResponse,
  ExternalProjectImportItemResult,
  ExternalProjectImportRequest,
  ExternalProjectImportResponse,
} from '@canopy/desktop-shared/types';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import type { WorkspaceContextState } from '@canopy/protocol/workspace-context';

const loadProjects = jest.fn(() => Promise.resolve());
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: {
    getState: (): { loadProjects: () => Promise<void> } => ({ loadProjects }),
  },
}));
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: {
    getState: (): { navigate: () => void } => ({ navigate: jest.fn() }),
  },
}));
const navigateAfterRepositoryWorkspaceCreated = jest.fn();
jest.mock('@/lib/postWorkspaceCreateNavigation', () => ({
  navigateAfterRepositoryWorkspaceCreated: (workspaceId: string): void => {
    navigateAfterRepositoryWorkspaceCreated(workspaceId);
  },
}));
const completeOnboardingSuggestionDurably = jest.fn();
jest.mock('@/components/home/onboarding-suggestions/completionWriter', () => ({
  completeOnboardingSuggestionDurably: (...args: unknown[]): void => {
    completeOnboardingSuggestionDurably(...args);
  },
}));

interface CursorRulesOfferProps {
  workspaces: ReadonlyArray<{ workspaceId: string; displayName: string }>;
  onReview: (workspaceId: string) => void;
}
const cursorRulesOfferProps: CursorRulesOfferProps[] = [];
// The offer reads presence through the client provider; it has its own tests.
jest.mock('@/components/repo-rules/ImportedCursorRulesOffer', () => ({
  ImportedCursorRulesOffer: (props: CursorRulesOfferProps): null => {
    cursorRulesOfferProps.push(props);
    return null;
  },
}));
const openRepoRulesModal = jest.fn();
jest.mock('@/stores/repoRulesModalStore', () => ({
  openRepoRulesModal: (...args: unknown[]): void => {
    openRepoRulesModal(...args);
  },
}));

import {
  ImportProjectsPanel,
  type ImportProjectsPhase,
} from '../ImportProjectsPanel';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORGANIZATION_CONTEXT: WorkspaceContextState = {
  context: { kind: 'organization', organizationId: ORG_A },
  revision: 1,
  organizations: [{ id: ORG_A, name: 'Org A', role: 'MEMBER' }],
};

interface MockApi {
  externalProjects: {
    discover: jest.Mock<Promise<ExternalProjectDiscoverResponse>, [unknown]>;
    importProjects: jest.Mock<
      Promise<ExternalProjectImportResponse>,
      [ExternalProjectImportRequest]
    >;
    pickFolder: jest.Mock<Promise<string | null>, []>;
    onImportProgress: jest.Mock<() => void, [unknown]>;
  };
  loadPreferences: jest.Mock<Promise<Record<string, unknown>>, []>;
  savePreferences: jest.Mock<Promise<void>, [unknown]>;
}

function candidate(
  id: string,
  overrides: Partial<ExternalProjectCandidate> = {},
): ExternalProjectCandidate {
  return {
    id,
    providers: ['claude'],
    surfaces: ['claude-code'],
    displayName: id,
    rootPath: `/Users/me/${id}`,
    kind: 'git',
    status: 'available',
    linkedWorktreePaths: [],
    lastActivityAt: null,
    sessions: [],
    sessionCount: 0,
    importableSessionCount: 0,
    ...overrides,
  };
}

function result(
  candidateId: string,
  overrides: Partial<ExternalProjectImportItemResult> = {},
): ExternalProjectImportItemResult {
  return {
    candidateId,
    displayName: candidateId,
    rootPath: `/Users/me/${candidateId}`,
    status: 'imported',
    chatsImported: 0,
    chatsReadOnly: 0,
    chatsSkipped: 0,
    retryable: false,
    ...overrides,
  };
}

function scan(
  candidates: ExternalProjectCandidate[],
  detectedPlugins: ExternalProjectDiscoverResponse['detectedPlugins'] = [],
  providersDetected: ExternalProjectDiscoverResponse['providersDetected'] = {
    claude: true,
    codex: false,
  },
): ExternalProjectDiscoverResponse {
  return {
    scanId: 'scan-1',
    scannedAt: '2026-09-10T00:00:00.000Z',
    candidates,
    diagnostics: [],
    providersDetected,
    detectedPlugins,
  };
}

function createApi(discovered: ExternalProjectDiscoverResponse): MockApi {
  return {
    externalProjects: {
      discover: jest.fn(() => Promise.resolve(discovered)),
      importProjects: jest.fn(() => Promise.resolve({ results: [] })),
      pickFolder: jest.fn(() => Promise.resolve(null)),
      onImportProgress: jest.fn(() => jest.fn()),
    },
    loadPreferences: jest.fn(() => Promise.resolve({})),
    savePreferences: jest.fn(() => Promise.resolve()),
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(container: HTMLElement, testId: string): void {
  const node = container.querySelector(`[data-testid="${testId}"]`);
  if (!(node instanceof HTMLElement)) {
    throw new Error(`missing ${testId}`);
  }
  act(() => {
    node.click();
  });
}

describe('ImportProjectsPanel', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalApiDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
    originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    loadProjects.mockClear();
    navigateAfterRepositoryWorkspaceCreated.mockClear();
    completeOnboardingSuggestionDurably.mockClear();
    cursorRulesOfferProps.length = 0;
    openRepoRulesModal.mockClear();
    useFeatureFlagsStore.setState({
      snapshot: {
        ...getDefaultFeatureFlagSnapshot(),
        values: {
          [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
        },
      },
    });
    useWorkspaceContextStore.setState({
      hydrated: true,
      accountEpoch: 1,
      state: {
        context: { kind: 'personal' },
        revision: 1,
        organizations: ORGANIZATION_CONTEXT.organizations,
      },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  async function mount(api: MockApi): Promise<void> {
    Object.defineProperty(window, 'api', { configurable: true, value: api });
    await act(async () => {
      root.render(
        <ImportProjectsPanel onSkip={jest.fn()} onDone={jest.fn()} />,
      );
      await Promise.resolve();
    });
    await flush();
  }

  it('keeps earlier results when a retry only reports the retried projects', async () => {
    const api = createApi(scan([candidate('alpha'), candidate('beta')]));
    api.externalProjects.importProjects
      .mockResolvedValueOnce({
        results: [
          result('alpha'),
          result('beta', {
            status: 'failed',
            message: 'Disk full',
            retryable: true,
          }),
        ],
      })
      .mockResolvedValueOnce({ results: [result('beta')] });
    await mount(api);
    expect(
      container.querySelector('[data-testid="import-projects-choose"]'),
    ).not.toBeNull();

    click(container, 'import-projects-submit');
    await flush();
    expect(
      container.querySelector('[data-testid="import-projects-result-alpha"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="import-projects-result-beta"]')
        ?.textContent,
    ).toContain('Failed');

    click(container, 'import-projects-retry');
    await flush();
    // Only the failed project was retried...
    expect(api.externalProjects.importProjects).toHaveBeenLastCalledWith({
      scanId: 'scan-1',
      selections: [{ candidateId: 'beta', importChats: false }],
    });
    // ...and the earlier success is still listed next to the fresh outcome.
    expect(
      container.querySelector('[data-testid="import-projects-result-alpha"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="import-projects-result-beta"]')
        ?.textContent,
    ).toContain('Added');
    expect(
      container.querySelector('[data-testid="import-projects-retry"]'),
    ).toBeNull();
    expect(completeOnboardingSuggestionDurably).toHaveBeenCalledWith(
      'import-projects',
      'imported',
    );
  });

  // CAN-2053: the Cursor rules offer targets each just-imported workspace by
  // its explicit id, and opening it closes the import flow first.
  it('offers Cursor rules review only for just-imported workspaces', async () => {
    const onDone = jest.fn();
    const api = createApi(scan([candidate('alpha'), candidate('beta')]));
    api.externalProjects.importProjects.mockResolvedValueOnce({
      results: [
        result('alpha', { workspaceId: 'imported-alpha' }),
        result('beta', { status: 'failed', retryable: true }),
      ],
    });
    Object.defineProperty(window, 'api', { configurable: true, value: api });
    await act(async () => {
      root.render(<ImportProjectsPanel onSkip={jest.fn()} onDone={onDone} />);
      await Promise.resolve();
    });
    await flush();

    click(container, 'import-projects-submit');
    await flush();

    const props = cursorRulesOfferProps.at(-1);
    expect(props?.workspaces).toEqual([
      { workspaceId: 'imported-alpha', displayName: 'alpha' },
    ]);
    act(() => props?.onReview('imported-alpha'));
    expect(onDone).toHaveBeenCalled();
    expect(openRepoRulesModal).toHaveBeenCalledWith({
      source: 'import-results',
      workspaceId: 'imported-alpha',
    });
  });

  it('switches an unchanged organization submission to Personal before selecting the imported workspace', async () => {
    const setContext = jest.fn(() =>
      Promise.resolve({
        ...ORGANIZATION_CONTEXT,
        context: { kind: 'personal' as const },
        revision: 2,
      }),
    );
    useWorkspaceContextStore.setState({
      hydrated: true,
      accountEpoch: 4,
      state: ORGANIZATION_CONTEXT,
      setContext,
    });
    const api = createApi(scan([candidate('alpha')]));
    api.externalProjects.importProjects.mockResolvedValueOnce({
      results: [result('alpha', { workspaceId: 'imported-alpha' })],
    });
    await mount(api);

    click(container, 'import-projects-submit');
    await flush();

    expect(setContext).toHaveBeenCalledWith({ kind: 'personal' });
    expect(navigateAfterRepositoryWorkspaceCreated).toHaveBeenCalledWith(
      'imported-alpha',
    );
    expect(setContext.mock.invocationCallOrder[0]).toBeLessThan(
      navigateAfterRepositoryWorkspaceCreated.mock.invocationCallOrder[0],
    );
  });

  it('keeps successful import results visible when the Personal context switch fails', async () => {
    const setContext = jest.fn(() =>
      Promise.reject(new Error('switch failed')),
    );
    useWorkspaceContextStore.setState({
      hydrated: true,
      accountEpoch: 4,
      state: ORGANIZATION_CONTEXT,
      setContext,
    });
    const api = createApi(scan([candidate('alpha')]));
    api.externalProjects.importProjects.mockResolvedValueOnce({
      results: [result('alpha', { workspaceId: 'imported-alpha' })],
    });
    await mount(api);

    click(container, 'import-projects-submit');
    await flush();

    expect(
      container.querySelector('[data-testid="import-projects-result-alpha"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="import-projects-follow-through-error"]',
      )?.textContent,
    ).toContain('switch failed');
    expect(
      container.querySelector('[data-testid="import-projects-error"]'),
    ).toBeNull();
  });

  it('labels imports as Personal while an organization context is selected', async () => {
    useWorkspaceContextStore.setState({ state: ORGANIZATION_CONTEXT });
    await mount(createApi(scan([candidate('alpha')])));

    expect(
      container.querySelector('[data-testid="import-projects-personal-notice"]')
        ?.textContent,
    ).toContain('Imported projects are Personal');
  });

  it('does not hijack navigation when the selected context changes during import', async () => {
    let resolveImport!: (response: ExternalProjectImportResponse) => void;
    const importResponse = new Promise<ExternalProjectImportResponse>(
      (resolve) => {
        resolveImport = resolve;
      },
    );
    const setContext = jest.fn();
    useWorkspaceContextStore.setState({
      hydrated: true,
      accountEpoch: 4,
      state: ORGANIZATION_CONTEXT,
      setContext,
    });
    const api = createApi(scan([candidate('alpha')]));
    api.externalProjects.importProjects.mockReturnValueOnce(importResponse);
    await mount(api);

    click(container, 'import-projects-submit');
    act(() => {
      useWorkspaceContextStore.setState({
        state: {
          context: { kind: 'personal' },
          revision: 2,
          organizations: ORGANIZATION_CONTEXT.organizations,
        },
      });
    });
    resolveImport({
      results: [result('alpha', { workspaceId: 'imported-alpha' })],
    });
    await flush();

    expect(setContext).not.toHaveBeenCalled();
    expect(navigateAfterRepositoryWorkspaceCreated).not.toHaveBeenCalled();
  });

  it('lists recent chat titles on a project row so similar projects can be told apart', async () => {
    const sessionsOf = (
      titles: Array<string | null>,
    ): ExternalProjectCandidate['sessions'] =>
      titles.map((title, index) => ({
        id: `s${index}`,
        provider: 'claude',
        title,
        startedAt: null,
        lastActivityAt: null,
        continuable: true,
        sizeBytes: 1,
      }));
    const api = createApi(
      scan([
        candidate('alpha', {
          sessions: sessionsOf([
            'Car wash transportation',
            'Meeting notes',
            null,
            'Meeting notes',
            'Trip planning',
            'Budget',
          ]),
          sessionCount: 6,
          importableSessionCount: 6,
        }),
        candidate('beta'),
      ]),
    );
    await mount(api);
    const titles = container.querySelector(
      '[data-testid="import-projects-row-chat-titles-alpha"]',
    );
    // Newest first, de-duplicated, untitled chats skipped, the rest counted.
    expect(titles?.textContent).toBe(
      'Car wash transportation · Meeting notes · Trip planning · 3 more',
    );
    expect(
      container.querySelector(
        '[data-testid="import-projects-row-chat-titles-beta"]',
      ),
    ).toBeNull();
  });

  it('completes the checklist entry when the user skips the flow', async () => {
    // Skip for now is a decision: the user has seen what can be imported
    // and passed. The Getting started entry must not keep asking.
    const onSkip = jest.fn();
    const api = createApi(scan([candidate('alpha')]));
    Object.defineProperty(window, 'api', { configurable: true, value: api });
    await act(async () => {
      root.render(<ImportProjectsPanel onSkip={onSkip} onDone={jest.fn()} />);
      await Promise.resolve();
    });
    await flush();
    click(container, 'import-projects-skip');
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(completeOnboardingSuggestionDurably).toHaveBeenCalledWith(
      'import-projects',
      'skipped',
    );
  });

  it('leaves the checklist entry pending when the scan failed and the user skips', async () => {
    // A failed scan showed the user nothing to pass on, and completion is
    // permanent (Settings restores dismissals only), so a transient failure
    // plus one click must not remove the Getting started prompt for good.
    const onSkip = jest.fn();
    const api = createApi(scan([]));
    api.externalProjects.discover.mockRejectedValueOnce(new Error('EPIPE'));
    Object.defineProperty(window, 'api', { configurable: true, value: api });
    await act(async () => {
      root.render(<ImportProjectsPanel onSkip={onSkip} onDone={jest.fn()} />);
      await Promise.resolve();
    });
    await flush();
    expect(
      container.querySelector('[data-testid="import-projects-error"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-testid="import-projects-error"] > p')
        ?.classList.contains('fg-destructive'),
    ).toBe(true);
    click(container, 'import-projects-skip');
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(completeOnboardingSuggestionDurably).not.toHaveBeenCalled();
  });

  it('reports each phase to its host, including a failed scan', async () => {
    // The wizard decides from these reports whether its own Continue and
    // Skip may resolve the Getting started entry, so a phase that stopped
    // being reported would silently let a failed scan complete it.
    const onPhaseChange = jest.fn<void, [ImportProjectsPhase]>();
    const api = createApi(scan([]));
    api.externalProjects.discover.mockRejectedValueOnce(new Error('EPIPE'));
    Object.defineProperty(window, 'api', { configurable: true, value: api });
    await act(async () => {
      root.render(
        <ImportProjectsPanel
          onSkip={jest.fn()}
          onDone={jest.fn()}
          onPhaseChange={onPhaseChange}
        />,
      );
      await Promise.resolve();
    });
    await flush();
    expect(onPhaseChange.mock.calls.map(([phase]) => phase)).toEqual([
      'scanning',
      'error',
    ]);

    click(container, 'import-projects-rescan');
    await flush();
    expect(onPhaseChange.mock.calls.map(([phase]) => phase)).toEqual([
      'scanning',
      'error',
      'scanning',
      'choose',
    ]);
  });

  it('completes the checklist entry on Done even when nothing was added', async () => {
    const api = createApi(scan([candidate('alpha')]));
    api.externalProjects.importProjects.mockResolvedValueOnce({
      results: [
        result('alpha', {
          status: 'failed',
          message: 'Disk full',
          retryable: true,
        }),
      ],
    });
    await mount(api);
    click(container, 'import-projects-submit');
    await flush();
    // A failed import completes nothing on its own...
    expect(completeOnboardingSuggestionDurably).not.toHaveBeenCalled();
    // ...but finishing the flow does: the user chose to stop here.
    click(container, 'import-projects-done');
    expect(completeOnboardingSuggestionDurably).toHaveBeenCalledWith(
      'import-projects',
      'finished',
    );
  });

  function chooseNote(): HTMLParagraphElement | undefined {
    return Array.from(container.querySelectorAll('p')).find((node) =>
      node.textContent?.includes('can be added.'),
    );
  }

  it('warns that Code project chats start from the remote default branch', async () => {
    await mount(createApi(scan([candidate('alpha')])));
    const note = chooseNote()?.textContent ?? '';
    expect(note).toContain('1 project can be added.');
    expect(note).toContain('Source folders stay where they are.');
    expect(note).toContain(
      'Chats from a Code project open in a new worktree based on the default branch from your remote when available.',
    );
    expect(note).toContain(
      'Uncommitted or unpushed changes stay in the original folder.',
    );
    expect(note).toMatch(/Nothing from the project runs until you start it\.$/);
  });

  it('omits the choose note when nothing can be added', async () => {
    await mount(createApi(scan([candidate('alpha', { status: 'imported' })])));
    expect(chooseNote()).toBeUndefined();
    expect(container.textContent).not.toContain('Uncommitted or unpushed');
  });

  it('keeps the classification and import behavior for Cowork-only candidates', async () => {
    const api = createApi(scan([candidate('notes', { kind: 'folder' })]));
    await mount(api);

    expect(chooseNote()?.textContent).toContain(
      'Code projects keep working in Git; other folders become Cowork projects.',
    );
    expect(chooseNote()?.textContent).toContain(
      'Uncommitted or unpushed changes stay in the original folder.',
    );
    expect(
      container.querySelector('[data-testid="import-projects-row-notes"]')
        ?.textContent,
    ).toContain('Cowork project');

    click(container, 'import-projects-submit');
    await flush();
    expect(api.externalProjects.importProjects).toHaveBeenCalledWith({
      scanId: 'scan-1',
      selections: [{ candidateId: 'notes', importChats: false }],
    });
  });

  it('tells a missing store apart from an empty one', async () => {
    await mount(createApi(scan([], [], { claude: false, codex: false })));
    expect(
      container.querySelector('[data-testid="import-projects-empty"]')
        ?.textContent,
    ).toContain('No Claude or Codex data found on this computer.');

    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    await mount(createApi(scan([], [], { claude: true, codex: false })));
    expect(
      container.querySelector('[data-testid="import-projects-empty"]')
        ?.textContent,
    ).toContain('No Claude or Codex projects found on this computer.');
  });

  it('offers a retry for a project whose chats partially failed', async () => {
    const api = createApi(scan([candidate('alpha')]));
    api.externalProjects.importProjects.mockResolvedValueOnce({
      results: [
        result('alpha', { chatsImported: 2, chatsSkipped: 1, retryable: true }),
      ],
    });
    await mount(api);
    click(container, 'import-projects-submit');
    await flush();
    expect(
      container.querySelector('[data-testid="import-projects-retry"]'),
    ).not.toBeNull();
  });

  it('refuses to merge plugins over a degraded preferences read', async () => {
    const api = createApi(
      scan(
        [candidate('alpha')],
        [
          {
            marketplaceId: 'mk',
            pluginName: 'linear',
            displayName: 'Linear',
            providers: ['claude'],
          },
        ],
      ),
    );
    api.externalProjects.importProjects.mockResolvedValueOnce({
      results: [result('alpha')],
    });
    api.loadPreferences.mockResolvedValueOnce({
      __error: 'preferences.json is unreadable',
    });
    await mount(api);
    click(container, 'import-projects-submit');
    await flush();
    click(container, 'import-projects-add-plugins');
    await flush();
    expect(api.savePreferences).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="import-projects-plugins-error"]')
        ?.textContent,
    ).toContain('Preferences could not be read');
    expect(
      container
        .querySelector('[data-testid="import-projects-plugins-error"]')
        ?.classList.contains('fg-destructive'),
    ).toBe(true);
  });
});
