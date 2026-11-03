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

const startOperation = jest.fn<void, unknown[]>();
const succeedOperation = jest.fn<void, unknown[]>();
const failOperation = jest.fn<void, unknown[]>();
jest.mock('@canopy/desktop-instrumentation/client', () => ({
  ...jest.requireActual<object>('@canopy/desktop-instrumentation/client'),
  startClientOperation: (...args: unknown[]): void => {
    startOperation(...args);
  },
  succeedClientOperation: (...args: unknown[]): void => {
    succeedOperation(...args);
  },
  failClientOperation: (...args: unknown[]): void => {
    failOperation(...args);
  },
}));

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
      discover: jest.fn<Promise<ExternalProjectDiscoverResponse>, [unknown]>(
        () => Promise.resolve(discovered),
      ),
      importProjects: jest.fn<
        Promise<ExternalProjectImportResponse>,
        [ExternalProjectImportRequest]
      >(() => Promise.resolve({ results: [] })),
      pickFolder: jest.fn(() => Promise.resolve(null)),
      onImportProgress: jest.fn<() => void, [unknown]>(() => () => undefined),
    },
    loadPreferences: jest.fn(() => Promise.resolve({})),
    savePreferences: jest.fn<Promise<void>, [unknown]>(() => Promise.resolve()),
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

    cursorRulesOfferProps.length = 0;
    openRepoRulesModal.mockClear();
    startOperation.mockClear();
    succeedOperation.mockClear();
    failOperation.mockClear();
    useFeatureFlagsStore.setState({
      snapshot: {
        ...getDefaultFeatureFlagSnapshot(),
        values: {
          ...getDefaultFeatureFlagSnapshot().values,
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
        .querySelector('[data-testid="import-projects-error"]')
        ?.querySelector('[role="alert"]'),
    ).not.toBeNull();
    click(container, 'import-projects-skip');
    expect(onSkip).toHaveBeenCalledTimes(1);
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

    // ...but finishing the flow does: the user chose to stop here.
    click(container, 'import-projects-done');
  });

  function chooseNote(): Element | null {
    return container.querySelector(
      '[data-testid="import-projects-choose-note"]',
    );
  }

  it('says briefly that folders stay put and Code chats need a push first', async () => {
    await mount(createApi(scan([candidate('alpha')])));
    expect(chooseNote()?.textContent).toBe(
      'Your folders stay put and nothing changes until you say so. Chats from Code projects open in a new worktree, so commit and push your work before you import.',
    );
  });

  it('omits the choose note when nothing can be added', async () => {
    await mount(
      createApi(scan([candidate('alpha', { status: 'already-imported' })])),
    );
    expect(chooseNote()).toBeNull();
    expect(container.textContent).not.toContain('commit and push your work');
  });

  it('keeps the classification and import behavior for Cowork-only candidates', async () => {
    const api = createApi(scan([candidate('notes', { kind: 'folder' })]));
    await mount(api);

    expect(chooseNote()?.textContent).toContain('commit and push your work');
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
        ?.querySelector('[role="alert"]'),
    ).toBeTruthy();
  });

  describe('a picked folder holding repositories (CAN-5487)', () => {
    const PARENT = '/Users/me/AndroidStudioProjects';
    const parent = (
      overrides: Partial<ExternalProjectCandidate> = {},
    ): ExternalProjectCandidate =>
      candidate('parent', {
        displayName: 'AndroidStudioProjects',
        rootPath: PARENT,
        kind: 'folder',
        surfaces: ['custom-folder'],
        providers: [],
        nestedRepositories: { count: 3, complete: true },
        ...overrides,
      });
    const nested = (name: string): ExternalProjectCandidate =>
      candidate(name, {
        rootPath: `${PARENT}/${name}`,
        surfaces: ['nested-repository'],
        providers: [],
        parentCandidateIds: ['parent'],
      });
    const ticketScan = (
      parentOverrides: Partial<ExternalProjectCandidate> = {},
    ): ExternalProjectDiscoverResponse =>
      scan([
        parent(parentOverrides),
        nested('compose-playground'),
        nested('pantry-android'),
        nested('wear-timer'),
      ]);
    const box = (id: string): HTMLInputElement => {
      const node = container.querySelector(
        `[data-testid="import-projects-row-checkbox-${id}"]`,
      );
      if (!(node instanceof HTMLInputElement)) throw new Error(`missing ${id}`);
      return node;
    };
    const REPOS = ['compose-playground', 'pantry-android', 'wear-timer'];

    it('selects the repositories by default and leaves the folder for an explicit choice', async () => {
      await mount(createApi(ticketScan()));

      for (const id of REPOS) expect(box(id).checked).toBe(true);
      expect(box('parent').checked).toBe(false);
      expect(box('parent').disabled).toBe(false);
      const row = container.querySelector(
        '[data-testid="import-projects-row-parent"]',
      );
      expect(row?.textContent).toContain('Plain folder');
      expect(row?.textContent).not.toContain('not a code repository');
      expect(row?.textContent).toContain('Contains 3 code repositories');
    });

    it('keeps the folder and its repositories exclusive', async () => {
      const api = createApi(ticketScan());
      await mount(api);

      click(container, 'import-projects-row-checkbox-parent');
      expect(box('parent').checked).toBe(true);
      for (const id of REPOS) expect(box(id).checked).toBe(false);

      click(container, 'import-projects-row-checkbox-wear-timer');
      expect(box('parent').checked).toBe(false);
      expect(box('wear-timer').checked).toBe(true);

      click(container, 'import-projects-row-checkbox-parent');
      click(container, 'import-projects-select-all');
      expect(box('parent').checked).toBe(false);
      for (const id of REPOS) expect(box(id).checked).toBe(true);

      click(container, 'import-projects-submit');
      await flush();
      expect(
        api.externalProjects.importProjects.mock.calls[0]?.[0].selections.map(
          (selection) => selection.candidateId,
        ),
      ).toEqual(expect.arrayContaining(REPOS));
      expect(
        api.externalProjects.importProjects.mock.calls[0]?.[0].selections,
      ).toHaveLength(3);
    });

    it('explains an incomplete, capped scan on the folder row', async () => {
      await mount(
        createApi(
          ticketScan({ nestedRepositories: { count: 37, complete: false } }),
        ),
      );
      const row = container.querySelector(
        '[data-testid="import-projects-row-parent"]',
      );
      expect(row?.textContent).toContain(
        'Contains 37 or more code repositories',
      );
      // One run of sentences, not a line per note.
      expect(row?.textContent).toContain(
        'Could not finish checking for repositories. Choose a repository folder directly to import one that is not listed.',
      );
    });

    it('does not default-select an uncertain picked folder', async () => {
      await mount(
        createApi(
          scan([parent({ nestedRepositories: { count: 0, complete: false } })]),
        ),
      );
      expect(box('parent').checked).toBe(false);
    });

    it('replaces an automatic provider parent selection when a pick discovers repositories', async () => {
      const api = createApi(
        scan([
          parent({ surfaces: ['claude-code'], nestedRepositories: undefined }),
        ]),
      );
      await mount(api);
      expect(box('parent').checked).toBe(true);
      api.externalProjects.pickFolder.mockResolvedValueOnce(PARENT);
      api.externalProjects.discover.mockResolvedValueOnce(ticketScan());
      click(container, 'import-projects-pick-folder');
      await flush();
      expect(box('parent').checked).toBe(false);
      for (const id of REPOS) expect(box(id).checked).toBe(true);
    });

    it('retains a manual parent choice on rescan rather than restoring repository defaults', async () => {
      const api = createApi(ticketScan());
      await mount(api);
      click(container, 'import-projects-row-checkbox-parent');
      click(container, 'import-projects-rescan');
      await flush();
      expect(box('parent').checked).toBe(true);
      for (const id of REPOS) expect(box(id).checked).toBe(false);
    });

    it('retains opt-outs and drops newly unavailable selections on rescan', async () => {
      const api = createApi(ticketScan());
      await mount(api);
      click(container, 'import-projects-row-checkbox-wear-timer');
      const response = ticketScan();
      const pantry = response.candidates.find(
        (entry) => entry.id === 'pantry-android',
      );
      if (!pantry) throw new Error('fixture');
      pantry.status = 'unavailable';
      api.externalProjects.discover.mockResolvedValueOnce(response);
      click(container, 'import-projects-rescan');
      await flush();
      expect(box('wear-timer').checked).toBe(false);
      expect(box('pantry-android').checked).toBe(false);
      expect(box('compose-playground').checked).toBe(true);
    });

    it('explains absent scan metadata from an older host without selecting the folder', async () => {
      await mount(createApi(scan([parent({ nestedRepositories: undefined })])));
      expect(box('parent').checked).toBe(false);
      expect(container.textContent).toContain(
        'Could not finish checking for repositories',
      );
    });

    it('keeps chat opt-outs and defaults only newly discovered repositories', async () => {
      const repository = candidate('known', { importableSessionCount: 1 });
      const api = createApi(scan([repository]));
      await mount(api);
      click(container, 'import-projects-row-chats-known');
      api.externalProjects.discover.mockResolvedValueOnce(
        scan([repository, candidate('new')]),
      );
      click(container, 'import-projects-rescan');
      await flush();
      expect(box('known').checked).toBe(true);
      expect(box('new').checked).toBe(true);
      const chats = container.querySelector(
        '[data-testid="import-projects-row-chats-known"]',
      );
      expect(chats).toHaveProperty('checked', false);
    });

    it('ignores a stale scan and accumulates concurrent folder picks without losing provenance', async () => {
      const api = createApi(scan([]));
      await mount(api);
      api.externalProjects.pickFolder
        .mockResolvedValueOnce(PARENT)
        .mockResolvedValueOnce('/Users/me/other');
      let resolveOlder: (value: ExternalProjectDiscoverResponse) => void = () =>
        undefined;
      api.externalProjects.discover
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveOlder = resolve;
            }),
        )
        .mockResolvedValueOnce(ticketScan());
      act(() => {
        const picker = container.querySelector(
          '[data-testid="import-projects-pick-folder"]',
        );
        if (!(picker instanceof HTMLElement)) throw new Error('missing picker');
        picker.click();
        picker.click();
      });
      await flush();
      expect(api.externalProjects.discover).toHaveBeenLastCalledWith({
        customRoots: [PARENT, '/Users/me/other'],
      });
      click(container, 'import-projects-row-checkbox-parent');
      await act(async () => {
        resolveOlder(scan([candidate('stale')]));
        await Promise.resolve();
      });
      await flush();
      expect(box('parent').checked).toBe(true);
      expect(
        container.querySelector('[data-testid="import-projects-row-stale"]'),
      ).toBeNull();
    });
  });

  describe('import telemetry (CAN-4635)', () => {
    type Call = unknown[];
    type OperationMock = jest.Mock<void, unknown[]>;
    const ended = (mock: OperationMock): Call[] =>
      mock.mock.calls.filter(
        (call: Call) => call[0] === 'canopy.project_import',
      );
    const optionsOf = (
      call: Call | undefined,
    ): { operationKey?: unknown; context?: unknown } => {
      const options = call?.[call.length - 1];
      return options && typeof options === 'object' ? options : {};
    };

    async function mountFrom(
      api: MockApi,
      modalEntry?: 'invite' | 'settings' | 'app-advisor' | 'checklist',
      onSkip: () => void = jest.fn(),
    ): Promise<void> {
      Object.defineProperty(window, 'api', { configurable: true, value: api });
      await act(async () => {
        root.render(
          <ImportProjectsPanel
            onSkip={onSkip}
            onDone={jest.fn()}
            {...(modalEntry ? { modalEntry } : {})}
          />,
        );
        await Promise.resolve();
      });
      await flush();
    }

    it('submits only once for clicks before React updates the importing phase', async () => {
      const api = createApi(scan([candidate('alpha')]));
      api.externalProjects.importProjects.mockReturnValue(
        new Promise(() => undefined),
      );
      await mountFrom(api, 'settings');
      const submit = container.querySelector(
        '[data-testid="import-projects-submit"]',
      );
      if (!(submit instanceof HTMLElement)) throw new Error('missing submit');
      act(() => {
        submit.click();
        submit.click();
      });
      expect(api.externalProjects.importProjects).toHaveBeenCalledTimes(1);
    });

    it('reports each submission and retry with the modal entry', async () => {
      const api = createApi(
        scan(
          [
            candidate('alpha', {
              providers: ['claude', 'codex'],
              importableSessionCount: 2,
            }),
            candidate('beta'),
          ],
          [],
          { claude: true, codex: true },
        ),
      );
      api.externalProjects.importProjects
        .mockResolvedValueOnce({
          results: [
            result('alpha', { workspaceId: 'ws-alpha', chatsImported: 2 }),
            result('beta', {
              status: 'failed',
              message: 'Disk full',
              retryable: true,
            }),
          ],
        })
        .mockResolvedValueOnce({ results: [result('beta')] });
      await mountFrom(api, 'app-advisor');

      click(container, 'import-projects-submit');
      await flush();
      click(container, 'import-projects-retry');
      await flush();

      const successes = ended(succeedOperation);
      expect(successes.map((call) => optionsOf(call).context)).toEqual([
        {
          source: 'import_modal',
          modal_entry: 'app_advisor',
          scan_outcome: 'found',
          claude_data_detected: true,
          codex_data_detected: true,
          found_count: 2,
          found_claude_count: 2,
          found_codex_count: 1,
          picked_folder: false,
          outcome: 'partial',
          selected_count: 2,
          imported_count: 1,
          imported_claude_count: 1,
          imported_codex_count: 1,
          failed_count: 1,
          chats_imported_count: 2,
        },
        expect.objectContaining({
          modal_entry: 'app_advisor',
          outcome: 'imported',
          selected_count: 1,
          imported_count: 1,
          imported_codex_count: 0,
        }),
      ]);
      const keys = ended(startOperation).map(
        (call) => optionsOf(call).operationKey,
      );
      expect(keys).toHaveLength(2);
      expect(keys[0]).not.toBe(keys[1]);
      expect(successes.map((call) => optionsOf(call).operationKey)).toEqual(
        keys,
      );
      expect(JSON.stringify(successes)).not.toMatch(
        /alpha|beta|scan-1|ws-|Users/,
      );
    });

    it('reports a thrown request and a zero import as failures', async () => {
      const api = createApi(scan([candidate('alpha')]));
      api.externalProjects.importProjects.mockRejectedValueOnce(
        new Error('offline'),
      );
      await mountFrom(api, 'checklist');

      click(container, 'import-projects-submit');
      await flush();

      expect(ended(succeedOperation)).toHaveLength(0);
      const failures = ended(failOperation);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.[1]).toBe('error');
      const context = optionsOf(failures[0]).context;
      expect(context).toMatchObject({
        source: 'import_modal',
        outcome: 'request_failed',
        selected_count: 1,
        imported_count: 0,
        failed_count: 1,
        chats_imported_count: 0,
      });
      expect(context).not.toHaveProperty('modal_entry');
    });

    it('records a picked folder for the submission', async () => {
      const api = createApi(scan([candidate('alpha')]));
      api.externalProjects.pickFolder.mockResolvedValueOnce('/Users/me/x');
      api.externalProjects.importProjects.mockResolvedValueOnce({
        results: [result('alpha', { status: 'skipped' })],
      });
      await mountFrom(api, 'settings');

      click(container, 'import-projects-pick-folder');
      await flush();
      await flush();
      click(container, 'import-projects-submit');
      await flush();

      expect(optionsOf(ended(failOperation)[0]).context).toMatchObject({
        modal_entry: 'settings',
        picked_folder: true,
        outcome: 'none_imported',
      });
    });

    it('emits nothing when the flow is skipped', async () => {
      const onSkip = jest.fn();
      await mountFrom(createApi(scan([candidate('alpha')])), 'invite', onSkip);
      click(container, 'import-projects-skip');
      expect(onSkip).toHaveBeenCalled();
      expect(ended(startOperation)).toHaveLength(0);
      expect(ended(succeedOperation)).toHaveLength(0);
      expect(ended(failOperation)).toHaveLength(0);
    });
  });
});
